(() => {
  const FLAG = '__sfa_bridge__';
  const SOURCE = 'sfa-page-hook';
  if (window.__SFA_BRIDGE_INITIALIZED__) return;
  window.__SFA_BRIDGE_INITIALIZED__ = true;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[FLAG] !== true) return;
    chrome.runtime.sendMessage({
      type: 'PAGE_HIT',
      payload: data.payload
    }).catch?.(() => {});
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'SFA_INJECT_NOW') return;
    window.postMessage({ [FLAG]: true, payload: { kind: 'bridge-ready', source: SOURCE, pageUrl: location.href, title: document.title, ts: Date.now() } }, '*');
  });

  // Let the service worker know the frame is alive.
  chrome.runtime.sendMessage({ type: 'FRAME_READY', payload: { pageUrl: location.href, title: document.title, ts: Date.now(), visible: document.visibilityState === 'visible' } }).catch?.(() => {});
})();
