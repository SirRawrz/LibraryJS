const fs = require('node:fs');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function runDevServer() {
  await import('./server.mjs');
}

function getSeaCacheKey(manifestText) {
  return crypto.createHash('sha256').update(manifestText).digest('hex').slice(0, 16);
}

async function cleanupLegacySeaFolders() {
  const legacyRoot = os.tmpdir();
  const retentionMs = 7 * 24 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = await fsp.readdir(legacyRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('libraryjs-server-sea-')) {
      continue;
    }

    const targetPath = path.join(legacyRoot, entry.name);
    try {
      const stat = await fsp.stat(targetPath);
      if (Date.now() - stat.mtimeMs > retentionMs) {
        await fsp.rm(targetPath, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup failures
    }
  }
}

async function materializeSeaBundle() {
  const sea = require('node:sea');
  const manifestText = sea.getAsset('asset-manifest.json', 'utf8');
  const manifest = JSON.parse(manifestText);

  await cleanupLegacySeaFolders();

  const tempRoot = path.join(os.tmpdir(), 'libraryjs-server-sea-cache', getSeaCacheKey(manifestText));
  await fsp.mkdir(tempRoot, { recursive: true });

  for (const assetKey of manifest.assets || []) {
    const targetPath = path.join(tempRoot, assetKey);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const data = Buffer.from(sea.getAsset(assetKey));
    await fsp.writeFile(targetPath, data);
  }

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
