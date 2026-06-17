(() => {
  const FLAG = '__sfa_bridge__';
  const SOURCE = 'sfa-page-hook';
  const MUSIC_PAGE_SOURCE = 'UD_PAGE';
  const MUSIC_EXT_SOURCE = 'UD_EXT';
  const MUSIC_TYPES = new Set([
    'UD_PROXY_REQUEST',
    'UD_PROXY_DOWNLOAD',
    'UD_FLOW_TRANSFER',
    'UD_FLOW_READY',
    'UD_ACTIVITY_STATE',
    'UD_SETTINGS_UPDATE'
  ]);

  if (window.__SFA_BRIDGE_INITIALIZED__) return;
  window.__SFA_BRIDGE_INITIALIZED__ = true;

  function postMusicResponse(type, requestId, response) {
    try {
      window.postMessage({
        source: MUSIC_EXT_SOURCE,
        type,
        requestId,
        response
      }, '*');
    } catch {}
  }

  async function requestMusicFlowPayload() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'UD_FLOW_READY',
        payload: {
          pageUrl: location.href
        }
      });

      if (response && response.ok && response.payload) {
        window.postMessage({
          source: MUSIC_EXT_SOURCE,
          type: 'UD_FLOW_IMPORT',
          payload: response.payload
        }, '*');
      }
    } catch (error) {
      window.postMessage({
        source: MUSIC_EXT_SOURCE,
        type: 'UD_FLOW_IMPORT_ERROR',
        payload: {
          ok: false,
          error: error?.message || String(error)
        }
      }, '*');
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data[FLAG] === true) {
      chrome.runtime.sendMessage({
        type: 'PAGE_HIT',
        payload: data.payload
      }).catch?.(() => {});
      return;
    }

    if (data.source === MUSIC_PAGE_SOURCE && MUSIC_TYPES.has(data.type)) {
      chrome.runtime.sendMessage({
        type: data.type,
        payload: data.payload
      }).then((response) => {
        const responseType =
          data.type === 'UD_PROXY_DOWNLOAD'
            ? 'UD_PROXY_DOWNLOAD_RESPONSE'
            : data.type === 'UD_FLOW_TRANSFER'
              ? 'UD_FLOW_TRANSFER_RESPONSE'
              : data.type === 'UD_ACTIVITY_STATE'
                ? 'UD_ACTIVITY_STATE_RESPONSE'
                : 'UD_PROXY_RESPONSE';
        postMusicResponse(responseType, data.requestId, response);
      }).catch((error) => {
        const responseType =
          data.type === 'UD_PROXY_DOWNLOAD'
            ? 'UD_PROXY_DOWNLOAD_RESPONSE'
            : data.type === 'UD_FLOW_TRANSFER'
              ? 'UD_FLOW_TRANSFER_RESPONSE'
              : data.type === 'UD_ACTIVITY_STATE'
                ? 'UD_ACTIVITY_STATE_RESPONSE'
                : 'UD_PROXY_RESPONSE';
        postMusicResponse(responseType, data.requestId, {
          ok: false,
          error: error?.message || String(error)
        });
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'SFA_INJECT_NOW') return;
    window.postMessage({ [FLAG]: true, payload: { kind: 'bridge-ready', source: SOURCE, pageUrl: location.href, title: document.title, ts: Date.now() } }, '*');
  });

  chrome.runtime.sendMessage({ type: 'FRAME_READY', payload: { pageUrl: location.href, title: document.title, ts: Date.now(), visible: document.visibilityState === 'visible' } }).catch?.(() => {});

  window.addEventListener('load', () => {
    try {
      const params = new URLSearchParams(location.search || '');
      if (params.get('flow') === '1') {
        requestMusicFlowPayload();
      }
    } catch {}
  });
})();
