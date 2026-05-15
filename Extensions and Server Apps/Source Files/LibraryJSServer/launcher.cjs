const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function runDevServer() {
  await import('./server.mjs');
}

async function materializeSeaBundle() {
  const sea = require('node:sea');
  const manifestText = sea.getAsset('asset-manifest.json', 'utf8');
  const manifest = JSON.parse(manifestText);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'libraryjs-server-sea-'));
  for (const assetKey of manifest.assets || []) {
    const targetPath = path.join(tempRoot, assetKey);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const data = Buffer.from(sea.getAsset(assetKey));
    await fsp.writeFile(targetPath, data);
  }

  process.on('exit', () => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  return pathToFileURL(path.join(tempRoot, 'server.mjs')).href;
}

(async () => {
  try {
    const sea = require('node:sea');
    if (sea.isSea()) {
      const entryUrl = await materializeSeaBundle();
      await import(entryUrl);
      return;
    }
  } catch {
    // Not running inside SEA, or node:sea unavailable in this mode.
  }

  await runDevServer();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
