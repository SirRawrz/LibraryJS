package com.example.libraryjs

import android.Manifest
import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.text.InputType
import android.text.TextUtils
import android.content.res.ColorStateList
import android.text.method.LinkMovementMethod
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.text.HtmlCompat
import androidx.core.widget.doAfterTextChanged
import androidx.documentfile.provider.DocumentFile

class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var urlText: TextView
    private lateinit var rootsText: TextView
    private lateinit var mainRootText: TextView
    private lateinit var mainPortInput: EditText
    private lateinit var mainHttpsCheck: CheckBox
    private lateinit var mainHttpsInstallButton: Button
    private lateinit var installLibraryJsButton: Button
    private lateinit var temporaryUsbButton: Button
    private lateinit var temporaryUsbPortInput: EditText
    private lateinit var temporaryUsbUrlText: TextView
    private lateinit var autoOpenOnBootCheck: CheckBox
    private lateinit var autoStartServersOnOpenCheck: CheckBox
    private lateinit var mainPickButton: Button
    private lateinit var extendedContainer: LinearLayout
    private lateinit var store: ServerStore

    private val extendedRows = mutableListOf<RowState>()
    private var pendingPickerRow: RowState? = null
    private var pendingMainPicker = false
    private var pendingTemporaryUsbPicker = false
    private var bindingUi = false

    private data class RowState(
        var root: StorageRoot?,
        val container: LinearLayout,
        val title: TextView,
        val pickButton: Button,
        val portInput: EditText,
        val httpsCheck: CheckBox,
        val installButton: Button,
        val summary: TextView,
        val removeButton: Button
    )

    private val pickFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        val row = pendingPickerRow
        val isMain = pendingMainPicker
        val isTemporaryUsb = pendingTemporaryUsbPicker
        pendingPickerRow = null
        pendingMainPicker = false
        pendingTemporaryUsbPicker = false

        if (uri == null) {
            statusText.text = "Folder selection canceled."
            return@registerForActivityResult
        }

        runCatching {
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            runCatching { contentResolver.takePersistableUriPermission(uri, takeFlags) }

            val displayName = resolveStorageDisplayName(uri)
            val id = store.makeStableRootId(displayName, uri.toString())
            val tempSuggestedPort = store.nextAvailablePort((store.loadRoots().map { it.port } + extendedRows.mapNotNull { it.root?.port }).toSet())
            val port = when {
                isMain -> parsePort(mainPortInput.text?.toString(), store.loadLastPort())
                isTemporaryUsb -> parsePort(temporaryUsbPortInput.text?.toString(), tempSuggestedPort)
                else -> parsePort(row?.portInput?.text?.toString(), store.loadLastPort())
            }

            val updated = StorageRoot(
                id = id,
                displayName = displayName,
                treeUri = uri.toString(),
                port = port,
                httpsEnabled = when {
                    isMain -> mainHttpsCheck.isChecked
                    isTemporaryUsb -> false
                    else -> row?.httpsCheck?.isChecked ?: false
                },
                isMain = isMain
            )

            if (isTemporaryUsb) {
                TemporaryUsbRegistry.set(updated.copy(isMain = false))
                statusText.text = "Temporary USB root set: $displayName"
                startServerService()
            } else if (isMain) {
                upsertMainRoot(updated)
            } else if (row != null) {
                row.root = updated
                store.saveExtendedRoot(updated)
            }

            refreshUi()
            if (!isTemporaryUsb) {
                statusText.text = "Selected root: $displayName"
            }
        }.onFailure { error ->
            statusText.text = "Could not save folder: ${error.message ?: error.javaClass.simpleName}"
        }
    }

    private val requestNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        statusText.text = if (granted || Build.VERSION.SDK_INT < 33) {
            "Notification permission granted."
        } else {
            "Notification permission denied. Server is still running."
        }
        refreshUi()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = ServerStore(this)

        statusText = findViewById(R.id.statusText)
        urlText = findViewById(R.id.urlText)
        rootsText = findViewById(R.id.rootsText)
        mainRootText = findViewById(R.id.mainRootText)

        installLibraryJsButton = findViewById(R.id.installLibraryJsButton)
        temporaryUsbButton = findViewById(R.id.temporaryUsbButton)
        temporaryUsbPortInput = findViewById(R.id.temporaryUsbPortInput)
        temporaryUsbUrlText = findViewById(R.id.temporaryUsbUrlText)

        bindLinks(urlText)
        bindLinks(mainRootText)
        bindLinks(rootsText)
        mainPortInput = findViewById(R.id.mainPortInput)
        mainHttpsCheck = findViewById(R.id.mainHttpsCheck)
        mainHttpsInstallButton = findViewById(R.id.mainHttpsInstallButton)
        autoOpenOnBootCheck = findViewById(R.id.autoOpenOnBootCheck)
        autoStartServersOnOpenCheck = findViewById(R.id.autoStartServersOnOpenCheck)
        mainPickButton = findViewById(R.id.pickFolderButton)
        extendedContainer = findViewById(R.id.extendedContainer)

        installLibraryJsButton.setOnClickListener { showInstallLibraryJsDialog() }
        temporaryUsbButton.setOnClickListener { toggleTemporaryUsb() }
        temporaryUsbPortInput.doAfterTextChanged {
            if (bindingUi) return@doAfterTextChanged
            val tempRoot = TemporaryUsbRegistry.get() ?: return@doAfterTextChanged
            val port = parsePort(it?.toString(), tempRoot.port)
            TemporaryUsbRegistry.set(tempRoot.copy(port = port))
            startServerService()
            refreshUi()
        }

        mainPortInput.doAfterTextChanged {
            if (bindingUi) return@doAfterTextChanged
            val port = parsePort(it?.toString(), store.loadLastPort())
            store.saveLastPort(port)
            store.loadMainRoot()?.let { mainRoot ->
                store.saveMainRoot(mainRoot.copy(port = port))
            }
            refreshUi()
        }

        mainPickButton.setOnClickListener {
            pendingPickerRow = null
            pendingMainPicker = true
            launchFolderPicker()
        }

        mainHttpsCheck.setOnCheckedChangeListener { _, isChecked ->
            if (bindingUi) return@setOnCheckedChangeListener
            store.loadMainRoot()?.let { mainRoot ->
                store.saveMainRoot(mainRoot.copy(httpsEnabled = isChecked))
            }
            refreshUi()
        }

        autoOpenOnBootCheck.setOnCheckedChangeListener { _, isChecked ->
            if (bindingUi) return@setOnCheckedChangeListener
            store.saveAutoOpenOnBoot(isChecked)
            refreshUi()
        }

        autoStartServersOnOpenCheck.setOnCheckedChangeListener { _, isChecked ->
            if (bindingUi) return@setOnCheckedChangeListener
            store.saveAutoStartServersOnAppOpen(isChecked)
            refreshUi()
        }

        styleBlueActionButton(mainHttpsInstallButton)
        mainHttpsInstallButton.setOnClickListener {
            store.loadMainRoot()?.let { installHttpsCertificate(it) }
        }

        findViewById<Button>(R.id.startButton).setOnClickListener {
            if (!persistUiState()) return@setOnClickListener
            startServerService()
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        findViewById<Button>(R.id.stopButton).setOnClickListener {
            stopService(Intent(this, ServerService::class.java).setAction(ServerService.ACTION_STOP))
            statusText.text = "Server stopped."
            refreshUi()
        }

        findViewById<Button>(R.id.refreshButton).setOnClickListener {
            if (persistUiState()) refreshUi()
        }

        findViewById<Button>(R.id.addExtendedServersButton).setOnClickListener {
            addExtendedServerRow()
        }

        refreshUi()
        maybeAutoStartServersOnAppOpen()
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
        maybeAutoStartServersOnAppOpen()
    }

    private fun launchFolderPicker() {
        val roots = store.loadRoots()
        val initialUri = when {
            pendingMainPicker -> roots.firstOrNull()?.treeUri
            pendingPickerRow?.root != null -> pendingPickerRow?.root?.treeUri
            else -> null
        }?.let { runCatching { Uri.parse(it) }.getOrNull() }
        pickFolder.launch(initialUri)
    }

    private fun startServerService() {
        ContextCompat.startForegroundService(
            this,
            Intent(this, ServerService::class.java).setAction(ServerService.ACTION_START)
        )
        statusText.text = "Starting server…"
        refreshUi()
    }

    private fun maybeAutoStartServersOnAppOpen() {
        if (!store.loadAutoStartServersOnAppOpen()) return
        if (ServerService.isRunning()) return
        startServerService()
    }

    private fun refreshUi() {
        val roots = store.loadRoots()
        bindingUi = true
        try {
            val mainRoot = store.loadMainRoot()
            val mainPort = mainRoot?.port ?: store.loadLastPort()
            val desiredMainPort = mainPort.toString()
            if (mainPortInput.text?.toString()?.trim() != desiredMainPort) {
                mainPortInput.setText(desiredMainPort)
            }
            mainPickButton.text = if (mainRoot == null) "Add main storage folder" else "Change main storage folder"
            mainHttpsCheck.isEnabled = mainRoot != null
            mainHttpsCheck.isChecked = mainRoot?.httpsEnabled ?: false
            temporaryUsbButton.text = if (TemporaryUsbRegistry.hasTemporaryRoot()) "Remove Temporary USB" else "Temporary USB"
            mainHttpsInstallButton.isEnabled = mainRoot?.httpsEnabled == true
            mainHttpsInstallButton.text = if (mainRoot?.httpsEnabled == true) "Install HTTPS cert" else "Enable HTTPS first"
            autoOpenOnBootCheck.isChecked = store.loadAutoOpenOnBoot()
            autoStartServersOnOpenCheck.isChecked = store.loadAutoStartServersOnAppOpen()

            mainRootText.text = mainRoot?.let { buildRootSummary(it) } ?: "No main storage folder selected."

            val tempRoot = TemporaryUsbRegistry.get()
            val suggestedTempPort = store.nextAvailablePort((roots.map { it.port } + listOfNotNull(mainRoot?.port) + extendedRows.mapNotNull { it.root?.port }).toSet())
            val tempPortText = (tempRoot?.port ?: suggestedTempPort).toString()
            if (!temporaryUsbPortInput.hasFocus() && temporaryUsbPortInput.text?.toString()?.trim() != tempPortText) {
                temporaryUsbPortInput.setText(tempPortText)
            }
            temporaryUsbButton.text = if (tempRoot != null) "Remove Temporary USB" else "Temporary USB"
            temporaryUsbUrlText.text = if (tempRoot != null) {
                HtmlCompat.fromHtml(
                    "<b>Temporary USB Server:</b><br>" + buildEndpointHtml(NetworkUtils.serverUrls(tempRoot.port, tempRoot.httpsEnabled)),
                    HtmlCompat.FROM_HTML_MODE_LEGACY
                )
            } else {
                "Temporary USB Server: not active."
            }
            bindLinks(temporaryUsbUrlText)

            val extraRoots = store.loadExtendedRoots()
            while (extendedRows.size > extraRoots.size) {
                val removed = extendedRows.removeAt(extendedRows.lastIndex)
                extendedContainer.removeView(removed.container)
            }
            while (extendedRows.size < extraRoots.size) {
                val index = extendedRows.size + 1
                val row = createExtendedRow(extraRoots[extendedRows.size], index, extraRoots[extendedRows.size].port)
                extendedRows += row
                extendedContainer.addView(row.container)
            }

            for (i in extendedRows.indices) {
                val row = extendedRows[i]
                val persisted = extraRoots.getOrNull(i)
                if (persisted != null) {
                    row.root = persisted
                    val portText = persisted.port.toString()
                    if (row.portInput.text?.toString()?.trim() != portText) {
                        row.portInput.setText(portText)
                    }
                    row.httpsCheck.isEnabled = true
                    row.httpsCheck.isChecked = persisted.httpsEnabled
                    row.installButton.isEnabled = persisted.httpsEnabled
                    row.installButton.text = if (persisted.httpsEnabled) "Install HTTPS cert" else "Enable HTTPS first"
                    row.pickButton.text = "Change extended storage folder"
                    row.summary.text = buildRootSummary(persisted)
                } else {
                    row.title.text = "Extended Server ${i + 1}"
                    row.pickButton.text = if (row.root == null) "Add extended storage folder" else "Change extended storage folder"
                    row.httpsCheck.isEnabled = row.root != null
                    row.httpsCheck.isChecked = row.root?.httpsEnabled ?: false
                    row.installButton.isEnabled = row.root?.httpsEnabled == true
                    row.installButton.text = if (row.root?.httpsEnabled == true) "Install HTTPS cert" else "Enable HTTPS first"
                    row.summary.text = row.root?.let { buildRootSummary(it) } ?: "Select a folder to mount this server."
                }
            }

            rootsText.text = if (roots.isEmpty()) {
                "No storage roots selected."
            } else {
                roots.joinToString(separator = "\n\n") { root -> buildRootSummary(root) }
            }

            val ports = roots.map { it.port }.distinct().sorted()
            urlText.text = if (ports.isEmpty()) {
                HtmlCompat.fromHtml(
                    "<a href=\"${TextUtils.htmlEncode(ServerConfig.localhostUrl(store.loadLastPort()))}\">${TextUtils.htmlEncode(ServerConfig.localhostUrl(store.loadLastPort()))}</a>",
                    HtmlCompat.FROM_HTML_MODE_LEGACY
                )
            } else {
                HtmlCompat.fromHtml(
                    ports.joinToString(separator = "<br><br>") { port ->
                        val urlTextValue = NetworkUtils.serverUrlLabel(port, roots.firstOrNull { it.port == port }?.httpsEnabled ?: false)
                        urlTextValue.split('\n').joinToString("<br>") { url ->
                            val safeUrl = TextUtils.htmlEncode(url)
                            "<a href=\"$safeUrl\">$safeUrl</a>"
                        }
                    },
                    HtmlCompat.FROM_HTML_MODE_LEGACY
                )
            }
            statusText.text = if (ServerService.isRunning()) "Server running." else "Server stopped."
        } finally {
            bindingUi = false
        }
    }

    private fun persistUiState(): Boolean {
        val roots = mutableListOf<StorageRoot>()
        val mainPort = parsePort(mainPortInput.text?.toString(), store.loadLastPort())
        store.saveLastPort(mainPort)

        val mainRoot = store.loadMainRoot()?.copy(port = mainPort, httpsEnabled = mainHttpsCheck.isChecked, isMain = true)
        if (mainRoot != null) {
            roots += mainRoot
        }

        for (row in extendedRows) {
            val port = parsePort(row.portInput.text?.toString(), store.nextAvailablePort(roots.map { it.port }.toSet()))
            row.root = row.root?.copy(port = port, httpsEnabled = row.httpsCheck.isChecked, isMain = false)
            row.root?.let { roots += it }
        }

        return try {
            if (roots.isNotEmpty()) {
                ensureUniquePorts(roots)
                store.saveRoots(roots)
            }
            true
        } catch (e: IllegalArgumentException) {
            statusText.text = e.message ?: "Duplicate ports are not allowed."
            false
        }
    }

    private fun upsertMainRoot(root: StorageRoot) {
        store.saveMainRoot(root.copy(isMain = true))
        mainPortInput.setText(root.port.toString())
    }

    private fun addExtendedServerRow() {
        val suggestedPort = store.nextAvailablePort(
            (store.loadRoots().map { it.port } + extendedRows.mapNotNull { it.root?.port }).toSet()
        )
        val row = createExtendedRow(null, extendedRows.size + 1, suggestedPort)
        extendedRows += row
        extendedContainer.addView(row.container)
    }

    private fun createExtendedRow(root: StorageRoot?, index: Int, suggestedPort: Int = store.nextAvailablePort()): RowState {
        val container = createVerticalCardLayout()
        val title = TextView(this).apply {
            textSize = 16f
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTextColor(0xFFE8EEF7.toInt())
            text = "Extended Server $index"
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setPadding(0, dp(8), 0, dp(8))
        }
        val pickButton = Button(this).apply {
            text = if (root == null) "Add extended storage folder" else "Change extended storage folder"
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            styleBlueActionButton(this)
        }
        val portInput = EditText(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(96), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(8)
            }
            inputType = InputType.TYPE_CLASS_NUMBER
            setTextColor(0xFFE8EEF7.toInt())
            setHintTextColor(0xFFA8B3C7.toInt())
            setText((root?.port ?: suggestedPort).toString())
            setSelectAllOnFocus(true)
            hint = "Port"
        }
        val httpsCheck = CheckBox(this).apply {
            text = "HTTPS"
            setTextColor(0xFFE8EEF7.toInt())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(8)
            }
            isChecked = root?.httpsEnabled ?: false
            isEnabled = root != null
        }
        val removeButton = Button(this).apply {
            text = "Remove"
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(8)
            }
            styleBlueActionButton(this)
        }
        val summary = TextView(this).apply {
            text = root?.let { buildRootSummary(it) } ?: "Select a folder to mount this server."
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(0xFFE8EEF7.toInt())
            bindLinks(this)
        }
        val installButton = Button(this).apply {
            text = if (root?.httpsEnabled == true) "Install HTTPS cert" else "Enable HTTPS first"
            isEnabled = root?.httpsEnabled == true
            styleBlueActionButton(this)
        }

        row.addView(pickButton)
        row.addView(portInput)
        row.addView(httpsCheck)
        row.addView(removeButton)
        container.addView(title)
        container.addView(row)
        container.addView(summary)
        container.addView(installButton)

        val state = RowState(root, container, title, pickButton, portInput, httpsCheck, installButton, summary, removeButton)

        pickButton.setOnClickListener {
            pendingPickerRow = state
            pendingMainPicker = false
            launchFolderPicker()
        }

        portInput.doAfterTextChanged {
            if (bindingUi) return@doAfterTextChanged
            val port = parsePort(it?.toString(), suggestedPort)
            state.root = state.root?.copy(port = port, httpsEnabled = httpsCheck.isChecked)
            state.root?.let { root -> store.saveExtendedRoot(root) }
        }

        httpsCheck.setOnCheckedChangeListener { _, isChecked ->
            if (bindingUi) return@setOnCheckedChangeListener
            state.root = state.root?.copy(httpsEnabled = isChecked)
            state.root?.let { root -> store.saveExtendedRoot(root) }
            installButton.isEnabled = isChecked
            installButton.text = if (isChecked) "Install HTTPS cert" else "Enable HTTPS first"
        }

        installButton.setOnClickListener {
            state.root?.let { installHttpsCertificate(it) }
        }

        removeButton.setOnClickListener {
            state.root?.let { store.removeRoot(it.id) }
            extendedRows.remove(state)
            extendedContainer.removeView(state.container)
            refreshUi()
        }

        return state
    }

    private fun installHttpsCertificate(root: StorageRoot) {
        if (!root.httpsEnabled) {
            statusText.text = "Enable HTTPS first for ${root.displayName}."
            return
        }
        runCatching { ServerTlsManager.installCertificateIntent(this, root) }
            .onSuccess { intent ->
                runCatching { startActivity(intent) }
                    .onSuccess {
                        statusText.text = "Certificate installer opened for ${root.displayName}."
                    }
                    .onFailure { error ->
                        statusText.text = "Could not open certificate installer: ${error.message ?: error.javaClass.simpleName}"
                    }
            }
            .onFailure { error ->
                statusText.text = "Could not create HTTPS certificate: ${error.message ?: error.javaClass.simpleName}"
            }
    }

    private fun createVerticalCardLayout(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(12)
                bottomMargin = dp(12)
            }
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
    }

    private fun styleBlueActionButton(button: Button) {
        button.setTextColor(0xFF000000.toInt())
        button.backgroundTintList = ColorStateList.valueOf(0xFF79A8FF.toInt())
    }

    private fun buildRootSummary(root: StorageRoot): CharSequence {
        val certLine = if (root.httpsEnabled) {
            ServerTlsManager.certificateStatusLine(this, root)
        } else {
            "HTTPS is off for this root."
        }
        val endpointHtml = buildEndpointHtml(NetworkUtils.serverUrls(root.port, root.httpsEnabled))
        val html = buildString {
            append("<b>")
            append(TextUtils.htmlEncode(root.displayName))
            append("</b><br>")
            append("Port: ")
            append(root.port)
            append("<br>")
            append("HTTPS: ")
            append(if (root.httpsEnabled) "On" else "Off")
            append("<br>")
            append(TextUtils.htmlEncode(certLine))
            append("<br>")
            append(endpointHtml)
        }
        return HtmlCompat.fromHtml(html, HtmlCompat.FROM_HTML_MODE_LEGACY)
    }

    private fun buildEndpointHtml(urls: List<String>): String {
        return urls.distinct().joinToString("<br>") { url ->
            val safeUrl = TextUtils.htmlEncode(url)
            "<a href=\"$safeUrl\">$safeUrl</a>"
        }
    }

    private fun bindLinks(textView: TextView) {
        textView.movementMethod = LinkMovementMethod.getInstance()
        textView.linksClickable = true
        textView.isClickable = false
        textView.isLongClickable = true
    }

    private data class InstallTarget(val label: String, val root: StorageRoot)

    private fun showInstallLibraryJsDialog() {
        val targets = buildInstallTargets()
        if (targets.isEmpty()) {
            statusText.text = "Pick the main server root or start the temporary USB server before installing the hosted bundle."
            return
        }

        val dialogBg = 0xFF141A22.toInt()
        val dialogTextPrimary = 0xFFE8EEF7.toInt()
        val dialogTextSecondary = 0xFFA8B3C7.toInt()
        val dialogAccent = 0xFF79A8FF.toInt()

        val scroll = ScrollView(this).apply {
            setBackgroundColor(dialogBg)
            isFillViewport = true
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(dialogBg)
            setPadding(dp(20), dp(18), dp(20), dp(8))
        }

        val intro = TextView(this).apply {
            text = "Choose where to install LibraryJS and whether to preserve your database files."
            setTextColor(dialogTextPrimary)
            textSize = 14f
        }
        content.addView(intro)

        val targetLabel = TextView(this).apply {
            text = "Destination server"
            setTextColor(dialogTextSecondary)
            setPadding(0, dp(14), 0, dp(8))
        }
        content.addView(targetLabel)

        val targetGroup = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
        }
        val targetButtons = targets.mapIndexed { index, target ->
            RadioButton(this).apply {
                id = View.generateViewId()
                text = target.label
                setTextColor(dialogTextPrimary)
                isChecked = index == 0
            }.also { targetGroup.addView(it) }
        }
        content.addView(targetGroup)

        val modeLabel = TextView(this).apply {
            text = "Install mode"
            setTextColor(dialogTextSecondary)
            setPadding(0, dp(16), 0, dp(8))
        }
        content.addView(modeLabel)

        val modeGroup = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
        }
        val wipeButton = RadioButton(this).apply {
            id = View.generateViewId()
            text = "Complete Wipe"
            setTextColor(dialogTextPrimary)
            isChecked = true
        }
        val preserveButton = RadioButton(this).apply {
            id = View.generateViewId()
            text = "Preserve current files"
            setTextColor(dialogTextPrimary)
        }
        modeGroup.addView(wipeButton)
        modeGroup.addView(preserveButton)
        content.addView(modeGroup)

        val note = TextView(this).apply {
            text = "Preserve mode saves and restores your database JS files after the bundle finishes unpacking."
            setTextColor(dialogTextSecondary)
            setPadding(0, dp(12), 0, 0)
        }
        content.addView(note)

        scroll.addView(content)

        val dialog = AlertDialog.Builder(this)
            .setView(scroll)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Install", null)
            .create()

        dialog.setOnShowListener {
            dialog.window?.setBackgroundDrawable(ColorDrawable(dialogBg))
            dialog.findViewById<View>(androidx.appcompat.R.id.parentPanel)?.setBackgroundColor(dialogBg)
            dialog.findViewById<View>(androidx.appcompat.R.id.topPanel)?.setBackgroundColor(dialogBg)
            dialog.findViewById<View>(androidx.appcompat.R.id.contentPanel)?.setBackgroundColor(dialogBg)
            dialog.findViewById<View>(androidx.appcompat.R.id.buttonPanel)?.setBackgroundColor(dialogBg)

            dialog.getButton(AlertDialog.BUTTON_POSITIVE).apply {
                setTextColor(dialogAccent)
                setOnClickListener {
                    val selectedIndex = targetGroup.indexOfChild(
                        targetButtons.firstOrNull { it.isChecked } ?: targetButtons.first()
                    ).coerceAtLeast(0)
                    val selectedTarget = targets.getOrNull(selectedIndex) ?: targets.first()
                    val preserve = preserveButton.isChecked
                    dialog.dismiss()
                    startHostedBundleInstall(selectedTarget.root, selectedTarget.label, preserve)
                }
            }
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(dialogTextPrimary)
        }
        dialog.show()
    }

    private fun buildInstallTargets(): List<InstallTarget> {
        val targets = mutableListOf<InstallTarget>()
        store.loadMainRoot()?.let { targets += InstallTarget("Mainserver • ${it.displayName}", it) }
        TemporaryUsbRegistry.get()?.let { targets += InstallTarget("Temporary USB server • ${it.displayName}", it) }
        return targets.distinctBy { it.root.treeUri }
    }

    private fun startHostedBundleInstall(root: StorageRoot, targetLabel: String, preserve: Boolean) {
        statusText.text = if (preserve) {
            "Downloading HostedByServerApp.zip for ${root.displayName} with preserve mode..."
        } else {
            "Downloading HostedByServerApp.zip for ${root.displayName}..."
        }

        Thread {
            runCatching {
                ReleaseBundleInstaller.installHostedBundle(
                    context = this,
                    root = root,
                    releaseZipUrl = ServerConfig.INSTALL_LIBRARYJS_URL,
                    preserveRelativePaths = if (preserve) ServerConfig.INSTALL_LIBRARYJS_PRESERVE_PATHS else emptyList(),
                    onProgress = { message -> runOnUiThread { statusText.text = message } }
                )
            }.onSuccess { message ->
                runOnUiThread {
                    statusText.text = "${message} (Target: $targetLabel)"
                    startServerService()
                }
            }.onFailure { error ->
                runOnUiThread {
                    statusText.text = "Install failed: ${error.message ?: error.javaClass.simpleName}"
                }
            }
        }.start()
    }

    private fun toggleTemporaryUsb() {
        if (TemporaryUsbRegistry.hasTemporaryRoot()) {
            TemporaryUsbRegistry.clear()
            statusText.text = "Temporary USB removed."
            refreshUi()
            startServerService()
            return
        }

        pendingTemporaryUsbPicker = true
        launchFolderPicker()
    }

    private fun parsePort(raw: String?, fallback: Int): Int {
        val value = raw?.trim()?.toIntOrNull() ?: fallback
        return value.coerceIn(1, 65535)
    }

    private fun ensureUniquePorts(roots: List<StorageRoot>) {
        val dupes = roots.groupBy { it.port }.filterValues { it.size > 1 }.keys
        require(dupes.isEmpty()) { "Duplicate ports: ${dupes.joinToString(", ")}" }
    }

    private fun dp(value: Int): Int = (resources.displayMetrics.density * value).toInt().coerceAtLeast(1)

    private fun resolveStorageDisplayName(uri: Uri): String {
        val documentFileName = runCatching { DocumentFile.fromTreeUri(this, uri)?.name }.getOrNull()
        if (!documentFileName.isNullOrBlank()) return documentFileName

        val treeDocumentId = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()
        val fromTreeDocumentId = treeDocumentId
            ?.substringAfterLast(':')
            ?.substringAfterLast('/')
            ?.trim()
        if (!fromTreeDocumentId.isNullOrBlank()) return fromTreeDocumentId

        val lastSegment = uri.lastPathSegment
            ?.substringAfterLast('/')
            ?.trim()
        if (!lastSegment.isNullOrBlank()) return lastSegment

        return "Storage"
    }
}
