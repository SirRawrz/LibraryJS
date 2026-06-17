package com.example.libraryjs

import android.content.Context
import android.util.Base64
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import javax.net.ssl.SSLServerSocket
import java.net.URL
import java.net.URLDecoder
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

class LocalLibraryServer(private val context: Context, private val root: StorageRoot) {

    private val executor = Executors.newCachedThreadPool()
    private val ffmpegRepairManager = FfmpegRepairManager(context, root)
    private val pathCache = ConcurrentHashMap<String, DocumentFile>()
    @Volatile private var cachedTree: DocumentFile? = null
    @Volatile private var cachedTreeUri: String? = null
    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        val socket = createServerSocket()
        serverSocket = socket
        running = true
        ServerService.setRunning(true)
        executor.execute {
            try {
                while (running) {
                    val client = try {
                        socket.accept()
                    } catch (_: Exception) {
                        break
                    }
                    executor.execute { handleClient(client) }
                }
            } finally {
                running = false
                runCatching { socket.close() }
            }
        }
    }

    fun stop() {
        running = false
        runCatching { serverSocket?.close() }
        serverSocket = null
    }

    private fun createServerSocket(): ServerSocket {
        return if (root.httpsEnabled) {
            val factory = ServerTlsManager.serverSocketFactory(context, root)
            val socket = factory.createServerSocket(root.port) as SSLServerSocket
            socket.reuseAddress = true
            socket.needClientAuth = false
            val supported = socket.supportedProtocols.toSet()
            val preferredProtocols = listOf("TLSv1.3", "TLSv1.2").filter { it in supported }
            if (preferredProtocols.isNotEmpty()) {
                socket.enabledProtocols = preferredProtocols.toTypedArray()
            }
            socket
        } else {
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(root.port))
            }
        }
    }

