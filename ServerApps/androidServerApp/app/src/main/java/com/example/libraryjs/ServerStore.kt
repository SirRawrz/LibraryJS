package com.example.libraryjs

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences(ServerConfig.PREFS_NAME, Context.MODE_PRIVATE)

    fun loadRoots(): List<StorageRoot> {
        val raw = prefs.getString(ServerConfig.PREFS_ROOTS, "[]") ?: "[]"
        val fallbackPort = loadLastPort()
        val list = mutableListOf<StorageRoot>()
        var hasExplicitMainFlags = false
        runCatching { JSONArray(raw) }.onSuccess { arr ->
            hasExplicitMainFlags = (0 until arr.length()).any { idx ->
                arr.optJSONObject(idx)?.has("isMain") == true
            }

            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val id = obj.optString("id").trim()
                val name = obj.optString("displayName").trim()
                val uri = obj.optString("treeUri").trim()
                val port = obj.optInt("port", if (i == 0) fallbackPort else ServerConfig.DEFAULT_PORT + i)
                val httpsEnabled = obj.optBoolean("httpsEnabled", false)
                val isMain = if (hasExplicitMainFlags) {
                    obj.optBoolean("isMain", false)
                } else {
                    i == 0
                }
                if (id.isNotBlank() && name.isNotBlank() && uri.isNotBlank()) {
                    list += StorageRoot(id, name, uri, port.coerceIn(1, 65535), httpsEnabled, isMain)
                }
            }
        }
        return normalizeRoots(list, promoteFirstWhenMissing = !hasExplicitMainFlags)
    }

    fun loadMainRoot(): StorageRoot? = loadRoots().firstOrNull { it.isMain } ?: loadRoots().firstOrNull()

    fun loadExtendedRoots(): List<StorageRoot> = loadRoots().filterNot { it.isMain }

    fun saveRoots(roots: List<StorageRoot>) {
        persistRoots(roots)
        roots.firstOrNull { it.isMain }?.let { saveLastPort(it.port) }
    }

    fun saveMainRoot(root: StorageRoot) {
        val normalized = root.copy(isMain = true)
        val remaining = loadRoots().filterNot { it.id == normalized.id || it.treeUri == normalized.treeUri || it.isMain }.map { it.copy(isMain = false) }
        persistRoots(listOf(normalized) + remaining)
        saveLastPort(normalized.port)
    }

    fun saveExtendedRoot(root: StorageRoot) {
        val normalized = root.copy(isMain = false)
        val existing = loadRoots().toMutableList()
        val index = existing.indexOfFirst { !it.isMain && (it.id == normalized.id || it.treeUri == normalized.treeUri) }
        if (index >= 0) existing[index] = normalized else existing += normalized
        persistRoots(existing)
    }

    fun removeRoot(id: String) {
        val remaining = loadRoots().filterNot { it.id == id }
        persistRoots(remaining)
    }

    fun makeStableRootId(displayName: String, treeUri: String): String {
        val slug = displayName.lowercase(Locale.US)
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .ifBlank { "root" }
        val hash = treeUri.hashCode().toUInt().toString(36)
        return "$slug-$hash"
    }


    fun loadAutoOpenOnBoot(): Boolean = prefs.getBoolean(ServerConfig.PREFS_AUTO_OPEN_ON_BOOT, false)

    fun saveAutoOpenOnBoot(enabled: Boolean) {
        prefs.edit().putBoolean(ServerConfig.PREFS_AUTO_OPEN_ON_BOOT, enabled).commit()
    }

    fun loadAutoStartServersOnAppOpen(): Boolean = prefs.getBoolean(ServerConfig.PREFS_AUTO_START_SERVERS_ON_APP_OPEN, false)

    fun saveAutoStartServersOnAppOpen(enabled: Boolean) {
        prefs.edit().putBoolean(ServerConfig.PREFS_AUTO_START_SERVERS_ON_APP_OPEN, enabled).commit()
    }
    fun loadLastPort(): Int = prefs.getInt(ServerConfig.PREFS_LAST_PORT, ServerConfig.DEFAULT_PORT)
        .coerceIn(1, 65535)

    fun saveLastPort(port: Int) {
        prefs.edit().putInt(ServerConfig.PREFS_LAST_PORT, port.coerceIn(1, 65535)).commit()
    }

    fun nextAvailablePort(existingPorts: Set<Int> = loadRoots().map { it.port }.toSet()): Int {
        val preferred = loadLastPort().coerceIn(1, 65535)
        if (preferred !in existingPorts) return preferred
        var candidate = maxOf(ServerConfig.DEFAULT_PORT, existingPorts.maxOrNull()?.plus(1) ?: ServerConfig.DEFAULT_PORT)
        while (candidate in existingPorts && candidate < 65535) candidate++
        return candidate.coerceAtMost(65535)
    }

    private fun normalizeRoots(roots: List<StorageRoot>, promoteFirstWhenMissing: Boolean): List<StorageRoot> {
        if (roots.isEmpty()) return roots
        val mainIndex = roots.indexOfFirst { it.isMain }
        return when {
            mainIndex < 0 && promoteFirstWhenMissing -> roots.mapIndexed { index, root -> root.copy(isMain = index == 0) }
            mainIndex < 0 -> roots.map { it.copy(isMain = false) }
            mainIndex == 0 -> roots
            else -> buildList {
                add(roots[mainIndex].copy(isMain = true))
                roots.forEachIndexed { index, root ->
                    if (index != mainIndex) add(root.copy(isMain = false))
                }
            }
        }
    }

    private fun persistRoots(roots: List<StorageRoot>) {
        val json = JSONArray().apply {
            roots.forEach {
                put(JSONObject().apply {
                    put("id", it.id)
                    put("displayName", it.displayName)
                    put("treeUri", it.treeUri)
                    put("port", it.port)
                    put("httpsEnabled", it.httpsEnabled)
                    put("isMain", it.isMain)
                })
            }
        }.toString()
        prefs.edit().putString(ServerConfig.PREFS_ROOTS, json).commit()
    }
}
