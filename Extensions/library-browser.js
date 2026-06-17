(() => {
  const state = {
    open: false,
    loading: false,
    error: '',
    rawText: '',
    tree: [],
    entryMap: new Map(),
    search: '',
    selectedPath: '',
    selectedNode: null,
    currentHitId: '',
    currentHitData: null,
    availability: new Map(),
    expanded: new Set(),
    loadedAt: 0,
    libraryOrigin: '',
    folderChecks: new Map(),
    vttAvailability: new Map(),
    subtitlePickerExpanded: false,
    includeSubtitleUploads: true,
    recentRoots: [],
    activeArchiveMatches: new Map(),
  };

  function $(id) { return document.getElementById(id); }
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
  function joinUrl(base, path) {
    try { return new URL(path, base).href; } catch { return String(path || ''); }
  }
  function basenameFromUrl(url = '') {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'file';
    } catch {
      return 'file';
    }
  }
  function folderFromUrl(url = '') {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      parts.pop();
      return `${u.origin}${parts.join('/')}/`;
    } catch {
      return '';
    }
  }

  function displayFolderFromUrl(url = '') {
    try {
      const u = new URL(url);
      const decodedPath = decodeURIComponent(u.pathname || '');
      const parts = decodedPath.split('/').filter(Boolean);
      return parts.length ? `${parts.join(' / ')}/` : '/';
    } catch {
      return '';
    }
  }
  async function pauseListening(paused, tabId = 0) {
    try {
      await chrome.runtime.sendMessage({ type: 'PAUSE_TAB_LISTENING', paused: !!paused, tabId: Number(tabId || 0) || 0 });
    } catch {}
  }
  function fileStem(url = '') {
    return basenameFromUrl(url).replace(/\.[^.]+$/, '') || 'archive';
  }

  function normalizeComparableName(value = '') {
    return String(value || '')
      .trim()
      .split(/[?#]/)[0]
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
  }

  function normalizeComparableUrl(value = '') {
    return String(value || '')
      .trim()
      .split(/[?#]/)[0]
      .replace(/\/+$|\/+$/g, '')
      .toLowerCase();
  }

  function isActiveArchiveHit(hit) {
    const status = String(hit?.status || '').toLowerCase();
    if (['archived', 'failed', 'cancelled', 'skipped'].includes(status)) return false;
    if (['queued', 'downloading', 'retrying', 'remuxing', 'archiving'].includes(status)) return true;
    if (status === 'partial') {
      if (hit?.browserRemuxRequested && hit?.browserRemuxSucceeded === false) return true;
      if (hit?.remuxRequested && hit?.browserRemuxSucceeded === false) return true;
    }
    const done = Number(hit?.progressDone || 0);
    const total = Number(hit?.progressTotal || 0);
    return total > 0 && done >= 0 && done < total;
  }

  function activeArchiveMatchKeysForHit(hit) {
    // Exact identity only: the clock should appear for the one row whose file
    // matches the active download, never for sibling branches/children.
    return [...new Set([
      normalizeComparableUrl(hit?.targetFileUrl),
      normalizeComparableName(hit?.targetFileName),
      normalizeComparableName(hit?.fileName),
    ].filter(Boolean))];
  }

  function buildActiveArchiveMatches(hits = []) {
    const matches = new Map();
    for (const hit of Array.isArray(hits) ? hits : []) {
      if (!hit || !isActiveArchiveHit(hit)) continue;
      const keys = activeArchiveMatchKeysForHit(hit);
      for (const key of keys) {
        if (!matches.has(key)) matches.set(key, hit);
      }
    }
    return matches;
  }

  function getEpisodeAvailability(node) {
    const fileUrl = String(node?.file || '').trim();
    if (!fileUrl) return { status: 'unknown', exists: null, code: 0 };
    const cached = state.availability.get(fileUrl) || { status: 'unknown', exists: null, code: 0 };
    if (cached.status === 'exists' || cached.status === 'missing' || cached.status === 'checking') return cached;
    const keys = [
      normalizeComparableUrl(fileUrl),
      normalizeComparableName(node?.fileName),
    ].filter(Boolean);
    for (const key of keys) {
      const hit = state.activeArchiveMatches.get(key);
      if (hit) {
        return {
          status: 'pending',
          exists: false,
          code: 0,
          activeStatus: String(hit.status || '').toLowerCase(),
          hitId: hit.id || hit.key || '',
          hitTitle: hit.archiveName || hit.title || '',
        };
      }
    }
    if (cached.status === 'pending') state.availability.delete(fileUrl);
    return { status: 'unknown', exists: null, code: 0 };
  }

  function syncActiveArchiveMatches(extState = null) {
    const hits = Array.isArray(extState?.hits) ? extState.hits : [];
    state.activeArchiveMatches = buildActiveArchiveMatches(hits);
    return state.activeArchiveMatches;
  }
  function skipSpaceComments(text, i) {
    while (i < text.length) {
      const ch = text[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '/' && text[i + 1] === '/') { i += 2; while (i < text.length && text[i] !== '\n') i++; continue; }
      if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
      break;
    }
    return i;
  }
  function readString(text, i) {
    const quote = text[i];
    let out = '';
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        const nxt = text[i + 1];
        if (nxt === undefined) { out += '\\'; i++; continue; }
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '`': '`' };
        out += Object.prototype.hasOwnProperty.call(map, nxt) ? map[nxt] : nxt;
        i += 2;
        continue;
      }
      if (ch === quote) return { value: out, end: i + 1 };
      out += ch;
      i++;
    }
    return { value: out, end: i };
  }
  function findMatching(text, start, openCh, closeCh) {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = readString(text, i).end; continue; }
      if (ch === '/' && text[i + 1] === '/') { i += 2; while (i < text.length && text[i] !== '\n') i++; continue; }
      if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
      if (ch === openCh) depth++;
      else if (ch === closeCh) { depth--; if (depth === 0) return i; }
      i++;
    }
    return -1;
  }
  function extractEpisodesBody(text) {
    const idx = text.indexOf('const episodes');
    if (idx < 0) return '';
    const brace = text.indexOf('{', idx);
    if (brace < 0) return '';
    const end = findMatching(text, brace, '{', '}');
    return end >= 0 ? text.slice(brace, end + 1) : '';
  }
  function readKey(text, i) {
    i = skipSpaceComments(text, i);
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') return readString(text, i);
    let j = i;
    while (j < text.length && !/[\s:]/.test(text[j])) j++;
    return { value: text.slice(i, j), end: j };
  }
  function readValueEnd(text, i) {
    i = skipSpaceComments(text, i);
    const ch = text[i];
    if (ch === '{') return findMatching(text, i, '{', '}') + 1;
    if (ch === '[') return findMatching(text, i, '[', ']') + 1;
    if (ch === '"' || ch === "'" || ch === '`') return readString(text, i).end;
    let j = i;
    while (j < text.length && !/[,\}\]]/.test(text[j])) j++;
    return j;
  }
  function parseTopLevelEntries(body) {
    const entries = [];
    let i = 1;
    while (i < body.length - 1) {
      i = skipSpaceComments(body, i);
      if (i >= body.length - 1) break;
      if (body[i] === ',') { i++; continue; }
      if (body[i] === '}') break;
      const key = readKey(body, i);
      if (!key?.value) { i++; continue; }
      i = skipSpaceComments(body, key.end);
      if (body[i] !== ':') { i++; continue; }
      i = skipSpaceComments(body, i + 1);
      const end = readValueEnd(body, i);
      entries.push({ key: key.value, raw: body.slice(i, end).trim() });
      i = end;
    }
    return entries;
  }
  function parseArrayItems(raw) {
    const items = [];
    const start = raw.indexOf('[');
    if (start < 0) return items;
    let i = start + 1;
    while (i < raw.length) {
      i = skipSpaceComments(raw, i);
      if (i >= raw.length || raw[i] === ']') break;
      if (raw[i] === ',') { i++; continue; }
      const ch = raw[i];
      if (ch === '{' || ch === '[') {
        const end = findMatching(raw, i, ch, ch === '{' ? '}' : ']');
        if (end < 0) break;
        items.push({ type: ch === '{' ? 'object' : 'array', raw: raw.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const str = readString(raw, i);
        items.push({ type: 'string', value: str.value });
        i = str.end;
        continue;
      }
      let j = i;
      while (j < raw.length && !/[\s,\]]/.test(raw[j])) j++;
      items.push({ type: 'literal', value: raw.slice(i, j).trim() });
      i = j;
    }
    return items;
  }
  function parseObjectFields(raw) {
    const obj = {};
    const start = raw.indexOf('{');
    if (start < 0) return obj;
    let i = start + 1;
    while (i < raw.length) {
      i = skipSpaceComments(raw, i);
      if (i >= raw.length || raw[i] === '}') break;
      if (raw[i] === ',') { i++; continue; }
      const key = readKey(raw, i);
      if (!key?.value) { i++; continue; }
      i = skipSpaceComments(raw, key.end);
      if (raw[i] !== ':') { i++; continue; }
      i = skipSpaceComments(raw, i + 1);
      const end = readValueEnd(raw, i);
      const valueRaw = raw.slice(i, end).trim();
      let value = valueRaw;
      if (valueRaw.startsWith('"') || valueRaw.startsWith("'") || valueRaw.startsWith('`')) value = readString(valueRaw, 0).value;
      else if (/^(true|false)$/i.test(valueRaw)) value = valueRaw.toLowerCase() === 'true';
      else if (/^(null)$/i.test(valueRaw)) value = null;
      else if (/^-?\d+(?:\.\d+)?$/.test(valueRaw)) value = Number(valueRaw);
      obj[key.value] = value;
      i = end;
    }
    return obj;
  }
  function normalizeSearch(raw = '') {
    return String(raw || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 20);
  }
  function textForNode(node) {
    // Search should stay anchored to the tail file name or the visible folder label.
    // Skipping the deeper title/path text keeps the library search snappy.
    const pieces = [];
    if (node.kind === 'episode') {
      if (node.fileName) pieces.push(node.fileName);
      else if (node.file) pieces.push(basenameFromUrl(node.file));
      else if (node.label) pieces.push(node.label);
    } else {
      if (node.label) pieces.push(node.label);
      else if (node.key) pieces.push(node.key);
    }
    return pieces.filter(Boolean).join(' ').toLowerCase();
  }
  function matchesSearch(node, terms) {
    if (!terms.length) return true;
    const hay = textForNode(node);
    return terms.every(t => hay.includes(t));
  }
  function childMatchExists(node, terms) {
    if (matchesSearch(node, terms)) return true;
    return Array.isArray(node.children) && node.children.some(child => childMatchExists(child, terms));
  }
  function childMatchExistsForVisible(node, terms) {
    if (matchesSearch(node, terms)) return true;
    return Array.isArray(node.children) && node.children.some(child => childMatchExistsForVisible(child, terms));
  }

  function buildNodeFromEntry(entry, entryMap, serverOrigin, pathParts = [], seen = new Set()) {
    const nodeKey = entry.key;
    if (seen.has(nodeKey)) {
      return { key: nodeKey, label: nodeKey, kind: 'cycle', path: [...pathParts, nodeKey], children: [] };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(nodeKey);
    const rawItems = parseArrayItems(entry.raw);
    const children = [];
    const objectItems = rawItems.filter(item => item.type === 'object');
    const stringItems = rawItems.filter(item => item.type === 'string');

    for (const item of stringItems) {
      const targetEntry = entryMap.get(item.value);
      if (targetEntry) {
        children.push(buildNodeFromEntry(targetEntry, entryMap, serverOrigin, [...pathParts, nodeKey], nextSeen));
      } else {
        children.push({
          key: item.value,
          label: item.value,
          kind: 'label',
          path: [...pathParts, nodeKey, item.value],
          children: [],
          file: '',
          fileName: '',
          episodeTitle: '',
          exists: null,
          isLeaf: true,
        });
      }
    }

    for (let index = 0; index < objectItems.length; index++) {
      const obj = parseObjectFields(objectItems[index].raw);
      const file = String(obj.file || obj.url || '').trim();
      // ---- FIX: encode special characters in the relative file path ----
      const encodedFile = encodePathForUrl(file);
      const fileUrl = encodedFile
          ? joinUrl(serverOrigin || location.origin, encodedFile)
          : '';
      const fileName = fileUrl ? basenameFromUrl(fileUrl) : basenameFromUrl(file);
      const episodeTitle = String(obj.name || obj.title || '').trim();
      const label = fileName || episodeTitle || `Episode ${index + 1}`;
      children.push({
        key: `${nodeKey}:${index}`,
        label,
        kind: 'episode',
        path: [...pathParts, nodeKey, label, String(index)],
        children: [],
        file: fileUrl,
        fileName,
        episodeTitle,
        raw: obj,
        isLeaf: true,
        exists: state.availability.get(fileUrl)?.exists ?? null,
      });
    }

    return {
      key: nodeKey,
      label: nodeKey,
      kind: children.length ? 'folder' : 'label',
      path: [...pathParts, nodeKey],
      children,
      isLeaf: !children.length,
    };
  }

  function collectRoots(entries) {
    const entryMap = new Map(entries.map(e => [e.key, e]));
    const referenced = new Set();
    for (const entry of entries) {
      for (const item of parseArrayItems(entry.raw)) {
        if (item.type === 'string' && entryMap.has(item.value)) referenced.add(item.value);
      }
    }
    return { entryMap, roots: entries.filter(entry => !referenced.has(entry.key)) };
  }

  function flattenNodes(nodes, out = []) {
    for (const node of nodes) {
      out.push(node);
      if (Array.isArray(node.children)) flattenNodes(node.children, out);
    }
    return out;
  }

  function collectEpisodeDescendants(node, out = []) {
    if (!node) return out;
    if (node.kind === 'episode' && node.file) out.push(node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) collectEpisodeDescendants(child, out);
    }
    return out;
  }

  function getFileAvailability(fileUrl) {
    return state.availability.get(fileUrl) || { status: 'unknown', exists: null, code: 0 };
  }

  function vttUrlForFileUrl(fileUrl = '') {
    try {
      const u = new URL(fileUrl);
      const parts = u.pathname.split('/');
      const file = parts.pop() || '';
      const stem = file.replace(/\.[^.]+$/, '');
      if (!stem) return '';
      parts.push(`${stem}.vtt`);
      u.pathname = parts.join('/');
      return u.href;
    } catch {
      return '';
    }
  }

  function getVttAvailability(fileUrl) {
    const vttUrl = vttUrlForFileUrl(fileUrl);
    if (!vttUrl) return { status: 'unknown', exists: null, code: 0 };
    return state.vttAvailability.get(vttUrl) || { status: 'unknown', exists: null, code: 0 };
  }

  function getFolderStats(node) {
    const episodes = collectEpisodeDescendants(node);
    let total = episodes.length;
    let checked = 0;
    let exists = 0;
    let missing = 0;
    let pending = 0;
    let checking = 0;
    for (const ep of episodes) {
      const st = getEpisodeAvailability(ep);
      if (st.status === 'exists') { checked++; exists++; }
      else if (st.status === 'pending') { checked++; pending++; }
      else if (st.status === 'missing') { checked++; missing++; }
      else if (st.status === 'checking') { checking++; }
    }
    const cached = state.folderChecks.get(node.path.join('>'));
    const done = !!cached || (total > 0 && checked >= total);
    const label = done
      ? (missing > 0
        ? `${missing} missing${pending > 0 ? ` • ${pending} downloading` : ''}`
        : (pending > 0 ? `${exists}/${total} found • ${pending} downloading` : `${exists}/${total} found`))
      : `Check folder`;
    return { total, checked, exists, missing, pending, checking, done, label };
  }

  function getFolderVttStats(node) {
    const episodes = collectEpisodeDescendants(node).filter(ep => ep.file);
    let total = episodes.length;
    let checked = 0;
    let exists = 0;
    let missing = 0;
    let checking = 0;
    for (const ep of episodes) {
      const st = getVttAvailability(ep.file);
      if (st.status === 'exists') { checked++; exists++; }
      else if (st.status === 'missing') { checked++; missing++; }
      else if (st.status === 'checking') { checking++; }
    }
    const done = total > 0 && checked >= total;
    return { total, checked, exists, missing, checking, done, label: done ? (missing > 0 ? `${missing} VTT missing` : `${exists}/${total} VTT`) : `Check VTT` };
  }

  function folderActionClass(node) {
    const stats = getFolderStats(node);
    if (!stats.total) return 'dim';
    if (!stats.done) return 'dim';
    if (stats.missing > 0) return 'warn';
    if (stats.pending > 0) return 'pending';
    return 'ok';
  }

  function folderVttActionClass(node) {
    const stats = getFolderVttStats(node);
    if (!stats.total) return 'dim';
    if (!stats.done) return 'dim';
    return stats.missing > 0 ? 'warn' : 'ok';
  }

  function episodeActionClass(node) {
    const st = getEpisodeAvailability(node);
    if (st.status === 'exists') return 'ok';
    if (st.status === 'pending') return 'pending';
    if (st.status === 'missing') return 'warn';
    if (st.status === 'checking') return 'dim';
    return 'dim';
  }

  function episodeActionLabel(node) {
    const st = getEpisodeAvailability(node);
    if (st.status === 'exists') return '✓';
    if (st.status === 'pending') return '🕒';
    if (st.status === 'checking') return '…';
    return 'Check';
  }

  function vttActionClass(node) {
    const st = getVttAvailability(node.file);
    if (st.status === 'exists') return 'ok';
    if (st.status === 'missing') return 'warn';
    if (st.status === 'checking') return 'dim';
    return 'dim';
  }

  function vttActionLabel(node) {
    const st = getVttAvailability(node.file);
    if (st.status === 'exists') return '✓';
    if (st.status === 'checking') return '…';
    return 'VTT Check';
  }

  const RECENT_ROOTS_STORAGE_KEY = 'libraryPickerRecentRootsV1';

  function loadRecentRoots() {
    try {
      const raw = localStorage.getItem(RECENT_ROOTS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string' && v) : [];
    } catch {
      return [];
    }
  }

  function saveRecentRoots() {
    try {
      localStorage.setItem(RECENT_ROOTS_STORAGE_KEY, JSON.stringify(state.recentRoots.slice(0, 3)));
    } catch {}
  }

  function touchRecentRoot(pathKey) {
    if (!pathKey) return;
    const next = [String(pathKey), ...state.recentRoots.filter(v => v !== pathKey)].slice(0, 3);
    state.recentRoots = next;
    saveRecentRoots();
  }

  function recentRankForNode(node) {
    if (!node?.path?.length) return 9999;
    const rootKey = node.path[0];
    const idx = state.recentRoots.indexOf(rootKey);
    return idx >= 0 ? idx : 9999;
  }

  function sortTopLevelNodes(nodes) {
    return [...nodes].sort((a, b) => {
      const ar = recentRankForNode(a);
      const br = recentRankForNode(b);
      if (ar !== br) return ar - br;
      const al = String(a?.label || a?.key || '').toLowerCase();
      const bl = String(b?.label || b?.key || '').toLowerCase();
      return al.localeCompare(bl);
    });
  }

  function selectedSummary() {
    const node = state.selectedNode;
    if (!node) return 'Select a file to target it.';
    const file = node.file || '';
    const folder = file ? displayFolderFromUrl(file) : '';
    const subtitleLabels = selectedSubtitleLabels();
    const parts = [];
    if (node.fileName) parts.push(`File: ${node.fileName}`);
    if (node.episodeTitle) parts.push(`Episode title: ${node.episodeTitle}`);
    if (folder) parts.push(`Folder: ${folder}`);
    if (subtitleLabels.length) parts.push(`Subtitle: ${subtitleLabels.join(', ')}`);
    if (!parts.length && node.label) parts.push(node.label);
    return parts.join(' • ');
  }

  function subtitleChipLabel(sub = {}) {
    const base = String(sub.subtitleLabel || sub.label || sub.subtitleLang || sub.title || '').trim();
    const fallback = basenameFromUrl(sub.url || '').replace(/\.(?:vtt|srt|sbv|ttml|dfxp|sub)$/i, '') || 'subtitle';
    const label = base || fallback;
    const flags = [];
    if (sub.subtitleDefault) flags.push('default');
    if (sub.subtitleActive) flags.push('active');
    if (/^en(?:[-_].*|$)|english|eng/i.test(String(sub.subtitleLang || sub.srclang || sub.language || sub.subtitleLabel || '').trim())) flags.push('EN');
    return [label, ...flags].join(' • ');
  }

  function selectedSubtitleLabels(hit = state.currentHitData) {
    const subtitleHits = Array.isArray(hit?.subtitleHits) ? hit.subtitleHits : [];
    const urls = Array.isArray(hit?.selectedSubtitleUrls) && hit.selectedSubtitleUrls.length
      ? hit.selectedSubtitleUrls
      : (hit?.selectedSubtitleUrl ? [hit.selectedSubtitleUrl] : []);
    if (!urls.length) return [];
    const labels = [];
    for (const url of urls) {
      const match = subtitleHits.find(sub => String(sub?.url || '') === String(url || ''));
      labels.push(match ? subtitleChipLabel(match) : (basenameFromUrl(url).replace(/\.(?:vtt|srt|sbv|ttml|dfxp|sub)$/i, '') || 'subtitle'));
    }
    return labels.filter(Boolean);
  }

  function getSelectedSubtitleUrls() {
    if (Array.isArray(state.currentHitData?.selectedSubtitleUrls) && state.currentHitData.selectedSubtitleUrls.length) return [...state.currentHitData.selectedSubtitleUrls];
    if (state.currentHitData?.selectedSubtitleUrl) return [state.currentHitData.selectedSubtitleUrl].filter(Boolean);
    return [];
  }

  function setSelectedSubtitleUrl(url) {
    if (!state.currentHitData || !url) return;
    state.currentHitData = {
      ...state.currentHitData,
      selectedSubtitleUrls: [url],
      selectedSubtitleUrl: url,
    };
    updateFooter();
    renderTree();
  }

  function includeSubtitleUploadsForCurrentHit() {
    return state.currentHitData?.includeSubtitleUploads !== false;
  }

  function setIncludeSubtitleUploadsForCurrentHit(value) {
    if (!state.currentHitData) return;
    state.currentHitData = {
      ...state.currentHitData,
      includeSubtitleUploads: !!value,
    };
    updateFooter();
    renderTree();
  }

  function renderSubtitlePicker() {
    const subtitleHits = Array.isArray(state.currentHitData?.subtitleHits) ? state.currentHitData.subtitleHits : [];
    const selected = new Set(getSelectedSubtitleUrls());
    if (!subtitleHits.length && !selected.size) return '';
    const expanded = !!state.subtitlePickerExpanded;
    const selectedLabels = selectedSubtitleLabels();
    const title = selected.size ? 'Subtitle selected' : 'Select subtitle';
    const meta = selected.size
      ? `Current: ${selectedLabels.join(', ')}`
      : 'Choose a subtitle to upload on its own.';
    const toggleLabel = expanded ? 'Hide choices' : `Show choices (${subtitleHits.length || selected.size})`;
    return `
      <div class="library-subtitle-box${expanded ? ' expanded' : ''}">
        <div class="library-subtitle-head">
          <div>
            <div class="library-subtitle-title">${esc(title)}</div>
            <div class="library-subtitle-meta">${esc(meta)}</div>
          </div>
          <button class="btn secondary library-subtitle-toggle" data-toggle-library-subtitle>${esc(toggleLabel)}</button>
        </div>
        ${expanded ? `
          <div class="library-subtitle-scroll">
            <div class="library-subtitle-row">
              ${subtitleHits.map((sub) => {
                const subUrl = String(sub?.url || '').trim();
                const isSelected = selected.has(subUrl);
                return `<button class="library-subtitle-chip${isSelected ? ' selected' : ''}" data-select-library-subtitle="${esc(subUrl)}" title="${esc(subUrl)}">${esc(subtitleChipLabel(sub))}</button>`;
              }).join('')}
            </div>
          </div>
        ` : ''}
      </div>`;
  }

  function updateFooter() {
    const title = $('librarySelectedTitle');
    const details = $('librarySelectedDetails');
    const archiveBtn = $('libraryArchiveBtn');
    const useBtn = $('libraryUseBtn');
    const archiveSubtitleToggle = $('libraryArchiveSubtitleToggle');
    if (title) title.textContent = state.selectedNode ? (state.selectedNode.fileName || state.selectedNode.label || 'Selected') : 'Nothing selected';
    if (details) details.textContent = selectedSummary();
    const subtitleUrls = getSelectedSubtitleUrls();
    const includeSubtitleUploads = includeSubtitleUploadsForCurrentHit();
    if (archiveSubtitleToggle) {
      archiveSubtitleToggle.checked = includeSubtitleUploads;
      archiveSubtitleToggle.disabled = !subtitleUrls.length;
      archiveSubtitleToggle.title = subtitleUrls.length
        ? 'Include the selected subtitle in the archive'
        : 'Select a subtitle to include it in the archive';
    }
    if (archiveBtn) {
      archiveBtn.disabled = !state.selectedNode?.file || !state.currentHitId;
      archiveBtn.textContent = includeSubtitleUploads && subtitleUrls.length
        ? 'Upload Archive + subtitles'
        : 'Upload Archive';
      archiveBtn.title = includeSubtitleUploads && subtitleUrls.length
        ? 'Upload the selected episode and subtitle together'
        : 'Upload the selected episode only';
    }
    if (useBtn) {
      useBtn.textContent = 'Upload Subtitle';
      useBtn.disabled = !state.selectedNode?.file || !subtitleUrls.length;
      useBtn.title = subtitleUrls.length ? 'Upload the selected subtitle only' : 'Select a subtitle first';
    }
    const subtitleBox = $('librarySubtitleBox');
    if (subtitleBox) {
      subtitleBox.hidden = !subtitleUrls.length && !(Array.isArray(state.currentHitData?.subtitleHits) && state.currentHitData.subtitleHits.length);
      subtitleBox.innerHTML = renderSubtitlePicker();
    }
  }

  function renderNode(node, terms, depth = 0) {
    if (!childMatchExistsForVisible(node, terms)) return '';
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const isFolderLike = hasChildren && node.kind !== 'episode';
    const pathKey = node.path.join('>');
    const isExpanded = state.expanded.has(pathKey);
    const selected = state.selectedPath === pathKey;
    const isEpisode = node.kind === 'episode';
    const fileStatus = isEpisode ? getFileAvailability(node.file) : null;
    const folderStats = isFolderLike ? getFolderStats(node) : null;
    const folderVttStats = isFolderLike ? getFolderVttStats(node) : null;
    const rowClasses = ['library-row'];
    if (selected) rowClasses.push('selected');
    if (isEpisode) rowClasses.push('episode', fileStatus?.status || 'unknown');
    else if (isFolderLike) rowClasses.push('folder');
    if (isEpisode && getEpisodeAvailability(node).status === 'pending') rowClasses.push('pending');
    else rowClasses.push('leaf');

    const leftIndent = 12 + depth * 14;
    const toggle = hasChildren ? `<button class="library-toggle" data-toggle-node="${esc(pathKey)}">${isExpanded ? '▾' : '▸'}</button>` : '<span class="library-toggle-spacer"></span>';
    const mainBtn = isFolderLike
      ? `<button class="library-node-btn" data-toggle-node="${esc(pathKey)}">${esc(node.label)}</button>`
      : `<button class="library-node-btn" data-select-node="${esc(pathKey)}">${esc(node.label)}</button>`;

    const meta = isEpisode
      ? [node.episodeTitle && node.episodeTitle !== node.fileName ? `Episode title: ${node.episodeTitle}` : '', node.file ? `Folder: ${displayFolderFromUrl(node.file)}` : '', node.fileName ? `File: ${node.fileName}` : ''].filter(Boolean).join(' • ')
      : esc(node.kind === 'folder' ? 'folder' : 'title');

    const actionButton = isFolderLike
      ? `<div class="library-status-group folder-actions stack-right"><button class="library-status-btn ${folderActionClass(node)}" data-check-folder="${esc(pathKey)}" title="Check all files in this folder">${esc(folderStats?.done ? (folderStats.missing > 0 ? `⚠ ${folderStats.missing} missing` : `✓ ${folderStats.exists}/${folderStats.total}`) : 'Check folder')}</button><button class="library-status-btn ${folderVttActionClass(node)}" data-check-vtt-folder="${esc(pathKey)}" title="Check all companion VTT files in this folder">${esc(getFolderVttStats(node).label)}</button></div>`
      : isEpisode
        ? `<div class="library-status-group stack-right"><button class="library-status-btn ${episodeActionClass(node)}" data-check-episode="${esc(pathKey)}" title="${fileStatus?.status === 'exists' ? 'Found file. Click for options.' : 'Check file availability'}">${esc(episodeActionLabel(node))}</button><button class="library-status-btn ${vttActionClass(node)}" data-check-vtt="${esc(pathKey)}" title="Check the companion VTT file in this folder">${esc(vttActionLabel(node))}</button></div>`
        : '';

    const titleLine = esc(node.label);
    const childHtml = (hasChildren && isExpanded) ? node.children.map(child => renderNode(child, terms, depth + 1)).join('') : '';
    return `
      <div class="library-row-wrap" data-node-path="${esc(pathKey)}">
        <div class="${rowClasses.join(' ')}" style="padding-left:${leftIndent}px">
          ${toggle}
          <div class="library-node-main">
            <div class="library-node-line">
              ${mainBtn}
            </div>
            <div class="library-node-title">${titleLine}</div>
            <div class="library-node-meta">${esc(meta)}</div>
          </div>
          ${actionButton}
        </div>
        ${childHtml}
      </div>`;
  }

  function renderTree() {
    const root = $('libraryTree');
    const status = $('libraryStatus');
    if (!root) return;

    if (state.loading) {
      root.innerHTML = '<div class="library-empty">Loading library…</div>';
      if (status) status.textContent = 'Loading library.js…';
      return;
    }

    if (state.error) {
      root.innerHTML = `<div class="library-empty">${esc(state.error)}</div>`;
      if (status) status.textContent = state.error;
      updateFooter();
      return;
    }

    const terms = normalizeSearch(state.search);
    if (!state.tree.length) {
      root.innerHTML = '<div class="library-empty">No titles were found in library.js.</div>';
      if (status) status.textContent = 'No titles found.';
      updateFooter();
      return;
    }

    const nodes = sortTopLevelNodes(state.tree.filter(node => childMatchExistsForVisible(node, terms)));
    root.innerHTML = nodes.map(node => renderNode(node, terms, 0)).join('') || '<div class="library-empty">No matches.</div>';
    if (status) status.textContent = terms.length ? `${nodes.length} matching title${nodes.length === 1 ? '' : 's'}` : `${state.tree.length} top-level title${state.tree.length === 1 ? '' : 's'}`;
    updateFooter();
  }

  async function fetchLibraryText(serverOrigin) {
    const res = await fetch(joinUrl(serverOrigin, '/library.js'), { cache: 'no-store', credentials: 'include' });
    if (!res.ok) throw new Error(`library.js returned HTTP ${res.status}`);
    return await res.text();
  }

  async function getState() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res?.ok) throw new Error(res?.error || 'Could not load extension state');
    return res;
  }

  function normalizeComparablePageUrl(url = '') {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`.replace(/\/+$/g, '').toLowerCase();
    } catch {
      return String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/g, '').toLowerCase();
    }
  }

  function collectLatestSubtitleHits(extHits = [], sourceHit = null) {
    const pageUrl = normalizeComparablePageUrl(sourceHit?.pageUrl || state.currentHitData?.pageUrl || '');
    const tabId = Number(sourceHit?.tabId || state.currentHitData?.tabId || 0) || 0;
    const sourceUrl = String(sourceHit?.sourceUrl || state.currentHitData?.sourceUrl || sourceHit?.url || state.currentHitData?.url || '').trim();
    const archiveName = String(sourceHit?.archiveName || state.currentHitData?.archiveName || sourceHit?.title || state.currentHitData?.title || '').trim().toLowerCase();
    const title = String(sourceHit?.title || state.currentHitData?.title || '').trim().toLowerCase();
    const sourceTime = Number(sourceHit?.ts || sourceHit?.lastSeen || state.currentHitData?.ts || state.currentHitData?.lastSeen || 0) || 0;
    const subtitles = [];
    for (const hit of Array.isArray(extHits) ? extHits : []) {
      if (!hit || String(hit.kind || '').toLowerCase() !== 'subtitle') continue;
      if (String(hit.status || '').toLowerCase() === 'archived') continue;
      const hitPage = normalizeComparablePageUrl(hit.pageUrl || '');
      const hitSource = String(hit.sourceUrl || hit.url || '').trim();
      const hitTitle = String(hit.archiveName || hit.title || '').trim().toLowerCase();
      const hitTab = Number(hit.tabId || 0) || 0;
      const samePage = pageUrl && hitPage && hitPage === pageUrl;
      const sameTab = tabId && hitTab && hitTab === tabId;
      const sameSource = sourceUrl && hitSource && hitSource === sourceUrl;
      const sameTitle = !!(archiveName && hitTitle && (hitTitle === archiveName || hitTitle === title));
      const timeDelta = sourceTime && Number(hit.ts || hit.lastSeen || 0)
        ? Math.abs(sourceTime - Number(hit.ts || hit.lastSeen || 0))
        : null;
      const sameWindow = timeDelta === null || timeDelta <= 5000;
      if (samePage || sameTab || sameSource || (sameTitle && sameWindow)) subtitles.push(hit);
    }
    return subtitles.sort((a, b) => Number(b.lastSeen || b.ts || 0) - Number(a.lastSeen || a.ts || 0));
  }

  async function syncCurrentHitFromState(extState = null) {
    const latestState = extState || await getState();
    const hits = Array.isArray(latestState?.hits) ? latestState.hits : [];
    syncActiveArchiveMatches({ hits });
    if (!state.currentHitId) return null;
    const latestHit = hits.find(h => String(h.id) === String(state.currentHitId)) || null;
    const sourceHit = latestHit || state.currentHitData;
    if (!sourceHit) return null;
    const priorSelected = Array.isArray(state.currentHitData?.selectedSubtitleUrls) && state.currentHitData.selectedSubtitleUrls.length
      ? [...state.currentHitData.selectedSubtitleUrls]
      : (Array.isArray(sourceHit.selectedSubtitleUrls) ? [...sourceHit.selectedSubtitleUrls] : (sourceHit.selectedSubtitleUrl ? [sourceHit.selectedSubtitleUrl] : []));
    const subtitleHits = collectLatestSubtitleHits(hits, sourceHit);
    const carriedSubtitleHits = subtitleHits.length
      ? subtitleHits
      : (Array.isArray(state.currentHitData?.subtitleHits) ? state.currentHitData.subtitleHits.filter(hit => hit && String(hit.status || '').toLowerCase() !== 'archived') : []);
    state.currentHitData = {
      ...sourceHit,
      selectedSubtitleUrls: priorSelected,
      selectedSubtitleUrl: priorSelected[0] || sourceHit.selectedSubtitleUrl || '',
      selectedVariantUrl: sourceHit.selectedVariantUrl || state.currentHitData?.selectedVariantUrl || '',
      subtitleBaseName: String(sourceHit.subtitleBaseName || state.currentHitData?.subtitleBaseName || '').trim(),
      subtitleHits: carriedSubtitleHits,
      includeSubtitleUploads: typeof state.currentHitData?.includeSubtitleUploads === 'boolean'
        ? state.currentHitData.includeSubtitleUploads
        : (typeof sourceHit.includeSubtitleUploads === 'boolean' ? sourceHit.includeSubtitleUploads : (priorSelected.length > 0))
    };
    return state.currentHitData;
  }

  async function ensureLibraryLoaded(force = false) {
    if (state.loading) return;
    if (!force && state.tree.length) return;
    state.loading = true;
    state.error = '';
    renderTree();
    try {
      const extState = await getState();
      const serverOrigin = extState?.config?.serverOrigin || '';
      if (!serverOrigin) throw new Error('Server is not configured yet.');
      state.libraryOrigin = serverOrigin;
      const text = await fetchLibraryText(serverOrigin);
      const body = extractEpisodesBody(text);
      if (!body) throw new Error('Could not find the episodes object in library.js');
      const entries = parseTopLevelEntries(body);
      const { entryMap, roots } = collectRoots(entries);
      state.entryMap = entryMap;
      state.tree = roots.map(entry => buildNodeFromEntry(entry, entryMap, serverOrigin, []));
      if (!state.recentRoots.length) state.recentRoots = loadRecentRoots();
      state.loadedAt = Date.now();
      state.rawText = text;
      state.error = '';
      await syncCurrentHitFromState(extState).catch(() => {});
      if (!state.expanded.size && state.tree.length <= 8) {
        for (const node of state.tree) state.expanded.add(node.path.join('>'));
      }
      await primeAvailabilityForVisibleNodes();
    } catch (err) {
      state.error = String(err?.message || err);
    } finally {
      state.loading = false;
      renderTree();
    }
  }

  function collectVisibleLeaves(nodes, terms, out = []) {
    for (const node of nodes) {
      if (!childMatchExistsForVisible(node, terms)) continue;
      if (!Array.isArray(node.children) || !node.children.length || node.kind === 'episode' || node.kind === 'label') {
        if (node.file) out.push(node);
      } else if (state.expanded.has(node.path.join('>')) || terms.length) {
        collectVisibleLeaves(node.children, terms, out);
      }
    }
    return out;
  }

  async function checkAvailabilityForNode(node) {
    if (!node?.file) return null;
    const cached = state.availability.get(node.file);
    if (cached && cached.status !== 'checking') return cached;
    state.availability.set(node.file, { status: 'checking', exists: null, code: 0 });
    renderTree();
    let exists = false;
    let status = 0;
    try {
      let res = await fetch(node.file, { method: 'HEAD', cache: 'no-store', credentials: 'include' });
      status = res.status;
      if (!res.ok && (res.status === 405 || res.status === 501)) {
        res = await fetch(node.file, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store', credentials: 'include' });
        status = res.status;
      }
      exists = res.ok;
    } catch {
      exists = false;
      status = 0;
    }
    const info = { status: exists ? 'exists' : 'missing', exists, code: status };
    state.availability.set(node.file, info);
    node.exists = exists;
    renderTree();
    return info;
  }

  async function checkVttAvailabilityForNode(node) {
    if (!node?.file) return null;
    const vttUrl = vttUrlForFileUrl(node.file);
    if (!vttUrl) return null;
    const cached = state.vttAvailability.get(vttUrl);
    if (cached && cached.status !== 'checking') return cached;
    state.vttAvailability.set(vttUrl, { status: 'checking', exists: null, code: 0 });
    renderTree();
    let exists = false;
    let status = 0;
    try {
      let res = await fetch(vttUrl, { method: 'HEAD', cache: 'no-store', credentials: 'include' });
      status = res.status;
      if (!res.ok && (res.status === 405 || res.status === 501)) {
        res = await fetch(vttUrl, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store', credentials: 'include' });
        status = res.status;
      }
      exists = res.ok;
    } catch {
      exists = false;
      status = 0;
    }
    const info = { status: exists ? 'exists' : 'missing', exists, code: status };
    state.vttAvailability.set(vttUrl, info);
    node.vttExists = exists;
    renderTree();
    return info;
  }

  async function checkVttFolder(node) {
    if (!node) return;
    const key = node.path.join('>');
    state.expanded.add(key);
    renderTree();
    const leaves = collectEpisodeDescendants(node).filter(ep => ep.file);
    for (const leaf of leaves) {
      await checkVttAvailabilityForNode(leaf);
    }
    renderTree();
  }

  async function checkFolder(node) {
    if (!node) return;
    const key = node.path.join('>');
    state.folderChecks.set(key, { checkedAt: Date.now() });
    state.expanded.add(key);
    renderTree();
    const leaves = collectEpisodeDescendants(node).filter(ep => ep.file);
    for (const leaf of leaves) {
      const st = getEpisodeAvailability(leaf);
      if (st.status === 'pending') continue;
      await checkAvailabilityForNode(leaf);
    }
    const firstMissing = leaves.find(ep => {
      const st = getEpisodeAvailability(ep);
      return st.status !== 'exists' && st.status !== 'pending';
    });
    if (firstMissing) {
      state.selectedNode = firstMissing;
      state.selectedPath = firstMissing.path.join('>');
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-node-path="${CSS.escape(state.selectedPath)}"]`);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
      });
    }
    renderTree();
  }

  async function primeAvailabilityForVisibleNodes() {
    const terms = normalizeSearch(state.search);
    const visibleLeaves = collectVisibleLeaves(state.tree, terms);
    const leafs = visibleLeaves.slice(0, 50);
    for (const node of leafs) {
      if (!node.file || state.availability.has(node.file)) continue;
      if (getEpisodeAvailability(node).status === 'pending') continue;
      checkAvailabilityForNode(node);
    }
  }

  /** ---- NEW: encode special characters in relative paths ---- **/
  function encodePathForUrl(urlStr) {
    // If already an absolute URL, leave it untouched
    if (/^https?:\/\//i.test(urlStr)) return urlStr;
    // Encode each path segment individually, keeping slashes
    return urlStr.split('/').map(encodeURIComponent).join('/');
  }

  async function open(hitId) {
    state.currentHitId = typeof hitId === 'object' ? String(hitId?.id || hitId?.key || '') : String(hitId || '');
    const providedSubtitleUrls = Array.isArray(hitId?.selectedSubtitleUrls) && hitId.selectedSubtitleUrls.length
      ? [...hitId.selectedSubtitleUrls]
      : (hitId?.selectedSubtitleUrl ? [hitId.selectedSubtitleUrl] : []);
    const selectedSubtitleUrls = providedSubtitleUrls.length
      ? providedSubtitleUrls
      : (typeof window.getSelectedSubtitleUrls === 'function' ? window.getSelectedSubtitleUrls(hitId || {}) : []);
    state.currentHitData = typeof hitId === 'object' && hitId ? { ...hitId, selectedSubtitleUrls: Array.isArray(selectedSubtitleUrls) ? [...selectedSubtitleUrls] : [], selectedSubtitleUrl: selectedSubtitleUrls[0] || '', selectedVariantUrl: hitId.selectedVariantUrl || '', subtitleBaseName: String(hitId.subtitleBaseName || '').trim(), includeSubtitleUploads: typeof hitId.includeSubtitleUploads === 'boolean' ? hitId.includeSubtitleUploads : (selectedSubtitleUrls.length > 0) } : null;
    state.subtitlePickerExpanded = false;
    state.recentRoots = loadRecentRoots();
    state.open = true;
    const overlay = $('libraryModal');
    if (overlay) overlay.hidden = false;
    const search = $('librarySearch');
    if (search) search.value = state.search || '';
    const tabId = Number(state.currentHitData?.tabId || hitId?.tabId || 0) || 0;
    if (tabId) await pauseListening(true, tabId);
    const extState = await getState().catch(() => null);
    await syncCurrentHitFromState(extState).catch(() => {});
    await ensureLibraryLoaded();
    await syncCurrentHitFromState(extState).catch(() => {});
    renderTree();
    await primeAvailabilityForVisibleNodes();
    updateFooter();
  }

  function close() {
    const tabId = Number(state.currentHitData?.tabId || 0) || 0;
    state.open = false;
    const overlay = $('libraryModal');
    if (overlay) overlay.hidden = true;
    if (tabId) pauseListening(false, tabId);
  }

  async function closeAndClearLibrary() {
    const closeBtn = $('libraryCloseBtn');
    try { closeBtn?.click?.(); } catch {}
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_HITS' });
    } catch {
      const clearBtn = $('clearBtn');
      try { clearBtn?.click?.(); } catch {}
    }
    close();
  }

  async function archiveSelected() {
    if (!state.selectedNode?.file) return;
    const extState = await getState();
    const hit = (extState?.hits || []).find(h => String(h.id) === String(state.currentHitId));
    const sourceHit = state.currentHitData || hit;
    if (!sourceHit) throw new Error('Could not find the current captured stream.');
    const selectedVariant = typeof window.getSelectedOption === 'function' ? window.getSelectedOption(sourceHit) : null;
    const subtitleUrls = Array.isArray(state.currentHitData?.selectedSubtitleUrls) && state.currentHitData.selectedSubtitleUrls.length
      ? state.currentHitData.selectedSubtitleUrls
      : (Array.isArray(sourceHit.selectedSubtitleUrls) && sourceHit.selectedSubtitleUrls.length
        ? sourceHit.selectedSubtitleUrls
        : []);
    const includeSubtitleUploads = includeSubtitleUploadsForCurrentHit();
    const archiveSubtitleUrls = includeSubtitleUploads ? subtitleUrls : [];
    const outputName = fileStem(state.selectedNode.file);
    const targetFolder = folderFromUrl(state.selectedNode.file);
    const payloadHit = {
      ...sourceHit,
      targetFileUrl: state.selectedNode.file,
      targetFileName: basenameFromUrl(state.selectedNode.file),
      targetFileStem: fileStem(state.selectedNode.file),
      selectedSubtitleUrls: Array.isArray(archiveSubtitleUrls) ? [...archiveSubtitleUrls] : [],
      selectedSubtitleUrl: Array.isArray(archiveSubtitleUrls) ? (archiveSubtitleUrls[0] || '') : '',
      subtitleBaseName: outputName,
      includeSubtitleUploads
    };
    const res = await chrome.runtime.sendMessage({
      type: 'ARCHIVE_HIT',
      id: sourceHit.id,
      hitData: payloadHit,
      outputName,
      targetFileUrl: state.selectedNode.file,
      targetFileName: basenameFromUrl(state.selectedNode.file),
      targetFileStem: fileStem(state.selectedNode.file),
      variantUrl: selectedVariant?.url || sourceHit.url || '',
      subtitleUrls: archiveSubtitleUrls,
      includeSubtitleUploads,
      subtitleBaseName: outputName,
      folder: targetFolder,
    });
    if (!res?.ok) throw new Error(res?.error || 'Archive failed');
    return res;
  }

  async function uploadSubtitleSelected() {
    if (!state.selectedNode?.file) throw new Error('Select an episode first.');
    const subtitleUrls = Array.isArray(state.currentHitData?.selectedSubtitleUrls) && state.currentHitData.selectedSubtitleUrls.length
      ? [...state.currentHitData.selectedSubtitleUrls]
      : [];
    if (!subtitleUrls.length) throw new Error('Select a subtitle first.');
    const extState = await getState();
    const hits = Array.isArray(extState?.hits) ? extState.hits : [];
    const subtitleHits = Array.isArray(state.currentHitData?.subtitleHits) && state.currentHitData.subtitleHits.length
      ? state.currentHitData.subtitleHits
      : hits.filter(h => String(h?.kind || '').toLowerCase() === 'subtitle');
    const subtitleHit = subtitleHits.find(sub => String(sub?.url || '') === String(subtitleUrls[0] || ''))
      || hits.find(sub => String(sub?.kind || '').toLowerCase() === 'subtitle' && String(sub?.url || '') === String(subtitleUrls[0] || ''));
    if (!subtitleHit) throw new Error('Could not find the selected subtitle in the captured items.');
    const outputName = fileStem(state.selectedNode.file);
    const targetFolder = folderFromUrl(state.selectedNode.file);
    const res = await chrome.runtime.sendMessage({
      type: 'ARCHIVE_HIT',
      id: subtitleHit.id,
      hitData: subtitleHit,
      outputName,
      subtitleBaseName: outputName,
      folder: targetFolder,
    });
    if (!res?.ok) throw new Error(res?.error || 'Subtitle upload failed');
    return res;
  }

  function selectNode(pathKey) {
    const node = flattenNodes(state.tree).find(n => n.path.join('>') === pathKey);
    if (!node) return;
    state.selectedPath = pathKey;
    state.selectedNode = node.file ? node : null;
    if (node.path?.length) touchRecentRoot(node.path[0]);
    if (node.file) {
      const existing = state.availability.get(node.file);
      if (!existing && getEpisodeAvailability(node).status !== 'pending') checkAvailabilityForNode(node);
    }
    updateFooter();
    renderTree();
  }

  function toggleNode(pathKey) {
    if (state.expanded.has(pathKey)) state.expanded.delete(pathKey);
    else state.expanded.add(pathKey);
    renderTree();
  }

  async function onSearchChange(value) {
    state.search = String(value || '').trim();
    renderTree();
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const toggle = t.closest('[data-toggle-node]');
    if (toggle && toggle.getAttribute('data-toggle-node')) {
      const pathKey = toggle.getAttribute('data-toggle-node') || '';
      if (pathKey) toggleNode(pathKey);
      return;
    }
    const select = t.closest('[data-select-node]');
    if (select && select.getAttribute('data-select-node')) {
      const pathKey = select.getAttribute('data-select-node') || '';
      if (pathKey) selectNode(pathKey);
      return;
    }
    const checkFolderBtn = t.closest('[data-check-folder]');
    if (checkFolderBtn && checkFolderBtn.getAttribute('data-check-folder')) {
      const pathKey = checkFolderBtn.getAttribute('data-check-folder') || '';
      const node = flattenNodes(state.tree).find(n => n.path.join('>') === pathKey);
      if (node) await checkFolder(node);
      return;
    }
    const checkVttFolderBtn = t.closest('[data-check-vtt-folder]');
    if (checkVttFolderBtn && checkVttFolderBtn.getAttribute('data-check-vtt-folder')) {
      const pathKey = checkVttFolderBtn.getAttribute('data-check-vtt-folder') || '';
      const node = flattenNodes(state.tree).find(n => n.path.join('>') === pathKey);
      if (node) await checkVttFolder(node);
      return;
    }
    const checkEpisodeBtn = t.closest('[data-check-episode]');
    if (checkEpisodeBtn && checkEpisodeBtn.getAttribute('data-check-episode')) {
      const pathKey = checkEpisodeBtn.getAttribute('data-check-episode') || '';
      const node = flattenNodes(state.tree).find(n => n.path.join('>') === pathKey);
      if (!node) return;
      const st = getEpisodeAvailability(node);
      if (st.status === 'exists' || st.status === 'pending') {
        selectNode(pathKey);
        return;
      }
      await checkAvailabilityForNode(node);
      selectNode(pathKey);
      return;
    }
    const checkVttBtn = t.closest('[data-check-vtt]');
    if (checkVttBtn && checkVttBtn.getAttribute('data-check-vtt')) {
      const pathKey = checkVttBtn.getAttribute('data-check-vtt') || '';
      const node = flattenNodes(state.tree).find(n => n.path.join('>') === pathKey);
      if (!node) return;
      await checkVttAvailabilityForNode(node);
      return;
    }
    const subtitleBtn = t.closest('[data-select-library-subtitle]');
    if (subtitleBtn && subtitleBtn.getAttribute('data-select-library-subtitle')) {
      const url = subtitleBtn.getAttribute('data-select-library-subtitle') || '';
      if (url) {
        setSelectedSubtitleUrl(url);
        return;
      }
    }
  });

  window.openLibraryPicker = open;
  window.closeLibraryPicker = close;
  window.refreshLibraryPicker = async () => { await ensureLibraryLoaded(true); };
  window.archiveLibrarySelection = archiveSelected;

  document.addEventListener('input', ev => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.id === 'librarySearch') {
      onSearchChange(t.value).catch(err => {
        state.error = String(err?.message || err);
        renderTree();
      });
    }
  });

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === 'libraryCloseBtn' || t.closest('#libraryCloseBtn')) { close(); return; }
    if (t.id === 'libraryReloadBtn' || t.closest('#libraryReloadBtn')) { state.loading = true; renderTree(); await ensureLibraryLoaded(true); return; }
    if (t.id === 'libraryArchiveBtn' || t.closest('#libraryArchiveBtn')) {
      const btn = $('libraryArchiveBtn');
      if (!btn || btn.disabled) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Archiving…';
      try {
        const started = await archiveSelected();
        if (started?.ok) {
          await closeAndClearLibrary();
        }
      } catch (err) {
        state.error = String(err?.message || err); renderTree();
      } finally {
        btn.disabled = false;
        btn.textContent = original || 'Archive selected';
      }
      return;
    }
    if (t.closest('[data-toggle-library-subtitle]')) {
      state.subtitlePickerExpanded = !state.subtitlePickerExpanded;
      updateFooter();
      return;
    }
    if (t.id === 'libraryArchiveSubtitleToggle' || t.closest('#libraryArchiveSubtitleToggle')) {
      const el = $('libraryArchiveSubtitleToggle');
      if (!el) return;
      setIncludeSubtitleUploadsForCurrentHit(el.checked);
      return;
    }
    if (t.id === 'libraryUseBtn' || t.closest('#libraryUseBtn')) {
      if (!state.selectedNode?.file) return;
      if (!Array.isArray(state.currentHitData?.selectedSubtitleUrls) || !state.currentHitData.selectedSubtitleUrls.length) return;
      const btn = $('libraryUseBtn');
      const original = btn?.textContent || 'Upload Subtitle';
      if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
      try {
        const started = await uploadSubtitleSelected();
        if (started?.ok) await closeAndClearLibrary();
      } catch (err) {
        state.error = String(err?.message || err);
        renderTree();
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = original || 'Upload Subtitle'; }
      }
    }
  });

  setInterval(() => {
    if (!state.open) return;
    syncCurrentHitFromState().catch(() => {});
    updateFooter();
  }, 1200);
})();