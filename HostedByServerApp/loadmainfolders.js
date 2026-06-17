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
  // Add or adjust entries here when a folder needs a non-standard handler.
  /* === ADMIN EDITABLE: SPECIAL_HANDLERS START === */
  const specialHandlers = {
    // existing navigation tiles
    "Continue Watching": () => { window.location.href = "./tvd.html"; },
    "Games": () => { displayGames(); },
    "Music": () => { window.location.href = "./Music.html"; },
    "Books": () => { window.location.href = "./Books.html"; },
    "Manga": () => { window.location.href = "./Manga.html"; },
    "Calendar": () => { window.location.href = "./Calendar.html"; },

    // Favorites main folder -> uses the new loadFavorites() function (defined in index.html)
    "Favorites": () => {
      if (typeof loadFavorites === 'function') {
        loadFavorites();
      } else {
        console.warn('Favorites handler invoked but loadFavorites() not found.');
        loadMainFolders();
      }
    }
  };
  /* === ADMIN EDITABLE: SPECIAL_HANDLERS END === */

  // make special handlers available globally so search-results can reuse them
  window._specialFolderHandlers = specialHandlers;

  // Root-level navigation tiles that should not show the favorite star.
  // Keep this scoped to the main grid only so nested season tiles remain favoriteable.
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

  // Master tiles are the root navigation tiles that special handlers own.
  // This set stays separate so nested loaders do not inherit the root-only suppression.
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

  // Helper tolerantKey: reuse global one if present, otherwise use best-effort fallback
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

  // Helper: convert display string into loader-safe PascalCase with HyPhEn token for hyphens.
