const ALLOWED_TYPES = new Set([
  'UD_PROXY_REQUEST',
  'UD_PROXY_DOWNLOAD',
  'UD_FLOW_TRANSFER',
  'UD_FLOW_READY',
  'UD_ACTIVITY_STATE',
  'UD_SETTINGS_UPDATE'
]);

const SETTINGS_KEY = 'ud_music_proxy_settings';
const LOCAL_TASK_FALLBACK = 'http://localhost:8084/';
const LOCAL_PROXY_FALLBACK = 'http://localhost:8084/proxy';
const LOCAL_DOWNLOAD_FALLBACK = 'http://localhost:8084/download';
const DEFAULT_FLOW_PAGE = 'musiclib.html';
const SETUP_PAGE = 'setup.html';
const ICON_PATHS = {
  idle: {
    16: 'icons/idle-16.png',
    32: 'icons/idle-32.png',
    48: 'icons/idle-48.png',
    128: 'icons/idle-128.png'
  },
  busy: {
    16: 'icons/busy-16.png',
    32: 'icons/busy-32.png',
    48: 'icons/busy-48.png',
    128: 'icons/busy-128.png'
  }
};
const transferStore = new Map();

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

async function setActionState(activity = {}) {
  const state = String(activity.state || activity.status || 'idle').toLowerCase();
  const busy = state === 'busy' || state === 'downloading' || state === 'working';
  const error = state === 'error' || state === 'failed';
  const percent = clampPercent(activity.progress);
  const title = String(activity.title || activity.phase || (busy ? 'Downloading…' : 'Music Archiver Relay')).trim();
  const detail = String(activity.detail || activity.message || '').trim();

  try { await chrome.action.setIcon({ path: busy ? ICON_PATHS.busy : ICON_PATHS.idle }); } catch {}
  try { await chrome.action.setBadgeBackgroundColor({ color: error ? '#dc2626' : busy ? '#d97706' : '#2f855a' }); } catch {}
  try {
    await chrome.action.setBadgeText({
      text: error ? '!' : busy ? (percent != null ? `${percent}%` : 'DL') : ''
    });
  } catch {}
  try { await chrome.action.setTitle({ title: detail ? `${title} — ${detail}` : title }); } catch {}
  return { ok: true, state, busy, error, percent };
}

function safeUrl(input, fallback) {
  try {
    return new URL(String(input || '').trim() || fallback);
  } catch {
    return new URL(fallback);
  }
}

function extractPortFromUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return '';
  }
}

