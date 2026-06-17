import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import readline from "node:readline/promises";
import os from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function getArgValue(names) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    for (const name of names) {
      if (arg === name && i + 1 < argv.length) return String(argv[i + 1] || "").trim();
      if (arg.startsWith(name + "=")) return String(arg.slice(name.length + 1)).trim();
    }
  }
  return null;
}

function hasArgFlag(names) {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    for (const name of names) {
      if (arg === name || arg.startsWith(name + "=")) return true;
    }
  }
  return false;
}

function parsePortValue(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function parseBool(raw, defaultValue = false) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

function parseCsvList(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

const defaultLibraryRoot = appRoot; // site root: contains server.mjs, index.html, and /ffmpeg/
const libraryRoot = path.resolve(String(process.env.LIBRARYJS_ROOT || process.env.LIBRARYJS_MEDIA_ROOT || getArgValue(["--root"]) || defaultLibraryRoot).trim());
const DEFAULT_PORT = 60064;
const host = "0.0.0.0";

const SHOW_INDEX = parseBool(process.env.LIBRARYJS_SHOW_INDEX ?? "1", true);
const DIRECTORY_LISTING = parseBool(process.env.LIBRARYJS_DIRECTORY_LISTING ?? "1", true);
const HIDDEN_DOT_FILES = parseBool(process.env.LIBRARYJS_HIDDEN_DOT_FILES ?? "0", false);
const PRECOMPRESSION = parseBool(process.env.LIBRARYJS_PRECOMPRESSION ?? "1", true);
const SPA = parseBool(process.env.LIBRARYJS_SPA ?? "0", false);
const EXCLUDE_DOT_HTML = parseBool(process.env.LIBRARYJS_EXCLUDE_DOT_HTML ?? "0", false);
const ENABLE_CORS = parseBool(process.env.LIBRARYJS_CORS ?? "1", true);
const ENABLE_HTTPS = parseBool(process.env.LIBRARYJS_HTTPS ?? "0", false);
const CROSS_ORIGIN_RESOURCE_POLICY = String(process.env.LIBRARYJS_CORP || "cross-origin").trim();
const TLS_CERT_PATH = String(process.env.LIBRARYJS_TLS_CERT || getArgValue(["--tls-cert"]) || "").trim();
const TLS_KEY_PATH = String(process.env.LIBRARYJS_TLS_KEY || getArgValue(["--tls-key"]) || "").trim();
const CACHE_CONTROL = String(process.env.LIBRARYJS_CACHE_CONTROL || "no-store").trim();
const DEFAULT_SPA_REWRITE = String(process.env.LIBRARYJS_SPA_REWRITE_TO || "/index.html").trim() || "/index.html";

const ENABLE_LOGGING = parseBool(
  process.env.LIBRARYJS_ENABLE_LOGGING ??
  process.env.LIBRARYJS_DEBUG_LOGS ??
  getArgValue(["--log", "--debug-log"]),
  false
) || Boolean(String(process.env.LIBRARYJS_LOG_FILE || "").trim()) || hasArgFlag(["--log", "--debug-log"]);

let logFilePath = ENABLE_LOGGING ? String(process.env.LIBRARYJS_LOG_FILE || "").trim() : "";
function ensureLogFilePath(port) {
  if (!ENABLE_LOGGING) return "";
  if (!logFilePath) {
    logFilePath = path.join(os.tmpdir(), `LibraryJSServer-${port}.log`);
  }
  return logFilePath;
}
function logLine(...parts) {
  if (!ENABLE_LOGGING) return;
  const line = `[${new Date().toISOString()}] ${parts.map((part) => {
    if (part instanceof Error) return part.stack || `${part.name}: ${part.message}`;
    if (typeof part === "object") {
      try { return JSON.stringify(part); } catch { return String(part); }
    }
    return String(part);
  }).join(" ")}`;
  try {
    if (logFilePath) fs.appendFileSync(logFilePath, line + "\n");
  } catch {}
  console.log(line);
}

function getPortFromArguments() {
  const argPort = getArgValue(["--port"]);
  return parsePortValue(process.env.LIBRARYJS_PORT || process.env.PORT || argPort);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".mjs": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav"
};

const FFMPEG_BIN = String(process.env.LIBRARYJS_FFMPEG_BIN || process.env.FFMPEG_BIN || "ffmpeg").trim() || "ffmpeg";
const FFMPEG_JOB_MAX_LOG_LINES = Math.max(50, Number.parseInt(String(process.env.LIBRARYJS_FFMPEG_JOB_MAX_LOG_LINES || "400"), 10) || 400);
const ffmpegRepairJobs = new Map();

function appendJobLog(job, line) {
  if (!job || !line) return;
  const text = String(line).replace(/\r/g, "").trimEnd();
  if (!text) return;
  job.logs.push(text);
  if (job.logs.length > FFMPEG_JOB_MAX_LOG_LINES) {
    job.logs.splice(0, job.logs.length - FFMPEG_JOB_MAX_LOG_LINES);
  }
  job.updatedAt = new Date().toISOString();
}

function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    sourcePath: job.sourcePath,
    targetPath: job.targetPath,
    tempPath: job.tempPath,
    pid: job.pid,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error,
    logs: [...(job.logs || [])]
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startFfmpegRepairJob({ sourcePath, targetPath, localTargetPath = "", targetUrl = "", cleanupPath = "", extraArgs = [] }) {
  const id = `ffmpeg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const targetLabel = String(targetPath || localTargetPath || sourcePath || "").trim() || "repaired.mp4";
  const targetExt = path.extname(localTargetPath || targetLabel) || ".mp4";
  const targetBaseName = sanitizeFilename(path.parse(targetLabel).name || "repaired");
  const tempDir = path.join(os.tmpdir(), "LibraryJSServer-ffmpeg");
  const tempPath = path.join(tempDir, `${targetBaseName}.part-${id}${targetExt}`);
  const job = {
    id,
    status: 'queued',
    sourcePath,
    targetPath: targetPath || localTargetPath || '',
    targetUrl: targetUrl || '',
    cleanupPath: cleanupPath || getRepairCleanupSessionRoot(sourcePath) || '',
    tempPath,
    pid: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    logs: []
  };

  ffmpegRepairJobs.set(id, job);
  appendJobLog(job, 'Starting server-side FFmpeg repair');
  appendJobLog(job, `Source: ${sourcePath}`);
  appendJobLog(job, `Target: ${job.targetUrl || job.targetPath}`);
  appendJobLog(job, `Temp: ${tempPath}`);

  queueMicrotask(async () => {
    try {
      await ensureParentDir(tempPath);
      job.status = 'running';
      job.updatedAt = new Date().toISOString();

      const ffArgs = [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-err_detect',
        'ignore_err',
        '-fflags',
        '+genpts+discardcorrupt',
        '-i',
        sourcePath,
        '-map',
        '0',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        ...extraArgs,
        tempPath
      ];

      appendJobLog(job, `${FFMPEG_BIN} ${ffArgs.map((v) => JSON.stringify(v)).join(' ')}`);

      const child = spawn(FFMPEG_BIN, ffArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      job.pid = child.pid || null;
      job.updatedAt = new Date().toISOString();

      const push = (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        for (const line of text.split(/\r?\n/)) appendJobLog(job, line);
      };

      child.stdout.on('data', push);
      child.stderr.on('data', push);

      child.on('error', async (error) => {
        job.status = 'error';
        job.error = error?.message || String(error);
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        appendJobLog(job, `Spawn error: ${job.error}`);
        try { await fsp.rm(tempPath, { force: true }); } catch {}
      });

      child.on('close', async (code, signal) => {
        job.exitCode = code;
        job.signal = signal || null;
        const cleanupTarget = job.cleanupPath || getRepairCleanupSessionRoot(job.sourcePath);
        if (code === 0) {
          try {
            if (job.targetUrl) {
              await uploadFileToUrl(tempPath, job.targetUrl);
              appendJobLog(job, 'Output uploaded successfully');
            } else {
              await renameReplacing(tempPath, job.targetPath);
              appendJobLog(job, 'Output replaced successfully');
            }
            job.status = 'done';
            try { await fsp.rm(tempPath, { force: true }); } catch {}
            if (cleanupTarget) {
              await cleanupUploadSession(cleanupTarget);
              appendJobLog(job, `Removed staged upload folder: ${cleanupTarget}`);
            }
          } catch (error) {
            job.status = 'error';
            job.error = error?.message || String(error);
            appendJobLog(job, `Finalize error: ${job.error}`);
            try { await fsp.rm(tempPath, { force: true }); } catch {}
          }
        } else if (job.status !== 'error') {
          job.status = 'error';
          job.error = `ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;
          appendJobLog(job, job.error);
          try { await fsp.rm(tempPath, { force: true }); } catch {}
        }
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
      });
    } catch (error) {
      job.status = 'error';
      job.error = error?.message || String(error);
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      appendJobLog(job, `Setup error: ${job.error}`);
      try { await fsp.rm(tempPath, { force: true }); } catch {}
    }
  });

  return job;
}