private fun handleClient(socket: Socket) {
    socket.use { s ->
        try {
            s.soTimeout = 30000
            s.tcpNoDelay = true
            val input = s.getInputStream()
            val output = s.getOutputStream()
            val request = readRequest(input) ?: return
            val response = route(request)
            writeResponse(output, response, request.method == "HEAD")
        } catch (_: Exception) {
            runCatching {
                writeResponse(
                    s.getOutputStream(),
                    HttpResponse(
                        500,
                        "Internal Server Error",
                        headers = linkedMapOf("Content-Type" to "text/plain; charset=utf-8"),
                        bodyBytes = "Internal Server Error".toByteArray()
                    )
                )
            }
        }
    }
}

    private fun readRequest(input: InputStream): HttpRequest? {
        val headerBytes = ByteArrayOutputStream()
        var state = 0
        while (true) {
            val next = input.read()
            if (next == -1) return null
            headerBytes.write(next)
            state = when {
                state == 0 && next == '\r'.code -> 1
                state == 1 && next == '\n'.code -> 2
                state == 2 && next == '\r'.code -> 3
                state == 3 && next == '\n'.code -> 4
                else -> 0
            }
            if (state == 4) break
        }

        val headerText = String(headerBytes.toByteArray(), Charsets.ISO_8859_1)
        val lines = headerText.split("\r\n").filter { it.isNotEmpty() }
        if (lines.isEmpty()) return null

        val requestLine = lines.first()
        val parts = requestLine.split(" ", limit = 3)
        if (parts.size < 2) return null

        val method = parts[0].uppercase(Locale.US)
        val rawTarget = parts[1]

        val headers = linkedMapOf<String, String>()
        for (line in lines.drop(1)) {
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            val key = line.substring(0, idx).trim().lowercase(Locale.US)
            val value = line.substring(idx + 1).trim()
            headers[key] = value
        }

        val body = readRequestBody(input, headers)

        val target = rawTarget.toUriLike()
        return HttpRequest(
            method = method,
            target = target.first,
            query = target.second,
            headers = headers,
            body = body
        )
    }

    private fun readRequestBody(input: InputStream, headers: Map<String, String>): ByteArray {
        val transferEncoding = headers["transfer-encoding"]?.lowercase(Locale.US).orEmpty()
        return when {
            transferEncoding.contains("chunked") -> readChunkedBody(input)
            else -> {
                val bodyLength = headers["content-length"]?.toLongOrNull()?.coerceAtLeast(0L) ?: 0L
                readFixedLengthBody(input, bodyLength)
            }
        }
    }

    private fun readFixedLengthBody(input: InputStream, length: Long): ByteArray {
        if (length <= 0L) return ByteArray(0)
        val cap = min(length, Int.MAX_VALUE.toLong()).toInt()
        val body = ByteArray(cap)
        var read = 0
        while (read < body.size) {
            val r = input.read(body, read, body.size - read)
            if (r <= 0) break
            read += r
        }
        return if (read == body.size) body else body.copyOf(read)
    }

    private fun readHttpLine(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) {
                return if (out.size() > 0) String(out.toByteArray(), StandardCharsets.ISO_8859_1) else null
            }
            if (b == '\n'.code) break
            if (b != '\r'.code) out.write(b)
        }
        return String(out.toByteArray(), StandardCharsets.ISO_8859_1)
    }

    private fun readChunkedBody(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val sizeLine = readHttpLine(input) ?: break
            val sizeToken = sizeLine.substringBefore(';').trim()
            val chunkSize = runCatching { sizeToken.toInt(16) }.getOrDefault(0)
            if (chunkSize <= 0) {
                while (true) {
                    val trailer = readHttpLine(input) ?: break
                    if (trailer.isBlank()) break
                }
                break
            }

            val chunk = ByteArray(chunkSize)
            var read = 0
            while (read < chunkSize) {
                val r = input.read(chunk, read, chunkSize - read)
                if (r <= 0) break
                read += r
            }
            if (read > 0) out.write(chunk, 0, read)

            input.read() // CR
            input.read() // LF
        }
        return out.toByteArray()
    }

    private fun route(req: HttpRequest): HttpResponse {
        val path = normalizePath(req.target)

        if (req.method == "OPTIONS") {
            return emptyResponse(204)
        }

        if (path == "/api/health") {
            return jsonResponse(
                200,
                mapOf(
                    "ok" to true,
                    "port" to root.port,
                    "running" to true,
                    "https" to root.httpsEnabled,
                    "serverUrls" to NetworkUtils.serverUrls(root.port, root.httpsEnabled),
                    "roots" to listOf(
                        mapOf(
                            "id" to root.id,
                            "displayName" to root.displayName,
                            "treePath" to "/storage/${root.id}/",
                            "port" to root.port,
                            "urls" to NetworkUtils.serverUrls(root.port, root.httpsEnabled)
                        )
                    )
                )
            )
        }

        if (path == "/api/storage-roots") {
            return jsonResponse(
                200,
                mapOf(
                    "ok" to true,
                    "roots" to listOf(
                        mapOf(
                            "id" to root.id,
                            "displayName" to root.displayName,
                            "treeUri" to root.treeUri,
                            "url" to "/storage/${root.id}/",
                            "port" to root.port
                        )
                    )
                )
            )
        }

        if (path == "/serverip.txt") {
            serveUploadedRootTextFile("serverip.txt", req.headers["range"], req.method == "HEAD")?.let { return it }
            return plainTextResponse(200, NetworkUtils.primaryServerUrl(root.port, root.httpsEnabled).removeSuffix("?I"), req.method == "HEAD")
        }

        if (path == "/httpserverip.txt" || path == "/httpsserverip.txt" || path == "/tailscaleip.txt" || path == "/tailscaleserverip.txt") {
            serveUploadedRootTextFile(path.removePrefix("/"), req.headers["range"], req.method == "HEAD")?.let { return it }
            return plainTextResponse(200, NetworkUtils.primaryServerUrl(root.port, root.httpsEnabled).removeSuffix("?I"), req.method == "HEAD")
        }

        if (path == "/platform.txt") {
            serveUploadedRootTextFile("platform.txt", req.headers["range"], req.method == "HEAD")?.let { return it }
            return plainTextResponse(200, "android", req.method == "HEAD")
        }

        if (path == "/expandedstorage.txt") {
            return plainTextResponse(200, buildExpandedStorageReport(), req.method == "HEAD")
        }

        if (path == "/https setup.txt") {
            return plainTextResponse(200, buildHttpsSetupNote(), req.method == "HEAD")
        }
        if (path == "/proxy" || path == "/Musicproxy/proxy") {
            return handleProxy(req)
        }

        if (path == "/download" || path == "/Musicproxy/download") {
            return handleDownload(req)
        }

        if (path == "/api/file/copy") {
            return handleRemoteCopy(req)
        }

        if (path == "/api/ffmpeg/repair" || path.startsWith("/api/ffmpeg/repair/")) {
            return handleFfmpegRepair(req)
        }

        if (req.method == "POST" || req.method == "PUT") {
            return handleUpload(req, path)
        }

        if (req.method != "GET" && req.method != "HEAD") {
            return textResponse(405, "Method Not Allowed")
        }

        return serveGet(path, req.headers["range"], req.method == "HEAD")
    }

    private fun serveGet(path: String, rangeHeader: String?, headOnly: Boolean): HttpResponse {
        if (path == "/storage" || path == "/storage/") {
            return serveLandingPage(headOnly)
        }

        if (path.startsWith("/storage/")) {
            val rest = path.removePrefix("/storage/")
            val parts = rest.split('/').filter { it.isNotBlank() }
            if (parts.isEmpty()) return serveLandingPage(headOnly)
            if (parts.first() != root.id) return textResponse(404, "Unknown storage root")
            return servePathCandidates(
                buildPathCandidates(parts.drop(1)),
                rangeHeader,
                headOnly,
                requestedPath = path
            )
        }

        val normalized = normalizePath(path)
        if (isBundledMusicPath(normalized)) {
            val storageResponse = servePathCandidates(
                buildPathCandidates(normalized.removePrefix("/").split('/').filter { it.isNotBlank() }),
                rangeHeader,
                headOnly,
                requestedPath = path
            )
            if (storageResponse.status != 404) return storageResponse
            serveBundledMusicAsset(normalized, headOnly)?.let { return it }
            return storageResponse
        }

        return servePathCandidates(
            buildPathCandidates(normalized.removePrefix("/").split('/').filter { it.isNotBlank() }),
            rangeHeader,
            headOnly,
            requestedPath = path
        )
    }

    private fun serveLandingPage(headOnly: Boolean): HttpResponse {
        val urls = NetworkUtils.serverUrls(root.port, root.httpsEnabled).joinToString("<br>")
        val html = buildString {
            append("<!doctype html><html><head><meta charset='utf-8'><title>LibraryJS Server</title>")
            append("<style>body{font-family:sans-serif;padding:16px;line-height:1.4}</style>")
            append("</head><body>")
            append("<h1>LibraryJS Server</h1>")
            append("<p>Server URLs:</p><p>")
            append(urls)
            append("</p>")
            append("<h2>Mounted root</h2>")
            append("<p><strong>")
            append(escapeHtml(root.displayName))
            append("</strong><br>")
            append(escapeHtml(root.treeUri))
            append("</p>")
            append("<p>Pick a folder that contains files such as <code>index.html</code>, <code>manage.html</code>, <code>library.js</code>, and the rest of your hosted app.</p>")
            append("</body></html>")
        }
        return HttpResponse(
            200,
            "OK",
            headers = linkedMapOf(
                "Content-Type" to "text/html; charset=utf-8",
                "Cache-Control" to "no-store"
            ),
            bodyBytes = if (headOnly) null else html.toByteArray()
        )
    }

    private fun serveRelativePath(
        segments: List<String>,
        rangeHeader: String?,
        headOnly: Boolean,
        requestedPath: String
    ): HttpResponse {
        val tree = storageTree() ?: return textResponse(404, "Storage root unavailable")

        val target = when {
            segments.isEmpty() -> tree.findFile("index.html") ?: tree
            else -> resolveDocumentFileCached(tree, segments)
        } ?: return textResponse(404, "Not found")

        if (target.isDirectory) {
            val index = target.findFile("index.html")
            if (index != null) {
                return serveDocument(index, rangeHeader, headOnly)
            }
            val html = renderDirectoryListing(root, target, requestedPath)
            return HttpResponse(
                200,
                "OK",
                headers = linkedMapOf(
                    "Content-Type" to "text/html; charset=utf-8",
                    "Cache-Control" to "no-store"
                ),
                bodyBytes = if (headOnly) null else html.toByteArray()
            )
        }

        return serveDocument(target, rangeHeader, headOnly)
    }

    private fun servePathCandidates(
        candidates: List<List<String>>,
        rangeHeader: String?,
        headOnly: Boolean,
        requestedPath: String
    ): HttpResponse {
        fun lookup(tree: DocumentFile): HttpResponse? {
            var sawNotFound = false
            for (segments in candidates) {
                val target = when {
                    segments.isEmpty() -> tree.findFile("index.html") ?: tree
                    else -> resolveDocumentFileCached(tree, segments)
                }
                if (target == null) {
                    sawNotFound = true
                    continue
                }

                if (target.isDirectory) {
                    val index = target.findFile("index.html")
                    if (index != null) {
                        return serveDocument(index, rangeHeader, headOnly)
                    }
                    val html = renderDirectoryListing(root, target, requestedPath)
                    return HttpResponse(
                        200,
                        "OK",
                        headers = linkedMapOf(
                            "Content-Type" to "text/html; charset=utf-8",
                            "Cache-Control" to "no-store"
                        ),
                        bodyBytes = if (headOnly) null else html.toByteArray()
                    )
                }

                return serveDocument(target, rangeHeader, headOnly)
            }
            return if (sawNotFound) textResponse(404, "Not found") else null
        }

        val tree = storageTree() ?: return textResponse(404, "Storage root unavailable")
        lookup(tree)?.let { return it }

        // SAF providers can lag right after create/delete operations. Refresh once
        // and retry before declaring a file missing.
        invalidateStorageCache()
        val refreshedTree = storageTree() ?: return textResponse(404, "Storage root unavailable")
        lookup(refreshedTree)?.let { return it }

        return textResponse(404, "Not found")
    }

    private fun serveDocument(document: DocumentFile, rangeHeader: String?, headOnly: Boolean): HttpResponse {
        val afd = context.contentResolver.openAssetFileDescriptor(document.uri, "r")
            ?: return textResponse(404, "Not found")

        val length = afd.length
        val lastModified = document.lastModified().takeIf { it > 0L }
        val contentType = mimeTypeFor(document.name ?: "application/octet-stream")
        val etag = etagFor(document, length, lastModified)
        val range = parseRange(rangeHeader, length)
        val bodyLen = when {
            range != null -> range.second - range.first + 1
            length >= 0 -> length
            else -> -1
        }

        val headers = linkedMapOf(
            "Content-Type" to contentType,
            "Accept-Ranges" to "bytes",
            "Cache-Control" to cacheControlForContentType(contentType)
        )
        if (etag.isNotBlank()) headers["ETag"] = etag
        lastModified?.let { headers["Last-Modified"] = formatHttpDate(it) }
        if (bodyLen >= 0) headers["Content-Length"] = bodyLen.toString()
        if (range != null && length >= 0) headers["Content-Range"] = "bytes ${range.first}-${range.second}/$length"

        val stream = if (headOnly) null else openBoundedDocStream(afd, range?.first ?: 0L, range?.second)
        val status = if (range != null) 206 else 200
        return HttpResponse(
            status,
            if (status == 206) "Partial Content" else "OK",
            headers = headers,
            bodyBytes = null,
            bodyStream = stream
        )
    }



    private fun serveUploadedRootTextFile(filename: String, rangeHeader: String?, headOnly: Boolean): HttpResponse? {
        val tree = storageTree() ?: return null
        val target = tree.findFile(filename) ?: return null
        if (target.isDirectory) return null
        return serveDocument(target, rangeHeader, headOnly)
    }

    private fun isBundledMusicPath(path: String): Boolean {
        return path == "/musiclib.html" ||
            path == "/musiclibrary.js" ||
            path == "/Music.html" ||
            path == "/musicgenres.html" ||
            path == "/Musicproxy" ||
            path == "/Musicproxy/" ||
            path.startsWith("/Musicproxy/")
    }

    private fun bundledMusicAssetPath(path: String): String? {
        return when {
            path == "/musiclib.html" -> "musiclib.html"
            path == "/musiclibrary.js" -> "musiclibrary.js"
            path == "/Music.html" -> "Music.html"
            path == "/musicgenres.html" -> "musicgenres.html"
            path == "/Musicproxy" || path == "/Musicproxy/" -> "Musicproxy/index.html"
            path.startsWith("/Musicproxy/") -> path.removePrefix("/")
            else -> null
        }
    }

    private fun serveBundledMusicAsset(path: String, headOnly: Boolean): HttpResponse? {
        val assetPath = bundledMusicAssetPath(path) ?: return null
        val bytes = runCatching { context.assets.open(assetPath).use { it.readBytes() } }.getOrNull() ?: return null
        val contentType = mimeTypeFor(assetPath.substringAfterLast('/'))
        return HttpResponse(
            200,
            "OK",
            headers = linkedMapOf(
                "Content-Type" to contentType,
                "Content-Length" to bytes.size.toString(),
                "Cache-Control" to cacheControlForContentType(contentType)
            ),
            bodyBytes = if (headOnly) null else bytes
        )
    }

    private fun handleUpload(req: HttpRequest, requestPath: String): HttpResponse {
        val body = req.body
        val contentType = req.headers["content-type"] ?: ""
        val multipart = parseMultipart(contentType, body)
        val fields = multipart?.fields.orEmpty()

        val endpointPath = normalizePath(requestPath)
        val isDirectoryStyleUpload = endpointPath == "/api/file/upload" || endpointPath == "/pocketserver-api/upload"
        val routeSuffix = when {
            endpointPath.startsWith("/api/file/upload/") -> endpointPath.removePrefix("/api/file/upload/")
            endpointPath.startsWith("/pocketserver-api/upload/") -> endpointPath.removePrefix("/pocketserver-api/upload/")
            else -> ""
        }

        val fileName = req.query["name"]?.takeIf { it.isNotBlank() }
            ?: req.query["filename"]?.takeIf { it.isNotBlank() }
            ?: fields["name"]?.takeIf { it.isNotBlank() }
            ?: fields["filename"]?.takeIf { it.isNotBlank() }
            ?: uploadHeader(req, "x-libraryjs-upload-name", "x-upload-name")
            ?: multipart?.fileName?.takeIf { it.isNotBlank() }
            ?: splitSegments(routeSuffix).lastOrNull()

        val targetText = when {
            req.query["path"]?.isNotBlank() == true -> req.query["path"].orEmpty()
            fields["targetDir"]?.isNotBlank() == true -> fields["targetDir"].orEmpty()
            fields["path"]?.isNotBlank() == true -> fields["path"].orEmpty()
            routeSuffix.isNotBlank() -> routeSuffix
            isDirectoryStyleUpload -> ""
            else -> endpointPath
        }

        val uploadTarget = if (isDirectoryStyleUpload && targetText.isBlank()) "" else targetText
        val rawSegments = splitSegments(uploadTarget)
        val (dirSegments, finalName, payload) = if (isDirectoryStyleUpload) {
            val directorySegments = normalizeUploadDirectorySegments(rawSegments)
            val chosenName = fileName ?: return textResponse(400, "Missing filename")
            val bytes = multipart?.fileBytes ?: body
            Triple(directorySegments, chosenName, bytes)
        } else {
            if (rawSegments.isEmpty()) return textResponse(400, "Missing upload target")
            val maybeFileName = fileName ?: rawSegments.lastOrNull() ?: return textResponse(400, "Missing filename")
            val directorySegments = if (uploadTarget.endsWith("/") || uploadTarget.endsWith("\\") ) {
                normalizeUploadDirectorySegments(rawSegments)
            } else {
                normalizeUploadDirectorySegments(rawSegments.dropLast(1))
            }
            val bytes = multipart?.fileBytes ?: body
            Triple(directorySegments, maybeFileName, bytes)
        }

        val tree = storageTree() ?: return textResponse(404, "Storage root unavailable")
        val parentDir = if (dirSegments.isEmpty()) tree else resolveOrCreateDirectoriesCached(tree, dirSegments)
        if (parentDir == null) return textResponse(500, "Could not resolve target directory")

        val uploadId = uploadHeader(req, "x-libraryjs-upload-id", "x-upload-id")
        val uploadSize = uploadHeader(req, "x-libraryjs-upload-size", "x-upload-size")?.toLongOrNull()
        val uploadOffset = uploadHeader(req, "x-libraryjs-upload-offset", "x-upload-offset")?.toLongOrNull() ?: 0L
        val uploadPart = uploadHeader(req, "x-libraryjs-chunk-index", "x-upload-part")?.toIntOrNull() ?: -1
        val uploadPartCount = uploadHeader(req, "x-libraryjs-chunk-count", "x-upload-count")?.toIntOrNull() ?: -1

        val shouldAssembleChunks = !uploadId.isNullOrBlank() && uploadSize != null && uploadSize >= 0L
        if (shouldAssembleChunks) {
            val targetKey = buildString {
                append("/storage/")
                append(root.id)
                if (dirSegments.isNotEmpty()) {
                    append("/")
                    append(dirSegments.joinToString("/"))
                }
                append("/")
                append(finalName)
            }

            val tempRoot = File(context.cacheDir, "libraryjs-upload-temp")
            val sessionSlug = buildUploadSessionSlug(targetKey, uploadId!!)
            val sessionRoot = File(tempRoot, sessionSlug).apply { mkdirs() }
            val assembledPath = File(sessionRoot, "assembled.part")

            RandomAccessFile(assembledPath, "rw").use { raf ->
                raf.seek(uploadOffset)
                raf.write(payload)
            }

            val expectedEnd = uploadOffset + payload.size.toLong()
            val completeNow = expectedEnd >= uploadSize
            if (!completeNow) {
                return jsonResponse(
                    200,
                    mapOf(
                        "ok" to true,
                        "complete" to false,
                        "receivedBytes" to expectedEnd,
                        "totalSize" to uploadSize,
                        "path" to targetKey,
                        "port" to root.port,
                        "partIndex" to uploadPart,
                        "partCount" to uploadPartCount
                    )
                )
            }

            parentDir.findFile(finalName)?.delete()
            val created = parentDir.createFile(guessMimeType(finalName), finalName) ?: return textResponse(500, "Could not create target file")
            context.contentResolver.openOutputStream(created.uri)?.use { out ->
                assembledPath.inputStream().use { input -> input.copyToBuffered(out) }
                out.flush()
            } ?: return textResponse(500, "Could not open output stream")

            runCatching { assembledPath.delete() }
            runCatching { deleteRecursivelySafe(sessionRoot) }
            runCatching { cleanupUploadTempRootIfEmpty(tempRoot) }
            invalidateStorageCache()

            return jsonResponse(200, mapOf("ok" to true, "complete" to true, "path" to targetKey, "port" to root.port))
        }

        parentDir.findFile(finalName)?.delete()
        val created = parentDir.createFile(guessMimeType(finalName), finalName) ?: return textResponse(500, "Could not create target file")
        context.contentResolver.openOutputStream(created.uri)?.use { out ->
            out.write(payload)
            out.flush()
        } ?: return textResponse(500, "Could not open output stream")

        val targetPath = buildString {
            append("/storage/")
            append(root.id)
            if (dirSegments.isNotEmpty()) {
                append("/")
                append(dirSegments.joinToString("/"))
            }
            append("/")
            append(finalName)
        }

        invalidateStorageCache()
        return jsonResponse(200, mapOf("ok" to true, "path" to targetPath, "port" to root.port))
    }


    private fun handleRemoteCopy(req: HttpRequest): HttpResponse {
        val method = req.method.uppercase(Locale.US)
        if (method == "OPTIONS") {
            return emptyResponse(204)
        }
        if (method != "POST") {
            return textResponse(405, "Use POST")
        }

        val payload = try {
            JSONObject(String(req.body, StandardCharsets.UTF_8))
        } catch (_: Exception) {
            return jsonResponse(400, mapOf("ok" to false, "error" to "Invalid JSON body"))
        }

        val sourceUrl = payload.optString("sourceUrl").takeIf { it.isNotBlank() }
            ?: payload.optString("source").takeIf { it.isNotBlank() }
            ?: return jsonResponse(400, mapOf("ok" to false, "error" to "Missing sourceUrl"))

        val targetText = payload.optString("targetPath").takeIf { it.isNotBlank() }
            ?: payload.optString("target").takeIf { it.isNotBlank() }
            ?: return jsonResponse(400, mapOf("ok" to false, "error" to "Missing targetPath"))

        val targetSegments = splitSegments(targetText)
        if (targetSegments.isEmpty()) {
            return jsonResponse(400, mapOf("ok" to false, "error" to "Missing targetPath"))
        }

        val tree = storageTree() ?: return jsonResponse(404, mapOf("ok" to false, "error" to "Storage root unavailable"))
        val parentDir = resolveOrCreateDirectoriesCached(tree, targetSegments.dropLast(1))
            ?: return jsonResponse(500, mapOf("ok" to false, "error" to "Could not resolve target directory"))
        val finalName = targetSegments.last()
        parentDir.findFile(finalName)?.delete()
        val created = parentDir.createFile(guessMimeType(finalName), finalName)
            ?: return jsonResponse(500, mapOf("ok" to false, "error" to "Could not create target file"))

        val connection = try {
            URL(sourceUrl).openConnection() as HttpURLConnection
        } catch (e: Exception) {
            return jsonResponse(400, mapOf("ok" to false, "error" to (e.message ?: "Invalid sourceUrl")))
        }

        connection.instanceFollowRedirects = true
        connection.connectTimeout = 30000
        connection.readTimeout = 30000
        connection.requestMethod = "GET"

        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                val errorText = runCatching { connection.errorStream?.use { String(it.readBytes(), StandardCharsets.UTF_8) } }.getOrNull().orEmpty()
                return jsonResponse(502, mapOf("ok" to false, "error" to (errorText.ifBlank { "Source fetch failed: HTTP $code" })))
            }

            context.contentResolver.openOutputStream(created.uri)?.use { out ->
                connection.inputStream.use { input -> input.copyToBuffered(out) }
                out.flush()
            } ?: return jsonResponse(500, mapOf("ok" to false, "error" to "Could not open output stream"))

            invalidateStorageCache()
            return jsonResponse(200, mapOf(
                "ok" to true,
                "mode" to "remote-copy",
                "path" to buildString {
                    append("/storage/")
                    append(root.id)
                    if (targetSegments.dropLast(1).isNotEmpty()) {
                        append("/")
                        append(targetSegments.dropLast(1).joinToString("/"))
                    }
                    append("/")
                    append(finalName)
                },
                "port" to root.port
            ))
        } catch (e: Exception) {
            return jsonResponse(500, mapOf("ok" to false, "error" to (e.message ?: "Copy failed")))
        } finally {
            runCatching { connection.disconnect() }
        }
    }

    private fun uploadHeader(req: HttpRequest, vararg names: String): String? {
        for (name in names) {
            val value = req.headers[name.lowercase(Locale.US)]?.trim()
            if (!value.isNullOrBlank()) return value
        }
        return null
    }


    private fun cleanupUploadTempRootIfEmpty(tempRoot: File) {
        if (!tempRoot.exists()) return
        val children = tempRoot.listFiles().orEmpty()
        if (children.isEmpty()) {
            runCatching { tempRoot.delete() }
        }
    }

    private fun deleteRecursivelySafe(file: File) {
        if (!file.exists()) return
        if (file.isDirectory) {
            file.listFiles().orEmpty().forEach { child ->
                deleteRecursivelySafe(child)
            }
        }
        runCatching { file.delete() }
    }

    private fun buildUploadSessionSlug(targetKey: String, uploadId: String): String {
        val stem = targetKey.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^A-Za-z0-9._-]+"), "_")
            .trim('_')
            .ifBlank { "upload" }
            .take(48)
        val hash = ("$targetKey|$uploadId").hashCode().toUInt().toString(36)
        return "$stem-$hash"
    }

    private fun handleProxy(req: HttpRequest): HttpResponse {
        if (req.method != "GET" && req.method != "POST") {
            return jsonResponse(405, mapOf("ok" to false, "error" to "Use GET or POST"))
        }

        val body = bodyJson(req)
        val urlText = req.query["url"]?.trim().orEmpty().ifBlank { body?.optString("url").orEmpty().trim() }
        if (urlText.isBlank()) {
            return jsonResponse(400, mapOf("ok" to false, "error" to "Missing url"))
        }

        val method = (body?.optString("method")?.trim().orEmpty().ifBlank {
            if (req.method == "POST") "POST" else "GET"
        }).uppercase(Locale.US)

        val responseType = body?.optString("responseType")?.trim().orEmpty().ifBlank { "text" }.lowercase(Locale.US)
        val requestHeaders = mutableMapOf<String, String>()

        body?.optJSONObject("headers")?.let { headersObj ->
            val keys = headersObj.keys()
            while (keys.hasNext()) {
                val key = keys.next().trim()
                if (key.isBlank() || isHopByHopHeader(key)) continue
                val value = jsonHeaderValue(headersObj.opt(key))
                if (!value.isNullOrBlank()) {
                    requestHeaders[key] = value
                }
            }
        }

        val bodyText = body?.let { if (it.has("bodyText") && !it.isNull("bodyText")) it.optString("bodyText") else null }
        val bodyBase64 = body?.let { if (it.has("bodyBase64") && !it.isNull("bodyBase64")) it.optString("bodyBase64") else null }

        return try {
            val conn = (URL(urlText).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                instanceFollowRedirects = true
                connectTimeout = 30000
                readTimeout = 30000
                doInput = true
                requestHeaders.forEach { (k, v) ->
                    if (k.isNotBlank() && v.isNotBlank()) {
                        setRequestProperty(k, v)
                    }
                }
                if (!requestHeaders.keys.any { it.equals("User-Agent", ignoreCase = true) }) {
                    setRequestProperty("User-Agent", "LibraryJS-Android")
                }
                if (!requestHeaders.keys.any { it.equals("Accept", ignoreCase = true) }) {
                    setRequestProperty("Accept", "*/*")
                }
                if (method !in setOf("GET", "HEAD") && (bodyText != null || bodyBase64 != null)) {
                    doOutput = true
                }
            }

            if (method !in setOf("GET", "HEAD")) {
                when {
                    bodyText != null -> conn.outputStream.use { out -> out.write(bodyText.toByteArray(Charsets.UTF_8)) }
                    bodyBase64 != null -> conn.outputStream.use { out -> out.write(Base64.decode(bodyBase64, Base64.DEFAULT)) }
                }
            }

            val status = conn.responseCode
            val responseHeaders = linkedMapOf<String, String>()
            conn.headerFields.forEach { (key, values) ->
                if (key.isNullOrBlank() || values.isNullOrEmpty()) return@forEach
                responseHeaders[key] = values.joinToString(", ")
            }
            if (!responseHeaders.containsKey("Content-Type") && !conn.contentType.isNullOrBlank()) {
                responseHeaders["Content-Type"] = conn.contentType!!
            }
            val contentLength = runCatching { conn.getHeaderFieldLong("Content-Length", -1L) }.getOrDefault(-1L)
            if (contentLength >= 0) {
                responseHeaders["Content-Length"] = contentLength.toString()
            }

            val responseStream = when {
                status >= 400 -> runCatching { conn.errorStream }.getOrNull() ?: runCatching { conn.inputStream }.getOrNull()
                else -> runCatching { conn.inputStream }.getOrNull()
            }
            val responseBodyBytes = responseStream?.use { input -> input.readBytes() } ?: ByteArray(0)
            val responseBody = if (responseType == "arraybuffer" || responseType == "binary") {
                Base64.encodeToString(responseBodyBytes, Base64.NO_WRAP)
            } else {
                String(responseBodyBytes, Charsets.UTF_8)
            }

            jsonResponse(
                200,
                mapOf(
                    "ok" to true,
                    "status" to status,
                    "statusText" to (conn.responseMessage ?: ""),
                    "headers" to responseHeaders,
                    "body" to responseBody,
                    "bodyEncoding" to if (responseType == "arraybuffer" || responseType == "binary") "base64" else "text",
                    "finalUrl" to conn.url.toString()
                )
            )
        } catch (e: Exception) {
            jsonResponse(502, mapOf("ok" to false, "error" to (e.message ?: e.javaClass.simpleName)))
        }
    }

    private fun jsonHeaderValue(value: Any?): String? {
        return when (value) {
            null, org.json.JSONObject.NULL -> null
            is String -> value.trim().ifBlank { null }
            is Number, is Boolean -> value.toString()
            is org.json.JSONArray -> {
                val pieces = mutableListOf<String>()
                for (i in 0 until value.length()) {
                    jsonHeaderValue(value.opt(i))?.let { pieces += it }
                }
                if (pieces.isEmpty()) null else pieces.joinToString(", ")
            }
            is org.json.JSONObject -> value.toString()
            else -> value.toString().trim().ifBlank { null }
        }
    }

    private fun isHopByHopHeader(name: String): Boolean {
        return when (name.lowercase(Locale.US)) {
            "host",
            "content-length",
            "connection",
            "proxy-connection",
            "keep-alive",
            "transfer-encoding",
            "upgrade",
            "accept-encoding" -> true
            else -> false
        }
    }

    private fun handleDownload(req: HttpRequest): HttpResponse {
        val body = bodyJson(req)
        val urlText = req.query["url"]?.trim().orEmpty().ifBlank { body?.optString("url").orEmpty().trim() }
        val fileName = req.query["filename"]?.trim().orEmpty().ifBlank { body?.optString("filename").orEmpty().trim() }.ifBlank { "download.bin" }
        if (urlText.isBlank()) return textResponse(400, "Missing url")

        return try {
            val conn = (URL(urlText).openConnection() as HttpURLConnection).apply {
                requestMethod = body?.optString("method")?.takeIf { it.isNotBlank() } ?: "GET"
                instanceFollowRedirects = true
                connectTimeout = 30000
                readTimeout = 30000
                doInput = true
            }

            val requestedRange = req.headers["range"]?.trim()
            if (!requestedRange.isNullOrBlank()) {
                conn.setRequestProperty("Range", requestedRange)
            }

            if (conn.requestMethod == "POST" && req.body.isNotEmpty()) {
                conn.doOutput = true
                conn.outputStream.use { it.write(req.body) }
            }

            val status = conn.responseCode
            val responseHeaders = linkedMapOf(
                "Content-Type" to (conn.contentType ?: "application/octet-stream"),
                "Content-Disposition" to "attachment; filename=\"${fileName.replace("\"", "_")}\"",
                "Cache-Control" to "no-store"
            )

            val contentLength = runCatching { conn.getHeaderFieldLong("Content-Length", -1L) }.getOrDefault(-1L)
            if (contentLength >= 0) {
                responseHeaders["Content-Length"] = contentLength.toString()
            }

            conn.headerFields.forEach { (key, values) ->
                if (key.isNullOrBlank() || values.isNullOrEmpty()) return@forEach
                when (key.lowercase(Locale.US)) {
                    "accept-ranges",
                    "content-range",
                    "etag",
                    "last-modified" -> responseHeaders[key] = values.joinToString(", ")
                }
            }

            val responseStream = when {
                status >= 400 -> runCatching { conn.errorStream }.getOrNull() ?: runCatching { conn.inputStream }.getOrNull()
                else -> runCatching { conn.inputStream }.getOrNull()
            }

            HttpResponse(
                status,
                conn.responseMessage ?: "OK",
                headers = responseHeaders,
                bodyStream = responseStream
            )
        } catch (e: Exception) {
            jsonResponse(502, mapOf("ok" to false, "error" to (e.message ?: e.javaClass.simpleName)))
        }
    }

    private fun openBoundedDocStream(
        afd: android.content.res.AssetFileDescriptor,
        start: Long,
        end: Long?
    ): InputStream {
        val input = FileInputStream(afd.fileDescriptor)
        val startOffset = afd.startOffset + start
        if (startOffset > 0) input.channel.position(startOffset)
        val maxBytes = when {
            end != null -> max(0L, end - start + 1)
            afd.length >= 0 -> max(0L, afd.length - start)
            else -> -1L
        }
        return if (maxBytes >= 0) LimitedInputStream(input, maxBytes) else input
    }

    private fun buildPathCandidates(segments: List<String>): List<List<String>> {
        val candidates = mutableListOf<List<String>>()
        fun addCandidate(value: List<String>) {
            if (value !in candidates) candidates += value
        }

        addCandidate(segments)

        if (segments.firstOrNull() == "emulator") {
            val alias = segments.drop(1)
            val aliasKey = alias.joinToString("/")
            val aliasedFiles = setOf(
                "reader.html",
                "booklib.html",
                "books.js",
                "manga.js",
                "guidebooks.js",
                "games.js"
            )
            if (alias.size == 1 && aliasKey in aliasedFiles) {
                addCandidate(alias)
            }
        }

        return candidates
    }


