
(function () {
  // config
  const INACTIVITY_MS = 15000; // 15s before slideshow when idle
  const SLIDE_MS = 10500;       // time per slide
  const FADE_MS = 800;
  const AlbumsRoot = '/Albums/'; // matches albums.html
  const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|heic)$/i;
  const PROFILE_KEYS = ['activeProfile','chosenProfile','selectedProfile','profile','activeProfileName'];

  // state
  let inactivityTimer = null;
  let slideTimer = null;
  let playingSlideshow = false;
  let images = [];
  let idx = -1;
  let lastActivity = Date.now();

  // overlay / two image slots
  let overlay = document.getElementById('tvdAlbumScreensaver');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tvdAlbumScreensaver';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: 99990, display: 'none',
      alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.95)',
      backdropFilter: 'blur(4px)', cursor: 'default', overflow: 'hidden'
    });
    overlay.innerHTML = `
      <div id="tvdScrInner" style="width:100%;height:100%;display:block;position:relative;overflow:hidden;">
        <img id="tvdScrA" style="position:absolute; top:0; left:0; height:100%; width:100%; object-fit:contain; opacity:0; transition:opacity ${FADE_MS}ms ease;">
        <img id="tvdScrB" style="position:absolute; top:0; right:0; height:100%; width:100%; object-fit:contain; opacity:0; transition:opacity ${FADE_MS}ms ease;">
        <div id="tvdScrCaption" style="position:absolute; left:20px; bottom:24px; color:rgba(255,255,255,0.0); font-weight:600;"></div>
      </div>`;
    document.body.appendChild(overlay);
  }

  const imgA = document.getElementById('tvdScrA');
  const imgB = document.getElementById('tvdScrB');
  const caption = document.getElementById('tvdScrCaption');

  // helpers
  function getStoredProfile() {
    for (const k of PROFILE_KEYS) {
      try { const v = localStorage.getItem(k); if (v) return v; } catch (e) {}
    }
    return 'Guest';
  }
  function basenameFromPath(p) { if (!p) return ''; const parts = p.split('/').filter(Boolean); return parts[parts.length-1] || p; }

  async function listImagesForProfile(profile) {
    const dir = `${AlbumsRoot}${encodeURIComponent(profile)}/`;
    try {
      const r = await fetch(dir, { cache: 'no-store' });
      if (r && r.ok) {
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const anchors = Array.from(doc.querySelectorAll('a[href]')).map(a => a.getAttribute('href') || '');
        const resolved = anchors.map(h => {
          try { return new URL(h, location.origin + dir).href; } catch(e) { return (dir + h); }
        }).filter(Boolean).map(s=>s.split('#')[0].split('?')[0]);
        const imgs = resolved.filter(u => IMAGE_RE.test(basenameFromPath(u)));
        if (imgs.length) return imgs;
      }
    } catch (e) { /* ignore and fallback */ }

    try {
      const candidateNames = [
        `${profile}-albums.json`,
        `${profile}-album-unsorted.json`,
        `${profile}-album-default.json`
      ];
      for (const name of candidateNames) {
        try {
          const r2 = await fetch(`./Profiles/${name}?t=${Date.now()}`, { cache: 'no-store' });
          if (r2 && r2.ok) {
            const arr = await r2.json();
            if (Array.isArray(arr) && arr.length) {
              return arr.map(n => `${AlbumsRoot}${profile}/${n}`);
            }
          }
        } catch(e){ /* ignore */ }
      }
    } catch (e) {}

    return [];
  }

  // prefetch and decode with returned Image element (natural sizes available)
  async function prefetchImageElement(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('img load fail: ' + url));
      im.src = url;
    });
  }

  function fillsViewportFromNatural(nw, nh) {
    if (!nw || !nh) return false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / nw, vh / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    // treat as filling if it would cover most of viewport
    return (dw >= vw * 0.85 && dh >= vh * 0.85);
  }

  function resetSlotStyles() {
    // normalize both slots to default single-image layout
    [imgA, imgB].forEach(el => {
      el.style.transition = `opacity ${FADE_MS}ms ease`;
      el.style.top = '0';
      el.style.height = '100%';
      el.style.objectFit = 'contain';
      el.style.left = '0';
      el.style.right = 'auto';
      el.style.width = '100%';
      el.style.opacity = '0';
    });
  }

  function hideOverlay() {
    if (!playingSlideshow) return;
    playingSlideshow = false;
    overlay.style.display = 'none';
    clearTimeout(slideTimer);
    slideTimer = null;
    idx = -1;
    imgA.src = imgB.src = '';
    imgA.style.opacity = imgB.style.opacity = '0';
  }

  // Atomic advance: decide pairing, preload all needed, then set layout + fade
  async function advance() {
    if (!playingSlideshow || !images.length) { hideOverlay(); return; }

    // choose next primary index
    idx = (idx + 1) % images.length;
    const primarySrc = images[idx];
    let secondarySrc = null;

    // preload primary to read natural dimensions
    let primaryImgEl;
    try {
      primaryImgEl = await prefetchImageElement(primarySrc);
    } catch (e) {
      console.warn('screensaver: primary preload failed', primarySrc, e);
      // skip this and go to next
      slideTimer = setTimeout(advance, SLIDE_MS);
      return;
    }

    const primaryFills = fillsViewportFromNatural(primaryImgEl.naturalWidth, primaryImgEl.naturalHeight);

    if (!primaryFills && images.length > 1) {
      // choose a secondary candidate (prefer next in list)
      const candidateIdx = (idx + 1) % images.length;
      secondarySrc = images[candidateIdx];
    }

    // preload any secondary
    let secondaryImgEl = null;
    if (secondarySrc) {
      try {
        secondaryImgEl = await prefetchImageElement(secondarySrc);
      } catch (e) {
        // fallback: if secondary fails, show primary alone
        console.warn('screensaver: secondary preload failed', secondarySrc, e);
        secondarySrc = null;
      }
    }

    // Now that all needed images are preloaded, set layout and swap sources atomically.
    // We'll use imgA as "left slot" and imgB as "right slot" when pairing.
    // We'll fade both in together so no element changes while visible.

    // prepare slots
    resetSlotStyles();

    if (secondarySrc) {
      // Pair: left = primary, right = secondary
      imgA.style.left = '0';
      imgA.style.right = 'auto';
      imgA.style.width = '50%';

      imgB.style.right = '0';
      imgB.style.left = 'auto';
      imgB.style.width = '50%';

      // place new images while invisible
      imgA.style.opacity = '0';
      imgB.style.opacity = '0';
      imgA.src = primarySrc;
      imgB.src = secondarySrc;

      // set caption hidden (we removed text earlier); kept but invisible
      caption.textContent = '';

      // fade both in together
      // use RAF to ensure the browser notices the new src/styles before transition
      requestAnimationFrame(() => {
        // small delay to allow image decode & style application
        requestAnimationFrame(() => {
          imgA.style.opacity = '1';
          imgB.style.opacity = '1';
        });
      });

      // advance idx an extra step so we don't immediately repeat the secondary as primary
      // (this makes the pair atomic: primary+secondary are consumed together)
      idx = (idx + 1) % images.length;
    } else {
      // Single fullscreen image
      imgA.style.left = '0';
      imgA.style.right = '0';
      imgA.style.width = '100%';

      imgB.style.opacity = '0'; // ensure other slot hidden
      // set primary into left slot (A)
      imgA.style.opacity = '0';
      imgA.src = primarySrc;
      caption.textContent = '';

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          imgA.style.opacity = '1';
        });
      });
    }

    // schedule next
    slideTimer = setTimeout(advance, SLIDE_MS);
  }

  async function startSlideshowIfAppropriate() {
    if (playingSlideshow) return;
    const vid = (window.vid || document.querySelector('video'));
    const noMediaPlaying = !vid || vid.paused || vid.ended || !vid.currentSrc || vid.readyState === 0;
    if (!noMediaPlaying) return;

    const profile = getStoredProfile();
    const fetched = await listImagesForProfile(profile);
    if (!fetched || !fetched.length) return;

    // randomize once per start
    images = fetched.slice();
    for (let i = images.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [images[i], images[j]] = [images[j], images[i]];
    }

    // start
    playingSlideshow = true;
    idx = -1;
    overlay.style.display = 'flex';
    // ensure both slots are reset
    resetSlotStyles();

    // preload first slide proactively: advance() will do the decode logic, so call it once
    slideTimer = setTimeout(advance, 60);
  }

  // user activity handlers (stop slideshow)
  function onUserActivity(e) {
    lastActivity = Date.now();
    if (playingSlideshow) {
      hideOverlay();
    }
    resetInactivityTimer();
  }
  function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(async () => {
      const vid = (window.vid || document.querySelector('video'));
      const noMediaPlaying = !vid || vid.paused || vid.ended || !vid.currentSrc || vid.readyState === 0;
      if (noMediaPlaying) await startSlideshowIfAppropriate();
    }, INACTIVITY_MS);
  }

  function onPlaybackStart() {
    if (playingSlideshow) hideOverlay();
    resetInactivityTimer();
  }

  // Treat pointer, touch, scroll, and focus movement as activity.
  // This covers mouse, phones/tablets, and remote/controller navigation.
  const activityEvents = [
    'mousemove',
    'mousedown',
    'pointermove',
    'pointerdown',
    'click',
    'keydown',
    'wheel',
    'touchstart',
    'touchmove',
    'touchend'
  ];

  activityEvents.forEach(ev => {
    window.addEventListener(ev, onUserActivity, { passive: true });
  });

  // Scroll can happen without touchmove (and keyboard/page buttons can scroll too).
  window.addEventListener('scroll', onUserActivity, { passive: true });
  document.addEventListener('scroll', onUserActivity, { passive: true, capture: true });

  // Remote/controller navigation often moves focus without generating pointer events.
  document.addEventListener('focusin', onUserActivity, { passive: true, capture: true });

  function wireVideoEvents() {
    const vid = (window.vid || document.querySelector('video'));
    if (!vid) return;
    vid.addEventListener('play', onPlaybackStart, { passive: true });
    vid.addEventListener('playing', onPlaybackStart, { passive: true });
    vid.addEventListener('pause', () => { resetInactivityTimer(); }, { passive: true });
    vid.addEventListener('ended', () => { resetInactivityTimer(); }, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', () => { wireVideoEvents(); resetInactivityTimer(); });
  try { wireVideoEvents(); resetInactivityTimer(); } catch(e){}

  const mo = new MutationObserver(() => { if (document.querySelector('video')) wireVideoEvents(); });
  mo.observe(document.body, { childList: true, subtree: true });

  // debug / control surface
  window._tvdScreensaver = {
    start: startSlideshowIfAppropriate,
    stop: hideOverlay,
    isRunning: () => playingSlideshow,
    resetTimer: resetInactivityTimer
  };
})();
