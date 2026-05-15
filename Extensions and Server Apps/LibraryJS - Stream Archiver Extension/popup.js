const $ = (id) => document.getElementById(id);
const selectedVariantByHit = new Map();
const selectedSubtitleByHit = new Map();
const subtitleSectionsCollapsedByHit = new Map();
const subtitlePreviewCache = new Map();
const subtitleSearchQueryByHit = new Map();
const subtitlePreviewScoreByKey = new Map();
const includeSubtitleUploadsByHit = new Map();
const SUBTITLE_CAPTURE_WINDOW_MS = 5000;
let currentSettings = {};
const VIEW_MODE_STORAGE_KEY = 'stream-archiver-view-mode';
let compactViewEnabled = false;

function loadCompactViewPreference() {
  try {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === 'compact') return true;
    if (stored === 'normal') return false;
  } catch {}
  return false;
}

function saveCompactViewPreference(value) {
  compactViewEnabled = !!value;
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, compactViewEnabled ? 'compact' : 'normal');
  } catch {}
}

function isActiveHit(hit = {}) {
  const status = String(hit?.status || '').toLowerCase();
  if (['queued', 'downloading', 'remuxing', 'archiving', 'pending', 'retrying', 'failed', 'partial', 'missing'].includes(status)) return true;
  const missingCount = Number(hit?.missingSegmentCount || 0);
  const missingUrls = Array.isArray(hit?.missingSegmentUrls) ? hit.missingSegmentUrls.filter(Boolean) : [];
  return !!hit?.retainOnClear || missingCount > 0 || missingUrls.length > 0;
}