private fun invalidateStorageCache() {
    pathCache.clear()
    cachedTree = null
    cachedTreeUri = null
}

private fun storageTree(): DocumentFile? {
    val treeUri = root.treeUri
    val cached = cachedTree
    if (cached != null && cachedTreeUri == treeUri) return cached
    val tree = DocumentFile.fromTreeUri(context, Uri.parse(treeUri)) ?: return null
    cachedTree = tree
    cachedTreeUri = treeUri
    return tree
}

private fun resolveDocumentFileCached(root: DocumentFile, segments: List<String>): DocumentFile? {
    var current = root
    val pathParts = ArrayList<String>(segments.size)
    for (seg in segments) {
        val decoded = urlDecode(seg)
        pathParts += decoded
        val cacheKey = pathParts.joinToString("/")
        val cached = pathCache[cacheKey]
        if (cached != null) {
            current = cached
            continue
        }
        current = current.findFile(decoded) ?: return null
        pathCache[cacheKey] = current
    }
    return current
}

private fun resolveOrCreateDirectoriesCached(root: DocumentFile, segments: List<String>): DocumentFile? {
    var current = root
    val pathParts = ArrayList<String>(segments.size)
    for (seg in segments) {
        val decoded = urlDecode(seg)
        pathParts += decoded
        val cacheKey = pathParts.joinToString("/")
        val cached = pathCache[cacheKey]
        if (cached != null && cached.isDirectory) {
            current = cached
            continue
        }

        val existing = current.findFile(decoded)
        current = when {
            existing != null && existing.isDirectory -> existing
            existing != null && existing.isFile -> return null
            else -> current.createDirectory(decoded) ?: return null
        }
        pathCache[cacheKey] = current
    }
    return current
}

    private fun renderDirectoryListing(root: StorageRoot, directory: DocumentFile, requestPath: String): String {
        val entries = directory.listFiles().sortedBy { it.name?.lowercase(Locale.US).orEmpty() }
        return buildString {
            append("<!doctype html><html><head><meta charset='utf-8'><title>")
            append(escapeHtml(root.displayName))
            append("</title><style>body{font-family:sans-serif;padding:16px}a{display:block;margin:6px 0}</style></head><body>")
            append("<h1>")
            append(escapeHtml(root.displayName))
            append("</h1>")
            append("<p>")
            append(escapeHtml(requestPath))
            append("</p>")
            for (entry in entries) {
                val name = entry.name ?: continue
                val href = if (entry.isDirectory) "${urlEncodePath(name)}/" else urlEncodePath(name)
                append("<a href='")
                append(href)
                append("'>")
                append(escapeHtml(name))
                append(if (entry.isDirectory) "/" else "")
                append("</a>")
            }
            append("</body></html>")
        }
    }

    private fun parseRange(rangeHeader: String?, totalLength: Long): Pair<Long, Long>? {
        if (rangeHeader.isNullOrBlank() || totalLength < 0) return null
        val value = rangeHeader.trim().lowercase(Locale.US)
        if (!value.startsWith("bytes=")) return null
        val spec = value.removePrefix("bytes=").trim()
        val parts = spec.split('-', limit = 2)
        val start = parts.getOrNull(0)?.trim()?.takeIf { it.isNotBlank() }?.toLongOrNull()
        val end = parts.getOrNull(1)?.trim()?.takeIf { it.isNotBlank() }?.toLongOrNull()
        return when {
            start != null && end != null -> {
                val s = start.coerceAtLeast(0L).coerceAtMost(max(0L, totalLength - 1))
                val e = end.coerceAtLeast(s).coerceAtMost(max(0L, totalLength - 1))
                s to e
            }
            start != null -> {
                val s = start.coerceAtLeast(0L).coerceAtMost(max(0L, totalLength - 1))
                s to max(0L, totalLength - 1)
            }
            start == null && end != null -> {
                val suffix = end.coerceAtLeast(0L).coerceAtMost(totalLength)
                val s = max(0L, totalLength - suffix)
                s to max(0L, totalLength - 1)
            }
            else -> null
        }
    }

    private fun mimeTypeFor(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase(Locale.US)
        return when (ext) {
            "html", "htm" -> "text/html; charset=utf-8"
            "js" -> "application/javascript; charset=utf-8"
            "mjs" -> "application/javascript; charset=utf-8"
            "wasm" -> "application/wasm"
            "css" -> "text/css; charset=utf-8"
            "json" -> "application/json; charset=utf-8"
            "txt", "md" -> "text/plain; charset=utf-8"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "svg" -> "image/svg+xml"
            "ico" -> "image/x-icon"
            "mp4" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "webm" -> "video/webm"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "wav" -> "audio/wav"
            "ogg" -> "audio/ogg"
            "opus" -> "audio/opus"
            "flac" -> "audio/flac"
            "aac" -> "audio/aac"
            "m3u" -> "audio/x-mpegurl"
            "m3u8" -> "application/vnd.apple.mpegurl"
            "vtt" -> "text/vtt; charset=utf-8"
            else -> "application/octet-stream"
        }
    }


    private fun formatHttpDate(epochMillis: Long): String {
        return DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneOffset.UTC))
    }

    private fun etagFor(document: DocumentFile, length: Long, lastModified: Long?): String {
        val namePart = (document.name ?: document.uri.toString()).hashCode().toUInt().toString(36)
        val modifiedPart = (lastModified ?: document.lastModified()).coerceAtLeast(0L).toString(36)
        return "W/\"$namePart-$length-$modifiedPart\""
    }

    private fun cacheControlForContentType(contentType: String): String {
        val lower = contentType.lowercase(Locale.US)
        return when {
            lower.startsWith("text/html") || lower.startsWith("application/xhtml") -> "no-cache, must-revalidate"
            lower.startsWith("application/javascript") || lower.startsWith("text/javascript") -> "public, max-age=86400"
            lower.startsWith("text/css") || lower.startsWith("application/json") || lower.startsWith("text/plain") || lower.startsWith("text/xml") || lower.startsWith("text/vtt") -> "public, max-age=86400"
            lower.startsWith("image/") || lower.startsWith("audio/") || lower.startsWith("video/") -> "public, max-age=86400"
            else -> "no-cache, must-revalidate"
        }
    }

    private fun guessMimeType(name: String): String = mimeTypeFor(name)

    private fun textResponse(status: Int, text: String): HttpResponse {
        return HttpResponse(
            status,
            reasonFor(status),
            headers = standardHeaders().apply { put("Content-Type", "text/plain; charset=utf-8") },
            bodyBytes = text.toByteArray()
        )
    }

    private fun jsonResponse(status: Int, data: Any): HttpResponse {
        val json = when (data) {
            is String -> data
            else -> org.json.JSONObject.wrap(data)?.toString() ?: "{}"
        }
        return HttpResponse(
            status,
            reasonFor(status),
            headers = standardHeaders().apply { put("Content-Type", "application/json; charset=utf-8") },
            bodyBytes = json.toByteArray()
        )
    }

    private fun emptyResponse(status: Int): HttpResponse {
        return HttpResponse(status, reasonFor(status), headers = standardHeaders(), bodyBytes = ByteArray(0))
    }

    private fun plainTextResponse(status: Int, text: String, headOnly: Boolean = false): HttpResponse {
        return HttpResponse(
            status,
            reasonFor(status),
            headers = standardHeaders().apply { put("Content-Type", "text/plain; charset=utf-8") },
            bodyBytes = if (headOnly) null else text.toByteArray()
        )
    }

    private fun htmlResponse(status: Int, html: String, headOnly: Boolean = false): HttpResponse {
        return HttpResponse(
            status,
            reasonFor(status),
            headers = standardHeaders().apply { put("Content-Type", "text/html; charset=utf-8") },
            bodyBytes = if (headOnly) null else html.toByteArray()
        )
    }

    private fun buildExpandedStorageReport(): String {
        return buildString {
            append(root.displayName)
            append("\n")
            append("Port: ")
            append(root.port)
            append("\n")
            append("Tree URI: ")
            append(root.treeUri)
            append("\n")
            append("URLs:\n")
            NetworkUtils.serverUrls(root.port, root.httpsEnabled).forEach { url ->
                append(" - ")
                append(url)
                append("\n")
            }
        }.trim()
    }

    private fun buildHttpsSetupNote(): String {
        return buildString {
            append("HTTPS is available on Android when the root has HTTPS enabled.\n\n")
            append("Use the HTTPS endpoint for this root after installing the certificate:\n")
            NetworkUtils.serverUrls(root.port, root.httpsEnabled).forEach { url ->
                append(url)
                append("\n")
            }
            append("\n")
            append("The Android app saves a certificate for each HTTPS root and can launch the installer so this device trusts it.")
        }.trim()
    }
    private fun handleFfmpegRepair(req: HttpRequest): HttpResponse {
        return ffmpegRepairManager.handle(req)
    }

    private fun standardHeaders(): MutableMap<String, String> {
        return linkedMapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Methods" to "GET, HEAD, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers" to "Content-Type, Authorization, X-Requested-With, Range, If-None-Match, If-Modified-Since, Content-Range, Content-Disposition, X-LibraryJS-Upload-Id, X-LibraryJS-Upload-Name, X-LibraryJS-Upload-Size, X-LibraryJS-Upload-Offset, X-LibraryJS-Chunk-Index, X-LibraryJS-Chunk-Count, X-Upload-Id, X-Upload-Name, X-Upload-Size, X-Upload-Offset, X-Upload-Part, X-Upload-Count, X-Streamtest-Offset, X-Streamtest-Final-Size",
            "Access-Control-Expose-Headers" to "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Location, Content-Disposition",
            "Cross-Origin-Opener-Policy" to "same-origin",
            "Cross-Origin-Embedder-Policy" to "require-corp",
            "Cross-Origin-Resource-Policy" to "cross-origin",
            "Connection" to "close",
            "Cache-Control" to "no-store"
        )
    }

    private fun writeResponse(output: OutputStream, response: HttpResponse, headOnly: Boolean = false) {
        val body = if (headOnly) null else response.bodyBytes
        val headers = linkedMapOf<String, String>()
        headers.putAll(standardHeaders())
        headers.putAll(response.headers)
        if (body != null && !headers.containsKey("Content-Length")) {
            headers["Content-Length"] = body.size.toString()
        }
        if (body == null) {
            headers.remove("Content-Length")
        }
        val headerText = buildString {
            append("HTTP/1.1 ")
            append(response.status)
            append(' ')
            append(response.reason)
            append("\r\n")
            for ((k, v) in headers) {
                append(k)
                append(": ")
                append(v)
                append("\r\n")
            }
            append("\r\n")
        }.toByteArray(StandardCharsets.ISO_8859_1)
        output.write(headerText)
        if (body != null) {
            output.write(body)
        } else {
            response.bodyStream?.use { input -> input.copyToBuffered(output) }
        }
        output.flush()
    }


    private fun InputStream.copyToBuffered(output: OutputStream, bufferSize: Int = 512 * 1024): Long {
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
        206 -> "Partial Content"
        204 -> "No Content"
        302 -> "Found"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        500 -> "Internal Server Error"
        501 -> "Not Implemented"
        502 -> "Bad Gateway"
        else -> "OK"
    }

    private fun normalizePath(raw: String): String {
        var value = raw
        return try {
            value = URLDecoder.decode(value, "UTF-8")
            if (!value.startsWith("/")) value = "/$value"
            value
        } catch (_: Exception) {
            if (!value.startsWith("/")) "/$value" else value
        }
    }

    private fun splitSegments(raw: String): List<String> {
        val normalized = normalizePath(raw)
        val output = mutableListOf<String>()
        for (segment in normalized.removePrefix("/").split('/')) {
            when (segment) {
                "", "." -> Unit
                ".." -> if (output.isNotEmpty()) output.removeAt(output.lastIndex)
                else -> output += segment
            }
        }
        return output
    }

    private fun normalizeUploadDirectorySegments(segments: List<String>): List<String> {
        if (segments.isEmpty()) return emptyList()
        return when {
            segments.firstOrNull() == "storage" && segments.getOrNull(1) == root.id -> segments.drop(2)
            segments.firstOrNull() == root.id -> segments.drop(1)
            else -> segments
        }
    }

    private fun parseMultipart(contentType: String, body: ByteArray): MultipartData? {
        val boundary = contentType.split(';')
            .map { it.trim() }
            .firstOrNull { it.startsWith("boundary=", ignoreCase = true) }
            ?.substringAfter('=')
            ?.trim()
            ?.trim('"')
            ?: return null
        if (boundary.isBlank()) return null

        val marker = ("--" + boundary).toByteArray(Charsets.ISO_8859_1)
        val endMarker = ("--" + boundary + "--").toByteArray(Charsets.ISO_8859_1)
        val parts = mutableListOf<MultipartPart>()
        var index = indexOf(body, marker, 0) ?: return null
        while (index >= 0) {
            index += marker.size
            if (startsWith(body, endMarker, index - marker.size)) break
            if (index + 1 < body.size && body[index] == '\r'.code.toByte() && body[index + 1] == '\n'.code.toByte()) index += 2
            val nextBoundary = indexOf(body, marker, index) ?: body.size
            val partBytes = body.copyOfRange(index, nextBoundary).trimTrailingCrlf()
            val headerEnd = indexOf(partBytes, byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte()), 0)
            if (headerEnd != null) {
                val headerText = String(partBytes.copyOfRange(0, headerEnd), Charsets.ISO_8859_1)
                val content = partBytes.copyOfRange(headerEnd + 4, partBytes.size)
                val headers = parseHeaders(headerText)
                parts += MultipartPart(headers, content)
            }
            index = nextBoundary
            if (index < 0 || index >= body.size) break
            if (startsWith(body, endMarker, index)) break
        }

        val fields = linkedMapOf<String, String>()
        var fileName: String? = null
        var fileBytes: ByteArray? = null
        for (part in parts) {
            val disposition = part.headers["content-disposition"] ?: continue
            val name = dispositionAttribute(disposition, "name") ?: continue
            val partFileName = dispositionAttribute(disposition, "filename")
            if (!partFileName.isNullOrBlank() && fileBytes == null) {
                fileName = partFileName
                fileBytes = part.content
            } else if (partFileName.isNullOrBlank()) {
                fields[name] = String(part.content, Charsets.UTF_8).trim()
            }
        }
        return MultipartData(fields = fields, fileName = fileName, fileBytes = fileBytes)
    }

    private fun parseHeaders(text: String): Map<String, String> {
        return text.split("\r\n").mapNotNull { line ->
            val idx = line.indexOf(':')
            if (idx <= 0) return@mapNotNull null
            val key = line.substring(0, idx).trim().lowercase(Locale.US)
            val value = line.substring(idx + 1).trim()
            key to value
        }.toMap()
    }

    private fun dispositionAttribute(headerValue: String, attribute: String): String? {
        val regex = Regex("(?:^|;\\s*)${Regex.escape(attribute)}=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE)
        return regex.find(headerValue)?.groupValues?.getOrNull(1)?.trim()
    }

    private fun startsWith(bytes: ByteArray, prefix: ByteArray, start: Int): Boolean {
        if (start < 0 || start + prefix.size > bytes.size) return false
        for (i in prefix.indices) {
            if (bytes[start + i] != prefix[i]) return false
        }
        return true
    }

    private fun indexOf(bytes: ByteArray, needle: ByteArray, start: Int): Int? {
        if (needle.isEmpty()) return start
        val last = bytes.size - needle.size
        for (i in start.coerceAtLeast(0)..last) {
            var match = true
            for (j in needle.indices) {
                if (bytes[i + j] != needle[j]) {
                    match = false
                    break
                }
            }
            if (match) return i
        }
        return null
    }

    private fun ByteArray.trimTrailingCrlf(): ByteArray {
        var end = size
        while (end >= 2 && this[end - 2] == '\r'.code.toByte() && this[end - 1] == '\n'.code.toByte()) {
            end -= 2
        }
        return copyOfRange(0, end)
    }

    private fun bodyJson(req: HttpRequest): org.json.JSONObject? {
        val text = String(req.body, Charsets.UTF_8).trim()
        if (text.isBlank() || !(text.startsWith("{") && text.endsWith("}"))) return null
        return runCatching { org.json.JSONObject(text) }.getOrNull()
    }

    private fun urlDecode(value: String): String = runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)
    private fun urlEncodePath(value: String): String = Uri.encode(value).replace("+", "%20")
    private fun escapeHtml(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;")
}



