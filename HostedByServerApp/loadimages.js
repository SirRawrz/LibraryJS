// loadimages.js – Unified image path inference for LibraryJS

// Map folder names to their home server origin (set by loadexpanded / loadlocalexpanded)
window.folderOriginMap = window.folderOriginMap || {};

function assetVariantsForName(name) {
  const base = String(name || '').trim();
  if (!base) return [];
  const noApos = base.replace(/[’']/g, '');
  const noSpace = base.replace(/\s+/g, '');
  const noAposNoSpace = noApos.replace(/\s+/g, '');
  return [...new Set([base, noApos, noSpace, noAposNoSpace].filter(Boolean))];
}

function buildImageCandidates(folderName, parentSeries = null, episodes = null, extensions = ['.jpg', '.png', '.webp']) {
  const candidates = [];
  const pushIf = (url) => { if (url && !candidates.includes(url)) candidates.push(url); };

  const folderVariants = assetVariantsForName(folderName);
  const parentVariants = parentSeries ? assetVariantsForName(parentSeries) : [];

  // ---- 1. Derive from episode file path (local relative) ----
  if (episodes && typeof episodes === 'object') {
    let episodeList = episodes[folderName];
    if (!episodeList && parentSeries && episodes[parentSeries]) {
      const seasonNames = episodes[parentSeries];
      if (Array.isArray(seasonNames) && seasonNames.includes(folderName)) {
        episodeList = episodes[folderName];
      }
    }
    if (Array.isArray(episodeList) && episodeList.length > 0) {
      for (const ep of episodeList) {
        if (ep && (ep.file || ep.img || ep.image)) {
          let filePath = ep.file || ep.img || ep.image;
          if (filePath) {
            const dir = filePath.split('/').slice(0, -1).join('/');
            if (dir) {
              for (const v of folderVariants) {
                for (const ext of extensions) {
                  pushIf(`${dir}/${v}${ext}`);
                }
                const noSpace = v.replace(/\s+/g, '');
                if (noSpace !== v) {
                  for (const ext of extensions) {
                    pushIf(`${dir}/${noSpace}${ext}`);
                  }
                }
              }
            }
          }
          break;
        }
      }
    }
  }

  // ---- 2. Try parent/season folder patterns (local) ----
  if (parentVariants.length) {
    for (const p of parentVariants) {
      for (const s of folderVariants) {
        for (const ext of extensions) {
          pushIf(`./${p}/${s}/${s}${ext}`);
          const noSpaceS = s.replace(/\s+/g, '');
          if (noSpaceS !== s) pushIf(`./${p}/${s}/${noSpaceS}${ext}`);
        }
      }
    }
  }

  // ---- 3. Try folder-only patterns (local) ----
  for (const s of folderVariants) {
    for (const ext of extensions) {
      pushIf(`./${s}/${s}${ext}`);
      pushIf(`./${s}${ext}`);
      pushIf(`./Movies/${s}${ext}`);
    }
  }

  // ---- 4. If this folder has a known home server origin, add candidates from there ----
  const folderOrigin = window.folderOriginMap && window.folderOriginMap[folderName];
  if (folderOrigin) {
    // Episode-derived paths on the folder's own server
    if (episodes && typeof episodes === 'object') {
      let episodeList = episodes[folderName];
      if (!episodeList && parentSeries && episodes[parentSeries]) {
        const seasonNames = episodes[parentSeries];
        if (Array.isArray(seasonNames) && seasonNames.includes(folderName)) {
          episodeList = episodes[folderName];
        }
      }
      if (Array.isArray(episodeList) && episodeList.length > 0) {
        for (const ep of episodeList) {
          if (ep && (ep.file || ep.img || ep.image)) {
            const filePath = ep.file || ep.img || ep.image;
            try {
              const url = new URL(filePath, folderOrigin);
              const dir = url.pathname.split('/').slice(0, -1).join('/');
              for (const v of folderVariants) {
                for (const ext of extensions) {
                  pushIf(`${folderOrigin}${dir}/${v}${ext}`);
                }
                const noSpace = v.replace(/\s+/g, '');
                if (noSpace !== v) {
                  for (const ext of extensions) {
                    pushIf(`${folderOrigin}${dir}/${noSpace}${ext}`);
                  }
                }
              }
            } catch (e) {}
            break;
          }
        }
      }
    }

    // Parent/Season layouts on the folder's own server
    if (parentVariants.length) {
      for (const p of parentVariants) {
        for (const s of folderVariants) {
          for (const ext of extensions) {
            pushIf(`${folderOrigin}/${p}/${s}/${s}${ext}`);
            const noSpace = s.replace(/\s+/g, '');
            if (noSpace !== s) {
              pushIf(`${folderOrigin}/${p}/${s}/${noSpace}${ext}`);
            }
          }
        }
      }
    }

    // Standalone layouts on the folder's own server
    for (const s of folderVariants) {
      for (const ext of extensions) {
        pushIf(`${folderOrigin}/${s}/${s}${ext}`);
        pushIf(`${folderOrigin}/${s}${ext}`);
        pushIf(`${folderOrigin}/Movies/${s}${ext}`);
      }
    }
  }
  // ---- Note: We no longer iterate over all expandedImageOrigins; only the folder's own origin is used.
  // This prevents cross‑server mixing. Local folders (without folderOrigin) only use local candidates.

  // ---- 5. Fallback ----
  pushIf('./Images/default.jpg');
  pushIf('./Images/placeholder.jpg');

  return candidates;
}

window.assetVariantsForName = assetVariantsForName;
window.buildImageCandidates = buildImageCandidates;