async function handleFfmpegRepairApi(req, res, reqUrl) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET') {
    const jobId = reqUrl.pathname.split('/').pop();
    const job = ffmpegRepairJobs.get(jobId);
    if (!job) {
      send(res, 404, JSON.stringify({ ok: false, error: 'Job not found' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' }, reqUrl.pathname)
      });
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, job: serializeJob(job) }), {
      'Content-Type': 'application/json; charset=utf-8',
      ...baseHeaders({ 'Cache-Control': 'no-store' }, reqUrl.pathname)
    });
    return;
  }

  if (method !== 'POST') {
    send(res, 405, JSON.stringify({ ok: false, error: 'Use POST or GET' }), {
      'Content-Type': 'application/json; charset=utf-8',
      ...baseHeaders({ 'Cache-Control': 'no-store' }, reqUrl.pathname)
    });
    return;
  }

  let payload = {};
  try {
    const raw = (await collectRequestBody(req)).toString('utf8');
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    send(res, 400, JSON.stringify({ ok: false, error: `Invalid JSON body: ${error?.message || String(error)}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      ...baseHeaders({ 'Cache-Control': 'no-store' }, reqUrl.pathname)
    });
    return;
  }

  const sourceRef = String(payload.sourcePath || payload.source || payload.sourceUrl || '').trim();
  const sourceUrlRef = String(payload.sourceUrl || payload.sourceUri || '').trim();

  let sourceInput = '';
  if (isHttpUrl(sourceUrlRef) || isHttpUrl(sourceRef)) {
    sourceInput = String(sourceUrlRef || sourceRef).trim();
  } else {
    sourceInput = resolveRepairFilePath(sourceRef, { mustExist: true }) || '';
  }

  if (!sourceInput) {
    send(res, 404, JSON.stringify({
      ok: false,
      error: 'Source file not found',
      sourcePath: sourceRef,
      sourceUrl: sourceUrlRef
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      ...baseHeaders({ 'Cache-Control': 'no-store' }, reqUrl.pathname)
    });
    return;
  }

  const targetRef = String(payload.targetPath || payload.target || payload.targetUrl || '').trim();
  const targetUrl = isHttpUrl(targetRef) ? new URL(targetRef).href : '';
  const localTargetPath = targetUrl ? '' : deriveRepairTarget(sourceInput, targetRef, payload.outputName);

  if (!targetUrl && !localTargetPath) {
    send(res, 400, JSON.stringify({ ok: false, error: 'Missing or invalid target path' }), {
      'Content-Type': 'application/json; charset=utf-8',
      ...baseHeaders({ 'Cache-Control': 'no-store' }, reqUrl.pathname)
    });
    return;
  }

  const job = startFfmpegRepairJob({
    sourcePath: sourceInput,
    targetPath: targetRef || localTargetPath,
    localTargetPath,
    targetUrl,
    cleanupPath: getRepairCleanupSessionRoot(sourceInput),
    extraArgs: []
  });
  send(res, 202, JSON.stringify({ ok: true, job: serializeJob(job) }), {
    'Content-Type': 'application/json; charset=utf-8',
    ...baseHeaders({ 'Cache-Control': 'no-store' }, reqUrl.pathname)
  });
}

async function askPort(defaultPort = DEFAULT_PORT) {
  const envPort = parsePortValue(process.env.LIBRARYJS_PORT || process.env.PORT);
  if (envPort) return envPort;

  const argPort = getPortFromArguments();
  if (argPort) return argPort;

  if (process.env.LIBRARYJS_NO_PROMPT === "1" || !process.stdin.isTTY) return defaultPort;

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`Which port should the server use? [${defaultPort}] `);
    const parsed = parsePortValue(answer);
    if (!parsed) {
      console.log(`Invalid port "${String(answer || "").trim()}". Falling back to ${defaultPort}.`);
      return defaultPort;
    }
    return parsed;
  } finally {
    rl.close();
  }
}

function getDefaultTlsMaterialPaths() {
  const baseDir = process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Local", "LibraryJSServer", "Https")
    : path.join(os.homedir(), ".libraryjs", "Https");
  return {
    certPath: path.join(baseDir, "libraryjs-https-cert.pem"),
    keyPath: path.join(baseDir, "libraryjs-https-key.pem")
  };
}

function readTlsMaterial(certPath, keyPath) {
  const fallback = getDefaultTlsMaterialPaths();
  const resolvedCertPath = String(certPath || fallback.certPath).trim();
  const resolvedKeyPath = String(keyPath || fallback.keyPath).trim();

  if (!fs.existsSync(resolvedCertPath)) {
    throw new Error(`HTTPS certificate file not found: ${resolvedCertPath}`);
  }

  if (!fs.existsSync(resolvedKeyPath)) {
    throw new Error(`HTTPS private key file not found: ${resolvedKeyPath}`);
  }

  return {
    cert: fs.readFileSync(resolvedCertPath),
    key: fs.readFileSync(resolvedKeyPath)
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function withCors(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Range, If-None-Match, If-Modified-Since, Content-Range, Content-Disposition, X-LibraryJS-Upload-Id, X-LibraryJS-Upload-Name, X-LibraryJS-Upload-Size, X-LibraryJS-Upload-Offset, X-LibraryJS-Chunk-Index, X-LibraryJS-Chunk-Count, X-Upload-Id, X-Upload-Name, X-Upload-Size, X-Upload-Offset, X-Upload-Part, X-Upload-Count, X-Streamtest-Offset, X-Streamtest-Final-Size",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Location, Content-Disposition",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Private-Network": "true"
  };
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasHiddenSegment(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === "") return false;
  const segments = relative.split(path.sep);
  return segments.some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

function normalizePathname(rawPathname) {
  let pathname = String(rawPathname || "/");
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // keep original if malformed
  }
  pathname = pathname.replace(/\\/g, "/");
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  return pathname;
}


function resolveSpecialAssetCandidates(pathname) {
  const normalized = normalizePathname(pathname);
  const candidates = [];

  if (normalized === '/manage.html' || normalized === '/manageffmpeg.html') {
    candidates.push(path.join(appRoot, 'manage.html'));
  }

  if (normalized === '/ffmpeg/repair.html') {
    candidates.push(path.join(appRoot, 'repair.html'));
    candidates.push(path.join(appRoot, 'ffmpeg', 'repair.html'));
  }

  if (normalized === '/ffmpeg/index.html') {
    candidates.push(path.join(appRoot, 'ffmpeg', 'index.html'));
    candidates.push(path.join(appRoot, 'repair.html'));
  }

  if (normalized.startsWith('/ffmpeg/')) {
    candidates.push(path.join(appRoot, normalized.slice(1)));
  }

  return [...new Set(candidates)];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function etagForStat(stat) {
  return `W/\"${stat.size}-${Math.floor(stat.mtimeMs)}\"`;
}

// ===== UPDATED: now returns true for every path so COOP/COEP headers are always sent =====
function shouldSendIsolationHeaders(pathname) {
  // Unconditional – every response gets Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy.
  // This is required for SharedArrayBuffer (used by threaded WASM like ort-wasm-simd-threaded.jsep).
  // If you later need to restrict the headers to only HTML pages, use the commented-out version below.
  return true;

  /*
  // Alternative: send only for paths that likely serve HTML (or /emulator)
  const normalized = normalizePathname(pathname);
  if (normalized === "/" || normalized.endsWith(".html") || normalized.endsWith(".htm")) return true;
  if (normalized.startsWith("/emulator/")) return true;
  return false;
  */
}

function isolationHeaders(pathname) {
  if (!shouldSendIsolationHeaders(pathname)) {
    return {};
  }

  return {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp"
  };
}

function resourcePolicyHeaders() {
  const value = String(CROSS_ORIGIN_RESOURCE_POLICY || "").trim().toLowerCase();
  if (!value || value === "0" || value === "false" || value === "off" || value === "none" || value === "null" || value === "no") {
    return {};
  }
  return {
    "Cross-Origin-Resource-Policy": CROSS_ORIGIN_RESOURCE_POLICY
  };
}

function baseHeaders(extra = {}, pathname = "") {
  const headers = {
    "Cache-Control": CACHE_CONTROL,
    ...isolationHeaders(pathname),
    ...resourcePolicyHeaders(),
    ...extra
  };
  if (ENABLE_CORS) {
    Object.assign(headers, withCors("*"));
  }
  return headers;
}

function acceptsEncoding(req, encoding) {
  const header = String(req.headers["accept-encoding"] || "").toLowerCase();
  return header.split(",").some((part) => part.trim().startsWith(encoding));
}

function rangeNotSatisfiable(res, size, extra = {}) {
  send(res, 416, "Requested Range Not Satisfiable", {
    ...baseHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Range": `bytes */${size}`,
      ...extra
    })
  });
}

function parseRangeHeader(rangeHeader, size) {
  const raw = String(rangeHeader || "").trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!match) return null;

  let start = match[1] === "" ? null : Number.parseInt(match[1], 10);
  let end = match[2] === "" ? null : Number.parseInt(match[2], 10);

  if ((start != null && (!Number.isFinite(start) || start < 0)) || (end != null && (!Number.isFinite(end) || end < 0))) {
    return null;
  }

  if (start == null && end == null) return null;

  if (start == null) {
    const suffixLength = end;
    if (suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    if (end == null || end >= size) end = size - 1;
  }

  if (start > end || start >= size) return null;

  return { start, end };
}

function choosePrecompressedFile(filePath, req) {
  if (!PRECOMPRESSION) return null;
  const originalExt = path.extname(filePath);
  if (!originalExt) return null;

  if (acceptsEncoding(req, "br")) {
    const candidate = `${filePath}.br`;
    if (fs.existsSync(candidate)) return { path: candidate, encoding: "br", contentType: mime[originalExt.toLowerCase()] || "application/octet-stream" };
  }
  if (acceptsEncoding(req, "gzip")) {
    const candidate = `${filePath}.gz`;
    if (fs.existsSync(candidate)) return { path: candidate, encoding: "gzip", contentType: mime[originalExt.toLowerCase()] || "application/octet-stream" };
  }
  return null;
}

async function readFileSafe(filePath) {
  try {
    return await fsp.readFile(filePath);
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath) {
  try {
    const stat = await fsp.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}


async function ensureParentDir(filePath) {
  const parentDir = path.dirname(filePath);
  if (!parentDir) return;

  const parsed = path.parse(parentDir);
  if (parentDir === parsed.root) {
    return;
  }

  await fsp.mkdir(parentDir, { recursive: true });
}


async function writeFileReplacing(targetFilePath, payload) {
  await ensureParentDir(targetFilePath);

  try {
    await fsp.writeFile(targetFilePath, payload);
    return;
  } catch (directError) {
    if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(String(directError?.code || ''))) {
      throw directError;
    }

    try {
      await fsp.unlink(targetFilePath);
    } catch {
      // ignore; if unlink fails, the following write may still succeed or surface a clearer error.
    }

    await fsp.writeFile(targetFilePath, payload);
  }
}

const UPLOAD_SESSION_ROOT_DIR = '.libraryjs-temp-upload';
const uploadSessionQueues = new Map();

function sanitizeUploadToken(raw, fallback = 'upload') {
  const cleaned = String(raw || '').trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return cleaned.slice(0, 96) || `${fallback}-${Date.now()}`;
}

function makeReadableStem(filePath) {
  const base = path.parse(String(filePath || '')).name || 'upload';
  return base
    .replace(/[\/]+/g, ' ')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120) || 'upload';
}

function parsePositiveInt(raw) {
  const value = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseContentRangeHeader(value) {
  const raw = String(value || '').trim();
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(raw);
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  const total = match[3] === '*' ? null : Number.parseInt(match[3], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
  if (total !== null && (!Number.isFinite(total) || total <= end)) return null;
  return { start, end, total };
}

function mergeRanges(ranges) {
  const cleaned = (Array.isArray(ranges) ? ranges : [])
    .map((range) => {
      const start = Number.isFinite(Number(range?.[0])) ? Number(range[0]) : null;
      const end = Number.isFinite(Number(range?.[1])) ? Number(range[1]) : null;
      if (start === null || end === null || start < 0 || end < start) return null;
      return [start, end];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const out = [];
  for (const range of cleaned) {
    const last = out[out.length - 1];
    if (!last || range[0] > last[1] + 1) {
      out.push([...range]);
      continue;
    }
    last[1] = Math.max(last[1], range[1]);
  }
  return out;
}

function coveredBytes(ranges) {
  return mergeRanges(ranges).reduce((total, [start, end]) => total + (end - start + 1), 0);
}

function getUploadTempRoot() {
  return path.join(libraryRoot, UPLOAD_SESSION_ROOT_DIR);
}

function getUploadSessionSlug(targetFilePath, uploadId) {
  const stem = makeReadableStem(targetFilePath);
  const tag = createHash('sha1').update(String(uploadId || '')).digest('hex').slice(0, 8);
  return `${stem}-${tag}`;
}

function getUploadSessionPaths(targetFilePath, uploadId) {
  const tempRoot = getUploadTempRoot();
  const sessionSlug = getUploadSessionSlug(targetFilePath, uploadId);
  const sessionRoot = path.join(tempRoot, sessionSlug);
  return {
    tempRoot,
    sessionSlug,
    sessionRoot,
    manifestPath: path.join(sessionRoot, 'manifest.json'),
    assembledPath: path.join(sessionRoot, 'assembled.part')
  };
}

function getChunkFilePath(targetFilePath, uploadId, partIndex) {
  const { sessionRoot, sessionSlug } = getUploadSessionPaths(targetFilePath, uploadId);
  const partLabel = `ps${String(Number(partIndex) + 1).padStart(4, '0')}`;
  return path.join(sessionRoot, `${sessionSlug}-${partLabel}`);
}

async function readJsonFile(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, data) {
  await ensureParentDir(filePath);
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(data, null, 2));
  await fsp.rename(tempPath, filePath);
}

async function renameReplacing(sourcePath, targetPath) {
  await ensureParentDir(targetPath);
  try {
    await pipeline(
      fs.createReadStream(sourcePath),
      fs.createWriteStream(targetPath, { flags: 'w' })
    );
    try { await fsp.rm(sourcePath, { force: true }); } catch {}
    return;
  } catch (err) {
    const code = String(err?.code || '');
    if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err;
    try {
      await pipeline(
        fs.createReadStream(sourcePath),
        fs.createWriteStream(targetPath, { flags: 'w' })
      );
      try { await fsp.rm(sourcePath, { force: true }); } catch {}
    } catch (err2) {
      throw err2;
    }
  }
}

async function cleanupTempRootIfEmpty() {
  const tempRoot = getUploadTempRoot();
  try {
    const entries = await fsp.readdir(tempRoot);
    if (!entries.length) {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

async function cleanupUploadSession(sessionRoot) {
  if (!sessionRoot) return;
  try {
    await fsp.rm(sessionRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function getRepairCleanupSessionRoot(sourcePath) {
  const resolvedSource = resolveRepairFilePath(sourcePath, { mustExist: false });
  if (!resolvedSource) return null;

  const tempRoots = [
    path.resolve(libraryRoot, 'libraryjs-upload-temp'),
    path.resolve(libraryRoot, '.libraryjs-upload-temp'),
    path.resolve(appRoot, 'libraryjs-upload-temp'),
    path.resolve(appRoot, '.libraryjs-upload-temp')
  ];

  for (const tempRoot of [...new Set(tempRoots)]) {
    const relative = path.relative(tempRoot, resolvedSource);
    if (!relative || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const [topFolder] = relative.split(path.sep);
    if (!topFolder || topFolder === '.' || topFolder === '..') continue;
    return path.join(tempRoot, topFolder);
  }

  return null;
}

function deriveUploadId(targetFilePath, totalSize) {
  return `derived-${createHash('sha1').update(`${path.resolve(targetFilePath)}|${Number(totalSize) || 0}`).digest('hex').slice(0, 24)}`;
}

function getUploadPartMeta(req, reqUrl, targetFilePath, bodyLength) {
  const headers = req.headers || {};
  const contentRange = parseContentRangeHeader(headers['content-range']);
  const offsetRaw =
    headers['x-libraryjs-upload-offset'] ??
    headers['x-upload-offset'] ??
    headers['x-streamtest-offset'] ??
    reqUrl.searchParams.get('offset');

  const totalRaw =
    contentRange?.total ??
    headers['x-libraryjs-upload-size'] ??
    headers['x-upload-size'] ??
    headers['x-streamtest-final-size'] ??
    reqUrl.searchParams.get('finalSize') ??
    reqUrl.searchParams.get('totalSize');

  const partRaw =
    headers['x-libraryjs-chunk-index'] ??
    headers['x-upload-part'] ??
    reqUrl.searchParams.get('part');

  const partCountRaw =
    headers['x-libraryjs-chunk-count'] ??
    headers['x-upload-count'] ??
    reqUrl.searchParams.get('parts');

  let start = contentRange?.start ?? null;
  let end = contentRange?.end ?? null;
  let totalSize = totalRaw != null && String(totalRaw).trim() !== '' ? parsePositiveInt(totalRaw) : null;

  if (start == null && offsetRaw != null && String(offsetRaw).trim() !== '') {
    start = parsePositiveInt(offsetRaw);
    if (start != null && bodyLength > 0) end = start + bodyLength - 1;
  }

  if (end == null && start != null && bodyLength > 0) end = start + bodyLength - 1;
  if (totalSize == null && contentRange?.total != null) totalSize = contentRange.total;

  const uploadIdRaw =
    headers['x-libraryjs-upload-id'] ??
    headers['x-upload-id'] ??
    reqUrl.searchParams.get('uploadId') ??
    reqUrl.searchParams.get('upload-id');

  const uploadId = sanitizeUploadToken(uploadIdRaw || deriveUploadId(targetFilePath, totalSize ?? bodyLength), 'upload');
  const partIndex = partRaw != null && String(partRaw).trim() !== '' ? parsePositiveInt(partRaw) : null;
  const partCount = partCountRaw != null && String(partCountRaw).trim() !== '' ? parsePositiveInt(partCountRaw) : null;

  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (!Number.isFinite(totalSize) || totalSize <= 0) return null;
  if (bodyLength !== (end - start + 1)) return null;
  if (start < 0 || end < start || end >= totalSize) return null;

  return { uploadId, start, end, totalSize, partIndex, partCount };
}

async function withUploadQueue(queueKey, task) {
  const previous = uploadSessionQueues.get(queueKey) || Promise.resolve();
  const next = previous.then(task, task);
  uploadSessionQueues.set(queueKey, next.catch(() => {}));
  try {
    return await next;
  } finally {
    if (uploadSessionQueues.get(queueKey) === uploadSessionQueues.get(queueKey)) {
      // leave the latest settled promise in place until the next task overwrites it
    }
  }
}

async function processSlicedUpload({ req, reqUrl, targetFilePath, bodyBuffer, partMeta, contentType }) {
  const { uploadId, start, end, totalSize, partIndex, partCount } = partMeta;
  const sessionKey = `${path.resolve(targetFilePath)}|${uploadId}`;
  return await withUploadQueue(sessionKey, async () => {
    const { tempRoot, sessionSlug, sessionRoot, manifestPath, assembledPath } = getUploadSessionPaths(targetFilePath, uploadId);
    await fsp.mkdir(sessionRoot, { recursive: true });

    const chunkPartIndex = Number.isFinite(partIndex) ? partIndex : Math.floor(start / Math.max(bodyBuffer.length, 1));
    const chunkPath = getChunkFilePath(targetFilePath, uploadId, chunkPartIndex);

    let manifest = await readJsonFile(manifestPath);
    if (!manifest) {
      manifest = {
        version: 2,
        targetFilePath: path.resolve(targetFilePath),
        uploadId,
        sessionSlug,
        totalSize,
        contentType: String(contentType || 'application/octet-stream'),
        receivedRanges: [],
        receivedParts: [],
        receivedBytes: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeJsonAtomic(manifestPath, manifest);
    } else {
      if (path.resolve(String(manifest.targetFilePath || '')) !== path.resolve(targetFilePath) || Number(manifest.totalSize || 0) !== totalSize) {
        throw new Error('Upload session metadata mismatch');
      }
      if (!Array.isArray(manifest.receivedRanges)) manifest.receivedRanges = [];
      if (!Array.isArray(manifest.receivedParts)) manifest.receivedParts = [];
    }

    await fsp.writeFile(chunkPath, bodyBuffer);

    const partRecord = {
      partIndex: Number.isFinite(partIndex) ? partIndex : chunkPartIndex,
      start,
      end,
      fileName: path.basename(chunkPath),
      bytes: bodyBuffer.length
    };
    const existingIdx = manifest.receivedParts.findIndex((item) => item.fileName === partRecord.fileName);
    if (existingIdx >= 0) manifest.receivedParts[existingIdx] = partRecord;
    else manifest.receivedParts.push(partRecord);

    manifest.receivedRanges = mergeRanges([...manifest.receivedRanges, [start, end]]);
    manifest.receivedBytes = coveredBytes(manifest.receivedRanges);
    manifest.updatedAt = new Date().toISOString();
    if (Number.isFinite(partIndex)) manifest.lastPartIndex = partIndex;
    if (Number.isFinite(partCount)) manifest.partCount = partCount;
    await writeJsonAtomic(manifestPath, manifest);

    const complete = manifest.receivedBytes >= totalSize && manifest.receivedRanges.length === 1 && manifest.receivedRanges[0][0] === 0 && manifest.receivedRanges[0][1] >= totalSize - 1;
    if (!complete) {
      return {
        ok: true,
        complete: false,
        receivedBytes: manifest.receivedBytes,
        totalSize,
        path: path.relative(libraryRoot, targetFilePath).replace(/\\/g, '/')
      };
    }

    const sortedParts = [...manifest.receivedParts]
      .filter((item) => item && Number.isFinite(Number(item.start)) && Number.isFinite(Number(item.end)) && item.fileName)
      .sort((a, b) => Number(a.start) - Number(b.start) || Number(a.end) - Number(b.end));

    await ensureParentDir(targetFilePath);

    // Assemble to a temp file first, then atomically replace the destination.
    // This avoids half-written output if the merge is interrupted and makes
    // directory creation failures much easier to diagnose.
    const assembledHandle = await fsp.open(assembledPath, 'w');
    try {
      for (const part of sortedParts) {
        const partPath = path.join(sessionRoot, part.fileName);
        const data = await fsp.readFile(partPath);
        await assembledHandle.write(data);
      }
    } catch (err) {
      try { await assembledHandle.close(); } catch {}
      try { await fsp.rm(assembledPath, { force: true }); } catch {}
      throw err;
    }
    await assembledHandle.close();

    const finalStat = await fsp.stat(assembledPath).catch(() => null);
    if (!finalStat || !finalStat.isFile() || Number(finalStat.size || 0) !== totalSize) {
      try { await fsp.rm(assembledPath, { force: true }); } catch {}
      throw new Error(`Finalized upload size mismatch for ${path.basename(targetFilePath)}`);
    }

    await renameReplacing(assembledPath, targetFilePath);

    await cleanupUploadSession(sessionRoot);
    try { await cleanupTempRootIfEmpty(); } catch {}
    logLine('UPLOAD ASSEMBLED', targetFilePath, `uploadId=${uploadId}`, `bytes=${totalSize}`);
    return {
      ok: true,
      complete: true,
      receivedBytes: totalSize,
      totalSize,
      path: path.relative(libraryRoot, targetFilePath).replace(/\\/g, '/')
    };
  });
}

function decodeMultipartFilename(contentDisposition) {
  const raw = String(contentDisposition || '');
  const star = /filename\*=UTF-8''([^;\r\n]+)/i.exec(raw);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { return star[1]; }
  }
  const plain = /filename="?([^";\r\n]+)"?/i.exec(raw);
  return plain ? plain[1] : null;
}

function parseMultipartUpload(contentType, bodyBuffer) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(String(contentType || ''));
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[1].trim()}`;
  const parts = bodyBuffer.toString('latin1').split(boundary);

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headersText = part.slice(0, headerEnd);
    if (!/content-disposition:/i.test(headersText)) continue;
    if (!/filename=/i.test(headersText)) continue;

    const filename = decodeMultipartFilename(headersText);
    if (!filename) continue;

    let contentSection = part.slice(headerEnd + 4);
    if (contentSection.endsWith('\r\n')) contentSection = contentSection.slice(0, -2);
    if (contentSection.endsWith('\n')) contentSection = contentSection.slice(0, -1);
    const content = Buffer.from(contentSection, 'latin1');
    return { filename, content };
  }
  return null;
}

async function collectRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}


async function pickIndexFile(dirPath) {
  for (const name of ["index.html", "index.htm"]) {
    const candidate = path.join(dirPath, name);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function renderDirectoryListing(root, dirPath, pathname) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const relParts = path.relative(root, dirPath).split(path.sep).filter(Boolean);
  const crumbs = [{ name: "Root", href: "/" }];
  let buildHref = "/";
  for (const part of relParts) {
    buildHref = path.posix.join(buildHref, part) + "/";
    crumbs.push({ name: part, href: buildHref });
  }

  const rows = [];
  if (path.resolve(dirPath) !== path.resolve(root)) {
    rows.push(`<tr><td><a href="../">../</a></td><td>Parent directory</td><td></td></tr>`);
  }

  for (const entry of entries) {
    if (!HIDDEN_DOT_FILES && entry.name.startsWith(".")) continue;
    const entryPath = path.join(dirPath, entry.name);
    const stat = await fsp.stat(entryPath).catch(() => null);
    const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;
    const hrefName = encodeURIComponent(entry.name) + (entry.isDirectory() ? "/" : "");
    const modified = stat ? new Date(stat.mtimeMs).toLocaleString() : "";
    const size = stat && stat.isFile() ? humanSize(stat.size) : entry.isDirectory() ? "Folder" : "";
    rows.push(`<tr><td><a href="${hrefName}">${escapeHtml(displayName)}</a></td><td>${escapeHtml(modified)}</td><td>${escapeHtml(size)}</td></tr>`);
  }

  const breadcrumb = crumbs.map((crumb, index) => {
    const sep = index > 0 ? " / " : "";
    return `${sep}<a href="${crumb.href}">${escapeHtml(crumb.name)}</a>`;
  }).join("");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Index of ${escapeHtml(pathname)}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;line-height:1.45}
h1{margin:0 0 10px}
nav{margin:0 0 16px;color:#444;word-break:break-all}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #ddd;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}
a{text-decoration:none}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>Index of ${escapeHtml(pathname)}</h1>
<nav>${breadcrumb}</nav>
<table>
<thead><tr><th>Name</th><th>Modified</th><th>Size</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
</body>
</html>`;

  return Buffer.from(html, "utf8");
}

async function serveStaticFile(req, res, reqPathname) {
  const pathname = normalizePathname(reqPathname);
  const wantsHtmlRedirect = EXCLUDE_DOT_HTML && /\.(html?|htm)$/i.test(pathname);

  const specialCandidates = resolveSpecialAssetCandidates(pathname);
  for (const specialPath of specialCandidates) {
    const resolvedSpecial = path.resolve(specialPath);
    if (await fileExists(resolvedSpecial)) {
      await sendFile(req, res, resolvedSpecial, { requestedPath: pathname, appAsset: true });
      return;
    }
  }

  let targetPath;
  if (pathname === "/") {
    targetPath = path.join(libraryRoot, "index.html");
  } else if (pathname === "/emulator/reader.html") {
    // Mirror root reader.html under /emulator/ so iframe + isolation headers match
    targetPath = path.join(libraryRoot, "reader.html");
  } else if (pathname === "/emulator/booklib.html") {
    // Mirror root booklib.html under /emulator/ for the same iframe flow.
    targetPath = path.join(libraryRoot, "booklib.html");
  } else if (pathname === "/emulator/books.js") {
    // booklib.html loads its library catalog relative to its own URL.
    targetPath = path.join(libraryRoot, "books.js");
  } else if (pathname === "/emulator/manga.js") {
    // Same treatment for manga mode.
    targetPath = path.join(libraryRoot, "manga.js");
  } else if (pathname === "/emulator/guidebooks.js") {
    // Same treatment for guidebook mode.
    targetPath = path.join(libraryRoot, "guidebooks.js");
  } else if (pathname === "/emulator/games.js") {
    // booklib.html fetches games.js relative to its own URL.
    targetPath = path.join(libraryRoot, "games.js");
  } else {
    targetPath = path.join(libraryRoot, pathname.slice(1));
  }

  const resolvedTarget = path.resolve(targetPath);
  if (!isInsideRoot(libraryRoot, resolvedTarget)) {
    send(res, 403, "Forbidden", baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }, pathname));
    return;
  }

  if (!HIDDEN_DOT_FILES && hasHiddenSegment(libraryRoot, resolvedTarget)) {
    send(res, 403, "Forbidden", baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }, pathname));
    return;
  }

  const targetStat = await fsp.stat(resolvedTarget).catch(() => null);

  if (targetStat && targetStat.isDirectory()) {
    const indexFile = SHOW_INDEX ? await pickIndexFile(resolvedTarget) : null;
    if (indexFile) {
      await sendFile(req, res, indexFile, { requestedPath: pathname, asIndex: true });
      return;
    }

    if (pathname !== "/" && !pathname.endsWith("/")) {
      send(res, 301, "", baseHeaders({ Location: `${pathname}/` }, pathname));
      return;
    }

    if (DIRECTORY_LISTING) {
      const listing = await renderDirectoryListing(libraryRoot, resolvedTarget, pathname);
      send(res, 200, listing, baseHeaders({ "Content-Type": "text/html; charset=utf-8" }, pathname));
      return;
    }

    send(res, 404, "Not found", baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }, meta.requestedPath || ""));
    return;
  }

  if (targetStat && targetStat.isFile()) {
    await sendFile(req, res, resolvedTarget, { requestedPath: pathname });
    return;
  }

  if (wantsHtmlRedirect) {
    const withoutExt = pathname.replace(/\.(html?|htm)$/i, "");
    const noExtTarget = path.resolve(path.join(libraryRoot, withoutExt.slice(1)));
    if (await fileExists(noExtTarget)) {
      send(res, 302, "", baseHeaders({ Location: withoutExt }, pathname));
      return;
    }
  }

  for (const ext of [".html", ".htm"]) {
    const candidate = path.resolve(path.join(libraryRoot, pathname.slice(1) + ext));
    if (!isInsideRoot(libraryRoot, candidate)) continue;
    if (await fileExists(candidate)) {
      await sendFile(req, res, candidate, { requestedPath: pathname, htmlFallback: true });
      return;
    }
  }

  if (SPA) {
    const rewriteTarget = DEFAULT_SPA_REWRITE.startsWith("/") ? DEFAULT_SPA_REWRITE : `/${DEFAULT_SPA_REWRITE}`;
    const rewritten = path.resolve(path.join(libraryRoot, rewriteTarget.slice(1)));
    if (await fileExists(rewritten)) {
      await sendFile(req, res, rewritten, { requestedPath: pathname, spaRewrite: true });
      return;
    }
  }

  send(res, 404, "Not found", baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }, pathname));
}

