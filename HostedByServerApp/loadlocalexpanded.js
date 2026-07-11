// loadlocalexpanded.js – merges libraries, adds origins, and ensures image generation uses buildImageCandidates.
(function() {
  if (window.__loadlocalexpandedDone) return;
  window.__loadlocalexpandedDone = true;

  // Helper: extract folders array from mainfolders.js text
  // Now returns { names: string[], adultSet: Set<string> }
  function extractFoldersFromJs(text) {
    const arrMatch = /(?:const|let|var)?\s*folders\s*=\s*\[([\s\S]*?)\]/m.exec(text);
    if (!arrMatch) return { names: [], adultSet: new Set() };
    let content = arrMatch[1];
    content = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/.*$/gm, '');
    const re = /(['"])(.*?)\1/g;
    const names = [];
    const adultSet = new Set();
    let m;
    while ((m = re.exec(content)) !== null) {
      let rawName = (m[2] || '').trim();
      if (!rawName) continue;
      const hasStar = rawName.includes('*');
      const cleanName = rawName.replace(/\*/g, '').trim();
      names.push(cleanName);
      if (hasStar) adultSet.add(cleanName);
    }
    return { names, adultSet };
  }

  // Helper: prepend baseUrl to relative paths
  function prependBaseToPaths(obj, baseUrl) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => prependBaseToPaths(item, baseUrl));
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) {
          let cleanPath = value.replace(/^(\.\/|\.\.\/|\/)/, '');
          result[key] = baseUrl + '/' + cleanPath;
        } else if (value.startsWith('http://') || value.startsWith('https://')) {
          result[key] = value;
        } else {
          result[key] = value;
        }
      } else if (typeof value === 'object' && value !== null) {
        result[key] = prependBaseToPaths(value, baseUrl);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // Helper: extract episodes from library.js
  function extractEpisodesFromLibraryJs(text) {
    try {
      const fn = new Function(`"use strict"; ${text}; return episodes;`);
      const result = fn();
      if (result && typeof result === 'object') return result;
      return null;
    } catch (e) {
      console.warn('[loadlocalexpanded] Failed to extract episodes from library.js:', e);
      return null;
    }
  }

  // Mainfolders sorting logic (same as loadexpanded)
  const MAIN_FOLDER_PINNED_TOP = [
    "Continue Watching", "Games", "Music", "Books", "Manga",
    "Animated Movies", "Movies", "Favorites"
  ];
  const MAIN_FOLDER_PINNED_BOTTOM = [ "Beanstalk Videos" ];

  function normalizeLookupKey(value) {
    return String(value || '').replace(/\s+/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function collapseTrailingAdultMarks(value) {
    return String(value || '').replace(/\*+$/g, '').trim();
  }
  function compareMainFolderTitles(a, b) {
    const aTitle = String(a || '').trim();
    const bTitle = String(b || '').trim();
    const aTop = MAIN_FOLDER_PINNED_TOP.indexOf(aTitle);
    const bTop = MAIN_FOLDER_PINNED_TOP.indexOf(bTitle);
    if (aTop !== -1 || bTop !== -1) {
      if (aTop === -1) return 1;
      if (bTop === -1) return -1;
      if (aTop !== bTop) return aTop - bTop;
      return 0;
    }
    const aBottom = MAIN_FOLDER_PINNED_BOTTOM.indexOf(aTitle);
    const bBottom = MAIN_FOLDER_PINNED_BOTTOM.indexOf(bTitle);
    if (aBottom !== -1 || bBottom !== -1) {
      if (aBottom === -1) return -1;
      if (bBottom === -1) return 1;
      if (aBottom !== bBottom) return aBottom - bBottom;
      return 0;
    }
    const aNorm = aTitle.replace(/^The\s+/i, '');
    const bNorm = bTitle.replace(/^The\s+/i, '');
    const aKey = normalizeLookupKey(aNorm);
    const bKey = normalizeLookupKey(bNorm);
    if (aKey !== bKey) return aKey.localeCompare(bKey, undefined, { sensitivity: 'base' });
    return aTitle.localeCompare(bTitle, undefined, { sensitivity: 'base' });
  }

  function mergeMainFolderTitlesPreferAdult(currentTitles, incomingTitles) {
    const merged = new Map();
    function upsert(rawTitle) {
      const title = String(rawTitle || '').trim();
      if (!title) return;
      const base = collapseTrailingAdultMarks(title);
      const key = normalizeLookupKey(base || title);
      const hasStar = /\*$/.test(title);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { title: hasStar ? title : base, hasStar });
        return;
      }
      if (hasStar && !existing.hasStar) {
        merged.set(key, { title, hasStar: true });
      }
    }
    (Array.isArray(currentTitles) ? currentTitles : []).forEach(upsert);
    (Array.isArray(incomingTitles) ? incomingTitles : []).forEach(upsert);
    return Array.from(merged.values())
      .map(entry => entry.title)
      .sort(compareMainFolderTitles);
  }

  // Fetch with timeout
  async function fetchWithTimeout(url, timeoutMs = 3000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeout);
      if (!res.ok) return { ok: false };
      const text = await res.text();
      return { ok: true, text };
    } catch (e) {
      clearTimeout(timeout);
      return { ok: false };
    }
  }

  // Parse entry: "primary[fallback]" -> array of { baseUrl, isFallback }
  function parseServerEntry(entry) {
    const trimmed = entry.trim();
    if (!trimmed) return [];
    const bracketMatch = trimmed.match(/^(.*?)\s*\[(.*?)\]\s*$/);
    let primary, fallback;
    if (bracketMatch) {
      primary = bracketMatch[1].trim();
      fallback = bracketMatch[2].trim();
    } else {
      primary = trimmed;
      fallback = null;
    }
    const candidates = [];
    if (primary) {
      const p = /^https?:\/\//.test(primary) ? primary : 'http://' + primary;
      candidates.push({ baseUrl: p, isFallback: false });
    }
    if (fallback) {
      const f = /^https?:\/\//.test(fallback) ? fallback : 'http://' + fallback;
      candidates.push({ baseUrl: f, isFallback: true });
    }
    return candidates;
  }

  // Record folder origin (only if not already set)
  function addFolderOrigin(folder, baseUrl) {
    if (!window.folderOriginMap) window.folderOriginMap = {};
    if (!window.folderOriginMap[folder]) {
      window.folderOriginMap[folder] = baseUrl;
    }
  }

  // Merge a single server's data (episodes, folders, loaders)
  async function mergeServer(baseUrl) {
    console.log(`[loadlocalexpanded] Merging from ${baseUrl}`);

    const mfRes = await fetchWithTimeout(`${baseUrl}/mainfolders.js`, 1500);
    if (!mfRes.ok) {
      console.warn(`[loadlocalexpanded] Failed to fetch mainfolders.js from ${baseUrl}`);
      return false;
    }
    const parsed = extractFoldersFromJs(mfRes.text);
    const remoteFolders = parsed.names;
    const remoteAdultSet = parsed.adultSet;
    console.log(`[loadlocalexpanded] Remote folders from ${baseUrl}:`, remoteFolders);

    if (typeof folders !== 'undefined' && Array.isArray(folders)) {
      const localFolders = folders.slice();
      const merged = mergeMainFolderTitlesPreferAdult(localFolders, remoteFolders);
      console.log(`[loadlocalexpanded] Merged folders with ${baseUrl}: local ${localFolders.length}, remote ${remoteFolders.length}, total ${merged.length}`);
      folders.length = 0;
      folders.push(...merged);

      // ---- Apply Kids Mode filtering to the merged folders ----
      if (typeof window.isKidsModeActive === 'function' && window.isKidsModeActive()) {
        const allAdult = new Set(window.__adultFolderNames || []);
        for (const name of remoteAdultSet) allAdult.add(name);
        for (let i = folders.length - 1; i >= 0; i--) {
          if (allAdult.has(folders[i])) {
            folders.splice(i, 1);
          }
        }
        window.__adultFolderNames = Array.from(allAdult);
      }
    } else {
      console.warn('[loadlocalexpanded] Global `folders` not found; creating it.');
      window.folders = remoteFolders.slice();
    }

    // Record origin for each remote folder
    remoteFolders.forEach(f => addFolderOrigin(f, baseUrl));

    const libRes = await fetchWithTimeout(`${baseUrl}/library.js`, 1500);
    let remoteEpisodesCache = {};
    if (libRes.ok) {
      const remoteEpisodes = extractEpisodesFromLibraryJs(libRes.text);
      if (remoteEpisodes) {
        const transformed = prependBaseToPaths(remoteEpisodes, baseUrl);
        remoteEpisodesCache = transformed;

        // ---- Helper to filter season arrays for Kids Mode ----
        function normalizeSeasonsArray(arr) {
          if (!Array.isArray(arr)) return arr;
          const kidsMode = (typeof window.isKidsModeActive === 'function') ? window.isKidsModeActive() : false;
          if (!kidsMode) return arr;
          return arr.filter(item => typeof item === 'string' && !item.includes('*'));
        }

        // ---- Apply filtering to episodes ----
        const adultSet = new Set(window.__adultFolderNames || []);
        const filteredEpisodes = {};
        for (const key in transformed) {
          if (adultSet.has(key)) continue;
          const seasons = transformed[key];
          if (Array.isArray(seasons)) {
            const filtered = normalizeSeasonsArray(seasons);
            if (filtered.length > 0) {
              filteredEpisodes[key] = filtered;
            }
          } else {
            filteredEpisodes[key] = seasons;
          }
        }

        let targetEpisodes;
        try {
          targetEpisodes = eval('episodes');
        } catch (e) {
          targetEpisodes = window.episodes;
        }
        if (typeof targetEpisodes === 'object' && targetEpisodes !== null) {
          let added = 0;
          for (const key in filteredEpisodes) {
            if (!(key in targetEpisodes)) {
              targetEpisodes[key] = filteredEpisodes[key];
              addFolderOrigin(key, baseUrl);
              added++;
            }
          }
          console.log(`[loadlocalexpanded] Added ${added} new episode entries (filtered) from ${baseUrl}.`);
        } else {
          if (!window.episodes) window.episodes = {};
          let added = 0;
          for (const key in filteredEpisodes) {
            if (!(key in window.episodes)) {
              window.episodes[key] = filteredEpisodes[key];
              addFolderOrigin(key, baseUrl);
              added++;
            }
          }
          console.log(`[loadlocalexpanded] Added ${added} new episode entries (filtered) to window.episodes from ${baseUrl}.`);
        }

        // Merge other globals
        try {
          const sandbox = { window: {} };
          const fn = new Function('window', libRes.text);
          fn(sandbox.window);
          const libGlobals = ['libraryData', 'books', 'manga', 'guidebooks'];
          for (const g of libGlobals) {
            if (sandbox.window[g] !== undefined) {
              const transformed2 = prependBaseToPaths(sandbox.window[g], baseUrl);
              if (!window[g] || !Array.isArray(window[g])) {
                window[g] = transformed2;
                console.log(`[loadlocalexpanded] Set ${g} from ${baseUrl}.`);
              } else if (Array.isArray(window[g]) && Array.isArray(transformed2)) {
                let added = 0;
                for (const item of transformed2) {
                  let exists = false;
                  if (item && item.title) {
                    exists = window[g].some(local => local.title === item.title);
                  } else {
                    exists = window[g].includes(item);
                  }
                  if (!exists) {
                    window[g].push(item);
                    added++;
                  }
                }
                if (added > 0) {
                  console.log(`[loadlocalexpanded] Merged ${g}: added ${added} remote items from ${baseUrl}.`);
                }
              }
            }
          }
        } catch (e) {
          console.warn('[loadlocalexpanded] Failed to merge other globals from library.js:', e);
        }
      } else {
        console.warn(`[loadlocalexpanded] Could not extract episodes from ${baseUrl}/library.js`);
      }
    } else {
      console.warn(`[loadlocalexpanded] Failed to fetch library.js from ${baseUrl}`);
    }

    const lsfRes = await fetchWithTimeout(`${baseUrl}/loadseasonfunctions.js`, 1500);
    if (lsfRes.ok) {
      const existingLoaders = new Set();
      for (const prop of Object.getOwnPropertyNames(window)) {
        if (prop.startsWith('load') && typeof window[prop] === 'function') {
          existingLoaders.add(prop);
        }
      }
      const script = document.createElement('script');
      script.textContent = lsfRes.text;
      document.head.appendChild(script);

      let addedLoaders = 0;
      for (const prop of Object.getOwnPropertyNames(window)) {
        if (prop.startsWith('load') && typeof window[prop] === 'function' && !existingLoaders.has(prop)) {
          addedLoaders++;
        }
      }
      console.log(`[loadlocalexpanded] Added ${addedLoaders} new loader functions from ${baseUrl}/loadseasonfunctions.js.`);
      script.remove();
    } else {
      console.warn(`[loadlocalexpanded] Failed to fetch loadseasonfunctions.js from ${baseUrl}`);
    }

    // Cache remote episodes for fallback in loadEpisodes
    if (!window.__remoteEpisodes) window.__remoteEpisodes = {};
    for (const key in remoteEpisodesCache) {
      if (!(key in window.__remoteEpisodes)) {
        window.__remoteEpisodes[key] = remoteEpisodesCache[key];
      }
    }

    if (!window.__remoteFoldersSet) {
      window.__remoteFoldersSet = new Set();
    }

    window.folderImageOrigins ??= {};

    for (const f of remoteFolders) {
      window.__remoteFoldersSet.add(f);
      if (!(f in window.folderImageOrigins)) {
        window.folderImageOrigins[f] = baseUrl;
      }
    }

    console.log(`[loadlocalexpanded] Merge from ${baseUrl} completed.`);
    return true;
  }

  // ------------------------------------------------------------------------
  // Main execution – promise so window.onload can wait
  // ------------------------------------------------------------------------
  window.__loadlocalexpandedPromise = (async function() {
    try {
      console.log('[loadlocalexpanded] Looking for localexpanded.txt...');
      const portRes = await fetch('./localexpanded.txt', { cache: 'no-store' });
      if (!portRes.ok) {
        console.warn('[loadlocalexpanded] localexpanded.txt not found, skipping.');
        return;
      }
      const raw = await portRes.text();
      if (!raw.trim()) {
        console.warn('[loadlocalexpanded] localexpanded.txt is empty, skipping.');
        return;
      }

      const entries = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      if (entries.length === 0) {
        console.warn('[loadlocalexpanded] No valid entries in localexpanded.txt, skipping.');
        return;
      }

      const candidateList = [];
      for (const entry of entries) {
        const parsed = parseServerEntry(entry);
        for (const cand of parsed) {
          candidateList.push({ baseUrl: cand.baseUrl, isFallback: cand.isFallback, entry });
        }
      }

      if (candidateList.length === 0) {
        console.warn('[loadlocalexpanded] No candidates parsed, skipping.');
        return;
      }

      // Register every candidate origin in expandedImageOrigins (legacy)
      if (!window.expandedImageOrigins) {
        window.expandedImageOrigins = [];
      }
      for (const cand of candidateList) {
        if (!window.expandedImageOrigins.includes(cand.baseUrl)) {
          window.expandedImageOrigins.push(cand.baseUrl);
          console.log(`[loadlocalexpanded] ✅ Added origin to expandedImageOrigins: ${cand.baseUrl}`);
        }
      }

      // Concurrently fetch mainfolders.js from all candidates
      const fetchPromises = candidateList.map(async (cand) => {
        const result = await fetchWithTimeout(`${cand.baseUrl}/mainfolders.js`, 1200);
        return { ...cand, result };
      });

      const settled = await Promise.allSettled(fetchPromises);
      const successful = settled
        .filter(s => s.status === 'fulfilled' && s.value.result.ok)
        .map(s => s.value);

      if (successful.length === 0) {
        console.warn('[loadlocalexpanded] No reachable server found; skipping merge but origins are already registered.');
        return;
      }

      console.log(`[loadlocalexpanded] Found ${successful.length} reachable server(s).`);

      // Merge each reachable server (deduplicate by baseUrl)
      const processed = new Set();
      for (const cand of successful) {
        if (processed.has(cand.baseUrl)) continue;
        processed.add(cand.baseUrl);
        await mergeServer(cand.baseUrl);
      }

      // --------------------------------------------------------------------
      // Fallback: if loadexpanded.js failed to set the image override,
      //    we do it here – but ONLY if it hasn't been set already.
      // --------------------------------------------------------------------
      const isOverridePresent = (
        typeof window.getImageCandidatesForFolder === 'function' &&
        window.getImageCandidatesForFolder.toString().indexOf('buildImageCandidates') !== -1
      );

      if (!isOverridePresent && typeof window.buildImageCandidates === 'function') {
        window.getImageCandidatesForFolder = function(folder) {
          let eps;
          try { eps = eval('episodes'); } catch(e) { eps = window.episodes || {}; }
          return window.buildImageCandidates(folder, null, eps);
        };
        console.log('[loadlocalexpanded] 🔧 getImageCandidatesForFolder fallback applied (loadexpanded may have failed).');
      } else if (isOverridePresent) {
        console.log('[loadlocalexpanded] ✅ getImageCandidatesForFolder already uses buildImageCandidates.');
      } else {
        console.warn('[loadlocalexpanded] buildImageCandidates not available; image fallback may be limited.');
      }

      console.log('[loadlocalexpanded] All merges completed.');
    } catch (e) {
      console.error('[loadlocalexpanded] Merge failed:', e);
    }
  })();
})();