function getWorkingStageStatus(hit = {}) {
  const status = String(hit?.status || '').toLowerCase();
  return ['downloading', 'remuxing', 'archiving'].includes(status) ? status : '';
}
let subtitlePreviewState = { parentKey: '', subtitleUrl: '', loading: false, text: '', title: '', meta: '', optionIndex: 0, optionTotal: 0 };
function escapeHtml(str) {
  return String(str || '').replace(/[&<>'"]/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[m]));
}
function fmtBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
function fmtRate(bytesPerSec) {
  const n = Math.max(0, Number(bytesPerSec) || 0);
  if (!n) return '0 KB/s';
  return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB/s`;
}
const COUNTED_VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'ts', 'm2ts', 'mpg', 'mpeg', 'avi', 'flv', 'wmv', 'ogv', '3gp', '3g2', 'f4v', 'mxf'
]);

function isCountedArchiveFile(name = '') {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/)?.[1] || '';
  return COUNTED_VIDEO_EXTENSIONS.has(ext);
}

function countArchivedMediaFiles(hit = {}) {
  if (!Array.isArray(hit.archivedFiles)) return 0;
  return hit.archivedFiles.reduce((count, fileName) => count + (isCountedArchiveFile(fileName) ? 1 : 0), 0);
}
function isMainCardKind(kind) {
  const value = String(kind || '').toLowerCase();
  return value === 'playlist' || value === 'media' || value === 'dom-media';
}

function normalizeComparableUrl(url = '') {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/+$/g, '').toLowerCase();
  } catch {
    return String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/g, '').toLowerCase();
  }
}

function normalizeCardFamilyText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeComparableOrigin(url = '') {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/g, '').toLowerCase();
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

function mainCardFamilyKey(hit = {}) {
  if (!hit) return '';
  const tab = String(Number(hit.tabId || 0) || '');
  const page = normalizeComparablePageUrl(hit.pageUrl || '');
  const title = normalizeStreamFamilyTitle(hit.archiveName || hit.title || hit.quality || hit.playlistType || '');
  const source = normalizeComparableUrl(hit.sourceUrl || hit.url || '');
  const sourceOrigin = normalizeComparableOrigin(hit.sourceUrl || hit.url || '');
  const kind = String(hit.kind || '').toLowerCase();

  if (kind === 'playlist') {
    const familyRoot = page || sourceOrigin || source || '';
    return [tab, familyRoot].filter(Boolean).join('|') || [tab, familyRoot, source].join('|');
  }

  const root = page || source || '';
  return [tab, root, title, source].filter(Boolean).join('|');
}

function mainCardDisplayRank(hit = {}) {
  const selected = getSelectedOption(hit);
  const selectedScore = qualityScore(selected?.label || selected?.quality || selected?.resolution, selected?.url);
  const ownScore = qualityScore(hit.quality || hit.title || '', hit.url);
  const optionCount = Array.isArray(hit.qualityOptions) ? hit.qualityOptions.length : (Array.isArray(hit.variants) ? hit.variants.length : 0);
  const variantScore = Math.max(0, Number(hit.variantCount || 0));
  return Math.max(ownScore, selectedScore) * 100 + optionCount * 10 + variantScore;
}

function mergeMainCardHits(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  const merged = { ...base };
  const want = (field, preferExtra = false) => {
    const a = merged[field];
    const b = extra[field];
    if (preferExtra) return b ?? a;
    return a ?? b;
  };

  merged.lastSeen = Math.max(Number(base.lastSeen || base.ts || 0), Number(extra.lastSeen || extra.ts || 0));
  merged.ts = Math.max(Number(base.ts || 0), Number(extra.ts || 0)) || merged.lastSeen;
  merged.status = isActiveHit(extra) ? extra.status : (merged.status || extra.status || 'new');
  merged.error = merged.error || extra.error || '';
  merged.pageUrl = want('pageUrl', true) || '';
  merged.sourceUrl = want('sourceUrl', true) || want('url', true) || '';
  merged.url = want('url', true) || '';
  merged.title = want('title', true) || '';
  merged.archiveName = want('archiveName', true) || '';
  merged.quality = want('quality', true) || merged.quality || '';
  merged.playlistType = want('playlistType', true) || merged.playlistType || '';
  merged.variantCount = Math.max(Number(base.variantCount || 0), Number(extra.variantCount || 0));
  merged.segmentCount = Math.max(Number(base.segmentCount || 0), Number(extra.segmentCount || 0));

  const mergeByUrl = (items) => {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
      const url = String(item?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(item);
    }
    return out;
  };

  if (Array.isArray(base.qualityOptions) || Array.isArray(extra.qualityOptions)) {
    merged.qualityOptions = mergeByUrl([...(base.qualityOptions || []), ...(extra.qualityOptions || [])])
      .sort((a, b) => (Number(b?.score || 0) - Number(a?.score || 0)) || String(a?.label || '').localeCompare(String(b?.label || '')) || String(a?.url || '').localeCompare(String(b?.url || '')));
  }
  if (Array.isArray(base.variants) || Array.isArray(extra.variants)) {
    merged.variants = mergeByUrl([...(base.variants || []), ...(extra.variants || [])]);
  }

  const best = (mainCardDisplayRank(extra) > mainCardDisplayRank(base)) ? extra : base;
  if (best !== merged) {
    merged.selectedVariantUrl = best.selectedVariantUrl || merged.selectedVariantUrl || '';
  }
  if (Array.isArray(merged.qualityOptions) && merged.qualityOptions.length) {
    const top = merged.qualityOptions[0];
    if (top?.url) merged.selectedVariantUrl = top.url;
    if (top?.label) merged.quality = top.label;
  }
  return merged;
}

function dedupeMainCardsByFamily(hits, preferActive = false) {
  const buckets = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit || !isMainCardKind(hit.kind)) continue;
    const key = mainCardFamilyKey(hit) || hit.id || hit.key || hit.url || '';
    if (!buckets.has(key)) {
      buckets.set(key, { ...hit });
      continue;
    }
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { ...hit });
      continue;
    }
    const existingActive = isActiveHit(existing);
    const nextActive = isActiveHit(hit);
    if (preferActive && nextActive && !existingActive) {
      buckets.set(key, mergeMainCardHits(hit, existing));
      continue;
    }
    if (existingActive && !nextActive) {
      buckets.set(key, mergeMainCardHits(existing, hit));
      continue;
    }

    const existingRank = mainCardDisplayRank(existing);
    const nextRank = mainCardDisplayRank(hit);
    if (nextRank > existingRank || (nextRank === existingRank && Number(hit.lastSeen || hit.ts || 0) >= Number(existing.lastSeen || existing.ts || 0))) {
      buckets.set(key, mergeMainCardHits(hit, existing));
    } else {
      buckets.set(key, mergeMainCardHits(existing, hit));
    }
  }
  return [...buckets.values()].sort((a, b) => Number(b.lastSeen || b.ts || 0) - Number(a.lastSeen || a.ts || 0));
}

function subtitleUploadsEnabledByDefault() {
  return currentSettings?.captureSubtitleFiles !== false;
}
function includeSubtitleUploadsForHit(hit = {}) {
  const key = hit?.id || '';
  if (key && includeSubtitleUploadsByHit.has(key)) return !!includeSubtitleUploadsByHit.get(key);
  return subtitleUploadsEnabledByDefault();
}
function setIncludeSubtitleUploadsForHit(hit = {}, value) {
  const key = hit?.id || '';
  if (!key) return;
  includeSubtitleUploadsByHit.set(key, !!value);
}
function fmtPct(done, total) {
  if (!(total > 0)) return '0%';
  const pct = Math.min(100, Math.max(0, (Number(done) || 0) / total * 100));
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}
function displayPctForHit(hit, progress) {
  const segmentDone = Number(hit?.segmentProgressDone || 0);
  const segmentTotal = Number(hit?.segmentProgressTotal || 0);
  const currentIndex = Number(hit?.currentSegmentIndex || 0);
  const currentPct = Number(hit?.currentSegmentProgress || 0);
  if (segmentTotal > 0) {
    if (currentIndex > 0 && currentPct > 0 && currentPct < 100) {
      const completedBeforeCurrent = Math.max(0, Math.min(segmentTotal, Math.max(segmentDone, currentIndex - 1)));
      const liveDone = Math.min(segmentTotal, completedBeforeCurrent + (currentPct / 100));
      return fmtPct(liveDone, segmentTotal);
    }
    return fmtPct(segmentDone, segmentTotal);
  }
  return fmtPct(progress.overallDone, progress.overallTotal);
}
function progressWidth(done, total) {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (Number(done) || 0) / total * 100));
}
function buildProgressLine(hit) {
  const segmentDone = Math.max(0, Number(hit.segmentProgressDone || 0));
  const segmentTotal = Math.max(0, Number(hit.segmentProgressTotal || hit.segmentCount || 0));
  const segmentPct = progressWidth(segmentDone, segmentTotal);
  const currentIndex = Number(hit.currentSegmentIndex || 0);
  const currentTotal = Number(hit.currentSegmentTotal || 0);
  const currentPct = Math.max(0, Math.min(100, Number(hit.currentSegmentProgress || 0)));
  const currentName = hit.currentSegmentName || '';
  const currentBytes = Number(hit.currentSegmentBytes || 0);
  const currentBytesTotal = Number(hit.currentSegmentBytesTotal || 0);
  const currentRate = Number(hit.currentSegmentSpeedBps || 0);
  const currentLabel = hit.currentSegmentStatus ? String(hit.currentSegmentStatus) : '';
  const doneWhole = Math.min(segmentTotal, Math.floor(segmentDone + 1e-6));
  const chunks = [];
  if (currentTotal > 0) chunks.push(`Segment ${currentIndex} / ${currentTotal}`);
  if (currentPct > 0 || currentTotal > 0) chunks.push(`${currentPct.toFixed(currentPct < 10 ? 1 : 0)}%`);
  if (currentBytesTotal > 0) chunks.push(`${fmtBytes(currentBytes)} / ${fmtBytes(currentBytesTotal)}`);
  else if (currentBytes > 0) chunks.push(fmtBytes(currentBytes));
  if (currentRate > 0) chunks.push(fmtRate(currentRate));
  if (currentName) chunks.push(currentName);
  if (currentLabel && currentLabel !== 'downloading') chunks.push(currentLabel);
  return {
    segmentDone,
    segmentTotal,
    segmentPct,
    segmentText: segmentTotal > 0 ? `${doneWhole} / ${segmentTotal} segments` : '',
    segmentSummary: segmentTotal > 0 ? `${fmtPct(segmentDone, segmentTotal)} • ${doneWhole.toFixed(0)} / ${segmentTotal.toFixed(0)}` : '',
    currentPct,
    currentText: chunks.join(' • ')
  };
}

function buildAggregateProgress(hits) {
  const active = [];
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!isMainCardKind(hit?.kind)) continue;
    const status = String(hit?.status || '').toLowerCase();
    if (status === 'archived' || status === 'complete' || status === 'done') continue;
    const total = Math.max(0, Number(hit?.segmentProgressTotal || hit?.segmentCount || 0));
    const done = Math.max(0, Number(hit?.segmentProgressDone || 0));
    if (!(total > 0) || done >= total) continue;
    if (status && !['queued', 'archiving', 'downloading', 'pending', 'retrying'].includes(status)) continue;
    active.push({ done, total });
  }
  const total = active.reduce((sum, item) => sum + item.total, 0);
  const done = active.reduce((sum, item) => sum + Math.min(item.total, item.done), 0);
  const pct = progressWidth(done, total);
  const doneWhole = Math.min(total, Math.floor(done + 1e-6));
  return {
    activeCount: active.length,
    done,
    total,
    pct,
    text: total > 0 ? `${doneWhole} / ${total} segments` : 'Idle',
    label: active.length ? `${active.length} active ${active.length === 1 ? 'card' : 'cards'} • ${doneWhole} / ${total} segments` : 'Idle'
  };
}

function qualityScore(label, url) {
  const text = String(label || '').trim();
  const m = text.match(/(2160|1440|1080|720|480|360|240)\s*p/i)
    || text.match(/(?:^|\D)(2160|1440|1080|720|480|360|240)(?:\D|$)/i)
    || String(url || '').match(/(?:^|\D)(2160|1440|1080|720|480|360|240)(?:p|\D|$)/i);
  return Number(m?.[1] || m?.[2] || 0) || 0;
}
function normalizeQualityLabel(option) {
  const raw = String(option?.label || option?.quality || option?.resolution || '').trim();
  const score = qualityScore(raw, option?.url);
  if (score > 0) return `${score}p`;
  const fromUrl = qualityScore('', option?.url);
  if (fromUrl > 0) return `${fromUrl}p`;
  return '0p';
}
function sortQualityOptions(options) {
  const mapped = [...(Array.isArray(options) ? options : [])]
    .map((opt, idx) => ({
      ...opt,
      _idx: idx,
      label: normalizeQualityLabel(opt),
      score: qualityScore(opt?.label || opt?.quality || opt?.resolution, opt?.url)
    }))
    .filter(opt => opt.url)
    .filter((opt, idx, arr) => arr.findIndex(other => other.url === opt.url) === idx);
  const hasRealQuality = mapped.some(opt => (opt.score || 0) > 0);
  return mapped
    .filter(opt => hasRealQuality ? (opt.score || 0) > 0 : true)
    .sort((a, b) => {
      const qb = (b.score || 0) - (a.score || 0);
      if (qb) return qb;
      return a._idx - b._idx;
    });
}
function getHostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return 'stream'; }
}
function getPathLabel(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/g, '');
    const parts = path.split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  } catch {
    return '';
  }
}
function getCardLabel(hit, selectedUrl) {
  const baseUrl = selectedUrl || hit.url || '';
  const host = getHostLabel(baseUrl);
  const path = getPathLabel(baseUrl);
  const displayName = String(hit.archiveName || hit.title || '').trim();
  if (displayName) return displayName;
  return path ? `${host} • ${path}` : host;
}
const SUBTITLE_LANGUAGE_NAMES = {
  en: 'English', eng: 'English', enus: 'English', engb: 'English', enca: 'English', enau: 'English',
  es: 'Spanish', spa: 'Spanish', fr: 'French', fra: 'French', fre: 'French',
  de: 'German', deu: 'German', ger: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', zho: 'Chinese', chi: 'Chinese',
  ru: 'Russian', rus: 'Russian', ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi',
  tr: 'Turkish', tur: 'Turkish', nl: 'Dutch', nld: 'Dutch', dut: 'Dutch'
};
function subtitleLanguageName(raw = '') {
  const txt = String(raw || '').trim().toLowerCase();
  if (!txt) return '';
  const cleaned = txt.replace(/[^a-z0-9]/g, '');
  if (SUBTITLE_LANGUAGE_NAMES[cleaned]) return SUBTITLE_LANGUAGE_NAMES[cleaned];
  const compact = txt.replace(/[^a-z]/g, '');
  if (SUBTITLE_LANGUAGE_NAMES[compact]) return SUBTITLE_LANGUAGE_NAMES[compact];
  if (/^en(?:g(?:lish)?)?$/.test(compact)) return 'English';
  if (/^es/.test(compact)) return 'Spanish';
  if (/^fr/.test(compact)) return 'French';
  if (/^de/.test(compact)) return 'German';
  if (/^pt/.test(compact)) return 'Portuguese';
  if (/^zh/.test(compact)) return 'Chinese';
  return txt ? txt.charAt(0).toUpperCase() + txt.slice(1) : '';
}
function subtitleDescriptor(hit = {}) {
  const lang = subtitleLanguageName(hit.subtitleLang || hit.srclang || hit.language || '');
  const label = String(hit.subtitleLabel || hit.label || '').trim();
  const kind = String(hit.subtitleKind || '').toLowerCase();
  const kindLabel = kind === 'captions' ? 'Captions' : 'Subtitles';
  const parts = [];
  if (lang) parts.push(lang);
  if (label && label.toLowerCase() !== lang.toLowerCase()) parts.push(label);
  if (kindLabel && parts.every(p => p.toLowerCase() !== kindLabel.toLowerCase())) parts.push(kindLabel);
  return parts.join(' • ') || 'Subtitle';
}
function subtitleFileBadge(hit = {}) {
  const ct = String(hit.contentType || '').toLowerCase();
  const url = String(hit.url || '').toLowerCase();
  if (/\bsubrip\b/.test(ct) || /\.(?:srt)(?:$|[?#])/.test(url)) return 'SRT → VTT';
  return 'VTT';
}
function subtitleTypeLabel(hit = {}) {
  return `${subtitleDescriptor(hit)} • ${subtitleFileBadge(hit)}`;
}
function subtitleChipLabel(hit = {}) {
  const descriptor = subtitleDescriptor(hit);
  const badge = subtitleFileBadge(hit);
  return descriptor ? `${descriptor} • ${badge}` : badge;
}
function subtitleOptionLabel(index, total, hit = {}) {
  const ordinal = Number(index || 0) + 1;
  const count = Number(total || 0);
  const prefix = count > 1 ? `Option ${ordinal} of ${count}` : `Option ${ordinal}`;
  return `${prefix}: ${subtitleChipLabel(hit)}`;
}
function subtitleSelectionKey(parentHit) {
  return parentHit?.id || parentHit?.key || parentHit?.url || '';
}
function subtitleSectionCollapsedKey(parentHit) {
  return subtitleSelectionKey(parentHit);
}
function isSubtitleSectionCollapsed(parentHit) {
  return !!subtitleSectionsCollapsedByHit.get(subtitleSectionCollapsedKey(parentHit));
}
function setSubtitleSectionCollapsed(parentHit, collapsed = true) {
  const key = subtitleSectionCollapsedKey(parentHit);
  if (!key) return;
  if (collapsed) subtitleSectionsCollapsedByHit.set(key, true);
  else subtitleSectionsCollapsedByHit.delete(key);
}
function normalizeComparablePageUrl(url = '') {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/+$/g, '').toLowerCase();
  } catch {
    return String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/g, '').toLowerCase();
  }
}
function subtitleCaptureDeltaMs(parentHit, subtitleHit) {
  const parentTime = Number(parentHit?.ts || parentHit?.lastSeen || 0);
  const subtitleTime = Number(subtitleHit?.ts || subtitleHit?.lastSeen || 0);
  if (!parentTime || !subtitleTime) return null;
  return Math.abs(parentTime - subtitleTime);
}
function sameMediaFamily(parentHit, subtitleHit) {
  if (!parentHit || !subtitleHit) return false;
  const parentPage = normalizeComparablePageUrl(parentHit.pageUrl || '');
  const subtitlePage = normalizeComparablePageUrl(subtitleHit.pageUrl || '');
  const samePage = parentPage && subtitlePage && parentPage === subtitlePage;
  const sameTab = Number(parentHit.tabId || 0) && Number(subtitleHit.tabId || 0) && Number(parentHit.tabId || 0) === Number(subtitleHit.tabId || 0);
  const parentSource = String(parentHit.sourceUrl || parentHit.url || '').trim();
  const subtitleSource = String(subtitleHit.sourceUrl || subtitleHit.url || '').trim();
  const sameSource = parentSource && subtitleSource && parentSource === subtitleSource;
  if (!(samePage || sameTab || sameSource)) return false;
  const delta = subtitleCaptureDeltaMs(parentHit, subtitleHit);
  if (delta === null) return true;
  return delta <= SUBTITLE_CAPTURE_WINDOW_MS;
}
function subtitleAffinityScore(parentHit, subtitleHit) {
  if (!parentHit || !subtitleHit) return 0;
  let score = 0;
  const parentPage = String(parentHit.pageUrl || '').trim();
  const subtitlePage = String(subtitleHit.pageUrl || '').trim();
  if (parentPage && subtitlePage) {
    if (parentPage !== subtitlePage) return 0;
    const delta = subtitleCaptureDeltaMs(parentHit, subtitleHit);
    if (delta !== null && delta > SUBTITLE_CAPTURE_WINDOW_MS) return 0;
    score += 80;
    if (delta !== null) score += Math.max(0, 20 - Math.floor(delta / 250));
  } else {
    const parentSource = String(parentHit.sourceUrl || parentHit.url || '').trim();
    const subtitleSource = String(subtitleHit.sourceUrl || '').trim();
    if (parentSource && subtitleSource && parentSource === subtitleSource) score += 30;
  }
  if (String(parentHit.kind || '').toLowerCase() === 'media') score += 8;
  if (String(parentHit.kind || '').toLowerCase() === 'playlist') score += 5;
  score += Math.min(5, Number(parentHit.lastSeen || parentHit.ts || 0) ? 1 : 0);
  return score;
}
function groupedHits(hits) {
  const all = Array.isArray(hits) ? [...hits] : [];
  const sorted = all.sort((a, b) => {
    const ak = a.kind === 'media' ? 0 : 1;
    const bk = b.kind === 'media' ? 0 : 1;
    if (ak !== bk) return ak - bk;
    return Number(b.lastSeen || b.ts || 0) - Number(a.lastSeen || a.ts || 0);
  });
  const subtitleHits = sorted.filter(h => h.kind === 'subtitle');
  const primaries = sorted.filter(h => h.kind !== 'subtitle');
  return primaries.map(primary => ({
    ...primary,
    subtitleHits: subtitleHits.filter(sub => sameMediaFamily(primary, sub))
  }));
}
function defaultSubtitleSelection(parentHit) {
  const subs = Array.isArray(parentHit.subtitleHits) ? parentHit.subtitleHits : [];
  if (!subs.length) return '';
  const active = subs.find(hit => hit.subtitleActive || hit.subtitleDefault);
  const english = subs.find(hit => /english|eng|en-us|en-gb|en-ca|en-au/i.test([hit.subtitleLang, hit.subtitleLabel, hit.title, hit.subtitleKind].filter(Boolean).join(' ')));
  return (active || english || subs[0] || {}).url || '';
}
function getSelectedSubtitleUrls(parentHit) {
  const key = subtitleSelectionKey(parentHit);
  if (!key) return [];
  if (!selectedSubtitleByHit.has(key)) {
    selectedSubtitleByHit.set(key, defaultSubtitleSelection(parentHit));
  }
  const selected = selectedSubtitleByHit.get(key);
  return selected ? [selected] : [];
}
function toggleSubtitleSelection(parentHit, subtitleHit) {
  const key = subtitleSelectionKey(parentHit);
  if (!key || !subtitleHit?.url) return;
  selectedSubtitleByHit.set(key, subtitleHit.url);
}
function subtitlePreviewKey(parentHit, subtitleHit) {
  return `${subtitleSelectionKey(parentHit)}::${subtitleHit?.url || ''}`;
}
function subtitlePreviewSummary(hit = {}) {
  const parts = [];
  if (hit.subtitleActive) parts.push('Now playing');
  if (hit.subtitleDefault) parts.push('Default track');
  const type = subtitleFileBadge(hit);
  if (type) parts.push(type);
  const ct = String(hit.contentType || '').trim();
  if (ct) parts.push(ct);
  return parts.join(' • ');
}
function subtitlePreviewMatches(parentHit, subtitleHit) {
  return !!subtitlePreviewState.subtitleUrl
    && subtitlePreviewState.parentKey === subtitleSelectionKey(parentHit)
    && subtitlePreviewState.subtitleUrl === String(subtitleHit?.url || '');
}

function escapeRegExp(text = '') {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function subtitleSearchKey(parentHit) {
  return subtitleSelectionKey(parentHit);
}
function parseSubtitleSearchTerms(raw = '') {
  const tokens = String(raw || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 12);
  return [...new Set(tokens)];
}
function subtitleSearchTerms(parentHit) {
  const raw = subtitleSearchQueryByHit.get(subtitleSearchKey(parentHit)) || 'the and to of a';
  return parseSubtitleSearchTerms(raw);
}
function subtitlePreviewTextScore(text = '', terms = []) {
  const sample = String(text || '').toLowerCase();
  if (!sample) return 0;
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const rx = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g');
    const matches = sample.match(rx);
    if (matches && matches.length) score += Math.min(12, matches.length * 3);
  }
  for (const word of ['the', 'and', 'to', 'of', 'a']) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(sample)) score += 1;
  }
  if (/\\benglish\\b|\\beng\\b|en-us|en-gb|captions?|subtitles?/i.test(sample)) score += 6;
  return score;
}
function subtitlePreviewHeuristicScore(parentHit, subtitleHit) {
  const labelParts = [subtitleHit?.subtitleLang, subtitleHit?.subtitleLabel, subtitleHit?.title, subtitleHit?.subtitleKind, subtitleHit?.url]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  if (/\\benglish\\b|\\beng\\b|en-us|en-gb|en-ca|en-au|\\bcaption\\b|\\bsubtitle\\b/.test(labelParts)) score += 15;
  if (/^en(?:[-_].*|$)/.test(String(subtitleHit?.subtitleLang || subtitleHit?.srclang || subtitleHit?.language || '').trim().toLowerCase())) score += 12;
  if (subtitleHit?.subtitleDefault) score += 3;
  if (subtitleHit?.subtitleActive) score += 2;
  const cached = subtitlePreviewCache.get(subtitlePreviewKey(parentHit, subtitleHit)) || '';
  score += Math.min(4, subtitlePreviewTextScore(cached, subtitleSearchTerms(parentHit)) > 0 ? 1 : 0);
  return score;
}
function subtitlePreviewCachedScore(parentHit, subtitleHit) {
  const key = subtitlePreviewKey(parentHit, subtitleHit);
  const cached = subtitlePreviewScoreByKey.get(key);
  if (Number.isFinite(Number(cached))) return Number(cached);
  return subtitlePreviewHeuristicScore(parentHit, subtitleHit);
}
function scoreAndRememberSubtitle(parentHit, subtitleHit, text = '') {
  const key = subtitlePreviewKey(parentHit, subtitleHit);
  const score = Math.max(subtitlePreviewHeuristicScore(parentHit, subtitleHit), subtitlePreviewTextScore(text, subtitleSearchTerms(parentHit)));
  subtitlePreviewScoreByKey.set(key, score);
  return score;
}
async function scanSubtitleCandidates(parentHit) {
  const key = subtitleSelectionKey(parentHit);
  const subtitleHits = Array.isArray(parentHit.subtitleHits) ? parentHit.subtitleHits : [];
  const raw = subtitleSearchQueryByHit.get(key) || 'the and to of a';
  subtitleSearchQueryByHit.set(key, raw);
  for (let i = 0; i < subtitleHits.length; i++) {
    const subHit = subtitleHits[i];
    if (!subHit?.url) continue;
    try {
      const text = await loadSubtitlePreview(parentHit, subHit, i, subtitleHits.length, { silent: true });
      scoreAndRememberSubtitle(parentHit, subHit, text || subtitlePreviewCache.get(subtitlePreviewKey(parentHit, subHit)) || '');
    } catch {
      scoreAndRememberSubtitle(parentHit, subHit, subtitlePreviewCache.get(subtitlePreviewKey(parentHit, subHit)) || '');
    }
  }
  await refresh();
}
function sortedSubtitleHits(parentHit) {
  const subtitleHits = Array.isArray(parentHit.subtitleHits) ? [...parentHit.subtitleHits] : [];
  return subtitleHits.sort((a, b) => {
    const scoreDelta = subtitlePreviewCachedScore(parentHit, b) - subtitlePreviewCachedScore(parentHit, a);
    if (scoreDelta) return scoreDelta;
    return Number(a?.subtitleTrackIndex || 0) - Number(b?.subtitleTrackIndex || 0);
  });
}
function subtitleSectionSearchValue(parentHit) {
  const key = subtitleSelectionKey(parentHit);
  return subtitleSearchQueryByHit.get(key) || 'the and to of a';
}

async function loadSubtitlePreview(parentHit, subtitleHit, index = 0, total = 0, options = {}) {
  const key = subtitlePreviewKey(parentHit, subtitleHit);
  const silent = !!options?.silent;
  if (!subtitleHit?.url) return null;
  if (!silent) {
    subtitlePreviewState = {
      parentKey: subtitleSelectionKey(parentHit),
      subtitleUrl: subtitleHit.url,
      loading: true,
      text: subtitlePreviewCache.get(key) || '',
      title: `Previewing ${subtitleOptionLabel(index, total, subtitleHit)}`,
      meta: subtitlePreviewSummary(subtitleHit),
      optionIndex: Number(index || 0),
      optionTotal: Number(total || 0)
    };
    await refresh();
  }
  if (subtitlePreviewCache.has(key)) {
    const cached = subtitlePreviewCache.get(key) || '';
    if (!silent) {
      subtitlePreviewState.loading = false;
      subtitlePreviewState.text = cached;
      await refresh();
    }
    return cached;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'GET_SUBTITLE_PREVIEW',
    id: subtitleHit.id,
    baseName: parentHit.archiveName || parentHit.title || parentHit.quality || 'archive',
    subtitleCount: Array.isArray(parentHit.subtitleHits) ? parentHit.subtitleHits.length : 0,
    subtitleIndex: Number(subtitleHit.subtitleTrackIndex || 0)
  });
  const text = String(res?.text || '').replace(/\r\n/g, '\n');
  subtitlePreviewCache.set(key, text);
  scoreAndRememberSubtitle(parentHit, subtitleHit, text);
  if (!silent) {
    subtitlePreviewState = {
      parentKey: subtitleSelectionKey(parentHit),
      subtitleUrl: subtitleHit.url,
      loading: false,
      text,
      title: `Previewing ${subtitleOptionLabel(Number(subtitleHit.subtitleTrackIndex || 0), Number(subtitleHit.subtitleCount || 0), subtitleHit)}`,
      meta: [
        subtitlePreviewSummary(subtitleHit),
        res?.previewName || '',
        res?.converted ? 'Converted from SRT' : '',
        res?.looksReadable ? 'Looks readable' : 'May not be a valid subtitle file'
      ].filter(Boolean).join(' • '),
      optionIndex: Number(subtitleHit.subtitleTrackIndex || 0),
      optionTotal: Number(subtitleHit.subtitleCount || 0)
    };
    await refresh();
  }
  return text;
}
function closeSubtitlePreview() {
  subtitlePreviewState = { parentKey: '', subtitleUrl: '', loading: false, text: '', title: '', meta: '' };
  refresh().catch(() => {});
}
function renderSubtitleChip(parentHit, subtitleHit, index = 0, total = 0) {
  const key = subtitleSelectionKey(parentHit);
  const selectedUrl = selectedSubtitleByHit.get(key) || defaultSubtitleSelection(parentHit);
  const selected = selectedUrl === subtitleHit.url;
  const active = !!subtitleHit.subtitleActive;
  const previewing = subtitlePreviewMatches(parentHit, subtitleHit);
  const score = subtitlePreviewCachedScore(parentHit, subtitleHit);
  const bestScore = Math.max(...(Array.isArray(parentHit.subtitleHits) ? parentHit.subtitleHits : []).map(sub => subtitlePreviewCachedScore(parentHit, sub)).concat([0]));
  const classes = ['subtitle-chip'];
  if (selected) classes.push('selected');
  if (active) classes.push('active');
  if (previewing) classes.push('previewing');
  if (score > 0 && score >= bestScore) classes.push('best-match');
  const label = subtitleOptionLabel(index, total, subtitleHit);
  const ct = String(subtitleHit.contentType || '').trim();
  const source = String(subtitleHit.sourceUrl || '').trim();
  const extra = [subtitlePreviewSummary(subtitleHit), ct, source].filter(Boolean).join(' • ');
  const previewPanel = previewing ? renderSubtitlePreviewPanel(parentHit, subtitleHit, index, total) : '';
  return `<span class="subtitle-item${selected ? ' selected' : ''}${active ? ' active' : ''}${previewing ? ' previewing' : ''}"><span class="subtitle-controls"><button class="${classes.join(' ')}" data-toggle-subtitle="${escapeHtml(parentHit.id)}" data-subtitle-url="${escapeHtml(subtitleHit.url)}" title="${escapeHtml([label, extra, subtitleHit.url].filter(Boolean).join(' • '))}">${escapeHtml(label)}</button><button class="subtitle-preview-btn" data-preview-subtitle="${escapeHtml(parentHit.id)}" data-subtitle-url="${escapeHtml(subtitleHit.url)}" title="Preview ${escapeHtml(`Option ${Number(index || 0) + 1}`)}">Preview</button></span>${previewPanel}</span>`;
}
function renderSubtitlePreviewPanel(parentHit, subtitleHit, index = 0, total = 0) {
  if (!subtitlePreviewMatches(parentHit, subtitleHit)) return '';
  const loading = subtitlePreviewState.loading;
  const text = subtitlePreviewState.text || '';
  const previewLines = text ? text.split('\n').slice(0, 120).join('\n') : '';
  const headerIndex = Number(index || subtitlePreviewState.optionIndex || 0) + 1;
  const headerTotal = Number(total || subtitlePreviewState.optionTotal || 0);
  const header = headerTotal > 1 ? `Previewing Option ${headerIndex} of ${headerTotal}` : `Previewing Option ${headerIndex}`;
  return `
    <div class="subtitle-preview-panel inline-preview">
      <div class="subtitle-preview-head">
        <div>
          <div class="subtitle-preview-title">${escapeHtml(header)}</div>
          <div class="subtitle-preview-meta">${escapeHtml(subtitlePreviewState.meta || '')}</div>
        </div>
        <button class="subtitle-preview-close" data-close-preview="1" title="Close preview">&times;</button>
      </div>
      <pre class="subtitle-preview-body">${escapeHtml(loading ? 'Loading preview...' : (previewLines || 'No preview text available.'))}</pre>
    </div>`;
}
function renderSubtitleSection(parentHit) {
  const subtitleHits = sortedSubtitleHits(parentHit);
  const subtitleCount = subtitleHits.length;
  if (!subtitleCount) return '';
  const collapsed = isSubtitleSectionCollapsed(parentHit);
  const selectedUrls = getSelectedSubtitleUrls(parentHit);
  const selectedHits = subtitleHits.filter(sub => selectedUrls.includes(sub.url));
  const selectedLabel = selectedHits.length ? selectedHits.map((sub) => subtitleChipLabel(sub)).join(', ') : 'None selected';
  const activeHits = subtitleHits.filter(sub => sub.subtitleActive);
  const activeLabel = activeHits.length ? activeHits.map(sub => subtitleChipLabel(sub)).join(', ') : '';
  const searchValue = escapeHtml(subtitleSectionSearchValue(parentHit));
  if (collapsed) {
    return `
      <div class="subtitle-box collapsed">
        <div class="subtitle-collapsed-head">
          <div>
            <div class="subtitle-label">Subtitles (${subtitleCount})</div>
            <div class="subtitle-summary">Selected: ${escapeHtml(selectedLabel)}${activeLabel ? ` • Active: ${escapeHtml(activeLabel)}` : ''}</div>
          </div>
          <button class="subtitle-collapse-btn" data-toggle-subtitle-section="${escapeHtml(parentHit.id)}">Show</button>
        </div>
      </div>`;
  }
  return `
    <div class="subtitle-box">
      <div class="subtitle-collapsed-head" style="margin-bottom:6px">
        <div>
          <div class="subtitle-label">Subtitles (${subtitleCount})</div>
          <div class="subtitle-summary">Pick one subtitle to upload as VTT. Preview before selecting.${activeLabel ? ` Active: ${escapeHtml(activeLabel)}` : ''}</div>
        </div>
        <button class="subtitle-collapse-btn" data-toggle-subtitle-section="${escapeHtml(parentHit.id)}">Collapse</button>
      </div>
      <div class="subtitle-search-row">
        <input class="subtitle-search-input" data-subtitle-search="${escapeHtml(parentHit.id)}" value="${searchValue}" placeholder="the and to of a" />
        <button class="subtitle-search-btn" data-scan-subtitles="${escapeHtml(parentHit.id)}">Scan</button>
      </div>
      <div class="subtitle-row">${subtitleHits.map((sub, index) => renderSubtitleChip(parentHit, sub, index, subtitleCount)).join('')}</div>
    </div>`;
}
function getSelectedUrl(hit) {
  const options = sortQualityOptions(hit.qualityOptions || hit.variants || []);
  if (!options.length) return hit.url || '';
  const saved = selectedVariantByHit.get(hit.id) || hit.selectedVariantUrl || '';
  const match = options.find(opt => opt.url === saved);
  return (match?.url || options[0].url || hit.url || '');
}
function getSelectedOption(hit) {
  const options = sortQualityOptions(hit.qualityOptions || hit.variants || []);
  if (!options.length) return null;
  const saved = selectedVariantByHit.get(hit.id) || hit.selectedVariantUrl || '';
  return options.find(opt => opt.url === saved) || options[0];
}
function selectedSubtitleUrlsForHit(hit) {
  const explicit = Array.isArray(hit?.selectedSubtitleUrls) ? hit.selectedSubtitleUrls.filter(Boolean) : [];
  if (explicit.length) return explicit;
  if (hit?.selectedSubtitleUrl) return [hit.selectedSubtitleUrl].filter(Boolean);
  return [];
}
function hasSubtitleSelection(hit) {
  const subtitleHits = Array.isArray(hit?.subtitleHits) ? hit.subtitleHits : [];
  return selectedSubtitleUrlsForHit(hit).length > 0 || subtitleHits.length > 0;
}
function hasMissingSegmentActions(hit) {
  const status = String(hit?.status || '').toLowerCase();
  if (status !== 'partial' && status !== 'failed' && status !== 'missing') return false;
  const missingCount = Number(hit?.missingSegmentCount || 0);
  const missingUrls = Array.isArray(hit?.missingSegmentUrls) ? hit.missingSegmentUrls.filter(Boolean) : [];
  return missingCount > 0 || missingUrls.length > 0;
}

window.getSelectedUrl = getSelectedUrl;
window.getSelectedOption = getSelectedOption;
window.getSelectedSubtitleUrls = getSelectedSubtitleUrls;
function renderQualityChips(hit) {
  const options = sortQualityOptions(hit.qualityOptions || hit.variants || []);
  if (!options.length) return '';
  const selectedUrl = getSelectedUrl(hit);
  return options.map((opt, index) => {
    const selected = opt.url === selectedUrl;
    const classes = ['quality-chip'];
    if (selected) classes.push('selected');
    if (index === 0) classes.push('default');
    return `<button class="${classes.join(' ')}" data-select-quality="${escapeHtml(hit.id)}" data-quality-url="${escapeHtml(opt.url)}" title="${escapeHtml(opt.url)}">${escapeHtml(opt.label)}</button>`;
  }).join('');
}
function copyIconSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H10V7h9v14z"/></svg>';
}
function clearIconSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5.2 5.2 6.4 10.8 12l-5.6 5.6 1.2 1.2 5.6-5.6 5.6 5.6 1.2-1.2-5.6-5.6 5.6-5.6-1.2-1.2-5.6 5.6-5.6-5.6z"/></svg>';
}
function fmtHit(hit) {
  const rawStatus = String(hit.status || 'new').toLowerCase();
  const status = getWorkingStageStatus(hit) || rawStatus;
  const statusBadgeClass = rawStatus === 'archived' ? 'ok' : (rawStatus === 'partial' ? 'warn' : (rawStatus === 'failed' ? 'warn' : ''));
  const selected = getSelectedOption(hit);
  const selectedUrl = selected?.url || hit.url || '';
  const mediaType = hit.kind === 'media'
    ? (String(hit.contentType || '').split(';')[0].trim() || (selectedUrl.toLowerCase().match(/\.(mp4|m4v|webm|mov|mkv|flv|aac|mp3|ogg|wav)$/)?.[1] || 'media'))
    : '';
  const qualityLabel = hit.kind === 'playlist' ? (selected?.label || hit.quality || '0p') : (mediaType || (hit.kind === 'subtitle' ? 'subtitle' : 'media'));
  const cardLabel = getCardLabel(hit, selectedUrl);
  const playlistMeta = hit.kind === 'playlist' ? [
    hit.segmentCount ? `${hit.segmentCount} segment${hit.segmentCount === 1 ? '' : 's'}` : '',
    hit.missingSegmentCount ? `${hit.missingSegmentCount} missing` : ''
  ].filter(Boolean).join(' • ') : '';
  const subtitleHits = Array.isArray(hit.subtitleHits) ? hit.subtitleHits : [];
  const selectedSubtitleUrls = selectedSubtitleUrlsForHit(hit);
  const subtitleCount = Math.max(subtitleHits.length, selectedSubtitleUrls.length);
  const fileCount = countArchivedMediaFiles(hit);
  const remuxRequested = hit.browserRemuxRequested ? (hit.browserRemuxSucceeded ? 'browser remuxed' : 'browser remuxing') : '';
  const details = [
    remuxRequested,
    fileCount ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : '',
    isActiveHit(hit) && hit.progressLabel ? hit.progressLabel : ''
  ].filter(Boolean).join(' • ');
  const progress = buildProgressLine(hit);
  const currentBarPct = progress.currentPct;
  const currentPctText = `${progress.currentPct.toFixed(progress.currentPct < 10 ? 1 : 0)}%`;
  const missingActions = hasMissingSegmentActions(hit);
  const actionLabel = status === 'downloading' ? 'Downloading…' : (status === 'remuxing' ? 'Remuxing…' : (status === 'archiving' ? 'Archiving…' : ((rawStatus === 'partial' || rawStatus === 'failed') ? (missingActions ? 'Retry missing' : 'Retry archive') : ((includeSubtitleUploadsForHit(hit) && hasSubtitleSelection(hit)) ? 'Archive + subtitles' : 'Archive'))));
  const activeActionDetail = isActiveHit(hit) ? (hit.progressLabel || progress.currentText || progress.segmentSummary || 'Working…') : '';
  const activeActionTitle = isActiveHit(hit) ? `${actionLabel}${activeActionDetail ? ` — ${activeActionDetail}` : ''}` : '';
  const actionButtonClass = ['btn', 'job-action'];
  if (isActiveHit(hit)) actionButtonClass.push('busy', `stage-${status || rawStatus}`);
  const archiveName = (hit.archiveName || hit.title || hit.quality || 'archive').replace(/\s+(?:playlist|adaptive playlist)$/i, '').trim() || 'archive';
  const optionsLine = hit.kind === 'playlist' ? renderQualityChips(hit) : '';
  const qualityCount = hit.kind === 'playlist' ? (hit.qualityOptions || hit.variants || []).length : 0;
  const copyTitle = selectedUrl || hit.url || '';
  const compactCard = compactViewEnabled && isActiveHit(hit);
  const subtitleLine = compactCard ? '' : renderSubtitleSection(hit);
  const qualityRow = compactCard ? '' : optionsLine;
  const segmentLabel = progress.segmentText || (hit.kind === 'playlist' && hit.segmentCount ? `${hit.segmentCount} segments` : '');
  const progressLabel = compactCard
    ? (hit.progressLabel || progress.currentText || segmentLabel || 'Working…')
    : (segmentLabel || '');
  const footerDetails = !compactCard && details ? `<div class="small" style="margin-top:6px">${escapeHtml(details)}${hit.error ? ' — ' + escapeHtml(hit.error) : ''}</div>` : '';
  const includeSubtitles = includeSubtitleUploadsForHit(hit);
  const archivedCard = rawStatus === 'archived';
  const subtitleToggle = isActiveHit(hit) && !archivedCard ? '' : `<label class="toggle" style="margin:0; align-self:center; font-size:12px; white-space:nowrap;"><input type="checkbox" data-include-subtitles="${escapeHtml(hit.id)}"${includeSubtitles ? ' checked' : ''}> Include subtitles</label>`;
  const showTargetLibrary = !isActiveHit(hit) && !archivedCard;
  const targetLibraryButton = showTargetLibrary ? `<button class="btn secondary target-btn" data-target-library="${escapeHtml(hit.id)}" title="Open library picker">Target Library</button>` : '';
  const hitActions = (compactCard || archivedCard) ? '' : (status === 'partial' || status === 'failed') ? (missingActions ? `<div class="hit-actions">
        <button class="btn" data-retry-missing="${escapeHtml(hit.id)}" data-output-name="${escapeHtml(archiveName)}">Retry missing</button>
        <button class="btn secondary" data-skip-missing="${escapeHtml(hit.id)}" data-output-name="${escapeHtml(archiveName)}">Skip missing</button>
      </div>` : `<div class="hit-actions">
        <button class="${actionButtonClass.join(' ')}" data-retry-archive="${escapeHtml(hit.id)}" data-output-name="${escapeHtml(archiveName)}"${activeActionTitle ? ` title="${escapeHtml(activeActionTitle)}"` : ''}>${isActiveHit(hit) ? `<span class="btn-kicker">${escapeHtml(actionLabel)}</span><span class="btn-detail">${escapeHtml(activeActionDetail)}</span>` : escapeHtml(actionLabel)}</button>
        ${targetLibraryButton}
      </div>`) : `<div class="hit-actions">
        ${subtitleToggle}
        <button class="${actionButtonClass.join(' ')}" data-archive="${escapeHtml(hit.id)}" data-output-name="${escapeHtml(archiveName)}"${activeActionTitle ? ` title="${escapeHtml(activeActionTitle)}"` : ''}>${isActiveHit(hit) ? `<span class="btn-kicker">${escapeHtml(actionLabel)}</span><span class="btn-detail">${escapeHtml(activeActionDetail)}</span>` : escapeHtml(actionLabel)}</button>
        ${targetLibraryButton}
      </div>`;
  const showClearButton = !archivedCard && (isActiveHit(hit) || rawStatus === 'cancelled' || hasMissingSegmentActions(hit));
  const clearButtonTitle = status === 'downloading' ? 'Cancel download' : (status === 'remuxing' ? 'Cancel remux' : (status === 'archiving' ? 'Cancel upload' : (rawStatus === 'cancelled' ? 'Remove cancelled card' : 'Clear this card')));
  const clearArchivedButton = showClearButton ? `<button class="icon-btn danger" data-clear-hit="${escapeHtml(hit.id)}" title="${clearButtonTitle}" aria-label="${clearButtonTitle}">${clearIconSvg()}</button>` : '';
  return `
    <div class="hit${compactCard ? ' compact-view' : ''}" title="${escapeHtml(copyTitle)}">
      <div class="hit-header">
        <div class="hit-top">
          <div class="hit-title"><span class="badge ${statusBadgeClass}">${escapeHtml(status)}</span><span class="badge dim">${escapeHtml(qualityLabel)}</span>${hasSubtitleSelection(hit) ? '<span class="badge dim" title="Selected subtitle will upload as VTT">VTT ✓</span>' : ''}${escapeHtml(cardLabel)}</div>
          <div class="hit-top-actions">${archivedCard ? '' : `
            ${clearArchivedButton}
            <button class="icon-btn" data-copy="${escapeHtml(hit.id)}" data-copy-url="${escapeHtml(selectedUrl)}" title="Copy URL" aria-label="Copy URL">${copyIconSvg()}</button>
          `}</div>
        </div>
        <div class="hit-subtitle">${escapeHtml(playlistMeta || details || '')}${qualityCount && hit.kind !== 'playlist' ? ` • ${qualityCount} option${qualityCount === 1 ? '' : 's'}` : ''}</div>
      </div>
      ${qualityRow ? `<div class="quality-row">${qualityRow}</div>` : ''}
      ${subtitleLine}
      ${!compactCard && (currentBarPct > 0 || (isActiveHit(hit) && Number(hit.currentSegmentTotal || 0) > 0)) ? `
      <div class="progress-meta"><span>${escapeHtml(progress.currentText || 'Segment progress')}</span><span>${escapeHtml(currentPctText)}</span></div>
      <div class="progress progress-mini" style="margin-top:6px"><div style="width:${currentBarPct}%"></div></div>
      ` : ''}
      <div class="progress" style="margin-top:8px"><div style="width:${progress.segmentPct}%"></div></div>
      <div class="progress-meta"><span>${escapeHtml(progressLabel)}</span><span>${escapeHtml(progress.segmentSummary || '0%')}</span></div>
      ${footerDetails}
      ${hitActions}
    </div>`;
}
async function loadState() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!res?.ok) throw new Error(res?.error || 'Could not load state');
  return res;
}
async function saveSettings(patch) {
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: patch });
}
async function refresh() {
  const state = await loadState();
  const { settings, config, hits } = state;
  currentSettings = settings || {};
  compactViewEnabled = loadCompactViewPreference();
  const visibleHits = groupedHits(hits).filter((hit) => {
    const kind = String(hit?.kind || '').toLowerCase();
    const ct = String(hit?.contentType || '').toLowerCase();
    const url = String(hit?.url || '').toLowerCase();
    const looksHtmlDownload = /^text\/html/i.test(ct);
    const looksTextish = /^(?:text\/(?:plain|html|markdown|csv)|application\/(?:json|xml))/i.test(ct)
      || /\.(?:html?|txt|md|json|xml|csv)(?:$|[?#])/i.test(url)
      || looksHtmlDownload;
    const looksGif = /^image\/gif/i.test(ct) || /\.gif(?:$|[?#])/i.test(url);
    if (kind === 'playlist' || kind === 'subtitle') return true;
    if ((kind === 'text' || kind === 'document') && !settings.captureTextDownloads) return false;
    if (!settings.captureTextDownloads && looksTextish) return false;
    if (settings.ignoreGifTxtDownloads !== false && (looksGif || /\.txt(?:$|[?#])/i.test(url))) return false;
    return true;
  });
  const mainCardHits = visibleHits.filter(hit => isMainCardKind(hit?.kind));
  const activeHits = dedupeMainCardsByFamily(mainCardHits.filter(isActiveHit), true);
  const activeFamilyKeys = new Set(activeHits.map(hit => mainCardFamilyKey(hit)).filter(Boolean));
  const detectedMainHits = dedupeMainCardsByFamily(visibleHits.filter((hit) => {
    if (!isMainCardKind(hit?.kind)) return false;
    const familyKey = mainCardFamilyKey(hit);
    return !familyKey || !activeFamilyKeys.has(familyKey);
  }));
  const detectedHits = [
    ...detectedMainHits,
    ...visibleHits.filter(hit => !isMainCardKind(hit?.kind))
  ];
  $('summary').textContent = `Ready on ${settings.archiveFolder || '/videodownloader/'} `;
  $('activeCountLabel').textContent = `${activeHits.length} job${activeHits.length === 1 ? '' : 's'}`;
  const detectedMainCount = detectedHits.filter(hit => isMainCardKind(hit?.kind)).length;
  $('countLabel').textContent = `${detectedMainCount} item${detectedMainCount === 1 ? '' : 's'}`;
  const qHit = mainCardHits.find(h => h.kind === 'playlist' && getSelectedOption(h)) || mainCardHits.find(h => h.kind === 'playlist' && h.playlistType === 'master') || mainCardHits[0];
  const qOpt = qHit ? getSelectedOption(qHit) : null;
  const qCount = qHit && qHit.kind === 'playlist' ? (qHit.qualityOptions || qHit.variants || []).length : 0;
  const aggregateProgress = buildAggregateProgress(mainCardHits);
  $('progressBar').style.width = `${aggregateProgress.pct}%`;
  $('progressPercent').textContent = aggregateProgress.total > 0 ? `${aggregateProgress.pct.toFixed(aggregateProgress.pct < 10 ? 1 : 0)}%` : '0%';
  $('progressLabel').textContent = aggregateProgress.label;
  $('compactToggle').checked = compactViewEnabled;
  document.body.classList.toggle('compact-view-mode', compactViewEnabled);
  $('activeHitList').innerHTML = activeHits.length ? activeHits.map(fmtHit).join('') : '<div class="small">No active jobs right now.</div>';
  $('hitList').innerHTML = detectedHits.length ? detectedHits.map(fmtHit).join('') : '<div class="small">No media or playlists detected yet.</div>';
  for (const btn of document.querySelectorAll('[data-select-quality]')) {
    btn.addEventListener('click', async () => {
      const hitId = btn.getAttribute('data-select-quality');
      const url = btn.getAttribute('data-quality-url') || '';
      if (!hitId || !url) return;
      selectedVariantByHit.set(hitId, url);
      await refresh();
    });
  }
  for (const btn of document.querySelectorAll('[data-toggle-subtitle]')) {
    btn.addEventListener('click', async () => {
      const parentId = btn.getAttribute('data-toggle-subtitle');
      const subUrl = btn.getAttribute('data-subtitle-url') || '';
      if (!parentId || !subUrl) return;
      const hit = visibleHits.find(h => h.id === parentId);
      if (!hit) return;
      toggleSubtitleSelection(hit, { url: subUrl });
      const current = selectedSubtitleByHit.get(subtitleSelectionKey(hit));
      if (current !== subUrl) selectedSubtitleByHit.set(subtitleSelectionKey(hit), subUrl);
      await refresh();
    });
  }
  for (const btn of document.querySelectorAll('[data-preview-subtitle]')) {
    btn.addEventListener('click', async () => {
      const parentId = btn.getAttribute('data-preview-subtitle');
      const subUrl = btn.getAttribute('data-subtitle-url') || '';
      if (!parentId || !subUrl) return;
      const hit = visibleHits.find(h => h.id === parentId);
      if (!hit) return;
      const subtitleHits = Array.isArray(hit.subtitleHits) ? hit.subtitleHits : [];
      const index = subtitleHits.findIndex(s => s.url === subUrl);
      const subHit = index >= 0 ? subtitleHits[index] : null;
      if (!subHit) return;
      setSubtitleSectionCollapsed(hit, false);
      toggleSubtitleSelection(hit, subHit);
      try {
        await loadSubtitlePreview(hit, subHit, Math.max(0, index), subtitleHits.length);
      } catch (err) {
        subtitlePreviewState = {
          parentKey: subtitleSelectionKey(hit),
          subtitleUrl: subUrl,
          loading: false,
          text: `Preview failed: ${err?.message || err}`,
          title: `Previewing ${subtitleOptionLabel(Math.max(0, index), subtitleHits.length, subHit)}`,
          meta: subtitlePreviewSummary(subHit),
          optionIndex: Math.max(0, index),
          optionTotal: subtitleHits.length
        };
        await refresh();
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-close-preview]')) {
    btn.addEventListener('click', () => closeSubtitlePreview());
  }
  for (const btn of document.querySelectorAll('[data-toggle-subtitle-section]')) {
    btn.addEventListener('click', async () => {
      const parentId = btn.getAttribute('data-toggle-subtitle-section');
      if (!parentId) return;
      const hit = visibleHits.find(h => h.id === parentId);
      if (!hit) return;
      const collapsed = isSubtitleSectionCollapsed(hit);
      setSubtitleSectionCollapsed(hit, !collapsed);
      if (collapsed && subtitlePreviewState.parentKey === subtitleSelectionKey(hit)) {
        closeSubtitlePreview();
      }
      await refresh();
    });
  }

  for (const input of document.querySelectorAll('[data-subtitle-search]')) {
    input.addEventListener('change', async () => {
      const parentId = input.getAttribute('data-subtitle-search');
      if (!parentId) return;
      const hit = visibleHits.find(h => h.id === parentId);
      if (!hit) return;
      subtitleSearchQueryByHit.set(subtitleSelectionKey(hit), String(input.value || '').trim() || 'the and to of a');
      await refresh();
    });
  }
  for (const btn of document.querySelectorAll('[data-scan-subtitles]')) {
    btn.addEventListener('click', async () => {
      const parentId = btn.getAttribute('data-scan-subtitles');
      if (!parentId) return;
      const hit = visibleHits.find(h => h.id === parentId);
      if (!hit) return;
      const searchInput = document.querySelector(`[data-subtitle-search="${parentId}"]`);
      subtitleSearchQueryByHit.set(subtitleSelectionKey(hit), String(searchInput?.value || '').trim() || 'the and to of a');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Scanning…';
      try {
        await scanSubtitleCandidates(hit);
      } finally {
        btn.disabled = false;
        btn.textContent = original || 'Scan';
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-retry-missing]')) {
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      const hit = visibleHits.find(h => h.id === btn.getAttribute('data-retry-missing'));
      if (!hit) return;
      const outputName = (btn.getAttribute('data-output-name') || hit.archiveName || hit.title || hit.quality || 'archive').replace(/\s+(?:playlist|adaptive playlist)$/i, '').trim() || 'archive';
      setSubtitleSectionCollapsed(hit, true);
      if (subtitlePreviewState.parentKey === subtitleSelectionKey(hit)) closeSubtitlePreview();
      btn.disabled = true;
      btn.textContent = 'Working…';
      let errorText = '';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'RETRY_MISSING_SEGMENTS',
          id: hit.id,
          outputName
        });
        if (!res?.ok) throw new Error(res?.error || 'Retry failed');
      } catch (err) {
        errorText = err?.message || String(err);
      }
      await refresh();
      btn.disabled = false;
      btn.textContent = original || 'Retry missing';
      btn.title = errorText || '';
    });
  }
  for (const btn of document.querySelectorAll('[data-skip-missing]')) {
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      const hit = visibleHits.find(h => h.id === btn.getAttribute('data-skip-missing'));
      if (!hit) return;
      const outputName = (btn.getAttribute('data-output-name') || hit.archiveName || hit.title || hit.quality || 'archive').replace(/\s+(?:playlist|adaptive playlist)$/i, '').trim() || 'archive';
      setSubtitleSectionCollapsed(hit, true);
      if (subtitlePreviewState.parentKey === subtitleSelectionKey(hit)) closeSubtitlePreview();
      btn.disabled = true;
      btn.textContent = 'Working…';
      let errorText = '';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'SKIP_MISSING_SEGMENTS',
          id: hit.id,
          outputName
        });
        if (!res?.ok) throw new Error(res?.error || 'Skip failed');
      } catch (err) {
        errorText = err?.message || String(err);
      }
      await refresh();
      btn.disabled = false;
      btn.textContent = original || 'Skip';
      btn.title = errorText || '';
    });
  }
  for (const input of document.querySelectorAll('[data-include-subtitles]')) {
    input.addEventListener('change', async () => {
      const hitId = input.getAttribute('data-include-subtitles');
      const hit = visibleHits.find(h => h.id === hitId);
      if (!hit) return;
      setIncludeSubtitleUploadsForHit(hit, input.checked);
    });
  }
  for (const btn of document.querySelectorAll('[data-retry-archive]')) {
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      const hit = visibleHits.find(h => h.id === btn.getAttribute('data-retry-archive'));
      if (!hit) return;
      const selected = getSelectedOption(hit);
      const outputName = (btn.getAttribute('data-output-name') || hit.archiveName || hit.title || hit.quality || 'archive').replace(/\s+(?:playlist|adaptive playlist)$/i, '').trim() || 'archive';
      const includeSubtitles = includeSubtitleUploadsForHit(hit);
      const subtitleUrls = includeSubtitles ? getSelectedSubtitleUrls(hit) : [];
      setSubtitleSectionCollapsed(hit, true);
      if (subtitlePreviewState.parentKey === subtitleSelectionKey(hit)) closeSubtitlePreview();
      btn.disabled = true;
      btn.textContent = 'Working…';
      let errorText = '';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'ARCHIVE_HIT',
          id: hit.id,
          outputName,
          variantUrl: selected?.url || '',
          subtitleUrls,
          subtitleBaseName: outputName
        });
        if (!res?.ok) throw new Error(res?.error || 'Archive failed');
        await chrome.runtime.sendMessage({ type: 'CLEAR_HITS' });
      } catch (err) {
        errorText = err?.message || String(err);
      }
      await refresh();
      btn.disabled = false;
      btn.textContent = original || 'Retry';
      btn.title = errorText || '';
    });
  }
  for (const btn of document.querySelectorAll('[data-archive]')) {
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      const hit = visibleHits.find(h => h.id === btn.getAttribute('data-archive'));
      if (!hit) return;
      const selected = getSelectedOption(hit);
      const suggested = (btn.getAttribute('data-output-name') || hit.title || hit.quality || 'archive').replace(/\s+(?:playlist|adaptive playlist)$/i, '').trim() || 'archive';
      const chosen = window.prompt('Archive file name', suggested);
      if (chosen === null) return;
      const outputName = chosen.trim();
      if (!outputName) return;
      const includeSubtitles = includeSubtitleUploadsForHit(hit);
      const subtitleUrls = includeSubtitles ? getSelectedSubtitleUrls(hit) : [];
      setSubtitleSectionCollapsed(hit, true);
      if (subtitlePreviewState.parentKey === subtitleSelectionKey(hit)) closeSubtitlePreview();
      btn.disabled = true;
      btn.textContent = 'Working…';
      let errorText = '';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'ARCHIVE_HIT',
          id: hit.id,
          outputName,
          variantUrl: selected?.url || '',
          subtitleUrls,
          subtitleBaseName: outputName
        });
        if (!res?.ok) throw new Error(res?.error || 'Archive failed');
        await chrome.runtime.sendMessage({ type: 'CLEAR_HITS' });
      } catch (err) {
        errorText = err?.message || String(err);
      }
      await refresh();
      btn.disabled = false;
      btn.textContent = original || 'Archive';
      btn.title = errorText || '';
    });
  }
  for (const btn of document.querySelectorAll('[data-target-library]')) {
    btn.addEventListener('click', async () => {
      const hitId = btn.getAttribute('data-target-library') || '';
      const hit = visibleHits.find(h => h.id === hitId);
      if (!hit) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Opening…';
      try {
        if (typeof window.openLibraryPicker === 'function') {
          await window.openLibraryPicker({
            ...hit,
            selectedSubtitleUrls: Array.isArray(hit.selectedSubtitleUrls) ? [...hit.selectedSubtitleUrls] : [],
            selectedSubtitleUrl: Array.isArray(hit.selectedSubtitleUrls) ? (hit.selectedSubtitleUrls[0] || hit.selectedSubtitleUrl || '') : (hit.selectedSubtitleUrl || ''),
            selectedVariantUrl: hit.selectedVariantUrl || hit.url || ''
          });
        }
      } finally {
        btn.disabled = false;
        btn.textContent = original || 'Target Library';
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-copy-url') || '';
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        const old = btn.getAttribute('aria-label') || btn.title || 'Copy URL';
        btn.title = 'Copied';
        setTimeout(() => { btn.title = old; }, 900);
      } catch {
        window.prompt('Copy URL', url);
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-clear-hit]')) {
    btn.addEventListener('click', async () => {
      const hitId = btn.getAttribute('data-clear-hit') || '';
      if (!hitId) return;
      btn.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type: 'CLEAR_HIT', id: hitId });
        await refresh();
      } finally {
        btn.disabled = false;
      }
    });
  }
}
$('refreshBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'REFRESH_CONFIG' });
  await refresh();
});
$('compactToggle').addEventListener('change', async () => {
  saveCompactViewPreference($('compactToggle').checked);
  document.body.classList.toggle('compact-view-mode', $('compactToggle').checked);
  await refresh();
});
$('reloadTabBtn')?.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id) return;
  await chrome.tabs.reload(tab.id);
});
$('clearBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_HITS' });
  await refresh();
});
$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
refresh().catch(err => {
  $('summary').textContent = `Error: ${err.message}`;
});
setInterval(() => refresh().catch(() => {}), 1500);