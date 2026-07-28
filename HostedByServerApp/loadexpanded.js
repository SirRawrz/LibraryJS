// loadexpanded.js – Enhanced search with dynamic music & library globals loading
// Implements priority-based merging for music, games, and books
(function() {
  window.__loadexpandedPromise = new Promise(async (resolve) => {
    // ----------------------------------------------------------------
    // 0. Priority source management (shared across categories)
    // ----------------------------------------------------------------

    /**
     * Fetches and orders sources from lowest priority to highest priority.
     * Priority: localexpanded.txt (1) → expandedstorage.txt (2) → server origin (3)
     */
    async function getPrioritizedSources() {
      const sources = [];
      const serverOrigin = window.location.origin;

      // PRIORITY 1: localexpanded.txt (farthest nodes)
      try {
        const res = await fetch('./localexpanded.txt', { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          const lines = text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
          for (const line of lines) {
            let origin = line;
            if (!/^https?:\/\//i.test(origin)) origin = `http://${origin}`;
            sources.push({ id: `local-${origin}`, label: `Node: ${origin}`, origin, priority: 1 });
          }
        }
      } catch (e) {
        console.warn('[loadexpanded] Could not load localexpanded.txt', e);
      }

      // PRIORITY 2: expandedstorage.txt (expanded ports)
      try {
        const res = await fetch('./expandedstorage.txt', { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          const entries = text.split(/[\s,;|]+/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
          for (const entry of entries) {
            let origin = entry;
            if (!/^https?:\/\//i.test(origin)) {
              origin = `${window.location.protocol}//${window.location.hostname}:${entry}`;
            }
            sources.push({ id: `expanded-${entry}`, label: `Expanded: ${entry}`, origin, priority: 2 });
          }
        }
      } catch (e) {
        console.warn('[loadexpanded] Could not load expandedstorage.txt', e);
      }

      // PRIORITY 3: Server origin (source of most truth)
      sources.push({ id: 'server-origin', label: 'Server', origin: serverOrigin, priority: 3 });

      // Sort ascending so highest priority is processed LAST
      return sources.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Merges category data by processing sources from lowest to highest priority.
     * Duplicates are overwritten by higher-priority sources.
     * Every item is guaranteed to be an object with _origin and _sourceId.
     */
    function mergeCategoryData(fetchedDatasets, category) {
      const mergedMap = new Map();

      fetchedDatasets.forEach(({ source, data }) => {
        if (!data) return;

        const items = Array.isArray(data) ? data : Object.values(data);

        items.forEach(item => {
          // Normalize: if item is not an object, wrap it with a `raw` property
          let normalizedItem = item;
          if (typeof item !== 'object' || item === null) {
            normalizedItem = { raw: String(item) };
          } else if (Array.isArray(item)) {
            // If it's an array, treat it as a special case (unlikely for music/games/books)
            // We'll just keep it and add origin to the array? Better to flatten or ignore.
            // For safety, we'll wrap it in an object with a "items" property.
            normalizedItem = { items: item };
          }

          // Ensure it's a plain object (not Array) for adding properties
          if (typeof normalizedItem === 'object' && !Array.isArray(normalizedItem)) {
            normalizedItem._origin = source.origin;
            normalizedItem._sourceId = source.id;
          }

          // Determine a unique key for deduplication
          let uniqueKey = '';
          if (category === 'music') {
            uniqueKey = normalizedItem.base || normalizedItem.title || normalizedItem.raw || JSON.stringify(normalizedItem);
          } else if (category === 'games') {
            uniqueKey = normalizedItem.name || normalizedItem.title || normalizedItem.file || JSON.stringify(normalizedItem);
          } else if (category === 'books') {
            uniqueKey = normalizedItem.title || normalizedItem.file || normalizedItem.name || JSON.stringify(normalizedItem);
          } else {
            uniqueKey = normalizedItem.id || normalizedItem.title || JSON.stringify(normalizedItem);
          }

          if (uniqueKey) {
            mergedMap.set(uniqueKey, normalizedItem);
          }
        });
      });

      return Array.from(mergedMap.values());
    }

    /**
     * Consistent source color for UI dots (matches manage.html's implementation)
     */
    function getSourceColor(sourceId) {
      if (!sourceId) return '#cccccc';
      let hash = 0;
      for (let i = 0; i < sourceId.length; i++) {
        hash = sourceId.charCodeAt(i) + ((hash << 5) - hash);
      }
      hash = Math.abs(hash);
      const colors = [
        '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
        '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4',
        '#469990', '#dcbeff', '#9A6324', '#fffac8', '#800000',
        '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9'
      ];
      return colors[hash % colors.length];
    }

    // ----------------------------------------------------------------
    // 1. Ensure musicLibrary and library globals (books, manga, guidebooks)
    // ----------------------------------------------------------------
    async function ensureMusicLibrary() {
      if (window.musicLibrary && Array.isArray(window.musicLibrary)) {
        console.log('[loadexpanded] musicLibrary already present.');
        return;
      }
      try {
        const res = await fetch('./musiclibrary.js', { cache: 'no-store' });
        if (!res.ok) {
          console.warn('[loadexpanded] musiclibrary.js not found, music search disabled.');
          return;
        }
        const text = await res.text();
        const fn = new Function(`"use strict"; ${text}; return {
          musicLibrary: typeof musicLibrary !== 'undefined' ? musicLibrary : null,
          musicLibraryGenreMap: typeof musicLibraryGenreMap !== 'undefined' ? musicLibraryGenreMap : null
        };`);
        const result = fn();
        if (result.musicLibrary) {
          window.musicLibrary = result.musicLibrary;
        }
        if (result.musicLibraryGenreMap) {
          window.musicLibraryGenreMap = result.musicLibraryGenreMap;
        }
        console.log('[loadexpanded] ✅ musicLibrary loaded dynamically.');
      } catch (e) {
        console.warn('[loadexpanded] Failed to load musicLibrary:', e);
      }
    }

    async function ensureLibraryGlobals() {
      const globals = ['books', 'manga', 'guidebooks'];
      const toLoad = globals.filter(g => !Array.isArray(window[g]));
      if (toLoad.length === 0) {
        console.log('[loadexpanded] All library globals already present.');
        return;
      }
      console.log('[loadexpanded] Loading missing library globals:', toLoad);
      for (const g of toLoad) {
        try {
          const res = await fetch(`./${g}.js`, { cache: 'no-store' });
          if (!res.ok) {
            console.warn(`[loadexpanded] ${g}.js not found, skipping.`);
            continue;
          }
          const text = await res.text();
          const fn = new Function(`"use strict"; ${text}; return typeof ${g} !== 'undefined' ? ${g} : null;`);
          const result = fn();
          if (Array.isArray(result)) {
            window[g] = result;
            console.log(`[loadexpanded] ✅ ${g} loaded dynamically.`);
          } else {
            const sandbox = { window: {} };
            const fn2 = new Function('window', text);
            fn2(sandbox.window);
            if (sandbox.window.libraryData && Array.isArray(sandbox.window.libraryData.items)) {
              window[g] = sandbox.window.libraryData.items;
              console.log(`[loadexpanded] ✅ ${g} loaded from libraryData.items.`);
            } else {
              console.warn(`[loadexpanded] No data found in ${g}.js`);
            }
          }
        } catch (e) {
          console.warn(`[loadexpanded] Failed to load ${g}.js:`, e);
        }
      }
    }

    await ensureMusicLibrary();
    await ensureLibraryGlobals();

    // ================================================================
    // 1. ALWAYS install enhanced search (regardless of remote merge)
    // ================================================================

    function collapseTrailingAdultMarks(value) {
      return String(value || '').replace(/\*+$/g, '').trim();
    }

    function normKey(s) {
      return String(s || '')
        .replace(/&amp;/gi, 'and')
        .replace(/&/g, 'and')
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
    }

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
      try { episodesObj = eval('episodes'); } catch (e) { episodesObj = window.episodes; }
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
      const libGlobals = { books: 'Books', manga: 'Manga', guidebooks: 'Guidebooks' };
      for (const [globalKey, category] of Object.entries(libGlobals)) {
        if (Array.isArray(window[globalKey])) {
          for (const item of window[globalKey]) {
            if (item && item.title) {
              items.push({
                title: item.title,
                parent: category,
                source: 'library',
                cover: item.cover || '',
                lib: globalKey,
                rawItem: item,
                _origin: item._origin || null,
                _sourceId: item._sourceId || null
              });
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
              disks: game.disks,
              _origin: game._origin || null,
              _sourceId: game._sourceId || null
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
          let origin = entry._origin || null;
          let sourceId = entry._sourceId || null;

          if (typeof entry === 'string') {
            raw = entry;
          } else if (entry && typeof entry === 'object' && entry.raw) {
            raw = entry.raw;
          } else if (entry && typeof entry === 'object' && entry.title && entry.artist) {
            // already structured
            items.push({
              title: entry.title || '',
              artist: entry.artist || '',
              genre: entry.genre || '',
              raw: entry.raw || '',
              _origin: origin,
              _sourceId: sourceId
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
            raw: entry,
            _origin: origin,
            _sourceId: sourceId
          });
        }
      }
      return items;
    }

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
        } catch (e) { return []; }
      };
      const starBtn = document.createElement('button');
      starBtn.type = 'button';
      starBtn.className = 'tile-fav-star';
      starBtn.setAttribute('aria-label', `Favorite ${folderName}`);
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
          if (typeof toggleFavoriteByName === 'function') toggleFavoriteByName(folderName);
          else {
            const favs = readFavs();
            const idx = favs.indexOf(folderName);
            if (idx === -1) favs.push(folderName);
            else favs.splice(idx, 1);
            if (typeof setStoredFavorites === 'function') setStoredFavorites(favs);
            else localStorage.setItem('favorites', JSON.stringify(favs));
            if (typeof saveFavoritesToServer === 'function') try { saveFavoritesToServer(favs).catch(()=>{}); } catch(e){}
          }
        } catch (e) {}
        refreshStarVisual();
        if (typeof updateFavoriteButtonUI === 'function') updateFavoriteButtonUI();
      }
      starBtn.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(); });
      starBtn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); starBtn.click(); }
      });
      starBtn.addEventListener('pointerdown', e => e.stopPropagation(), { passive: true });
      tile.style.position = tile.style.position || 'relative';
      tile.appendChild(starBtn);
      refreshStarVisual();
    }

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
      const gamesOrigin = (window.folderOriginMap && window.folderOriginMap['Games'])
        ? (window.folderOriginMap['Games'].endsWith('/') ? window.folderOriginMap['Games'] : window.folderOriginMap['Games'] + '/') : null;

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

        const candidates = [];
        if (m.img) {
          candidates.push(m.img);
          if (gamesOrigin && !/^https?:\/\//i.test(m.img)) candidates.push(gamesOrigin + m.img.replace(/^\.?\//, ''));
        }
        candidates.push('./Images/placeholder.jpg');
        let idx = 0;
        rootImg.src = candidates[0];
        rootImg.onerror = function() {
          idx++;
          if (idx < candidates.length) this.src = candidates[idx];
          else this.onerror = null;
        };

        const rootTitle = document.createElement('p');
        rootTitle.style.fontSize = '13px';
        rootTitle.style.margin = '6px 0 0';
        rootTitle.style.fontWeight = 'bold';
        rootTitle.innerText = m.title || m.name || '';
        rootTile.appendChild(rootImg);
        rootTile.appendChild(rootTitle);

        rootTile.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          if (isMultiDisk && typeof window.displayDisks === 'function') { window.displayDisks(m); return; }
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
            diskImg.style.width = '48px';
            diskImg.style.height = '68px';
            diskImg.style.objectFit = 'cover';
            diskImg.style.borderRadius = '6px';
            diskImg.style.display = 'block';
            const diskCandidates = [];
            if (disk.img) {
              diskCandidates.push(disk.img);
              if (gamesOrigin && !/^https?:\/\//i.test(disk.img)) diskCandidates.push(gamesOrigin + disk.img.replace(/^\.?\//, ''));
            }
            diskCandidates.push('./Images/placeholder.jpg');
            let diskIdx = 0;
            diskImg.src = diskCandidates[0];
            diskImg.onerror = function() {
              diskIdx++;
              if (diskIdx < diskCandidates.length) this.src = diskCandidates[diskIdx];
              else this.onerror = null;
            };
            const diskLabel = document.createElement('div');
            diskLabel.textContent = `D${disk.disk}`;
            diskLabel.style.fontSize = '11px';
            diskLabel.style.marginTop = '3px';
            diskTile.appendChild(diskImg);
            diskTile.appendChild(diskLabel);
            diskTile.addEventListener('click', (e) => {
              e.preventDefault(); e.stopPropagation();
              if (disk.link) window.location.href = disk.link;
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
      const musicOrigin = (window.folderOriginMap && window.folderOriginMap['Music'])
        ? (window.folderOriginMap['Music'].endsWith('/') ? window.folderOriginMap['Music'] : window.folderOriginMap['Music'] + '/') : null;

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
        if (artistSafe) {
          candidates.push(`./Music/Images/${artistSafe}.jpg`);
          candidates.push(`Music/Images/${artistSafe}.jpg`);
          candidates.push(`./Music/Images/${artistSafe}.png`);
          if (musicOrigin) {
            candidates.push(`${musicOrigin}Music/Images/${artistSafe}.jpg`);
            candidates.push(`${musicOrigin}Music/Images/${artistSafe}.png`);
          }
        }
        if (typeof window.buildImageCandidates === 'function') {
          const musicCandidates = window.buildImageCandidates('Music', null, window.episodes || {});
          for (const url of musicCandidates) if (!candidates.includes(url)) candidates.push(url);
        } else {
          candidates.push('./Music/Music.jpg');
        }
        candidates.push('./Images/placeholder.jpg');

        let idx = 0;
        const imgEl = document.createElement('img');
        imgEl.alt = `${m.title || ''} - ${m.artist || ''}`.trim();
        imgEl.style.width = '150px';
        imgEl.style.height = '210px';
        imgEl.style.objectFit = 'cover';
        imgEl.style.borderRadius = '10px';
        imgEl.style.display = 'block';
        imgEl.onerror = function() {
          if (idx < candidates.length - 1) { idx++; this.src = candidates[idx]; }
          else this.onerror = null;
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

        div.appendChild(imgEl); div.appendChild(titleP);
        if (m.artist) div.appendChild(artistP);
        if (m.genre) div.appendChild(genreP);

        div.addEventListener('click', () => {
          try { window.location.href = `./Music.html?play=${encodeURIComponent(m.raw || m.title)}`; } catch(e){}
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

      const groups = {};
      for (const item of libraryMatches) {
        const parent = item.parent || 'Books';
        if (!groups[parent]) groups[parent] = [];
        groups[parent].push(item);
      }
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
        const categoryOrigin = (window.folderOriginMap && window.folderOriginMap[category])
          ? (window.folderOriginMap[category].endsWith('/') ? window.folderOriginMap[category] : window.folderOriginMap[category] + '/') : null;

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

          const candidates = [coverPath];
          if (categoryOrigin && !/^https?:\/\//i.test(coverPath)) candidates.push(categoryOrigin + coverPath.replace(/^\.?\//, ''));
          candidates.push('./Images/placeholder.jpg');

          let idx = 0;
          img.src = candidates[0];
          img.onerror = function() {
            idx++;
            if (idx < candidates.length) this.src = candidates[idx];
            else this.onerror = null;
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

          div.appendChild(img); div.appendChild(titleP); div.appendChild(parentP);
          div.onclick = () => {
            const lib = item.lib || 'books';
            window.location.href = `./reader.html?lib=${encodeURIComponent(lib)}&Book=${encodeURIComponent(item.title)}`;
          };
          grid.appendChild(div);
        }
        section.appendChild(grid);
      }
      container.appendChild(section);
      if (typeof showHomeButton === 'function') showHomeButton();
    }

    const DEEP_ALL_TOKEN = '---';

    function debounce(fn, wait) {
      let timer;
      return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
      };
    }

    const enhancedFilterTiles = debounce(async function() {
      if (!document.getElementById('sendtotv-inline-style')) {
        const style = document.createElement('style');
        style.id = 'sendtotv-inline-style';
        style.textContent = `
          .send-to-tv-btn {
            position: absolute; top: 6px; right: 8px; width: 36px; height: 36px; padding: 0; margin: 0;
            border: none; background: transparent; display: flex; align-items: center; justify-content: center;
            z-index: 9999; cursor: pointer; border-radius: 0;
          }
          .send-to-tv-btn img { width: 28px; height: 28px; display: block; pointer-events: none; }
          .send-to-tv-btn:focus { outline: 2px solid rgba(255,255,255,0.9); }
        `;
        document.head.appendChild(style);
      }
      if (!document.getElementById('fav-star-focus-style')) {
        const focusStyle = document.createElement('style');
        focusStyle.id = 'fav-star-focus-style';
        focusStyle.textContent = `.tile-fav-star:focus { opacity: 1 !important; pointer-events: auto !important; }`;
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
        if (typeof loadMainFolders === 'function') loadMainFolders();
        return;
      }

      const deepAll = raw === DEEP_ALL_TOKEN;
      const mergedIndex = buildMergedIndex();
      const libraryIndex = buildLibraryIndex();
      const gamesIndex = buildGamesIndex();
      const musicIndex = buildMusicIndex();

      let mainMatches = []; let libraryMatches = []; let gameMatches = []; let musicMatches = [];

      if (deepAll) {
        mainMatches = mergedIndex; libraryMatches = libraryIndex; gameMatches = gamesIndex; musicMatches = musicIndex;
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
        } else return;
      }

      container.innerHTML = '';
      if (mainMatches.length === 0 && libraryMatches.length === 0 && gameMatches.length === 0 && musicMatches.length === 0) {
        const no = document.createElement('div');
        no.style.color = '#fff'; no.style.textAlign = 'center'; no.style.padding = '30px';
        no.innerText = `No matches for "${raw}"`;
        container.appendChild(no);
        return;
      }

      if (mainMatches.length > 0) {
        const parentMap = new Map();
        for (const item of mergedIndex) {
          if (item.parent) {
            if (!parentMap.has(item.parent)) parentMap.set(item.parent, []);
            parentMap.get(item.parent).push(item.title);
          }
        }
        const grid = document.createElement('div');
        grid.style.display = 'flex'; grid.style.flexWrap = 'wrap'; grid.style.gap = '12px'; grid.style.justifyContent = 'center';
        const episodesObj = (typeof episodes !== 'undefined') ? episodes : window.episodes;

        for (const item of mainMatches) {
          const div = document.createElement('div');
          div.className = 'folder'; div.style.width = '150px'; div.style.position = 'relative'; div.style.overflow = 'visible';

          let candidates = [];
          if (typeof window.buildImageCandidates === 'function') candidates = window.buildImageCandidates(item.title, item.parent, episodesObj);
          else candidates = [`./${item.title}/${item.title}.jpg`, './Images/placeholder.jpg'];
          
          let idx = 0;
          const img = document.createElement('img');
          img.alt = item.title; img.style.width = '150px'; img.style.height = '210px'; img.style.objectFit = 'cover'; img.style.borderRadius = '10px';
          img.src = candidates[0] || './Images/placeholder.jpg';
          img.onerror = function() {
            idx++;
            if (idx < candidates.length) this.src = candidates[idx];
            else this.onerror = null;
          };

          const titleP = document.createElement('p');
          titleP.style.fontSize = '16px'; titleP.style.fontWeight = 'bold'; titleP.style.color = '#fff'; titleP.style.margin = '10px 0 0';
          titleP.innerText = item.title;
          div.appendChild(img); div.appendChild(titleP);

          if (item.parent) {
            const parentP = document.createElement('p');
            parentP.style.fontSize = '11px'; parentP.style.margin = '2px 0 0'; parentP.style.color = '#aaa'; parentP.innerText = item.parent;
            div.appendChild(parentP);
          }

          const suppressFavoriteStar = (typeof window.isRootFavoriteSuppressedTile === 'function') ? window.isRootFavoriteSuppressedTile(item.title) : false;
          const parentLower = (item.parent || '').toLowerCase();
          const isMusicOrGame = parentLower === 'music' || parentLower === 'games';
          if (!suppressFavoriteStar && !isMusicOrGame) attachTileFavorite(div, item.title);

          const hasChildren = parentMap.has(item.title) && parentMap.get(item.title).length > 0;
          const isSpecialHandlerTile = !!(window._specialFolderHandlers && typeof window._specialFolderHandlers[item.title] === 'function');
          const isMasterTile = (typeof window.isMasterTile === 'function') ? window.isMasterTile(item.title) : false;
          const loaderExists = (typeof window[`load${item.title.replace(/\s+/g, '')}Seasons`] === 'function');
          const isRootWithSeasons = loaderExists || hasChildren;
          const showSendBtn = !isRootWithSeasons && !isSpecialHandlerTile && !isMasterTile;

          if (!showSendBtn) {
            div.tabIndex = 0; div.setAttribute('role', 'button'); div.setAttribute('aria-label', `Open ${item.title}`);
            div.addEventListener('keydown', function(ev) {
              if (ev.target.closest && ev.target.closest('.send-to-tv-btn, .tile-fav-star, button, a, input, textarea, select, [role="switch"]')) return;
              if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); div.click(); }
            });
          }

          if (showSendBtn) {
            const sendBtn = document.createElement('button');
            sendBtn.type = 'button'; sendBtn.className = 'send-to-tv-btn'; sendBtn.setAttribute('aria-label', `Send ${item.title} to TV`);
            sendBtn.tabIndex = 0;
            const sendImg = document.createElement('img');
            sendImg.alt = 'Send to TV'; sendImg.style.width = '28px'; sendImg.style.height = '28px'; sendImg.style.pointerEvents = 'none';
            const iconCandidates = ['./Images/sendtotv.png', 'Images/sendtotv.png', '/Images/sendtotv.png'];
            let tryIdx = 0;
            sendImg.src = iconCandidates[tryIdx];
            sendImg.onerror = function() {
              tryIdx++;
              if (tryIdx < iconCandidates.length) this.src = iconCandidates[tryIdx];
              else this.style.display = 'none';
            };
            sendBtn.appendChild(sendImg);
            sendBtn.addEventListener('click', async function(ev) {
              ev.stopPropagation();
              try {
                const ok = (window.SysNotify && window.SysNotify.confirm) ? await window.SysNotify.confirm(`Send "${item.title}" to TV?`, `Send to TV`) : true;
                if (!ok) return;
                currentFolder = item.title; window.currentFolder = item.title;
                if (typeof sendToTV === 'function') { const maybe = sendToTV(); if (maybe && typeof maybe.then === 'function') await maybe; }
                const inputEl = document.getElementById('searchInput');
                if (inputEl) { inputEl.value = ''; try { window.filterTiles(); } catch(e) {} }
                setTimeout(() => { try { if (typeof returnToHome === 'function') returnToHome(); else if (typeof loadMainFolders === 'function') loadMainFolders(); } catch(e) {} }, 120);
                setTimeout(() => {
                  try {
                    const container = document.getElementById('folderContainer');
                    if (!container) return;
                    let target = Array.from(container.querySelectorAll('.folder')).find(t => {
                      const p = t.querySelector('p'); return p && p.innerText && p.innerText.trim() === 'Continue Watching';
                    }) || Array.from(container.querySelectorAll('.folder')).find(t => t.offsetParent !== null);
                    if (target) {
                      target.setAttribute('tabindex', '0'); try { target.focus(); } catch(e){}
                      const cleanup = () => { try { target.removeAttribute('tabindex'); } catch(e){} target.removeEventListener('blur', cleanup); };
                      target.addEventListener('blur', cleanup);
                    }
                  } catch (e) {}
                }, 250);
              } catch (e) { console.error('send-to-tv click error', e); }
            });
            sendBtn.addEventListener('keydown', function(ev) {
              if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); sendBtn.click(); }
            });
            div.appendChild(sendBtn);
          }

          div.onclick = () => {
            window._searchNavigateInProgress = true;
            const input = document.getElementById('searchInput');
            if (input) { input.value = ''; input.blur(); }
            try {
              if (typeof window.openFolderByName === 'function') window.openFolderByName(item.title);
              else if (typeof loadEpisodes === 'function') loadEpisodes(item.title);
            } catch(e) { console.warn('Navigation error:', e); }
            setTimeout(() => { window._searchNavigateInProgress = false; }, 500);
          };
          grid.appendChild(div);
        }
        container.appendChild(grid);
      }

      if (gameMatches.length > 0) renderGameMatches(gameMatches, raw);
      if (musicMatches.length > 0) renderMusicMatches(musicMatches, raw);
      if (libraryMatches.length > 0) renderLibraryMatches(libraryMatches, raw);
      if (typeof showHomeButton === 'function') showHomeButton();
    }, 120);

    window.filterTiles = enhancedFilterTiles;

    const inputEl = document.getElementById('searchInput');
    if (inputEl) {
      if (window.filterTiles && typeof window.filterTiles === 'function') {
        try { inputEl.removeEventListener('input', window.filterTiles); } catch (e) {}
      }
      inputEl.oninput = enhancedFilterTiles;
      try { inputEl.addEventListener('input', enhancedFilterTiles); } catch (e) {}
      console.log('[loadexpanded] Enhanced filterTiles installed.');
    }

    document.addEventListener('click', function(ev) {
      const input = document.getElementById('searchInput');
      const results = document.getElementById('folderContainer');
      if (!input || !results) return;
      const clickedInsideInput = input.contains(ev.target) || ev.target === input;
      const clickedInsideResults = results.contains(ev.target);
      if (!clickedInsideInput && !clickedInsideResults && input.value.trim().length > 0) {
        input.value = ''; window.filterTiles();
      }
    });

    (function enableDoubleTapToCloseSearch() {
      const input = () => document.getElementById('searchInput');
      const container = () => document.getElementById('folderContainer');
      if (!container() || !input()) return;
      let lastTap = 0; const DOUBLE_TAP_MS = 300;
      function isTapOnEmptySpace(eventTarget, x, y) {
        let el = null;
        try { if (typeof x === 'number' && typeof y === 'number') el = document.elementFromPoint(x, y); } catch (e) { el = null; }
        el = el || eventTarget;
        if (!el) return true;
        if (el.closest && el.closest('.folder')) return false;
        if (el === input()) return false;
        if (el.closest && el.closest('.qr-buttons-container')) return false;
        return true;
      }
      container().addEventListener('touchend', function(e) {
        if (!e.changedTouches || e.changedTouches.length === 0) return;
        const t = e.changedTouches[0]; const now = Date.now();
        if (!isTapOnEmptySpace(e.target, t.clientX, t.clientY)) { lastTap = now; return; }
        if (now - lastTap <= DOUBLE_TAP_MS) {
          const s = input();
          if (s && s.value.trim().length > 0) { s.value = ''; try { window.filterTiles(); } catch(_) {} s.blur(); }
          lastTap = 0; e.preventDefault && e.preventDefault();
        } else lastTap = now;
      }, { passive: true });
      container().addEventListener('dblclick', function(e) {
        if (!isTapOnEmptySpace(e.target)) return;
        const s = input();
        if (s && s.value.trim().length > 0) { s.value = ''; try { window.filterTiles(); } catch(_) {} s.blur(); }
      });
    })();

    // ================================================================
    // 2. OPTIONAL: Merge remote server if expandedstorage.txt exists
    // ================================================================
    
    // Core structural functions safely moved out of inner loops
    function addFolderOrigin(folder, baseUrl) {
      if (!window.folderOriginMap) window.folderOriginMap = {};
      if (!window.folderOriginMap[folder]) window.folderOriginMap[folder] = baseUrl;
    }
    function extractFoldersFromJs(text) {
      const arrMatch = /(?:const|let|var)?\s*folders\s*=\s*\[([\s\S]*?)\]/m.exec(text);
      if (!arrMatch) return { names: [], adultSet: new Set() };
      let content = arrMatch[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/.*$/gm, '');
      const re = /(['"])(.*?)\1/g;
      const names = []; const adultSet = new Set(); let m;
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
    function prependBaseToPaths(obj, baseUrl) {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(item => prependBaseToPaths(item, baseUrl));
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) result[key] = baseUrl + '/' + value.replace(/^(\.\/|\.\.\/|\/)/, '');
          else if (value.startsWith('http://') || value.startsWith('https://')) result[key] = value;
          else result[key] = value;
        } else if (typeof value === 'object' && value !== null) result[key] = prependBaseToPaths(value, baseUrl);
        else result[key] = value;
      }
      return result;
    }
    function extractEpisodesFromLibraryJs(text) {
      try { return new Function(`"use strict"; ${text}; return episodes;`)(); } catch (e) { return null; }
    }
    function extractGamesFromJs(text) {
      try { const r = new Function(`"use strict"; ${text}; return typeof games !== 'undefined' ? games : null;`)(); return Array.isArray(r) ? r : null; } catch (e) { return null; }
    }
    function extractMusicFromJs(text) {
      try { return new Function(`"use strict"; ${text}; return { musicLibrary: typeof musicLibrary !== 'undefined' ? musicLibrary : null, musicLibraryGenreMap: typeof musicLibraryGenreMap !== 'undefined' ? musicLibraryGenreMap : null };`)(); } catch (e) { return null; }
    }
    
    // Sort logic
    const MAIN_FOLDER_PINNED_TOP = ["Continue Watching", "Games", "Music", "Books", "Manga", "Animated Movies", "Movies", "Favorites"];
    const MAIN_FOLDER_PINNED_BOTTOM = ["Beanstalk Videos"];
    function normalizeLookupKey(value) { return String(value || '').replace(/\s+/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
    function compareMainFolderTitles(a, b) {
      const aTitle = String(a || '').trim(); const bTitle = String(b || '').trim();
      const aTop = MAIN_FOLDER_PINNED_TOP.indexOf(aTitle); const bTop = MAIN_FOLDER_PINNED_TOP.indexOf(bTitle);
      if (aTop !== -1 || bTop !== -1) {
        if (aTop === -1) return 1; if (bTop === -1) return -1;
        return aTop - bTop;
      }
      const aBottom = MAIN_FOLDER_PINNED_BOTTOM.indexOf(aTitle); const bBottom = MAIN_FOLDER_PINNED_BOTTOM.indexOf(bTitle);
      if (aBottom !== -1 || bBottom !== -1) {
        if (aBottom === -1) return -1; if (bBottom === -1) return 1;
        return aBottom - bBottom;
      }
      const aNorm = aTitle.replace(/^The\s+/i, ''); const bNorm = bTitle.replace(/^The\s+/i, '');
      const aKey = normalizeLookupKey(aNorm); const bKey = normalizeLookupKey(bNorm);
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
        if (!existing) { merged.set(key, { title: hasStar ? title : base, hasStar }); return; }
        if (hasStar && !existing.hasStar) merged.set(key, { title, hasStar: true });
      }
      (Array.isArray(currentTitles) ? currentTitles : []).forEach(upsert);
      (Array.isArray(incomingTitles) ? incomingTitles : []).forEach(upsert);
      return Array.from(merged.values()).map(entry => entry.title).sort(compareMainFolderTitles);
    }
    function normalizeSeasonsArray(arr) {
      if (!Array.isArray(arr)) return arr;
      const kidsMode = (typeof window.isKidsModeActive === 'function') ? window.isKidsModeActive() : false;
      if (!kidsMode) return arr;
      return arr.filter(item => typeof item === 'string' && !item.includes('*'));
    }

    // ================================================================
    // NEW: Priority-based merge for non-video categories
    // ================================================================
    // Gather all sources
    const sourcesList = await getPrioritizedSources();

    // Prepare datasets for each category
    const musicDatasets = [];
    const gamesDatasets = [];
    const booksDatasets = [];

    // Also collect available sources for UI filter
    const availableSources = [];

    for (const src of sourcesList) {
      availableSources.push({ id: src.id, label: src.label, origin: src.origin });

      // Helper to fetch a JS file and extract the variable
      async function fetchJsArray(url, varName) {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) return null;
          const text = await res.text();
          const fn = new Function(`"use strict"; ${text}; return typeof ${varName} !== 'undefined' ? ${varName} : null;`);
          return fn();
        } catch (e) {
          console.warn(`[loadexpanded] Could not fetch ${url}`, e);
          return null;
        }
      }

      let base = src.origin;
      if (!base.endsWith('/')) base += '/';

      // Fetch music
      const musicData = await fetchJsArray(base + 'musiclibrary.js', 'musicLibrary');
      if (musicData) {
        musicDatasets.push({ source: src, data: musicData });
      }

      // Fetch games
      const gamesData = await fetchJsArray(base + 'games.js', 'games');
      if (gamesData) {
        gamesDatasets.push({ source: src, data: gamesData });
      }

      // Fetch books (multiple files)
      const bookFiles = ['books', 'manga', 'guidebooks'];
      let combinedBooks = [];
      for (const file of bookFiles) {
        const data = await fetchJsArray(base + file + '.js', file);
        if (data && Array.isArray(data)) {
          // Tag each item with its category for later splitting
          data.forEach(item => {
            if (item && typeof item === 'object') {
              item._category = file;
            }
          });
          combinedBooks = combinedBooks.concat(data);
        }
      }
      if (combinedBooks.length) {
        booksDatasets.push({ source: src, data: combinedBooks });
      }
    }

    // Merge each category using priority system
    const mergedMusic = mergeCategoryData(musicDatasets, 'music');
    const mergedGames = mergeCategoryData(gamesDatasets, 'games');
    const mergedBooks = mergeCategoryData(booksDatasets, 'books');

    // Assign to window
    if (mergedMusic.length) {
      window.musicLibrary = mergedMusic;
      console.log(`[loadexpanded] ✅ Merged musicLibrary with ${mergedMusic.length} items (priority sources).`);
    }
    if (mergedGames.length) {
      window.games = mergedGames;
      console.log(`[loadexpanded] ✅ Merged games with ${mergedGames.length} items (priority sources).`);
    }
    if (mergedBooks.length) {
      const books = mergedBooks.filter(item => item._category === 'books');
      const manga = mergedBooks.filter(item => item._category === 'manga');
      const guidebooks = mergedBooks.filter(item => item._category === 'guidebooks');
      if (books.length) window.books = books;
      if (manga.length) window.manga = manga;
      if (guidebooks.length) window.guidebooks = guidebooks;
      console.log(`[loadexpanded] ✅ Merged books with ${books.length}, manga ${manga.length}, guidebooks ${guidebooks.length} (priority sources).`);
    }

    // Store available sources for UI filter (used in manage.html and index.html)
    window.__availableSources = availableSources;
    window.__sourceList = availableSources; // Also set for renderLeaf in manage.html

    // ================================================================
    // Continue with existing video merge (unchanged)
    // ================================================================

    try {
      console.log('[loadexpanded] Looking for expandedstorage.txt...');
      const portRes = await fetch('./expandedstorage.txt', { cache: 'no-store' });
      if (!portRes.ok) {
        console.warn('[loadexpanded] expandedstorage.txt not found, skipping remote merge.');
        resolve(); return;
      }
      
      const rawText = await portRes.text();
      const ports = rawText.split(/[\s,;|]+/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));

      if (ports.length === 0) {
        console.warn('[loadexpanded] expandedstorage.txt has no valid ports, skipping remote merge.');
        resolve(); return;
      }

      if (!window.__remoteEpisodes) window.__remoteEpisodes = {};
      if (!window.__remoteFoldersSet) window.__remoteFoldersSet = new Set();
      if (!window.expandedImageOrigins) window.expandedImageOrigins = [];
      if (typeof folders === 'undefined' || !Array.isArray(folders)) window.folders = [];

      const fetchPromises = ports.map(async (portString) => {
        let baseUrl = portString;
        if (!portString.startsWith('http://') && !portString.startsWith('https://')) {
          baseUrl = `${window.location.protocol}//${window.location.hostname}:${portString}`;
        }
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

        console.log(`[loadexpanded] Fetching remote data concurrently from ${baseUrl}...`);
        const data = { baseUrl, valid: false };
        try {
           const [mf, lib, lsf, gm, mus] = await Promise.allSettled([
             fetch(`${baseUrl}/mainfolders.js`, { cache: 'no-store' }),
             fetch(`${baseUrl}/library.js`, { cache: 'no-store' }),
             fetch(`${baseUrl}/loadseasonfunctions.js`, { cache: 'no-store' }),
             fetch(`${baseUrl}/games.js`, { cache: 'no-store' }),
             fetch(`${baseUrl}/musiclibrary.js`, { cache: 'no-store' })
           ]);
           
           if (mf.status === 'fulfilled' && mf.value.ok) data.mfText = await mf.value.text();
           if (lib.status === 'fulfilled' && lib.value.ok) data.libText = await lib.value.text();
           if (lsf.status === 'fulfilled' && lsf.value.ok) data.lsfText = await lsf.value.text();
           if (gm.status === 'fulfilled' && gm.value.ok) data.gmText = await gm.value.text();
           if (mus.status === 'fulfilled' && mus.value.ok) data.musText = await mus.value.text();
           
           data.valid = true;
        } catch(e) {
           console.warn(`[loadexpanded] Network error connecting to ${baseUrl}:`, e);
        }
        return data;
      });

      const portResults = await Promise.all(fetchPromises);

      for (const res of portResults) {
        if (!res.valid) continue;
        const { baseUrl, mfText, libText, lsfText, gmText, musText } = res;
        
        // 1. Merge mainfolders
        if (mfText) {
          const parsed = extractFoldersFromJs(mfText);
          const remoteFolders = parsed.names;
          const remoteAdultSet = parsed.adultSet;
          const localFolders = folders.slice();
          const merged = mergeMainFolderTitlesPreferAdult(localFolders, remoteFolders);
          
          folders.length = 0;
          folders.push(...merged);
          
          remoteFolders.forEach(f => {
              addFolderOrigin(f, baseUrl);
              window.__remoteFoldersSet.add(f);
          });
          
          if (typeof window.isKidsModeActive === 'function' && window.isKidsModeActive()) {
            const allAdult = new Set(window.__adultFolderNames || []);
            for (const name of remoteAdultSet) allAdult.add(name);
            for (let i = folders.length - 1; i >= 0; i--) {
              if (allAdult.has(folders[i])) folders.splice(i, 1);
            }
            window.__adultFolderNames = Array.from(allAdult);
          }
        }
        
        // 2. Merge library (episodes and books/manga)
        if (libText) {
          const remoteEpisodes = extractEpisodesFromLibraryJs(libText);
          if (remoteEpisodes) {
            const transformed = prependBaseToPaths(remoteEpisodes, baseUrl);
            Object.assign(window.__remoteEpisodes, transformed);

            const adultSet = new Set(window.__adultFolderNames || []);
            const filteredEpisodes = {};
            for (const key in transformed) {
              if (adultSet.has(key)) continue;
              const seasons = transformed[key];
              if (Array.isArray(seasons)) {
                const filtered = normalizeSeasonsArray(seasons);
                if (filtered.length > 0) filteredEpisodes[key] = filtered;
              } else filteredEpisodes[key] = seasons;
            }

            let targetEpisodes;
            try { targetEpisodes = eval('episodes'); } catch (e) { targetEpisodes = window.episodes; }
            if (typeof targetEpisodes === 'object' && targetEpisodes !== null) {
              for (const key in filteredEpisodes) {
                if (!(key in targetEpisodes)) {
                  targetEpisodes[key] = filteredEpisodes[key];
                  addFolderOrigin(key, baseUrl);
                }
              }
            } else {
              if (!window.episodes) window.episodes = {};
              for (const key in filteredEpisodes) {
                if (!(key in window.episodes)) {
                  window.episodes[key] = filteredEpisodes[key];
                  addFolderOrigin(key, baseUrl);
                }
              }
            }

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
                  } else if (Array.isArray(window[g]) && Array.isArray(transformed2)) {
                    for (const item of transformed2) {
                      const exists = window[g].some(local => (item.title && local.title === item.title) || local === item);
                      if (!exists) window[g].push(item);
                    }
                  }
                }
              }
            } catch (e) {}
          }
        }
        
        // 3. Merge loadseasonfunctions
        if (lsfText) {
           const script = document.createElement('script');
           script.textContent = lsfText;
           document.head.appendChild(script);
           script.remove();
        }
        
        // 4. Merge games (skip – already handled by priority merge)
        // 5. Merge music (skip – already handled by priority merge)
        // We keep the old blocks commented to avoid duplication.
        // if (gmText) { ... } // skipped
        // if (musText) { ... } // skipped

        if (!window.expandedImageOrigins.includes(baseUrl)) {
          window.expandedImageOrigins.push(baseUrl);
        }
      } 
      
      const originalLoadEpisodes = window.loadEpisodes;
      if (typeof originalLoadEpisodes === 'function') {
        window.loadEpisodes = async function(folderName) {
          const cleanFolder = collapseTrailingAdultMarks(folderName);
          let targetEpisodes;
          try { targetEpisodes = eval('episodes'); } catch (e) { targetEpisodes = window.episodes; }
          if (targetEpisodes && typeof targetEpisodes === 'object') {
            if (!(cleanFolder in targetEpisodes) || (Array.isArray(targetEpisodes[cleanFolder]) && targetEpisodes[cleanFolder].length === 0)) {
              const remoteEntry = window.__remoteEpisodes && window.__remoteEpisodes[cleanFolder];
              if (remoteEntry && Array.isArray(remoteEntry) && remoteEntry.length > 0) {
                targetEpisodes[cleanFolder] = remoteEntry;
                const origin = window.folderOriginMap && window.folderOriginMap[cleanFolder];
                if (origin) addFolderOrigin(cleanFolder, origin);
              }
            }
          }
          return originalLoadEpisodes.call(this, cleanFolder);
        };
      }

      console.log('[loadexpanded] Remote merge completed (video & folders).');
      
      setTimeout(() => {
        const searchEl = document.getElementById('searchInput');
        if (searchEl && searchEl.value.trim().length > 0) {
          if (typeof window.filterTiles === 'function') window.filterTiles();
        } else if (!window.currentFolder) {
          if (typeof window.loadMainFolders === 'function') window.loadMainFolders();
        }
      }, 50);

    } catch (e) {
      console.error('[loadexpanded] Remote merge failed:', e);
    }

    resolve();
  });
})();