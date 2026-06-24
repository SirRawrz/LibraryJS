package com.example.libraryjs

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Locale

object NetworkUtils {

    fun localIPv4Addresses(includeHotspot: Boolean = true): List<String> {
        return runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback && !it.isVirtual }
                .filter { includeHotspot || !it.name.equals("ap0", ignoreCase = true) }
                .flatMap { iface ->
                    iface.inetAddresses.toList()
                        .filterIsInstance<Inet4Address>()
                        .mapNotNull { it.hostAddress }
                }
                .filter(::isUsableIpv4)
                .distinct()
        }.getOrDefault(emptyList())
    }

    fun preferredLocalIPv4(broadcastOwnWifi: Boolean = true): String? {
        val interfaces = runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback && !it.isVirtual }
                .filter { broadcastOwnWifi || !it.name.equals("ap0", ignoreCase = true) }
        }.getOrDefault(emptyList())

        val preferredNames = if (broadcastOwnWifi) {
            listOf("ap0", "wlan0", "eth0", "rndis0")
        } else {
            listOf("wlan0", "eth0", "rndis0")
        }

        for (name in preferredNames) {
            val found = interfaces.firstOrNull { it.name.equals(name, ignoreCase = true) }
                ?.inetAddresses
                ?.toList()
                ?.filterIsInstance<Inet4Address>()
                ?.mapNotNull { it.hostAddress }
                ?.firstOrNull(::isUsableIpv4)
            if (found != null) return found
        }

        return localIPv4Addresses(includeHotspot = broadcastOwnWifi).firstOrNull()
    }

    fun serverUrls(port: Int, httpsEnabled: Boolean = false, broadcastOwnWifi: Boolean = true): List<String> {
        val urls = mutableListOf(ServerConfig.localhostUrl(port, httpsEnabled))
        preferredLocalIPv4(broadcastOwnWifi)?.let { ip ->
            val scheme = if (httpsEnabled) "https" else "http"
            val lanUrl = "$scheme://$ip:$port/?I"
            if (lanUrl !in urls) {
                urls.add(0, lanUrl)
            }
        }
        return urls.distinct()
    }

    fun primaryServerUrl(port: Int, httpsEnabled: Boolean = false, broadcastOwnWifi: Boolean = true): String {
        return serverUrls(port, httpsEnabled, broadcastOwnWifi).firstOrNull().orEmpty()
    }

    fun serverUrlLabel(port: Int, httpsEnabled: Boolean = false, broadcastOwnWifi: Boolean = true): String {
        return serverUrls(port, httpsEnabled, broadcastOwnWifi).joinToString(separator = "\n")
    }

    private fun isUsableIpv4(ip: String): Boolean {
        if (ip.isBlank()) return false
        if (ip == "127.0.0.1") return false
        val lower = ip.lowercase(Locale.US)
        if (lower.startsWith("169.254.")) return false
        return lower.startsWith("10.") ||
            lower.startsWith("192.168.") ||
            lower.startsWith("172.16.") ||
            lower.startsWith("172.17.") ||
            lower.startsWith("172.18.") ||
            lower.startsWith("172.19.") ||
            lower.startsWith("172.20.") ||
            lower.startsWith("172.21.") ||
            lower.startsWith("172.22.") ||
            lower.startsWith("172.23.") ||
            lower.startsWith("172.24.") ||
            lower.startsWith("172.25.") ||
            lower.startsWith("172.26.") ||
            lower.startsWith("172.27.") ||
            lower.startsWith("172.28.") ||
            lower.startsWith("172.29.") ||
            lower.startsWith("172.30.") ||
            lower.startsWith("172.31.")
    }
}

private fun <T> java.util.Enumeration<T>.toList(): List<T> {
    val out = mutableListOf<T>()
    while (hasMoreElements()) {
        out += nextElement()
    }
    return out
}
