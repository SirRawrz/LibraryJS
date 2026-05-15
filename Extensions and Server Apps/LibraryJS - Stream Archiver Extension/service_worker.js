function clonePartialArchiveWithoutBlobs(partial) {
  if (!partial || typeof partial !== 'object') return null;
  const segmentMeta = Array.isArray(partial.segmentMeta)
    ? partial.segmentMeta.map((seg) => {
        if (!seg || typeof seg !== 'object') return seg;
        const { blob, ...rest } = seg;
        return { ...rest };
      })
    : [];
  const extraFiles = Array.isArray(partial.extraFiles)
    ? partial.extraFiles.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const { blob, ...rest } = item;
        return { ...rest };
      })
    : [];
  return { ...partial, segmentMeta, extraFiles };
}

const PARTIAL_ARCHIVE_CACHE_NAME = 'sfa-partial-archives-v1';
const PARTIAL_ARCHIVE_CACHE_PREFIX = '__sfa_partial_archive__';

const UPLOAD_STAGING_CACHE_NAME = 'sfa-upload-staging-v1';
const UPLOAD_STAGING_CACHE_PREFIX = '__sfa_upload_staging__';

function uploadStagingCacheUrl(key, name) {
  const safeKey = encodeURIComponent(String(key || '').trim());
  const safeName = encodeURIComponent(String(name || '').trim() || 'upload.bin');
  // Cache Storage does not accept chrome-extension:// URLs. Use a synthetic https:// key.
  return `https://sfa-upload-staging.invalid/${UPLOAD_STAGING_CACHE_PREFIX}/${safeKey}/${safeName}`;
}

async function stageUploadBlobForOffscreen(blob, name) {
  const cleanName = String(name || '').trim() || 'upload.bin';
  const tempKey = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cacheUrl = uploadStagingCacheUrl(tempKey, cleanName);
  const payload = blob instanceof Blob ? blob : new Blob([blob || new ArrayBuffer(0)]);
  const cache = await caches.open(UPLOAD_STAGING_CACHE_NAME);
  await cache.put(cacheUrl, new Response(payload, {
    headers: {
      'Content-Type': String(payload.type || 'application/octet-stream'),
      'X-SFA-Upload-Name': cleanName
    }
  }));
  return cacheUrl;
}

async function clearUploadStagingCacheUrl(cacheUrl) {
  const cleanUrl = String(cacheUrl || '').trim();
  if (!cleanUrl) return;
  try {
    const cache = await caches.open(UPLOAD_STAGING_CACHE_NAME);
    await cache.delete(cleanUrl);
  } catch {}
}

function shouldCacheBlob(blob, maxBytes = 32 * 1024 * 1024) {
  const size = blob instanceof Blob
    ? blob.size
    : blob instanceof ArrayBuffer
      ? blob.byteLength
      : ArrayBuffer.isView(blob)
        ? blob.byteLength
        : 0;
  return size > 0 && size <= maxBytes;
}

function partialArchiveCacheUrl(key, name) {
  const safeKey = encodeURIComponent(String(key || '').trim());
  const safeName = encodeURIComponent(String(name || '').trim());
  return chrome.runtime.getURL(`${PARTIAL_ARCHIVE_CACHE_PREFIX}/${safeKey}/${safeName}`);
}

