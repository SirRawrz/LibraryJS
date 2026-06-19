function pretty(value) {
  return JSON.stringify(value, null, 2);
}

const els = {
  videoId: document.getElementById("videoId"),
  btnNext: document.getElementById("btnNext"),
  btnPlayer: document.getElementById("btnPlayer"),
  requestPreview: document.getElementById("requestPreview"),
  jsonOutput: document.getElementById("jsonOutput"),
  streamCategory: document.getElementById("streamCategory"),
  streamSelect: document.getElementById("streamSelect"),
  selectedSummary: document.getElementById("selectedSummary"),
  btnUseStream: document.getElementById("btnUseStream"),
  btnDownloadSelected: document.getElementById("btnDownloadSelected"),
  mediaUrl: document.getElementById("mediaUrl"),
  fileName: document.getElementById("fileName"),
  btnDownload: document.getElementById("btnDownload"),
  btnClear: document.getElementById("btnClear"),
  btnSendSelected: document.getElementById("btnSendSelected"),
  btnOpenLibraryJS: document.getElementById("btnOpenLibraryJS"),
  btnStartupOptions: document.getElementById("btnStartupOptions"),
  startupOptionsDialog: document.getElementById("startupOptionsDialog"),
  libraryJsHost: document.getElementById("libraryJsHost"),
  libraryJsPort: document.getElementById("libraryJsPort"),
  libraryJsPath: document.getElementById("libraryJsPath"),
  musicProxyUrl: document.getElementById("musicProxyUrl"),
  musicProxyPort: document.getElementById("musicProxyPort"),
  libraryJsStatus: document.getElementById("libraryJsStatus"),
  logOutput: document.getElementById("logOutput"),
  status: document.getElementById("status"),
  autoProgressOverlay: document.getElementById("autoProgressOverlay"),
  autoProgressTitle: document.getElementById("autoProgressTitle"),
  autoProgressDetail: document.getElementById("autoProgressDetail"),
  autoProgressBar: document.getElementById("autoProgressBar"),
  autoProgressPercent: document.getElementById("autoProgressPercent"),
  autoProgressStage: document.getElementById("autoProgressStage")
};

const state = {
  lastPlayerResponse: null,
  streamsByCategory: {
    muxed: [],
    video: [],
    audio: []
  },
  selectedCategory: "muxed"
};

const autoState = {
  active: false,
  hideTimer: null
};

const SETTINGS_KEY = "ud_libraryjs_handoff_settings";
let bridgeSettings = {
  musicProxyUrl: "",
  musicProxyPort: ""
};

let currentHandoffSettings = null;

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function setLibraryJSStatus(text, kind = "") {
  if (!els.libraryJsStatus) return;
  els.libraryJsStatus.value = text;
  els.libraryJsStatus.className = `status ${kind}`.trim();
}

function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function showAutoProgress() {
  if (!els.autoProgressOverlay) return;
  autoState.active = true;
  els.autoProgressOverlay.classList.add("show");
  els.autoProgressOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("auto-busy");
}

function hideAutoProgress() {
  if (!els.autoProgressOverlay) return;
  autoState.active = false;
  els.autoProgressOverlay.classList.remove("show");
  els.autoProgressOverlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("auto-busy");
}

function setAutoProgress(progress, title, detail, stage) {
  const percent = clampProgress(progress);
  if (els.autoProgressBar) els.autoProgressBar.value = percent;
  if (els.autoProgressPercent) els.autoProgressPercent.textContent = `${percent}%`;
  if (els.autoProgressTitle && title != null) els.autoProgressTitle.textContent = String(title);
  if (els.autoProgressDetail && detail != null) els.autoProgressDetail.textContent = String(detail);
  if (els.autoProgressStage && stage != null) els.autoProgressStage.textContent = String(stage);
  if (!autoState.active) showAutoProgress();
}

function scheduleAutoProgressHide(delay = 900) {
  if (autoState.hideTimer) clearTimeout(autoState.hideTimer);
  autoState.hideTimer = setTimeout(() => {
    hideAutoProgress();
  }, Math.max(0, Number(delay) || 0));
}

async function setBridgeActivity(state, payload = {}) {
  if (!window.LibraryJSServerProxy?.setActivity) return;
  try {
    await window.LibraryJSServerProxy.setActivity({
      state,
      ...payload
    });
  } catch {
    // Ignore bridge failures; the page UI still carries the status.
  }
}

function parseMusicStorageUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/libraryjs.html";
    }
    return {
      host: `${url.protocol}//${url.hostname}`,
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
      path: `${url.pathname || "/libraryjs.html"}${url.search || ""}${url.hash || ""}` || "/libraryjs.html",
      url: url.href
    };
  } catch {
    return null;
  }
}

