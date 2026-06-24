package com.example.libraryjs

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.zip.ZipFile

object ReleaseBundleInstaller {
    private const val USER_AGENT = "LibraryJS-Android-Server/1.0"

    private data class PreservedFile(
        val relativePath: String,
        val bytes: ByteArray,
        val mimeType: String
    )

    fun installHostedBundle(
        context: Context,
        root: StorageRoot,
        releaseZipUrl: String,
        preserveRelativePaths: List<String> = emptyList(),
        onProgress: (String) -> Unit = {}
    ): String {
        onProgress("Downloading HostedByServerApp.zip...")
        val cacheDir = File(context.cacheDir, "libraryjs-release-install").apply { mkdirs() }
        val zipFile = File(cacheDir, "HostedByServerApp.zip")
        val tree = DocumentFile.fromTreeUri(context, Uri.parse(root.treeUri))
            ?: error("Selected main root is no longer available")

        val preserveTargets = preserveRelativePaths
            .map { normalizeEntryName(it) }
            .filter { it.isNotBlank() }
            .distinct()

        val preservedFiles = if (preserveTargets.isNotEmpty()) {
            onProgress("Saving ${preserveTargets.size} current file${if (preserveTargets.size == 1) "" else "s"}...")
            snapshotPreservedFiles(context, tree, preserveTargets)
        } else {
            emptyList()
        }

        downloadToFile(releaseZipUrl, zipFile)
        try {
            val installed = extractZipToTree(context, tree, zipFile, onProgress)
            val restored = if (preservedFiles.isNotEmpty()) {
                onProgress("Restoring preserved database files...")
                restorePreservedFiles(context, tree, preservedFiles, onProgress)
            } else {
                0
            }
            onProgress("Installed $installed file${if (installed == 1) "" else "s"} to ${root.displayName}.")
            return buildString {
                append("HostedByServerApp.zip installed to ")
                append(root.displayName)
                if (restored > 0) {
                    append(" with ")
                    append(restored)
                    append(" preserved file")
                    append(if (restored == 1) "" else "s")
                    append(" restored.")
                } else {
                    append('.')
                }
            }
        } finally {
            runCatching { zipFile.delete() }
        }
    }

    private fun downloadToFile(urlString: String, target: File) {
        target.parentFile?.mkdirs()
        val connection = (URL(urlString).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("User-Agent", USER_AGENT)
        }

        val code = connection.responseCode
        if (code !in 200..299) {
            connection.errorStream?.close()
            connection.disconnect()
            error("Download failed with HTTP $code")
        }

        connection.inputStream.buffered(DEFAULT_BUFFER_SIZE).use { input ->
            target.outputStream().buffered(256 * 1024).use { output ->
                input.copyTo(output, 256 * 1024)
            }
        }
        connection.disconnect()
    }

    private fun snapshotPreservedFiles(
        context: Context,
        tree: DocumentFile,
        preserveTargets: List<String>
    ): List<PreservedFile> {
        val out = mutableListOf<PreservedFile>()
        for (relative in preserveTargets) {
            val existing = findFileByRelativePath(tree, relative) ?: continue
            if (existing.isDirectory) continue
            val bytes = context.contentResolver.openInputStream(existing.uri)?.use { input ->
                input.readBytes()
            } ?: continue
            out += PreservedFile(relative, bytes, guessMimeType(relative.substringAfterLast('/')))
        }
        return out
    }

    private fun restorePreservedFiles(
        context: Context,
        tree: DocumentFile,
        preservedFiles: List<PreservedFile>,
        onProgress: (String) -> Unit
    ): Int {
        var count = 0
        for (file in preservedFiles) {
            onProgress("Restoring ${file.relativePath}...")
            val parentPath = file.relativePath.substringBeforeLast('/', missingDelimiterValue = "")
            val fileName = file.relativePath.substringAfterLast('/')
            val parentDir = ensureDirectory(tree, parentPath) ?: continue
            parentDir.findFile(fileName)?.delete()
            val created = parentDir.createFile(file.mimeType, fileName) ?: continue
            context.contentResolver.openOutputStream(created.uri)?.buffered(64 * 1024)?.use { output ->
                output.write(file.bytes)
                output.flush()
            } ?: continue
            count++
        }
        return count
    }

    private fun findFileByRelativePath(parent: DocumentFile, relativePath: String): DocumentFile? {
        var current = parent
        val segments = relativePath.replace('\\', '/').split('/').filter { it.isNotBlank() }
        if (segments.isEmpty()) return null
        for ((index, segment) in segments.withIndex()) {
            val next = current.findFile(segment) ?: return null
            if (index == segments.lastIndex) return next
            if (!next.isDirectory) return null
            current = next
        }
        return null
    }