async function putPartialArchiveBlob(key, name, blob) {
  const cleanKey = String(key || '').trim();
  const cleanName = String(name || '').trim();
  if (!cleanKey || !cleanName || !blob) return false;
  if (!shouldCacheBlob(blob, 32 * 1024 * 1024)) return false;
  try {
    const cache = await caches.open(PARTIAL_ARCHIVE_CACHE_NAME);
    await cache.put(
      partialArchiveCacheUrl(cleanKey, cleanName),
      new Response(blob instanceof Blob ? blob : new Blob([blob]), {
        headers: { 'Content-Type': String(blob?.type || 'application/octet-stream') }
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function getPartialArchiveBlobFromCache(key, name) {
  const cleanKey = String(key || '').trim();
  const cleanName = String(name || '').trim();
  if (!cleanKey || !cleanName) return null;
  try {
    const cache = await caches.open(PARTIAL_ARCHIVE_CACHE_NAME);
    const res = await cache.match(partialArchiveCacheUrl(cleanKey, cleanName));
    if (!res) return null;
    const blob = await res.blob();
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

async function clearPartialArchiveBlobCache(hitOrKey) {
  const key = typeof hitOrKey === 'string' ? hitOrKey : partialArchiveKey(hitOrKey);
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return;
  try {
    const cache = await caches.open(PARTIAL_ARCHIVE_CACHE_NAME);
    const requests = await cache.keys();
    await Promise.all(requests.map((request) => {
      try {
        const url = new URL(request.url);
        const marker = `/${PARTIAL_ARCHIVE_CACHE_PREFIX}/${encodeURIComponent(cleanKey)}/`;
        if (url.pathname.includes(marker)) return cache.delete(request);
      } catch {}
      return Promise.resolve(false);
    }));
  } catch {}
}

function syncPartialArchiveBlobCache(key, partial) {
  if (!key) return;
  const blobMap = new Map();
  const remember = (name, blob) => {
    const clean = String(name || '').trim();
    if (!clean || !blob) return;
    blobMap.set(clean, blob);
    void putPartialArchiveBlob(key, clean, blob).catch(() => {});
  };
  for (const seg of Array.isArray(partial?.segmentMeta) ? partial.segmentMeta : []) {
    remember(seg?.localName, seg?.blob || null);
  }
  for (const item of Array.isArray(partial?.extraFiles) ? partial.extraFiles : []) {
    remember(item?.name, item?.blob || null);
  }
  if (blobMap.size) MEMORY.partialArchiveBlobs.set(key, blobMap);
  else MEMORY.partialArchiveBlobs.delete(key);
}

function getPartialArchiveBlob(hit, name) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;

  const fromPartial = (partial) => {
    const segments = Array.isArray(partial?.segmentMeta) ? partial.segmentMeta : [];
    for (const seg of segments) {
      if (String(seg?.localName || '').trim() !== cleanName) continue;
      if (seg?.blob) return seg.blob;
    }
    for (const item of Array.isArray(partial?.extraFiles) ? partial.extraFiles : []) {
      if (String(item?.name || '').trim() !== cleanName) continue;
      if (item?.blob) return item.blob;
    }
    return null;
  };

  const directPartial = hit && hit.partialArchive && typeof hit.partialArchive === 'object' ? fromPartial(hit.partialArchive) : null;
  if (directPartial) return directPartial;

  const key = partialArchiveKey(hit);
  if (!key) return null;
  const blobMap = MEMORY.partialArchiveBlobs.get(key);
  if (blobMap && blobMap.has(cleanName)) return blobMap.get(cleanName) || null;
  const cachedPartial = MEMORY.partialArchives.get(key);
  const cached = fromPartial(cachedPartial);
  if (cached) return cached;
  return null;
}

async function loadPartialArchiveBlob(hit, name) {
  const direct = getPartialArchiveBlob(hit, name);
  if (direct) return direct;
  const key = partialArchiveKey(hit);
  if (!key) return null;
  return await getPartialArchiveBlobFromCache(key, name);
}

function storePartialArchiveState(hit, partial) {
  const key = partialArchiveKey(hit);
  if (!hit || !key) return partial || null;
  if (partial && typeof partial === 'object') {
    const sanitized = clonePartialArchiveWithoutBlobs(partial);
    hit.partialArchive = sanitized;
    MEMORY.partialArchives.set(key, sanitized);
    syncPartialArchiveBlobCache(key, partial);
    return sanitized;
  }
  delete hit.partialArchive;
  MEMORY.partialArchives.delete(key);
  MEMORY.partialArchiveBlobs.delete(key);
  void clearPartialArchiveBlobCache(key).catch(() => {});
  return null;
}
const DEFAULT_SETTINGS = {
  configBaseUrl: '',
  archiveFolder: '/videodownloader/',
  autoArchive: false,
  saveSegments: true,
  captureDirectMedia: true,
  captureSubtitleFiles: true,
  captureTextDownloads: false,
  ignoreGifTxtDownloads: true,
  mediabunnyBaseUrl: '',
  perItemDelayMs: 0,
  reserveBufferOverestimationPercent: 15
};

const STATE_KEYS = {
  settings: 'sfa_settings',
  hits: 'sfa_hits',
  config: 'sfa_config'
};

const ARCHIVE_TUNING = {
  perItemDelayMs: 600,
  segmentFetchConcurrency: 48,
  segmentFetchBatchSize: 0,
  segmentFetchTimeoutMs: 20000,
  retryDelaysMs: [0, 900, 1800, 3600]
};

const MEMORY = {
  settings: { ...DEFAULT_SETTINGS },
  config: { platform: 'windows', serverOrigin: '', uploadBase: '', fetchedAt: 0 },
  hits: [],
  hitMap: new Map(),
  requestHeaders: new Map(),
  tabPageUrlByTabId: new Map(),
  tabSessionByTabId: new Map(),
  tabMonitoringByTabId: new Map(),
  injectQueue: new Set(),
  mediabunny: { module: null, loading: null, baseUrl: '' },
  partialArchives: new Map(),
  partialArchiveBlobs: new Map(),
  archiveAbortControllers: new Map(),
  activeArchiveSignal: null,
  activeArchiveHitKey: '',
  initialised: false
};

function nowIsoStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function safeText(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getPerItemDelayMs() {
  return Math.max(0, Number(MEMORY.settings.perItemDelayMs ?? 0) || 0);
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatRate(bytesPerSec) {
  const n = Math.max(0, Number(bytesPerSec) || 0);
  if (!n) return '0 KB/s';
  return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB/s`;
}

const DIRECT_MEDIA_PROGRESS_CHUNK_BYTES = 1024 * 1024;

function buildPseudoSegmentProgress(loadedBytes, totalBytes, chunkBytes = DIRECT_MEDIA_PROGRESS_CHUNK_BYTES) {
  const loaded = Math.max(0, Number(loadedBytes) || 0);
  const total = Math.max(0, Number(totalBytes) || 0);
  const chunk = Math.max(64 * 1024, Number(chunkBytes) || DIRECT_MEDIA_PROGRESS_CHUNK_BYTES);

  // Prefer a known total, but keep a stable minimum so the UI can animate.
  const effectiveTotal = total > 0 ? total : Math.max(loaded, chunk);
  const pseudoTotal = Math.max(1, Math.ceil(effectiveTotal / chunk));
  const clampedLoaded = Math.min(loaded, effectiveTotal);
  const currentIndex = Math.min(pseudoTotal, Math.max(1, Math.floor(clampedLoaded / chunk) + 1));
  const completedBytesBeforeCurrent = (currentIndex - 1) * chunk;
  const bytesIntoCurrent = Math.max(0, clampedLoaded - completedBytesBeforeCurrent);
  const lastChunkBytes = Math.max(1, effectiveTotal - ((pseudoTotal - 1) * chunk));
  const currentChunkTotal = currentIndex < pseudoTotal ? chunk : lastChunkBytes;
  const currentPct = Math.min(100, Math.max(0, (bytesIntoCurrent / currentChunkTotal) * 100));
  const segmentDone = Math.min(pseudoTotal, (currentIndex - 1) + (currentPct / 100));

  return {
    segmentDone,
    segmentTotal: pseudoTotal,
    currentIndex,
    currentTotal: pseudoTotal,
    currentBytes: clampedLoaded,
    currentBytesTotal: currentChunkTotal,
    currentPct,
    currentLabel: `${formatBytes(clampedLoaded)} / ${formatBytes(effectiveTotal)}`
  };
}

async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await workerFn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Number(limit) || 1) },
    () => runner()
  );

  await Promise.all(workers);
  return results;
}

function setTabMonitoringState(tabId, visible) {
  if (!Number.isFinite(Number(tabId))) return;
  MEMORY.tabMonitoringByTabId.set(Number(tabId), !!visible);
}

function isTabMonitoringEnabled(tabId) {
  if (!Number.isFinite(Number(tabId))) return false;
  return MEMORY.tabMonitoringByTabId.get(Number(tabId)) !== false;
}

function clearTabState(tabId) {
  if (!Number.isFinite(Number(tabId))) return;
  const id = Number(tabId);
  MEMORY.tabPageUrlByTabId.delete(id);
  MEMORY.tabSessionByTabId.delete(id);
  MEMORY.tabMonitoringByTabId.delete(id);
}

function shouldKeepActiveHit(hit) {
  const status = String(hit?.status || '').toLowerCase();
  if (status === 'cancelled') return false;
  if (hit?.retainOnClear) return true;
  if (['queued', 'archiving', 'downloading', 'pending', 'retrying', 'failed', 'partial', 'missing'].includes(status)) return true;
  const missingCount = Number(hit?.missingSegmentCount || 0);
  const missingUrls = Array.isArray(hit?.missingSegmentUrls) ? hit.missingSegmentUrls.filter(Boolean) : [];
  return missingCount > 0 || missingUrls.length > 0;
}

function shouldKeepHitDuringMassClear(hit) {
  const status = String(hit?.status || '').toLowerCase();
  if (status === 'cancelled') return false;
  if (hit?.retainOnClear) return true;
  if (['queued', 'downloading', 'remuxing', 'archiving', 'pending', 'retrying', 'failed', 'partial', 'missing'].includes(status)) return true;
  const missingCount = Number(hit?.missingSegmentCount || 0);
  const missingUrls = Array.isArray(hit?.missingSegmentUrls) ? hit.missingSegmentUrls.filter(Boolean) : [];
  return missingCount > 0 || missingUrls.length > 0;
}

function clearHitsForTab(tabId, options = {}) {
  if (!Number.isFinite(Number(tabId))) return 0;
  const id = Number(tabId);
  const keepActive = options.keepActive !== false;
  const before = MEMORY.hits.length;
  MEMORY.hits = MEMORY.hits.filter(hit => {
    if (Number(hit?.tabId || -1) !== id) return true;
    return keepActive && shouldKeepActiveHit(hit);
  });
  MEMORY.hitMap = new Map(MEMORY.hits.filter(h => h && h.key).map(h => [h.key, h]));
  return before - MEMORY.hits.length;
}

function archiveHitKey(hit) {
  return String(hit?.id || hit?.key || '').trim();
}

function getActiveArchiveSignal(hit) {
  const key = archiveHitKey(hit);
  if (key && MEMORY.archiveAbortControllers.has(key)) {
    const ctrl = MEMORY.archiveAbortControllers.get(key);
    if (ctrl && ctrl.signal) return ctrl.signal;
  }
  return null;
}

function beginArchiveCancellation(hit) {
  const key = archiveHitKey(hit);
  if (!key) return null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (controller) MEMORY.archiveAbortControllers.set(key, controller);
  return controller;
}

function endArchiveCancellation(hit) {
  const key = archiveHitKey(hit);
  if (key && MEMORY.archiveAbortControllers.has(key)) {
    MEMORY.archiveAbortControllers.delete(key);
  }
}

function cancelArchiveHit(hit) {
  const key = archiveHitKey(hit);
  const ctrl = key ? MEMORY.archiveAbortControllers.get(key) : null;
  if (ctrl) {
    try { ctrl.abort(); } catch {}
  }
  if (hit && typeof hit === 'object') {
    hit.status = 'cancelled';
    hit.error = 'Cancelled';
    hit.progressLabel = 'Cancelled';
  }
}


function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || !base64) return new ArrayBuffer(0);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bytesToBase64(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return '';
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

const REMUX_MESSAGE_CHUNK_BYTES = 8 * 1024 * 1024;

function bufferFromView(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function normalizeBinarySource(value) {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return bufferFromView(value);
  return value;
}

async function* binaryChunks(value, chunkSize = REMUX_MESSAGE_CHUNK_BYTES) {
  const source = normalizeBinarySource(value);
  if (!source) return;

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    for (let offset = 0; offset < source.size; offset += chunkSize) {
      yield await source.slice(offset, offset + chunkSize).arrayBuffer();
    }
    return;
  }

  if (source instanceof ArrayBuffer) {
    for (let offset = 0; offset < source.byteLength; offset += chunkSize) {
      yield source.slice(offset, offset + chunkSize);
    }
    return;
  }

  if (typeof source.arrayBuffer === 'function') {
    const ab = await source.arrayBuffer();
    if (ab instanceof ArrayBuffer) {
      for (let offset = 0; offset < ab.byteLength; offset += chunkSize) {
        yield ab.slice(offset, offset + chunkSize);
      }
    }
  }
}

function scheduleRemuxStatus(hit, label) {
  if (!hit) return;
  if (!label) return;
  hit.progressLabel = label;
  void scheduleHitPersistence(false);
  scheduleBadgeUpdate(150);
}


async function yieldToEventLoop() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }
        resolve(resp);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function retryableFetchError(err) {
  const msg = String(err?.message || err || '');
  return err?.name === 'AbortError'
    || /HTTP\s+(?:429|5\d\d|403|408|425|429|500|502|503|504)|failed to fetch|networkerror|network error|timeout|aborted/i.test(msg);
}

async function fetchWithRetry(url, opts = {}, kind = 'text', label = 'resource') {
  let lastErr = null;
  for (let attempt = 0; attempt < ARCHIVE_TUNING.retryDelaysMs.length; attempt++) {
    const waitMs = ARCHIVE_TUNING.retryDelaysMs[attempt];
    if (attempt > 0 && waitMs) await sleep(waitMs);
    try {
      const init = { cache: 'no-store', credentials: 'include' };
      const signal = opts.signal || opts.archiveSignal || null;
      if (signal) init.signal = signal;
      if (opts.referrer) init.referrer = opts.referrer;
      if (opts.headers && Object.keys(opts.headers).length) init.headers = opts.headers;
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return kind === 'blob' ? await res.blob() : await res.text();
    } catch (err) {
      lastErr = err;
      if (!retryableFetchError(err)) throw err;
      if (attempt === ARCHIVE_TUNING.retryDelaysMs.length - 1) break;
    }
  }
  throw lastErr || new Error(`Could not fetch ${label}`);
}

function ensureSlash(v, prefix = true, suffix = true) {
  let s = safeText(v, '').trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  if (prefix && !s.startsWith('/')) s = '/' + s;
  if (suffix && !s.endsWith('/')) s += '/';
  return s;
}

function joinUrl(base, path) {
  const cleanBase = safeText(base, '').replace(/\/+$/, '');
  const cleanPath = safeText(path, '').replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
}

function joinPath(...parts) {
  return parts
    .map(p => safeText(p, '').replace(/\\/g, '/').trim())
    .filter(Boolean)
    .map((p, idx) => idx === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))
    .join('/')
    .replace(/\/+/g, '/');
}

function normalizeServerOrigin(raw) {
  const txt = safeText(raw, '').trim();
  if (!txt) return '';
  try {
    if (/^https?:\/\//i.test(txt)) return new URL(txt).origin;
    if (/^[^\s/]+:\d+$/.test(txt) || /^[^\s/]+$/.test(txt)) return new URL(`http://${txt}`).origin;
    return new URL(txt).origin;
  } catch {
    return '';
  }
}

function normalizeMediabunnyBaseUrl(raw) {
  const txt = safeText(raw, '').trim();
  if (!txt) return '';
  try {
    return ensureSlash(new URL(txt).toString(), true, true);
  } catch {
    return '';
  }
}

function normalizeArchiveFolder(raw) {
  let txt = safeText(raw, '').trim();
  if (!txt) return '/videodownloader/';
  txt = txt.replace(/\\/g, '/');
  if (/^https?:\/\//i.test(txt)) {
    try { txt = new URL(txt).pathname || '/videodownloader/'; } catch {}
  }
  if (!txt.startsWith('/')) txt = '/' + txt;
  if (!txt.endsWith('/')) txt += '/';
  return txt;
}

function serverInternalBases() {
  const serverOrigin = safeText(MEMORY.config?.serverOrigin || '', '').trim();
  const archiveFolder = normalizeArchiveFolder(MEMORY.config?.archiveFolder || '/videodownloader/');
  const uploadBase = safeText(MEMORY.config?.uploadBase || '', '').trim();
  return { serverOrigin, archiveFolder, uploadBase };
}

function isArchiveServerUrl(url) {
  try {
    const { serverOrigin, uploadBase } = serverInternalBases();
    if (!serverOrigin && !uploadBase) return false;
    const u = new URL(url);
    if (u.protocol === 'chrome-extension:') return true;
    if (uploadBase) {
      const full = u.toString().toLowerCase();
      const base = ensureSlash(uploadBase, true, true).toLowerCase();
      if (full.startsWith(base)) return true;
    }
    if (serverOrigin) {
      const server = new URL(serverOrigin);
      // Match only the exact configured server origin so unrelated same-host
      // streams on other ports or paths do not get swept up.
      if (u.origin === server.origin) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sanitizeSegment(name) {
  return safeText(name, 'file')
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
}

function filenameFromUrl(url, fallback = 'file.bin') {
  try {
    const u = new URL(url, 'http://x/');
    const last = decodeURIComponent((u.pathname.split('/').pop() || '').trim());
    return sanitizeSegment(last || fallback);
  } catch {
    return sanitizeSegment(fallback);
  }
}

function archiveBaseName(hit, preferred = '') {
  const raw = safeText(preferred, '').trim()
    || safeText(hit?.archiveName, '').trim()
    || safeText(hit?.title, '').trim()
    || filenameFromUrl(hit?.url || '', 'archive');
  return sanitizeSegment(raw.replace(/\.(?:mp4|ts|mkv|mov|webm|m4v)$/i, '')) || 'archive';
}

function archiveOutputName(hit, preferred = '') {
  return `${archiveBaseName(hit, preferred)}.mp4`;
}

function extFromUrl(url, contentType = '') {
  const urlName = filenameFromUrl(url, 'x.bin');
  const m = urlName.match(/(\.[a-z0-9]{1,6})$/i);
  if (m) return m[1].toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('mpegurl')) return '.m3u8';
  if (ct.includes('mp2t')) return '.ts';
  if (ct.includes('mp4')) return '.mp4';
  if (ct.includes('webm')) return '.webm';
  if (ct.includes('aac')) return '.aac';
  if (ct.includes('m4s')) return '.m4s';
  if (ct.includes('cmfv')) return '.cmfv';
  if (ct.includes('cmfa')) return '.cmfa';
  return '.bin';
}

function subtitleExtFromUrl(url, contentType = '') {
  const name = filenameFromUrl(url, 'subtitle.vtt');
  const m = name.match(/(\.[a-z0-9]{1,6})$/i);
  if (m) {
    const ext = m[1].toLowerCase();
    if (ext === '.srt' || ext === '.vtt' || ext === '.ttml' || ext === '.dfxp' || ext === '.sbv' || ext === '.sub') return ext;
  }
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('subrip')) return '.srt';
  if (ct.includes('webvtt')) return '.vtt';
  if (ct.includes('ttml') || ct.includes('dfxp')) return '.ttml';
  if (ct.includes('sbv')) return '.sbv';
  return '.vtt';
}

function looksLikeSubtitleUrl(url = '', contentType = '', contentDisposition = '') {
  const u = String(url || '');
  const ct = String(contentType || '').toLowerCase();
  const cd = String(contentDisposition || '').toLowerCase();
  const name = `${filenameFromUrl(u, '')} ${cd}`.toLowerCase();
  if (/(?:\.(?:vtt|srt|sbv|ttml|dfxp|sub))(?:$|[?#])/i.test(u)) return true;
  if (/\b(?:vtt|webvtt|subrip|x-subrip|ttml|dfxp|sbv)\b/i.test(ct)) return true;
  if (/\b(?:vtt|srt|sbv|ttml|dfxp|sub)\b/i.test(name)) return true;
  return false;
}

function looksLikeHlsSubtitleNoise(url = '', contentType = '', contentDisposition = '') {
  const u = String(url || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const cd = String(contentDisposition || '').toLowerCase();
  const name = `${filenameFromUrl(u, '')} ${cd}`.toLowerCase();
  if (/\/hls\//.test(u)) return true;
  if (/\b(?:m3u8?|mpegurl|playlist|manifest|master|index)\b/.test(u) || /\b(?:m3u8?|mpegurl|playlist|manifest|master|index)\b/.test(ct)) return true;
  if (/\b(?:segment|seg\d*|chunk|part|frag|fragment)\b/.test(u) && /\.(?:vtt|srt|sbv|ttml|dfxp|sub)(?:$|[?#])/i.test(u)) return true;
  if (/\b(?:segment|seg\d*|chunk|part|frag|fragment)\b/.test(name)) return true;
  return false;
}

function looksLikeTextDownloadUrl(url = '', contentType = '', contentDisposition = '') {
  const u = String(url || '');
  const ct = String(contentType || '').toLowerCase();
  const cd = String(contentDisposition || '').toLowerCase();
  const name = `${filenameFromUrl(u, '')} ${cd}`.toLowerCase();
  if (/\.(?:html?|txt|md|json|xml)(?:$|[?#])/i.test(u)) return true;
  if (/\btext\/(?:plain|html|markdown|csv)|application\/(?:json|xml)/i.test(ct)) return true;
  if (/\b(?:html?|txt|json|xml|csv|md)\b/i.test(name)) return true;
  return false;
}

function looksLikeGifDownloadUrl(url = '', contentType = '', contentDisposition = '') {
  const u = String(url || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const cd = String(contentDisposition || '').toLowerCase();
  const name = `${filenameFromUrl(u, '')} ${cd}`.toLowerCase();
  if (/\.(?:gif)(?:$|[?#])/i.test(u)) return true;
  if (/^image\/gif\b/i.test(ct)) return true;
  if (/\bgif\b/i.test(name)) return true;
  return false;
}

function looksLikeTxtDownloadUrl(url = '', contentType = '', contentDisposition = '') {
  const u = String(url || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const cd = String(contentDisposition || '').toLowerCase();
  const name = `${filenameFromUrl(u, '')} ${cd}`.toLowerCase();
  if (/\.(?:txt)(?:$|[?#])/i.test(u)) return true;
  if (/^text\/plain\b/i.test(ct)) return true;
  if (/\btxt\b/i.test(name)) return true;
  return false;
}

function subtitleCueLooksReadable(text = '') {
  const body = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim();
  if (!body) return false;

  const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.some(line => /-->/.test(line))) return false;

  const sample = body.slice(0, 4000);
  const printableChars = sample.replace(/[^\t\n\r\x20-\x7E\u00A0-\u024F]/g, '').length;
  const printableRatio = printableChars / Math.max(1, sample.length);
  const wordCount = (sample.match(/[A-Za-z]{2,}/g) || []).length;

  return printableRatio >= 0.65 && wordCount >= 2;
}

function isProbablyEnglishSubtitle(meta = {}, text = '') {
  const lang = String(meta.subtitleLang || meta.srclang || meta.language || '').trim().toLowerCase();
  const label = String(meta.subtitleLabel || meta.label || '').trim().toLowerCase();
  const url = String(meta.url || '').trim().toLowerCase();
  const sourceUrl = String(meta.sourceUrl || '').trim().toLowerCase();
  const textSample = String(text || '').replace(/\s+/g, ' ').toLowerCase().slice(0, 2500);

  if (!subtitleCueLooksReadable(textSample)) return false;
  if (/^(?:en|eng|en-us|en-gb|en-ca|en-au)$/i.test(lang)) return true;
  if (/\b(?:english|eng|cc|captions|subtitles?)\b/i.test(label)) return true;
  if (/\b(?:english|eng|en-us|en-gb|caption|subtitle|subtitles?)\b/i.test(url)) return true;
  if (/\b(?:english|eng|en-us|en-gb|caption|subtitle|subtitles?)\b/i.test(sourceUrl)) return true;
  if (meta.subtitleDefault === true) return true;
  if (!textSample) return false;

  const commonWords = [' the ', ' and ', ' to ', ' of ', ' in ', ' is ', ' it ', ' you ', ' that ', ' a ', ' for ', ' with ', ' on ', ' this ', ' be ', ' are ', ' as ', ' have ', ' not '];
  let score = 0;
  for (const word of commonWords) {
    if (textSample.includes(word)) score += 1;
  }
  const asciiRatio = textSample.split('').reduce((acc, ch) => acc + (ch.charCodeAt(0) < 128 ? 1 : 0), 0) / Math.max(1, textSample.length);
  return score >= 2 || asciiRatio > 0.92;
}

function srtToVtt(srtText = '') {
  const body = String(srtText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim();
  if (!body) return 'WEBVTT\n';
  const lines = body.split('\n');
  const out = ['WEBVTT', ''];
  for (const line of lines) {
    if (/^\d+$/.test(line.trim())) continue;
    if (/-->/i.test(line)) {
      out.push(line.replace(/,/g, '.'));
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function normalizeSubtitleName(name = '', fallback = 'subtitle') {
  const raw = sanitizeSegment(String(name || '').replace(/\.(?:vtt|srt|sbv|ttml|dfxp|sub)$/i, '')) || fallback;
  return raw;
}

const SUBTITLE_LANGUAGE_NAMES = {
  en: 'English', eng: 'English', enus: 'English', engb: 'English', enca: 'English', enau: 'English',
  es: 'Spanish', spa: 'Spanish', fr: 'French', fra: 'French', fre: 'French',
  de: 'German', deu: 'German', ger: 'German', it: 'Italian', ita: 'Italian',
  pt: 'Portuguese', por: 'Portuguese', ptbr: 'Portuguese', nl: 'Dutch', nld: 'Dutch', dut: 'Dutch',
  ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', zho: 'Chinese', chi: 'Chinese',
  zhcn: 'Chinese', zhhans: 'Chinese', zhtw: 'Chinese', zhhant: 'Chinese', ru: 'Russian', rus: 'Russian',
  ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi', tr: 'Turkish', tur: 'Turkish',
  pl: 'Polish', pol: 'Polish', sv: 'Swedish', swe: 'Swedish', no: 'Norwegian', nor: 'Norwegian',
  da: 'Danish', dan: 'Danish', fi: 'Finnish', fin: 'Finnish', cs: 'Czech', cze: 'Czech', ces: 'Czech',
  el: 'Greek', ell: 'Greek', gre: 'Greek', he: 'Hebrew', heb: 'Hebrew', uk: 'Ukrainian', ukr: 'Ukrainian',
  vi: 'Vietnamese', vie: 'Vietnamese', id: 'Indonesian', ind: 'Indonesian', th: 'Thai', tha: 'Thai'
};

function subtitleLanguageName(raw = '') {
  const txt = String(raw || '').trim().toLowerCase();
  if (!txt) return '';
  const cleaned = txt.replace(/[^a-z0-9]/g, '');
  if (SUBTITLE_LANGUAGE_NAMES[cleaned]) return SUBTITLE_LANGUAGE_NAMES[cleaned];
  const compact = txt.replace(/[^a-z]/g, '');
  if (SUBTITLE_LANGUAGE_NAMES[compact]) return SUBTITLE_LANGUAGE_NAMES[compact];
  if (/^en(?:g(?:lish)?)?$/.test(compact)) return 'English';
  if (/^es(?:p(?:anol|añol)?|spanish)?$/.test(compact)) return 'Spanish';
  if (/^fr(?:a?n(?:çais|cais|ch)?|french)?$/.test(compact)) return 'French';
  if (/^de(?:u(?:tsch)?|ger(?:man)?)?$/.test(compact)) return 'German';
  if (/^pt(?:br)?$/.test(compact)) return 'Portuguese';
  if (/^zh(?:hans|hant|cn|tw)?$/.test(compact)) return 'Chinese';
  return sanitizeSegment(txt, 'subtitle');
}

function subtitleDescriptor(hit = {}) {
  const lang = subtitleLanguageName(hit.subtitleLang || hit.srclang || hit.language || '');
  const label = sanitizeSegment(String(hit.subtitleLabel || hit.label || '').trim(), '');
  const kind = String(hit.subtitleKind || hit.kind || '').toLowerCase();
  const kindLabel = kind === 'captions' ? 'Captions' : (kind === 'subtitles' ? 'Subtitles' : 'Subtitles');
  const parts = [];
  if (lang) parts.push(lang);
  if (label && label.toLowerCase() !== lang.toLowerCase()) parts.push(label);
  if (kindLabel && parts.every(p => p.toLowerCase() !== kindLabel.toLowerCase())) parts.push(kindLabel);
  return parts.filter(Boolean).join(' • ') || 'Subtitle';
}

function subtitleShortCode(hit = {}) {
  const raw = String(hit.subtitleLang || hit.srclang || hit.language || '').trim().toLowerCase();
  if (!raw) return '';
  const cleaned = raw.replace(/[^a-z0-9]/g, '');
  const name = subtitleLanguageName(raw);
  if (name && name !== cleaned) {
    const code = cleaned.replace(/^en(?:g(?:lish)?)?$/, 'en');
    if (/^en/.test(code)) return 'en';
    if (/^es/.test(code)) return 'es';
    if (/^fr/.test(code)) return 'fr';
    if (/^de/.test(code)) return 'de';
    if (/^pt/.test(code)) return 'pt';
    if (/^zh/.test(code)) return 'zh';
    return code.slice(0, 8);
  }
  return cleaned.slice(0, 8);
}

function subtitleDisplayBase(hit = {}) {
  const baseSource = hit?.sourceUrl || hit?.url || 'subtitle';
  const filename = filenameFromUrl(baseSource, 'subtitle');
  const safeBase = normalizeSubtitleName(filename, 'subtitle');
  const baseName = safeBase.replace(/\.(?:vtt|srt|sbv|ttml|dfxp|sub)$/i, '');
  const fallback = normalizeSubtitleName(hit?.subtitleLabel || hit?.title || hit?.archiveName || 'subtitle', 'subtitle');
  return baseName || fallback || 'subtitle';
}

function subtitleArchiveBaseName(hit = {}, options = {}) {
  const parentBase = normalizeSubtitleName(options.subtitleBaseName || options.baseName || options.parentBaseName || options.parentTitle || '', '');
  const baseName = parentBase || subtitleDisplayBase(hit);
  const subtitleCount = Number(options.subtitleCount || 0) || 0;
  const subtitleIndex = Number(options.subtitleIndex ?? hit.subtitleTrackIndex ?? 0) || 0;
  const labelSuffix = normalizeSubtitleName(hit?.subtitleLabel || hit?.label || '', '');
  const langSuffix = subtitleShortCode(hit);
  const rawSuffix = labelSuffix || langSuffix || (subtitleIndex > 0 ? `track-${subtitleIndex + 1}` : '');
  const suffix = subtitleCount > 1 ? sanitizeSegment(rawSuffix || `track-${subtitleIndex + 1}`, 'subtitle') : '';
  const combined = suffix ? `${baseName}.${suffix}` : baseName;
  return sanitizeSegment(combined, 'subtitle');
}

function isHlsSegmentUrl(url, contentType = '') {
  return /(?:\.(?:ts|m2ts|m4s))(?:$|[?#])/i.test(url || '') || /(?:mp2t|mpegts)/i.test(contentType || '');
}

function isInternalUrl(url) {
  return isArchiveServerUrl(url);
}

function isInternalHit(hit) {
  if (!hit || typeof hit !== 'object') return false;
  return [
    hit.url,
    hit.pageUrl,
    hit.sourceUrl,
    hit.resolvedUrl,
    hit.documentUrl,
    hit.initiator
  ].some(value => isInternalUrl(value));
}

function purgeInternalHits() {
  const before = MEMORY.hits.length;
  MEMORY.hits = MEMORY.hits.filter(hit => !isInternalHit(hit));
  MEMORY.hitMap = new Map(MEMORY.hits.filter(h => h && h.key).map(h => [h.key, h]));
  return MEMORY.hits.length !== before;
}

function requestHeadersFor(url, { allowRange = false } = {}) {
  const store = MEMORY.requestHeaders instanceof Map ? MEMORY.requestHeaders : null;
  const raw = store ? store.get(url) : null;
  if (!Array.isArray(raw)) return {};
  const out = {};
  for (const h of raw) {
    const name = String(h?.name || '').trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if ([
      'host',
      'content-length',
      'connection',
      'cookie',
      'cookie2',
      'origin',
      'referer',
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'sec-fetch-user',
      'accept-encoding',
      'cache-control',
      'pragma',
      'if-none-match',
      'if-modified-since',
      'if-range',
      'if-match',
      'range'
    ].includes(lower)) continue;
    out[name] = String(h?.value ?? '');
  }
  if (!allowRange) {
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === 'range') delete out[key];
    }
  }
  return out;
}


function requestHeaderValue(url, headerName) {
  const store = MEMORY.requestHeaders instanceof Map ? MEMORY.requestHeaders : null;
  const raw = store ? store.get(url) : null;
  if (!Array.isArray(raw)) return '';
  const needle = String(headerName || '').toLowerCase();
  const found = raw.find(h => String(h?.name || '').toLowerCase() === needle);
  return String(found?.value ?? '');
}

function requestHeaderMap(url) {
  const store = MEMORY.requestHeaders instanceof Map ? MEMORY.requestHeaders : null;
  const raw = store ? store.get(url) : null;
  const out = new Map();
  if (!Array.isArray(raw)) return out;
  for (const h of raw) {
    const name = String(h?.name || '').trim().toLowerCase();
    if (!name) continue;
    out.set(name, String(h?.value ?? ''));
  }
  return out;
}

function contentDispositionFilename(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const m = text.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''));
  } catch {
    return m[1].trim().replace(/^"|"$/g, '');
  }
}

function looksLikeMediaName(text) {
  return /(?:\.(?:mp4|m4v|webm|mov|mkv|flv|aac|mp3|ogg|wav|ts|m2ts|m4s))(?:$|[?#])/i.test(String(text || ''));
}

function looksLikeVideoResponse(url, contentType, contentDisposition, reqHeaders = new Map()) {
  const ct = String(contentType || '').toLowerCase();
  const cd = String(contentDisposition || '').toLowerCase();
  const filename = contentDispositionFilename(contentDisposition);
  const secFetchDest = String(reqHeaders.get('sec-fetch-dest') || '').toLowerCase();
  const accept = String(reqHeaders.get('accept') || '').toLowerCase();
  const urlText = String(url || '');

  if (isHlsSegmentUrl(urlText, ct)) return false;
  if (/^(?:video|audio)\//i.test(ct)) return true;
  if (/application\/(?:mp4|octet-stream|x-iso|vnd\.apple\.mpegurl)|binary\/octet-stream/i.test(ct)) {
    if (looksLikeMediaName(urlText) || looksLikeMediaName(filename) || /video|audio/.test(secFetchDest) || /video\//.test(accept) || /filename=.*\.(?:mp4|m4v|webm|mov|mkv|flv|aac|mp3|ogg|wav)/i.test(cd)) return true;
  }
  if (looksLikeMediaName(urlText) || looksLikeMediaName(filename)) return true;
  if (/(?:video|audio)/i.test(secFetchDest)) return true;
  return false;
}

function qualityLabelFromResolution(resolution) {
  const text = String(resolution || '').trim();
  if (!text) return '';
  const m = text.match(/(?:(\d+)\s*[xX]\s*(\d+))|(?:(\d+)\s*[pP])/);
  if (m) {
    const height = Number(m[2] || m[3] || 0);
    if (height > 0) return `${height}p`;
  }
  return text.toLowerCase();
}

function resolutionFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const m = path.match(/(?:^|\/)(2160|1440|1080|720|480|360)(?:p)?(?:\/|\.|$)/i)
      || path.match(/(?:^|\/)(2160|1440|1080|720|480|360)(?:p)?(?:\.m3u8?|\.m3u)?(?:$|[?#])/i);
    return Number(m?.[1] || 0);
  } catch {
    return 0;
  }
}

function qualityLabelFromPlaylistUrl(url) {
  const h = resolutionFromUrl(url);
  return h > 0 ? `${h}p` : '';
}

function qualityScoreFromText(value, url = '') {
  const text = String(value || '').trim();
  const m = text.match(/(2160|1440|1080|720|480|360|240)\s*p/i)
    || text.match(/(?:^|\D)(2160|1440|1080|720|480|360|240)(?:\D|$)/i)
    || String(url || '').match(/(?:^|\D)(2160|1440|1080|720|480|360|240)(?:p|\D|$)/i);
  return Number(m?.[1] || m?.[2] || 0) || 0;
}

function normalizeQualityChoice(hit, url, label, score = 0) {
  const resolvedScore = Number(score || qualityScoreFromText(label, url) || resolutionFromUrl(url) || 0);
  const resolvedLabel = resolvedScore > 0 ? `${resolvedScore}p` : '0p';
  return {
    id: crypto.randomUUID(),
    url: safeText(url, ''),
    label: resolvedLabel,
    score: resolvedScore,
    playlistType: hit?.playlistType || '',
    segmentCount: Number(hit?.segmentCount || 0),
    sourceHitId: hit?.id || ''
  };
}

function describePlaylist(text, playlistUrl) {
  const parsed = parsePlaylist(text, playlistUrl);
  if (parsed.type === 'master') {
    const chosen = chooseBestVariant(parsed.variants);
    const quality = qualityLabelFromResolution(chosen?.resolution)
      || qualityLabelFromPlaylistUrl(chosen?.uri)
      || qualityLabelFromPlaylistUrl(playlistUrl)
      || (chosen?.bandwidth ? `${Math.round(Number(chosen.bandwidth) / 1000)} kbps` : 'adaptive');
    return {
      playlistType: 'master',
      quality,
      variantCount: parsed.variants.length,
      variants: parsed.variants.map(v => ({
        quality: qualityLabelFromResolution(v.resolution) || qualityLabelFromPlaylistUrl(v.uri) || (v.bandwidth ? `${Math.round(Number(v.bandwidth) / 1000)} kbps` : 'variant'),
        uri: v.uri,
        bandwidth: v.bandwidth || 0,
        resolution: v.resolution || ''
      }))
    };
  }
  return {
    playlistType: 'media',
    quality: qualityLabelFromPlaylistUrl(playlistUrl) || (parsed.segments.length ? 'stream' : 'playlist'),
    segmentCount: parsed.segments.length,
    segments: parsed.segments.length
  };
}

function parseAttributes(attrText) {
  const out = {};
  const text = safeText(attrText, '');
  const re = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let m;
  while ((m = re.exec(text))) {
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    const num = Number(val);
    out[m[1].toUpperCase()] = Number.isFinite(num) && String(num) === val ? num : val;
  }
  return out;
}

function parsePlaylist(text, playlistUrl) {
  const lines = safeText(text, '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const hasMaster = lines.some(line => line.startsWith('#EXT-X-STREAM-INF'));
  if (hasMaster) {
    const variants = [];
    let pending = null;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        continue;
      }
      if (line.startsWith('#')) continue;
      if (pending) {
        variants.push({
          uri: new URL(line, playlistUrl).href,
          bandwidth: Number(pending.BANDWIDTH || 0),
          resolution: pending.RESOLUTION || '',
          quality: qualityLabelFromResolution(pending.RESOLUTION) || (pending.BANDWIDTH ? `${Math.round(Number(pending.BANDWIDTH) / 1000)} kbps` : ''),
          attrs: pending
        });
        pending = null;
      }
    }
    return { type: 'master', variants };
  }

  const segments = [];
  const keys = [];
  const maps = [];
  let pendingInf = null;
  let pendingKey = null;
  let pendingMap = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length);
      const [durationPart, ...titleParts] = rest.split(',');
      pendingInf = { duration: parseFloat(durationPart) || null, title: titleParts.join(',').trim() };
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      pendingKey = attrs.URI ? { ...attrs, uri: new URL(attrs.URI, playlistUrl).href } : { ...attrs };
      keys.push(pendingKey);
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      pendingMap = attrs.URI ? { ...attrs, uri: new URL(attrs.URI, playlistUrl).href } : { ...attrs };
      maps.push(pendingMap);
      continue;
    }
    if (line.startsWith('#')) continue;
    segments.push({
      uri: new URL(line, playlistUrl).href,
      title: pendingInf?.title || '',
      duration: pendingInf?.duration || null,
      key: pendingKey || null,
      map: pendingMap || null
    });
    pendingInf = null;
  }

  return { type: 'media', segments, keys, maps };
}

function chooseBestVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const ranked = [...variants].sort((a, b) => {
    const abw = Number(a.bandwidth || 0);
    const bbw = Number(b.bandwidth || 0);
    if (bbw !== abw) return bbw - abw;
    const ah = Number(String(a.resolution || '').split('x')[1] || 0);
    const bh = Number(String(b.resolution || '').split('x')[1] || 0);
    return bh - ah;
  });
  return ranked[0];
}

function buildArchiveBase(hit) {
  const host = (() => { try { return new URL(hit.pageUrl || hit.sourceUrl || hit.url).hostname; } catch { return 'site'; } })();
  const labelSource = hit?.sourceUrl || hit?.url || 'stream';
  const label = sanitizeSegment(`${nowIsoStamp()}_${host}_${filenameFromUrl(labelSource, 'stream')}`);
  return ensureSlash(joinPath(normalizeArchiveFolder(MEMORY.settings.archiveFolder || '/videodownloader/'), label), true, true);
}

async function storageGet(keys, area = 'local') {
  return await chrome.storage[area].get(keys);
}

async function loadState() {
  const [{ [STATE_KEYS.settings]: settings, [STATE_KEYS.config]: config }, { [STATE_KEYS.hits]: sessionHits }] = await Promise.all([
    storageGet([STATE_KEYS.settings, STATE_KEYS.config], 'local'),
    storageGet([STATE_KEYS.hits], 'session')
  ]);
  MEMORY.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!MEMORY.settings.mediabunnyBaseUrl && typeof MEMORY.settings.mediabunnyBaseUrl === 'string' && MEMORY.settings.mediabunnyBaseUrl) {
    MEMORY.settings.mediabunnyBaseUrl = MEMORY.settings.mediabunnyBaseUrl;
  }
  delete MEMORY.settings.mediabunnyBaseUrl;
  MEMORY.hits = (Array.isArray(sessionHits) ? sessionHits : []).filter(h => !(h && h.kind === 'media' && isHlsSegmentUrl(h.url, h.contentType)));
  MEMORY.hitMap = new Map(MEMORY.hits.map(h => [h.key, h]));
  MEMORY.config = { ...MEMORY.config, ...(config || {}) };
  if (!(MEMORY.requestHeaders instanceof Map)) MEMORY.requestHeaders = new Map();
}

async function saveSettings(patch) {
  MEMORY.settings = { ...MEMORY.settings, ...(patch || {}) };
  MEMORY.settings.perItemDelayMs = Math.max(0, Number(MEMORY.settings.perItemDelayMs ?? 0) || 0);
  MEMORY.settings.captureSubtitleFiles = !!MEMORY.settings.captureSubtitleFiles;
  MEMORY.settings.captureTextDownloads = !!MEMORY.settings.captureTextDownloads;
  MEMORY.settings.ignoreGifTxtDownloads = !!MEMORY.settings.ignoreGifTxtDownloads;
  MEMORY.settings.captureDirectMedia = MEMORY.settings.captureDirectMedia !== false;
  MEMORY.settings.saveSegments = MEMORY.settings.saveSegments !== false;
  MEMORY.settings.autoArchive = !!MEMORY.settings.autoArchive;
  await chrome.storage.local.set({ [STATE_KEYS.settings]: MEMORY.settings });
  await refreshConfig(true);
}

async function saveHits() {
  await chrome.storage.session.set({ [STATE_KEYS.hits]: MEMORY.hits });
}

const HIT_PERSIST_THROTTLE_MS = 2000;
let hitPersistTimer = null;
let hitPersistImmediateQueued = false;

function scheduleHitPersistence(immediate = false) {
  if (immediate) {
    if (hitPersistTimer) {
      clearTimeout(hitPersistTimer);
      hitPersistTimer = null;
    }
    hitPersistImmediateQueued = false;
    return saveHits().catch(() => {}).then(() => updateBadge().catch(() => {}));
  }

  hitPersistImmediateQueued = true;
  if (hitPersistTimer) return Promise.resolve();

  return new Promise((resolve) => {
    hitPersistTimer = setTimeout(async () => {
      hitPersistTimer = null;
      if (!hitPersistImmediateQueued) return resolve();
      hitPersistImmediateQueued = false;
      await saveHits().catch(() => {});
      await updateBadge().catch(() => {});
      resolve();
    }, HIT_PERSIST_THROTTLE_MS);
  });
}

async function saveConfig() {
  await chrome.storage.local.set({ [STATE_KEYS.config]: MEMORY.config });
}

async function fetchText(url, opts = {}) {
  return await fetchWithRetry(url, opts, 'text', 'playlist');
}

async function refreshConfig(force = false) {
  if (!force && MEMORY.config.fetchedAt && Date.now() - MEMORY.config.fetchedAt < 120_000) return MEMORY.config;
  const base = safeText(MEMORY.settings.configBaseUrl, '').trim();
  let platform = 'windows';
  let serverOrigin = '';

  if (base) {
    try {
      const platformTxt = (await fetchText(joinUrl(base, 'platform.txt'))).trim().toLowerCase();
      if (['windows', 'iphones', 'android'].includes(platformTxt)) platform = platformTxt;
    } catch {}

    try {
      const serverip = (await fetchText(joinUrl(base, 'serverip.txt'))).trim();
      serverOrigin = normalizeServerOrigin(serverip);
    } catch {}

    if (!serverOrigin) {
      try {
        serverOrigin = new URL(base).origin;
      } catch {
        serverOrigin = '';
      }
    }
  }

  const archiveFolder = normalizeArchiveFolder(MEMORY.settings.archiveFolder || '/videodownloader/');
  MEMORY.config = {
    platform,
    serverOrigin,
    archiveFolder,
    uploadBase: serverOrigin ? joinUrl(serverOrigin, archiveFolder) : '',
    fetchedAt: Date.now()
  };
  if (purgeInternalHits()) {
    await saveHits();
  }
  await saveConfig();
  return MEMORY.config;
}

function buildUploadPutPath(targetDir, filename) {
  const platform = (MEMORY.config.platform || 'windows').toLowerCase();
  const rawFolder = String(targetDir || '').trim() || '/videodownloader/';
  const serverOrigin = MEMORY.config.serverOrigin || '';

  if (!serverOrigin) throw new Error('Server origin not configured.');

  const isAbsolute = /^https?:\/\//i.test(rawFolder);
  const targetOrigin = isAbsolute ? new URL(rawFolder).origin : serverOrigin;
  const folderPath = isAbsolute ? ensureSlash(new URL(rawFolder).pathname, true, true) : normalizeArchiveFolder(rawFolder);
  const encodedName = encodeURIComponent(filename);
  const putPath = joinUrl(targetOrigin, `${folderPath}${encodedName}`);
  return { platform, targetOrigin, folderPath, putPath };
}

async function uploadViaPut(fullPath, blob, filename = '') {
  const payload = blob instanceof Blob
    ? blob
    : blob instanceof ArrayBuffer
      ? new Blob([blob])
      : ArrayBuffer.isView(blob)
        ? new Blob([blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)])
        : new Blob([blob || new ArrayBuffer(0)]);
  const contentType = String(payload.type || 'application/octet-stream');
  try {
    const res = await fetch(fullPath, {
      method: 'PUT',
      body: payload,
      credentials: 'include',
      headers: { 'Content-Type': contentType },
      signal: MEMORY.activeArchiveSignal || undefined
    });
    if (res.ok) return true;
    return false;
  } catch {
    return false;
  }
}



async function uploadBlob(targetDir, filename, blob) {
  const { putPath } = buildUploadPutPath(targetDir, filename);
  return uploadViaPut(putPath, blob, filename);
}
function serverFileUrl(folder, filename) {
  const rawFolder = String(folder || '').trim() || '/videodownloader/';
  const serverOrigin = MEMORY.config.serverOrigin || '';
  if (!serverOrigin) return '';
  const isAbsolute = /^https?:\/\//i.test(rawFolder);
  const baseOrigin = isAbsolute ? new URL(rawFolder).origin : serverOrigin;
  const folderPath = isAbsolute ? ensureSlash(new URL(rawFolder).pathname, true, true) : normalizeArchiveFolder(rawFolder);
  return joinUrl(baseOrigin, `${folderPath}${encodeURIComponent(filename)}`);
}

async function fetchServerFileBlob(folder, filename) {
  const url = serverFileUrl(folder, filename);
  if (!url) throw new Error('Server file URL unavailable.');
  const res = await fetch(url, { cache: 'no-store', credentials: 'include', signal: MEMORY.activeArchiveSignal || undefined });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${filename}`);
  return await res.blob();
}

async function fetchBlob(url, opts = {}) {
  return await fetchWithRetry(url, opts, 'blob', 'media');
}

async function fetchBlobMeta(url, opts = {}, onProgress = null) {
  return await fetchBlobMetaWithProgress(url, opts, onProgress);
}

async function fetchBlobMetaWithProgress(url, opts = {}, onProgress = null) {
  let lastErr = null;
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs || ARCHIVE_TUNING.segmentFetchTimeoutMs || 20000) || 20000);
  const expectedTotalBytes = Math.max(0, Number(opts.expectedTotalBytes || opts.progressTotalBytes || 0) || 0);
  for (let attempt = 0; attempt < ARCHIVE_TUNING.retryDelaysMs.length; attempt++) {
    const waitMs = ARCHIVE_TUNING.retryDelaysMs[attempt];
    if (attempt > 0 && waitMs) await sleep(waitMs);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => {
      try { controller.abort(); } catch {}
    }, timeoutMs) : null;
    try {
      const init = { cache: 'no-store', credentials: 'include' };
      const signal = opts.signal || opts.archiveSignal || null;
      if (controller && !signal) init.signal = controller.signal;
      else if (signal) init.signal = signal;
      if (opts.referrer) init.referrer = opts.referrer;
      if (opts.headers && Object.keys(opts.headers).length) init.headers = opts.headers;
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const contentType = res.headers.get('content-type') || '';
      const contentLength = Number(res.headers.get('content-length') || 0) || 0;
      if (!res.body || typeof res.body.getReader !== 'function') {
        const blob = await res.blob();
        if (onProgress) onProgress({ loaded: blob.size, total: blob.size || contentLength || expectedTotalBytes || 0, done: true, contentType, speedBps: 0 });
        return {
          blob,
          contentType,
          contentLength: Number(contentLength || blob.size || 0) || 0,
          finalUrl: res.url || url
        };
      }

      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      const start = performance.now();
      let lastTick = start;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const now = performance.now();
        if (!onProgress) continue;
        if (now - lastTick >= 700 || (contentLength && received >= contentLength)) {
          lastTick = now;
          const elapsedSec = Math.max(0.001, (now - start) / 1000);
          const speedBps = received / elapsedSec;
          onProgress({
            loaded: received,
            total: contentLength || expectedTotalBytes || 0,
            done: false,
            contentType,
            speedBps
          });
        }
      }
      const blob = new Blob(chunks, { type: contentType || 'application/octet-stream' });
      if (onProgress) onProgress({ loaded: received, total: contentLength || expectedTotalBytes || received, done: true, contentType, speedBps: 0 });
      return {
        blob,
        contentType,
        contentLength: Number(contentLength || received || 0) || 0,
        finalUrl: res.url || url
      };
    } catch (err) {
      lastErr = err;
      if (!retryableFetchError(err)) throw err;
      if (attempt === ARCHIVE_TUNING.retryDelaysMs.length - 1) break;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`Could not fetch media`);
}

function contentTypeLooksLikeTs(contentType = '') {
  return /(?:video\/mp2t|application\/(?:x-)?mpegurl)/i.test(String(contentType || ''));
}

function contentTypeLooksLikeIso(contentType = '') {
  return /(?:video\/mp4|audio\/mp4|application\/mp4|video\/iso|audio\/iso|application\/octet-stream)/i.test(String(contentType || ''));
}

function bytesToAscii(bytes) {
  return Array.from(bytes || [], b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
}

function blobLooksLikeTs(blob) {
  try {
    if (!blob || blob.size < 188) return false;
    const sampleSize = Math.min(blob.size, 188 * 8);
    return blob.slice(0, sampleSize).arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      const limitPackets = Math.max(1, Math.min(8, Math.floor(bytes.byteLength / 188)));
      for (let offset = 0; offset < 188; offset += 1) {
        let hits = 0;
        let checked = 0;
        for (let i = 0; i < limitPackets; i += 1) {
          const pos = offset + (i * 188);
          if (pos >= bytes.byteLength) break;
          checked += 1;
          if (bytes[pos] === 0x47) hits += 1;
        }
        if (checked >= 2 && hits >= Math.max(2, Math.ceil(checked * 0.75))) {
          return true;
        }
      }
      return false;
    }).catch(() => false);
  } catch {
    return false;
  }
}

async function classifyFetchedBlob(blob, url = '', contentType = '') {
  const type = String(contentType || blob?.type || '').toLowerCase();
  const urlExt = extFromUrl(url, contentType);
  if (contentTypeLooksLikeTs(type)) {
    return { family: 'ts', ext: '.ts', isInit: false };
  }
  if (contentTypeLooksLikeIso(type)) {
    // Some servers label fMP4 as octet-stream; sniff the payload.
    const headBuf = await blob.slice(0, 32).arrayBuffer().catch(() => new ArrayBuffer(0));
    const head = new Uint8Array(headBuf);
    const ascii = bytesToAscii(head);
    const looksIso = ascii.includes('ftyp') || ascii.includes('styp') || ascii.includes('moof') || ascii.includes('mdat') || ascii.includes('sidx');
    if (looksIso) {
      const isInit = ascii.includes('ftyp') || ascii.includes('moov');
      return { family: 'iso', ext: isInit ? '.mp4' : '.m4s', isInit };
    }
  }
  const tsByMagic = await blobLooksLikeTs(blob);
  if (tsByMagic) return { family: 'ts', ext: '.ts', isInit: false };
  return { family: 'unknown', ext: urlExt || '.bin', isInit: false };
}

function normalizeSubtitleGroupUrl(url = '') {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    let path = (u.pathname || '').replace(/\/+$/g, '');
    path = path.replace(/([._-](?:seg|segment|chunk|part|frag)?\d{1,5})(?=\.(?:vtt|srt|sbv|ttml|dfxp|sub)(?:$|[?#]))/i, '');
    path = path.replace(/([._-]\d{1,5})(?=\.(?:vtt|srt|sbv|ttml|dfxp|sub)(?:$|[?#]))/i, '');
    return `${u.origin}|${path.toLowerCase()}`;
  } catch {
    return String(url || '').split('#')[0].split('?')[0].toLowerCase();
  }
}

function normalizePageUrl(url = '') {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return String(url || '').trim();
  }
}


function normalizeStreamFamilyTitle(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\b(?:playlist|master|variant|adaptive|stream|m3u8|m3u3)\b/g, ' ')
    .replace(/\b(?:2160|1440|1080|720|480|360|240)p\b/g, ' ')
    .replace(/\b(?:4k|8k)\b/g, ' ')
    .replace(/^[-_\s.:]+|[-_\s.:]+$/g, '')
    .replace(/\s+/g, ' ');
}

function dedupeKey(hit) {
  if (hit?.kind === 'playlist') return playlistGroupKey(hit);
  if (hit?.kind === 'subtitle') {
    const pageUrl = normalizePageUrl(hit.pageUrl || '');
    return ['subtitle', pageUrl, normalizeSubtitleGroupUrl(hit.url || '')].join('|');
  }
  return [hit.kind || 'unknown', hit.url || ''].join('|');
}

function playlistGroupKey(hit) {
  const page = normalizePageUrl(hit?.pageUrl || '');
  const source = normalizeComparableUrl(hit?.sourceUrl || hit?.url || '');
  const origin = normalizeComparableOrigin(hit?.sourceUrl || hit?.url || '');
  const title = normalizeStreamFamilyTitle(hit?.archiveName || hit?.title || hit?.quality || hit?.playlistType || '');
  const root = page || origin || source || '';
  const fallback = (() => {
    try {
      const u = new URL(hit.url);
      const path = decodeURIComponent((u.pathname || '').replace(/\/+$/g, ''));
      return `${u.origin}|${path.toLowerCase()}`;
    } catch {
      return [hit.kind || 'unknown', hit.url || ''].join('|');
    }
  })();
  return [root, title].filter(Boolean).join('|') || fallback;
}

function playlistStatusRank(status) {
  return ({ archived: 4, archiving: 3, queued: 2, failed: 1, new: 0 })[String(status || '').toLowerCase()] ?? 0;
}

function playlistQualityRank(hit) {
  if (!hit || hit.kind !== 'playlist') return 0;
  const scores = [];
  const maybeNum = (val) => qualityScoreFromText(val, hit.url);
  scores.push(maybeNum(hit.quality));
  scores.push(maybeNum(hit.title));
  scores.push(resolutionFromUrl(hit.url));
  if (Array.isArray(hit.variants)) {
    for (const v of hit.variants) {
      scores.push(maybeNum(v?.quality));
      scores.push(maybeNum(v?.resolution));
      scores.push(resolutionFromUrl(v?.uri));
    }
  }
  return Math.max(0, ...scores.map(n => Number(n) || 0));
}

function uniqueByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const url = safeText(item?.url, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(item);
  }
  return out;
}

function dedupePlaylistHits(hits) {
  const buckets = new Map();
  for (const hit of (Array.isArray(hits) ? hits : [])) {
    if (!hit || hit.kind !== 'playlist') continue;
    const key = playlistGroupKey(hit);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(hit);
  }

  const result = [];
  for (const [key, group] of buckets.entries()) {
    const sorted = [...group].sort((a, b) => {
      const qb = playlistQualityRank(b) - playlistQualityRank(a);
      if (qb) return qb;
      const sb = playlistStatusRank(b.status) - playlistStatusRank(a.status);
      if (sb) return sb;
      return Number(b.lastSeen || b.ts || 0) - Number(a.lastSeen || a.ts || 0);
    });
    const best = { ...sorted[0] };
    best.groupKey = key;
    best.groupSize = group.length;
    best.groupMembers = group.map(h => h.id);

    const qualityOptions = [];
    for (const hit of group) {
      qualityOptions.push(normalizeQualityChoice(hit, hit.url, hit.quality || hit.playlistType || '', playlistQualityRank(hit)));
      if (Array.isArray(hit.variants)) {
        for (const v of hit.variants) {
          qualityOptions.push(normalizeQualityChoice(hit, v?.uri, v?.quality || v?.resolution || '', qualityScoreFromText(v?.quality || v?.resolution || '', v?.uri)));
        }
      }
    }
    best.qualityOptions = uniqueByUrl(qualityOptions)
      .sort((a, b) => (b.score || 0) - (a.score || 0) || a.label.localeCompare(b.label) || a.url.localeCompare(b.url));
    const top = best.qualityOptions[0] || null;
    if (top) {
      best.selectedVariantUrl = top.url;
      best.quality = top.label || best.quality || '0p';
    } else if (!best.quality || best.quality === 'stream' || best.quality === 'adaptive' || best.quality === 'playlist') {
      best.quality = '0p';
    }
    if (!best.title && best.quality) best.title = `${best.quality} playlist`;
    result.push(best);
  }

  return result.sort((a, b) => Number(b.lastSeen || b.ts || 0) - Number(a.lastSeen || a.ts || 0));
}


function dedupeSubtitleHits(hits) {
  const buckets = new Map();
  for (const hit of (Array.isArray(hits) ? hits : [])) {
    if (!hit || String(hit.kind || '').toLowerCase() !== 'subtitle') continue;
    const key = dedupeKey(hit);
    if (!buckets.has(key)) buckets.set(key, { ...hit });
    else {
      const existing = buckets.get(key);
      if (hit.text && !existing.text) existing.text = hit.text;
      if (hit.title && !existing.title) existing.title = hit.title;
      if (hit.subtitleLang && !existing.subtitleLang) existing.subtitleLang = hit.subtitleLang;
      if (hit.subtitleLabel && !existing.subtitleLabel) existing.subtitleLabel = hit.subtitleLabel;
      if (hit.subtitleKind && !existing.subtitleKind) existing.subtitleKind = hit.subtitleKind;
      existing.lastSeen = Math.max(Number(existing.lastSeen || 0), Number(hit.lastSeen || hit.ts || 0), Number(hit.ts || 0));
    }
  }
  return [...buckets.values()].sort((a, b) => Number(b.lastSeen || b.ts || 0) - Number(a.lastSeen || a.ts || 0));
}

function dedupeHitsForDisplay(hits) {
  const all = Array.isArray(hits) ? hits.filter(hit => !isInternalHit(hit)) : [];
  const media = all
    .filter(hit => hit && hit.kind !== 'playlist' && String(hit.kind || '').toLowerCase() !== 'subtitle')
    .sort((a, b) => Number(b.lastSeen || b.ts || 0) - Number(a.lastSeen || a.ts || 0));
  const subtitles = dedupeSubtitleHits(all);
  const playlists = dedupePlaylistHits(all);
  return [...media, ...subtitles, ...playlists];
}

function isMainCardKind(kind) {
  const value = String(kind || '').toLowerCase();
  return value === 'playlist' || value === 'media' || value === 'dom-media';
}

async function enrichPlaylistHit(hit) {
  if (!hit || hit.kind !== 'playlist') return hit;
  if (hit.quality && hit.text) return hit;
  try {
    const text = hit.text || await fetchText(hit.url);
    const meta = describePlaylist(text, hit.url);
    if (text && !hit.text) hit.text = text;
    if (meta?.quality) hit.quality = meta.quality;
    if (meta?.playlistType) hit.playlistType = meta.playlistType;
    if (meta?.variantCount) hit.variantCount = meta.variantCount;
    if (meta?.segmentCount) hit.segmentCount = meta.segmentCount;
    if (Array.isArray(meta?.variants)) hit.variants = meta.variants;
    if (Array.isArray(meta?.variants) && !hit.qualityOptions) hit.qualityOptions = meta.variants.map(v => ({ id: crypto.randomUUID(), url: v.uri, label: v.quality || qualityLabelFromResolution(v.resolution) || '0p', score: qualityScoreFromText(v.quality || v.resolution || '', v.uri) }));
    await saveHits();
    await updateBadge();
  } catch (err) {}
  return hit;
}

async function registerHit(hit) {
  if (!hit || !hit.url) return null;
  if (isInternalHit(hit)) return null;
  const ct = String(hit.contentType || '').toLowerCase();
  const cd = String(hit.contentDisposition || '');
  const url = String(hit.url || '');
  const looksHtmlDownload = /^text\/html/i.test(ct);
  const looksTextDownload = looksLikeTextDownloadUrl(url, ct, cd) || looksHtmlDownload;
  const looksGifDownload = looksLikeGifDownloadUrl(url, ct, cd);
  const looksTxtDownload = looksLikeTxtDownloadUrl(url, ct, cd);
  if (!MEMORY.settings.captureTextDownloads && looksTextDownload && String(hit.kind || '').toLowerCase() !== 'playlist') return null;
  if (MEMORY.settings.ignoreGifTxtDownloads !== false && (looksGifDownload || looksTxtDownload || looksHtmlDownload) && String(hit.kind || '').toLowerCase() !== 'playlist') return null;
  const key = dedupeKey(hit);
  if (MEMORY.hitMap.has(key)) {
    const existing = MEMORY.hitMap.get(key);
    if (hit.text && !existing.text) existing.text = hit.text;
    if (hit.title) existing.title = hit.title;
    if (hit.archiveName) existing.archiveName = hit.archiveName;
    if (hit.pageUrl) existing.pageUrl = hit.pageUrl;
    if (hit.sourceUrl) existing.sourceUrl = hit.sourceUrl;
    if (hit.subtitleLang && !existing.subtitleLang) existing.subtitleLang = hit.subtitleLang;
    if (hit.subtitleLabel && !existing.subtitleLabel) existing.subtitleLabel = hit.subtitleLabel;
    if (hit.subtitleKind && !existing.subtitleKind) existing.subtitleKind = hit.subtitleKind;
    if (typeof hit.subtitleDefault === 'boolean') existing.subtitleDefault = existing.subtitleDefault || hit.subtitleDefault;
    if (typeof hit.subtitleActive === 'boolean') existing.subtitleActive = existing.subtitleActive || hit.subtitleActive;
    existing.lastSeen = Date.now();
    await saveHits();
    await updateBadge();
    return existing;
  }

  const item = {
    id: crypto.randomUUID(),
    key,
    kind: hit.kind || 'unknown',
    url: hit.url,
    sourceUrl: hit.sourceUrl || hit.relatedUrl || '',
    contentType: hit.contentType || '',
    contentDisposition: hit.contentDisposition || '',
    sourceSize: Number(hit.sourceSize || 0),
    pageUrl: hit.pageUrl || '',
    title: hit.kind === 'subtitle' ? subtitleDescriptor(hit) : (hit.archiveName || hit.title || ''),
    tabId: Number(hit.tabId || 0),
    sessionId: Number(hit.sessionId || 0),
    archiveName: hit.archiveName || '',
    ts: hit.ts || Date.now(),
    lastSeen: Date.now(),
    status: 'new',
    text: hit.text || '',
    quality: hit.quality || '',
    playlistType: hit.playlistType || '',
    variantCount: Number(hit.variantCount || 0),
    segmentCount: Number(hit.segmentCount || 0),
    variants: Array.isArray(hit.variants) ? hit.variants : [],
    subtitleLang: hit.subtitleLang || '',
    subtitleLabel: hit.subtitleLabel || '',
    subtitleKind: hit.subtitleKind || '',
    subtitleDefault: !!hit.subtitleDefault,
    subtitleActive: !!hit.subtitleActive,
    subtitleTrackIndex: Number(hit.subtitleTrackIndex || 0),
    archivedFolder: '',
    archivedFiles: [],
    error: ''
  };
  if (!item.title && item.kind === 'playlist' && item.quality) {
    item.title = item.quality === 'adaptive' ? 'Adaptive HLS playlist' : `${item.quality} playlist`;
  }
  MEMORY.hits.unshift(item);
  MEMORY.hitMap.set(key, item);
  await saveHits();
  await updateBadge();
  if (item.kind === 'playlist' && (!item.quality || !item.text)) {
    enrichPlaylistHit(item).catch(() => {});
  }
  return item;
}

function isSubtitleHit(hit) {
  return String(hit?.kind || '').toLowerCase() === 'subtitle';
}

const SUBTITLE_CAPTURE_WINDOW_MS = 5000;

function subtitleFileNameForHit(hit, sourceBlob = null, forceExt = '', options = {}) {
  const ext = '.vtt';
  const baseName = subtitleArchiveBaseName(hit, options);
  return `${baseName}${ext}`;
}

function hitMatchesEnglishSubtitlePolicy(hit, text = '', bypass = false) {
  return true;
}

function collectAssociatedSubtitleHits(primaryHit) {
  const pageUrl = normalizePageUrl(primaryHit?.pageUrl || '');
  if (!pageUrl) return [];
  const primaryTime = Number(primaryHit?.ts || primaryHit?.lastSeen || 0);
  return MEMORY.hits.filter((hit) => {
    if (!hit || !isSubtitleHit(hit)) return false;
    if (String(hit.status || '').toLowerCase() === 'archived') return false;
    if (normalizePageUrl(hit.pageUrl || '') !== pageUrl) return false;
    if (!primaryTime) return true;
    const subtitleTime = Number(hit.ts || hit.lastSeen || 0);
    if (!subtitleTime) return true;
    return Math.abs(primaryTime - subtitleTime) <= SUBTITLE_CAPTURE_WINDOW_MS;
  });
}

function resolveSubtitleTargets(primaryHit, options = {}) {
  const subtitleUrls = Array.isArray(options.subtitleUrls)
    ? options.subtitleUrls.map(v => String(v || '').trim()).filter(Boolean)
    : [];
  const subtitleSet = subtitleUrls.length ? new Set(subtitleUrls) : null;
  const associated = collectAssociatedSubtitleHits(primaryHit);
  const explicit = subtitleSet
    ? MEMORY.hits.filter(hit => isSubtitleHit(hit) && subtitleSet.has(String(hit.url || '').trim()))
    : [];
  const selected = subtitleSet
    ? (explicit.length ? explicit : associated.filter(hit => subtitleSet.has(String(hit.url || '').trim())))
    : associated.filter(hit => hitMatchesEnglishSubtitlePolicy(hit));
  if (selected.length || !subtitleSet) return selected;
  const pageUrl = primaryHit?.pageUrl || primaryHit?.sourceUrl || primaryHit?.url || '';
  const sourceUrl = primaryHit?.sourceUrl || primaryHit?.url || '';
  return subtitleUrls.map((url, index) => ({
    kind: 'subtitle',
    url,
    pageUrl,
    sourceUrl,
    title: primaryHit?.title || '',
    archiveName: primaryHit?.archiveName || primaryHit?.title || '',
    subtitleLabel: primaryHit?.subtitleLabel || primaryHit?.selectedSubtitleTitle || '',
    subtitleLang: primaryHit?.subtitleLang || primaryHit?.language || '',
    subtitleKind: primaryHit?.subtitleKind || '',
    subtitleDefault: index === 0,
    subtitleActive: index === 0,
    contentType: primaryHit?.contentType || '',
    contentDisposition: primaryHit?.contentDisposition || '',
    ts: primaryHit?.ts || Date.now()
  }));
}

function convertSubtitleBlob(blob, sourceExt = '.vtt') {
  if (!blob) return Promise.resolve(new Blob([], { type: 'text/vtt' }));
  const ext = String(sourceExt || '').toLowerCase();
  if (ext !== '.srt') return Promise.resolve(blob instanceof Blob ? blob : new Blob([blob], { type: 'text/vtt' }));
  return blob.text().then((txt) => new Blob([srtToVtt(txt)], { type: 'text/vtt' }));
}

async function prepareSelectedSubtitleArtifacts(primaryHit, options = {}) {
  if (!MEMORY.settings.captureSubtitleFiles) return [];
  const selected = resolveSubtitleTargets(primaryHit, options);
  const baseName = options.subtitleBaseName || options.baseName || primaryHit.archiveName || primaryHit.title || '';
  const artifacts = [];
  for (let i = 0; i < selected.length; i++) {
    const subHit = selected[i];
    const requestedExt = subtitleExtFromUrl(subHit.url || '', subHit.contentType || '');
    try {
      const fetched = await fetchBlobMeta(subHit.url, {
        referrer: subHit.pageUrl || subHit.sourceUrl || subHit.url,
        headers: requestHeadersFor(subHit.url)
      });
      if (!fetched?.blob || fetched.blob.size <= 0) throw new Error('empty subtitle response');
      const contentType = String(fetched.contentType || fetched.blob.type || '').toLowerCase();
      const subtitleText = await fetched.blob.text().catch(() => '');
      if (!hitMatchesEnglishSubtitlePolicy(subHit, subtitleText, !!options.bypassEnglishSubtitleOnly)) {
        continue;
      }
      let subtitleBlob = fetched.blob;
      const sourceLooksSrt = requestedExt === '.srt' || /subrip/i.test(contentType) || /\.(?:srt)(?:$|[?#])/i.test(subHit.url || '');
      if (sourceLooksSrt) subtitleBlob = await convertSubtitleBlob(fetched.blob, '.srt');
      const finalText = await subtitleBlob.text().catch(() => '');
      if (!subtitleCueLooksReadable(finalText)) continue;
      const name = subtitleFileNameForHit(subHit, null, sourceLooksSrt ? '.srt' : '.vtt', {
        ...options,
        baseName,
        subtitleBaseName: baseName,
        subtitleCount: selected.length,
        subtitleIndex: i
      });
      artifacts.push({ hit: subHit, blob: subtitleBlob, name, contentType: String(subtitleBlob.type || contentType || 'text/vtt').toLowerCase() });
    } catch (err) {
      artifacts.push({ hit: subHit, error: String(err?.message || err) });
    }
  }
  return artifacts;
}

async function previewSubtitleHit(hit, options = {}) {
  if (!hit || !hit.url) throw new Error('Subtitle not found');
  const requestedExt = subtitleExtFromUrl(hit.url || '', hit.contentType || '');
  const fetched = await fetchBlobMeta(hit.url, {
    referrer: hit.pageUrl || hit.sourceUrl || hit.url,
    headers: requestHeadersFor(hit.url)
  });
  if (!fetched?.blob || fetched.blob.size <= 0) throw new Error('empty subtitle response');
  const sourceLooksSrt = requestedExt === '.srt' || /subrip/i.test(String(fetched.contentType || fetched.blob.type || '').toLowerCase()) || /\.(?:srt)(?:$|[?#])/i.test(hit.url || '');
  const previewBlob = sourceLooksSrt ? await convertSubtitleBlob(fetched.blob, '.srt') : fetched.blob;
  const text = await previewBlob.text();
  return {
    ok: true,
    text,
    contentType: String(previewBlob.type || fetched.contentType || '').toLowerCase(),
    converted: !!sourceLooksSrt,
    looksReadable: subtitleCueLooksReadable(text),
    previewName: subtitleFileNameForHit(hit, null, sourceLooksSrt ? '.srt' : '.vtt', options)
  };
}

async function archiveSubtitleHit(hit, options = {}) {
  await refreshConfig(true);
  if (!MEMORY.config.serverOrigin) throw new Error('Server not configured.');
  if (!MEMORY.settings.captureSubtitleFiles) throw new Error('Subtitle capture is disabled in options.');

  const archiveSignal = options.archiveSignal || getActiveArchiveSignal(hit) || null;

  setArchiveStage(hit, 'downloading', 'Fetching subtitle');
  hit.error = '';
  hit.browserRemuxRequested = false;
  hit.browserRemuxSucceeded = false;
  hit.progressDone = 0;
  hit.progressTotal = 0;
  await saveHits();
  await updateBadge();

  const folder = options.folder || buildArchiveBase({ ...hit, sourceUrl: hit.sourceUrl || hit.url });
  hit.archivedFolder = folder;
  const sourceBlobType = String(hit.contentType || '').toLowerCase();
  const requestedExt = subtitleExtFromUrl(hit.url || '', hit.contentType || '');
  const sourceName = subtitleFileNameForHit(hit, null, requestedExt === '.srt' ? '.srt' : '.vtt', options);
  const finalName = sourceName.replace(/\.(?:srt|vtt|sbv|ttml|dfxp|sub)$/i, '.vtt');

  const uploads = [];
  const warnings = [];
  const archiveState = { mainOutputUploaded: false };
  try {
    const delayMs = getPerItemDelayMs();
    if (delayMs) await sleep(delayMs);
    const fetched = await fetchBlobMeta(hit.url, {
      referrer: hit.pageUrl || hit.sourceUrl || hit.url,
      headers: requestHeadersFor(hit.url)
    });
    if (!fetched?.blob || fetched.blob.size <= 0) throw new Error('empty subtitle response');
    const contentType = String(fetched.contentType || fetched.blob.type || '').toLowerCase();
    const subtitleText = await fetched.blob.text().catch(() => '');
    if (!hitMatchesEnglishSubtitlePolicy(hit, subtitleText, !!options.bypassEnglishSubtitleOnly)) {
      hit.status = 'skipped';
      hit.error = 'Subtitle does not look English';
      hit.archivedFiles = [];
      hit.progressLabel = 'Skipped';
      await saveHits();
      await updateBadge();
      return { folder, files: [], warnings: ['Subtitle does not look English'], failedUploads: [] };
    }

    let subtitleBlob = fetched.blob;
    const sourceLooksSrt = requestedExt === '.srt' || /subrip/i.test(contentType) || /\.(?:srt)(?:$|[?#])/i.test(hit.url || '');
    if (sourceLooksSrt) {
      subtitleBlob = await convertSubtitleBlob(fetched.blob, '.srt');
    }

    const finalText = await subtitleBlob.text().catch(() => '');
    if (!subtitleCueLooksReadable(finalText)) {
      throw new Error('Selected subtitle does not look like a readable VTT/SRT subtitle');
    }

    uploads.push({ name: finalName, blob: subtitleBlob });
  } catch (err) {
    warnings.push(`subtitle fetch failed: ${err?.message || err}`);
    uploads.push({ name: 'subtitle-url.txt', blob: new Blob([`${hit.url}\n`], { type: 'text/plain' }) });
  }

  uploads.push({ name: 'meta.json', blob: new Blob([JSON.stringify({
    sourceUrl: hit.sourceUrl || '',
    pageUrl: hit.pageUrl || '',
    title: hit.title || '',
    subtitleLang: hit.subtitleLang || '',
    subtitleLabel: hit.subtitleLabel || '',
    subtitleKind: hit.subtitleKind || '',
    subtitleDefault: !!hit.subtitleDefault,
    detectedAt: new Date(hit.ts || Date.now()).toISOString()
  }, null, 2)], { type: 'application/json' }) });
  if (warnings.length) uploads.push({ name: 'issues.txt', blob: new Blob([warnings.join('\n') + '\n'], { type: 'text/plain' }) });

  const totalSteps = Math.max(1, uploads.length + 1);
  const uploaded = [];
  const failedUploads = [];
  setArchiveStage(hit, 'archiving', 'Uploading subtitle');
  hit.progressDone = 1;
  hit.progressTotal = totalSteps;
  await saveHits();
  for (let i = 0; i < uploads.length; i++) {
    const item = uploads[i];
    if (!item || !item.name || !item.blob) {
      failedUploads.push(`upload ${i + 1}: invalid upload entry`);
      await updateHitProgress(hit, Math.min(totalSteps, 1 + i + 1), totalSteps, `Uploaded ${i + 1} / ${uploads.length}`);
      continue;
    }
    try {
      const delayMs = getPerItemDelayMs();
      if (delayMs) await sleep(delayMs);
      const ok = await uploadBlob(item.targetDir || folder, item.name, item.blob);
      if (!ok) throw new Error('upload rejected');
      uploaded.push(item.name);
      if (item.name === finalName) archiveState.mainOutputUploaded = true;
    } catch (err) {
      failedUploads.push(`${item.name}: ${err?.message || err}`);
    }
    hit.progressDone = Math.min(totalSteps, 1 + i + 1);
    hit.progressTotal = totalSteps;
    hit.progressLabel = `Uploaded ${i + 1} / ${uploads.length}`;
    await saveHits();
  }

  if (!archiveState.mainOutputUploaded) warnings.push('main media file was not uploaded');
  const archiveIssues = failedUploads.length ? failedUploads.join(' | ') : (warnings.length ? warnings.join(' | ') : '');
  hit.status = !archiveState.mainOutputUploaded
    ? (uploaded.length ? 'partial' : 'failed')
    : (failedUploads.length ? (uploaded.length ? 'partial' : 'failed') : 'archived');
  hit.archivedFiles = uploaded;
  hit.error = archiveIssues;
  hit.progressDone = totalSteps;
  hit.progressTotal = totalSteps;
  hit.progressLabel = hit.status === 'archived' ? 'Complete' : hit.status;
  await saveHits();
  await updateBadge();

  if (failedUploads.length && !uploaded.length) throw new Error(hit.error);
  return { folder, files: uploaded, warnings, failedUploads };
}

async function archiveAssociatedSubtitles(primaryHit, options = {}) {
  if (!MEMORY.settings.captureSubtitleFiles) return [];
  if (options.includeSubtitleUploads === false) return [];
  const selected = resolveSubtitleTargets(primaryHit, options);
  const baseName = options.baseName || primaryHit.archiveName || primaryHit.title || '';
  const prefetched = Array.isArray(options.prefetchedSubtitleArtifacts) ? options.prefetchedSubtitleArtifacts : [];
  const results = [];
  const subtitleSet = Array.isArray(options.subtitleUrls) && options.subtitleUrls.length
    ? new Set(options.subtitleUrls.map(v => String(v || '').trim()).filter(Boolean))
    : null;
  for (let i = 0; i < selected.length; i++) {
    const subHit = selected[i];
    const pref = prefetched.find(item => item && item.hit && item.hit.url && String(item.hit.url).trim() === String(subHit.url || '').trim()) || null;
    try {
      results.push(await archiveSubtitleHit(subHit, {
        ...options,
        baseName,
        subtitleBaseName: options.subtitleBaseName || baseName,
        subtitleCount: selected.length,
        subtitleIndex: i,
        folder: options.folder || primaryHit.archivedFolder || buildArchiveBase(primaryHit),
        bypassEnglishSubtitleOnly: !!subtitleSet,
        prefetchedBlob: pref?.blob || null,
        prefetchedName: pref?.name || ''
      }));
    } catch (err) {
      subHit.status = 'failed';
      subHit.error = String(err?.message || err);
      await saveHits();
      await updateBadge();
    }
  }
  return results;
}



function normalizeComparablePageUrl(url = '') {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/+$/g, '').toLowerCase();
  } catch {
    return String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/g, '').toLowerCase();
  }
}

function normalizeComparableUrl(url = '') {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/+$/g, '').toLowerCase();
  } catch {
    return String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/g, '').toLowerCase();
  }
}

function normalizeComparableOrigin(url = '') {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/g, '').toLowerCase();
  }
}

function normalizeCardFamilyText(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mainCardFamilyKey(hit = {}) {
  if (!hit) return '';
  const tab = String(Number(hit.tabId || 0) || '');
  const page = normalizeComparablePageUrl(hit.pageUrl || '');
  const title = normalizeCardFamilyText(hit.archiveName || hit.title || '');
  const source = normalizeComparableUrl(hit.sourceUrl || hit.url || '');
  const sourceOrigin = normalizeComparableOrigin(hit.sourceUrl || hit.url || '');
  const kind = String(hit.kind || '').toLowerCase();

  if (kind === 'playlist') {
    const familyRoot = page || sourceOrigin || source || '';
    return [tab, familyRoot, title].join('|');
  }

  const root = page || source || '';
  return [tab, root, title, source].join('|');
}

function isCountableBadgeStatus(hit = {}) {
  const status = String(hit?.status || '').toLowerCase();
  return ['new', 'queued', 'archiving'].includes(status);
}

async function updateBadge() {
  const visible = dedupeHitsForDisplay(MEMORY.hits)
    .filter(h => !isInternalHit(h))
    .filter(h => isMainCardKind(h?.kind));

  const familyBuckets = new Map();
  for (const hit of visible) {
    const key = mainCardFamilyKey(hit) || hit.id || hit.key || hit.url || '';
    if (!key) continue;
    const bucket = familyBuckets.get(key) || { countable: false };
    bucket.countable = bucket.countable || isCountableBadgeStatus(hit);
    familyBuckets.set(key, bucket);
  }

  const count = [...familyBuckets.values()].filter(bucket => bucket.countable).length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#66d0e8' });
}

let remuxBadgeTimer = null;
function scheduleBadgeUpdate(delayMs = 250) {
  if (remuxBadgeTimer) return;
  remuxBadgeTimer = setTimeout(async () => {
    remuxBadgeTimer = null;
    await updateBadge().catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
}

async function setTabListeningPaused(tabId, paused) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SFA_SET_LISTENING_PAUSED', paused: !!paused });
  } catch {}
}

async function updateHitProgress(hit, done, total, label = '', extra = {}) {
  if (!hit) return;
  hit.progressDone = Math.max(0, Number(done) || 0);
  hit.progressTotal = Math.max(0, Number(total) || 0);
  hit.progressLabel = label || hit.progressLabel || '';
  let immediatePersist = false;
  if (extra && typeof extra === 'object') {
    const { immediatePersist: forcePersist, ...rest } = extra;
    immediatePersist = !!forcePersist;
    Object.assign(hit, rest);
  }
  if (immediatePersist) {
    await scheduleHitPersistence(true);
  } else {
    void scheduleHitPersistence(false);
  }
}

function setArchiveStage(hit, stage, label = '') {
  if (!hit) return;
  const nextStage = String(stage || '').toLowerCase();
  if (['downloading', 'remuxing', 'archiving'].includes(nextStage)) {
    hit.status = nextStage;
  }
  if (label) hit.progressLabel = label;
}

function rewritePlaylist(mediaText, baseUrl, localMap, segmentStatusByUrl = new Map(), options = {}) {
  const omitMissingSegments = !!options.omitMissingSegments;
  const replacementMap = options.replacementMap instanceof Map ? options.replacementMap : new Map();
  const lines = safeText(mediaText, '').replace(/\r/g, '').split('\n');
  const rewritten = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { rewritten.push(raw); continue; }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      if (attrs.URI) {
        const url = new URL(attrs.URI, baseUrl).href;
        const local = localMap.get(url);
        if (local) {
          const outAttrs = { ...attrs, URI: local };
          const attrText = Object.entries(outAttrs).map(([k,v]) => `${k}=${typeof v === 'string' && !/^\d+$/.test(v) && !/^(?:NONE|AES-128|SAMPLE-AES)$/i.test(v) ? JSON.stringify(String(v)) : v}`).join(',');
          rewritten.push(`#EXT-X-KEY:${attrText}`);
          continue;
        }
      }
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        const url = new URL(attrs.URI, baseUrl).href;
        const local = localMap.get(url);
        if (local) {
          const outAttrs = { ...attrs, URI: local };
          const attrText = Object.entries(outAttrs).map(([k,v]) => `${k}=${typeof v === 'string' && !/^\d+$/.test(v) ? JSON.stringify(String(v)) : v}`).join(',');
          rewritten.push(`#EXT-X-MAP:${attrText}`);
          continue;
        }
      }
    }

    if (line.startsWith('#')) {
      rewritten.push(raw);
      continue;
    }

    const absUrl = new URL(line, baseUrl).href;
    const segStatus = String(segmentStatusByUrl.get(absUrl) || '').toLowerCase();
    const local = localMap.get(absUrl);

    if (segStatus === 'placeholder') {
      rewritten.push('#EXT-X-DISCONTINUITY');
    }

    if (local) {
      rewritten.push(local);
      continue;
    }

    if (segStatus === 'missing') {
      const replacement = replacementMap.get(absUrl);
      if (replacement) {
        rewritten.push('#EXT-X-DISCONTINUITY');
        rewritten.push(replacement);
        continue;
      }
      if (!omitMissingSegments) {
        rewritten.push('#EXT-X-DISCONTINUITY');
        rewritten.push('#EXT-X-GAP');
      }
      continue;
    }

    rewritten.push(raw);
  }

  return rewritten.join('\n');
}

function buildMissingSegmentReplacementMap(segmentMeta = []) {
  return new Map();
}
async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('Offscreen API is not available in this Chrome version.');
  }
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  } catch {}
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run mediabunny remux in an extension page that supports dedicated workers.'
  });
}



function placeholderFamilyFromRecord(record = {}) {
  const ext = String(record.ext || extFromUrl(record.uri || '', '') || '').toLowerCase();
  if (['.ts', '.m2ts', '.m2t', '.mp2t'].includes(ext)) return 'ts';
  return 'iso';
}

async function generatePlaceholderSegmentInBrowser({ duration, family, outputName, quality = '', resolution = '' }) {
  await ensureOffscreenDocument();
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onMessage);
      reject(new Error('Placeholder generation timed out.'));
    }, 5 * 60 * 1000);

    const resultChunks = [];
    let resultName = String(outputName || (String(family || '').toLowerCase() === 'ts' ? 'gap.ts' : 'gap.mp4'));
    let mimeType = '';

    const onMessage = (message) => {
      const msg = message || {};
      if (msg.id !== id) return;

      if (msg.type === 'sfa-remux-result-chunk') {
        if (typeof msg.name === 'string' && msg.name) resultName = msg.name;
        if (typeof msg.mimeType === 'string' && msg.mimeType) mimeType = msg.mimeType;

        const chunkBytes = msg.base64 ? base64ToBytes(msg.base64) : (msg.bytes instanceof ArrayBuffer
          ? msg.bytes
          : ArrayBuffer.isView(msg.bytes)
            ? msg.bytes.buffer.slice(msg.bytes.byteOffset, msg.bytes.byteOffset + msg.bytes.byteLength)
            : null);
        if (chunkBytes) {
          const idx = Number.isInteger(msg.chunkIndex) && msg.chunkIndex >= 0 ? msg.chunkIndex : resultChunks.length;
          resultChunks[idx] = chunkBytes;
        }
        return;
      }

      if (msg.type === 'sfa-remux-result-done') {
        if (typeof msg.name === 'string' && msg.name) resultName = msg.name;
        if (typeof msg.mimeType === 'string' && msg.mimeType) mimeType = msg.mimeType;

        const ordered = resultChunks.filter(Boolean);
        const blob = new Blob(ordered, { type: mimeType || 'application/octet-stream' });

        chrome.runtime.onMessage.removeListener(onMessage);
        clearTimeout(timeout);
        resolve({ name: resultName, mimeType, blob });
        return;
      }

      if (msg.type === 'sfa-remux-result-error') {
        chrome.runtime.onMessage.removeListener(onMessage);
        clearTimeout(timeout);
        reject(new Error(msg.error || 'Placeholder generation failed.'));
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    runtimeSendMessage({
      type: 'sfa-remux-placeholder',
      id,
      baseUrl: normalizeMediabunnyBaseUrl(MEMORY.settings.mediabunnyBaseUrl || '') || chrome.runtime.getURL('mediabunny/'),
      duration: Number(duration || 0) || 1,
      family: family || 'ts',
      quality: quality || '',
      resolution: resolution || '',
      outputName: String(outputName || (String(family || '').toLowerCase() === 'ts' ? 'gap.ts' : 'gap.mp4'))
    }).catch((err) => {
      chrome.runtime.onMessage.removeListener(onMessage);
      clearTimeout(timeout);
      reject(err);
    });
  });

  const outBlob = result?.blob instanceof Blob ? result.blob : null;
  if (!outBlob || !outBlob.size) {
    throw new Error('Placeholder generation produced an empty output.');
  }
  const outName = String(result.name || outputName || (String(family || '').toLowerCase() === 'ts' ? 'gap.ts' : 'gap.mp4'));
  const mimeType = String(result.mimeType || (outName.toLowerCase().endsWith('.ts') ? 'video/mp2t' : 'video/mp4'));
  return { name: outName, blob: new Blob([outBlob], { type: mimeType }) };
}

async function resolveSegmentPlaceholder(record, { warnings } = {}) {
  if (Array.isArray(warnings)) warnings.push(`segment ${Number(record?.index || 0) + 1}: missing segment skipped for remux`);
  if (record && typeof record === 'object') {
    record.status = 'missing';
    record.placeholder = false;
    record.error = record.error || 'missing segment skipped for remux';
  }
  return record;
}


function partialArchiveKey(hit) {
  return hit?.id || hit?.key || '';
}

function readPartialArchiveState(hit) {
  const key = partialArchiveKey(hit);
  const stored = hit && hit.partialArchive && typeof hit.partialArchive === 'object' ? hit.partialArchive : null;
  const cached = key ? MEMORY.partialArchives.get(key) : null;
  return stored || cached || null;
}

function findPartialSegmentByUri(partial, uri, index = -1) {
  const segments = Array.isArray(partial?.segmentMeta) ? partial.segmentMeta : [];
  const cleanUri = String(uri || '').trim();
  if (!cleanUri) return null;
  const matchByUri = segments.find((seg) => String(seg?.uri || '').trim() === cleanUri);
  if (matchByUri) return matchByUri;
  const localBase = cleanUri.split('?')[0].split('#')[0];
  const matchByBase = segments.find((seg) => String(seg?.uri || '').trim().split('?')[0].split('#')[0] === localBase);
  if (matchByBase) return matchByBase;
  if (Number.isInteger(index) && index >= 0) return segments[index] || null;
  return null;
}

function updatePartialArchiveSegment(hit, record, patch = {}) {
  const partial = readPartialArchiveState(hit) || {};
  const segments = Array.isArray(partial.segmentMeta) ? [...partial.segmentMeta] : [];
  const idx = Math.max(0, Number(record?.index || 0) || 0);
  const existing = segments[idx] || {};
  const status = String(patch.status || record?.status || existing.status || 'saved').toLowerCase();
  segments[idx] = {
    ...existing,
    uri: record?.uri || existing.uri || '',
    mapUri: record?.mapUri || existing.mapUri || '',
    localName: record?.localName || existing.localName || '',
    status,
    placeholder: patch.placeholder ?? (status === 'placeholder'),
    attempts: Number(record?.attempts ?? existing.attempts ?? 0) || 0,
    duration: Number(record?.duration ?? existing.duration ?? 0) || 0,
    contentType: record?.contentType || existing.contentType || '',
    family: record?.family || existing.family || '',
    ext: record?.ext || existing.ext || '',
    isInit: !!record?.isInit || !!existing.isInit,
    blob: record?.blob || existing.blob || null
  };
  const next = { ...partial, segmentMeta: segments };
  if (Array.isArray(patch.missingSegmentUrls)) {
    next.missingSegmentUrls = [...patch.missingSegmentUrls];
  }
  storePartialArchiveState(hit, next);
  return next;
}

function buildPartialArchiveFileEntries(partial) {
  const entries = [];
  const seen = new Set();
  const segments = Array.isArray(partial?.segmentMeta) ? partial.segmentMeta : [];
  for (const seg of segments) {
    if (!seg || !seg.localName) continue;
    const status = String(seg.status || '').toLowerCase();
    if (status !== 'saved' && status !== 'placeholder') continue;
    if (seen.has(seg.localName)) continue;
    seen.add(seg.localName);
    entries.push({ name: seg.localName, blob: seg.blob || null });
  }
  for (const item of Array.isArray(partial?.extraFiles) ? partial.extraFiles : []) {
    const name = String(item?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, blob: item?.blob || null });
  }
  for (const name of Array.isArray(partial?.extraFileNames) ? partial.extraFileNames : []) {
    const clean = String(name || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    entries.push({ name: clean, blob: null });
  }
  return entries;
}




async function createPlaceholderFromNeighborSegment(hit, partial, index, localName) {
  return null;
}

async function compileArchiveFromPartial(hit, options = {}) {
  await refreshConfig(true);
  if (!MEMORY.config.serverOrigin) throw new Error('Server not configured.');

  let partial = readPartialArchiveState(hit);
  if (!partial) {
    throw new Error('No partial archive data is available to finalize.');
  }

  const folder = options.folder || hit.archivedFolder || partial.folder || buildArchiveBase(hit);
  const playlistName = partial.playlistName || 'index.m3u8';
  const outputName = partial.outputName || archiveOutputName(hit, partial.baseName || archiveBaseName(hit, options.outputName || options.archiveName || ''));
  const playlistBaseUrl = hit.resolvedUrl || hit.url || hit.sourceUrl || '';
  const allowServerFetch = options.allowServerFetch === true;
  const finalizationMode = String(options.finalizationMode || '').trim().toLowerCase();
  const skippedMissingSegments = finalizationMode === 'skip' || !!options.skippedMissingSegments;
  const retryFinalizationRequested = finalizationMode === 'retry' || !!options.retryMissingSegments;

  const segmentMeta = Array.isArray(partial.segmentMeta) ? partial.segmentMeta : [];
  const localMap = new Map();
  const segmentStatusByUrl = new Map();
  for (const seg of segmentMeta) {
    const uri = String(seg?.uri || '').trim();
    const localName = String(seg?.localName || '').trim();
    const status = String(seg?.status || '').toLowerCase();
    if (!uri) continue;
    if (localName && (status === 'saved' || status === 'placeholder')) {
      localMap.set(uri, localName);
      segmentStatusByUrl.set(uri, status);
    }
    if (status === 'missing') {
      segmentStatusByUrl.set(uri, 'missing');
    }
  }

  const missingRecords = segmentMeta.filter((seg) => String(seg?.status || '').toLowerCase() === 'missing' && seg?.uri);
  if (missingRecords.length) {
    if (!skippedMissingSegments) {
      throw new Error(`${missingRecords.length} missing segment(s) are still unavailable. Retry missing to fetch them from the internet, or Skip missing to remux the partial archive.`);
    }
    if (!retryFinalizationRequested && finalizationMode !== 'skip' && finalizationMode !== 'retry' && !options.skipMissingSegments && !options.retryMissingSegments) {
      throw new Error(`${missingRecords.length} missing segment(s) are still unavailable. Retry missing to fetch them from the internet, or Skip missing to remux the partial archive.`);
    }
  }

  const uploaded = [];
  const placeholderWarnings = [];
  const warnings = placeholderWarnings.slice();

  partial = readPartialArchiveState(hit) || partial;
  const fileEntries = buildPartialArchiveFileEntries(partial);
  if (!fileEntries.length) {
    throw new Error('No saved segment files were available to compile.');
  }

  const rewrittenPlaylist = String(partial.playlistText || '').trim()
    ? rewritePlaylist(
        String(partial.playlistText || '').trim(),
        playlistBaseUrl,
        localMap,
        segmentStatusByUrl,
        {
          omitMissingSegments: skippedMissingSegments
        }
      )
    : String(partial.playlistText || '').trim();

  setArchiveStage(hit, 'remuxing', options.progressLabel || 'Finalizing archive');
  hit.error = '';
  hit.progressDone = 0;
  hit.progressTotal = fileEntries.length + 1;
  hit.browserRemuxRequested = true;
  await saveHits();
  await updateBadge();

  const files = [];
  for (let i = 0; i < fileEntries.length; i++) {
    const entry = fileEntries[i];
    const name = String(entry?.name || '').trim();
    if (!name) continue;
    if (i % 4 === 0) await yieldToEventLoop();
    let blob = entry?.blob || getPartialArchiveBlob(hit, name) || null;
    if (!blob) blob = await loadPartialArchiveBlob(hit, name);
    await updateHitProgress(hit, i + 1, fileEntries.length + 1, `Loading cached blob ${i + 1} / ${fileEntries.length}`);
    if (!blob && allowServerFetch) {
      try {
        blob = await fetchServerFileBlob(folder, name);
      } catch (err) {
        throw new Error(`Could not load ${name}: ${err?.message || err}`);
      }
    }
    if (!blob) {
      throw new Error(`Missing cached blob for ${name}.`);
    }
    files.push({ name, blob });
  }

  let compiled;
  let mainOutputUploaded = false;
  try {
    hit.progressLabel = 'Waiting for Mediabunny remux slot';
    void scheduleHitPersistence(false);
    scheduleBadgeUpdate(150);
    await yieldToEventLoop();
    compiled = await remuxPlaylistInBrowser({
      playlistName,
      outputName,
      files,
      playlistText: rewrittenPlaylist || String(partial.playlistText || '').trim(),
      uploadUrl: buildUploadPutPath(folder, outputName).putPath,
      onStatus: (label) => scheduleRemuxStatus(hit, label)
    });
    files.length = 0;
  } catch (err) {
    const remuxError = String(err?.message || err || 'browser remux failed');
    const issueLines = Array.isArray(warnings) ? warnings : [];
    issueLines.push(`browser remux failed: ${remuxError}`);
    issueLines.push(`browser remux inputs: ${fileEntries.map((entry) => String(entry?.name || '').trim()).filter(Boolean).join(', ') || '(none)'}`);
    issueLines.push(`browser remux mode: Mediabunny fast-start MP4 remux`);
    hit.error = issueLines.join(' | ');
    const issuesBlob = new Blob([issueLines.join('\n') + '\n'], { type: 'text/plain' });


    await uploadBlob(folder, 'issues.txt', issuesBlob).catch(() => {});
    await saveHits().catch(() => {});
    throw new Error(remuxError);
  }

  setArchiveStage(hit, 'archiving', 'Uploading archive');
  await yieldToEventLoop();
  const finalBlobName = compiled.name || outputName;
  uploaded.push(finalBlobName);

  if (rewrittenPlaylist) {
    const manifestUpload = await uploadBlob(folder, playlistName, new Blob([rewrittenPlaylist], { type: 'application/vnd.apple.mpegurl' }));
    if (manifestUpload) uploaded.push(playlistName);
  }

  const meta = {
    sourceUrl: hit.url,
    resolvedUrl: hit.resolvedUrl || hit.url,
    pageUrl: hit.pageUrl,
    title: hit.archiveName || hit.title,
    kind: hit.kind,
    detectedAt: new Date(hit.ts || Date.now()).toISOString(),
    folder,
    skippedMissingSegments: !!options.skippedMissingSegments,
    skippedSegmentUrls: Array.isArray(hit.missingSegmentUrls) ? hit.missingSegmentUrls : [],
    outputFile: finalBlobName
  };
  await uploadBlob(folder, 'skip-meta.json', new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' })).catch(() => {});

  hit.archivedFolder = folder;
  hit.archivedFiles = uploaded;
  hit.missingSegmentUrls = [];
  hit.missingSegmentCount = 0;
  hit.status = 'archived';
  hit.error = '';
  hit.browserRemuxSucceeded = true;
  hit.progressDone = fileEntries.length + 1;
  hit.progressTotal = fileEntries.length + 1;
  hit.progressLabel = 'Complete';
  hit.segmentProgressDone = fileEntries.length;
  hit.segmentProgressTotal = fileEntries.length;
  storePartialArchiveState(hit, null);
  await clearPartialArchiveBlobCache(hit).catch(() => {});
  await saveHits();
  await updateBadge();

  await archiveAssociatedSubtitles(
    { ...hit, archivedFolder: folder },
    {
      folder,
      baseName: partial.baseName || hit.archiveName || hit.title || '',
      subtitleBaseName: partial.baseName || hit.archiveName || hit.title || '',
      subtitleUrls: Array.isArray(options.subtitleUrls) ? options.subtitleUrls : []
    }
  ).catch(() => {});

  return { folder, files: uploaded, skipped: !!options.skippedMissingSegments };
}

function estimateChunkCount(value, chunkSize = REMUX_MESSAGE_CHUNK_BYTES) {
  const source = normalizeBinarySource(value);
  const size = typeof source?.size === 'number'
    ? source.size
    : typeof source?.byteLength === 'number'
      ? source.byteLength
      : ArrayBuffer.isView(source)
        ? source.byteLength
        : 0;
  return Math.max(1, Math.ceil(size / Math.max(1, Number(chunkSize) || REMUX_MESSAGE_CHUNK_BYTES)));
}

async function remuxPlaylistInBrowser({ playlistName, outputName, files, playlistText, segmentMeta = [], uploadUrl = '', onStatus = null, mode = 'archive' }) {
  await ensureOffscreenDocument();

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payloadFiles = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || !file.name) continue;
    payloadFiles.push({
      name: String(file.name),
      mimeType: String(file.mimeType || file.type || file.blob?.type || ''),
      source: normalizeBinarySource(file.bytes ?? file.blob ?? file.data)
    });
  }

  const totalPayloadFiles = payloadFiles.length;
  if (!totalPayloadFiles) {
    throw new Error('No media files were provided to remux.');
  }
  const label = (stage, detail = '') => {
    if (typeof onStatus !== 'function') return;
    onStatus([stage, detail].filter(Boolean).join(' • ') || 'Working…');
  };

  label('Remux', `Queueing ${totalPayloadFiles} file${totalPayloadFiles === 1 ? '' : 's'}`);
  await runtimeSendMessage({
    type: 'sfa-remux-init',
    id,
    baseUrl: normalizeMediabunnyBaseUrl(MEMORY.settings.mediabunnyBaseUrl || '') || chrome.runtime.getURL('mediabunny/'),
    playlistName: String(playlistName || 'index.m3u8'),
    outputName: String(outputName || 'compiled.mp4'),
    playlistText: typeof playlistText === 'string' ? playlistText : '',
    segmentMeta: Array.isArray(segmentMeta) ? segmentMeta : [],
    fileCount: totalPayloadFiles,
    chunkBytes: REMUX_MESSAGE_CHUNK_BYTES,
    mode: String(mode || 'archive'),
    reserveBufferOverestimationPercent: Math.max(0, Number(MEMORY.settings.reserveBufferOverestimationPercent ?? 15) || 0)
  });

  label('Remux', 'Preparing remux inputs');

  for (let fileIndex = 0; fileIndex < payloadFiles.length; fileIndex++) {
    const entry = payloadFiles[fileIndex];
    const totalChunks = estimateChunkCount(entry.source, REMUX_MESSAGE_CHUNK_BYTES);
    label('Remux', `Sending file ${fileIndex + 1} / ${totalPayloadFiles}${entry.name ? ` • ${entry.name}` : ''}`);

    await runtimeSendMessage({
      type: 'sfa-remux-file-start',
      id,
      fileIndex,
      name: entry.name,
      mimeType: String(entry.mimeType || '')
    });

    let chunkIndex = 0;
    for await (const chunk of binaryChunks(entry.source, REMUX_MESSAGE_CHUNK_BYTES)) {
      if (chunkIndex === 0 || chunkIndex + 1 === totalChunks || (chunkIndex + 1) % 8 === 0) {
        label('Remux', `Sending ${entry.name || 'file'} ${chunkIndex + 1} / ${totalChunks}`);
      }
      await runtimeSendMessage({
        type: 'sfa-remux-file-chunk',
        id,
        fileIndex,
        chunkIndex,
        base64: bytesToBase64(chunk)
      });
      chunkIndex += 1;
    }

    await runtimeSendMessage({
      type: 'sfa-remux-file-end',
      id,
      fileIndex,
      chunkCount: chunkIndex
    });
  }

  label('Remux', `Handing off to remux worker with ${totalPayloadFiles} file${totalPayloadFiles === 1 ? '' : 's'}`);

  const response = await runtimeSendMessage({
    type: 'sfa-remux-finalize',
    id,
    uploadUrl: String(uploadUrl || '')
  });

  if (!response || !response.ok) {
    throw new Error(response?.error || 'Remux upload failed.');
  }

  return {
    name: String(response.name || outputName || 'compiled.mp4'),
    mimeType: String(response.mimeType || (String(outputName || '').toLowerCase().endsWith('.ts') ? 'video/mp2t' : 'video/mp4')),
    uploaded: true,
    status: response.status || 200
  };
}

function buildRemuxCommandText(playlistName, outputName) {
  const input = String(playlistName || 'index.m3u8');
  const output = String(outputName || 'compiled.mp4');
  return [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    `mediabunny -y -hide_banner -loglevel error -allowed_extensions ALL -protocol_whitelist file,crypto,data,http,https,tcp,tls -i "${input}" -c copy "${output}"`,
    'endlocal'
  ].join('\r\n') + '\r\n';
}

function buildRemuxRequest(hit, folder, playlistName, outputName, segmentMeta, masterText, currentText) {
  const segmentFiles = Array.isArray(segmentMeta) ? segmentMeta.map(seg => seg.localName).filter(Boolean) : [];
  return {
    sourceUrl: hit.url,
    resolvedUrl: hit.resolvedUrl || hit.url,
    pageUrl: hit.pageUrl || '',
    title: hit.kind === 'subtitle' ? subtitleDescriptor(hit) : (hit.archiveName || hit.title || ''),
    tabId: Number(hit.tabId || 0),
    sessionId: Number(hit.sessionId || 0),
    playlistFile: playlistName,
    outputFile: outputName,
    outputFormat: 'mp4',
    folder,
    platform: MEMORY.config.platform,
    masterPlaylistSaved: !!masterText,
    mediaPlaylistSaved: !!currentText,
    segmentCount: segmentFiles.length,
    segmentFiles,
    createdAt: new Date(hit.ts || Date.now()).toISOString(),
    notes: 'Run mediabunny with the saved playlist and local segment paths to remux into a complete MP4.'
  };
}


async function archivePlaylistHit(hit, options = {}) {
  await refreshConfig(true);
  if (!MEMORY.config.serverOrigin) throw new Error('Server not configured.');

  const archiveSignal = options.archiveSignal || getActiveArchiveSignal(hit) || null;

  setArchiveStage(hit, 'downloading', 'Starting');
  hit.error = '';
  hit.progressDone = 0;
  hit.progressTotal = 0;
  hit.segmentProgressDone = 0;
  hit.segmentProgressTotal = 0;
  hit.browserRemuxRequested = false;
  hit.browserRemuxSucceeded = false;
  await saveHits();
  await updateBadge();

  const folder = options.folder || buildArchiveBase(hit);
  hit.archivedFolder = folder;
  const requestedBaseName = archiveBaseName(hit, options.outputName || options.archiveName || '');
  const finalArchiveName = archiveOutputName(hit, requestedBaseName);
  hit.archiveName = requestedBaseName;
  if (requestedBaseName) hit.title = requestedBaseName;

  let currentUrl = hit.url;
  let currentText = hit.text || '';
  let parsed = null;
  let masterText = '';
  const warnings = [];
  const archiveState = { mainOutputUploaded: false };
  const failedUploads = [];
  const localMap = new Map();
  const uploads = [];
  const remuxFileNames = [];
  const sourceName = 'source.m3u8';
  const manifestName = 'index.m3u8';
  const metaName = 'meta.json';

  await updateHitProgress(hit, 1, 4, 'Preparing playlist');

  if (!currentText) {
    try {
      const delayMs = getPerItemDelayMs();
      if (delayMs) await sleep(delayMs);
      currentText = await fetchText(currentUrl, { referrer: hit.pageUrl || currentUrl, headers: requestHeadersFor(currentUrl), archiveSignal });
    } catch (err) {
      throw new Error(`Could not fetch playlist: ${err?.message || err}`);
    }
  }

  parsed = parsePlaylist(currentText, currentUrl);

  if (parsed.type === 'master') {
    const chosenVariantUrl = safeText(options.variantUrl, '').trim();
    const chosen = chosenVariantUrl
      ? parsed.variants.find(v => v.uri === chosenVariantUrl) || chooseBestVariant(parsed.variants)
      : chooseBestVariant(parsed.variants);
    if (!chosen) throw new Error('No playlist variants found.');
    masterText = currentText;
    currentUrl = chosen.uri;
    try {
      const delayMs = getPerItemDelayMs();
      if (delayMs) await sleep(delayMs);
      currentText = await fetchText(currentUrl, { referrer: hit.pageUrl || currentUrl, headers: requestHeadersFor(currentUrl), archiveSignal });
    } catch (err) {
      warnings.push(`variant fetch failed: ${err?.message || err}`);
      currentText = '';
    }
    if (currentText) {
      parsed = parsePlaylist(currentText, currentUrl);
      hit.text = currentText;
      hit.mediaPlaylistText = currentText;
      hit.playlistType = parsed?.type || hit.playlistType || '';
      hit.resolvedPlaylistUrl = currentUrl;
      await saveHits();
      await updateBadge();
    } else {
      parsed = { type: 'media', segments: [], keys: [], maps: [] };
    }
  }

  if (masterText) {
    uploads.push({ name: 'master-source.m3u8', blob: new Blob([masterText], { type: 'application/vnd.apple.mpegurl' }) });
  }
  if (currentText) {
    uploads.push({ name: sourceName, blob: new Blob([currentText], { type: 'application/vnd.apple.mpegurl' }) });
  }

  const allKeys = Array.isArray(parsed.keys) ? parsed.keys : [];
  const allMaps = Array.isArray(parsed.maps) ? parsed.maps : [];
  const allSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
  const totalSteps = Math.max(4, 2 + allKeys.length + allMaps.length + allSegments.length);
  let step = masterText ? 2 : 1;
  let savedSegments = 0;
  let failedSegments = 0;
  let keyIndex = 0;
  let mapIndex = 0;
  const segmentBlobs = [];
  const segmentMeta = [];
  const mapBlobs = new Map();
  const keyBlobs = new Map();
  const segmentStatusByUrl = new Map();

  if (parsed.type === 'media' && MEMORY.settings.saveSegments) {
    hit.segmentProgressDone = 0;
    hit.segmentProgressTotal = allSegments.length;
    await updateHitProgress(hit, step, totalSteps, `Saving ${allSegments.length} segment(s)`);

    const segmentRecords = allSegments.map((seg, i) => ({
      index: i,
      uri: seg?.uri || '',
      mapUri: seg?.map?.uri || '',
      localName: `${String(i + 1).padStart(6, '0')}${extFromUrl(seg?.uri || '', '')}`,
      status: 'pending',
      attempts: 0,
      blob: null,
      contentType: '',
      family: '',
      ext: '',
      isInit: false,
      duration: Number(seg?.duration || 0) || 0,
      error: ''
    }));
    let activeFetches = 0;

    const downloadOne = async (record, attemptNo = 1) => {
      record.attempts = attemptNo;
      record.status = attemptNo > 1 ? 'retrying' : 'downloading';
      record.error = '';
      segmentStatusByUrl.set(record.uri, record.status);
      await updateHitProgress(hit, step, totalSteps, attemptNo > 1 ? `Retrying segment ${record.index + 1} / ${allSegments.length}` : `Downloading segment ${record.index + 1} / ${allSegments.length}`, {
        currentSegmentIndex: record.index + 1,
        currentSegmentTotal: allSegments.length,
        currentSegmentName: record.localName,
        currentSegmentAttempt: attemptNo,
        currentSegmentStatus: record.status,
        currentSegmentBytes: 0,
        currentSegmentBytesTotal: 0,
        currentSegmentSpeedBps: 0,
        currentSegmentProgress: 0
      });

      const fetched = await fetchBlobMetaWithProgress(record.uri, {
        referrer: hit.pageUrl || currentUrl,
        headers: requestHeadersFor(record.uri),
        archiveSignal
      }, (p) => {
        const loaded = Number(p?.loaded || 0) || 0;
        const total = Number(p?.total || 0) || 0;
        const pct = total > 0 ? Math.min(100, Math.max(0, (loaded / total) * 100)) : 0;
        const segmentProgress = pct / 100;
        const overallDone = step + segmentProgress;
        record.status = 'downloading';
        if (record.attempts > 1) record.status = 'retrying';
        segmentStatusByUrl.set(record.uri, record.status);
        hit.currentSegmentIndex = record.index + 1;
        hit.currentSegmentTotal = allSegments.length;
        hit.currentSegmentName = record.localName;
        hit.currentSegmentAttempt = attemptNo;
        hit.currentSegmentStatus = record.status;
        hit.currentSegmentBytes = loaded;
        hit.currentSegmentBytesTotal = total || 0;
        hit.currentSegmentSpeedBps = Number(p?.speedBps || 0) || 0;
        hit.currentSegmentProgress = pct;
        hit.currentSegmentProgressLabel = total > 0 ? `${formatBytes(loaded)} / ${formatBytes(total)}` : `${formatBytes(loaded)}`;
        hit.currentSegmentSpeedLabel = formatRate(p?.speedBps || 0);
        hit.progressLabel = `${attemptNo > 1 ? 'Retrying' : 'Downloading'} segment ${record.index + 1} / ${allSegments.length}`;
        hit.progressDone = overallDone;
        hit.progressTotal = totalSteps;
        hit.segmentProgressDone = Math.min(allSegments.length, savedSegments + segmentProgress);
        hit.segmentProgressTotal = allSegments.length;
        if (!hit._lastProgressSave || Date.now() - hit._lastProgressSave >= 2000 || p?.done) {
          hit._lastProgressSave = Date.now();
          void scheduleHitPersistence(!!p?.done);
        }
      });

      const classification = await classifyFetchedBlob(fetched.blob, record.uri, fetched.contentType);
      record.blob = fetched.blob;
      record.contentType = fetched.contentType || '';
      record.family = classification.family;
      record.ext = classification.ext || extFromUrl(record.uri, fetched.contentType);
      record.isInit = !!classification.isInit;
      record.localName = `${String(record.index + 1).padStart(6, '0')}${record.ext}`;
      record.status = 'saved';
      segmentStatusByUrl.set(record.uri, 'saved');
      localMap.set(record.uri, record.localName);
      savedSegments += 1;
      return record;
    };

    const processBatch = async (records, attemptNo = 1) => {
      const failures = [];
      const concurrency = Math.max(1, Number(ARCHIVE_TUNING.segmentFetchConcurrency || 1));
      const results = await runWithConcurrency(records, concurrency, async (record) => {
        try {
          return await downloadOne(record, attemptNo);
        } catch (err) {
          record.status = attemptNo > 1 ? 'missing' : 'failed';
          record.error = String(err?.message || err || 'unknown error');
          segmentStatusByUrl.set(record.uri, record.status);
          failures.push(record);
          return record;
        }
      });
      return { results, failures };
    };
    let retryTargets = (await processBatch(segmentRecords, 1)).failures.filter(Boolean);
    if (retryTargets.length) {
      warnings.push(`${retryTargets.length} segment(s) could not be fetched on the first pass`);
      retryTargets = (await processBatch(retryTargets, 2)).failures.filter(Boolean);
      if (retryTargets.length) {
        warnings.push(`${retryTargets.length} segment(s) could not be fetched on the second pass`);
        retryTargets = (await processBatch(retryTargets, 3)).failures.filter(Boolean);
      }
    }

    for (const record of segmentRecords) {
      if (record.status === 'saved' && record.blob) {
        segmentBlobs.push(record.blob);
        remuxFileNames.push(record.localName);
        segmentMeta.push({
          uri: record.uri,
          contentType: record.contentType || '',
          family: record.family,
          ext: record.ext,
          isInit: !!record.isInit,
          mapUri: record.mapUri || '',
          localName: record.localName,
          status: 'saved',
          attempts: record.attempts,
          duration: Number(record.duration || 0) || 0,
          placeholder: false,
          error: '',
          blob: record.blob || null
        });
      } else {
        failedSegments += 1;
        record.status = 'missing';
        record.error = record.error || 'missing after retry';
        segmentMeta.push({
          uri: record.uri,
          contentType: record.contentType || '',
          family: record.family,
          ext: record.ext || extFromUrl(record.uri),
          isInit: !!record.isInit,
          mapUri: record.mapUri || '',
          localName: record.localName,
          status: 'missing',
          attempts: record.attempts,
          duration: Number(record.duration || 0) || 0,
          placeholder: false,
          error: record.error || 'missing after retry',
          blob: record.blob || null
        });
      }
      hit.segmentProgressDone = Math.min(allSegments.length, savedSegments + failedSegments);
      hit.segmentProgressTotal = allSegments.length;
      step += 1;
      await updateHitProgress(hit, step, totalSteps, `Processed segment ${record.index + 1} / ${allSegments.length}`, {
        currentSegmentIndex: record.index + 1,
        currentSegmentTotal: allSegments.length,
        currentSegmentName: record.localName,
        currentSegmentAttempt: record.attempts || 1,
        currentSegmentStatus: record.status,
        currentSegmentBytes: 0,
        currentSegmentBytesTotal: 0,
        currentSegmentSpeedBps: 0,
        currentSegmentProgress: 100
      });
      void scheduleHitPersistence(false);
    }
  }

  if (parsed.type === 'media' && MEMORY.settings.saveSegments && allSegments.length > 0) {
    hit.segmentProgressDone = allSegments.length;
    hit.segmentProgressTotal = allSegments.length;
  }

  const segmentFamilies = new Set(segmentMeta.map(seg => seg.family).filter(Boolean));
  const segmentExts = new Set(segmentMeta.map(seg => seg.ext || '').filter(Boolean));
  const allSegmentsSaved = savedSegments === allSegments.length && failedSegments === 0 && segmentBlobs.length === allSegments.length;
  const replacementMap = buildMissingSegmentReplacementMap(segmentMeta);
  const exactPlaylist = (MEMORY.settings.saveSegments && localMap.size && currentText)
    ? rewritePlaylist(currentText, currentUrl, localMap, segmentStatusByUrl, { replacementMap })
    : currentText;
  const omittedPlaylist = (MEMORY.settings.saveSegments && localMap.size && currentText && segmentMeta.some(seg => seg.status === 'missing'))
    ? rewritePlaylist(currentText, currentUrl, localMap, segmentStatusByUrl, { omitMissingSegments: true, replacementMap })
    : exactPlaylist;

  const browserCombineOk = MEMORY.settings.saveSegments && parsed.type === 'media' && allSegments.length > 0 && allSegmentsSaved;
  if (browserCombineOk) setArchiveStage(hit, 'remuxing', 'Remuxing archive');
  if (browserCombineOk) {
    try {
      const remuxFiles = [];
      let savedSegmentIndex = 0;
      for (const seg of segmentMeta) {
        if (seg.status !== 'saved' && seg.status !== 'placeholder') continue;
        const ext = String(seg.ext || '').toLowerCase();
        const blob = segmentBlobs[savedSegmentIndex++];
        if (!blob) continue;

        // Only feed media-bearing segments to MediaBunny. Sidecar files like keys,
        // init maps, manifests, and other helpers stay out of the mux input so the
        // concatenated blob remains a recognizable media source.
        let isMediaSegment = ['.ts', '.m2ts', '.m4s', '.mp4', '.m4v', '.mov', '.mp2t'].includes(ext)
          || seg.family === 'ts'
          || seg.family === 'iso';
        if (!isMediaSegment && (ext === '.bin' || !ext || seg.family === 'unknown')) {
          try {
            isMediaSegment = await blobLooksLikeTs(blob);
          } catch {
            isMediaSegment = false;
          }
        }
        if (isMediaSegment) remuxFiles.push({ name: seg.localName, blob });
      }

      if (!remuxFiles.length) {
        throw new Error('No media segments were eligible for browser remux.');
      }

      const remuxed = await remuxPlaylistInBrowser({
        playlistName: manifestName,
        outputName: finalArchiveName,
        files: remuxFiles,
        playlistText: failedSegments > 0 ? omittedPlaylist : exactPlaylist,
        uploadUrl: buildUploadPutPath(folder, finalArchiveName).putPath
      });
      if (!remuxed?.uploaded) {
        throw new Error('Browser remux did not upload the remuxed MP4.');
      }
      archiveState.mainOutputUploaded = true;
    } catch (err) {
      const browserCombineError = String(err?.message || err);
      warnings.push(`browser remux failed: ${browserCombineError}`);
    }
  }

  const manifestToUpload = omittedPlaylist || exactPlaylist || currentText;
  if (manifestToUpload) {
    uploads.push({ name: manifestName, blob: new Blob([manifestToUpload], { type: 'application/vnd.apple.mpegurl' }) });
  }

  const remuxRequested = browserCombineOk;
  const desc = describePlaylist(masterText || currentText, currentUrl);
  const browserCombineError = browserCombineOk ? '' : (warnings.find((w) => String(w || '').startsWith('browser remux failed: ')) || '').replace(/^browser remux failed:\s*/, '');
  const meta = {
    sourceUrl: hit.url,
    resolvedUrl: currentUrl,
    pageUrl: hit.pageUrl,
    title: hit.archiveName || hit.title,
    kind: hit.kind,
    detectedAt: new Date(hit.ts || Date.now()).toISOString(),
    platform: MEMORY.config.platform,
    serverOrigin: MEMORY.config.serverOrigin,
    saveSegments: !!MEMORY.settings.saveSegments,
    segmentCount: allSegments.length,
    savedSegments,
    failedSegments,
    segmentFamilies: [...segmentFamilies],
    segmentExts: [...segmentExts],
    missingSegments: segmentMeta.filter(seg => seg.status === 'missing').length,
    variantMode: !!masterText,
    playlistType: desc.playlistType || hit.playlistType || '',
    quality: desc.quality || hit.quality || '',
    variantCount: desc.variantCount || hit.variantCount || 0,
    folder,
    remuxRequested,
    browserCombineRequested: !!(MEMORY.settings.saveSegments && parsed.type === 'media' && allSegments.length > 0 && allSegmentsSaved),
    browserCombineSucceeded: browserCombineOk,
    browserCombineError,
    remuxInput: remuxRequested ? manifestName : '',
    remuxOutput: remuxRequested ? finalArchiveName : '',
    warnings
  };
  uploads.push({ name: metaName, blob: new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }) });

  if (warnings.length) {
    uploads.push({ name: 'issues.txt', blob: new Blob([warnings.join('\n') + '\n'], { type: 'text/plain' }) });
  }

  const uploaded = [];
  setArchiveStage(hit, 'archiving', 'Uploading files');
  await updateHitProgress(hit, Math.max(step, totalSteps - 1), totalSteps, 'Uploading files');
  for (let i = 0; i < uploads.length; i++) {
    const item = uploads[i];
    if (!item || !item.name || !item.blob) {
      failedUploads.push(`upload ${i + 1}: invalid upload entry`);
      await updateHitProgress(hit, Math.min(totalSteps, 1 + i + 1), totalSteps, `Uploaded ${i + 1} / ${uploads.length}`);
      continue;
    }
    try {
      const delayMs = getPerItemDelayMs();
      if (delayMs) await sleep(delayMs);
      const ok = await uploadBlob(item.targetDir || folder, item.name, item.blob);
      if (!ok) throw new Error('upload rejected');
      uploaded.push(item.name);
      if (item.name === finalArchiveName) archiveState.mainOutputUploaded = true;
    } catch (err) {
      failedUploads.push(`${item.name}: ${err?.message || err}`);
    }
    await updateHitProgress(hit, Math.min(totalSteps, 1 + i + 1), totalSteps, `Uploaded ${i + 1} / ${uploads.length}`);
  }

  if (!archiveState.mainOutputUploaded) warnings.push('main media file was not uploaded');
  hit.archivedFiles = uploaded;
  hit.remuxRequested = remuxRequested;
  const compileOk = uploaded.some(name => /^compiled\.(?:mp4|ts)$/i.test(String(name || '')));
  const hasSegmentProblems = failedSegments > 0;
  hit.status = !archiveState.mainOutputUploaded
    ? (uploaded.length ? 'partial' : 'failed')
    : (failedUploads.length
      ? ((uploaded.length || hasSegmentProblems) ? 'partial' : 'failed')
      : (hasSegmentProblems ? 'partial' : 'archived'));
  const missingSegmentUrls = segmentMeta.filter(seg => seg.status === 'missing' && seg.uri).map(seg => seg.uri);
  hit.missingSegmentUrls = missingSegmentUrls;
  hit.missingSegmentCount = missingSegmentUrls.length;

  if (hit.status !== 'archived') {
    const segmentUris = new Set(segmentMeta.map((seg) => seg.uri).filter(Boolean));
    const extraFileEntries = [...new Map([
      ...[...keyBlobs.entries()],
      ...[...mapBlobs.entries()]
    ])].map(([uri, blob]) => {
      const localName = localMap.get(uri);
      return localName && blob ? { name: localName, blob } : null;
    }).filter(Boolean);
    const extraFileNames = [...new Set([
      ...[...localMap.entries()]
        .filter(([uri]) => uri && !segmentUris.has(uri))
        .map(([, localName]) => localName)
        .filter(Boolean)
    ])];
    storePartialArchiveState(hit, {
      folder,
      playlistName: manifestName,
      outputName: finalArchiveName,
      baseName: requestedBaseName,
      playlistText: exactPlaylist || manifestToUpload || currentText,
      sourcePlaylistText: currentText,
      sourcePlaylistUrl: currentUrl,
      createdAt: Date.now(),
      missingSegmentUrls: [...missingSegmentUrls],
      segmentMeta: segmentMeta.map((seg) => ({ ...seg, blob: seg.blob || null })),
      extraFileNames,
      extraFiles: extraFileEntries
    });
  } else {
    storePartialArchiveState(hit, null);
  }

  for (const seg of segmentMeta) {
    if (seg && seg.blob) seg.blob = null;
  }
  segmentBlobs.length = 0;
  const issueText = failedUploads.length ? failedUploads.join(' | ') : ((hasSegmentProblems || warnings.length) ? warnings.join(' | ') : '');
  hit.error = hit.status === 'archived' ? '' : issueText;
  if (hit.status !== 'archived') {
    hit.browserRemuxRequested = false;
    hit.browserRemuxSucceeded = false;
  }
  hit.progressDone = totalSteps;
  hit.progressTotal = totalSteps;
  hit.progressLabel = hit.status === 'archived' ? 'Complete' : hit.status;
  await saveHits();
  await updateBadge();

  if (hit.status === 'archived' || hit.status === 'partial') {
    await archiveAssociatedSubtitles(
      { ...hit, archivedFolder: folder },
      {
        folder,
        baseName: requestedBaseName || hit.archiveName || hit.title || '',
        subtitleBaseName: requestedBaseName || hit.archiveName || hit.title || '',
        subtitleUrls: Array.isArray(options.subtitleUrls) ? options.subtitleUrls : [],
        includeSubtitleUploads: options.includeSubtitleUploads !== false
      }
    ).catch(() => {});
  }
  if (failedUploads.length && !uploaded.length) {
    throw new Error(hit.error);
  }
  return { folder, files: uploaded, warnings, failedUploads };
}




async function retryMissingSegments(hit, options = {}) {
  await refreshConfig(true);
  if (!MEMORY.config.serverOrigin) throw new Error('Server not configured.');

  const folder = options.folder || hit.archivedFolder || buildArchiveBase(hit);
  hit.archivedFolder = folder;

  let currentText = String(hit.mediaPlaylistText || hit.sourcePlaylistText || hit.text || '').trim();
  let parsed = parsePlaylist(currentText, hit.resolvedPlaylistUrl || hit.url);
  const partial = readPartialArchiveState(hit);
  if (parsed.type !== 'media' && partial) {
    const partialSourceText = String(partial.sourcePlaylistText || '').trim();
    if (partialSourceText) {
      const partialSourceParsed = parsePlaylist(partialSourceText, partial.sourcePlaylistUrl || hit.resolvedPlaylistUrl || hit.url);
      if (partialSourceParsed.type === 'media') {
        currentText = partialSourceText;
        parsed = partialSourceParsed;
        hit.mediaPlaylistText = partialSourceText;
        hit.resolvedPlaylistUrl = partial.sourcePlaylistUrl || hit.resolvedPlaylistUrl || hit.url;
      }
    }
  }
  if (parsed.type !== 'media') {
    if (partial) {
      return await compileArchiveFromPartial(hit, {
        ...options,
        folder,
        skippedMissingSegments: false,
        allowServerFetch: false,
        finalizationMode: 'retry',
        progressLabel: 'Retrying missing segments'
      });
    }
    return await archivePlaylistHit(hit, { ...options, archiveSignal: archiveController?.signal || getActiveArchiveSignal(hit) });
  }

  const missingSet = new Set(Array.isArray(hit.missingSegmentUrls) ? hit.missingSegmentUrls.filter(Boolean) : []);
  if (!missingSet.size && partial && Array.isArray(partial.segmentMeta)) {
    for (const seg of partial.segmentMeta) {
      if (String(seg?.status || '').toLowerCase() === 'missing' && seg?.uri) missingSet.add(seg.uri);
    }
  }
  if (!missingSet.size) {
    return await compileArchiveFromPartial(hit, { ...options, folder, skippedMissingSegments: false, allowServerFetch: false, finalizationMode: 'retry' });
  }

  const allSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
  const targets = allSegments.map((seg, i) => {
    const partialSeg = findPartialSegmentByUri(partial, seg?.uri || '', i) || {};
    const extGuess = extFromUrl(seg?.uri || '', '') || extFromUrl(partialSeg?.localName || '', '') || '';
    const localName = String(partialSeg?.localName || '').trim() || `${String(i + 1).padStart(6, '0')}${extGuess}`;
    return {
      index: i,
      uri: seg?.uri || '',
      mapUri: seg?.map?.uri || '',
      localName,
      status: 'pending',
      attempts: 0,
      blob: null,
      contentType: '',
      family: '',
      ext: '',
      isInit: false,
      duration: Number(seg?.duration || 0) || 0,
      error: ''
    };
  }).filter(record => record.uri && missingSet.has(record.uri));

  if (!targets.length) {
    return await compileArchiveFromPartial(hit, { ...options, folder, skippedMissingSegments: false, allowServerFetch: false });
  }

  setArchiveStage(hit, 'downloading', 'Retrying missing segments');
  hit.error = '';
  hit.progressDone = 0;
  hit.progressTotal = targets.length;
  hit.segmentProgressDone = 0;
  hit.segmentProgressTotal = targets.length;
  hit.progressLabel = `Retrying ${targets.length} missing segment(s)`;
  hit.currentSegmentIndex = 0;
  hit.currentSegmentTotal = targets.length;
  hit.currentSegmentName = '';
  hit.currentSegmentAttempt = 1;
  hit.currentSegmentStatus = 'retrying';
  hit.currentSegmentBytes = 0;
  hit.currentSegmentBytesTotal = 0;
  hit.currentSegmentSpeedBps = 0;
  hit.currentSegmentProgress = 0;
  await saveHits();
  await updateBadge();

  const warnings = [];
  const failed = [];
  let finished = 0;

  const processRecord = async (record) => {
    let success = false;
    let lastErr = null;

    const partialSeg = findPartialSegmentByUri(partial, record.uri, record.index) || {};
    const cachedBlob = await loadPartialArchiveBlob(hit, partialSeg.localName || record.localName).catch(() => null);
    if (cachedBlob) {
      try {
        const classification = await classifyFetchedBlob(cachedBlob, record.uri, cachedBlob.type || record.contentType || '');
        record.blob = cachedBlob;
        record.contentType = cachedBlob.type || record.contentType || '';
        record.family = classification.family;
        record.ext = classification.ext || extFromUrl(record.uri, cachedBlob.type || record.contentType);
        record.isInit = !!classification.isInit;
        record.localName = `${String(record.index + 1).padStart(6, '0')}${record.ext}`;
        record.status = 'saved';
        void putPartialArchiveBlob(partialArchiveKey(hit), record.localName, record.blob).catch(() => {});
        await uploadBlob(folder, record.localName, record.blob);
        missingSet.delete(record.uri);
        hit.missingSegmentUrls = [...missingSet];
        hit.missingSegmentCount = missingSet.size;
        updatePartialArchiveSegment(hit, record, { status: 'saved', placeholder: false, missingSegmentUrls: [...missingSet] });
        hit.progressDone = targets.length - missingSet.size;
        hit.progressTotal = targets.length;
        hit.segmentProgressDone = targets.length - missingSet.size;
        hit.segmentProgressTotal = targets.length;
        hit.progressLabel = `Uploaded ${targets.length - missingSet.size} / ${targets.length} missing segment(s)`;
        void scheduleHitPersistence(false);
        success = true;
      } catch (err) {
        lastErr = err;
      }
    }

    for (let attemptNo = 1; attemptNo <= 3 && !success; attemptNo++) {
      try {
        record.attempts = attemptNo;
        record.status = 'retrying';
        await updateHitProgress(hit, finished + 1, targets.length, `Retrying segment ${record.index + 1} / ${targets.length}`, {
          currentSegmentIndex: record.index + 1,
          currentSegmentTotal: targets.length,
          currentSegmentName: record.localName,
          currentSegmentAttempt: attemptNo,
          currentSegmentStatus: record.status,
          currentSegmentBytes: 0,
          currentSegmentBytesTotal: 0,
          currentSegmentSpeedBps: 0,
          currentSegmentProgress: 0
        });
        const fetched = await fetchBlobMetaWithProgress(record.uri, {
          referrer: hit.pageUrl || hit.url,
          headers: requestHeadersFor(record.uri)
        }, (p) => {
          const loaded = Number(p?.loaded || 0) || 0;
          const total = Number(p?.total || 0) || 0;
          const pseudo = buildPseudoSegmentProgress(loaded, total);
          hit.currentSegmentIndex = pseudo.currentIndex;
          hit.currentSegmentTotal = pseudo.currentTotal;
          hit.currentSegmentName = record.localName;
          hit.currentSegmentAttempt = attemptNo;
          hit.currentSegmentStatus = 'retrying';
          hit.currentSegmentBytes = pseudo.currentBytes;
          hit.currentSegmentBytesTotal = directMediaTotalBytes;
          hit.currentSegmentSpeedBps = Number(p?.speedBps || 0) || 0;
          hit.currentSegmentProgress = pseudo.currentPct;
          hit.currentSegmentProgressLabel = pseudo.currentLabel;
          hit.currentSegmentSpeedLabel = formatRate(p?.speedBps || 0);
          hit.progressLabel = `Retrying segment ${pseudo.currentIndex} / ${pseudo.currentTotal}`;
          hit.progressDone = pseudo.segmentDone;
          hit.progressTotal = pseudo.segmentTotal;
          hit.segmentProgressDone = pseudo.segmentDone;
          hit.segmentProgressTotal = pseudo.segmentTotal;
          void scheduleHitPersistence(false);
        });

        const classification = await classifyFetchedBlob(fetched.blob, record.uri, fetched.contentType);
        record.blob = fetched.blob;
        record.contentType = fetched.contentType || '';
        record.family = classification.family;
        record.ext = classification.ext || extFromUrl(record.uri, fetched.contentType);
        record.isInit = !!classification.isInit;
        record.localName = `${String(record.index + 1).padStart(6, '0')}${record.ext}`;
        record.status = 'saved';
        void putPartialArchiveBlob(partialArchiveKey(hit), record.localName, record.blob).catch(() => {});
        await uploadBlob(folder, record.localName, record.blob);
        missingSet.delete(record.uri);
        hit.missingSegmentUrls = [...missingSet];
        hit.missingSegmentCount = missingSet.size;
        updatePartialArchiveSegment(hit, record, { status: 'saved', placeholder: false, missingSegmentUrls: [...missingSet] });
        hit.progressDone = targets.length - missingSet.size;
        hit.progressTotal = targets.length;
        hit.segmentProgressDone = targets.length - missingSet.size;
        hit.segmentProgressTotal = targets.length;
        hit.progressLabel = `Uploaded ${targets.length - missingSet.size} / ${targets.length} missing segment(s)`;
        void scheduleHitPersistence(false);
        success = true;
      } catch (err) {
        lastErr = err;
        record.status = attemptNo >= 3 ? 'missing' : 'retrying';
        record.error = String(err?.message || err || 'unknown error');
        if (attemptNo < 3) {
          hit.progressLabel = `Retrying missing segment ${record.index + 1} (attempt ${attemptNo + 1} of 3)`;
          void scheduleHitPersistence(false);
        }
      }
    }
    if (!success) {
      warnings.push(`segment ${record.index + 1}: ${String(lastErr?.message || lastErr || 'unknown error')}`);
    }
    finished += 1;
    await updateHitProgress(hit, Math.min(targets.length, finished), targets.length, missingSet.size ? 'Retrying missing segments' : 'Compiling archive');
    if (!success) failed.push(record);
  };

  const retryConcurrency = Math.max(1, Math.min(Number(ARCHIVE_TUNING.segmentFetchConcurrency || 1), targets.length));
  await runWithConcurrency(targets, retryConcurrency, processRecord);

  hit.missingSegmentUrls = [...missingSet];
  hit.missingSegmentCount = missingSet.size;
  hit.archivedFolder = folder;
  hit.status = missingSet.size ? (targets.length - missingSet.size ? 'partial' : 'failed') : 'archiving';
  hit.error = warnings.length ? warnings.join(' | ') : '';
  hit.progressDone = targets.length - missingSet.size;
  hit.progressTotal = targets.length;
  hit.segmentProgressDone = targets.length - missingSet.size;
  hit.segmentProgressTotal = targets.length;
  hit.progressLabel = missingSet.size ? 'Retrying missing segments' : 'Compiling archive';
  await saveHits();
  await updateBadge();

  if (missingSet.size) {
    const partial = readPartialArchiveState(hit);
    if (partial) {
      partial.missingSegmentUrls = [...missingSet];
      storePartialArchiveState(hit, partial);
    }
    if (targets.length - missingSet.size <= 0) {
      throw new Error(hit.error || 'Missing segments still unavailable.');
    }
    return { folder, files: [], warnings, failedUploads: failed.map(r => `${r.localName}: ${r.error}`), partial: true };
  }

  return await compileArchiveFromPartial(hit, { ...options, folder, skippedMissingSegments: false });
}


async function finalizeSkippedSegments(hit, options = {}) {
  await refreshConfig(true);
  if (!MEMORY.config.serverOrigin) throw new Error('Server not configured.');

  const folder = options.folder || hit.archivedFolder || buildArchiveBase(hit);
  hit.archivedFolder = folder;

  const parsed = parsePlaylist(hit.text || '', hit.url);
  const partial = readPartialArchiveState(hit);
  if (parsed.type !== 'media') {
    if (partial) {
      return await compileArchiveFromPartial(hit, {
        ...options,
        folder,
        skippedMissingSegments: true,
        allowServerFetch: false,
        finalizationMode: 'skip',
        progressLabel: 'Finalizing archive after skipped segments'
      });
    }
    return await archivePlaylistHit(hit, { ...options, archiveSignal: archiveController?.signal || getActiveArchiveSignal(hit) });
  }
  if (!partial) {
    throw new Error('No partial archive data is available to finalize.');
  }


  return await compileArchiveFromPartial(hit, {
    ...options,
    folder,
    skippedMissingSegments: true,
    allowServerFetch: false,
    finalizationMode: 'skip',
    progressLabel: 'Finalizing archive after skipped segments'
  });
}
async function archiveDirectMediaHit(hit, options = {}) {
  await refreshConfig(true);
  if (!MEMORY.config.serverOrigin) throw new Error('Server not configured.');

  const archiveSignal = options.archiveSignal || getActiveArchiveSignal(hit) || null;

  setArchiveStage(hit, 'downloading', 'Fetching media');
  hit.error = '';
  hit.progressDone = 0;
  hit.progressTotal = 0;
  await saveHits();
  await updateBadge();

  const folder = options.folder || buildArchiveBase(hit);
  hit.archivedFolder = folder;
  const directMediaTotalBytes = Math.max(0, Number(hit.sourceSize || 0) || 0);
  if (directMediaTotalBytes > 0) {
    const pseudo = buildPseudoSegmentProgress(0, directMediaTotalBytes);
    hit.segmentProgressDone = 0;
    hit.segmentProgressTotal = pseudo.segmentTotal;
    hit.currentSegmentIndex = 1;
    hit.currentSegmentTotal = pseudo.currentTotal;
    hit.currentSegmentBytes = 0;
    hit.currentSegmentBytesTotal = directMediaTotalBytes;
    hit.currentSegmentSpeedBps = 0;
    hit.currentSegmentProgress = 0;
    hit.currentSegmentProgressLabel = `0 B / ${formatBytes(directMediaTotalBytes)}`;
    hit.currentSegmentStatus = 'downloading';
  }

  const requestedBaseName = archiveBaseName(hit, options.outputName || options.archiveName || '');
  const finalArchiveName = archiveOutputName(hit, requestedBaseName);
  hit.archiveName = requestedBaseName;
  if (requestedBaseName) hit.title = requestedBaseName;

  const meta = {
    sourceUrl: hit.url,
    pageUrl: hit.pageUrl,
    title: hit.archiveName || hit.title,
    kind: hit.kind,
    detectedAt: new Date(hit.ts || Date.now()).toISOString(),
    platform: MEMORY.config.platform,
    serverOrigin: MEMORY.config.serverOrigin,
    folder,
    fileName: finalArchiveName,
    sourceSize: Number(hit.sourceSize || 0)
  };

  const uploads = [];
  const warnings = [];
  const archiveState = { mainOutputUploaded: false };
  try {
    const delayMs = getPerItemDelayMs();
    if (delayMs) await sleep(delayMs);
    const baseHeaders = requestHeadersFor(hit.url);
    const attempts = [
      baseHeaders,
      { ...baseHeaders, Range: 'bytes=0-' },
      {},
    ];
    const timeoutMs = Math.max(
      10 * 60 * 1000,
      Number(hit.sourceSize || 0) > 0 ? Math.min(30 * 60 * 1000, Math.ceil(Number(hit.sourceSize || 0) / (10 * 1024 * 1024)) * 60 * 1000) : 0
    );
    let fetched = null;
    let lastErr = null;
    for (const headers of attempts) {
      try {
        fetched = await fetchBlobMeta(hit.url, {
          referrer: hit.pageUrl || hit.url,
          headers,
          timeoutMs,
          credentials: 'include',
          expectedTotalBytes: directMediaTotalBytes
        }, (p) => {
          const loaded = Number(p?.loaded || 0) || 0;
          const total = Number(p?.total || 0) || 0;
          const pseudo = buildPseudoSegmentProgress(loaded, total || directMediaTotalBytes);
          hit.currentSegmentIndex = pseudo.currentIndex;
          hit.currentSegmentTotal = pseudo.currentTotal;
          hit.currentSegmentBytes = pseudo.currentBytes;
          hit.currentSegmentBytesTotal = total || directMediaTotalBytes || pseudo.currentBytesTotal;
          hit.currentSegmentProgress = pseudo.currentPct;
          hit.currentSegmentProgressLabel = pseudo.currentLabel;
          hit.currentSegmentSpeedBps = Number(p?.speedBps || 0) || 0;
          hit.currentSegmentSpeedLabel = formatRate(p?.speedBps || 0);
          hit.segmentProgressDone = pseudo.segmentDone;
          hit.segmentProgressTotal = pseudo.segmentTotal;
          hit.progressDone = pseudo.segmentDone;
          hit.progressTotal = pseudo.segmentTotal;
          hit.progressLabel = `Downloading chunk ${pseudo.currentIndex} / ${pseudo.currentTotal}`;
          if (!hit._lastProgressSave || Date.now() - hit._lastProgressSave >= 2000 || p?.done) {
            hit._lastProgressSave = Date.now();
            void scheduleHitPersistence(!!p?.done);
          }
        });
        const type = String(fetched?.contentType || '').toLowerCase();
        if (!fetched?.blob || fetched.blob.size <= 0) throw new Error('empty media response');
        if (/^text\//i.test(type) || /html/i.test(type)) throw new Error(`unexpected content type ${type || 'unknown'}`);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!fetched?.blob) throw lastErr || new Error('Could not fetch media');
    if (Number(hit.sourceSize || 0) > 0 && Math.abs(fetched.blob.size - Number(hit.sourceSize || 0)) > 1024 * 256) {
      warnings.push(`size mismatch: fetched ${fetched.blob.size} bytes vs expected ${Number(hit.sourceSize || 0)} bytes`);
    }
    const totalBytes = Number(fetched?.contentLength || 0) || directMediaTotalBytes || Number(fetched?.blob?.size || 0) || 0;
    const pseudo = buildPseudoSegmentProgress(totalBytes, totalBytes);
    hit.segmentProgressDone = pseudo.segmentTotal;
    hit.segmentProgressTotal = pseudo.segmentTotal;
    hit.currentSegmentIndex = pseudo.currentTotal;
    hit.currentSegmentTotal = pseudo.currentTotal;
    hit.currentSegmentBytes = pseudo.currentBytes;
    hit.currentSegmentBytesTotal = totalBytes;
    hit.currentSegmentProgress = pseudo.currentPct;
    hit.currentSegmentProgressLabel = pseudo.currentLabel;
    hit.currentSegmentSpeedBps = 0;
    hit.currentSegmentSpeedLabel = '';
    hit.currentSegmentStatus = 'saved';
    hit.progressDone = pseudo.segmentTotal;
    hit.progressTotal = pseudo.segmentTotal;
    hit.progressLabel = 'Downloaded media';
    uploads.push({ name: finalArchiveName, blob: fetched.blob });
  } catch (err) {
      warnings.push(`media fetch failed: ${err?.message || err}`);
      uploads.push({ name: 'source-url.txt', blob: new Blob([`${hit.url}\n`], { type: 'text/plain' }) });
    }
  uploads.push({ name: 'meta.json', blob: new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }) });
  if (warnings.length) {
    uploads.push({ name: 'issues.txt', blob: new Blob([warnings.join('\n') + '\n'], { type: 'text/plain' }) });
  }

  const totalSteps = Math.max(1, uploads.length + 1);
  const uploaded = [];
  const failedUploads = [];
  setArchiveStage(hit, 'archiving', 'Uploading media');
  hit.progressDone = 1;
  hit.progressTotal = totalSteps;
  await saveHits();
  for (let i = 0; i < uploads.length; i++) {
    const item = uploads[i];
    if (!item || !item.name || !item.blob) {
      failedUploads.push(`upload ${i + 1}: invalid upload entry`);
      await updateHitProgress(hit, Math.min(totalSteps, 1 + i + 1), totalSteps, `Uploaded ${i + 1} / ${uploads.length}`);
      continue;
    }
    try {
      const delayMs = getPerItemDelayMs();
      if (delayMs) await sleep(delayMs);
      const ok = await uploadBlob(item.targetDir || folder, item.name, item.blob);
      if (!ok) throw new Error('upload rejected');
      uploaded.push(item.name);
      if (item.name === finalArchiveName) archiveState.mainOutputUploaded = true;
    } catch (err) {
      failedUploads.push(`${item.name}: ${err?.message || err}`);
    }
    hit.progressDone = Math.min(totalSteps, 1 + i + 1);
    hit.progressTotal = totalSteps;
    hit.progressLabel = `Uploaded ${i + 1} / ${uploads.length}`;
    await saveHits();
  }

  if (!archiveState.mainOutputUploaded) warnings.push('main media file was not uploaded');
  hit.status = !archiveState.mainOutputUploaded
    ? (uploaded.length ? 'partial' : 'failed')
    : (failedUploads.length
      ? (uploaded.length ? 'partial' : 'failed')
      : 'archived');
  hit.archivedFiles = uploaded;
  hit.error = failedUploads.length ? failedUploads.join(' | ') : (warnings.length ? warnings.join(' | ') : '');
  hit.progressDone = totalSteps;
  hit.progressTotal = totalSteps;
  hit.progressLabel = hit.status === 'archived' ? 'Complete' : hit.status;
  await saveHits();
  await updateBadge();

  if (hit.status === 'archived' || hit.status === 'partial') {
    await archiveAssociatedSubtitles(
      { ...hit, archivedFolder: folder },
      {
        folder,
        baseName: requestedBaseName || hit.archiveName || hit.title || '',
        subtitleBaseName: requestedBaseName || hit.archiveName || hit.title || '',
        subtitleUrls: Array.isArray(options.subtitleUrls) ? options.subtitleUrls : [],
        includeSubtitleUploads: options.includeSubtitleUploads !== false
      }
    ).catch(() => {});
  }

  if (failedUploads.length && !uploaded.length) {
    throw new Error(hit.error);
  }
  return { folder, files: uploaded, warnings, failedUploads };
}


async function archiveHit(hit, options = {}) {
  if (!hit) throw new Error('Missing hit.');
  const kind = String(hit.kind || '').toLowerCase();
  const tabId = Number(hit.tabId || 0) || 0;
  const selectedSubtitleUrls = [
    ...(Array.isArray(options.subtitleUrls) ? options.subtitleUrls : []),
    ...(Array.isArray(hit.selectedSubtitleUrls) ? hit.selectedSubtitleUrls : []),
    ...(hit.selectedSubtitleUrl ? [hit.selectedSubtitleUrl] : [])
  ].map(v => String(v || '').trim()).filter(Boolean);
  if (selectedSubtitleUrls.length) {
    hit.selectedSubtitleUrls = [...new Set(selectedSubtitleUrls)];
    hit.selectedSubtitleUrl = hit.selectedSubtitleUrls[0] || '';
  }
  if (options.subtitleBaseName || hit.subtitleBaseName) {
    hit.subtitleBaseName = String(options.subtitleBaseName || hit.subtitleBaseName || '').trim();
  }
  await setTabListeningPaused(tabId, true);
  const archiveController = beginArchiveCancellation(hit);
  try {
    if (kind === 'playlist') {
      const missingUrls = Array.isArray(hit.missingSegmentUrls) ? hit.missingSegmentUrls.filter(Boolean) : [];
      if (missingUrls.length && String(hit.status || '').toLowerCase() !== 'archived') {
        if (options.skipMissingSegments) {
          return await finalizeSkippedSegments(hit, options);
        }
        if (options.retryMissingSegments) {
          return await retryMissingSegments(hit, options);
        }
        hit.status = hit.status === 'archived' ? 'archived' : (hit.status === 'queued' ? 'queued' : 'partial');
        hit.error = `${missingUrls.length} missing segment(s) are still unavailable. Retry missing to fetch them from the internet, or Skip missing to remux the partial archive.`;
        hit.missingSegmentUrls = missingUrls;
        hit.missingSegmentCount = missingUrls.length;
        await saveHits();
        await updateBadge();
        return { folder: hit.archivedFolder || buildArchiveBase(hit), files: [], warnings: [hit.error], failedUploads: [] };
      }
      return await archivePlaylistHit(hit, { ...options, archiveSignal: archiveController?.signal || getActiveArchiveSignal(hit), includeSubtitleUploads: options.includeSubtitleUploads !== false });
    }
    if (kind === 'media' || (kind === 'dom-media' && MEMORY.settings.captureDirectMedia)) return await archiveDirectMediaHit(hit, { ...options, archiveSignal: archiveController?.signal || getActiveArchiveSignal(hit), includeSubtitleUploads: options.includeSubtitleUploads !== false });
    if (kind === 'subtitle') return await archiveSubtitleHit(hit, { ...options, archiveSignal: archiveController?.signal || getActiveArchiveSignal(hit) });
    if (kind === 'text' || kind === 'document') return await archiveGenericTextHit(hit, options);
    throw new Error(`Unsupported hit type: ${hit.kind}`);
  } finally {
    endArchiveCancellation(hit);
    await setTabListeningPaused(tabId, false);
  }
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function injectIntoTab(tabId) {
  if (!tabId || MEMORY.injectQueue.has(tabId)) return;
  MEMORY.injectQueue.add(tabId);
  const pageConfig = {
    serverOrigin: String(MEMORY.config?.serverOrigin || ''),
    archiveFolder: String(MEMORY.config?.archiveFolder || '/videodownloader/'),
    uploadBase: String(MEMORY.config?.uploadBase || '')
  };
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (cfg) => {
        try { window.__SFA_SERVER_CONFIG__ = cfg || {}; } catch {}
      },
      args: [pageConfig]
    });
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['page-hook.js']
    });
  } catch {}
  MEMORY.injectQueue.delete(tabId);
}


async function boot() {
  await loadState();
  const before = MEMORY.hits.length;
  MEMORY.hits = MEMORY.hits.filter(h => !(h && h.kind === 'media' && isHlsSegmentUrl(h.url, h.contentType)));
  if (MEMORY.hits.length !== before) await saveHits();
  await refreshConfig(true);
  if (purgeInternalHits()) await saveHits();
  await injectIntoAllTabs();
  await updateBadge();
  MEMORY.initialised = true;
}

chrome.runtime.onInstalled.addListener(() => { boot().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { boot().catch(() => {}); });
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && isHttpUrl(details.url)) injectIntoTab(details.tabId);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0 && isHttpUrl(details.url)) injectIntoTab(details.tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isHttpUrl(tab.url)) injectIntoTab(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (Number.isFinite(Number(tabId))) setTabMonitoringState(tabId, true);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STATE_KEYS.settings]) {
    MEMORY.settings = { ...DEFAULT_SETTINGS, ...(changes[STATE_KEYS.settings].newValue || {}) };
    refreshConfig(true).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'FRAME_READY') {
      if (sender?.tab?.id) {
        if (msg?.payload?.pageUrl) {
          MEMORY.tabPageUrlByTabId.set(sender.tab.id, String(msg.payload.pageUrl || '').trim());
        }
        setTabMonitoringState(sender.tab.id, msg?.payload?.visible !== false);
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'PAGE_HIT') {
      const payload = { ...(msg.payload || {}) };
      if (sender?.tab) {
        payload.tabId = sender.tab.id;
        payload.pageUrl = payload.pageUrl || sender.tab.url || '';
        payload.title = payload.title || sender.tab.title || '';
        if (payload.pageUrl) MEMORY.tabPageUrlByTabId.set(sender.tab.id, String(payload.pageUrl || '').trim());
      }
      if (payload.kind === 'page-session') {
        const tabId = sender?.tab?.id;
        if (Number.isFinite(Number(tabId))) {
          const nextSession = Number(payload.sessionId || 0) || 0;
          const prevSession = Number(MEMORY.tabSessionByTabId.get(tabId) || 0) || 0;
          const pageUrl = String(payload.pageUrl || sender?.tab?.url || '').trim();
          MEMORY.tabSessionByTabId.set(tabId, Math.max(prevSession, nextSession));
          if (pageUrl) MEMORY.tabPageUrlByTabId.set(tabId, pageUrl);
          if (!prevSession || nextSession > prevSession) {
            const removed = clearHitsForTab(tabId);
            if (removed) {
              await saveHits();
              await updateBadge();
            }
          }
        }
        sendResponse({ ok: true });
        return;
      }
      if (payload.kind === 'monitor-state') {
        if (sender?.tab?.id) setTabMonitoringState(sender.tab.id, payload.visible !== false && payload.paused !== true);
        sendResponse({ ok: true });
        return;
      }
      if (sender?.tab?.id && !isTabMonitoringEnabled(sender.tab.id)) {
        sendResponse({ ok: true, ignored: true });
        return;
      }
      if (typeof payload.tabId !== 'number' || !payload.tabId) payload.tabId = sender?.tab?.id || 0;
      if (isInternalHit(payload)) {
        sendResponse({ ok: true, ignored: true });
        return;
      }
      if (payload.kind === 'playlist' && payload.text) {
        const meta = describePlaylist(payload.text, payload.url);
        payload.quality = meta.quality || payload.quality || '';
        payload.playlistType = meta.playlistType || payload.playlistType || '';
        payload.variantCount = meta.variantCount || payload.variantCount || 0;
        payload.segmentCount = meta.segmentCount || payload.segmentCount || 0;
        payload.variants = meta.variants || payload.variants || [];
      }
      const hit = await registerHit(payload);
      if (hit && MEMORY.settings.autoArchive && (hit.kind === 'playlist' || hit.kind === 'media' || hit.kind === 'subtitle')) {
        try {
          if (hit.kind === 'subtitle' && !hitMatchesEnglishSubtitlePolicy(hit)) {
            hit.status = 'skipped';
            hit.error = 'Subtitle does not look English';
            await saveHits();
            await updateBadge();
          } else {
            await archiveHit(hit);
          }
        } catch (err) {
          hit.status = 'failed';
          hit.retainOnClear = true;
        hit.error = String(err?.message || err);
          await saveHits();
          await updateBadge();
        }
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'GET_STATE') {
      await refreshConfig();
      sendResponse({
        ok: true,
        settings: MEMORY.settings,
        config: MEMORY.config,
        hits: dedupeHitsForDisplay(MEMORY.hits).slice(0, 80)
      });
      return;
    }
    if (msg?.type === 'SAVE_SETTINGS') {
      await saveSettings(msg.payload || {});
      sendResponse({ ok: true, settings: MEMORY.settings, config: MEMORY.config });
      return;
    }
    if (msg?.type === 'REFRESH_CONFIG') {
      await refreshConfig(true);
      sendResponse({ ok: true, config: MEMORY.config });
      return;
    }
    if (msg?.type === 'GET_SUBTITLE_PREVIEW') {
      const hit = MEMORY.hits.find(h => h.id === msg.id || h.key === msg.key);
      if (!hit) { sendResponse({ ok: false, error: 'Hit not found' }); return; }
      try {
        const result = await previewSubtitleHit(hit, { baseName: msg.baseName || '', subtitleCount: Number(msg.subtitleCount || 0) || 0, subtitleIndex: Number(msg.subtitleIndex || 0) || 0 });
        sendResponse({ ok: true, ...result, hit });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return;
    }
    if (msg?.type === 'RETRY_MISSING_SEGMENTS') {
      const hit = MEMORY.hits.find(h => h.id === msg.id || h.key === msg.key);
      if (!hit) { sendResponse({ ok: false, error: 'Hit not found' }); return; }
      try {
        const result = await retryMissingSegments(hit, { outputName: msg.outputName || '', variantUrl: msg.variantUrl || '' });
        sendResponse({ ok: true, result, hit });
      } catch (err) {
        hit.status = 'failed';
        hit.retainOnClear = true;
        hit.error = String(err?.message || err);
        await saveHits();
        await updateBadge();
        sendResponse({ ok: false, error: hit.error, hit });
      }
      return;
    }
    if (msg?.type === 'SKIP_MISSING_SEGMENTS') {
      const hit = MEMORY.hits.find(h => h.id === msg.id || h.key === msg.key);
      if (!hit) { sendResponse({ ok: false, error: 'Hit not found' }); return; }
      try {
        const result = await finalizeSkippedSegments(hit, { outputName: msg.outputName || '', variantUrl: msg.variantUrl || '' });
        sendResponse({ ok: true, result, hit });
      } catch (err) {
        hit.status = 'failed';
        hit.retainOnClear = true;
        hit.error = String(err?.message || err);
        await saveHits();
        await updateBadge();
        sendResponse({ ok: false, error: hit.error, hit });
      }
      return;
    }
    if (msg?.type === 'PAUSE_TAB_LISTENING') {
      const tabId = Number(msg.tabId || 0) || Number(sender?.tab?.id || 0) || 0;
      if (tabId) await setTabListeningPaused(tabId, !!msg.paused);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'ARCHIVE_HIT') {
      const fallback = msg.hitData && typeof msg.hitData === 'object' ? msg.hitData : null;
      const hit = MEMORY.hits.find(h =>
        h.id === msg.id ||
        h.key === msg.key ||
        (fallback && (h.id === fallback.id || h.key === fallback.key)) ||
        (fallback && fallback.url && h.url === fallback.url && h.tabId === fallback.tabId) ||
        (fallback && fallback.resolvedUrl && h.resolvedUrl === fallback.resolvedUrl && h.tabId === fallback.tabId)
      ) || null;
      if (!hit) { sendResponse({ ok: false, error: 'Hit not found' }); return; }
      const explicitSubtitleUrls = [
        ...(Array.isArray(msg.subtitleUrls) ? msg.subtitleUrls : []),
        ...(Array.isArray(fallback?.selectedSubtitleUrls) ? fallback.selectedSubtitleUrls : []),
        ...(fallback?.selectedSubtitleUrl ? [fallback.selectedSubtitleUrl] : []),
        ...(Array.isArray(hit.selectedSubtitleUrls) ? hit.selectedSubtitleUrls : []),
        ...(hit.selectedSubtitleUrl ? [hit.selectedSubtitleUrl] : [])
      ].map(v => String(v || '').trim()).filter(Boolean);
      const subtitleBaseName = String(msg.subtitleBaseName || fallback?.subtitleBaseName || hit.subtitleBaseName || msg.outputName || fallback?.outputName || hit.archiveName || hit.title || '').trim();

      // Mark the item as active immediately so a follow-up CLEAR_HITS call
      // preserves the stream that is about to archive.
      hit.status = 'queued';
      hit.error = '';
      hit.progressLabel = 'Starting archive';
      hit.progressDone = Number(hit.progressDone || 0);
      hit.progressTotal = Number(hit.progressTotal || 0);
      await saveHits();
      await updateBadge();

      sendResponse({ ok: true, started: true, hit });

      try {
        await archiveHit(hit, {
          outputName: msg.outputName || '',
          variantUrl: msg.variantUrl || '',
          subtitleUrls: [...new Set(explicitSubtitleUrls)],
          subtitleBaseName,
          skipMissingSegments: !!msg.skipMissingSegments,
          folder: msg.folder || '',
          includeSubtitleUploads: msg.includeSubtitleUploads !== false
        });
      } catch (err) {
        hit.status = 'failed';
        hit.retainOnClear = true;
        hit.error = String(err?.message || err);
        await saveHits();
        await updateBadge();
      }
      return;
    }
    if (msg?.type === 'CLEAR_HITS') {
      const before = MEMORY.hits.length;
      MEMORY.hits = MEMORY.hits.filter(shouldKeepHitDuringMassClear);
      MEMORY.hitMap = new Map(MEMORY.hits.filter(h => h && h.key).map(h => [h.key, h]));
      await saveHits();
      await updateBadge();
      sendResponse({ ok: true, removed: before - MEMORY.hits.length, kept: MEMORY.hits.length });
      return;
    }
    if (msg?.type === 'CLEAR_HIT') {
      const hit = MEMORY.hits.find(h => h.id === msg.id || h.key === msg.key);
      if (!hit) { sendResponse({ ok: false, error: 'Hit not found' }); return; }
      const activeStatus = String(hit.status || '').toLowerCase();
      if (activeStatus === 'cancelled') {
        const before = MEMORY.hits.length;
        MEMORY.hits = MEMORY.hits.filter(h => h !== hit && h.id !== msg.id && h.key !== msg.key);
        MEMORY.hitMap = new Map(MEMORY.hits.filter(h => h && h.key).map(h => [h.key, h]));
        if (hit.key) {
          MEMORY.partialArchives.delete(hit.key);
          MEMORY.partialArchiveBlobs.delete(hit.key);
        }
        await clearPartialArchiveBlobCache(hit).catch(() => {});
        await saveHits();
        await updateBadge();
        sendResponse({ ok: true, removed: before - MEMORY.hits.length });
        return;
      }
      const isActiveArchive = activeStatus === 'archiving' || activeStatus === 'queued' || (Number(hit.progressTotal || 0) > 0 && Number(hit.progressDone || 0) < Number(hit.progressTotal || 0));
      if (isActiveArchive) {
        cancelArchiveHit(hit);
        await saveHits();
        await updateBadge();
        sendResponse({ ok: true, removed: 0, cancelled: true });
        return;
      }
      const before = MEMORY.hits.length;
      MEMORY.hits = MEMORY.hits.filter(h => h !== hit && h.id !== msg.id && h.key !== msg.key);
      MEMORY.hitMap = new Map(MEMORY.hits.filter(h => h && h.key).map(h => [h.key, h]));
      if (hit.key) {
        MEMORY.partialArchives.delete(hit.key);
        MEMORY.partialArchiveBlobs.delete(hit.key);
      }
      await clearPartialArchiveBlobCache(hit).catch(() => {});
      await saveHits();
      await updateBadge();
      sendResponse({ ok: true, removed: before - MEMORY.hits.length });
      return;
    }
    if (msg?.type === 'SKIP_HIT') {
      const hit = MEMORY.hits.find(h => h.id === msg.id || h.key === msg.key);
      if (!hit) { sendResponse({ ok: false, error: 'Hit not found' }); return; }
      hit.status = 'skipped';
      hit.error = hit.error ? String(hit.error) : 'Skipped missing segments';
      hit.progressLabel = 'Skipped';
      hit.progressDone = Number(hit.progressDone || 0);
      hit.progressTotal = Number(hit.progressTotal || 0);
      await saveHits();
      await updateBadge();
      sendResponse({ ok: true, hit });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown message' });
  })().catch(err => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true;
});

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (Number.isFinite(Number(details.tabId)) && !isTabMonitoringEnabled(details.tabId)) return;
  const headers = details.responseHeaders || [];
  const ct = (headers.find(h => h.name && h.name.toLowerCase() === 'content-type')?.value || '').toLowerCase();
  const cd = headers.find(h => h.name && h.name.toLowerCase() === 'content-disposition')?.value || '';
  const cl = Number(headers.find(h => h.name && h.name.toLowerCase() === 'content-length')?.value || 0) || 0;
  const url = details.url || '';
  if (isInternalUrl(url) || isInternalUrl(details.documentUrl) || isInternalUrl(details.initiator)) return;
  const looksPlaylist = /(?:\.(?:m3u8?|m3u))(?:$|[?#])/i.test(url) || /mpegurl|vnd\.apple\.mpegurl|application\/x-mpegurl/i.test(ct);
  const looksHtmlDownload = /^text\/html/i.test(ct);
  const looksTextDownload = looksLikeTextDownloadUrl(url, ct, cd) || looksHtmlDownload;
  const ignoreGifTxtDownloads = !!MEMORY.settings.ignoreGifTxtDownloads && (looksLikeGifDownloadUrl(url, ct, cd) || looksLikeTxtDownloadUrl(url, ct, cd) || looksHtmlDownload);
  if (ignoreGifTxtDownloads) return;
  const looksDirectMedia = MEMORY.settings.captureDirectMedia && looksLikeVideoResponse(url, ct, cd, requestHeaderMap(url));
  const looksSubtitle = MEMORY.settings.captureSubtitleFiles && looksLikeSubtitleUrl(url, ct, cd) && !looksLikeHlsSubtitleNoise(url, ct, cd);
  const looksText = MEMORY.settings.captureTextDownloads && looksTextDownload;

  if (!looksPlaylist && !looksDirectMedia && !looksSubtitle && !looksText) return;

  const exactPageUrl = MEMORY.tabPageUrlByTabId.get(details.tabId) || '';
  if (looksSubtitle && !exactPageUrl) return;
  const payload = {
    kind: looksPlaylist ? 'playlist' : (looksSubtitle ? 'subtitle' : (looksText ? 'text' : 'media')),
    url,
    contentType: ct,
    contentDisposition: cd,
    sourceSize: cl,
    pageUrl: exactPageUrl || details.documentUrl || details.initiator || '',
    tabId: Number(details.tabId || 0),
    title: '',
    ts: Date.now(),
    source: 'webRequest'
  };
  registerHit(payload).then(hit => {
    if (hit && MEMORY.settings.autoArchive && hit.kind === 'playlist') {
      archiveHit(hit).catch(async (err) => {
        hit.status = 'failed';
        hit.retainOnClear = true;
        hit.error = String(err?.message || err);
        await saveHits();
        await updateBadge();
      });
    }
  }).catch(() => {});
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

boot().catch(() => {});


chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  const url = details.url || '';
  if (isInternalUrl(url) || isInternalUrl(details.documentUrl) || isInternalUrl(details.initiator)) return;
  if (!details.requestHeaders) return;
  if (!(MEMORY.requestHeaders instanceof Map)) MEMORY.requestHeaders = new Map();
  MEMORY.requestHeaders.set(url, details.requestHeaders.map(h => ({ name: h.name, value: h.value })));
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);
