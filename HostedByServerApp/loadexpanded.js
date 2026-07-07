// loadexpanded.js – data merge + search override with correct focus behavior
(function() {
  window.__loadexpandedPromise = new Promise(async (resolve) => {
    try {
      // 1. Read the port from expandedstorage.txt
      const portRes = await fetch('./expandedstorage.txt', { cache: 'no-store' });
      if (!portRes.ok) {
        console.warn('[loadexpanded] expandedstorage.txt not found, skipping merge.');
        resolve();
        return;
      }
      const port = (await portRes.text()).trim();
      if (!port) {
        console.warn('[loadexpanded] expandedstorage.txt is empty, skipping merge.');
        resolve();
        return;
      }
      const baseUrl = `${window.location.protocol}//${window.location.hostname}:${port}`;
      console.log(`[loadexpanded] Using remote server at ${baseUrl}`);

      // ---- Helper to record folder origin (only if not already set) ----
      function addFolderOrigin(folder) {
        if (!window.folderOriginMap) window.folderOriginMap = {};
        if (!window.folderOriginMap[folder]) {
          window.folderOriginMap[folder] = baseUrl;
        }
      }

      // ------------------------------------------------------------
      // Helper: extract folders array from mainfolders.js text
      // ------------------------------------------------------------
      function extractFoldersFromJs(text) {
        const arrMatch = /(?:const|let|var)?\s*folders\s*=\s*\[([\s\S]*?)\]/m.exec(text);
        if (!arrMatch) {
          console.warn('[loadexpanded] Could not find folders array in remote mainfolders.js');
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

      // ------------------------------------------------------------
      // Helper: recursively prepend baseUrl to any string that looks like a relative path
      // ------------------------------------------------------------
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

      // ------------------------------------------------------------
      // Helper: extract episodes object from library.js text using new Function
      // ------------------------------------------------------------
      function extractEpisodesFromLibraryJs(text) {
        try {
          const fn = new Function(`"use strict"; ${text}; return episodes;`);
          const result = fn();
          if (result && typeof result === 'object') {
            return result;
          }
          return null;
        } catch (e) {
          console.warn('[loadexpanded] Failed to extract episodes from library.js:', e);
          return null;
        }
      }

      // ------------------------------------------------------------
      // Mainfolders sorting logic (from lib.html)
      // ------------------------------------------------------------
      const MAIN_FOLDER_PINNED_TOP = [
        "Continue Watching",
        "Games",
        "Music",
        "Books",
        "Manga",
        "Animated Movies",
        "Movies",
        "Favorites"
      ];

      const MAIN_FOLDER_PINNED_BOTTOM = [
        "Beanstalk Videos"
      ];

      function normalizeLookupKey(value) {
        return String(value || '')
          .replace(/\s+/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
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

      // ------------------------------------------------------------
      // 2. Merge mainfolders.js using lib.html logic
      // ------------------------------------------------------------
      console.log('[loadexpanded] Fetching remote mainfolders.js...');
      const mfRes = await fetch(`${baseUrl}/mainfolders.js`, { cache: 'no-store' });
      let remoteFolders = [];
      if (mfRes.ok) {
        const mfText = await mfRes.text();
        remoteFolders = extractFoldersFromJs(mfText);
        console.log(`[loadexpanded] Remote folders (${port}):`, remoteFolders);

        if (typeof folders === 'undefined' || !Array.isArray(folders)) {
          console.warn('[loadexpanded] Global `folders` not found; creating it.');
          window.folders = [];
        }

        const localFolders = folders.slice();
        const merged = mergeMainFolderTitlesPreferAdult(localFolders, remoteFolders);
        console.log(`[loadexpanded] Merged folders: local ${localFolders.length}, remote ${remoteFolders.length}, added ${merged.length - localFolders.length}, total ${merged.length}`);

        folders.length = 0;
        folders.push(...merged);

        // Record origin for each remote folder
        remoteFolders.forEach(f => addFolderOrigin(f));
      } else {
        console.warn('[loadexpanded] Failed to fetch remote mainfolders.js, status:', mfRes.status);
      }

      // ------------------------------------------------------------
      // 3. Merge remote library.js (episodes, libraryData, books, etc.)
      // ------------------------------------------------------------
      console.log('[loadexpanded] Fetching remote library.js...');
      const libRes = await fetch(`${baseUrl}/library.js`, { cache: 'no-store' });
      let remoteEpisodesCache = {};

      if (libRes.ok) {
        const libText = await libRes.text();
        const remoteEpisodes = extractEpisodesFromLibraryJs(libText);
        if (remoteEpisodes) {
          const transformed = prependBaseToPaths(remoteEpisodes, baseUrl);
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
                // Record origin for this episode key (folder)
                addFolderOrigin(key);
                added++;
              }
            }
            console.log(`[loadexpanded] Added ${added} new episode entries to global episodes (paths transformed).`);
            if (added > 0) {
              console.log(`[loadexpanded] New episodes: ${Object.keys(transformed).join(', ')}`);
            }
          } else {
            if (!window.episodes) window.episodes = {};
            let added = 0;
            for (const key in transformed) {
              if (!(key in window.episodes)) {
                window.episodes[key] = transformed[key];
                addFolderOrigin(key);
                added++;
              }
            }
            console.log(`[loadexpanded] Added ${added} new episode entries to window.episodes (paths transformed).`);
          }

          // Merge other globals (libraryData, books, manga, guidebooks)
          try {
            const sandbox = { window: {} };
            const fn = new Function('window', libText);
            fn(sandbox.window);
            const libGlobals = ['libraryData', 'books', 'manga', 'guidebooks'];
            for (const g of libGlobals) {
              if (sandbox.window[g] !== undefined) {
                const transformed2 = prependBaseToPaths(sandbox.window[g], baseUrl);
                if (!window[g] || !Array.isArray(window[g])) {
                  window[g] = transformed2;
                  console.log(`[loadexpanded] Set ${g} from remote.`);
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
                    console.log(`[loadexpanded] Merged ${g}: added ${added} remote items.`);
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[loadexpanded] Failed to merge other globals from library.js:', e);
          }
        } else {
          console.warn('[loadexpanded] Could not extract episodes from remote library.js.');
        }
      } else {
        console.warn('[loadexpanded] Failed to fetch remote library.js, status:', libRes.status);
      }

      // ------------------------------------------------------------
      // 4. Merge remote loadseasonfunctions.js using a script tag
      // ------------------------------------------------------------
      console.log('[loadexpanded] Fetching remote loadseasonfunctions.js...');
      const lsfRes = await fetch(`${baseUrl}/loadseasonfunctions.js`, { cache: 'no-store' });
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
        console.log(`[loadexpanded] Added ${addedLoaders} new loader functions from remote loadseasonfunctions.js.`);
        script.remove();
      } else {
        console.warn('[loadexpanded] Failed to fetch remote loadseasonfunctions.js, status:', lsfRes.status);
      }

      // ------------------------------------------------------------
      // 5. Store remote cache for fallback (used by loadEpisodes)
      // ------------------------------------------------------------
      window.__remoteEpisodes = remoteEpisodesCache;
      window.__remoteFoldersSet = new Set(remoteFolders);
      window.__remoteBaseUrl = baseUrl; // kept for legacy/debug

      // ------------------------------------------------------------
      // 6. Push this server’s origin into expandedImageOrigins (legacy)
      // ------------------------------------------------------------
      if (!window.expandedImageOrigins) {
        window.expandedImageOrigins = [];
      }
      window.expandedImageOrigins.push(baseUrl);
      console.log('[loadexpanded] Added baseUrl to expandedImageOrigins:', baseUrl);

      // ------------------------------------------------------------
      // 7. Override getImageCandidatesForFolder to use buildImageCandidates
      //    (which now uses folderOriginMap)
      // ------------------------------------------------------------
      if (typeof window.buildImageCandidates === 'function') {
        window.getImageCandidatesForFolder = function(folder) {
          let eps;
          try { eps = eval('episodes'); } catch(e) { eps = window.episodes || {}; }
          return window.buildImageCandidates(folder, null, eps);
        };
        console.log('[loadexpanded] getImageCandidatesForFolder now uses buildImageCandidates.');
      } else {
        console.warn('[loadexpanded] buildImageCandidates not available; image fallback may be limited.');
      }

      // ------------------------------------------------------------
      // 8. Patch loadEpisodes to log and ensure episode data is used
      // ------------------------------------------------------------
      const originalLoadEpisodes = window.loadEpisodes;
      if (typeof originalLoadEpisodes === 'function') {
        window.loadEpisodes = async function(folderName) {
          const cleanFolder = collapseTrailingAdultMarks(folderName);
          let targetEpisodes;
          try {
            targetEpisodes = eval('episodes');
          } catch (e) {
            targetEpisodes = window.episodes;
          }
          if (targetEpisodes && typeof targetEpisodes === 'object') {
            if (!(cleanFolder in targetEpisodes) || (Array.isArray(targetEpisodes[cleanFolder]) && targetEpisodes[cleanFolder].length === 0)) {
              const remoteEntry = window.__remoteEpisodes && window.__remoteEpisodes[cleanFolder];
              if (remoteEntry && Array.isArray(remoteEntry) && remoteEntry.length > 0) {
                console.log(`[loadexpanded] Populating episodes["${cleanFolder}"] from remote cache (${remoteEntry.length} items)`);
                targetEpisodes[cleanFolder] = remoteEntry;
                // Also record origin for this folder if not set
                addFolderOrigin(cleanFolder);
              }
            }
          }

          const entry = targetEpisodes ? targetEpisodes[cleanFolder] : null;
          if (entry && Array.isArray(entry)) {
            console.log(`[loadexpanded] Calling loadEpisodes for "${cleanFolder}" with ${entry.length} episodes.`);
          } else {
            console.warn(`[loadexpanded] No episodes found for "${cleanFolder}" before calling loadEpisodes.`);
          }

          return originalLoadEpisodes.call(this, cleanFolder);
        };
        console.log('[loadexpanded] Patched loadEpisodes with logging and remote fallback.');
      } else {
        console.warn('[loadexpanded] loadEpisodes not found, cannot patch.');
      }

      // ------------------------------------------------------------
      // 9. Patch openFolderByName to strip adult markers
      // ------------------------------------------------------------
      if (typeof window.openFolderByName === 'function') {
        const originalOpenFolder = window.openFolderByName;
        window.openFolderByName = function(folder) {
          const cleanFolder = collapseTrailingAdultMarks(folder);
          console.log(`[loadexpanded] openFolderByName: "${folder}" -> "${cleanFolder}"`);
          return originalOpenFolder.call(this, cleanFolder);
        };
        console.log('[loadexpanded] Patched openFolderByName to strip adult markers.');
      } else {
        console.warn('[loadexpanded] openFolderByName not found, cannot patch.');
      }

      // ------------------------------------------------------------
      // 10. Override search (filterTiles) to use merged data
      // ------------------------------------------------------------
      console.log('[loadexpanded] Overriding search (filterTiles) to use merged data...');

      function debounce(fn, wait) {
        let timer;
        return function(...args) {
          clearTimeout(timer);
          timer = setTimeout(() => fn.apply(this, args), wait);
        };
      }

      const DEEP_ALL_TOKEN = '---';

      function normKey(s) {
        return String(s || '')
          .replace(/&amp;/gi, 'and')
          .replace(/&/g, 'and')
          .replace(/[’']/g, '')
          .replace(/[^a-z0-9]/gi, '')
          .toLowerCase();
      }

      // Build merged index from folders and episodes (both local and remote)
      function buildMergedIndex() {
        const merged = [];
        const seen = new Set();

        if (typeof folders !== 'undefined' && Array.isArray(folders)) {
          for (const f of folders) {
            const clean = collapseTrailingAdultMarks(f);
            const key = normKey(clean);
            if (!seen.has(key)) {
              seen.add(key);
              merged.push({ title: clean, parent: null, source: 'folder' });
            }
          }
        }

        let episodesObj = null;
        try {
          episodesObj = eval('episodes');
        } catch (e) {
          episodesObj = window.episodes;
        }
        if (episodesObj && typeof episodesObj === 'object') {
          for (const key in episodesObj) {
            const clean = collapseTrailingAdultMarks(key);
            const keyNorm = normKey(clean);
            if (!seen.has(keyNorm)) {
              seen.add(keyNorm);
              merged.push({ title: clean, parent: null, source: 'episode' });
            }
            const value = episodesObj[key];
            if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
              for (const sub of value) {
                const subClean = collapseTrailingAdultMarks(sub);
                const subKey = normKey(subClean);
                if (!seen.has(subKey)) {
                  seen.add(subKey);
                  merged.push({ title: subClean, parent: clean, source: 'season' });
                }
              }
            }
          }
        }

        return merged;
      }

      function buildLibraryIndex() {
        const items = [];
        if (window.libraryData && Array.isArray(window.libraryData.items)) {
          for (const item of window.libraryData.items) {
            if (item && item.title) {
              items.push({ title: item.title, parent: 'library', source: 'library', cover: item.cover, lib: 'library' });
            }
          }
        }
        const libGlobals = { books: 'Books', manga: 'Manga', guidebooks: 'Guidebooks' };
        for (const [globalKey, category] of Object.entries(libGlobals)) {
          if (Array.isArray(window[globalKey])) {
            for (const item of window[globalKey]) {
              if (item && item.title) {
                items.push({ title: item.title, parent: category, source: 'library', cover: item.cover, lib: globalKey });
              }
            }
          }
        }
        return items;
      }

      // --- Exact copy of the original attachTileFavorite from index.html (inside the search IIFE) ---
      function attachTileFavorite(tile, folderName) {
        if (!tile || !folderName) return;

        const starBtn = document.createElement('button');
        starBtn.className = 'tile-fav-star';
        starBtn.type = 'button';
        starBtn.title = 'Favorite';
        starBtn.tabIndex = 0;
        starBtn.setAttribute('aria-label', `Toggle favorite for ${folderName}`);

        const glyph = document.createElement('span');
        glyph.className = 'tile-fav-glyph';
        glyph.textContent = '☆';
        starBtn.appendChild(glyph);

        function refreshStarVisual() {
          const favs = (typeof getStoredFavorites === 'function') ? getStoredFavorites() : [];
          const isFav = Array.isArray(favs) && favs.includes(folderName);

          if (isFav) {
            starBtn.classList.add('favorited');
            glyph.textContent = '★';
          } else {
            starBtn.classList.remove('favorited');
            glyph.textContent = '☆';
          }
        }

        starBtn.addEventListener('click', function (e) {
          e.stopPropagation(); // IMPORTANT: prevents tile open
          toggleFavoriteByName(folderName);
          refreshStarVisual();
        });

        starBtn.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
            e.preventDefault();
            e.stopPropagation();
            starBtn.click();
            return;
          }
          e.stopPropagation();
        });

        // Optional: keyboard shortcut when tile focused (press F)
        tile.addEventListener('keydown', function (e) {
          if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            e.stopPropagation();
            toggleFavoriteByName(folderName);
            refreshStarVisual();
          }
        });

        tile.style.position = tile.style.position || 'relative';
        tile.appendChild(starBtn);
        refreshStarVisual();
      }

      // ---- The new filterTiles (overrides the original) ----
      const newFilterTiles = debounce(async function() {
        // Inject the required CSS for the Send-to-TV button (once)
        if (!document.getElementById('sendtotv-inline-style')) {
          const style = document.createElement('style');
          style.id = 'sendtotv-inline-style';
          style.textContent = `
            .send-to-tv-btn {
              position: absolute;
              top: 6px;
              right: 8px;
              width: 36px;
              height: 36px;
              padding: 0;
              margin: 0;
              border: none;
              background: transparent;
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 9999;
              cursor: pointer;
              border-radius: 0;
            }
            .send-to-tv-btn img {
              width: 28px;
              height: 28px;
              display: block;
              pointer-events: none;
            }
            .send-to-tv-btn:focus {
              outline: 2px solid rgba(255,255,255,0.9);
            }
          `;
          document.head.appendChild(style);
        }

        if (window._searchNavigateInProgress) {
          return;
        }

        const input = document.getElementById('searchInput');
        if (!input) return;
        const raw = input.value.trim();
        const q = normKey(raw);
        const container = document.getElementById('folderContainer');
        if (!container) return;

        // Clear container so we don't get stale results
        container.innerHTML = '';

        if (!raw) {
          if (typeof loadMainFolders === 'function') {
            loadMainFolders();
          }
          return;
        }

        const deepAll = raw === DEEP_ALL_TOKEN;

        const mergedIndex = buildMergedIndex();
        const libraryIndex = buildLibraryIndex();

        let mainMatches = [];
        if (deepAll) {
          mainMatches = mergedIndex;
        } else if (q.length >= 2) {
          mainMatches = mergedIndex.filter(item => normKey(item.title).includes(q));
        } else if (q.length === 1) {
          const exact = mergedIndex.find(item => normKey(item.title) === q);
          mainMatches = exact ? [exact] : [];
        }

        let libraryMatches = [];
        if (q.length >= 2) {
          libraryMatches = libraryIndex.filter(item => normKey(item.title).includes(q));
        }

        if (mainMatches.length === 0 && libraryMatches.length === 0) {
          const no = document.createElement('div');
          no.style.color = '#fff';
          no.style.textAlign = 'center';
          no.style.padding = '30px';
          no.innerText = `No matches for "${raw}"`;
          container.appendChild(no);
          return;
        }

        const parentMap = new Map();
        for (const item of mergedIndex) {
          if (item.parent) {
            const parentKey = item.parent;
            if (!parentMap.has(parentKey)) parentMap.set(parentKey, []);
            parentMap.get(parentKey).push(item.title);
          }
        }

        const grid = document.createElement('div');
        grid.style.display = 'flex';
        grid.style.flexWrap = 'wrap';
        grid.style.gap = '12px';
        grid.style.justifyContent = 'center';

        const episodesObj = (typeof episodes !== 'undefined') ? episodes : window.episodes;

        for (const item of mainMatches) {
          const div = document.createElement('div');
          div.className = 'folder';
          div.style.width = '150px';
          div.style.position = 'relative';
          div.style.overflow = 'visible';

          // Use buildImageCandidates (which now uses folderOriginMap)
          const candidates = window.buildImageCandidates(item.title, item.parent, episodesObj);

          let idx = 0;
          const img = document.createElement('img');
          img.alt = item.title;
          img.style.width = '150px';
          img.style.height = '210px';
          img.style.objectFit = 'cover';
          img.style.borderRadius = '10px';
          img.src = candidates[0] || './Images/placeholder.jpg';
          img.onerror = function() {
            idx++;
            if (idx < candidates.length) {
              this.src = candidates[idx];
            } else {
              this.onerror = null;
            }
          };

          const titleP = document.createElement('p');
          titleP.style.fontSize = '16px';
          titleP.style.fontWeight = 'bold';
          titleP.style.color = '#fff';
          titleP.style.margin = '10px 0 0';
          titleP.innerText = item.title;

          div.appendChild(img);
          div.appendChild(titleP);

          if (item.parent) {
            const parentP = document.createElement('p');
            parentP.style.fontSize = '11px';
            parentP.style.margin = '2px 0 0';
            parentP.style.color = '#aaa';
            parentP.innerText = item.parent;
            div.appendChild(parentP);
          }

          const suppressFavoriteStar = (typeof window.isRootFavoriteSuppressedTile === 'function')
            ? window.isRootFavoriteSuppressedTile(item.title)
            : false;

          let isFavoriteable = false;
          if (!suppressFavoriteStar) {
            if (episodesObj && episodesObj[item.title] && Array.isArray(episodesObj[item.title])) {
              isFavoriteable = true;
            } else if (window._specialFolderHandlers && typeof window._specialFolderHandlers[item.title] === 'function') {
              isFavoriteable = true;
            } else {
              const base = (typeof toLoaderSafeBase === 'function')
                ? toLoaderSafeBase(item.title)
                : item.title.replace(/[^a-zA-Z0-9]+/g,' ').split(/\s+/).filter(Boolean).map(s => s.charAt(0).toUpperCase()+s.slice(1)).join('');
              const candidates = [
                `load${base}Seasons`,
                `load${base}Season`,
                `load${base}`,
                `load${base}CollectionSeasons`,
                `load${base}Movies`,
                `load${base}Films`
              ];
              for (const n of candidates) {
                if (typeof window[n] === 'function') { isFavoriteable = true; break; }
              }
            }
          }

          if (isFavoriteable && !suppressFavoriteStar) {
            attachTileFavorite(div, item.title);
          }

          const isRootWithSeasons = (window._rootNonFavoriteTileSet && window._rootNonFavoriteTileSet.has(item.title));
          const hasChildren = parentMap.has(item.title) && parentMap.get(item.title).length > 0;
          const isSpecialHandlerTile = !!(window._specialFolderHandlers && typeof window._specialFolderHandlers[item.title] === 'function');
          const isMasterTile = (typeof window.isMasterTile === 'function') ? window.isMasterTile(item.title) : false;

          const showSendBtn = !isRootWithSeasons && !hasChildren && !isSpecialHandlerTile && !isMasterTile;

          if (!showSendBtn) {
            // Only make the tile itself focusable when it does NOT have a Send button
            div.tabIndex = 0;
            div.setAttribute('role', 'button');
            div.setAttribute('aria-label', `Open ${item.title}`);
            div.addEventListener('keydown', function(ev) {
              // If the target is a child interactive element (Send button, star, etc.), let it handle the event.
              if (ev.target.closest && ev.target.closest('.send-to-tv-btn, .tile-fav-star, button, a, input, textarea, select, [role="switch"]')) {
                return;
              }
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                div.click();
              }
            });
          }

          if (showSendBtn) {
            const sendBtn = document.createElement('button');
            sendBtn.type = 'button';
            sendBtn.className = 'send-to-tv-btn';
            sendBtn.setAttribute('aria-label', `Send ${item.title} to TV`);
            sendBtn.setAttribute('title', `Send ${item.title} to TV`);
            sendBtn.tabIndex = 0;

            const sendImg = document.createElement('img');
            sendImg.alt = 'Send to TV';
            sendImg.style.width = '28px';
            sendImg.style.height = '28px';
            sendImg.style.pointerEvents = 'none';
            const iconCandidates = ['./Images/sendtotv.png', 'Images/sendtotv.png', '/Images/sendtotv.png'];
            let tryIdx = 0;
            sendImg.src = iconCandidates[tryIdx];
            sendImg.onerror = function() {
              tryIdx++;
              if (tryIdx < iconCandidates.length) {
                this.src = iconCandidates[tryIdx];
              } else {
                this.style.display = 'none';
              }
            };
            sendBtn.appendChild(sendImg);

            sendBtn.addEventListener('click', async function(ev) {
              ev.stopPropagation();
              try {
                const ok = (window.SysNotify && window.SysNotify.confirm) ? await window.SysNotify.confirm(`Send "${item.title}" to TV?`, `Send to TV`) : true;
                if (!ok) return;
                currentFolder = item.title;
                window.currentFolder = item.title;
                if (typeof sendToTV === 'function') {
                  const maybe = sendToTV();
                  if (maybe && typeof maybe.then === 'function') await maybe;
                }
                const inputEl = document.getElementById('searchInput');
                if (inputEl) {
                  inputEl.value = '';
                  try { window.filterTiles(); } catch(e) {}
                }
                // Return to home (or load main folders)
                setTimeout(() => {
                  try {
                    if (typeof returnToHome === 'function') returnToHome();
                    else if (typeof loadMainFolders === 'function') loadMainFolders();
                  } catch(e) {}
                }, 120);

                // Focus the "Continue Watching" tile after the main folders load
                setTimeout(() => {
                  try {
                    const container = document.getElementById('folderContainer');
                    if (!container) return;
                    let target = null;
                    const tiles = Array.from(container.querySelectorAll('.folder'));
                    for (const t of tiles) {
                      const p = t.querySelector('p');
                      if (p && p.innerText && p.innerText.trim() === 'Continue Watching') {
                        target = t;
                        break;
                      }
                    }
                    if (!target) {
                      target = tiles.find(t => {
                        const style = window.getComputedStyle(t);
                        return style && style.display !== 'none' && t.offsetParent !== null;
                      }) || null;
                    }
                    if (target) {
                      target.setAttribute('tabindex', '0');
                      try { target.focus(); } catch(e){}
                      const cleanup = () => {
                        try { target.removeAttribute('tabindex'); } catch(e){}
                        target.removeEventListener('blur', cleanup);
                      };
                      target.addEventListener('blur', cleanup);
                    }
                  } catch (e) {
                    console.warn('focus Continue Watching failed in send action', e);
                  }
                }, 250);
              } catch (e) {
                console.error('send-to-tv click error', e);
              }
            });

            sendBtn.addEventListener('keydown', function(ev) {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                ev.stopPropagation(); // prevents parent tile from also handling
                sendBtn.click();
              }
            });

            div.appendChild(sendBtn);
          }

          div.onclick = () => {
            window._searchNavigateInProgress = true;
            const input = document.getElementById('searchInput');
            if (input) {
              input.value = '';
              input.blur();
            }
            try {
              if (typeof window.openFolderByName === 'function') {
                window.openFolderByName(item.title);
              } else if (typeof loadEpisodes === 'function') {
                loadEpisodes(item.title);
              }
            } catch(e) {
              console.warn('Navigation error:', e);
            }
            setTimeout(() => {
              window._searchNavigateInProgress = false;
            }, 500);
          };

          grid.appendChild(div);
        }

        container.appendChild(grid);

        if (libraryMatches.length > 0) {
          const section = document.createElement('div');
          section.style.width = '100%';
          section.style.marginTop = '18px';
          section.style.paddingTop = '8px';
          section.style.borderTop = '1px solid rgba(255,255,255,0.06)';

          const header = document.createElement('div');
          header.style.color = '#fff';
          header.style.fontSize = '14px';
          header.style.margin = '8px 12px';
          header.innerText = `Library matches for "${raw}"`;
          section.appendChild(header);

          const libGrid = document.createElement('div');
          libGrid.style.display = 'flex';
          libGrid.style.flexWrap = 'wrap';
          libGrid.style.gap = '12px';
          libGrid.style.justifyContent = 'center';

          for (const item of libraryMatches) {
            const div = document.createElement('div');
            div.className = 'folder';
            div.style.width = '150px';
            div.style.cursor = 'pointer';
            div.style.textAlign = 'center';
            div.style.color = '#fff';

            const img = document.createElement('img');
            const coverPath = item.cover || `./Images/${encodeURIComponent(item.title)}.jpg`;
            img.src = coverPath;
            img.alt = item.title;
            img.style.width = '150px';
            img.style.height = '210px';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '10px';
            img.onerror = function() {
              this.onerror = null;
              this.src = './Images/placeholder.jpg';
            };

            const titleP = document.createElement('p');
            titleP.style.fontSize = '16px';
            titleP.style.fontWeight = 'bold';
            titleP.style.color = '#fff';
            titleP.style.margin = '10px 0 0';
            titleP.innerText = item.title;

            const parentP = document.createElement('p');
            parentP.style.fontSize = '11px';
            parentP.style.margin = '2px 0 0';
            parentP.style.color = '#aaa';
            parentP.innerText = item.parent || 'Library';

            div.appendChild(img);
            div.appendChild(titleP);
            div.appendChild(parentP);

            div.onclick = () => {
              const lib = item.lib || 'books';
              const url = `./reader.html?lib=${encodeURIComponent(lib)}&Book=${encodeURIComponent(item.title)}`;
              window.location.href = url;
            };

            libGrid.appendChild(div);
          }

          section.appendChild(libGrid);
          container.appendChild(section);
        }

        if (typeof showHomeButton === 'function') {
          showHomeButton();
        }
      }, 120);

      // Replace the global filterTiles
      window.filterTiles = newFilterTiles;

      // Also attach the new listener to the search input
      const inputEl = document.getElementById('searchInput');
      if (inputEl) {
        // Remove any previous listeners to avoid duplicates
        const oldFilterTiles = window.filterTiles;
        if (oldFilterTiles && typeof oldFilterTiles === 'function') {
          try {
            inputEl.removeEventListener('input', oldFilterTiles);
            console.log('[loadexpanded] Removed old filterTiles listener.');
          } catch (e) {}
        }

        window.filterTiles = newFilterTiles;
        inputEl.oninput = newFilterTiles;
        try {
          inputEl.addEventListener('input', newFilterTiles);
        } catch (e) {}
        console.log('[loadexpanded] Attached new filterTiles listener.');
      }

      let targetEpisodes;
      try {
        targetEpisodes = eval('episodes');
      } catch (e) {
        targetEpisodes = window.episodes;
      }
      if (targetEpisodes && typeof targetEpisodes === 'object') {
        console.log('[loadexpanded] Final episodes keys:', Object.keys(targetEpisodes));
        if (targetEpisodes['Tokyo Ghoul']) {
          console.log('[loadexpanded] Tokyo Ghoul episodes:', targetEpisodes['Tokyo Ghoul']);
        }
      }

      console.log('[loadexpanded] Merge completed.');
      resolve();
    } catch (e) {
      console.error('[loadexpanded] Merge failed:', e);
      resolve();
    }
  });
})();