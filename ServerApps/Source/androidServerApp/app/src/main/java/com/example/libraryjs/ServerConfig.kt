package com.example.libraryjs

object ServerConfig {
    const val DEFAULT_PORT = 8080
    const val PREFS_NAME = "libraryjs_server"
    const val PREFS_ROOTS = "storage_roots"
    const val PREFS_LAST_PORT = "last_port"
    const val PREFS_AUTO_OPEN_ON_BOOT = "auto_open_on_boot"
    const val PREFS_AUTO_START_SERVERS_ON_APP_OPEN = "auto_start_servers_on_app_open"
    const val PREFS_WIFI_BROADCAST_MODE = "wifi_broadcast_mode"
    const val PREFS_WIFI_HOTSPOT_SSID = "wifi_hotspot_ssid"
    const val PREFS_WIFI_HOTSPOT_PASSWORD = "wifi_hotspot_password"
    const val PREFS_WIFI_HOTSPOT_ACTIVE = "wifi_hotspot_active"
    const val WIFI_MODE_BROADCAST_OWN_WIFI = "broadcast_own_wifi"
    const val WIFI_MODE_USE_EXISTING_WIFI = "use_existing_wifi"
    const val WIFI_MODE_CURRENT_WIFI_ONLY = "current_wifi_only"
    const val WIFI_MODE_USE_EXISTING_WIFI_IF_POSSIBLE = "use_existing_wifi_if_possible"
    const val INSTALL_LIBRARYJS_URL = "https://github.com/SirRawrz/LibraryJS/releases/download/V1.0/HostedByServerApp.zip"
    val INSTALL_LIBRARYJS_PRESERVE_PATHS = listOf(
        "mainfolders.js",
        "library.js",
        "loadseasonfunctions.js",
        "musiclibrary.js",
        "manga.js",
        "books.js",
        "guidebooks.js",
        "profile.js",
        "games.js"
    )

    fun localhostUrl(port: Int, httpsEnabled: Boolean = false): String {
        val scheme = if (httpsEnabled) "https" else "http"
        return "$scheme://127.0.0.1:$port/?I"
    }
}