private fun String.toUriLike(): Pair<String, Map<String, String>> {
    val raw = trim()
    if (raw.isBlank()) return "/" to emptyMap()
    val qIndex = raw.indexOf('?')
    val path = if (qIndex >= 0) raw.substring(0, qIndex) else raw
    val queryText = if (qIndex >= 0 && qIndex + 1 < raw.length) raw.substring(qIndex + 1) else ""
    val query = linkedMapOf<String, String>()
    if (queryText.isNotBlank()) {
        for (part in queryText.split('&')) {
            if (part.isBlank()) continue
            val idx = part.indexOf('=')
            val key = if (idx >= 0) part.substring(0, idx) else part
            val value = if (idx >= 0) part.substring(idx + 1) else ""
            val decodedKey = runCatching { URLDecoder.decode(key, "UTF-8") }.getOrDefault(key)
            val decodedValue = runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)
            if (decodedKey.isNotBlank()) query[decodedKey] = decodedValue
        }
    }
    return (if (path.startsWith('/')) path else "/$path") to query
}

data class HttpRequest(
    val method: String,
    val target: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: ByteArray
)

data class HttpResponse(
    val status: Int,
    val reason: String,
    val headers: Map<String, String> = emptyMap(),
    val bodyBytes: ByteArray? = null,
    val bodyStream: InputStream? = null
)

private data class MultipartData(
    val fields: Map<String, String>,
    val fileName: String?,
    val fileBytes: ByteArray?
)

private data class MultipartPart(
    val headers: Map<String, String>,
    val content: ByteArray
)

private class LimitedInputStream(
    private val delegate: InputStream,
    private val maxBytes: Long
) : InputStream() {
    private var remaining = maxBytes

    override fun read(): Int {
        if (remaining <= 0) return -1
        val value = delegate.read()
        if (value >= 0) remaining--
        return value
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (remaining <= 0) return -1
        val toRead = min(len.toLong(), remaining).toInt()
        val count = delegate.read(b, off, toRead)
        if (count > 0) remaining -= count.toLong()
        return count
    }

    override fun close() {
        delegate.close()
    }
}
