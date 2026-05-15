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
  const ARCHIVE_FOLDER = (() => {
    try { return normalizeArchiveFolder(SERVER_CONFIG.archiveFolder || '/videodownloader/'); } catch { return '/videodownloader/'; }
  })();
  const UPLOAD_BASE = (() => {
    try { return String(SERVER_CONFIG.uploadBase || '').trim(); } catch { return ''; }
  })();

  function canonicalSubtitleUrl(url) {
    try {
      const u = new URL(url, location.href);
      let path = (u.pathname || '').replace(/\/+$/g, '');
      path = path.replace(/([._-](?:seg|segment|chunk|part|frag)?\d{1,5})(?=\.(?:vtt|srt|sbv|ttml|dfxp|sub)(?:$|[?#]))/i, '');
      path = path.replace(/([._-]\d{1,5})(?=\.(?:vtt|srt|sbv|ttml|dfxp|sub)(?:$|[?#]))/i, '');
      return `${u.origin}|${path.toLowerCase()}`;
    } catch {
      return String(url || '').split('#')[0].split('?')[0].toLowerCase();
    }
  }

  function normalizeArchiveFolder(raw) {
    let txt = String(raw || '').trim();
    if (!txt) return '/videodownloader/';
    txt = txt.replace(/\\/g, '/');
    if (/^https?:\/\//i.test(txt)) {
      try { txt = new URL(txt).pathname || '/videodownloader/'; } catch {}
    }
    if (!txt.startsWith('/')) txt = '/' + txt;
    if (!txt.endsWith('/')) txt += '/';
    return txt;
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
    const visible = document.visibilityState === 'visible';
    listeningPaused = !visible;
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
      const u = new URL(url, location.href);
      if (u.protocol === 'chrome-extension:') return true;
      if (UPLOAD_BASE) {
        const base = new URL(UPLOAD_BASE, u.origin).toString().toLowerCase();
        if (u.toString().toLowerCase().startsWith(base)) return true;
      }
      if (SERVER_ORIGIN) {
        const server = new URL(SERVER_ORIGIN);
        // Only ignore the exact configured server origin. This keeps the archive
        // endpoint quiet without accidentally swallowing unrelated same-host streams.
        if (u.origin === server.origin) return true;
        if (location.origin === server.origin) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function rememberSubtitleUrl(url) {
    if (!url) return;
    KNOWN_SUBTITLE_URLS.add(canonicalSubtitleUrl(url));
  }

  function isKnownSubtitleUrl(url) {
    if (!url) return false;
    return KNOWN_SUBTITLE_URLS.has(canonicalSubtitleUrl(url));
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

  function emitTrackSubtitle(trackEl, index, isActive = false) {
    if (listeningPaused) return;
    const src = trackEl?.src || '';
    if (!src || shouldIgnore(src)) return;
    rememberSubtitleUrl(src);
    const parentMedia = trackEl.parentElement;
    const mediaUrl = parentMedia?.currentSrc || parentMedia?.src || '';
    const trackObj = trackEl.track || {};
    emit({
      kind: 'subtitle',
      url: src,
      sourceUrl: mediaUrl || '',
      contentType: '',
      pageUrl: location.href,
      title: document.title,
      subtitleLang: trackEl.srclang || trackObj.language || '',
      subtitleLabel: trackEl.label || trackObj.label || '',
      subtitleKind: trackEl.kind || trackObj.kind || '',
      subtitleDefault: !!trackEl.default,
      subtitleActive: !!isActive,
      subtitleTrackIndex: Number(index || 0),
      sessionId,
      ts: Date.now(),
      source: 'dom-track'
    });
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

    const tracks = Array.from(document.querySelectorAll('track[src]'));
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (!track) continue;
      const src = track.getAttribute('src') || track.src || '';
      if (!src || shouldIgnore(src)) continue;
      const kind = String(track.kind || track.track?.kind || '').toLowerCase();
      const trackObj = track.track || null;
      const isActive = !!(track.default || trackObj?.mode === 'showing' || (trackObj?.activeCues && trackObj.activeCues.length > 0));
      if (kind && kind !== 'subtitles' && kind !== 'captions' && !isActive) continue;
      emitTrackSubtitle(track, i, isActive);
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
        const headers = response && response.headers && typeof response.headers.get === 'function' ? response.headers : null;
        const ct = headers ? (headers.get('content-type') || '') : '';
        if (shouldIgnore(url)) return response;
        if (looksLikePlaylist(url, ct)) {
          const text = truncatedText(await response.clone().text());
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
      } catch {}
      return response;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__sfa_url = url;
    this.__sfa_method = method;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('loadend', () => {
      try {
        const url = this.__sfa_url || '';
        const ct = typeof this.getResponseHeader === 'function' ? (this.getResponseHeader('content-type') || '') : '';
        if (shouldIgnore(url)) return;
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

  function onLocationChange(reason) {
    if (!IS_TOP_FRAME) return;
    resetSession(reason);
  }

  document.addEventListener('visibilitychange', syncListeningState, { passive: true });
  window.addEventListener('pageshow', syncListeningState, { passive: true });
  window.addEventListener('pagehide', () => {
    listeningPaused = true;
    emitMonitorState();
  }, { passive: true });

  if (IS_TOP_FRAME) {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function(...args) {
      const ret = origPushState.apply(this, args);
      window.dispatchEvent(new Event('sfa-locationchange'));
      return ret;
    };
    history.replaceState = function(...args) {
      const ret = origReplaceState.apply(this, args);
      window.dispatchEvent(new Event('sfa-locationchange'));
      return ret;
    };
    window.addEventListener('sfa-locationchange', () => onLocationChange('history-change'), { passive: true });
    window.addEventListener('popstate', () => onLocationChange('popstate'), { passive: true });
    window.addEventListener('hashchange', () => onLocationChange('hashchange'), { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }

  setInterval(scanMediaElements, 5000);
})();