async function sendFile(req, res, filePath, meta = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    send(res, 404, "Not found", baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }, meta.requestedPath || ""));
    return;
  }

  const etag = etagForStat(stat);
  const lastModified = stat.mtime.toUTCString();

  if (req.headers["if-none-match"] && String(req.headers["if-none-match"]).split(/\s*,\s*/).includes(etag) && !req.headers.range) {
    res.writeHead(304, baseHeaders({
      ETag: etag,
      "Last-Modified": lastModified,
      "Accept-Ranges": "bytes"
    }, meta.requestedPath || ""));
    res.end();
    return;
  }

  const isHead = String(req.method || "GET").toUpperCase() === "HEAD";
  const precompressed = !req.headers.range ? choosePrecompressedFile(filePath, req) : null;
  const actualPath = precompressed?.path || filePath;
  const actualStat = precompressed ? await fsp.stat(actualPath) : stat;
  const contentType = precompressed?.contentType || mime[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const commonHeaders = baseHeaders({
    "Content-Type": contentType,
    ETag: etag,
    "Last-Modified": lastModified,
    "Accept-Ranges": "bytes"
  }, meta.requestedPath || "");

  if (precompressed) {
    commonHeaders["Content-Encoding"] = precompressed.encoding;
    commonHeaders["Vary"] = "Accept-Encoding";
  }

  if (req.headers.range && !precompressed) {
    const parsedRange = parseRangeHeader(req.headers.range, actualStat.size);
    if (!parsedRange) {
      rangeNotSatisfiable(res, actualStat.size, { ETag: etag, "Last-Modified": lastModified });
      return;
    }

    const { start, end } = parsedRange;
    const contentLength = end - start + 1;
    if (isHead) {
      res.writeHead(206, {
        ...commonHeaders,
        "Content-Range": `bytes ${start}-${end}/${actualStat.size}`,
        "Content-Length": String(contentLength)
      });
      res.end();
      return;
    }

    res.writeHead(206, {
      ...commonHeaders,
      "Content-Range": `bytes ${start}-${end}/${actualStat.size}`,
      "Content-Length": String(contentLength)
    });
    fs.createReadStream(actualPath, { start, end }).pipe(res);
    return;
  }

  if (isHead) {
    res.writeHead(200, {
      ...commonHeaders,
      "Content-Length": String(actualStat.size)
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    ...commonHeaders,
    "Content-Length": String(actualStat.size)
  });
  fs.createReadStream(actualPath).pipe(res);
}

function toBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

function fromBase64(base64) {
  return Buffer.from(base64, "base64");
}

function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

function rewriteProxyHeaders(headers) {
  const normalized = normalizeHeaders(headers);
  const out = new Headers();
  for (const [key, value] of Object.entries(normalized)) {
    const lower = key.toLowerCase();
    if (lower === "x-override-user-agent") {
      out.set("user-agent", value);
      continue;
    }
    if (lower === "x-override-origin") {
      out.set("origin", value);
      continue;
    }
    try {
      out.set(key, value);
    } catch {
      // Ignore forbidden or unsupported headers.
    }
  }
  return out;
}

function sanitizeFilename(input) {
  const raw = String(input || "").trim() || "download.bin";
  return raw.replace(/[\\/:*?"<>|]+/g, "_");
}

function parseUrlLikePath(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return decodeURIComponent(url.pathname || "/");
    }
    if (url.protocol === "file:") {
      return fileURLToPath(url);
    }
  } catch {
    // not a URL, keep as-is
  }
  return text;
}

function isHttpUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function uploadFileToUrl(sourcePath, targetUrl) {
  const body = fs.createReadStream(sourcePath);
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      body,
      duplex: "half",
      redirect: "follow",
      headers: {
        "Content-Type": "application/octet-stream"
      }
    });
    if (!response.ok) {
      throw new Error(`Upload failed: HTTP ${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    body.destroy?.();
  }
}

function resolveLibraryPath(raw) {
  const text = parseUrlLikePath(raw);
  if (!text) return null;

  const normalized = text.replace(/\\/g, "/");
  let resolved;
  if (/^[a-zA-Z]:[\\/]/.test(normalized) || (path.isAbsolute(normalized) && !normalized.startsWith("/"))) {
    resolved = path.resolve(normalized);
  } else {
    const rel = normalized.replace(/^\/+/, "");
    resolved = path.resolve(libraryRoot, rel);
  }

  return isInsideRoot(libraryRoot, resolved) ? resolved : null;
}

function resolveRepairFilePath(raw, { mustExist = false } = {}) {
  const text = parseUrlLikePath(raw);
  if (!text) return null;

  const normalized = text.replace(/\\/g, '/');
  const candidates = [];

  if (/^[a-zA-Z]:[\\/]/.test(normalized) || (path.isAbsolute(normalized) && !normalized.startsWith('/'))) {
    candidates.push(path.resolve(normalized));
  } else {
    const rel = normalized.replace(/^\/+/, '');
    candidates.push(path.resolve(libraryRoot, rel));
    if (appRoot !== libraryRoot) candidates.push(path.resolve(appRoot, rel));
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!candidate) continue;
    if (!isInsideRoot(libraryRoot, candidate) && !isInsideRoot(appRoot, candidate)) continue;
    if (!mustExist) return candidate;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }

  return null;
}

function deriveRepairTarget(sourcePath, requestedTarget, requestedOutputName) {
  const fallbackName = sanitizeFilename(
    requestedOutputName ||
    `${path.parse(sourcePath).name || 'repaired'}.mp4`
  );

  const explicit = requestedTarget ? resolveLibraryPath(requestedTarget) : null;
  if (!explicit) return path.join(path.dirname(sourcePath), fallbackName);

  try {
    const stat = fs.statSync(explicit);
    if (stat.isDirectory()) {
      return path.join(explicit, fallbackName);
    }
  } catch {}

  const raw = String(requestedTarget || '').trim();
  if (raw.endsWith(path.sep) || raw.endsWith('/') || raw.endsWith('\\')) {
    return path.join(explicit, fallbackName);
  }

  return explicit;
}


function contentDisposition(filename) {
  const safe = sanitizeFilename(filename);
  return `attachment; filename="${safe.replace(/\"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function downloadHeaders(filename, upstream) {
  const headers = baseHeaders({
    "Content-Disposition": contentDisposition(filename),
    "Cache-Control": "no-store"
  });

  const passThrough = ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified", "cache-control"];
  for (const key of passThrough) {
    const value = upstream.headers.get(key);
    if (value) headers[key] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "application/octet-stream";
  return headers;
}

async function handleDownload(req, res, reqUrl) {
  const method = String(req.method || "GET").toUpperCase();
  let payload = {};

  if (method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...baseHeaders()
      });
      return;
    }
  }

  const url = String(payload.url || reqUrl.searchParams.get("url") || "").trim();
  const filename = String(payload.filename || reqUrl.searchParams.get("filename") || "download.bin").trim() || "download.bin";

  if (!url) {
    send(res, 400, "Missing url", { "Content-Type": "text/plain; charset=utf-8", ...baseHeaders() });
    return;
  }

  const suppliedHeaders = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
  const suppliedMethod = String(payload.method || method || "GET").toUpperCase();
  const suppliedUA = String(
    suppliedHeaders["user-agent"] ||
    suppliedHeaders["User-Agent"] ||
    payload.userAgent ||
    reqUrl.searchParams.get("ua") ||
    req.headers["user-agent"] ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
  ).trim();
  let suppliedReferer = String(
    suppliedHeaders.referer ||
    suppliedHeaders.referrer ||
    payload.referer ||
    payload.referrer ||
    reqUrl.searchParams.get("referer") ||
    req.headers.referer ||
    ""
  ).trim();
  let suppliedOrigin = String(
    suppliedHeaders.origin ||
    payload.origin ||
    reqUrl.searchParams.get("origin") ||
    ""
  ).trim();

  if (!suppliedOrigin) {
    try {
      suppliedOrigin = suppliedReferer ? new URL(suppliedReferer).origin : new URL(url).origin;
    } catch {
      suppliedOrigin = "";
    }
  }
  if (!suppliedReferer) {
    try {
      suppliedReferer = `${new URL(url).origin}/`;
    } catch {
      suppliedReferer = "";
    }
  }

  const isMusicProxyRoute = String(reqUrl.pathname || "").startsWith("/Musicproxy/");
  if (isMusicProxyRoute) {
    if (!suppliedReferer) suppliedReferer = "https://www.youtube.com/";
    if (!suppliedOrigin) suppliedOrigin = "https://www.youtube.com";
  }

  let upstream;
  try {
    const upstreamHeaders = new Headers();
    for (const [key, value] of Object.entries(suppliedHeaders)) {
      if (value == null) continue;
      const lower = key.toLowerCase();
      if (["host", "content-length", "connection"].includes(lower)) continue;
      upstreamHeaders.set(key, String(value));
    }
    upstreamHeaders.set("user-agent", suppliedUA);
    if (suppliedReferer) upstreamHeaders.set("referer", suppliedReferer);
    if (suppliedOrigin) upstreamHeaders.set("origin", suppliedOrigin);

    const range = req.headers.range || suppliedHeaders.range || reqUrl.searchParams.get("range");
    if (range) upstreamHeaders.set("range", String(range));

    upstream = await fetch(url, { method: suppliedMethod, redirect: "follow", headers: upstreamHeaders });
  } catch (error) {
    send(res, 502, JSON.stringify({ ok: false, error: error?.message || String(error) }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...baseHeaders()
    });
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    const text = await upstream.text().catch(() => "");
    send(res, upstream.status, JSON.stringify({ ok: false, error: text || upstream.statusText || "Upstream fetch failed" }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...baseHeaders()
    });
    return;
  }

  const responseHeaders = downloadHeaders(filename, upstream);
  responseHeaders["X-LibraryJS-Final-Url"] = upstream.url || url;

  if (suppliedMethod === "HEAD") {
    res.writeHead(upstream.status, responseHeaders);
    res.end();
    return;
  }

  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

