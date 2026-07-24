(() => {
  if (window.__SFA_PAGE_HOOK__) return;
  window.__SFA_PAGE_HOOK__ = true;

  const FLAG = '__sfa_bridge__';
  const MAX_TEXT = 2_000_000;
  const IS_TOP_FRAME = (() => {
    try { return window.top === window; } catch { return true; }
  })();

  let listeningPaused = document.visibilityState !== 'visible';
  let sessionId = 0;
  let lastObservedHref = location.href;

  const PLAYLIST_RE = /(?:\.(?:m3u8?|m3u))(?:$|[?#])/i;
  const MEDIA_RE = /(?:\.(?:mp4|m4v|webm|mov|aac|mp3|flv|mkv))(?:$|[?#])/i;
  const SUBTITLE_RE = /(?:\.(?:vtt|srt|sbv|ttml|dfxp|sub))(?:$|[?#])/i;
  const KNOWN_SUBTITLE_URLS = new Set();

  const SERVER_CONFIG = (() => {
    try { return window.__SFA_SERVER_CONFIG__ || {}; } catch { return {}; }
  })();
  const SERVER_ORIGIN = (() => {
    try { return String(SERVER_CONFIG.serverOrigin || '').trim(); } catch { return ''; }
  })();

  function canonicalSubtitleUrl(url) {
    try {
      const u = new URL(url, location.href);
      let path = (u.pathname || '').replace(/\/+$/g, '');
      path = path.replace(/([._-](?:seg|segment|chunk|part|frag)?\d{1,5})(?=\.(?:vtt|srt|sbv|ttml|dfxp|sub)(?:$|[?#]))/i, '');
      return `${u.origin}|${path.toLowerCase()}`;
    } catch {
      return String(url || '').split('#')[0].split('?')[0].toLowerCase();
    }
  }

  const M3U_MIME_RE = /(?:mpegurl|vnd\.apple\.mpegurl|application\/x-mpegurl)/i;

  function emit(payload) {
    if (listeningPaused) return;
    try {
      window.postMessage({ [FLAG]: true, payload }, '*');
    } catch {}
  }

  function emitMonitorState() {
    try {
      window.postMessage({
        [FLAG]: true,
        payload: {
          kind: 'monitor-state',
          pageUrl: location.href,
          title: document.title,
          visible: document.visibilityState === 'visible',
          paused: listeningPaused,
          sessionId,
          ts: Date.now(),
          source: 'page-hook'
        }
      }, '*');
    } catch {}
  }

  function emitPageSession(reason = 'navigation') {
    if (!IS_TOP_FRAME) return;
    try {
      window.postMessage({
        [FLAG]: true,
        payload: {
          kind: 'page-session',
          pageUrl: location.href,
          title: document.title,
          visible: document.visibilityState === 'visible',
          paused: listeningPaused,
          sessionId,
          navigationReason: reason,
          ts: Date.now(),
          source: 'page-hook'
        }
      }, '*');
    } catch {}
  }

  function syncListeningState() {
    listeningPaused = document.visibilityState !== 'visible';
    emitMonitorState();
    if (!listeningPaused) scanMediaElements();
  }

  function looksLikePlaylist(url, contentType, bodyText) {
    return PLAYLIST_RE.test(url || '') || M3U_MIME_RE.test(contentType || '') || (typeof bodyText === 'string' && bodyText.includes('#EXTM3U'));
  }

  function looksLikeHlsSegment(url, contentType) {
    return /(?:\.(?:ts|m2ts|m4s))(?:$|[?#])/i.test(url || '') || /(?:mp2t|mpegts)/i.test(contentType || '');
  }

  function looksLikeMedia(url, contentType) {
    return !looksLikeHlsSegment(url, contentType) && (MEDIA_RE.test(url || '') || /(?:video|audio|octet-stream)/i.test(contentType || ''));
  }

  function looksLikeSubtitle(url, contentType) {
    return SUBTITLE_RE.test(url || '') || /(?:webvtt|vtt|subrip|x-subrip|ttml|dfxp|sbv)/i.test(contentType || '');
  }

  function truncatedText(text) {
    if (typeof text !== 'string') return '';
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  }

  function nearestMediaUrl() {
    const mediaEls = Array.from(document.querySelectorAll('video, audio'));
    for (const el of mediaEls) {
      const src = el?.currentSrc || el?.src || '';
      if (src && !shouldIgnore(src)) return src;
    }
    return '';
  }

  function shouldIgnore(url) {
    try {
      if (!url) return true;
      const u = new URL(url, location.href);
      if (u.protocol === 'chrome-extension:' || u.protocol === 'blob:') return true;
      if (SERVER_ORIGIN) {
        const server = new URL(SERVER_ORIGIN);
        if (u.origin === server.origin) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function rememberSubtitleUrl(url) {
    if (url) KNOWN_SUBTITLE_URLS.add(canonicalSubtitleUrl(url));
  }

  function isKnownSubtitleUrl(url) {
    return url ? KNOWN_SUBTITLE_URLS.has(canonicalSubtitleUrl(url)) : false;
  }

  function looksLikeHlsSubtitleNoise(url, contentType, bodyText = '') {
    const text = `${String(url || '')} ${String(contentType || '')} ${String(bodyText || '').slice(0, 500)}`.toLowerCase();
    if (/\b(?:m3u8?|mpegurl|playlist|manifest|master|index)\b/.test(text)) return true;
    if (/\/hls\//.test(text)) return true;
    if (/\b(?:segment|seg\d*|chunk|part|frag|fragment)\b/.test(text) && /\.vtt(?:$|[?#])/i.test(text)) return true;
    return false;
  }

  function emitIfUseful(details) {
    if (listeningPaused) return;
    const { url, contentType, text, kind } = details;
    if (shouldIgnore(url)) return;
    if (kind === 'subtitle' && !isKnownSubtitleUrl(url) && looksLikeHlsSubtitleNoise(url, contentType, text)) return;
    const payload = {
      kind,
      url,
      contentType: contentType || '',
      pageUrl: location.href,
      title: document.title,
      sessionId,
      ts: Date.now(),
      source: 'page-hook'
    };
    if (kind === 'playlist') payload.text = truncatedText(text || '');
    if (kind === 'subtitle') payload.sourceUrl = details.sourceUrl || nearestMediaUrl() || '';
    emit(payload);
  }

  function scanMediaElements() {
    if (listeningPaused) return;
    const mediaEls = Array.from(document.querySelectorAll('video, audio'));
    for (const el of mediaEls) {
      const src = el.currentSrc || el.src || '';
      if (!src || shouldIgnore(src)) continue;
      if (looksLikePlaylist(src, '') || looksLikeMedia(src, '')) {
        emit({
          kind: looksLikePlaylist(src, '') ? 'playlist' : 'media',
          url: src,
          contentType: '',
          pageUrl: location.href,
          title: document.title,
          sessionId,
          ts: Date.now(),
          source: 'dom-scan'
        });
      }
    }
  }

  function resetSession(reason = 'navigation') {
    const href = location.href;
    if (href === lastObservedHref && reason !== 'init') return;
    lastObservedHref = href;
    sessionId += 1;
    KNOWN_SUBTITLE_URLS.clear();
    emitPageSession(reason);
    emitMonitorState();
    if (!listeningPaused) scanMediaElements();
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function(...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) ? input.url : '';
      const response = await origFetch.apply(this, args);
      try {
        if (!shouldIgnore(url)) {
          const ct = response?.headers?.get?.('content-type') || '';
          if (looksLikePlaylist(url, ct)) {
            const text = truncatedText(await response.clone().text().catch(() => ''));
            emitIfUseful({ kind: 'playlist', url, contentType: ct, text });
          } else if (looksLikeSubtitle(url, ct)) {
            const text = truncatedText(await response.clone().text().catch(() => ''));
            if (isKnownSubtitleUrl(url) || !looksLikeHlsSubtitleNoise(url, ct, text)) {
              rememberSubtitleUrl(url);
              emitIfUseful({ kind: 'subtitle', url, contentType: ct, text });
            }
          } else if (looksLikeMedia(url, ct)) {
            emitIfUseful({ kind: 'media', url, contentType: ct });
          }
        }
      } catch {}
      return response;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__sfa_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('loadend', () => {
      try {
        const url = this.__sfa_url || '';
        if (shouldIgnore(url)) return;
        const ct = typeof this.getResponseHeader === 'function' ? (this.getResponseHeader('content-type') || '') : '';
        if (looksLikePlaylist(url, ct)) {
          let text = '';
          try { text = truncatedText(this.responseText || ''); } catch {}
          emitIfUseful({ kind: 'playlist', url, contentType: ct, text });
        } else if (looksLikeSubtitle(url, ct)) {
          let text = '';
          try { text = truncatedText(this.responseText || ''); } catch {}
          if (isKnownSubtitleUrl(url) || !looksLikeHlsSubtitleNoise(url, ct, text)) {
            rememberSubtitleUrl(url);
            emitIfUseful({ kind: 'subtitle', url, contentType: ct, text });
          }
        } else if (looksLikeMedia(url, ct)) {
          emitIfUseful({ kind: 'media', url, contentType: ct });
        }
      } catch {}
    });
    return origSend.apply(this, args);
  };

  const observer = new MutationObserver(() => scanMediaElements());
  const startObserver = () => {
    if (document.documentElement) {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
      if (IS_TOP_FRAME) resetSession('init');
      else {
        emitMonitorState();
        scanMediaElements();
      }
    }
  };

  document.addEventListener('visibilitychange', syncListeningState, { passive: true });
  window.addEventListener('pageshow', syncListeningState, { passive: true });
  window.addEventListener('pagehide', () => { listeningPaused = true; emitMonitorState(); }, { passive: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }

  setInterval(scanMediaElements, 5000);
})();