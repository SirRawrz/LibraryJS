package com.example.libraryjs

object ServerConfig {
    const val DEFAULT_PORT = 8080
    const val PREFS_NAME = "libraryjs_server"
    const val PREFS_ROOTS = "storage_roots"
    const val PREFS_LAST_PORT = "last_port"
    const val PREFS_AUTO_OPEN_ON_BOOT = "auto_open_on_boot"
    const val PREFS_AUTO_START_SERVERS_ON_APP_OPEN = "auto_start_servers_on_app_open"
    const val INSTALL_LIBRARYJS_URL = "https://github.com/search?q=HostedByServer&type=repositories"

    fun localhostUrl(port: Int, httpsEnabled: Boolean = false): String {
        val scheme = if (httpsEnabled) "https" else "http"
        return "$scheme://127.0.0.1:$port/?I"
    }
}
