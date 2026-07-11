// loadexpanded.js – Full data merge + search override with fixed image fallbacks
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
      // Now returns { names: string[], adultSet: Set<string> }
      // ------------------------------------------------------------
      function extractFoldersFromJs(text) {
        const arrMatch = /(?:const|let|var)?\s*folders\s*=\s*\[([\s\S]*?)\]/m.exec(text);
        if (!arrMatch) return { names: [], adultSet: new Set() };
        let content = arrMatch[1];
        content = content.replace(/\/\*[\s\S]*?\*\//g, '');
        content = content.replace(/(^|\n)\s*\/\/.*$/gm, '');
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
      // Helper: extract games array from games.js text
      // ------------------------------------------------------------
      function extractGamesFromJs(text) {
        try {
          const fn = new Function(`"use strict"; ${text}; return typeof games !== 'undefined' ? games : null;`);
          const result = fn();
          if (Array.isArray(result)) {
            return result;
          }
          return null;
        } catch (e) {
          console.warn('[loadexpanded] Failed to extract games from games.js:', e);
          return null;
        }
      }

      // ------------------------------------------------------------
      // Helper: extract musicLibrary and musicLibraryGenreMap from musiclibrary.js text
      // ------------------------------------------------------------
      function extractMusicFromJs(text) {
        try {
          const fn = new Function(`"use strict"; ${text}; return { musicLibrary: typeof musicLibrary !== 'undefined' ? musicLibrary : null, musicLibraryGenreMap: typeof musicLibraryGenreMap !== 'undefined' ? musicLibraryGenreMap : null };`);
          const result = fn();
          return result;
        } catch (e) {
          console.warn('[loadexpanded] Failed to extract music from musiclibrary.js:', e);
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
      let remoteAdultSet = new Set();
      if (mfRes.ok) {
        const mfText = await mfRes.text();
        const parsed = extractFoldersFromJs(mfText);
        remoteFolders = parsed.names;
        remoteAdultSet = parsed.adultSet;
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

          function normalizeSeasonsArray(arr) {
            if (!Array.isArray(arr)) return arr;
            const kidsMode = (typeof window.isKidsModeActive === 'function') ? window.isKidsModeActive() : false;
            if (!kidsMode) return arr;
            return arr.filter(item => typeof item === 'string' && !item.includes('*'));
          }

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
                addFolderOrigin(key);
                added++;
              }
            }
            console.log(`[loadexpanded] Added ${added} new episode entries to global episodes (paths transformed, filtered).`);
          } else {
            if (!window.episodes) window.episodes = {};
            let added = 0;
            for (const key in filteredEpisodes) {
              if (!(key in window.episodes)) {
                window.episodes[key] = filteredEpisodes[key];
                addFolderOrigin(key);
                added++;
              }
            }
            console.log(`[loadexpanded] Added ${added} new episode entries to window.episodes (paths transformed, filtered).`);
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
      // 5. Merge remote games.js (if exists)
      // ------------------------------------------------------------
      console.log('[loadexpanded] Fetching remote games.js...');
      try {
        const gamesRes = await fetch(`${baseUrl}/games.js`, { cache: 'no-store' });
        if (gamesRes.ok) {
          const gamesText = await gamesRes.text();
          const remoteGames = extractGamesFromJs(gamesText);
          if (Array.isArray(remoteGames) && remoteGames.length > 0) {
            if (!window.games || !Array.isArray(window.games)) {
              window.games = [];
            }
            let added = 0;
            for (const remoteGame of remoteGames) {
              const exists = window.games.some(localGame => localGame.name === remoteGame.name || localGame.link === remoteGame.link);
              if (!exists) {
                window.games.push(remoteGame);
                added++;
              }
            }
            console.log(`[loadexpanded] Merged games: added ${added} remote games.`);
          } else {
            console.warn('[loadexpanded] No games found in remote games.js.');
          }
        } else {
          console.warn('[loadexpanded] Remote games.js not found (status: ' + gamesRes.status + '), skipping.');
        }
      } catch (e) {
        console.warn('[loadexpanded] Failed to fetch remote games.js:', e);
      }

      // ------------------------------------------------------------
      // 6. Merge remote musiclibrary.js (if exists)
      // ------------------------------------------------------------
      console.log('[loadexpanded] Fetching remote musiclibrary.js...');
      try {
        const musicRes = await fetch(`${baseUrl}/musiclibrary.js`, { cache: 'no-store' });
        if (musicRes.ok) {
          const musicText = await musicRes.text();
          const remoteMusic = extractMusicFromJs(musicText);
          if (remoteMusic) {
            if (remoteMusic.musicLibrary && Array.isArray(remoteMusic.musicLibrary)) {
              if (!window.musicLibrary || !Array.isArray(window.musicLibrary)) {
                window.musicLibrary = [];
              }
              let added = 0;
              for (const item of remoteMusic.musicLibrary) {
                if (!window.musicLibrary.includes(item)) {
                  window.musicLibrary.push(item);
                  added++;
                }
              }
              console.log(`[loadexpanded] Merged musicLibrary: added ${added} remote entries.`);
            }
            if (remoteMusic.musicLibraryGenreMap && typeof remoteMusic.musicLibraryGenreMap === 'object') {
              if (!window.musicLibraryGenreMap || typeof window.musicLibraryGenreMap !== 'object') {
                window.musicLibraryGenreMap = {};
              }
              let added = 0;
              for (const [key, value] of Object.entries(remoteMusic.musicLibraryGenreMap)) {
                if (!(key in window.musicLibraryGenreMap)) {
                  window.musicLibraryGenreMap[key] = value;
                  added++;
                }
              }
              console.log(`[loadexpanded] Merged musicLibraryGenreMap: added ${added} genre mappings.`);
            }
          } else {
            console.warn('[loadexpanded] Could not extract music data from remote musiclibrary.js.');
          }
        } else {
          console.warn('[loadexpanded] Remote musiclibrary.js not found (status: ' + musicRes.status + '), skipping.');
        }
      } catch (e) {
        console.warn('[loadexpanded] Failed to fetch remote musiclibrary.js:', e);
      }

      // ------------------------------------------------------------
      // 7. Store remote cache for fallback (used by loadEpisodes)
      // ------------------------------------------------------------
      window.__remoteEpisodes = remoteEpisodesCache;
      window.__remoteFoldersSet = new Set(remoteFolders);
      window.__remoteBaseUrl = baseUrl;

      // ------------------------------------------------------------
      // 8. Push this server’s origin into expandedImageOrigins (legacy)
      // ------------------------------------------------------------
      if (!window.expandedImageOrigins) {
        window.expandedImageOrigins = [];
      }
      window.expandedImageOrigins.push(baseUrl);
      console.log('[loadexpanded] Added baseUrl to expandedImageOrigins:', baseUrl);

      // ------------------------------------------------------------
      // 9. Override getImageCandidatesForFolder to use buildImageCandidates
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
      // 10. Patch loadEpisodes to log and ensure episode data is used
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
      // 11. Patch openFolderByName to strip adult markers
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
      // 12. Override search (filterTiles) with full support and UNCONDITIONAL star attachment
      // ------------------------------------------------------------
      console.log('[loadexpanded] Overriding search (filterTiles) with fixed image fallbacks...');

      // --- Helper functions (mirroring original search) ---

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

        // Add loaders as potential root tiles
        for (const prop of Object.getOwnPropertyNames(window)) {
          if (prop.startsWith('load') && prop.endsWith('Seasons') && typeof window[prop] === 'function') {
            const base = prop.replace(/^load/, '').replace(/Seasons$/, '');
            let display = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
            display = display.trim();
            if (display && !seen.has(normKey(display))) {
              seen.add(normKey(display));
              merged.push({ title: display, parent: null, source: 'loader' });
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

      function buildGamesIndex() {
        const items = [];
        if (Array.isArray(window.games)) {
          for (const game of window.games) {
            if (game && game.name) {
              items.push({
                title: game.name,
                parent: 'Games',
                source: 'game',
                link: game.link,
                img: game.img,
                specialSet: game.specialSet,
                disks: game.disks
              });
            }
          }
        }
        return items;
      }

      function buildMusicIndex() {
        const items = [];
        if (Array.isArray(window.musicLibrary)) {
          for (const entry of window.musicLibrary) {
            let raw = '';
            if (typeof entry === 'string') {
              raw = entry;
            } else if (entry && typeof entry === 'object' && entry.raw) {
              raw = entry.raw;
            } else if (entry && typeof entry === 'object' && entry.title && entry.artist) {
              items.push({
                title: entry.title || '',
                artist: entry.artist || '',
                genre: entry.genre || '',
                raw: entry.raw || ''
              });
              continue;
            } else {
              continue;
            }

            let genreCode = '';
            const dollarIdx = raw.lastIndexOf('$');
            if (dollarIdx !== -1) {
              genreCode = raw.slice(dollarIdx + 1);
              raw = raw.slice(0, dollarIdx);
            }

            const parts = raw.split(' - ').map(s => s.trim());
            let song = raw;
            let artist = '';
            if (parts.length > 1) {
              artist = parts[parts.length - 1];
              song = parts.slice(0, parts.length - 1).join(' - ');
            }

            const genreName = (window.musicLibraryGenreMap && window.musicLibraryGenreMap[genreCode]) || genreCode;
            items.push({
              title: song,
              parent: 'Music',
              source: 'music',
              artist: artist,
              genre: genreName,
              raw: entry
            });
          }
        }
        return items;
      }

      // --- Render functions (FIXED: now use folderOriginMap for remote fallback) ---

      function renderGameMatches(matches, rawQuery) {
        const container = document.getElementById('folderContainer');
        if (!container) return;
        const old = document.getElementById('gamesSearchSection');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        if (!matches || matches.length === 0) return;

        const section = document.createElement('div');
        section.id = 'gamesSearchSection';
        section.style.width = '100%';
        section.style.marginTop = '18px';
        section.style.paddingTop = '8px';
        section.style.borderTop = '1px solid rgba(255,255,255,0.06)';

        const header = document.createElement('div');
        header.style.color = '#fff';
        header.style.fontSize = '14px';
        header.style.margin = '8px 12px';
        header.innerText = `Games matches for "${rawQuery}"`;
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.style.display = 'flex';
        grid.style.flexWrap = 'wrap';
        grid.style.gap = '12px';
        grid.style.justifyContent = 'center';
        grid.style.padding = '6px 12px';

        // Helper: get the origin for "Games" folder if set
        const gamesOrigin = (window.folderOriginMap && window.folderOriginMap['Games'])
          ? (window.folderOriginMap['Games'].endsWith('/') ? window.folderOriginMap['Games'] : window.folderOriginMap['Games'] + '/')
          : null;

        matches.forEach(m => {
          const isMultiDisk = m && m.specialSet === 'multidisk' && Array.isArray(m.disks) && m.disks.length > 0;
          const card = document.createElement('div');
          card.className = 'game-match-card';
          card.style.width = '170px';
          card.style.cursor = 'default';
          card.style.textAlign = 'center';
          card.style.color = '#fff';
          card.style.display = 'flex';
          card.style.flexDirection = 'column';
          card.style.alignItems = 'center';
          card.style.gap = '8px';

          const rootTile = document.createElement('div');
          rootTile.style.cursor = 'pointer';
          rootTile.style.width = '170px';

          const rootImg = document.createElement('img');
          rootImg.alt = m.title || m.name || '';
          rootImg.style.width = '150px';
          rootImg.style.height = '210px';
          rootImg.style.objectFit = 'cover';
          rootImg.style.borderRadius = '10px';
          rootImg.style.display = 'block';
          rootImg.style.margin = '0 auto';

          // Build candidate list: local img, then remote equivalent if origin exists, then placeholder
          const candidates = [];
          if (m.img) {
            candidates.push(m.img); // local first (may be relative or absolute)
            // If we have a "Games" origin, try the same path there
            if (gamesOrigin && !/^https?:\/\//i.test(m.img)) {
              const clean = m.img.replace(/^\.?\//, '');
              candidates.push(gamesOrigin + clean);
            }
          }
          candidates.push('./Images/placeholder.jpg');

          let idx = 0;
          rootImg.src = candidates[0];
          rootImg.onerror = function() {
            idx++;
            if (idx < candidates.length) {
              this.src = candidates[idx];
            } else {
              this.onerror = null;
            }
          };

          const rootTitle = document.createElement('p');
          rootTitle.style.fontSize = '13px';
          rootTitle.style.margin = '6px 0 0';
          rootTitle.style.fontWeight = 'bold';
          rootTitle.innerText = m.title || m.name || '';

          rootTile.appendChild(rootImg);
          rootTile.appendChild(rootTitle);

          rootTile.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isMultiDisk && typeof window.displayDisks === 'function') {
              window.displayDisks(m);
              return;
            }
            if (!m.link) return;
            if (/^https?:\/\//i.test(m.link)) window.open(m.link, '_blank');
            else window.location.href = m.link;
          });

          card.appendChild(rootTile);

          if (isMultiDisk) {
            const diskRow = document.createElement('div');
            diskRow.style.display = 'flex';
            diskRow.style.flexWrap = 'wrap';
            diskRow.style.gap = '6px';
            diskRow.style.justifyContent = 'center';
            diskRow.style.width = '100%';

            m.disks.forEach(disk => {
              const diskTile = document.createElement('div');
              diskTile.style.width = '48px';
              diskTile.style.cursor = 'pointer';
              diskTile.style.textAlign = 'center';
              diskTile.style.color = '#fff';

              const diskImg = document.createElement('img');
              diskImg.alt = `${m.title || m.name || 'Game'} - Disk ${disk.disk}`;
              diskImg.style.width = '48px';
              diskImg.style.height = '68px';
              diskImg.style.objectFit = 'cover';
              diskImg.style.borderRadius = '6px';
              diskImg.style.display = 'block';

              // Same fallback logic for disk images
              const diskCandidates = [];
              if (disk.img) {
                diskCandidates.push(disk.img);
                if (gamesOrigin && !/^https?:\/\//i.test(disk.img)) {
                  const clean = disk.img.replace(/^\.?\//, '');
                  diskCandidates.push(gamesOrigin + clean);
                }
              }
              diskCandidates.push('./Images/placeholder.jpg');

              let diskIdx = 0;
              diskImg.src = diskCandidates[0];
              diskImg.onerror = function() {
                diskIdx++;
                if (diskIdx < diskCandidates.length) {
                  this.src = diskCandidates[diskIdx];
                } else {
                  this.onerror = null;
                }
              };

              const diskLabel = document.createElement('div');
              diskLabel.textContent = `D${disk.disk}`;
              diskLabel.style.fontSize = '11px';
              diskLabel.style.marginTop = '3px';

              diskTile.appendChild(diskImg);
              diskTile.appendChild(diskLabel);

              diskTile.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (disk.link) {
                  window.location.href = disk.link;
                }
              });

              diskRow.appendChild(diskTile);
            });

            card.appendChild(diskRow);
          }

          grid.appendChild(card);
        });

        section.appendChild(grid);
        container.appendChild(section);
        if (typeof showHomeButton === 'function') showHomeButton();
      }

      function renderMusicMatches(matches, rawQuery) {
        const container = document.getElementById('folderContainer');
        if (!container) return;
        const old = document.getElementById('musicSearchSection');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        if (!matches || matches.length === 0) return;

        const section = document.createElement('div');
        section.id = 'musicSearchSection';
        section.style.width = '100%';
        section.style.marginTop = '18px';
        section.style.paddingTop = '8px';
        section.style.borderTop = '1px solid rgba(255,255,255,0.06)';

        const header = document.createElement('div');
        header.style.color = '#fff';
        header.style.fontSize = '14px';
        header.style.margin = '8px 12px';
        header.innerText = `Music matches for "${rawQuery}"`;
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.style.display = 'flex';
        grid.style.flexWrap = 'wrap';
        grid.style.gap = '12px';
        grid.style.justifyContent = 'center';
        grid.style.padding = '6px 12px';

        // Get the origin for the "Music" folder if set
        const musicOrigin = (window.folderOriginMap && window.folderOriginMap['Music'])
          ? (window.folderOriginMap['Music'].endsWith('/') ? window.folderOriginMap['Music'] : window.folderOriginMap['Music'] + '/')
          : null;

        matches.forEach(m => {
          const div = document.createElement('div');
          div.className = 'folder';
          div.style.width = '150px';
          div.style.cursor = 'pointer';
          div.style.textAlign = 'center';
          div.style.color = '#fff';
          div.style.position = 'relative';
          div.style.overflow = 'visible';

          const artistSafe = (m.artist || '').trim();
          const candidates = [];

          // Local artist‑based images first
          if (artistSafe) {
            candidates.push(`./Music/Images/${artistSafe}.jpg`);
            candidates.push(`Music/Images/${artistSafe}.jpg`);
            candidates.push(`./Music/Images/${artistSafe}.png`);
          }

          // Remote artist‑based images if Music origin exists
          if (musicOrigin && artistSafe) {
            candidates.push(`${musicOrigin}Music/Images/${artistSafe}.jpg`);
            candidates.push(`${musicOrigin}Music/Images/${artistSafe}.png`);
          }

          // Use buildImageCandidates for "Music" as a broader fallback (it includes e.g. ./Music/Music.jpg etc.)
          if (typeof window.buildImageCandidates === 'function') {
            const musicCandidates = window.buildImageCandidates('Music', null, window.episodes || {});
            for (const url of musicCandidates) {
              if (!candidates.includes(url)) candidates.push(url);
            }
          } else {
            // Fallback if buildImageCandidates missing
            candidates.push('./Music/Music.jpg');
            candidates.push('./Images/placeholder.jpg');
          }

          // Ensure placeholder is always last
          if (!candidates.includes('./Images/placeholder.jpg')) {
            candidates.push('./Images/placeholder.jpg');
          }

          let idx = 0;
          const imgEl = document.createElement('img');
          imgEl.alt = `${m.title || ''} - ${m.artist || ''}`.trim();
          imgEl.style.width = '150px';
          imgEl.style.height = '210px';
          imgEl.style.objectFit = 'cover';
          imgEl.style.borderRadius = '10px';
          imgEl.style.display = 'block';
          imgEl.onerror = function() {
            if (idx < candidates.length - 1) {
              idx++;
              this.src = candidates[idx];
            } else {
              this.onerror = null;
            }
          };
          imgEl.src = candidates[0];

          const titleP = document.createElement('p');
          titleP.style.fontSize = '14px';
          titleP.style.fontWeight = 'bold';
          titleP.style.color = '#fff';
          titleP.style.margin = '8px 0 0';
          titleP.innerText = m.title || '';

          const artistP = document.createElement('p');
          artistP.style.fontSize = '12px';
          artistP.style.margin = '4px 0 0';
          artistP.style.color = '#aaa';
          artistP.innerText = m.artist || '';

          const genreP = document.createElement('p');
          genreP.style.fontSize = '12px';
          genreP.style.margin = '3px 0 0';
          genreP.style.color = '#ddd';
          genreP.innerText = m.genre || '';

          div.appendChild(imgEl);
          div.appendChild(titleP);
          if (m.artist) div.appendChild(artistP);
          if (m.genre) div.appendChild(genreP);

          div.addEventListener('click', () => {
            try {
              const target = `./Music.html?play=${encodeURIComponent(m.raw || m.title)}`;
              window.location.href = target;
            } catch (e) { console.error('music tile click', e); }
          });

          grid.appendChild(div);
        });

        section.appendChild(grid);
        container.appendChild(section);
        if (typeof showHomeButton === 'function') showHomeButton();
      }

      function renderLibraryMatches(libraryMatches, rawQuery) {
        const container = document.getElementById('folderContainer');
        if (!container) return;
        const old = document.getElementById('librarySearchSection');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        if (!libraryMatches || libraryMatches.length === 0) return;

        const section = document.createElement('div');
        section.id = 'librarySearchSection';
        section.style.width = '100%';
        section.style.marginTop = '18px';
        section.style.paddingTop = '8px';
        section.style.borderTop = '1px solid rgba(255,255,255,0.06)';

        const header = document.createElement('div');
        header.style.color = '#fff';
        header.style.fontSize = '14px';
        header.style.margin = '8px 12px';
        header.innerText = `Reading matches for "${rawQuery}"`;
        section.appendChild(header);

        const groups = {};
        for (const item of libraryMatches) {
          const parent = item.parent || 'Library';
          if (!groups[parent]) groups[parent] = [];
          groups[parent].push(item);
        }

        for (const [category, items] of Object.entries(groups)) {
          const subHeader = document.createElement('div');
          subHeader.style.color = '#ddd';
          subHeader.style.fontSize = '13px';
          subHeader.style.margin = '14px 12px 6px';
          subHeader.style.opacity = '0.95';
          subHeader.innerText = `${category} (${items.length})`;
          section.appendChild(subHeader);

          const grid = document.createElement('div');
          grid.style.display = 'flex';
          grid.style.flexWrap = 'wrap';
          grid.style.gap = '12px';
          grid.style.justifyContent = 'center';
          grid.style.padding = '6px 12px';

          // Get origin for this category if available (Books, Manga, etc.)
          const categoryOrigin = (window.folderOriginMap && window.folderOriginMap[category])
            ? (window.folderOriginMap[category].endsWith('/') ? window.folderOriginMap[category] : window.folderOriginMap[category] + '/')
            : null;

          for (const item of items) {
            const div = document.createElement('div');
            div.className = 'folder';
            div.style.width = '150px';
            div.style.cursor = 'pointer';
            div.style.textAlign = 'center';
            div.style.color = '#fff';
            div.style.position = 'relative';
            div.style.overflow = 'visible';

            const coverPath = item.cover || `./Images/${encodeURIComponent(item.title)}.jpg`;
            const img = document.createElement('img');
            img.alt = item.title;
            img.style.width = '150px';
            img.style.height = '210px';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '10px';

            // Candidates: local cover, then remote equivalent (if category origin exists), then placeholder
            const candidates = [coverPath];
            if (categoryOrigin && !/^https?:\/\//i.test(coverPath)) {
              const clean = coverPath.replace(/^\.?\//, '');
              candidates.push(categoryOrigin + clean);
            }
            candidates.push('./Images/placeholder.jpg');

            let idx = 0;
            img.src = candidates[0];
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

            const parentP = document.createElement('p');
            parentP.style.fontSize = '11px';
            parentP.style.margin = '2px 0 0';
            parentP.style.color = '#aaa';
            parentP.innerText = item.parent || '';

            div.appendChild(img);
            div.appendChild(titleP);
            div.appendChild(parentP);

            div.onclick = () => {
              const lib = item.lib || 'books';
              const url = `./reader.html?lib=${encodeURIComponent(lib)}&Book=${encodeURIComponent(item.title)}`;
              window.location.href = url;
            };

            grid.appendChild(div);
          }

          section.appendChild(grid);
        }

        container.appendChild(section);
        if (typeof showHomeButton === 'function') showHomeButton();
      }

      // --- Helper: attach favorite star (mirroring original) ---
      function attachTileFavorite(tile, folderName) {
        if (typeof window.attachSeasonFavoriteStar === 'function') {
          window.attachSeasonFavoriteStar(tile, folderName);
          return;
        }

        const readFavs = () => {
          try {
            if (typeof getStoredFavorites === 'function') {
              const favs = getStoredFavorites();
              return Array.isArray(favs) ? favs : [];
            }
            return JSON.parse(localStorage.getItem('favorites') || '[]');
          } catch (e) {
            return [];
          }
        };

        const starBtn = document.createElement('button');
        starBtn.type = 'button';
        starBtn.className = 'tile-fav-star';
        starBtn.setAttribute('aria-label', `Favorite ${folderName}`);
        starBtn.setAttribute('title', `Favorite ${folderName}`);
        starBtn.tabIndex = 0;

        const glyph = document.createElement('span');
        glyph.className = 'tile-fav-glyph';
        glyph.style.pointerEvents = 'none';
        glyph.textContent = '☆';
        starBtn.appendChild(glyph);

        function refreshStarVisual() {
          const favs = readFavs();
          const isFav = Array.isArray(favs) && favs.includes(folderName);
          glyph.textContent = isFav ? '★' : '☆';
          glyph.style.color = isFav ? '#ffcf33' : '#fff';
          starBtn.classList.toggle('favorited', isFav);
        }

        function toggleFavorite() {
          try {
            if (typeof toggleFavoriteByName === 'function') {
              toggleFavoriteByName(folderName);
            } else {
              const favs = readFavs();
              const idx = favs.indexOf(folderName);
              if (idx === -1) favs.push(folderName);
              else favs.splice(idx, 1);
              if (typeof setStoredFavorites === 'function') setStoredFavorites(favs);
              else localStorage.setItem('favorites', JSON.stringify(favs));
              if (typeof saveFavoritesToServer === 'function') {
                try { saveFavoritesToServer(favs).catch(() => {}); } catch (e) {}
              }
            }
          } catch (e) {
            console.warn('favorite toggle failed', e);
          }
          refreshStarVisual();
          if (typeof updateFavoriteButtonUI === 'function') updateFavoriteButtonUI();
        }

        starBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          toggleFavorite();
        });

        starBtn.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
            e.preventDefault();
            e.stopPropagation();
            starBtn.click();
            return;
          }
        });

        starBtn.addEventListener('pointerdown', function(e) {
          e.stopPropagation();
        }, { passive: true });

        tile.style.position = tile.style.position || 'relative';
        tile.appendChild(starBtn);
        refreshStarVisual();
      }

      // --- Main filterTiles function ---
      const DEEP_ALL_TOKEN = '---';

      function debounce(fn, wait) {
        let timer;
        return function(...args) {
          clearTimeout(timer);
          timer = setTimeout(() => fn.apply(this, args), wait);
        };
      }

      const newFilterTiles = debounce(async function() {
        // Inject Send-to-TV CSS if missing
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

        // ensure star is visible when focused
        if (!document.getElementById('fav-star-focus-style')) {
          const focusStyle = document.createElement('style');
          focusStyle.id = 'fav-star-focus-style';
          focusStyle.textContent = `
            .tile-fav-star:focus {
              opacity: 1 !important;
              pointer-events: auto !important;
            }
          `;
          document.head.appendChild(focusStyle);
        }

        if (window._searchNavigateInProgress) return;

        const input = document.getElementById('searchInput');
        if (!input) return;
        const raw = input.value.trim();
        const q = normKey(raw);
        const container = document.getElementById('folderContainer');
        if (!container) return;

        if (!raw) {
          if (typeof loadMainFolders === 'function') {
            loadMainFolders();
          }
          return;
        }

        const deepAll = raw === DEEP_ALL_TOKEN;

        // Build all indices
        const mergedIndex = buildMergedIndex();
        const libraryIndex = buildLibraryIndex();
        const gamesIndex = buildGamesIndex();
        const musicIndex = buildMusicIndex();

        let mainMatches = [];
        let libraryMatches = [];
        let gameMatches = [];
        let musicMatches = [];

        if (deepAll) {
          mainMatches = mergedIndex;
          libraryMatches = libraryIndex;
          gameMatches = gamesIndex;
          musicMatches = musicIndex;
        } else {
          if (q.length >= 2) {
            mainMatches = mergedIndex.filter(item => normKey(item.title).includes(q));
            libraryMatches = libraryIndex.filter(item => normKey(item.title).includes(q));
            gameMatches = gamesIndex.filter(item => normKey(item.title).includes(q));
            musicMatches = musicIndex.filter(item => normKey(item.title).includes(q) || normKey(item.artist).includes(q) || normKey(item.genre).includes(q));
          } else if (q.length === 1) {
            const exact = mergedIndex.find(item => normKey(item.title) === q);
            mainMatches = exact ? [exact] : [];
            libraryMatches = libraryIndex.filter(item => normKey(item.title) === q);
            gameMatches = gamesIndex.filter(item => normKey(item.title) === q);
            musicMatches = musicIndex.filter(item => normKey(item.title) === q || normKey(item.artist) === q || normKey(item.genre) === q);
          } else {
            return;
          }
        }

        container.innerHTML = '';

        if (mainMatches.length === 0 && libraryMatches.length === 0 && gameMatches.length === 0 && musicMatches.length === 0) {
          const no = document.createElement('div');
          no.style.color = '#fff';
          no.style.textAlign = 'center';
          no.style.padding = '30px';
          no.innerText = `No matches for "${raw}"`;
          container.appendChild(no);
          return;
        }

        // --- Render main matches (folders, episodes, loaders) ---
        if (mainMatches.length > 0) {
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

            // Uses buildImageCandidates – already correct
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

            // Star attachment
            const suppressFavoriteStar = (typeof window.isRootFavoriteSuppressedTile === 'function')
              ? window.isRootFavoriteSuppressedTile(item.title)
              : false;

            const parentLower = (item.parent || '').toLowerCase();
            const isMusicOrGame = parentLower === 'music' || parentLower === 'games';

            if (!suppressFavoriteStar && !isMusicOrGame) {
              attachTileFavorite(div, item.title);
            }

            const isRootWithSeasons = (window._rootNonFavoriteTileSet && window._rootNonFavoriteTileSet.has(item.title));
            const hasChildren = parentMap.has(item.title) && parentMap.get(item.title).length > 0;
            const isSpecialHandlerTile = !!(window._specialFolderHandlers && typeof window._specialFolderHandlers[item.title] === 'function');
            const isMasterTile = (typeof window.isMasterTile === 'function') ? window.isMasterTile(item.title) : false;

            const showSendBtn = !isRootWithSeasons && !hasChildren && !isSpecialHandlerTile && !isMasterTile;

            if (!showSendBtn) {
              div.tabIndex = 0;
              div.setAttribute('role', 'button');
              div.setAttribute('aria-label', `Open ${item.title}`);
              div.addEventListener('keydown', function(ev) {
                if (ev.target.closest && ev.target.closest('.send-to-tv-btn, .tile-fav-star, button, a, input, textarea, select, [role="switch"]')) return;
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
                  setTimeout(() => {
                    try {
                      if (typeof returnToHome === 'function') returnToHome();
                      else if (typeof loadMainFolders === 'function') loadMainFolders();
                    } catch(e) {}
                  }, 120);
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
                  ev.stopPropagation();
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
        }

        // --- Render library (books, manga, guidebooks) matches ---
        if (libraryMatches.length > 0) {
          renderLibraryMatches(libraryMatches, raw);
        }

        // --- Render game matches ---
        if (gameMatches.length > 0) {
          renderGameMatches(gameMatches, raw);
        }

        // --- Render music matches ---
        if (musicMatches.length > 0) {
          renderMusicMatches(musicMatches, raw);
        }

        if (typeof showHomeButton === 'function') {
          showHomeButton();
        }
      }, 120);

      // --- Install the new filterTiles ---
      window.filterTiles = newFilterTiles;

      const inputEl = document.getElementById('searchInput');
      if (inputEl) {
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

      // ------------------------------------------------------------
      // Final log
      // ------------------------------------------------------------
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

      console.log('[loadexpanded] Merge completed. Search now includes games, music, books, manga, guidebooks with proper image fallbacks.');
      resolve();
    } catch (e) {
      console.error('[loadexpanded] Merge failed:', e);
      resolve();
    }
  });
})();