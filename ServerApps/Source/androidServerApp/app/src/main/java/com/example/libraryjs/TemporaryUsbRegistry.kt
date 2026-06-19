package com.example.libraryjs

object TemporaryUsbRegistry {
    @Volatile
    private var temporaryUsbRoot: StorageRoot? = null

    fun set(root: StorageRoot) {
        temporaryUsbRoot = root.copy(isMain = false)
    }

    fun clear() {
        temporaryUsbRoot = null
    }

    fun get(): StorageRoot? = temporaryUsbRoot

    fun hasTemporaryRoot(): Boolean = temporaryUsbRoot != null
}
