self.addEventListener('message', (event) => {
  const msg = event?.data || {};
  if (!msg || !msg.type) return;
  if (msg.type === 'sfa-remux-placeholder') {
    self.postMessage({
      id: msg.id ?? null,
      type: 'sfa-remux-result-error',
      error: 'Placeholder generation is disabled in this build.'
    });
  }
});
