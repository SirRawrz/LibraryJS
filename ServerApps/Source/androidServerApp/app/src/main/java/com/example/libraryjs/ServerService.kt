package com.example.libraryjs

import android.app.NotificationChannel
import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.content.ComponentName
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.documentfile.provider.DocumentFile

class ServerService : Service() {

    private data class RunningServer(
        val root: StorageRoot,
        val server: LocalLibraryServer,
        val signature: String
    )

    private val servers = linkedMapOf<Int, RunningServer>()
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var hotspotManager: WifiHotspotManager

    override fun onCreate() {
        super.onCreate()
        hotspotManager = WifiHotspotManager(applicationContext)
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopAllServers()
                hotspotManager.stop()
                ServerStore(applicationContext).saveWifiHotspotActive(false)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                val roots = ensureServers()
                syncHotspotState(roots)
                updateNotification()
                return START_STICKY
            }
            else -> {
                val roots = ensureServers()
                syncHotspotState(roots)
                updateNotification()
                return START_STICKY
            }
        }
    }

    override fun onDestroy() {
        stopAllServers()
        hotspotManager.stop()
        ServerStore(applicationContext).saveWifiHotspotActive(false)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureServers(): List<StorageRoot> {
        val store = ServerStore(applicationContext)
        val roots = (store.loadRoots() + listOfNotNull(TemporaryUsbRegistry.get()))
            .filter { it.treeUri.isNotBlank() }

        val duplicatePorts = roots.groupBy { it.port }
            .filterValues { it.size > 1 }
            .keys
            .sorted()

        if (duplicatePorts.isNotEmpty()) {
            updateNotification("Duplicate ports: ${duplicatePorts.joinToString(", ")}")
            stopAllServers()
            return emptyList()
        }

        val desiredPorts = roots.map { it.port }.toSet()
        val toRemove = servers.keys.filterNot { it in desiredPorts }
        toRemove.forEach { port ->
            servers.remove(port)?.let { runCatching { it.server.stop() } }
        }

        for (root in roots) {
            val signature = root.signature()
            val existing = servers[root.port]
            if (existing != null && existing.signature == signature) continue

            servers.remove(root.port)?.let { runCatching { it.server.stop() } }

            try {
                val server = LocalLibraryServer(applicationContext, root)
                server.start()
                servers[root.port] = RunningServer(root, server, signature)
            } catch (e: Exception) {
                updateNotification("Port ${root.port} failed: ${e.message ?: e.javaClass.simpleName}")
                stopAllServers()
                return emptyList()
            }
        }

        if (servers.isNotEmpty()) {
            acquireWakeLock()
        }
        setRunning(servers.isNotEmpty())
        return roots
    }

    private fun stopAllServers() {
        servers.values.forEach { runCatching { it.server.stop() } }
        servers.clear()
        releaseWakeLock()
        setRunning(false)
    }

    private fun syncHotspotState(roots: List<StorageRoot>) {
        val store = ServerStore(applicationContext)
        val mode = store.loadWifiBroadcastMode()
        val running = roots.isNotEmpty()
        val shouldBroadcast = running && shouldBroadcastOwnWifi(mode)

        store.saveWifiHotspotActive(false)

        if (!shouldBroadcast) {
            hotspotManager.stop()
            updateNotification()
            return
        }

        if (!hasHotspotPermission()) {
            hotspotManager.stop()
            updateNotification("Wi-Fi permission needed for hotspot mode.")
            return
        }

        hotspotManager.sync(shouldBroadcast, store.loadWifiHotspotSsid(), store.loadWifiHotspotPassword(), { text ->
            updateNotification(text)
        }) { info ->
            store.saveWifiHotspotActive(info.isRunning)
            if (info.isRunning) {
                store.saveWifiHotspotSsid(info.ssid)
                store.saveWifiHotspotPassword(info.password)
                writeStartupMetadataFiles(roots)
            }
            updateNotification()
        }
    }

    private fun hasHotspotPermission(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.NEARBY_WIFI_DEVICES
        } else {
            Manifest.permission.ACCESS_FINE_LOCATION
        }
        return ContextCompat.checkSelfPermission(applicationContext, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun shouldBroadcastOwnWifi(mode: String): Boolean {

        return when (mode) {
            ServerConfig.WIFI_MODE_BROADCAST_OWN_WIFI -> true
            ServerConfig.WIFI_MODE_USE_EXISTING_WIFI_IF_POSSIBLE -> !isConnectedToWifi()
            else -> false
        }
    }

    private fun isConnectedToWifi(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
    }

    private fun writeStartupMetadataFiles(roots: List<StorageRoot>) {
        val mainRoot = roots.firstOrNull { it.isMain } ?: roots.firstOrNull() ?: return
        val tree = runCatching { DocumentFile.fromTreeUri(applicationContext, Uri.parse(mainRoot.treeUri)) }.getOrNull() ?: return
        writeRootTextFile(tree, "platform.txt", "android")
        writeRootTextFile(tree, "serverip.txt", NetworkUtils.primaryServerUrl(mainRoot.port, mainRoot.httpsEnabled).removeSuffix("?I"))
        writeRootTextFile(
            tree,
            "httpserverip.txt",
            roots.firstOrNull { !it.httpsEnabled }?.let { NetworkUtils.primaryServerUrl(it.port, it.httpsEnabled).removeSuffix("?I") }.orEmpty()
        )
        writeRootTextFile(
            tree,
            "httpsserverip.txt",
            roots.firstOrNull { it.httpsEnabled }?.let { NetworkUtils.primaryServerUrl(it.port, it.httpsEnabled).removeSuffix("?I") }.orEmpty()
        )
        val info = hotspotManager.currentInfo()
        writeRootTextFile(tree, "wifissid.txt", info.ssid)
        writeRootTextFile(tree, "wifipassword.txt", info.password)
    }

    private fun writeRootTextFile(parent: DocumentFile, name: String, content: String) {
        val existing = parent.findFile(name)
        if (existing != null && existing.isFile) {
            val wrote = runCatching {
                applicationContext.contentResolver.openOutputStream(existing.uri, "wt")?.use { out ->
                    out.write(content.toByteArray(Charsets.UTF_8))
                } != null
            }.getOrDefault(false)
            if (wrote) return
        }

        if (existing != null) {
            runCatching { existing.delete() }
        }

        val created = parent.createFile("text/plain", name) ?: return
        applicationContext.contentResolver.openOutputStream(created.uri, "wt")?.use { out ->
            out.write(content.toByteArray(Charsets.UTF_8))
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(PowerManager::class.java) ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LibraryJS:ServerWakeLock").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        runCatching {
            wakeLock?.let { if (it.isHeld) it.release() }
        }
        wakeLock = null
    }

    private fun updateNotification(text: String = buildStatusText()) {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("LibraryJS Server")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(contentIntent)
            .addAction(android.R.drawable.ic_menu_view, "Open app", contentIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "LibraryJS Server",
            NotificationManager.IMPORTANCE_LOW
        )
        mgr.createNotificationChannel(channel)
    }

    private fun setRunning(running: Boolean) {
        runningFlag = running
        val pref = getSharedPreferences(ServerConfig.PREFS_NAME, MODE_PRIVATE)
        pref.edit().putBoolean(PREFS_RUNNING, running).commit()
    }

    private fun buildStatusText(): String {
        val portList = servers.keys.sorted()
        return if (portList.isEmpty()) {
            "No active servers."
        } else {
            val ports = portList.joinToString(", ")
            val hotspot = hotspotManager.currentSummary()
            if (hotspot.isBlank()) "Servers active on $ports." else "Servers active on $ports. $hotspot"
        }
    }

    companion object {
        const val ACTION_START = "com.example.libraryjs.START_SERVER"
        const val ACTION_STOP = "com.example.libraryjs.STOP_SERVER"
        private const val CHANNEL_ID = "libraryjs_server_channel"
        private const val NOTIFICATION_ID = 1001
        private const val PREFS_RUNNING = "server_running"

        @Volatile
        private var runningFlag: Boolean = false

        fun isRunning(): Boolean = runningFlag
    }
}