function buildMusicStorageUrl(host, port, path) {
  const hostValue = String(host || "").trim();
  const portValue = String(port || "").trim();
  const pathValue = String(path || "/libraryjs.html").trim() || "/libraryjs.html";
  let baseUrl;
  if (!hostValue) return "";
  try {
    baseUrl = new URL(/^https?:\/\//i.test(hostValue) ? hostValue : `http://${hostValue}`);
  } catch {
    return "";
  }
  if (portValue) baseUrl.port = portValue;
  const url = new URL(pathValue.startsWith("/") ? pathValue : `/${pathValue}`, baseUrl.href.endsWith("/") ? baseUrl.href : `${baseUrl.href}/`);
  return url.href;
}

function extractPortFromUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

function normalizeLoadedSettings(raw = {}) {
  const next = { ...raw };
  const storageUrl = String(next.musicStorageUrl || next.storageUrl || "").trim();
  const parsed = storageUrl ? parseMusicStorageUrl(storageUrl) : null;

  if (parsed) {
    next.musicStorageUrl = parsed.url;
    next.host = parsed.host;
    next.port = parsed.port;
    next.path = parsed.path;
    next.libraryJsHost = parsed.host;
    next.libraryJsPort = parsed.port;
    next.libraryJsPath = parsed.path;
  } else {
    next.host = String(next.host || next.libraryJsHost || "").trim();
    next.port = String(next.port || next.libraryJsPort || "").trim();
    next.path = String(next.path || next.libraryJsPath || "/libraryjs.html").trim() || "/libraryjs.html";
    next.libraryJsHost = next.host;
    next.libraryJsPort = next.port;
    next.libraryJsPath = next.path;
    next.musicStorageUrl = buildMusicStorageUrl(next.host, next.port, next.path);
  }

  next.musicProxyUrl = String(next.musicProxyUrl || next.proxyUrl || bridgeSettings.musicProxyUrl || "").trim();
  next.musicProxyPort = String(next.musicProxyPort || next.proxyPort || bridgeSettings.musicProxyPort || extractPortFromUrl(next.musicProxyUrl)).trim();
  bridgeSettings = {
    musicProxyUrl: next.musicProxyUrl,
    musicProxyPort: next.musicProxyPort
  };
  return next;
}

function extractSettingsFromQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = {};
    const storageUrl = params.get("musicStorageUrl") || params.get("storageUrl") || params.get("libraryJsUrl");
    const proxyUrl = params.get("musicProxyUrl") || params.get("proxyUrl");
    const proxyPort = params.get("musicProxyPort") || params.get("proxyPort");
    const legacyHost = params.get("libraryJsHost");
    const legacyPort = params.get("libraryJsPort");
    const legacyPath = params.get("libraryJsPath");
    if (storageUrl) raw.musicStorageUrl = storageUrl;
    if (proxyUrl) raw.musicProxyUrl = proxyUrl;
    if (proxyPort) raw.musicProxyPort = proxyPort;
    if (legacyHost) raw.libraryJsHost = legacyHost;
    if (legacyPort) raw.libraryJsPort = legacyPort;
    if (legacyPath) raw.libraryJsPath = legacyPath;
    return raw;
  } catch {
    return {};
  }
}

async function syncSettingsToBridge(next) {
  if (!window.LibraryJSServerProxy?.updateSettings) return;
  try {
    await window.LibraryJSServerProxy.updateSettings({
      musicStorageUrl: next.musicStorageUrl || buildMusicStorageUrl(next.libraryJsHost, next.libraryJsPort, next.libraryJsPath),
      musicProxyUrl: next.musicProxyUrl || bridgeSettings.musicProxyUrl || "",
      musicProxyPort: next.musicProxyPort || bridgeSettings.musicProxyPort || "",
      libraryJsHost: next.libraryJsHost,
      libraryJsPort: next.libraryJsPort,
      libraryJsPath: next.libraryJsPath
    });
  } catch {
    // ignore sync failures
  }
}

function loadHandoffSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return normalizeLoadedSettings({
      ...parsed,
      ...extractSettingsFromQuery()
    });
  } catch {
    return normalizeLoadedSettings(extractSettingsFromQuery());
  }
}

function saveHandoffSettings() {
  const next = normalizeLoadedSettings({
    libraryJsHost: String(els.libraryJsHost?.value || "").trim(),
    libraryJsPort: String(els.libraryJsPort?.value || "").trim(),
    libraryJsPath: String(els.libraryJsPath?.value || "").trim(),
    musicProxyUrl: String(els.musicProxyUrl?.value || bridgeSettings.musicProxyUrl || "").trim(),
    musicProxyPort: String(els.musicProxyPort?.value || bridgeSettings.musicProxyPort || "").trim()
  });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  currentHandoffSettings = next;
  syncSettingsToBridge(next);
  return next;
}

