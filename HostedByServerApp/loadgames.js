/* LibraryJS games runtime helpers
   Shared by index.html and any pages that render the Games library.
*/

(function () {
  if (window.__libraryjsLoadGamesReady) return;
  window.__libraryjsLoadGamesReady = true;

  function resolveGameReferralLink(rawLink) {
    const link = String(rawLink || '').trim();
    if (!link) return '';
    if (!/^https?:\/\//i.test(link)) return link;
    try {
      const target = new URL(link, window.location.href);
      const current = new URL(window.location.href);
      if (target.protocol === current.protocol && target.hostname === current.hostname && target.port === current.port) {
        return target.href;
      }
      target.hostname = current.hostname;
      return target.href;
    } catch (e) {
      return link;
    }
  }

  function _gamesFavoritesKeyForProfile(profile) {
    profile = profile || (localStorage.getItem('activeProfile') || 'Guest');
    return `gamesFavorites-${profile}`;
  }

  function normalizeGameFavoriteList(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = new Set();

    for (const item of arr) {
      const name = String(item || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }

    return out;
  }

  function getStoredGameFavorites() {
    try {
      const profile = localStorage.getItem('activeProfile') || 'Guest';
      const key = _gamesFavoritesKeyForProfile(profile);
      const perRaw = localStorage.getItem(key);
      if (perRaw) return normalizeGameFavoriteList(JSON.parse(perRaw));

      const legacyRaw = localStorage.getItem('gamesFavorites');
      if (legacyRaw) {
        const normalized = normalizeGameFavoriteList(JSON.parse(legacyRaw));
        try { localStorage.setItem(key, JSON.stringify(normalized)); } catch (e) {}
        return normalized;
      }

      return [];
    } catch (e) {
      console.warn('[games favorites] getStoredGameFavorites failed', e);
      return [];
    }
  }

  function setStoredGameFavorites(arr) {
    try {
      const profile = localStorage.getItem('activeProfile') || 'Guest';
      const key = _gamesFavoritesKeyForProfile(profile);
      localStorage.setItem(key, JSON.stringify(normalizeGameFavoriteList(arr)));
    } catch (e) {
      console.warn('[games favorites] setStoredGameFavorites failed', e);
    }
  }

  async function saveGameFavoritesToServer(arr) {
    const profile = localStorage.getItem('activeProfile') || 'Guest';
    const slug = 'gamesFavorites';

    if (typeof window.savePlaylistFileToServer === 'function') {
      try {
        await window.savePlaylistFileToServer(profile, slug, arr);
        return true;
      } catch (e) {
        console.warn('[games favorites] savePlaylistFileToServer failed', e);
      }
    }

    try {
      const fileName = `${profile}-${slug}.txt`;
      const payloadText = `[[[\n${JSON.stringify(arr, null, 2)}\n]]]`;
      if (typeof pocketReplace === 'function') {
        const ok = await pocketReplace(fileName, null, payloadText).catch(() => false);
        if (ok) return true;
      }
    } catch (e) {
      console.warn('[games favorites] pocketReplace failed', e);
    }

    try {
      const nameNoExt = `${profile}-${slug}`;
      const url = `/Profiles/${encodeURIComponent(nameNoExt)}.txt`;
      const payloadText = `[[[\n${JSON.stringify(arr, null, 2)}\n]]]`;
      const maxAttempts = 3;
      const baseDelay = 250;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const r = await fetch(url + `?_=${Date.now()}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: payloadText,
            credentials: 'include'
          });
          if (r.ok) return true;
        } catch (e) {
          console.warn('[games favorites] PUT attempt error', e);
        }
        await new Promise(res => setTimeout(res, baseDelay * Math.pow(2, attempt)));
      }
    } catch (e) {
      console.warn('[games favorites] fallback failed', e);
    }

    return false;
  }

  async function loadGameFavoritesFromServer() {
    const profile = localStorage.getItem('activeProfile') || 'Guest';
    const slug = 'gamesFavorites';
    const fileName = `${profile}-${slug}.txt`;
    const perKey = _gamesFavoritesKeyForProfile(profile);

    if (typeof fetchAndParseJsonArray === 'function') {
      try {
        const arr = await fetchAndParseJsonArray(`/Profiles/${encodeURIComponent(fileName)}`);
        if (Array.isArray(arr)) {
          const normalized = normalizeGameFavoriteList(arr);
          try { localStorage.setItem(perKey, JSON.stringify(normalized)); } catch (e) {}
          return normalized;
        }
      } catch (e) {
        console.warn('[games favorites] fetchAndParseJsonArray failed', e);
      }
    }

    try {
      const r = await fetch(`/Profiles/${encodeURIComponent(fileName)}?_=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'include'
      });

      let text = null;
      if (r && r.ok) {
        text = await r.text();
      } else {
        const alt = `/Profiles/${encodeURIComponent(fileName.replace(/\.txt$/, ''))}?_=${Date.now()}`;
        const r2 = await fetch(alt, { cache: 'no-store', credentials: 'include' });
        if (r2 && r2.ok) text = await r2.text();
        else {
          try { localStorage.removeItem(perKey); } catch (e) {}
          return [];
        }
      }

      try {
        const m = text.match(/\[\[\[\s*([\s\S]*?)\s*\]\]\]/);
        const arr = (m && m[1]) ? JSON.parse(m[1]) : JSON.parse(text);
        if (Array.isArray(arr)) {
          const normalized = normalizeGameFavoriteList(arr);
          try { localStorage.setItem(perKey, JSON.stringify(normalized)); } catch (e) {}
          return normalized;
        }
        try { localStorage.removeItem(perKey); } catch (e) {}
        return [];
      } catch (e) {
        console.warn('[games favorites] parse error', e);
        try { localStorage.removeItem(perKey); } catch (e) {}
        return [];
      }
    } catch (e) {
      console.warn('[games favorites] fetch failed', e);
      try { localStorage.removeItem(perKey); } catch (e) {}
      return [];
    }
  }

  function isGameFavorited(gameName) {
    const favs = getStoredGameFavorites();
    const key = String(gameName || '').trim().toLowerCase();
    return favs.some(n => String(n).trim().toLowerCase() === key);
  }

  function toggleGameFavoriteByName(gameName) {
    const name = String(gameName || '').trim();
    if (!name) return;

    const favs = getStoredGameFavorites();
    const idx = favs.findIndex(n => String(n).trim().toLowerCase() === name.toLowerCase());
    if (idx === -1) favs.push(name);
    else favs.splice(idx, 1);

    setStoredGameFavorites(favs);
    try { saveGameFavoritesToServer(favs).catch(() => {}); } catch (e) {}
  }

  function attachGameFavoriteStar(tile, gameName) {
    if (!tile || !gameName) return;

    const starBtn = document.createElement('button');
    starBtn.className = 'tile-fav-star';
    starBtn.type = 'button';
    starBtn.title = 'Favorite';
    starBtn.tabIndex = 0;
    starBtn.setAttribute('aria-label', `Toggle favorite for ${gameName}`);

    const glyph = document.createElement('span');
    glyph.className = 'tile-fav-glyph';
    glyph.textContent = '☆';
    starBtn.appendChild(glyph);

    function refreshStarVisual() {
      const fav = isGameFavorited(gameName);
      if (fav) {
        starBtn.classList.add('favorited');
        glyph.textContent = '★';
      } else {
        starBtn.classList.remove('favorited');
        glyph.textContent = '☆';
      }
    }

    starBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleGameFavoriteByName(gameName);
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

    tile.addEventListener('keydown', function (e) {
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        toggleGameFavoriteByName(gameName);
        refreshStarVisual();
      }
    });

    tile.style.position = tile.style.position || 'relative';
    tile.appendChild(starBtn);
    refreshStarVisual();
  }

  function openGameEntry(game) {
    if (!game) return;
    if (game.specialSet === 'multidisk' && Array.isArray(game.disks)) {
      displayDisks(game);
      return;
    }
    if (game.link) window.location.href = resolveGameReferralLink(game.link);
  }

  function createGameTile(container, game, onclickFunction) {
    const gameTile = document.createElement('div');
    gameTile.classList.add('folder');
    gameTile.innerHTML = `
      <img src="${game.img}" alt="${game.name}">
      <p>${game.name}</p>
    `;

    gameTile.onclick = onclickFunction || (() => openGameEntry(game));
    attachGameFavoriteStar(gameTile, game.name);
    container.appendChild(gameTile);
  }

  function createBackTitleTile(container) {
    const backButton = document.createElement('button');
    backButton.className = 'return-button';
    backButton.innerText = 'Back to Title Selection';
    backButton.onclick = () => {
      const folderContainer = document.getElementById('folderContainer');
      if (folderContainer) folderContainer.innerHTML = '';
      if (typeof loadMainFolders === 'function') loadMainFolders();
    };
    container.appendChild(backButton);
  }

  async function displayGames() {
    const container = document.getElementById('folderContainer');
    if (!container) return;
    container.innerHTML = '';

    try { await loadGameFavoritesFromServer().catch(() => {}); } catch (e) {}

    const favNames = getStoredGameFavorites();
    const favSet = new Set(favNames.map(n => String(n).trim().toLowerCase()));
    const sourceGames = Array.isArray(window.games) ? window.games : [];
    const favoriteGames = sourceGames.filter(g => favSet.has(String(g.name || '').trim().toLowerCase()));
    const otherGames = sourceGames.filter(g => !favSet.has(String(g.name || '').trim().toLowerCase()));
    const orderedGames = [...favoriteGames, ...otherGames];

    const grid = document.createElement('div');
    grid.className = 'container';

    createBackTitleTile(grid);
    orderedGames.forEach(game => createGameTile(grid, game, () => openGameEntry(game)));

    container.appendChild(grid);
  }

  function displayDisks(gameOrName, disksOverride) {
    const game = typeof gameOrName === 'object' && gameOrName ? gameOrName : {
      baseName: String(gameOrName || ''),
      disks: Array.isArray(disksOverride) ? disksOverride : []
    };
    const disks = Array.isArray(game.disks) ? game.disks : (Array.isArray(disksOverride) ? disksOverride : []);
    const gameName = game.baseName || game.name || '';
    const container = document.getElementById('folderContainer');
    if (!container) return;
    container.innerHTML = '';

    const topBack = document.createElement('button');
    topBack.className = 'return-button';
    topBack.innerText = 'Back to Games';
    topBack.onclick = displayGames;
    container.appendChild(topBack);

    disks.forEach(disk => {
      const diskTile = document.createElement('div');
      diskTile.classList.add('folder');
      const image = disk.img || `./Images/${gameName.toLowerCase().replace(/ /g, '')}-${disk.disk}.jpg`;
      diskTile.innerHTML = `
        <img src="${image}" alt="${gameName} - Disk ${disk.disk}">
        <p>${gameName} - Disk ${disk.disk}</p>
      `;
      diskTile.onclick = () => window.location.href = resolveGameReferralLink(disk.link);
      container.appendChild(diskTile);
    });

    const backButton = document.createElement('button');
    backButton.className = 'return-button';
    backButton.innerText = 'Back to Games';
    backButton.onclick = displayGames;
    container.appendChild(backButton);
  }

  window.resolveGameReferralLink = resolveGameReferralLink;
  window.getStoredGameFavorites = getStoredGameFavorites;
  window.toggleGameFavoriteByName = toggleGameFavoriteByName;
  window.loadGameFavoritesFromServer = loadGameFavoritesFromServer;
  window.displayGames = displayGames;
  window.createGameTile = createGameTile;
  window.displayDisks = displayDisks;
  window.createBackTitleTile = createBackTitleTile;
  window.openGameEntry = openGameEntry;
  window.attachGameFavoriteStar = attachGameFavoriteStar;
  window.isGameFavorited = isGameFavorited;
  window.normalizeGameFavoriteList = normalizeGameFavoriteList;
  window.saveGameFavoritesToServer = saveGameFavoritesToServer;
})();
