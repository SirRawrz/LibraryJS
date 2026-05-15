const $ = (id) => document.getElementById(id);

async function getState() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!res?.ok) throw new Error(res?.error || 'Could not load settings');
  return res;
}

function readNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function save() {
  const patch = {
    configBaseUrl: $('configBaseUrl').value.trim(),
    archiveFolder: $('archiveFolder').value.trim() || '/videodownloader/',
    mediabunnyBaseUrl: $('mediabunnyBaseUrl').value.trim(),
    autoArchive: $('autoArchive').checked,
    saveSegments: $('saveSegments').checked,
    captureDirectMedia: $('captureDirectMedia').checked,
    captureSubtitleFiles: $('captureSubtitleFiles').checked,
    captureTextDownloads: $('captureTextDownloads').checked,
    ignoreGifTxtDownloads: $('ignoreGifTxtDownloads').checked,
    subtitleSearchTerms: $('subtitleSearchTerms').value.trim() || 'the and to of a',
    perItemDelayMs: Math.max(0, readNumber($('perItemDelayMs').value, 0)),
    reserveBufferOverestimationPercent: Math.max(0, readNumber($('reserveBufferOverestimationPercent').value, 15))
  };
  const res = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: patch });
  if (!res?.ok) throw new Error(res?.error || 'Save failed');
  return res;
}

async function refresh() {
  const state = await getState();
  const { settings, config } = state;
  $('configBaseUrl').value = settings.configBaseUrl || '';
  $('archiveFolder').value = settings.archiveFolder || '/videodownloader/';
  $('mediabunnyBaseUrl').value = settings.mediabunnyBaseUrl || '';
  $('perItemDelayMs').value = String(Math.max(0, readNumber(settings.perItemDelayMs, 0)));
  $('reserveBufferOverestimationPercent').value = String(Math.max(0, readNumber(settings.reserveBufferOverestimationPercent, 15)));
  $('autoArchive').checked = !!settings.autoArchive;
  $('saveSegments').checked = !!settings.saveSegments;
  $('captureDirectMedia').checked = !!settings.captureDirectMedia;
  $('captureSubtitleFiles').checked = settings.captureSubtitleFiles !== false;
  $('captureTextDownloads').checked = !!settings.captureTextDownloads;
  $('ignoreGifTxtDownloads').checked = settings.ignoreGifTxtDownloads !== false;
  $('subtitleSearchTerms').value = settings.subtitleSearchTerms || 'the and to of a';
  $('result').textContent = config.serverOrigin
    ? `Loaded config:\nplatform = ${config.platform}\nserverOrigin = ${config.serverOrigin}\nuploadBase = ${config.uploadBase}`
    : 'No config base URL set yet.';
}

$('saveBtn').addEventListener('click', async () => {
  try {
    await save();
    $('result').textContent = 'Saved.';
    await refresh();
  } catch (err) {
    $('result').textContent = `Error: ${err.message}`;
  }
});

$('testBtn').addEventListener('click', async () => {
  try {
    await save();
    const res = await chrome.runtime.sendMessage({ type: 'REFRESH_CONFIG' });
    if (!res?.ok) throw new Error(res?.error || 'Test failed');
    const cfg = res.config;
    $('result').textContent = `OK\nplatform = ${cfg.platform}\nserverOrigin = ${cfg.serverOrigin}\narchiveFolder = ${cfg.archiveFolder}\nuploadBase = ${cfg.uploadBase}`;
  } catch (err) {
    $('result').textContent = `Error: ${err.message}`;
  }
});

$('useCurrentBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].url) return;
  try {
    const u = new URL(tabs[0].url);
    $('configBaseUrl').value = `${u.origin}/`;
  } catch {}
});

refresh().catch(err => { $('result').textContent = `Error: ${err.message}`; });
