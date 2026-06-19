package com.example.libraryjs

data class StorageRoot(
    val id: String,
    val displayName: String,
    val treeUri: String,
    val port: Int,
    val httpsEnabled: Boolean = false,
    val isMain: Boolean = false
)
