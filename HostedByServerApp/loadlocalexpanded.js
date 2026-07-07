// loadlocalexpanded.js
(function() {
  if (window.__loadlocalexpandedDone) return;
  window.__loadlocalexpandedDone = true;

  // ------------------------------------------------------------------------
  // Helper: extract folders array from mainfolders.js text
  // (identical to loadexpanded.js)
  // ------------------------------------------------------------------------
  function extractFoldersFromJs(text) {
    const arrMatch = /(?:const|let|var)?\s*folders\s*=\s*\[([\s\S]*?)\]/m.exec(text);
    if (!arrMatch) {
      console.warn('[loadlocalexpanded] Could not find folders array in remote mainfolders.js');
      return [];
    }
    let content = arrMatch[1];
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    content = content.replace(/(^|\n)\s*\/\/.*$/gm, '');
    const re = /(['"])(.*?)\1/g;
    const out = [];
    let m;
    while ((m = re.exec(content)) !== null) {
      let rawName = (m[2] || '').trim();
      if (!rawName) continue;
      const cleanName = rawName.replace(/\*/g, '').trim();
      out.push(cleanName);
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // Helper: recursively prepend baseUrl to relative paths
  // ------------------------------------------------------------------------
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
          const fullUrl = baseUrl + '/' + cleanPath;
          result[key] = fullUrl;
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

  // ------------------------------------------------------------------------
  // Helper: extract episodes from library.js text using new Function
  // ------------------------------------------------------------------------
  function extractEpisodesFromLibraryJs(text) {
    try {
      const fn = new Function(`"use strict"; ${text}; return episodes;`);
      const result = fn();
      if (result && typeof result === 'object') {
        return result;
      }
      return null;
    } catch (e) {
      console.warn('[loadlocalexpanded] Failed to extract episodes from library.js:', e);
      return null;
    }
  }

  // ------------------------------------------------------------------------
  // Mainfolders sorting logic (copied from loadexpanded)
  // ------------------------------------------------------------------------
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

  // ------------------------------------------------------------------------
  // Helper: attempt to fetch a resource from a base URL with timeout
  // Returns { ok: boolean, text: string } if success, else { ok: false }
  // ------------------------------------------------------------------------
  async function fetchWithTimeout(url, timeoutMs = 3000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(timeout);
      if (!res.ok) return { ok: false };
      const text = await res.text();
      return { ok: true, text };
    } catch (e) {
      clearTimeout(timeout);
      return { ok: false };
    }
  }

  // ------------------------------------------------------------------------
  // Parse an entry string like "192.168.254.12:60063[100.121.13.50:60063]"
  // Returns { primary: string, fallback: string | null }
  // ------------------------------------------------------------------------
  function parseServerEntry(entry) {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    // Check for optional fallback inside brackets
    const bracketMatch = trimmed.match(/^(.*?)\s*\[(.*?)\]\s*$/);
    if (bracketMatch) {
      const primary = bracketMatch[1].trim();
      const fallback = bracketMatch[2].trim();
      if (primary && fallback) {
        // Ensure both have protocol; if not, prepend http://
        const p = /^https?:\/\//.test(primary) ? primary : 'http://' + primary;
        const f = /^https?:\/\//.test(fallback) ? fallback : 'http://' + fallback;
        return { primary: p, fallback: f };
      }
    }
    // No fallback: just one address
    const addr = /^https?:\/\//.test(trimmed) ? trimmed : 'http://' + trimmed;
    return { primary: addr, fallback: null };
  }

  // ------------------------------------------------------------------------
  // Main execution
  // ------------------------------------------------------------------------
  (async function() {
    try {
      // 1. Read the list from localexpanded.txt
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

      // Split by commas and newlines, filter empty, trim
      const entries = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      if (entries.length === 0) {
        console.warn('[loadlocalexpanded] No valid entries in localexpanded.txt, skipping.');
        return;
      }

      // Parse entries into { primary, fallback }
      const serverList = entries.map(parseServerEntry).filter(Boolean);
      if (serverList.length === 0) {
        console.warn('[loadlocalexpanded] Could not parse any server entries.');
        return;
      }

      // 2. Try each server (primary, then fallback) until one responds
      let chosenBaseUrl = null;
      let mainfoldersText = null;

      for (const entry of serverList) {
        const candidates = [];
        if (entry.primary) candidates.push(entry.primary);
        if (entry.fallback) candidates.push(entry.fallback);

        for (const url of candidates) {
          console.log(`[loadlocalexpanded] Trying server: ${url}`);
          const result = await fetchWithTimeout(`${url}/mainfolders.js`, 3000);
          if (result.ok) {
            chosenBaseUrl = url;
            mainfoldersText = result.text;
            console.log(`[loadlocalexpanded] Successfully connected to ${url}`);
            break;
          } else {
            console.warn(`[loadlocalexpanded] Failed to reach ${url}`);
          }
        }
        if (chosenBaseUrl) break;
      }

      if (!chosenBaseUrl || !mainfoldersText) {
        console.warn('[loadlocalexpanded] No reachable server found; skipping merge.');
        return;
      }

      // 3. Merge mainfolders.js using the fetched text
      console.log('[loadlocalexpanded] Using remote server at', chosenBaseUrl);
      const remoteFolders = extractFoldersFromJs(mainfoldersText);
      console.log(`[loadlocalexpanded] Remote folders:`, remoteFolders);

      if (typeof folders === 'undefined' || !Array.isArray(folders)) {
        console.warn('[loadlocalexpanded] Global `folders` not found; creating it.');
        window.folders = [];
      }
      const localFolders = folders.slice();
      const merged = mergeMainFolderTitlesPreferAdult(localFolders, remoteFolders);
      console.log(`[loadlocalexpanded] Merged folders: local ${localFolders.length}, remote ${remoteFolders.length}, total ${merged.length}`);
      folders.length = 0;
      folders.push(...merged);

      // 4. Fetch and merge library.js from the chosen baseUrl
      console.log('[loadlocalexpanded] Fetching remote library.js...');
      const libRes = await fetch(`${chosenBaseUrl}/library.js`, { cache: 'no-store' });
      let remoteEpisodesCache = {};

      if (libRes.ok) {
        const libText = await libRes.text();
        const remoteEpisodes = extractEpisodesFromLibraryJs(libText);
        if (remoteEpisodes) {
          const transformed = prependBaseToPaths(remoteEpisodes, chosenBaseUrl);
          remoteEpisodesCache = JSON.parse(JSON.stringify(transformed));

          let targetEpisodes;
          try {
            targetEpisodes = eval('episodes');
          } catch (e) {
            targetEpisodes = window.episodes;
          }
          if (typeof targetEpisodes === 'object' && targetEpisodes !== null) {
            let added = 0;
            for (const key in transformed) {
              if (!(key in targetEpisodes)) {
                targetEpisodes[key] = transformed[key];
                added++;
              }
            }
            console.log(`[loadlocalexpanded] Added ${added} new episode entries to global episodes.`);
          } else {
            if (!window.episodes) window.episodes = {};
            let added = 0;
            for (const key in transformed) {
              if (!(key in window.episodes)) {
                window.episodes[key] = transformed[key];
                added++;
              }
            }
            console.log(`[loadlocalexpanded] Added ${added} new episode entries to window.episodes.`);
          }

          // Merge other globals (libraryData, books, manga, guidebooks)
          try {
            const sandbox = { window: {} };
            const fn = new Function('window', libText);
            fn(sandbox.window);
            const libGlobals = ['libraryData', 'books', 'manga', 'guidebooks'];
            for (const g of libGlobals) {
              if (sandbox.window[g] !== undefined) {
                const transformed2 = prependBaseToPaths(sandbox.window[g], chosenBaseUrl);
                if (!window[g] || !Array.isArray(window[g])) {
                  window[g] = transformed2;
                  console.log(`[loadlocalexpanded] Set ${g} from remote.`);
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
                    console.log(`[loadlocalexpanded] Merged ${g}: added ${added} remote items.`);
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[loadlocalexpanded] Failed to merge other globals from library.js:', e);
          }
        } else {
          console.warn('[loadlocalexpanded] Could not extract episodes from remote library.js.');
        }
      } else {
        console.warn('[loadlocalexpanded] Failed to fetch remote library.js, status:', libRes.status);
      }

      // 5. Merge remote loadseasonfunctions.js by injecting script
      console.log('[loadlocalexpanded] Fetching remote loadseasonfunctions.js...');
      const lsfRes = await fetch(`${chosenBaseUrl}/loadseasonfunctions.js`, { cache: 'no-store' });
      if (lsfRes.ok) {
        const lsfText = await lsfRes.text();
        const existingLoaders = new Set();
        for (const prop of Object.getOwnPropertyNames(window)) {
          if (prop.startsWith('load') && typeof window[prop] === 'function') {
            existingLoaders.add(prop);
          }
        }
        const script = document.createElement('script');
        script.textContent = lsfText;
        document.head.appendChild(script);

        let addedLoaders = 0;
        for (const prop of Object.getOwnPropertyNames(window)) {
          if (prop.startsWith('load') && typeof window[prop] === 'function' && !existingLoaders.has(prop)) {
            addedLoaders++;
          }
        }
        console.log(`[loadlocalexpanded] Added ${addedLoaders} new loader functions from remote loadseasonfunctions.js.`);
        script.remove();
      } else {
        console.warn('[loadlocalexpanded] Failed to fetch remote loadseasonfunctions.js, status:', lsfRes.status);
      }

      // 6. Extend global data structures for image and episode fallback
      if (!window.expandedImageOrigins) {
        window.expandedImageOrigins = [];
      }
      window.expandedImageOrigins.push(chosenBaseUrl);

      if (!window.__remoteEpisodes) {
        window.__remoteEpisodes = {};
      }
      for (const key in remoteEpisodesCache) {
        if (!(key in window.__remoteEpisodes)) {
          window.__remoteEpisodes[key] = remoteEpisodesCache[key];
        }
      }

      if (!window.__remoteFoldersSet) {
        window.__remoteFoldersSet = new Set();
      }
      for (const f of remoteFolders) {
        window.__remoteFoldersSet.add(f);
      }

      console.log('[loadlocalexpanded] Local expanded merge completed.');
    } catch (e) {
      console.error('[loadlocalexpanded] Merge failed:', e);
    }
  })();
})();