function buildStorageUrl(host, port, path) {
  const hostValue = String(host || '').trim();
  const portValue = String(port || '').trim();
  const pathValue = String(path || '/musiclib.html').trim() || '/musiclib.html';
  let baseUrl;
  if (!hostValue) return '';
  try {
    baseUrl = new URL(/^https?:\/\//i.test(hostValue) ? hostValue : `http://${hostValue}`);
  } catch {
    return '';
  }
  if (portValue) baseUrl.port = portValue;
  const url = new URL(pathValue.startsWith('/') ? pathValue : `/${pathValue}`, baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`);
  return url.href;
}

function normalizeStorageUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const pathname = String(url.pathname || '').trim();
    if (!pathname || pathname === '/') {
      url.pathname = `/${DEFAULT_FLOW_PAGE}`;
    }
    return url.href;
  } catch {
    return raw;
  }
}

function storageUrlToLegacyFields(storageUrl) {
  const url = safeUrl(storageUrl, `http://localhost/${DEFAULT_FLOW_PAGE}`);
  return {
    musicLibHost: `${url.protocol}//${url.hostname}`,
    musicLibPort: url.port || (url.protocol === 'https:' ? '443' : '80'),
    musicLibPath: `${url.pathname || `/${DEFAULT_FLOW_PAGE}`}${url.search || ''}${url.hash || ''}` || `/${DEFAULT_FLOW_PAGE}`
  };
}

function normalizeProxyOrigin(proxyUrl, proxyPort) {
  const raw = String(proxyUrl || '').trim();
  const fallback = 'http://localhost:8084';
  const url = safeUrl(raw || fallback, fallback);
  if (proxyPort != null && String(proxyPort).trim()) {
    url.port = String(proxyPort).trim();
  }
  return url.origin;
}

function normalizeSettings(raw = {}) {
  const storageUrl = normalizeStorageUrl(raw.musicStorageUrl || raw.storageUrl || '');
  const legacy = storageUrl ? storageUrlToLegacyFields(storageUrl) : {
    musicLibHost: String(raw.musicLibHost || '').trim(),
    musicLibPort: String(raw.musicLibPort || '').trim(),
    musicLibPath: String(raw.musicLibPath || '').trim()
  };
  const proxyUrl = String(raw.musicProxyUrl || raw.proxyUrl || '').trim();
  const proxyPort = String(raw.musicProxyPort || raw.proxyPort || '').trim() || extractPortFromUrl(proxyUrl);
  const next = {
    musicStorageUrl: storageUrl || buildStorageUrl(legacy.musicLibHost, legacy.musicLibPort, legacy.musicLibPath),
    musicProxyUrl: proxyUrl,
    musicProxyPort: proxyPort
  };

  return {
    ...legacy,
    ...next,
    musicLibHost: legacy.musicLibHost || 'http://localhost',
    musicLibPort: legacy.musicLibPort || '',
    musicLibPath: legacy.musicLibPath || `/${DEFAULT_FLOW_PAGE}`
  };
}

async function loadStoredSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return stored?.[SETTINGS_KEY] || {};
}

async function loadSettings() {
  return normalizeSettings(await loadStoredSettings());
}

async function saveSettings(nextSettings = {}) {
  const normalized = normalizeSettings(nextSettings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

function buildTaskPageUrl(sourceUrl, settings) {
  const proxyOrigin = normalizeProxyOrigin(settings?.musicProxyUrl, settings?.musicProxyPort);
  const storageUrl = settings?.musicStorageUrl || buildStorageUrl(settings?.musicLibHost, settings?.musicLibPort, settings?.musicLibPath);
  const taskUrl = new URL('/', `${proxyOrigin}/`);
  if (sourceUrl) taskUrl.searchParams.set('sourceUrl', sourceUrl);
  taskUrl.searchParams.set('autostart', '1');
  if (storageUrl) taskUrl.searchParams.set('musicStorageUrl', storageUrl);
  if (settings?.musicProxyUrl) taskUrl.searchParams.set('musicProxyUrl', settings.musicProxyUrl);
  if (settings?.musicProxyPort) taskUrl.searchParams.set('musicProxyPort', settings.musicProxyPort);

  if (settings?.musicLibHost) taskUrl.searchParams.set('musicLibHost', settings.musicLibHost);
  if (settings?.musicLibPort) taskUrl.searchParams.set('musicLibPort', settings.musicLibPort);
  if (settings?.musicLibPath) taskUrl.searchParams.set('musicLibPath', settings.musicLibPath);
  return taskUrl.href;
}

function makeTransferId() {
  return `flow_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toArrayBufferFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function safeFilenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || 'download.bin';
    return decodeURIComponent(last);
  } catch {
    return 'download.bin';
  }
}

function safeDownloadFilename(filename) {
  const raw = String(filename || '').trim();
  if (!raw) return 'download.bin';
  return raw.replace(/[\\/:*?"<>|]+/g, '_');
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

function getLocalProxyUrl(sender, settings) {
  try {
    const pageUrl = sender?.url || sender?.tab?.url || `${normalizeProxyOrigin(settings?.musicProxyUrl, settings?.musicProxyPort)}/`;
    const origin = new URL(pageUrl).origin;
    return new URL('/proxy', origin).href;
  } catch {
    return `${normalizeProxyOrigin(settings?.musicProxyUrl, settings?.musicProxyPort)}/proxy`;
  }
}

function getLocalDownloadUrl(sender, url, filename, settings) {
  try {
    const pageUrl = sender?.url || sender?.tab?.url || `${normalizeProxyOrigin(settings?.musicProxyUrl, settings?.musicProxyPort)}/`;
    const origin = new URL(pageUrl).origin;
    const out = new URL('/download', origin);
    out.searchParams.set('url', url);
    if (filename) out.searchParams.set('filename', filename);
    return out.href;
  } catch {
    const out = new URL(`${normalizeProxyOrigin(settings?.musicProxyUrl, settings?.musicProxyPort)}/download`);
    out.searchParams.set('url', url);
    if (filename) out.searchParams.set('filename', filename);
    return out.href;
  }
}

async function promptForSettings(tabId, currentSettings) {
  if (tabId == null) return null;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [currentSettings],
    func: (settings) => {
      const existingStorage = String(settings?.musicStorageUrl || '').trim();
      const existingProxy = String(settings?.musicProxyUrl || '').trim();

      const storageUrl = prompt('Music Storage URL', existingStorage);
      if (storageUrl == null) return { cancelled: true };

      const proxyUrl = prompt('Music Proxy URL', existingProxy);
      if (proxyUrl == null) return { cancelled: true };

      return {
        storageUrl: String(storageUrl).trim(),
        proxyUrl: String(proxyUrl).trim()
      };
    }
  });

  return results?.[0]?.result || null;
}

function hasConfiguredSettings(raw = {}) {
  const storage = String(raw.musicStorageUrl || raw.storageUrl || raw.musicLibHost || '').trim();
  const proxy = String(raw.musicProxyUrl || raw.proxyUrl || '').trim();
  return Boolean(storage && proxy);
}

function buildSetupPageUrl(settings) {
  const setupUrl = new URL(chrome.runtime.getURL(SETUP_PAGE));
  if (settings?.musicStorageUrl) setupUrl.searchParams.set('musicStorageUrl', settings.musicStorageUrl);
  if (settings?.musicProxyUrl) setupUrl.searchParams.set('musicProxyUrl', settings.musicProxyUrl);
  if (settings?.musicProxyPort) setupUrl.searchParams.set('musicProxyPort', settings.musicProxyPort);
  return setupUrl.href;
}

async function getConfiguredSettingsForClick(tabId) {
  const currentRaw = await loadStoredSettings();
  if (hasConfiguredSettings(currentRaw)) {
    return { settings: normalizeSettings(currentRaw), created: false };
  }

  const prompted = await promptForSettings(tabId, currentRaw);
  if (!prompted || prompted.cancelled) return null;

  const next = normalizeSettings({
    musicStorageUrl: prompted.storageUrl,
    musicProxyUrl: prompted.proxyUrl
  });
  const settings = await saveSettings(next);
  return { settings, created: true };
}

async function proxyRequest(payload, sender, settings) {
  const proxyUrl = getLocalProxyUrl(sender, settings);
  const response = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Local proxy returned non-JSON (${response.status})`);
  }

  if (!parsed.ok) {
    throw new Error(parsed.error || `Local proxy failed (${response.status})`);
  }

  return parsed;
}

async function proxyDownload(payload, sender, settings) {
  const { url, filename, saveAs = false } = payload || {};
  if (!url) throw new Error('Missing url');

  const downloadFilename = safeDownloadFilename(filename || safeFilenameFromUrl(url));
  const localUrl = getLocalDownloadUrl(sender, url, downloadFilename, settings);

  const downloadId = await chrome.downloads.download({
    url: localUrl,
    filename: downloadFilename,
    saveAs: Boolean(saveAs),
    conflictAction: 'uniquify'
  });

  return {
    ok: true,
    downloadId,
    filename: downloadFilename,
    finalUrl: localUrl,
    mimeType: 'application/octet-stream',
    mode: 'local-proxy-download'
  };
}

async function openFlowTarget(payload, sender, settings) {
  await setActionState({ state: 'busy', phase: 'Opening MusicLib', progress: 85 }).catch(() => {});
  const transferId = makeTransferId();
  const fallbackTarget = settings?.musicStorageUrl || buildStorageUrl(settings?.musicLibHost, settings?.musicLibPort, settings?.musicLibPath);
  const rawTarget = String(payload?.targetUrl || payload?.musicLibUrl || fallbackTarget).trim();
  if (!rawTarget) {
    throw new Error('No MusicLib storage URL is configured yet.');
  }
  const targetUrl = fallbackTarget ? new URL(rawTarget, fallbackTarget) : new URL(rawTarget);
  targetUrl.searchParams.set('flow', '1');
  targetUrl.searchParams.set('transferId', transferId);
  if (payload?.sourceUrl) targetUrl.searchParams.set('sourceUrl', payload.sourceUrl);
  if (payload?.videoId) targetUrl.searchParams.set('videoId', payload.videoId);

  const normalized = {
    transferId,
    targetUrl: targetUrl.href,
    payload: {
      ...payload,
      targetUrl: targetUrl.href,
      transferId,
      createdAt: Date.now()
    },
    createdAt: Date.now(),
    delivered: false
  };
  transferStore.set(transferId, normalized);

  const shouldOpenTarget = payload?.openTarget !== false;
  if (shouldOpenTarget) {
    const tab = await chrome.tabs.create({ url: targetUrl.href, active: false });
    normalized.tabId = tab?.id ?? null;
  }

  const sourceTabId = sender?.tab?.id ?? null;
  if (shouldOpenTarget && sourceTabId != null) {
    setTimeout(() => {
      chrome.tabs.remove(sourceTabId).catch(() => {});
    }, 150);
  }

  return {
    ok: true,
    transferId,
    targetUrl: targetUrl.href,
    tabId: normalized.tabId ?? null,
    closedSourceTabId: shouldOpenTarget ? sourceTabId : null
  };
}

function resolvePendingTransfer(request) {
  const transferId = String(request?.transferId || '').trim();
  if (transferId && transferStore.has(transferId)) {
    return transferStore.get(transferId);
  }

  const url = String(request?.pageUrl || request?.url || '').trim();
  if (url) {
    try {
      const parsed = new URL(url);
      const fromQuery = parsed.searchParams.get('transferId');
      if (fromQuery && transferStore.has(fromQuery)) {
        return transferStore.get(fromQuery);
      }
    } catch {
      // ignore
    }
  }

  for (const item of transferStore.values()) {
    if (!item.delivered) return item;
  }

  return null;
}

async function deliverPendingTransfer(payload) {
  const record = resolvePendingTransfer(payload);
  if (!record) {
    return { ok: false, error: 'No pending MusicLib transfer was found.' };
  }

  record.delivered = true;
  record.deliveredAt = Date.now();

  if (record.tabId != null) {
    try {
      await chrome.tabs.update(record.tabId, { active: true });
    } catch {
      // ignore activation failures
    }
  }

  try {
    await setActionState({ state: 'busy', phase: 'MusicLib importing', progress: 98, title: 'Downloading…' });
  } catch {}

  return {
    ok: true,
    transferId: record.transferId,
    payload: record.payload
  };
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const result = await getConfiguredSettingsForClick(tab?.id ?? null);
    if (!result) return;

    const sourceUrl = tab?.pendingUrl || tab?.url || '';
    const url = result.created
      ? buildSetupPageUrl(result.settings)
      : buildTaskPageUrl(sourceUrl, result.settings);

    await chrome.tabs.create({
      url,
      active: true
    });
  } catch (error) {
    console.error('Failed to open configured page', error);
    await chrome.tabs.create({
      url: chrome.runtime.getURL(SETUP_PAGE),
      active: true
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !ALLOWED_TYPES.has(message.type)) {
    return;
  }

  (async () => {
    try {
      const settings = await loadSettings();
      if (message.type === 'UD_PROXY_REQUEST') {
        const result = await proxyRequest(message.payload, sender, settings);
        sendResponse({ ok: true, ...result });
      } else if (message.type === 'UD_PROXY_DOWNLOAD') {
        const result = await proxyDownload(message.payload, sender, settings);
        sendResponse({ ok: true, ...result });
      } else if (message.type === 'UD_FLOW_TRANSFER') {
        const result = await openFlowTarget(message.payload || {}, sender, settings);
        sendResponse(result);
      } else if (message.type === 'UD_FLOW_READY') {
        const result = await deliverPendingTransfer(message.payload || {});
        sendResponse(result);
      } else if (message.type === 'UD_ACTIVITY_STATE') {
        const result = await setActionState(message.payload || {});
        sendResponse(result);
      } else if (message.type === 'UD_SETTINGS_UPDATE') {
        const result = await saveSettings(message.payload || {});
        sendResponse({ ok: true, settings: result });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(() => { setActionState({ state: 'idle' }).catch(() => {}); });
chrome.runtime.onStartup?.addListener?.(() => { setActionState({ state: 'idle' }).catch(() => {}); });