function openStartupOptionsDialog() {
  if (!els.startupOptionsDialog) return;
  if (typeof els.startupOptionsDialog.showModal === "function") {
    els.startupOptionsDialog.showModal();
    return;
  }
  els.startupOptionsDialog.setAttribute("open", "");
}

function closeStartupOptionsDialog() {
  if (!els.startupOptionsDialog) return;
  if (typeof els.startupOptionsDialog.close === "function") {
    els.startupOptionsDialog.close();
    return;
  }
  els.startupOptionsDialog.removeAttribute("open");
}

function normalizeLibraryJSTarget(settings = currentHandoffSettings || {}) {
  const saved = settings || {};
  const storageUrl = String(saved.musicStorageUrl || "").trim();

  let host = String(els.libraryJsHost?.value || saved.libraryJsHost || saved.host || "").trim();
  let port = String(els.libraryJsPort?.value || saved.libraryJsPort || saved.port || "").trim();
  let path = String(els.libraryJsPath?.value || saved.libraryJsPath || saved.path || "").trim();

  if (!host && storageUrl) {
    try {
      const parsed = new URL(storageUrl);
      host = `${parsed.protocol}//${parsed.hostname}`;
      if (!port) port = parsed.port || "";
      if (!path) path = `${parsed.pathname || "/libraryjs.html"}${parsed.search || ""}${parsed.hash || ""}` || "/libraryjs.html";
    } catch {}
  }

  host = host || saved.libraryJsHost || saved.host || "";
  port = port || saved.libraryJsPort || saved.port || "";
  path = path || saved.libraryJsPath || saved.path || "/libraryjs.html";

  if (!host) return storageUrl || "";

  let baseUrl;
  try {
    baseUrl = new URL(/^https?:\/\//i.test(host) ? host : `http://${host}`);
  } catch {
    return storageUrl || "";
  }
  if (port) baseUrl.port = port;
  const url = new URL(path.startsWith("/") ? path : `/${path}`, baseUrl.href.endsWith("/") ? baseUrl.href : `${baseUrl.href}/`);
  url.searchParams.set("flow", "1");
  if (saved.musicStorageUrl) url.searchParams.set("musicStorageUrl", saved.musicStorageUrl);
  if (saved.libraryJsPort || port) url.searchParams.set("libraryJsPort", saved.libraryJsPort || port);
  if (saved.musicProxyUrl) url.searchParams.set("musicProxyUrl", saved.musicProxyUrl);
  if (saved.musicProxyPort || bridgeSettings.musicProxyPort) {
    url.searchParams.set("musicProxyPort", saved.musicProxyPort || bridgeSettings.musicProxyPort);
  }
  return url.href;
}

function base64ToBytes(base64) {
  const clean = String(base64 || "").trim();
  if (!clean) return new Uint8Array();
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchStreamPayload(stream) {
  if (!stream?.url) throw new Error("No stream URL available");
  const response = await window.LibraryJSServerProxy.request(window.LibraryJSServerProxy.mediaGetRequest(stream.url));
  const body = response?.body;
  if (!response?.ok && response?.status == null) {
    throw new Error("Failed to fetch stream bytes");
  }
  if (response?.bodyEncoding === "base64") {
    return { ...response, bytes: base64ToBytes(body) };
  }
  throw new Error("Stream fetch did not return binary data");
}

async function sendStreamToLibraryJS(stream) {
  await setBridgeActivity("busy", { phase: "Fetching stream bytes", progress: 70, title: "Downloading…" });
  const payload = await fetchStreamPayload(stream);
  const title = getPlayerBody(state.lastPlayerResponse)?.videoDetails?.title || "";
  const targetUrl = normalizeLibraryJSTarget(currentHandoffSettings);
  const fileName = els.fileName.value.trim() || stream.filename || `${safeFileStem(title || "download")}${mediaExtFromMime(stream.mimeType || "")}`;

  setAutoProgress(82, "Opening LibraryJS", "Launching the LibraryJS flow page and preparing the file drop.", "Handoff");
  await setBridgeActivity("busy", { phase: "Opening LibraryJS", progress: 82, title: "Downloading…" });

  const transfer = await window.LibraryJSServerProxy.sendFlowTransfer({
    targetUrl,
    openTarget: true,
    fileName,
    mimeType: stream.mimeType || "application/octet-stream",
    bodyBase64: payload.body,
    title,
    videoId: syncVideoField(),
    streamKind: stream.kind,
    sourceUrl: stream.url
  });
  setLibraryJSStatus(`Opened ${transfer.targetUrl} and queued ${fileName} for the flow page.`, "ok");
  log(`flow transfer queued: ${fileName} -> ${transfer.targetUrl}`);
  return transfer;
}

function openLibraryJSTarget() {
  currentHandoffSettings = loadHandoffSettings();
  const targetUrl = normalizeLibraryJSTarget(currentHandoffSettings);
  if (!targetUrl) {
    setLibraryJSStatus("No LibraryJS storage URL is configured yet.", "err");
    return;
  }
  window.open(targetUrl, "_blank", "noopener");
  setLibraryJSStatus(`Opened ${targetUrl}.`, "ok");
  log(`libraryjs opened: ${targetUrl}`);
}

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  els.logOutput.value = `[${stamp}] ${line}\n${els.logOutput.value}`;
}

function previewRequest(request) {
  els.requestPreview.value = pretty(request);
}

function normalizeResponseBody(response) {
  if (!response) return null;
  if (response.bodyEncoding === "base64") {
    return { ...response, body: `[base64 ${response.body.length} chars]` };
  }
  return response;
}

function normalizeUrlInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  return `https://${raw}`;
}

