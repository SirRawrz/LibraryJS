// loadmainfolders.js
function loadMainFolders() {
  showProfilesButton();
  folderContainer.innerHTML = "";
  folderContainer.style.display = 'flex';

  const centerTitle = document.querySelector(".center-title");
  if (centerTitle) centerTitle.style.display = "flex";

  const qrButtons = document.querySelector(".qr-buttons-container");
  if (qrButtons) qrButtons.style.display = "flex";

  // --- initialize episodes (same as before) ---
  const safeGetNestedContentForFolder = (typeof window.getNestedContentForFolder === 'function')
    ? window.getNestedContentForFolder
    : function(folderName) {
        if (!folderName) return null;
        if (["Continue Watching", "Games", "Music", "Books", "Manga", "Calendar", "Favorites"].includes(folderName)) {
          return null;
        }
        return (episodes && episodes[folderName]) ? episodes[folderName] : null;
      };

  folders.forEach(folder => {
    if (!episodes[folder]) {
      episodes[folder] = safeGetNestedContentForFolder(folder);
    }
  });

  // --- explicit handlers for special cases ---
  const specialHandlers = {
    "Continue Watching": () => { window.location.href = "./tvd.html"; },
    "Games": () => { displayGames(); },
    "Music": () => { window.location.href = "./Music.html"; },
    "Books": () => { window.location.href = "./Books.html"; },
    "Manga": () => { window.location.href = "./Manga.html"; },
    "Calendar": () => { window.location.href = "./Calendar.html"; },
    "Favorites": () => {
      if (typeof loadFavorites === 'function') {
        loadFavorites();
      } else {
        console.warn('Favorites handler invoked but loadFavorites() not found.');
        loadMainFolders();
      }
    }
  };
  window._specialFolderHandlers = specialHandlers;

  window._rootNonFavoriteTileSet = window._rootNonFavoriteTileSet || new Set([
    "Continue Watching",
    "Games",
    "Music",
    "Movies",
    "Animated Movies",
    "Books",
    "Manga",
    "Calendar",
    "Favorites"
  ]);

  window._masterTileSet = window._masterTileSet || new Set([
    "Continue Watching",
    "Games",
    "Music",
    "Books",
    "Manga",
    "Calendar",
    "Favorites"
  ]);

  Object.keys(specialHandlers).forEach(name => {
    window._masterTileSet.add(name);
    window._rootNonFavoriteTileSet.add(name);
  });

  window.addToMasterTileSet = function(name) {
    if (!name) return;
    window._masterTileSet = window._masterTileSet || new Set();
    window._masterTileSet.add(name);
  };

  window.removeFromMasterTileSet = function(name) {
    if (!name || !window._masterTileSet) return;
    window._masterTileSet.delete(name);
  };

  window.isMasterTile = function(name) {
    if (!name) return false;
    return !!(window._masterTileSet && window._masterTileSet.has(name));
  };

  window.isRootFavoriteSuppressedTile = function(name) {
    if (!name) return false;
    return !!(window._rootNonFavoriteTileSet && window._rootNonFavoriteTileSet.has(name));
  };

  window._tolerantKeyForMasterTiles =
    (typeof tolerantKey === 'function') ? tolerantKey : (s => {
      if (!s) return '';
      return String(s)
        .replace(/&amp;/gi, 'and')
        .replace(/&/g, 'and')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '');
    });

  // NEW: simple alphanumeric-only normalization (no HyPhEn, PeRiOd, etc.)
  function toLoaderSafeBase(str) {
    return String(str || "")
        .normalize("NFKD")                 // decompose accented characters
        .replace(/[\u0300-\u036f]/g, "")   // remove combining marks
        .replace(/&amp;/gi, " ")
        .replace(/&/g, " ")
        .replace(/[^a-zA-Z0-9]/g, "")      // drop everything else
        .trim();
  }
  window.toLoaderSafeBase = toLoaderSafeBase;

  function toAssetFolderName(str) {
    return String(str || "")
      .replace(/\*/g, "")
      .replace(/['’]/g, "")
      .trim();
  }
  function toAssetName(str) {
    return String(str || "")
      .replace(/\*/g, "")
      .replace(/['’]/g, "")
      .trim();
  }

  // ============================================================
  // NEW: Default image candidate generator (can be overridden)
  // ============================================================
  if (typeof window.getImageCandidatesForFolder !== 'function') {
    window.getImageCandidatesForFolder = function(folder) {
      const assetFolder = toAssetName(folder);
      return [
        `./${encodeURIComponent(assetFolder)}/${encodeURIComponent(assetFolder)}.jpg`,
        `./Images/${encodeURIComponent(assetFolder)}.jpg`,
        `./${encodeURIComponent(assetFolder)}.jpg`,
        `./Images/placeholder.jpg`
      ];
    };
  }

  function hasLoaderForFolder(folderName) {
    if (!folderName) return false;
    const normalizedFolder = toLoaderSafeBase(folderName);
    const suffixes = ["seasons", "season", "collectionseasons", "movies", "films", ""];
    const names = Object.getOwnPropertyNames(window);

    for (const fnName of names) {
      if (typeof window[fnName] !== "function") continue;
      const n = String(fnName)
        .replace(/&amp;/gi, "and")
        .replace(/&/g, "and")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

      for (const s of suffixes) {
        if (n === ("load" + normalizedFolder + s)) {
          return true;
        }
      }
    }
    return false;
  }
  window.hasLoaderForFolder = hasLoaderForFolder;

  function tryCallCandidates(folderName) {
    if (!folderName) return false;
    const normalizedFolder = toLoaderSafeBase(folderName);

    const suffixes = ["seasons", "season", "collectionseasons", "movies", "films", ""];
    const pascalBase = toLoaderSafeBase(folderName);

    const fallbackCandidates = [
      `load${pascalBase}Seasons`,
      `load${pascalBase}Season`,
      `load${pascalBase}`,
      `load${pascalBase}CollectionSeasons`,
      `load${pascalBase}Movies`,
      `load${pascalBase}Films`
    ];

    for (const name of fallbackCandidates) {
      if (typeof window[name] === "function") {
        console.debug(`[loadMainFolders] calling strict candidate: ${name}`);
        window[name]();
        return true;
      }
    }

    try {
      const names = Object.getOwnPropertyNames(window);
      for (const fnName of names) {
        if (typeof window[fnName] !== "function") continue;
        const n = String(fnName)
          .replace(/&amp;/gi, "and")
          .replace(/&/g, "and")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

        for (const s of suffixes) {
          if (n === ("load" + normalizedFolder + s)) {
            console.debug(`[loadMainFolders] calling normalized match: ${fnName} (for folder "${folderName}")`);
            window[fnName]();
            return true;
          }
        }
      }
    } catch (e) {
      console.warn("[loadMainFolders] normalized scan failed:", e);
    }
    console.debug(`[loadMainFolders] no loader found for folder: "${folderName}"`);
    return false;
  }

  window.openFolderByName = function(folder) {
    if (!folder) return;
    try { showHomeButton?.(); } catch(e){}
    if (window._specialFolderHandlers && typeof window._specialFolderHandlers[folder] === 'function') {
      window._specialFolderHandlers[folder]();
      return;
    }
    if (typeof tryCallCandidates === 'function') {
      const handled = tryCallCandidates(folder);
      if (handled) return;
    }
    if (typeof loadEpisodes === 'function') {
      loadEpisodes(folder);
    }
  };

  function isFavoriteableFolder(folderName) {
    if (!folderName) return false;
    try {
      if (typeof window.isRootFavoriteSuppressedTile === 'function' && window.isRootFavoriteSuppressedTile(folderName)) {
        return false;
      }
      if (episodes && episodes[folderName] && Array.isArray(episodes[folderName])) {
        return true;
      }
      if (window._specialFolderHandlers && typeof window._specialFolderHandlers[folderName] === 'function') {
        return true;
      }
      const base = toLoaderSafeBase(folderName);
      const candidates = [
        `load${base}Seasons`,
        `load${base}Season`,
        `load${base}`,
        `load${base}CollectionSeasons`,
        `load${base}Movies`,
        `load${base}Films`
      ];
      for (const n of candidates) {
        if (typeof window[n] === 'function') return true;
      }
    } catch (e) {}
    return false;
  }

  function updateStarGlyph(glyphEl, folderName) {
    if (!glyphEl) return;
    try {
      const favs = (typeof getStoredFavorites === 'function')
        ? getStoredFavorites()
        : JSON.parse(localStorage.getItem('favorites') || '[]');
      const isFav = Array.isArray(favs) && favs.indexOf(folderName) !== -1;
      glyphEl.textContent = isFav ? '★' : '☆';
      glyphEl.style.color = isFav ? '#ffcf33' : '#fff';
      const starBtn = glyphEl.parentElement;
      if (starBtn) {
        starBtn.classList.toggle('favorited', isFav);
      }
    } catch (e) {
      glyphEl.textContent = '☆';
      glyphEl.style.color = '#fff';
      const starBtn = glyphEl.parentElement;
      if (starBtn) {
        starBtn.classList.remove('favorited');
      }
    }
  }

  // --- Create tiles ---
  folders.forEach(folder => {
    const folderDiv = document.createElement("div");
    folderDiv.className = "folder";
    folderDiv.style.position = folderDiv.style.position || 'relative';
    const suppressFavoriteStar = (typeof window.isRootFavoriteSuppressedTile === 'function')
      ? window.isRootFavoriteSuppressedTile(folder)
      : false;

    // --- USE THE GLOBAL FUNCTION for image candidates ---
    const imageCandidates = window.getImageCandidatesForFolder(folder);

    const img = document.createElement("img");
    img.alt = folder;

    let imageIndex = 0;
    img.src = imageCandidates[imageIndex];

    img.onerror = function () {
      imageIndex++;
      if (imageIndex < imageCandidates.length) {
        this.src = imageCandidates[imageIndex];
      } else {
        this.onerror = null;
      }
    };

    const titleP = document.createElement("p");
    titleP.textContent = folder;

    folderDiv.appendChild(img);
    folderDiv.appendChild(titleP);

    // --- star button (unchanged) ---
    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = 'tile-fav-star';
    starBtn.setAttribute('aria-label', `Favorite ${folder}`);
    starBtn.setAttribute('title', `Favorite ${folder}`);
    starBtn.tabIndex = -1;
    starBtn.setAttribute('aria-hidden', 'true');

    const glyph = document.createElement('span');
    glyph.className = 'tile-fav-glyph';
    glyph.style.pointerEvents = 'none';
    glyph.textContent = '☆';
    starBtn.appendChild(glyph);

    starBtn.style.display = 'none';

    starBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      try {
        if (typeof toggleFavoriteByName === 'function') {
          toggleFavoriteByName(folder);
        } else {
          try {
            let favs = (typeof getStoredFavorites === 'function') ? getStoredFavorites() : (JSON.parse(localStorage.getItem('favorites')||'[]'));
            const idx = favs.indexOf(folder);
            if (idx === -1) favs.push(folder); else favs.splice(idx,1);
            try { setStoredFavorites && setStoredFavorites(favs); } catch(e){ localStorage.setItem('favorites', JSON.stringify(favs)); }
          } catch(e){}
        }
      } catch (e) {
        console.warn('toggle favorite failed', e);
      }
      updateStarGlyph(glyph, folder);
      try { if (typeof updateFavoriteButtonUI === 'function') updateFavoriteButtonUI(); } catch(e){}
    });

    folderDiv.addEventListener('pointerenter', function (ev) {
      try {
        const pType = (ev && ev.pointerType) ? String(ev.pointerType).toLowerCase() : 'mouse';
        if (suppressFavoriteStar || !isFavoriteableFolder(folder)) return;
        if (pType === 'mouse' || pType === 'pen') {
          updateStarGlyph(glyph, folder);
          starBtn.style.display = 'flex';
        }
      } catch(e){}
    }, {passive:true});

    folderDiv.addEventListener('pointerleave', function () {
      try {
        starBtn.style.display = 'none';
      } catch(e){}
    }, {passive:true});

    folderDiv.addEventListener('pointerdown', function (ev) {
      try {
        if (ev && String(ev.pointerType).toLowerCase() === 'touch') {
          if (suppressFavoriteStar || !isFavoriteableFolder(folder)) return;
          updateStarGlyph(glyph, folder);
          starBtn.style.display = 'flex';
          setTimeout(() => { try { starBtn.style.display = 'none'; } catch(e){} }, 2500);
        }
      } catch(e){}
    }, {passive:true});

    folderDiv.appendChild(starBtn);

    folderDiv.onclick = () => {
      try {
        lastFolderScroll = (window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0);
        lastViewedFolder = folder;
      } catch (e) { /* ignore */ }
      window.openFolderByName(folder);
    };

    folderContainer.appendChild(folderDiv);
  });

  try {
    if (typeof lastFolderScroll === 'number' && lastViewedFolder) {
      setTimeout(function() {
        try { window.scrollTo({ top: lastFolderScroll, behavior: 'auto' }); } catch(e) {}
      }, 20);
    }
  } catch (e) { /* ignore */ }
}