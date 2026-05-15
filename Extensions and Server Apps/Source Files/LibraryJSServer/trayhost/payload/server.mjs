import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import readline from "node:readline/promises";
import os from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

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

const libraryRoot = path.resolve(String(process.env.LIBRARYJS_ROOT || getArgValue(["--root"]) || appRoot).trim());
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
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav"
};

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Range, If-None-Match, If-Modified-Since, Content-Range, Content-Disposition",
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

function shouldSendIsolationHeaders(pathname) {
  const normalized = normalizePathname(pathname);
  return normalized === "/emulator"
    || normalized === "/emulator/"
    || normalized.startsWith("/emulator/");
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

function baseHeaders(extra = {}, pathname = "") {
  const headers = {
    "Cache-Control": CACHE_CONTROL,
    ...isolationHeaders(pathname),
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
  const url = reqUrl.searchParams.get("url");
  const filename = reqUrl.searchParams.get("filename") || "download.bin";

  if (!url) {
    send(res, 400, "Missing url", { "Content-Type": "text/plain; charset=utf-8", ...baseHeaders() });
    return;
  }

  let upstream;
  try {
    const upstreamHeaders = new Headers({
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      referer: "https://www.youtube.com/",
      origin: "https://www.youtube.com"
    });
    const range = req.headers.range;
    if (range) upstreamHeaders.set("range", range);
    upstream = await fetch(url, { method: req.method, redirect: "follow", headers: upstreamHeaders });
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

  if (String(req.method || "GET").toUpperCase() === "HEAD") {
    res.writeHead(upstream.status, downloadHeaders(filename, upstream));
    res.end();
    return;
  }

  res.writeHead(upstream.status, downloadHeaders(filename, upstream));
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

    logLine('UPLOAD TARGET', targetFilePath, 'payload=' + payload.length);
    await writeFileReplacing(targetFilePath, payload);
    logLine('UPLOAD OK', targetFilePath);

    send(res, 200, JSON.stringify({
      ok: true,
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Range, If-None-Match, If-Modified-Since, Content-Range, Content-Disposition',
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

    if (pathname === '/download') {
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
  logLine(`Static options: index=${SHOW_INDEX} listing=${DIRECTORY_LISTING} hidden=${HIDDEN_DOT_FILES} precompression=${PRECOMPRESSION} spa=${SPA} dotHtmlRedirect=${EXCLUDE_DOT_HTML} https=${ENABLE_HTTPS}`);
});