async function handleUpload(req, res, reqUrl) {
  try {
    const method = String(req.method || 'POST').toUpperCase();
    logLine('UPLOAD START', method, reqUrl.pathname, reqUrl.search || '', 'from', req.socket?.remoteAddress || 'unknown');
    if (!['POST', 'PUT'].includes(method)) {
      send(res, 405, JSON.stringify({ ok: false, error: 'Use POST or PUT' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders()
      });
      return;
    }

    const bodyBuffer = await collectRequestBody(req);
    logLine('UPLOAD BODY', 'bytes=' + bodyBuffer.length, 'content-type=' + String(req.headers['content-type'] || ''));
    const contentType = String(req.headers['content-type'] || '');
    const isMultipart = /multipart\/form-data/i.test(contentType);
    const urlPath = normalizePathname(reqUrl.pathname);

    let targetFilePath = null;
    let payload = bodyBuffer;

    if (urlPath === '/api/file/upload') {
      const uploadDir = normalizePathname(reqUrl.searchParams.get('path') || '/').replace(/^\//, '');
      const explicitName = String(reqUrl.searchParams.get('name') || '').trim();
      let filename = explicitName;

      if (!filename && isMultipart) {
        const mp = parseMultipartUpload(contentType, bodyBuffer);
        if (mp) {
          filename = mp.filename;
          payload = mp.content;
        }
      }

      if (!filename) {
        send(res, 400, JSON.stringify({ ok: false, error: 'Missing filename' }), {
          'Content-Type': 'application/json; charset=utf-8',
          ...baseHeaders()
        });
        return;
      }

      targetFilePath = path.resolve(libraryRoot, uploadDir, filename);
    } else {
      targetFilePath = path.resolve(libraryRoot, urlPath.replace(/^\//, ''));
    }

    if (!isInsideRoot(libraryRoot, targetFilePath)) {
      send(res, 403, JSON.stringify({ ok: false, error: 'Forbidden' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders()
      });
      return;
    }
    if (!HIDDEN_DOT_FILES && hasHiddenSegment(libraryRoot, targetFilePath)) {
      send(res, 403, JSON.stringify({ ok: false, error: 'Forbidden' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders()
      });
      return;
    }

    const partMeta = getUploadPartMeta(req, reqUrl, targetFilePath, bodyBuffer.length);
    if (partMeta) {
      logLine('UPLOAD SLICE', targetFilePath, `uploadId=${partMeta.uploadId}`, `start=${partMeta.start}`, `end=${partMeta.end}`, `total=${partMeta.totalSize}`);
      const result = await processSlicedUpload({
        req,
        reqUrl,
        targetFilePath,
        bodyBuffer,
        partMeta,
        contentType
      });
      send(res, 200, JSON.stringify({
        ok: true,
        mode: 'sliced-put',
        complete: !!result.complete,
        receivedBytes: Number(result.receivedBytes || bodyBuffer.length) || bodyBuffer.length,
        totalSize: Number(result.totalSize || partMeta.totalSize) || partMeta.totalSize,
        path: result.path
      }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }

    logLine('UPLOAD TARGET', targetFilePath, 'payload=' + payload.length);
    await writeFileReplacing(targetFilePath, payload);
    logLine('UPLOAD OK', targetFilePath);

    send(res, 200, JSON.stringify({
      ok: true,
      mode: 'whole-put',
      path: path.relative(libraryRoot, targetFilePath).replace(/\\/g, '/')
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      ...baseHeaders({ 'Cache-Control': 'no-store' })
    });
  } catch (error) {
    logLine('UPLOAD FAILED', error);
    if (!res.headersSent) {
      const code = error?.code ? String(error.code) : '';
      const details = error?.message || String(error);
      send(res, 500, JSON.stringify({ ok: false, error: details, code }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
    } else {
      try { res.end(); } catch {}
    }
  }
}

async function handleRemoteCopy(req, res, reqUrl) {
  try {
    const method = String(req.method || 'POST').toUpperCase();
    logLine('COPY START', method, reqUrl.pathname, reqUrl.search || '', 'from', req.socket?.remoteAddress || 'unknown');
    if (method === 'OPTIONS') {
      send(res, 204, '', baseHeaders({ 'Cache-Control': 'no-store' }));
      return;
    }
    if (method !== 'POST') {
      send(res, 405, JSON.stringify({ ok: false, error: 'Use POST' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }

    let payload = {};
    try {
      const raw = (await collectRequestBody(req)).toString('utf8');
      payload = raw ? JSON.parse(raw) : {};
    } catch (error) {
      send(res, 400, JSON.stringify({ ok: false, error: `Invalid JSON body: ${error?.message || String(error)}` }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }

    const sourceUrl = String(payload.sourceUrl || payload.source || '').trim();
    const targetRef = String(payload.targetPath || payload.target || '').trim();
    if (!sourceUrl) {
      send(res, 400, JSON.stringify({ ok: false, error: 'Missing sourceUrl' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }
    if (!targetRef) {
      send(res, 400, JSON.stringify({ ok: false, error: 'Missing targetPath' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }

    let parsedSource;
    try {
      parsedSource = new URL(sourceUrl);
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: 'Invalid sourceUrl' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }
    if (!['http:', 'https:'].includes(parsedSource.protocol)) {
      send(res, 400, JSON.stringify({ ok: false, error: 'sourceUrl must use http or https' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }

    const targetFilePath = path.resolve(libraryRoot, normalizePathname(targetRef).replace(/^\//, ''));
    if (!isInsideRoot(libraryRoot, targetFilePath)) {
      send(res, 403, JSON.stringify({ ok: false, error: 'Forbidden' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }
    if (!HIDDEN_DOT_FILES && hasHiddenSegment(libraryRoot, targetFilePath)) {
      send(res, 403, JSON.stringify({ ok: false, error: 'Forbidden' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }

    await ensureParentDir(targetFilePath);
    const tempPath = `${targetFilePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.copy.tmp`;
    const upstream = await fetch(sourceUrl, { redirect: 'follow' });
    if (!upstream.ok) {
      send(res, 502, JSON.stringify({ ok: false, error: `Source fetch failed: HTTP ${upstream.status} ${upstream.statusText}` }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }
    if (!upstream.body) {
      send(res, 502, JSON.stringify({ ok: false, error: 'Source fetch returned no body' }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
      return;
    }

    const out = fs.createWriteStream(tempPath, { flags: 'w' });
    try {
      await pipeline(Readable.fromWeb(upstream.body), out);
      await renameReplacing(tempPath, targetFilePath);
    } finally {
      try { await fsp.rm(tempPath, { force: true }); } catch {}
    }

    send(res, 200, JSON.stringify({
      ok: true,
      mode: 'remote-copy',
      path: path.relative(libraryRoot, targetFilePath).replace(/\\/g, '/')
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      ...baseHeaders({ 'Cache-Control': 'no-store' })
    });
  } catch (error) {
    logLine('COPY FAILED', error);
    if (!res.headersSent) {
      const code = error?.code ? String(error.code) : '';
      const details = error?.message || String(error);
      send(res, 500, JSON.stringify({ ok: false, error: details, code }), {
        'Content-Type': 'application/json; charset=utf-8',
        ...baseHeaders({ 'Cache-Control': 'no-store' })
      });
    } else {
      try { res.end(); } catch {}
    }
  }
}


async function handleProxy(req, res) {
  const origin = req.headers.origin || "*";
  const cors = withCors(origin === "null" ? "*" : origin);

  if (req.method === "OPTIONS") {
    send(res, 204, "", cors);
    return;
  }

  if (req.method !== "POST") {
    send(res, 405, JSON.stringify({ ok: false, error: "Use POST" }), {
      ...cors,
      "Content-Type": "application/json; charset=utf-8"
    });
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    send(res, 400, JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
      ...cors,
      "Content-Type": "application/json; charset=utf-8"
    });
    return;
  }

  const { url, method = "GET", headers = {}, bodyText, bodyBase64, responseType = "text", credentials = "omit" } = payload;
  if (!url) {
    send(res, 400, JSON.stringify({ ok: false, error: "Missing url" }), {
      ...cors,
      "Content-Type": "application/json; charset=utf-8"
    });
    return;
  }

  const init = {
    method,
    redirect: "follow",
    credentials,
    headers: rewriteProxyHeaders(headers)
  };

  if (bodyText != null) init.body = bodyText;
  else if (bodyBase64 != null) init.body = fromBase64(bodyBase64);

  try {
    const response = await fetch(url, init);
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let body;
    let bodyEncoding = "text";
    if (responseType === "arrayBuffer" || responseType === "binary") {
      body = toBase64(await response.arrayBuffer());
      bodyEncoding = "base64";
    } else {
      body = await response.text();
    }

    send(res, 200, JSON.stringify({ ok: true, status: response.status, statusText: response.statusText, headers: responseHeaders, body, bodyEncoding, finalUrl: response.url }), {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
  } catch (error) {
    send(res, 502, JSON.stringify({ ok: false, error: error?.message || String(error) }), {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
  }
}

const requestHandler = async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = normalizePathname(reqUrl.pathname);
    const method = String(req.method || 'GET').toUpperCase();
    logLine('REQ', method, pathname);

    if (method === 'OPTIONS') {
      send(res, 204, '', baseHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Range, If-None-Match, If-Modified-Since, Content-Range, Content-Disposition, X-LibraryJS-Upload-Id, X-LibraryJS-Upload-Name, X-LibraryJS-Upload-Size, X-LibraryJS-Upload-Offset, X-LibraryJS-Chunk-Index, X-LibraryJS-Chunk-Count, X-Upload-Id, X-Upload-Name, X-Upload-Size, X-Upload-Offset, X-Upload-Part, X-Upload-Count, X-Streamtest-Offset, X-Streamtest-Final-Size',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Location, Content-Disposition',
        'Access-Control-Allow-Private-Network': 'true'
      }));
      return;
    }

    if (pathname === '/api/health') {
      send(res, 200, JSON.stringify({ ok: true, root: libraryRoot, now: new Date().toISOString(), https: ENABLE_HTTPS }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...baseHeaders()
      });
      return;
    }

    if (pathname === '/proxy') {
      await handleProxy(req, res);
      return;
    }

    if (pathname === '/Musicproxy/proxy') {
      await handleProxy(req, res);
      return;
    }

    if (pathname === '/api/file/copy') {
      await handleRemoteCopy(req, res, reqUrl);
      return;
    }

    if (pathname === '/api/ffmpeg/repair' || pathname.startsWith('/api/ffmpeg/repair/')) {
      await handleFfmpegRepairApi(req, res, reqUrl);
      return;
    }

    if (pathname === '/download') {
      await handleDownload(req, res, reqUrl);
      return;
    }

    if (pathname === '/Musicproxy/download') {
      await handleDownload(req, res, reqUrl);
      return;
    }

    if (method === 'POST' || method === 'PUT') {
      await handleUpload(req, res, reqUrl);
      return;
    }

    if (!['GET', 'HEAD'].includes(method)) {
      send(res, 405, 'Method Not Allowed', baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      return;
    }

    await serveStaticFile(req, res, pathname);
  } catch (error) {
    logLine('REQUEST FAILED', error);
    if (!res.headersSent) {
      send(res, 500, 'Internal Server Error', baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    } else {
      try { res.end(); } catch {}
    }
  }
};

const port = await askPort();
ensureLogFilePath(port);
if (ENABLE_LOGGING) {
  logLine('BOOT', 'Serving root=' + libraryRoot, 'port=' + port, 'https=' + ENABLE_HTTPS, 'log=' + logFilePath);
  logLine('Debug logging enabled. Log file is located in %TEMP%:', logFilePath);
}
let server;
if (ENABLE_HTTPS) {
  const { cert, key } = readTlsMaterial(TLS_CERT_PATH, TLS_KEY_PATH);
  server = https.createServer({ cert, key }, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

server.listen(port, host, () => {
  const scheme = ENABLE_HTTPS ? 'https' : 'http';
  logLine(`Serving ${libraryRoot} at ${scheme}://localhost:${port}/`);
  logLine(`Local proxy endpoint: ${scheme}://localhost:${port}/proxy`);
  logLine(`Local download endpoint: ${scheme}://localhost:${port}/download`);
  logLine(`Music proxy endpoint: ${scheme}://localhost:${port}/Musicproxy/proxy`);
  logLine(`Music download endpoint: ${scheme}://localhost:${port}/Musicproxy/download`);
  logLine(`Static options: index=${SHOW_INDEX} listing=${DIRECTORY_LISTING} hidden=${HIDDEN_DOT_FILES} precompression=${PRECOMPRESSION} spa=${SPA} dotHtmlRedirect=${EXCLUDE_DOT_HTML} https=${ENABLE_HTTPS}`);
});
