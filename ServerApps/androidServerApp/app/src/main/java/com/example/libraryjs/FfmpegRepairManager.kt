package com.example.libraryjs

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.min

class FfmpegRepairManager(
    private val context: Context,
    private val root: StorageRoot
) {
    private val jobs = ConcurrentHashMap<String, FfmpegRepairJob>()
    private val executor = Executors.newCachedThreadPool()

    fun handle(req: HttpRequest): HttpResponse {
        return when (req.method.uppercase(Locale.US)) {
            "GET" -> handleGet(req)
            "POST" -> handlePost(req)
            else -> jsonResponse(405, mapOf("ok" to false, "error" to "Use POST or GET"))
        }
    }

    private fun handleGet(req: HttpRequest): HttpResponse {
        val jobId = req.target.substringAfterLast('/').trim()
        val job = jobs[jobId] ?: return jsonResponse(404, mapOf("ok" to false, "error" to "Job not found"))
        return jsonResponse(200, mapOf("ok" to true, "job" to job.snapshot()))
    }

    private fun handlePost(req: HttpRequest): HttpResponse {
        val payload = bodyJson(req) ?: return jsonResponse(
            400,
            mapOf("ok" to false, "error" to "Invalid JSON body")
        )

        val sourceRef = firstNonBlank(
            payload.optString("sourcePath"),
            payload.optString("source"),
            payload.optString("sourceUrl"),
            payload.optString("sourceUri")
        )

        if (sourceRef.isBlank()) {
            return jsonResponse(400, mapOf("ok" to false, "error" to "Missing source path or URL"))
        }

        val targetRef = firstNonBlank(
            payload.optString("targetPath"),
            payload.optString("target"),
            payload.optString("targetUrl")
        )
        val outputName = firstNonBlank(
            payload.optString("outputName"),
            payload.optString("filename")
        )

        val sourceFolderRef = firstNonBlank(
            payload.optString("sourceFolder"),
            payload.optString("stagingFolder"),
            payload.optString("jobFolder")
        )
        val preparedSource = prepareSource(sourceRef, sourceFolderRef, payload.optString("sourceUrl"))
            ?: return jsonResponse(
                404,
                mapOf(
                    "ok" to false,
                    "error" to "Source file not found",
                    "sourcePath" to sourceRef,
                    "sourceUrl" to payload.optString("sourceUrl")
                )
            )

        val resolvedTarget = prepareTarget(
            sourceRef = sourceRef,
            targetRef = targetRef,
            outputName = outputName,
            sourceDisplayName = preparedSource.displayName
        ) ?: return jsonResponse(
            400,
            mapOf("ok" to false, "error" to "Missing or invalid target path")
        )

        val job = FfmpegRepairJob(
            id = "ffmpeg_${System.currentTimeMillis()}_${randomToken()}",
            sourceRef = sourceRef,
            sourceUrl = preparedSource.sourceUrl,
            sourceTemp = preparedSource.sourceTemp?.absolutePath.orEmpty(),
            sourceDisplayName = preparedSource.displayName,
            sourceCleanupPath = preparedSource.cleanupPath.orEmpty(),
            targetRef = targetRef,
            targetDisplayName = resolvedTarget.displayPath,
            targetTemp = resolvedTarget.tempOutput.absolutePath,
            startedAt = Instant.now().toString()
        )

        jobs[job.id] = job
        appendLog(job, "Starting server-side FFmpeg repair")
        appendLog(job, "Source: ${job.sourceUrl.ifBlank { job.sourceRef }}")
        appendLog(job, "Target: ${job.targetRef.ifBlank { job.targetDisplayName }}")
        appendLog(job, "Temp: ${job.targetTemp}")

        executor.execute {
            runJob(job, preparedSource, resolvedTarget)
        }

        return jsonResponse(202, mapOf("ok" to true, "job" to job.snapshot()))
    }

    private fun runJob(job: FfmpegRepairJob, source: PreparedSource, target: PreparedTarget) {
        val workDir = File(context.cacheDir, "libraryjs-ffmpeg/${job.id}").apply { mkdirs() }
        val binary = tryResolveFfmpegBinary(workDir)
        if (binary == null) {
            failJob(job, "FFmpeg binary not found. Place an executable at app/src/main/assets/ffmpeg/ffmpeg or app/src/main/assets/ffmpeg/<abi>/ffmpeg, or in app-private storage.")
            cleanupTemp(job, source, target, workDir)
            return
        }

        try {
            job.status = "running"
            job.updatedAt = Instant.now().toString()

            val inputSpec = if (source.sourceUrl.isNotBlank()) {
                source.sourceUrl
            } else {
                source.sourceTemp?.absolutePath ?: throw IllegalStateException("Missing local input")
            }

            val args = listOf(
                binary.absolutePath,
                "-hide_banner",
                "-nostdin",
                "-y",
                "-err_detect",
                "ignore_err",
                "-fflags",
                "+genpts+discardcorrupt",
                "-i",
                inputSpec,
                "-map",
                "0",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                target.tempOutput.absolutePath
            )

            appendLog(job, "Launching ffmpeg")
            appendLog(job, args.joinToString(" ") { shellQuote(it) })

            val process = ProcessBuilder(args)
                .directory(workDir)
                .redirectErrorStream(true)
                .start()

            // Android API/toolchain compatibility: avoid relying on Process.pid().
            job.pid = null
            job.updatedAt = Instant.now().toString()

            process.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (line in lines) {
                    appendLog(job, line)
                }
            }

            val exitCode = process.waitFor()
            job.exitCode = exitCode
            val finishedAt = Instant.now().toString()
            job.finishedAt = finishedAt
            job.updatedAt = finishedAt

            if (exitCode != 0) {
                throw IllegalStateException("ffmpeg exited with code $exitCode")
            }

            if (target.isRemoteUpload) {
                appendLog(job, "Uploading output to ${target.targetUrl}")
                uploadFileToUrl(target.tempOutput, target.targetUrl)
                appendLog(job, "Output uploaded successfully")
            } else {
                commitLocalTarget(target)
                appendLog(job, "Output saved successfully")
            }

            cleanupTemporarySourceFolder(source.cleanupPath)?.let { note ->
                appendLog(job, note)
            }

            job.status = "done"
            appendLog(job, "Repair finished")
        } catch (error: Exception) {
            failJob(job, error.message ?: error.javaClass.simpleName)
        } finally {
            cleanupTemp(job, source, target, workDir)
        }
    }

    private fun commitLocalTarget(target: PreparedTarget) {
        val parent = target.parentDir ?: throw IllegalStateException("Could not resolve target directory")
        parent.findFile(target.fileName)?.delete()
        val created = parent.createFile(guessMimeType(target.fileName), target.fileName)
            ?: throw IllegalStateException("Could not create target file")
        context.contentResolver.openOutputStream(created.uri)?.use { out ->
            target.tempOutput.inputStream().use { input -> input.copyToBuffered(out) }
            out.flush()
        } ?: throw IllegalStateException("Could not open target output stream")
        runCatching { target.tempOutput.delete() }
    }

    private fun cleanupTemp(job: FfmpegRepairJob, source: PreparedSource, target: PreparedTarget, workDir: File) {
        runCatching { source.sourceWorkDir?.deleteRecursively() }
        runCatching { source.sourceTemp?.delete() }
        runCatching { target.tempOutput.delete() }
        runCatching { workDir.deleteRecursively() }
        runCatching {
            val parent = workDir.parentFile
            if (parent != null && parent.exists() && parent.listFiles().orEmpty().isEmpty()) {
                parent.delete()
            }
        }
    }

    private fun failJob(job: FfmpegRepairJob, errorMessage: String) {
        job.status = "error"
        job.error = errorMessage
        val finishedAt = Instant.now().toString()
        job.finishedAt = finishedAt
        job.updatedAt = finishedAt
        appendLog(job, errorMessage)
    }

    private fun appendLog(job: FfmpegRepairJob, line: String) {
        val text = line.replace("\r", "").trimEnd()
        if (text.isBlank()) return
        synchronized(job.logs) {
            job.logs += text
            if (job.logs.size > 400) {
                val drop = job.logs.size - 400
                repeat(drop) { job.logs.removeAt(0) }
            }
        }
        job.updatedAt = Instant.now().toString()
    }

    private fun cleanupTemporarySourceFolder(pathRef: String?): String? {
        val folderPath = folderPathFromReference(pathRef ?: return null) ?: return null
        val normalized = normalizePath(folderPath)
        val segments = normalizePathSegments(normalized)
        if (segments.isEmpty()) return null

        val allowedRoots = setOf("libraryjs-upload-temp", "libraryjs-temp-upload", ".libraryjs-temp-upload")
        val rootName = segments.firstOrNull()?.lowercase(Locale.US) ?: return null
        if (rootName !in allowedRoots) return null

        val tree = DocumentFile.fromTreeUri(context, Uri.parse(root.treeUri)) ?: return "Temp folder cleanup skipped: storage root unavailable"
        val target = resolveDocument(tree, segments) ?: return "Temp folder cleanup skipped: folder not found"
        return if (deleteDocumentTree(target)) {
            "Temporary upload folder cleaned: $folderPath"
        } else {
            "Temp folder cleanup skipped: delete failed"
        }
    }

    private fun deleteDocumentTree(target: DocumentFile): Boolean {
        if (target.isDirectory) {
            target.listFiles().forEach { child ->
                deleteDocumentTree(child)
            }
        }
        return runCatching { target.delete() }.getOrDefault(false)
    }

    private fun folderPathFromReference(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isBlank()) return null
        val path = when {
            text.startsWith("http://", ignoreCase = true) || text.startsWith("https://", ignoreCase = true) -> urlPathOnly(text)
            else -> normalizePath(text)
        }.trim()
        if (path.isBlank()) return null
        return when {
            path.endsWith("/") -> path
            else -> path.substringBeforeLast('/', "").let { parent ->
                val normalizedParent = if (parent.isBlank()) "/" else parent
                if (normalizedParent.endsWith("/")) normalizedParent else "$normalizedParent/"
            }
        }
    }

    private fun prepareSource(sourceRef: String, sourceFolderRef: String, sourceUrl: String): PreparedSource? {
        val url = firstHttpUrl(sourceUrl, sourceRef)
        if (url != null) {
            return PreparedSource(
                sourceUrl = url,
                sourceTemp = null,
                sourceWorkDir = null,
                displayName = url.substringAfterLast('/').ifBlank { "source" },
                cleanupPath = firstNonBlank(sourceFolderRef, folderPathFromReference(url))
            )
        }

        val sourceDocument = resolveExistingDocument(sourceRef) ?: return null
        if (sourceDocument.isDirectory) return null

        val sourceWorkDir = createWorkDir("input-${sanitizeFilename(sourceDocument.name ?: "source")}")
        val sourceName = sanitizeFilename(sourceDocument.name ?: "source")
        val copiedFile = File(sourceWorkDir, sourceName)
        context.contentResolver.openInputStream(sourceDocument.uri)?.use { input ->
            copiedFile.outputStream().use { output -> input.copyToBuffered(output, 4 * 1024 * 1024) }
        } ?: return null

        if (!copiedFile.exists()) return null

        return PreparedSource(
            sourceUrl = "",
            sourceTemp = copiedFile,
            sourceWorkDir = sourceWorkDir,
            displayName = sourceDocument.name ?: copiedFile.name,
            cleanupPath = null
        )
    }

    private fun prepareTarget(
        sourceRef: String,
        targetRef: String,
        outputName: String,
        sourceDisplayName: String
    ): PreparedTarget? {
        val fallbackName = sanitizeFilename(
            firstNonBlank(
                outputName,
                sourceDisplayName.takeIf { it.isNotBlank() },
                pathNameFallback(sourceRef)
            ).ifBlank { "repaired.mp4" }
        ).let { ensureMp4Suffix(it) }

        val targetText = firstNonBlank(targetRef, "")
        val targetUrl = firstHttpUrl(targetText, "")

        if (targetUrl != null) {
            val tempOutputName = sanitizeFilename(
                firstNonBlank(
                    outputName,
                    pathNameFallback(targetUrl),
                    sourceDisplayName.takeIf { it.isNotBlank() },
                    pathNameFallback(sourceRef)
                ).ifBlank { "repaired.mp4" }
            ).let { ensureMp4Suffix(it) }
            val tempOutput = createWorkFile("output-$tempOutputName")
            return PreparedTarget(
                parentDir = null,
                fileName = tempOutputName,
                tempOutput = tempOutput,
                displayPath = targetUrl,
                targetUrl = targetUrl,
                isRemoteUpload = true
            )
        }

        return resolveLocalTarget(targetText, fallbackName)
            ?: resolveLocalTarget(sourceRef, fallbackName)
            ?: null
    }

    private fun resolveLocalTarget(rawTarget: String, fallbackName: String): PreparedTarget? {
        val normalized = normalizePath(rawTarget)
        val tree = DocumentFile.fromTreeUri(context, Uri.parse(root.treeUri)) ?: return null
        val segments = normalizePathSegments(normalized)

        val (parentSegments, finalName) = when {
            segments.isEmpty() -> emptyList<String>() to fallbackName
            normalized.endsWith("/") || normalized.endsWith("\\") -> segments to fallbackName
            else -> segments.dropLast(1) to sanitizeFilename(segments.last()).ifBlank { fallbackName }
        }

        val parentDir = if (parentSegments.isEmpty()) tree else resolveOrCreateDirectories(tree, parentSegments) ?: return null
        val fileName = ensureMp4Suffix(sanitizeFilename(finalName).ifBlank { fallbackName })
        val tempOutput = createWorkFile("output-${sanitizeFilename(fileName)}")
        return PreparedTarget(
            parentDir = parentDir,
            fileName = fileName,
            tempOutput = tempOutput,
            displayPath = buildDisplayPath(parentSegments, fileName),
            targetUrl = "",
            isRemoteUpload = false
        )
    }

    private fun resolveOrCreateDirectories(tree: DocumentFile, segments: List<String>): DocumentFile? {
        var current = tree
        for (segment in segments) {
            val existing = childNamed(current, segment)
            current = when {
                existing == null -> current.createDirectory(segment) ?: return null
                existing.isDirectory -> existing
                else -> return null
            }
        }
        return current
    }

    private fun resolveDocument(tree: DocumentFile, segments: List<String>): DocumentFile? {
        var current = tree
        for (segment in segments) {
            current = childNamed(current, segment) ?: return null
        }
        return current
    }

    private fun resolveExistingDocument(raw: String): DocumentFile? {
        val tree = DocumentFile.fromTreeUri(context, Uri.parse(root.treeUri)) ?: return null
        val segments = normalizePathSegments(normalizePath(raw))
        val resolved = when {
            segments.isEmpty() -> tree
            segments.firstOrNull() == "storage" && segments.getOrNull(1) == root.id -> resolveDocument(tree, segments.drop(2))
            segments.firstOrNull() == root.id -> resolveDocument(tree, segments.drop(1))
            else -> resolveDocument(tree, segments)
        } ?: return null
        return resolved
    }

    private fun childNamed(parent: DocumentFile, name: String): DocumentFile? {
        parent.findFile(name)?.let { return it }
        return parent.listFiles().firstOrNull { it.name == name }
    }

    private fun createWorkDir(name: String): File {
        val baseDir = File(context.cacheDir, "libraryjs-ffmpeg/work").apply { mkdirs() }
        val workDir = File(baseDir, "${sanitizeFilename(name)}-${randomToken()}")
        workDir.mkdirs()
        return workDir
    }

    private fun createWorkFile(name: String): File {
        val dir = File(context.cacheDir, "libraryjs-ffmpeg/work").apply { mkdirs() }
        return File(dir, name)
    }

    private fun pathNameFallback(raw: String): String {
        val text = normalizePath(raw)
        return text.substringAfterLast('/', "").ifBlank { "repaired.mp4" }
    }

    private fun normalizePath(raw: String): String {
        val text = raw.trim()
        if (text.isBlank()) return "/"
        return try {
            val decoded = URLDecoder.decode(text, "UTF-8").replace('\\', '/')
            if (decoded.startsWith("/")) decoded else "/$decoded"
        } catch (_: Exception) {
            val fallback = text.replace('\\', '/')
            if (fallback.startsWith("/")) fallback else "/$fallback"
        }
    }

    private fun normalizePathSegments(normalized: String): List<String> {
        val segments = mutableListOf<String>()
        for (segment in normalized.removePrefix("/").split('/')) {
            when (segment) {
                "", "." -> Unit
                ".." -> if (segments.isNotEmpty()) segments.removeAt(segments.lastIndex)
                else -> segments += segment
            }
        }
        return when {
            segments.firstOrNull() == "storage" && segments.getOrNull(1) == root.id -> segments.drop(2)
            segments.firstOrNull() == root.id -> segments.drop(1)
            else -> segments
        }
    }

    private fun buildDisplayPath(parentSegments: List<String>, fileName: String): String {
        val prefix = if (parentSegments.isEmpty()) "/" else "/" + parentSegments.joinToString("/") + "/"
        return prefix + fileName
    }

    private fun looksLikeFileName(value: String): Boolean {
        val text = value.trim()
        return text.contains('.') && !text.endsWith(".")
    }

    private fun ensureMp4Suffix(name: String): String {
        return if (name.lowercase(Locale.US).endsWith(".mp4")) name else "$name.mp4"
    }

    private fun sanitizeFilename(input: String): String {
        val raw = input.trim().ifBlank { "repaired.mp4" }
        return raw.replace(Regex("""[\\/:*?"<>|]+"""), "_")
    }

    private fun firstHttpUrl(vararg values: String): String? {
        for (value in values) {
            val candidate = normalizeUrlLikeReference(value)
            if (candidate.startsWith("http://", ignoreCase = true) || candidate.startsWith("https://", ignoreCase = true)) {
                return candidate
            }
        }
        return null
    }

    private fun normalizeUrlLikeReference(raw: String): String {
        val text = raw.trim()
        if (text.isBlank()) return ""

        var candidate = when {
            text.startsWith("http://", ignoreCase = true) || text.startsWith("https://", ignoreCase = true) -> text
            text.startsWith("http_", ignoreCase = true) -> "http://" + text.substring(5).trimStart('_', '/')
            text.startsWith("https_", ignoreCase = true) -> "https://" + text.substring(6).trimStart('_', '/')
            else -> text
        }

        val schemeEnd = candidate.indexOf("://")
        if (schemeEnd >= 0) {
            val authorityStart = schemeEnd + 3
            val pathStart = candidate.indexOf('/', authorityStart).let { if (it < 0) candidate.length else it }
            val authority = candidate.substring(authorityStart, pathStart)
            val portSep = authority.lastIndexOf('_')
            if (portSep > 0 && portSep < authority.length - 1) {
                val port = authority.substring(portSep + 1)
                if (port.all { it.isDigit() }) {
                    candidate = candidate.substring(0, authorityStart) +
                        authority.substring(0, portSep) +
                        ':' +
                        port +
                        candidate.substring(pathStart)
                }
            }
        }

        return candidate
    }

    private fun urlPathOnly(urlText: String): String {
        return runCatching { URL(urlText).path.orEmpty() }.getOrDefault("/")
    }

    private fun firstNonBlank(vararg values: String?): String {
        for (value in values) {
            val candidate = value?.trim().orEmpty()
            if (candidate.isNotBlank()) return candidate
        }
        return ""
    }

    private fun guessMimeType(name: String): String {
        val lower = name.lowercase(Locale.US)
        return when {
            lower.endsWith(".mp4") -> "video/mp4"
            lower.endsWith(".mkv") -> "video/x-matroska"
            lower.endsWith(".mov") -> "video/quicktime"
            lower.endsWith(".webm") -> "video/webm"
            lower.endsWith(".m4v") -> "video/mp4"
            lower.endsWith(".avi") -> "video/x-msvideo"
            lower.endsWith(".mp3") -> "audio/mpeg"
            lower.endsWith(".m4a") -> "audio/mp4"
            lower.endsWith(".aac") -> "audio/aac"
            lower.endsWith(".flac") -> "audio/flac"
            else -> "application/octet-stream"
        }
    }

    private fun randomToken(): String {
        return buildString {
            val source = "abcdefghijklmnopqrstuvwxyz0123456789"
            repeat(8) {
                append(source.random())
            }
        }
    }

    private fun jobDirPrefix(): String {
        return "job-${System.currentTimeMillis()}-${randomToken()}"
    }

    private fun createWorkRoot(): File {
        return File(context.cacheDir, "libraryjs-ffmpeg/${jobDirPrefix()}").apply { mkdirs() }
    }

    private fun tryResolveFfmpegBinary(workDir: File): File? {
        // Prefer a binary packaged as a native library. Android can execute files from
        // nativeLibraryDir much more reliably than a copied app-private cache file.
        val nativeLibDir = runCatching { File(context.applicationInfo.nativeLibraryDir) }.getOrNull()
        val nativeCandidates = listOf(
            "libffmpeg.so",
            "ffmpeg"
        ).mapNotNull { name ->
            nativeLibDir?.let { File(it, name) }
        }

        for (candidate in nativeCandidates) {
            if (candidate.exists() && isLaunchableExecutable(candidate)) {
                return candidate
            }
        }

        // Legacy fallback: keep supporting the old asset -> private cache flow.
        // If a stale copy already exists but cannot be executed, remove it and refresh.
        val cacheRoot = File(context.filesDir, "ffmpeg").apply { mkdirs() }
        val cacheBinary = File(cacheRoot, "ffmpeg")
        if (cacheBinary.exists() && !isLaunchableExecutable(cacheBinary)) {
            runCatching { cacheBinary.delete() }
        }
        if (cacheBinary.exists() && isLaunchableExecutable(cacheBinary)) {
            return cacheBinary
        }

        val assetCandidates = buildList {
            for (abi in Build.SUPPORTED_ABIS) {
                add("ffmpeg/$abi/libffmpeg.so")
                add("ffmpeg/$abi/ffmpeg")
                add("ffmpeg/$abi/ffmpeg.exe")
            }
            add("ffmpeg/libffmpeg.so")
            add("ffmpeg/ffmpeg")
            add("ffmpeg")
        }

        for (assetPath in assetCandidates) {
            if (extractAssetExecutable(assetPath, cacheBinary) && isLaunchableExecutable(cacheBinary)) {
                return cacheBinary
            }
            runCatching { cacheBinary.delete() }
        }

        return null
    }

    private fun isLaunchableExecutable(binary: File): Boolean {
        return runCatching {
            val process = ProcessBuilder(binary.absolutePath, "-version")
                .redirectErrorStream(true)
                .start()
            process.destroy()
            true
        }.getOrDefault(false)
    }

    private fun extractAssetExecutable(assetPath: String, destination: File): Boolean {
        return runCatching {
            context.assets.open(assetPath).use { input ->
                destination.parentFile?.mkdirs()
                destination.outputStream().use { output -> input.copyToBuffered(output) }
            }
            destination.setExecutable(true, true)
            destination.setReadable(true, true)
            destination.setWritable(true, true)
            true
        }.getOrDefault(false)
    }

    private fun uploadFileToUrl(source: File, targetUrl: String) {
        val connection = URL(targetUrl).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.connectTimeout = 30_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("Content-Type", "application/octet-stream")
            connection.setFixedLengthStreamingMode(source.length())
            connection.setRequestProperty("Content-Length", source.length().toString())
            connection.outputStream.use { output ->
                source.inputStream().use { input -> input.copyToBuffered(output) }
            }
            val code = connection.responseCode
            if (code !in 200..299) {
                val errorText = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                throw IllegalStateException("Upload failed: HTTP $code ${connection.responseMessage}${if (errorText.isNotBlank()) " - $errorText" else ""}")
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun bodyJson(req: HttpRequest): JSONObject? {
        val text = String(req.body, Charsets.UTF_8).trim()
        if (text.isBlank()) return null
        return runCatching { JSONObject(text) }.getOrNull()
    }

    private fun jsonResponse(status: Int, data: Any): HttpResponse {
        val body = when (data) {
            is String -> data
            else -> JSONObject.wrap(data)?.toString() ?: "{}"
        }
        return HttpResponse(
            status = status,
            reason = reasonFor(status),
            headers = linkedMapOf("Content-Type" to "application/json; charset=utf-8"),
            bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
        )
    }


    private fun InputStream.copyToBuffered(output: OutputStream, bufferSize: Int = 4 * 1024 * 1024): Long {
        val buffer = ByteArray(bufferSize)
        var total = 0L
        while (true) {
            val read = read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            total += read
        }
        return total
    }

    private fun reasonFor(status: Int): String = when (status) {
        200 -> "OK"
        202 -> "Accepted"
        204 -> "No Content"
        400 -> "Bad Request"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        500 -> "Internal Server Error"
        501 -> "Not Implemented"
        else -> "OK"
    }

    private fun shellQuote(value: String): String {
        if (value.isBlank()) return "''"
        return "'${value.replace("'", "'\"'\"'")}'"
    }

    private data class PreparedSource(
        val sourceUrl: String,
        val sourceTemp: File?,
        val sourceWorkDir: File?,
        val displayName: String,
        val cleanupPath: String?
    )

    private data class PreparedTarget(
        val parentDir: DocumentFile?,
        val fileName: String,
        val tempOutput: File,
        val displayPath: String,
        val targetUrl: String,
        val isRemoteUpload: Boolean
    )

    private data class FfmpegRepairJob(
        val id: String,
        val sourceRef: String,
        val sourceUrl: String,
        val sourceTemp: String,
        val sourceDisplayName: String,
        val sourceCleanupPath: String,
        val targetRef: String,
        val targetDisplayName: String,
        val targetTemp: String,
        val startedAt: String,
        @Volatile var status: String = "queued",
        @Volatile var pid: Long? = null,
        @Volatile var updatedAt: String = startedAt,
        @Volatile var finishedAt: String? = null,
        @Volatile var exitCode: Int? = null,
        @Volatile var error: String? = null,
        val logs: MutableList<String> = mutableListOf()
    ) {
        fun snapshot(): Map<String, Any?> {
            return mapOf(
                "id" to id,
                "status" to status,
                "sourcePath" to sourceRef,
                "sourceUrl" to sourceUrl,
                "sourceTemp" to sourceTemp,
                "sourceDisplayName" to sourceDisplayName,
                "sourceCleanupPath" to sourceCleanupPath,
                "targetPath" to targetRef,
                "targetDisplayName" to targetDisplayName,
                "targetTemp" to targetTemp,
                "pid" to pid,
                "startedAt" to startedAt,
                "updatedAt" to updatedAt,
                "finishedAt" to finishedAt,
                "exitCode" to exitCode,
                "error" to error,
                "logs" to synchronized(logs) { logs.toList() }
            )
        }
    }
}