function syncMediaField() {
  const normalized = normalizeUrlInput(els.mediaUrl.value);
  if (normalized && normalized !== els.mediaUrl.value.trim()) {
    els.mediaUrl.value = normalized;
  }
  return normalized;
}

function extractVideoId(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const v = url.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts.at(-1);
    if (last && /^[A-Za-z0-9_-]{11}$/.test(last)) return last;
  } catch {
    // fall through
  }
  return raw;
}


function extractVideoIdStrict(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const candidates = [
      url.searchParams.get("v"),
      url.pathname.split("/").filter(Boolean).at(-1),
      url.pathname.split("/").filter(Boolean).at(-2)
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (/^[A-Za-z0-9_-]{11}$/.test(candidate)) return candidate;
    }
  } catch {
    // fall through
  }
  return "";
}

function getTaskSourceUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("sourceUrl") || params.get("url") || "";
  } catch {
    return "";
  }
}

function hydrateVideoIdFromTaskUrl() {
  const sourceUrl = getTaskSourceUrl();
  if (!sourceUrl) return;

  const videoId = extractVideoIdStrict(sourceUrl);
  if (!videoId) {
    log(`Task opened with source URL, but no YouTube video ID could be extracted.`);
    return;
  }

  els.videoId.value = videoId;
  setStatus("Loaded video ID from clicked tab.", "ok");
  log(`filled video ID from task source URL: ${videoId}`);
}

function shouldAutoStartTask() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("autostart") === "1";
  } catch {
    return false;
  }
}

async function fetchPlayerAndDownloadSelected() {
  const videoId = syncVideoField();
  if (!videoId) {
    throw new Error("No video ID available to fetch player data.");
  }

  setAutoProgress(8, "Preparing automatic flow", "Building the YouTube player request.", "Step 1 of 4");
  await setBridgeActivity("busy", { phase: "Fetching player", progress: 8, title: "Downloading…" });

  const request = window.LibraryJSServerProxy.youtubePlayerRequest(videoId);
  const response = await sendRequest(request);

  setAutoProgress(32, "Player fetched", "Parsing the streaming formats from YouTube.", "Step 2 of 4");
  await setBridgeActivity("busy", { phase: "Parsing player response", progress: 32, title: "Downloading…" });

  const parsed = parseMaybeJson(response);
  els.jsonOutput.value = pretty(normalizeResponseBody(parsed));
  setStreamsFromPlayerResponse(parsed);

  const selected = getSelectedStream();
  if (!selected?.url) {
    throw new Error("Player response did not expose a downloadable stream.");
  }

  const title = getPlayerBody(parsed)?.videoDetails?.title || "";
  if (title && !els.fileName.value.trim()) {
    els.fileName.value = selected.filename || `${safeFileStem(title)}${mediaExtFromMime(selected.mimeType)}`;
  }

  setAutoProgress(62, "Stream selected", `Downloading ${selected.filename || "the chosen stream"} from the local proxy.`, "Step 3 of 4");
  await setBridgeActivity("busy", { phase: "Downloading stream", progress: 62, title: "Downloading…" });

  await sendStreamToLibraryJS(selected);

  setAutoProgress(100, "Handoff queued", "The LibraryJS page is now receiving the file.", "Step 4 of 4");
  scheduleAutoProgressHide(900);
}

function syncVideoField() {
  const normalized = extractVideoId(els.videoId.value);
  if (normalized && normalized !== els.videoId.value.trim()) {
    els.videoId.value = normalized;
  }
  return normalized;
}

function parseMaybeJson(response) {
  if (!response || typeof response.body !== "string") return response;
  try {
    const parsed = JSON.parse(response.body);
    return {
      ...response,
      body: parsed
    };
  } catch {
    return response;
  }
}

