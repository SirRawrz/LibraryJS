const $ = (id) => document.getElementById(id);
const getInput = (id) => document.getElementById(id);
const getCheckbox = (id, fallback = false) => {
  const el = document.getElementById(id);
  return el ? !!el.checked : !!fallback;
};
const setValue = (id, value, fallback = '') => {
  const el = document.getElementById(id);
  if (el) el.value = value ?? fallback;
};
const setChecked = (id, value) => {
  const el = document.getElementById(id);
  if (el) el.checked = !!value;
};

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
    autoArchive: getCheckbox('autoArchive'),
    saveSegments: getCheckbox('saveSegments'),
    captureDirectMedia: getCheckbox('captureDirectMedia'),
    captureSubtitleFiles: getCheckbox('captureSubtitleFiles'),
    captureTextDownloads: getCheckbox('captureTextDownloads'),
    ignoreGifTxtDownloads: getCheckbox('ignoreGifTxtDownloads'),
    uploadIssuesTxt: getCheckbox('uploadIssuesTxt'),
    subtitleSearchTerms: $('subtitleSearchTerms').value.trim() || 'the and to of a',
    perItemDelayMs: Math.max(0, readNumber($('perItemDelayMs').value, 0)),
  };
  const res = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: patch });
  if (!res?.ok) throw new Error(res?.error || 'Save failed');
  return res;
}

async function refresh() {
  const state = await getState();
  const { settings, config } = state;
  setValue('configBaseUrl', settings.configBaseUrl || '');
  setValue('archiveFolder', settings.archiveFolder || '/videodownloader/');
  setValue('perItemDelayMs', String(Math.max(0, readNumber(settings.perItemDelayMs, 0))));
  setChecked('autoArchive', settings.autoArchive);
  setChecked('saveSegments', settings.saveSegments);
  setChecked('captureDirectMedia', settings.captureDirectMedia);
  setChecked('captureSubtitleFiles', settings.captureSubtitleFiles !== false);
  setChecked('captureTextDownloads', settings.captureTextDownloads);
  setChecked('ignoreGifTxtDownloads', settings.ignoreGifTxtDownloads !== false);
  setChecked('uploadIssuesTxt', settings.uploadIssuesTxt !== false);
  setValue('subtitleSearchTerms', settings.subtitleSearchTerms || 'the and to of a');
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
