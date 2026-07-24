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

  function resolveResponseType(requestType) {
    switch (requestType) {
      case 'UD_PROXY_DOWNLOAD': return 'UD_PROXY_DOWNLOAD_RESPONSE';
      case 'UD_FLOW_TRANSFER': return 'UD_FLOW_TRANSFER_RESPONSE';
      case 'UD_ACTIVITY_STATE': return 'UD_ACTIVITY_STATE_RESPONSE';
      default: return 'UD_PROXY_RESPONSE';
    }
  }

  async function requestMusicFlowPayload(payload = {}) {
    try {
      if (!chrome?.runtime?.id) return;

      const response = await chrome.runtime.sendMessage({
        type: 'UD_FLOW_READY',
        payload: {
          ...payload,
          pageUrl: payload.pageUrl || location.href
        }
      });

      if (response?.ok && response?.payload) {
        window.postMessage({
          source: MUSIC_EXT_SOURCE,
          type: 'UD_FLOW_IMPORT',
          payload: response.payload
        }, '*');
      } else if (response && !response.ok) {
        window.postMessage({
          source: MUSIC_EXT_SOURCE,
          type: 'UD_FLOW_IMPORT_ERROR',
          payload: response
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
    if (event.source !== window || !event.data) return;
    const data = event.data;

    if (data[FLAG] === true) {
      chrome?.runtime?.sendMessage?.({
        type: 'PAGE_HIT',
        payload: data.payload
      })?.catch?.(() => {});
      return;
    }

    if (data.source === MUSIC_PAGE_SOURCE && MUSIC_TYPES.has(data.type)) {

      // Special flow handshake from musiclib.html
      if (data.type === 'UD_FLOW_READY') {
        requestMusicFlowPayload(data.payload || {});
        return;
      }

      const responseType = resolveResponseType(data.type);

      if (!chrome?.runtime?.id) {
        postMusicResponse(responseType, data.requestId, {
          ok: false,
          error: 'Extension context invalidated'
        });
        return;
      }

      chrome.runtime.sendMessage({
        type: data.type,
        payload: data.payload
      }).then((response) => {
        postMusicResponse(responseType, data.requestId, response);
      }).catch((error) => {
        postMusicResponse(responseType, data.requestId, {
          ok: false,
          error: error?.message || String(error)
        });
      });
    }
  });

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'SFA_INJECT_NOW') return;

      window.postMessage({
        [FLAG]: true,
        payload: {
          kind: 'bridge-ready',
          source: SOURCE,
          pageUrl: location.href,
          title: document.title,
          ts: Date.now()
        }
      }, '*');
    });
  }

  chrome?.runtime?.sendMessage?.({
    type: 'FRAME_READY',
    payload: {
      pageUrl: location.href,
      title: document.title,
      ts: Date.now(),
      visible: document.visibilityState === 'visible'
    }
  })?.catch?.(() => {});

  if (document.readyState === 'complete') {
    if (new URLSearchParams(location.search || '').get('flow') === '1') {
      requestMusicFlowPayload();
    }
  } else {
    window.addEventListener('load', () => {
      try {
        if (new URLSearchParams(location.search || '').get('flow') === '1') {
          requestMusicFlowPayload();
        }
      } catch {}
    });
  }
})();