function parseJsonText(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function getPlayerBody(source) {
  if (!source) return null;
  if (source.body && typeof source.body === "object") return source.body;
  if (typeof source === "object" && source.streamingData) return source;
  return null;
}

function extractUrlFromFormat(format) {
  if (!format || typeof format !== "object") return "";

  if (typeof format.url === "string" && format.url.trim()) {
    return format.url.trim();
  }

  const cipher = typeof format.signatureCipher === "string" && format.signatureCipher.trim()
    ? format.signatureCipher.trim()
    : typeof format.cipher === "string" && format.cipher.trim()
      ? format.cipher.trim()
      : "";

  if (!cipher) return "";

  const params = new URLSearchParams(cipher);
  const url = params.get("url");
  return url ? decodeURIComponent(url) : "";
}

function isDirectMediaUrl(url) {
  return typeof url === "string" && /https?:\/\/[^ ]*googlevideo\.com\/videoplayback/i.test(url);
}

function parseMimeType(mimeType) {
  const raw = String(mimeType || "").toLowerCase();
  const [typePart, ...params] = raw.split(";").map((part) => part.trim());
  const [major = "", minor = ""] = typePart.split("/");
  const codecsMatch = raw.match(/codecs="([^"]+)"/i) || raw.match(/codecs=([^;]+)/i);
  const codecs = codecsMatch ? String(codecsMatch[1]).replace(/\"/g, "").split(/\s*,\s*/).filter(Boolean) : [];
  return { raw, major, minor, codecs, params };
}

function mediaExtFromMime(mimeType) {
  const { major, minor } = parseMimeType(mimeType);
  if (major === "audio") {
    if (minor.includes("mp4") || minor.includes("m4a")) return ".m4a";
    if (minor.includes("webm")) return ".webm";
    if (minor.includes("mpeg")) return ".mp3";
    return ".audio";
  }
  if (major === "video") {
    if (minor.includes("mp4")) return ".mp4";
    if (minor.includes("webm")) return ".webm";
    return ".video";
  }
  return ".bin";
}

function safeFileStem(text) {
  return String(text || "download")
    .trim()
    .replace(/[\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 160) || "download";
}

function buildFilename(title, stream) {
  const stem = safeFileStem(title || "download");
  return `${stem}${mediaExtFromMime(stream?.mimeType || "")}`;
}

function streamScore(stream, kind) {
  const bitrate = Number(stream?.bitrate || stream?.averageBitrate || 0);
  const height = Number(stream?.height || 0);
  const width = Number(stream?.width || 0);
  const fps = Number(stream?.fps || 0);
  const qualityRank = {
    tiny: 1,
    small: 2,
    medium: 3,
    large: 4,
    hd720: 5,
    hd1080: 6,
    hd1440: 7,
    hd2160: 8,
    hd2880: 9,
    hd3072: 10,
    hd4320: 11,
    highres: 12
  };
  const qualityLabel = String(stream?.qualityLabel || stream?.quality || "").toLowerCase();
  const qualityScore = qualityRank[qualityLabel] || 0;
  if (kind === "audio") return bitrate * 10 + Number(stream?.audioSampleRate || 0) + qualityScore;
  if (kind === "video") return height * 1_000_000 + width * 1_000 + fps * 10 + bitrate + qualityScore * 100_000;
  return height * 1_000_000 + width * 1_000 + bitrate + qualityScore * 100_000;
}

function describeStream(stream) {
  const mime = String(stream?.mimeType || "unknown");
  const parts = [];
  if (stream?.qualityLabel) parts.push(stream.qualityLabel);
  if (stream?.fps) parts.push(`${stream.fps}fps`);
  if (stream?.bitrate || stream?.averageBitrate) parts.push(`${Math.round((stream.bitrate || stream.averageBitrate) / 1000)}kbps`);
  if (stream?.audioSampleRate) parts.push(`${stream.audioSampleRate}Hz`);
  if (stream?.contentLength) {
    const mb = Number(stream.contentLength) / 1024 / 1024;
    if (Number.isFinite(mb)) parts.push(`${mb.toFixed(mb >= 10 ? 0 : 1)}MB`);
  }
  return `itag ${stream.itag} · ${parts.join(" · ")} · ${mime}`;
}

function streamKind(stream, fromFormats = false) {
  const mime = String(stream?.mimeType || "").toLowerCase();
  const hasVideo = mime.startsWith("video/") || Number(stream?.height || 0) > 0 || Number(stream?.width || 0) > 0;
  const hasAudio = mime.startsWith("audio/") || Number(stream?.audioChannels || 0) > 0 || Number(stream?.audioSampleRate || 0) > 0;
  if (fromFormats || (hasVideo && hasAudio)) return "muxed";
  if (hasAudio && !hasVideo) return "audio";
  if (hasVideo && !hasAudio) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "muxed";
}

function collectStreams(source) {
  const body = getPlayerBody(source);
  const streamingData = body?.streamingData;
  if (!streamingData) {
    return { muxed: [], video: [], audio: [] };
  }

  const grouped = { muxed: [], video: [], audio: [] };
  const title = body?.videoDetails?.title || "";

  for (const [bucket, fromFormats] of [
    ["formats", true],
    ["adaptiveFormats", false]
  ]) {
    for (const item of streamingData[bucket] || []) {
      const url = extractUrlFromFormat(item);
      if (!isDirectMediaUrl(url)) continue;
      const kind = streamKind(item, fromFormats);
      const entry = {
        ...item,
        url,
        kind,
        bucket,
        score: streamScore(item, kind),
        label: describeStream(item),
        filename: buildFilename(title || `itag_${item.itag}`, item)
      };
      if (!grouped[kind]) grouped[kind] = [];
      grouped[kind].push(entry);
    }
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => b.score - a.score);
  }

  return grouped;
}

function getSelectedStreams() {
  return state.streamsByCategory[state.selectedCategory] || [];
}

function selectedIndex() {
  return Math.max(0, Number(els.streamSelect.value || 0));
}

function getSelectedStream() {
  const streams = getSelectedStreams();
  return streams[selectedIndex()] || streams[0] || null;
}

function renderSelectedSummary(stream) {
  if (!stream) {
    els.selectedSummary.value = "No stream selected.";
    return;
  }
  els.selectedSummary.value = [
    `Category: ${stream.kind}`,
    `itag: ${stream.itag}`,
    `label: ${stream.qualityLabel || "n/a"}`,
    `mimeType: ${stream.mimeType || "n/a"}`,
    `bitrate: ${stream.bitrate || stream.averageBitrate || "n/a"}`,
    `url: ${stream.url}`,
    `filename: ${stream.filename}`
  ].join("\n");
}

function syncFieldsFromStream(stream) {
  if (!stream) return;
  els.mediaUrl.value = stream.url;
  if (!els.fileName.value.trim() || /^(video|download)\./i.test(els.fileName.value.trim())) {
    els.fileName.value = stream.filename;
  }
}

function renderStreamOptions(category = state.selectedCategory) {
  state.selectedCategory = category;
  const streams = state.streamsByCategory[category] || [];
  els.streamSelect.innerHTML = "";

  if (!streams.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No streams available yet. Fetch /youtubei/v1/player first.";
    els.streamSelect.appendChild(opt);
    els.streamSelect.disabled = true;
    els.btnUseStream.disabled = true;
    els.btnDownloadSelected.disabled = true;
    if (els.btnSendSelected) els.btnSendSelected.disabled = true;
    renderSelectedSummary(null);
    return;
  }

  els.streamSelect.disabled = false;
  els.btnUseStream.disabled = false;
  els.btnDownloadSelected.disabled = false;
  if (els.btnSendSelected) els.btnSendSelected.disabled = false;

  streams.forEach((stream, index) => {
    const opt = document.createElement("option");
    opt.value = String(index);
    opt.textContent = stream.label;
    els.streamSelect.appendChild(opt);
  });

  els.streamSelect.value = "0";
  const stream = getSelectedStream();
  renderSelectedSummary(stream);
  syncFieldsFromStream(stream);
}

function setStreamsFromPlayerResponse(responseLike) {
  const grouped = collectStreams(responseLike);
  state.lastPlayerResponse = responseLike;
  state.streamsByCategory = grouped;
  renderStreamOptions(els.streamCategory.value || state.selectedCategory);
}

function getLatestPlayerResponseCandidate() {
  const fromLast = getSelectedStream() || null;
  if (fromLast?.url) return fromLast;

  const parsedOutput = parseJsonText(els.jsonOutput.value);
  const grouped = collectStreams(parsedOutput);
  const category = els.streamCategory.value || state.selectedCategory;
  return grouped[category]?.[0] || grouped.muxed?.[0] || grouped.video?.[0] || grouped.audio?.[0] || null;
}

els.videoId.addEventListener("blur", () => {
  syncVideoField();
});

els.mediaUrl.addEventListener("blur", () => {
  syncMediaField();
});

els.streamCategory.addEventListener("change", () => {
  renderStreamOptions(els.streamCategory.value);
});

els.streamSelect.addEventListener("change", () => {
  const stream = getSelectedStream();
  renderSelectedSummary(stream);
});

async function sendRequest(request) {
  if (!window.LibraryJSServerProxy) {
    throw new Error("Extension bridge not found");
  }
  previewRequest(request);
  setStatus("Sending request…");
  const response = await window.LibraryJSServerProxy.request(request);
  return response;
}

async function downloadStream(stream) {
  if (!stream?.url) {
    throw new Error("No stream selected");
  }
  const filename = els.fileName.value.trim() || stream.filename || "download.bin";
  const response = await window.LibraryJSServerProxy.downloadMedia(stream.url, filename);
  log(`download OK: ${response.filename} (id ${response.downloadId}, mode ${response.mode || "unknown"})`);
  setStatus(`download completed (${response.mode || "unknown"})`, "ok");
}

els.btnNext.addEventListener("click", async () => {
  try {
    const videoId = syncVideoField();
    const request = window.LibraryJSServerProxy.youtubeNextRequest(videoId);
    const response = await sendRequest(request);
    const parsed = parseMaybeJson(response);
    els.jsonOutput.value = pretty(normalizeResponseBody(parsed));
    setStatus(`next completed (${response.status} ${response.statusText || ""})`.trim(), "ok");
    log(`next OK for ${videoId} (${response.status} ${response.statusText || ""})`);
  } catch (error) {
    els.jsonOutput.value = "";
    setStatus(error.message || String(error), "err");
    log(`next failed: ${error.message || error}`);
  }
});

els.btnPlayer.addEventListener("click", async () => {
  try {
    const videoId = syncVideoField();
    const request = window.LibraryJSServerProxy.youtubePlayerRequest(videoId);
    const response = await sendRequest(request);
    const parsed = parseMaybeJson(response);
    els.jsonOutput.value = pretty(normalizeResponseBody(parsed));
    setStreamsFromPlayerResponse(parsed);

    const selected = getSelectedStream();
    if (selected) {
      log(`selected stream: itag ${selected.itag} (${selected.mimeType || "unknown"}, ${selected.qualityLabel || "n/a"}, ${selected.kind})`);
      const title = getPlayerBody(parsed)?.videoDetails?.title || "";
      if (title && !els.fileName.value.trim()) {
        els.fileName.value = selected.filename || `${safeFileStem(title)}${mediaExtFromMime(selected.mimeType)}`;
      }
    } else {
      log("player returned, but no direct media URL was found in streamingData.");
    }

    setStatus(`player completed (${response.status} ${response.statusText || ""})`.trim(), "ok");
    log(`player OK for ${videoId} (${response.status} ${response.statusText || ""})`);
  } catch (error) {
    els.jsonOutput.value = "";
    setStatus(error.message || String(error), "err");
    log(`player failed: ${error.message || error}`);
  }
});

els.btnUseStream.addEventListener("click", () => {
  const stream = getSelectedStream();
  if (!stream) {
    setStatus("No stream is selected.", "err");
    return;
  }
  syncFieldsFromStream(stream);
  renderSelectedSummary(stream);
  setStatus(`Using ${stream.kind} stream itag ${stream.itag}.`, "ok");
  log(`filled media box from ${stream.kind} stream (itag ${stream.itag})`);
});

els.btnDownloadSelected.addEventListener("click", async () => {
  try {
    const stream = getSelectedStream();
    if (!stream) throw new Error("No stream selected");
    syncFieldsFromStream(stream);
    await downloadStream(stream);
  } catch (error) {
    setStatus(error.message || String(error), "err");
    log(`selected download failed: ${error.message || error}`);
  }
});

if (els.btnSendSelected) {
  els.btnSendSelected.addEventListener("click", async () => {
    try {
      const stream = getSelectedStream();
      if (!stream) throw new Error("No stream selected");
      syncFieldsFromStream(stream);
      setAutoProgress(65, "Preparing handoff", "Fetching the selected stream and opening LibraryJS.", "Manual handoff");
      await setBridgeActivity("busy", { phase: "Preparing LibraryJS handoff", progress: 65, title: "Downloading…" });
      await sendStreamToLibraryJS(stream);
      setStatus("Stream handed off to LibraryJS.", "ok");
      scheduleAutoProgressHide(900);
    } catch (error) {
      setStatus(error.message || String(error), "err");
      setLibraryJSStatus(error.message || String(error), "err");
      log(`libraryjs transfer failed: ${error.message || error}`);
    }
  });
}

if (els.btnOpenLibraryJS) {
  els.btnOpenLibraryJS.addEventListener("click", () => {
    try {
      openLibraryJSTarget();
      setStatus("LibraryJS flow page opened.", "ok");
    } catch (error) {
      setStatus(error.message || String(error), "err");
      log(`libraryjs open failed: ${error.message || error}`);
    }
  });
}

if (els.btnStartupOptions) {
  els.btnStartupOptions.addEventListener("click", () => {
    openStartupOptionsDialog();
  });
}

els.startupOptionsDialog?.addEventListener("close", () => {
  saveHandoffSettings();
  if (els.libraryJsStatus) {
    els.libraryJsStatus.value = `Target: ${normalizeLibraryJSTarget(currentHandoffSettings)}`;
  }
});

els.btnDownload.addEventListener("click", async () => {
  try {
    let url = syncMediaField();

    if (!isDirectMediaUrl(url)) {
      const candidate = getLatestPlayerResponseCandidate();
      if (candidate?.url) {
        url = candidate.url;
        els.mediaUrl.value = url;
        log(`auto-filled media URL from ${candidate.kind} stream (itag ${candidate.itag})`);
      }
    }

    if (!isDirectMediaUrl(url)) {
      throw new Error("This box needs a direct media URL, not a YouTube watch page.");
    }

    const filename = els.fileName.value.trim() || "download.bin";
    const request = window.LibraryJSServerProxy.mediaGetRequest(url);
    previewRequest(request);
    setStatus("Starting download…");

    const response = await window.LibraryJSServerProxy.downloadMedia(url, filename);
    log(`download OK: ${response.filename} (id ${response.downloadId}, mode ${response.mode || "unknown"})`);
    setStatus(`download completed (${response.mode || "unknown"})`, "ok");
  } catch (error) {
    setStatus(error.message || String(error), "err");
    log(`download failed: ${error.message || error}`);
  }
});

els.btnClear.addEventListener("click", () => {
  els.jsonOutput.value = "";
  els.logOutput.value = "";
  els.requestPreview.value = "";
  hideAutoProgress();
  els.selectedSummary.value = "";
  state.lastPlayerResponse = null;
  state.streamsByCategory = { muxed: [], video: [], audio: [] };
  renderStreamOptions(els.streamCategory.value);
  setStatus("Cleared.");
});

window.addEventListener("load", async () => {
  const saved = loadHandoffSettings();
  currentHandoffSettings = saved;
  if (saved.libraryJsHost && els.libraryJsHost) els.libraryJsHost.value = saved.libraryJsHost;
  if (saved.libraryJsPort && els.libraryJsPort) els.libraryJsPort.value = saved.libraryJsPort;
  if (saved.libraryJsPath && els.libraryJsPath) els.libraryJsPath.value = saved.libraryJsPath;
  bridgeSettings = {
    musicProxyUrl: saved.musicProxyUrl || bridgeSettings.musicProxyUrl || "",
    musicProxyPort: saved.musicProxyPort || bridgeSettings.musicProxyPort || ""
  };
  if (els.musicProxyUrl && bridgeSettings.musicProxyUrl) els.musicProxyUrl.value = bridgeSettings.musicProxyUrl;
  if (els.musicProxyPort && bridgeSettings.musicProxyPort) els.musicProxyPort.value = bridgeSettings.musicProxyPort;

  [els.libraryJsHost, els.libraryJsPort, els.libraryJsPath, els.musicProxyUrl, els.musicProxyPort].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", saveHandoffSettings);
    el.addEventListener("input", () => {
      saveHandoffSettings();
      if (els.libraryJsStatus) {
        els.libraryJsStatus.value = `Target: ${normalizeLibraryJSTarget(currentHandoffSettings)}`;
      }
    });
  });

  if (els.libraryJsStatus) {
    els.libraryJsStatus.value = `Target: ${normalizeLibraryJSTarget(saved)}`;
  }

  await syncSettingsToBridge(saved);
  saveHandoffSettings();

  renderStreamOptions(els.streamCategory.value);
  hydrateVideoIdFromTaskUrl();
  if (window.LibraryJSServerProxy) {
    setStatus("Bridge ready.", "ok");
    previewRequest(window.LibraryJSServerProxy.youtubeNextRequest(syncVideoField()));

    if (shouldAutoStartTask()) {
      showAutoProgress();
      setAutoProgress(0, "Starting automatic flow", "Locking the page while the player and stream are fetched.", "Boot");
      try {
        setStatus("Auto-fetching player…", "ok");
        await fetchPlayerAndDownloadSelected();
        setStatus("Auto-send completed.", "ok");
        log("auto-run finished successfully");
      } catch (error) {
        const message = error?.message || String(error);
        setStatus(message, "err");
        log(`auto-run failed: ${message}`);
        setAutoProgress(100, "Automatic flow failed", message, "Error");
        scheduleAutoProgressHide(2500);
        await setBridgeActivity("idle", { phase: "Idle", title: "LibraryJS Relay" });
        if (message.includes("No video ID available to fetch player data.")) {
          setStatus("No video ID available. Closing this invalid task page…", "err");
          setTimeout(() => {
            try { window.close(); } catch {}
            try { if (!window.closed) window.location.replace("about:blank"); } catch {}
          }, 2000);
        }
      }
    }
  } else {
    setStatus("Bridge missing. Load the extension unpacked and refresh.", "err");
  }
});