function toLoaderSafeBase(str) {
  return String(str || "")
    .replace(/&amp;/gi, " ")
    .replace(/&/g, " AmPeRsAnD ")
    .replace(/\./g, " PeRiOd ")
    .replace(/,/g, " CoMmA ")
    .replace(/!/g, " ExClAmAtIoN ")
    .replace(/[-–—]/g, " HyPhEn ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
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
  function hasLoaderForFolder(folderName) {
    if (!folderName) return false;

    const normalizedFolder = String(folderName || "")
      .replace(/&amp;/gi, "and")
      .replace(/&/g, "and")
      .replace(/\s*[-–—]\s*/g, " HyPhEn ")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();

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

  // Helper: try candidate function names in order
  function tryCallCandidates(folderName) {
    if (!folderName) return false;

    const normalizedFolder = String(folderName || "")
      .replace(/&amp;/gi, "and")
      .replace(/&/g, "and")
      .replace(/\s*[-–—]\s*/g, " HyPhEn ")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();

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

  // =====================================================
  // GLOBAL folder opener (used by Main + Favorites + Search)
  // =====================================================
  window.openFolderByName = function(folder) {
    if (!folder) return;

    try {
      showHomeButton?.();
    } catch(e){}

    if (window._specialFolderHandlers &&
        typeof window._specialFolderHandlers[folder] === 'function') {
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

  // Return true if the given folder should be favoriteable (no navigation side-effect)
  function isFavoriteableFolder(folderName) {
    if (!folderName) return false;

    try {
      // Root-only navigation tiles should not show the favorite star.
      if (typeof window.isRootFavoriteSuppressedTile === 'function' && window.isRootFavoriteSuppressedTile(folderName)) {
        return false;
      }

      // normal favorite detection
      if (episodes &&
          episodes[folderName] &&
          Array.isArray(episodes[folderName])) {
        return true;
      }

      if (window._specialFolderHandlers &&
          typeof window._specialFolderHandlers[folderName] === 'function') {
        return true;
      }

      const base =
        (typeof toLoaderSafeBase === 'function')
          ? toLoaderSafeBase(folderName)
          : folderName
              .replace(/[^a-zA-Z0-9]+/g,' ')
              .split(/\s+/)
              .filter(Boolean)
              .map(s => s.charAt(0).toUpperCase()+s.slice(1))
              .join('');

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

  // Update glyph (★ or ☆) using your favorites storage helpers
  function updateStarGlyph(glyphEl, folderName) {
    if (!glyphEl) return;

    try {
      const favs =
        (typeof getStoredFavorites === 'function')
          ? getStoredFavorites()
          : JSON.parse(localStorage.getItem('favorites') || '[]');

      const isFav =
        Array.isArray(favs) && favs.indexOf(folderName) !== -1;

      // star icon
      glyphEl.textContent = isFav ? '★' : '☆';
      glyphEl.style.color = isFav ? '#ffcf33' : '#fff';

      // ⭐ IMPORTANT — controls CSS visibility state
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

  // Create folder UI cards and attach handlers (enhanced: top-left favorite star on pointer hover/touch)
  folders.forEach(folder => {
    const folderDiv = document.createElement("div");
    folderDiv.className = "folder";
    // ensure we can absolutely position the star inside
    folderDiv.style.position = folderDiv.style.position || 'relative';
    const suppressFavoriteStar = (typeof window.isRootFavoriteSuppressedTile === 'function')
      ? window.isRootFavoriteSuppressedTile(folder)
      : false;
const assetFolder = toAssetName(folder);

const imageCandidates = [
  `./${encodeURIComponent(assetFolder)}/${encodeURIComponent(assetFolder)}.jpg`,
  `./Images/${encodeURIComponent(assetFolder)}.jpg`,
  `./${encodeURIComponent(assetFolder)}.jpg`,
  `./Images/placeholder.jpg`
];

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

    // --- create top-left star element (hidden by default) ---
    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = 'tile-fav-star';
    starBtn.setAttribute('aria-label', `Favorite ${folder}`);
    starBtn.setAttribute('title', `Favorite ${folder}`);
    // Important: never focusable by keyboard/remote; still clickable by pointer/touch
    starBtn.tabIndex = -1;
    starBtn.setAttribute('aria-hidden', 'true');

    const glyph = document.createElement('span');
    glyph.className = 'tile-fav-glyph';
    glyph.style.pointerEvents = 'none';
    glyph.textContent = '☆';
    starBtn.appendChild(glyph);

    // Hidden by default
    starBtn.style.display = 'none';

    // Click handler (toggle favorite)
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

    // Keep pointer-based visibility only (mouse / touchpad / touch)
    folderDiv.addEventListener('pointerenter', function (ev) {
      try {
        const pType = (ev && ev.pointerType) ? String(ev.pointerType).toLowerCase() : 'mouse';
        if (suppressFavoriteStar || !isFavoriteableFolder(folder)) return;
        // allow 'mouse' and 'pen' only — ignore 'touch' (we'll handle touch with pointerdown)
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

    // For touch devices: reveal briefly on pointerdown so the user can tap the star
    folderDiv.addEventListener('pointerdown', function (ev) {
      try {
        if (ev && String(ev.pointerType).toLowerCase() === 'touch') {
          if (suppressFavoriteStar || !isFavoriteableFolder(folder)) return;
          updateStarGlyph(glyph, folder);
          starBtn.style.display = 'flex';
          // hide after 2.5s if user doesn't interact
          setTimeout(() => { try { starBtn.style.display = 'none'; } catch(e){} }, 2500);
        }
      } catch(e){}
    }, {passive:true});

    // append star into tile
    folderDiv.appendChild(starBtn);

    // original tile click behaviour (preserve scroll state and use centralized opener)
    folderDiv.onclick = () => {
      try {
        lastFolderScroll = (window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0);
        lastViewedFolder = folder;
      } catch (e) { /* ignore */ }

      window.openFolderByName(folder);
    };

    folderContainer.appendChild(folderDiv);
  });

  // restore scroll position if available (same as original)
  try {
    if (typeof lastFolderScroll === 'number' && lastViewedFolder) {
      setTimeout(function() {
        try { window.scrollTo({ top: lastFolderScroll, behavior: 'auto' }); } catch(e) {}
      }, 20);
    }
  } catch (e) { /* ignore */ }
}