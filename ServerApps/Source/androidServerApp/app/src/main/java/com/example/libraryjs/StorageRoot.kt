package com.example.libraryjs

data class StorageRoot(
    val id: String,
    val displayName: String,
    val treeUri: String,
    val port: Int,
    val httpsEnabled: Boolean = false,
    val isMain: Boolean = false
)

fun StorageRoot.signature(): String = listOf(
    id,
    displayName,
    treeUri,
    port.toString(),
    httpsEnabled.toString(),
    isMain.toString()
).joinToString("|")
