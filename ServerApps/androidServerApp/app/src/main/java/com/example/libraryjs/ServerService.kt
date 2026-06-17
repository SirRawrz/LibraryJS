package com.example.libraryjs

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.content.ComponentName
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.documentfile.provider.DocumentFile

class ServerService : Service() {

    private data class RunningServer(
        val root: StorageRoot,
        val server: LocalLibraryServer,
        val signature: String
    )

    private val servers = linkedMapOf<Int, RunningServer>()
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopAllServers()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                ensureServers()
                updateNotification()
                return START_STICKY
            }
            else -> {
                ensureServers()
                updateNotification()
                return START_STICKY
            }
        }
    }

    override fun onDestroy() {
        stopAllServers()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureServers() {
        val store = ServerStore(applicationContext)
        val roots = store.loadRoots().filter { it.treeUri.isNotBlank() }

        val duplicatePorts = roots.groupBy { it.port }
            .filterValues { it.size > 1 }
            .keys
            .sorted()

        if (duplicatePorts.isNotEmpty()) {
            updateNotification("Duplicate ports: ${duplicatePorts.joinToString(", ")}")
            stopAllServers()
            return
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
                return
            }
        }

        if (servers.isNotEmpty()) {
            writeStartupMetadataFiles(roots)
            acquireWakeLock()
        }
        setRunning(servers.isNotEmpty())
    }

    private fun stopAllServers() {
        servers.values.forEach { runCatching { it.server.stop() } }
        servers.clear()
        releaseWakeLock()
        setRunning(false)
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

    private fun buildStatusText(): String {
        if (servers.isEmpty()) return "No storage roots configured."

        val sortedServers = servers.values.sortedBy { it.root.port }
        val portsText = sortedServers.joinToString(", ") { it.root.port.toString() }
        val urlsText = sortedServers
            .flatMap { NetworkUtils.serverUrls(it.root.port, it.root.httpsEnabled) }
            .distinct()
            .joinToString("\n")
        return "Running on ports: $portsText\n$urlsText"
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "LibraryJS Server",
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun StorageRoot.signature(): String {
        return listOf(id, treeUri, port.toString(), httpsEnabled.toString()).joinToString("|")
    }

    companion object {
        const val ACTION_START = "com.example.libraryjs.action.START"
        const val ACTION_STOP = "com.example.libraryjs.action.STOP"
        private const val CHANNEL_ID = "libraryjs_server"
        private const val NOTIFICATION_ID = 1001
        @Volatile private var running = false
        fun isRunning(): Boolean = running
        internal fun setRunning(value: Boolean) {
            running = value
        }
    }
}
