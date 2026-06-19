/* Media Server Games Catalog */
(function () {
  if (typeof folders !== 'undefined' && Array.isArray(folders) && !folders.includes('Games')) {
    folders.push('Games');
  }

  const games = [
  ];

  if (typeof window !== 'undefined') window.games = games;
})();
