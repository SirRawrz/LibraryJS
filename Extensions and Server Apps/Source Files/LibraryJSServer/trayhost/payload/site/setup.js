const els = {
  musicStorageUrl: document.getElementById('musicStorageUrl'),
  musicProxyUrl: document.getElementById('musicProxyUrl'),
  musicProxyPort: document.getElementById('musicProxyPort'),
  saveBtn: document.getElementById('saveBtn'),
  status: document.getElementById('status')
};

function setStatus(text, kind = '') {
  if (!els.status) return;
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function getInitialValues() {
  try {
    const params = new URLSearchParams(location.search || '');
    return {
      musicStorageUrl: params.get('musicStorageUrl') || '',
      musicProxyUrl: params.get('musicProxyUrl') || '',
      musicProxyPort: params.get('musicProxyPort') || ''
    };
  } catch {
    return { musicStorageUrl: '', musicProxyUrl: '', musicProxyPort: '' };
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

function postSettingUpdate(payload) {
  return new Promise((resolve, reject) => {
    const requestId = `setup_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Timed out while saving settings.'));
    }, 4000);

    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'UD_EXT') return;
      if (data.type !== 'UD_PROXY_RESPONSE') return;
      if (data.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      if (data.response && data.response.ok) {
        resolve(data.response);
      } else {
        reject(new Error(data.response?.error || 'Save failed'));
      }
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'UD_PAGE',
      type: 'UD_SETTINGS_UPDATE',
      requestId,
      payload
    }, '*');
  });
}

async function saveSettings() {
  const payload = {
    musicStorageUrl: String(els.musicStorageUrl?.value || '').trim(),
    musicProxyUrl: String(els.musicProxyUrl?.value || '').trim(),
    musicProxyPort: String(els.musicProxyPort?.value || '').trim() || extractPortFromUrl(els.musicProxyUrl?.value || '')
  };

  if (!payload.musicStorageUrl || !payload.musicProxyUrl) {
    setStatus('Fill in the storage and proxy URLs before saving.', 'err');
    return;
  }

  setStatus('Saving settings…');
  try {
    await postSettingUpdate(payload);
    setStatus('Saved. Click the extension again to open the main page.', 'ok');
  } catch (error) {
    setStatus(error?.message || String(error), 'err');
  }
}

window.addEventListener('load', () => {
  const initial = getInitialValues();
  if (els.musicStorageUrl) els.musicStorageUrl.value = initial.musicStorageUrl;
  if (els.musicProxyUrl) els.musicProxyUrl.value = initial.musicProxyUrl;
  if (els.musicProxyPort) els.musicProxyPort.value = initial.musicProxyPort || extractPortFromUrl(initial.musicProxyUrl);
  setStatus('Waiting for values…');
});

els.saveBtn?.addEventListener('click', saveSettings);
[els.musicStorageUrl, els.musicProxyUrl, els.musicProxyPort].forEach((el) => {
  el?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveSettings();
    }
  });
});
