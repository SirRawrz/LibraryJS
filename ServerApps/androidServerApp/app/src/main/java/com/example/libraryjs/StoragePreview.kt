package com.example.libraryjs

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.util.Locale

fun describeStorageTree(
    context: Context,
    root: StorageRoot,
    maxDepth: Int = 2,
    maxEntriesPerDirectory: Int = 40
): String {
    val tree = runCatching { DocumentFile.fromTreeUri(context, Uri.parse(root.treeUri)) }.getOrNull()
        ?: return "${root.displayName}\n${root.treeUri}\nStorage root unavailable."

    return buildString {
        append(root.displayName)
        append("\n")
        append(root.treeUri)
        append("\n")
        renderDocumentFile(
            file = tree,
            out = this,
            depth = 0,
            maxDepth = maxDepth,
            maxEntriesPerDirectory = maxEntriesPerDirectory
        )
    }.trim()
}

private fun renderDocumentFile(
    file: DocumentFile,
    out: StringBuilder,
    depth: Int,
    maxDepth: Int,
    maxEntriesPerDirectory: Int
) {
    if (!file.isDirectory || depth >= maxDepth) return

    val children = runCatching { file.listFiles() }
        .getOrDefault(emptyArray())
        .sortedBy { it.name?.lowercase(Locale.US).orEmpty() }

    val shown = children.take(maxEntriesPerDirectory)
    for (child in shown) {
        repeat(depth) { out.append("  ") }
        out.append(if (child.isDirectory) "📁 " else "📄 ")
        out.append(child.name ?: "(unnamed)")
        if (child.isDirectory) {
            out.append("/")
        } else {
            child.type?.let {
                out.append("  [")
                out.append(it)
                out.append("]")
            }
            if (child.length() >= 0) {
                out.append("  ")
                out.append(child.length())
                out.append(" bytes")
            }
        }
        out.append("\n")
        if (child.isDirectory) {
            renderDocumentFile(child, out, depth + 1, maxDepth, maxEntriesPerDirectory)
        }
    }
    if (children.size > shown.size) {
        repeat(depth) { out.append("  ") }
        out.append("… ")
        out.append(children.size - shown.size)
        out.append(" more items\n")
    }
}