    private fun ensureDirectoryCached(
        parent: DocumentFile,
        path: String,
        cache: MutableMap<String, DocumentFile>
    ): DocumentFile? {
        val key = normalizeEntryName(path).trim('/')
        if (key.isBlank()) return parent
        cache[key]?.let { return it }

        val current = ensureDirectory(parent, key) ?: return null
        cache[key] = current
        return current
    }

    private fun extractZipToTree(
        context: Context,
        tree: DocumentFile,
        zipFile: File,
        onProgress: (String) -> Unit
    ): Int {
        ZipFile(zipFile).use { zip ->
            val entryNames = zip.entries().asSequence()
                .filterNot { it.isDirectory }
                .map { normalizeEntryName(it.name) }
                .filter { it.isNotBlank() }
                .toList()

            val stripPrefix = detectSharedRootPrefix(entryNames)
            var count = 0

            for (rawName in entryNames) {
                val relative = stripLeadingPrefix(rawName, stripPrefix)
                if (!isSafeRelativePath(relative)) {
                    continue
                }

                val entry = zip.getEntry(rawName.replace('\\', '/')) ?: continue
                onProgress("Installing $relative...")
                val parentPath = relative.substringBeforeLast('/', missingDelimiterValue = "")
                val fileName = relative.substringAfterLast('/')
                val parentDir = ensureDirectory(tree, parentPath) ?: error("Could not create ${parentPath.ifBlank { "root" }}")

                parentDir.findFile(fileName)?.delete()
                val mimeType = guessMimeType(fileName)
                val created = parentDir.createFile(mimeType, fileName)
                    ?: error("Could not create $relative")

                context.contentResolver.openOutputStream(created.uri)?.use { output ->
                    zip.getInputStream(entry).use { input ->
                        input.copyTo(output)
                    }
                } ?: error("Could not open output stream for $relative")
                count++
            }
            return count
        }
    }

    private fun ensureDirectory(parent: DocumentFile, path: String): DocumentFile? {
        var current = parent
        if (path.isBlank()) return current
        for (segment in path.split('/')) {
            val clean = segment.trim().trim('.')
            if (clean.isBlank()) continue
            val existing = current.findFile(clean)
            current = when {
                existing?.isDirectory == true -> existing
                existing != null -> {
                    existing.delete()
                    current.createDirectory(clean) ?: return null
                }
                else -> current.createDirectory(clean) ?: return null
            }
        }
        return current
    }

    private fun normalizeEntryName(name: String): String {
        return name.replace('\\', '/')
            .trimStart('/')
            .removePrefix("./")
            .trim()
    }

    private fun detectSharedRootPrefix(names: List<String>): String? {
        if (names.isEmpty()) return null
        val firstSegments = names.mapNotNull { name ->
            val segment = name.substringBefore('/', missingDelimiterValue = "").trim()
            segment.takeIf { name.contains('/') && it.isNotBlank() }
        }
        if (firstSegments.isEmpty()) return null
        val distinct = firstSegments.distinct()
        return if (distinct.size == 1) distinct.first() else null
    }

    private fun stripLeadingPrefix(path: String, prefix: String?): String {
        var value = path
        if (!prefix.isNullOrBlank()) {
            val normalizedPrefix = prefix.trim('/').trim()
            if (value == normalizedPrefix) return ""
            if (value.startsWith("$normalizedPrefix/")) {
                value = value.removePrefix("$normalizedPrefix/")
            }
        }
        return value
    }

    private fun isSafeRelativePath(path: String): Boolean {
        if (path.isBlank()) return false
        val normalized = path.replace('\\', '/')
        if (normalized.startsWith('/') || normalized.startsWith("../") || normalized.contains("/../") || normalized == "..") {
            return false
        }
        return true
    }

    private fun guessMimeType(fileName: String): String {
        val lower = fileName.lowercase(Locale.US)
        return when {
            lower.endsWith(".html") || lower.endsWith(".htm") -> "text/html"
            lower.endsWith(".js") -> "application/javascript"
            lower.endsWith(".css") -> "text/css"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".txt") -> "text/plain"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".ico") -> "image/x-icon"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".mp4") -> "video/mp4"
            lower.endsWith(".m4a") -> "audio/mp4"
            lower.endsWith(".mp3") -> "audio/mpeg"
            lower.endsWith(".wav") -> "audio/wav"
            lower.endsWith(".flac") -> "audio/flac"
            else -> "application/octet-stream"
        }
    }
}
