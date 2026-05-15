let activeWorker = null;
let activeJob = null;
const pendingJobs = new Map();
const taskQueue = [];
let taskQueueRunning = false;

function enqueueTask(task) {
  return new Promise((resolve, reject) => {
    taskQueue.push({ task, resolve, reject });
    void pumpTaskQueue();
  });
}

async function pumpTaskQueue() {
  if (taskQueueRunning) return;
  taskQueueRunning = true;
  try {
    while (taskQueue.length) {
      const entry = taskQueue.shift();
      try {
        const result = await entry.task();
        entry.resolve(result);
      } catch (err) {
        entry.reject(err);
      }
    }
  } finally {
    taskQueueRunning = false;
  }
}

function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || !base64) return null;
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return '';
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

function ensureWorker() {
  if (activeWorker) return activeWorker;
  activeWorker = new Worker(chrome.runtime.getURL('remux-worker.js'), { type: 'module' });
  let outputQueue = Promise.resolve();
  activeWorker.onmessage = (ev) => {
    const msg = ev?.data || {};
    if (msg.type === 'status') {
      chrome.runtime.sendMessage({
        type: 'sfa-remux-status',
        id: msg.id ?? null,
        stage: String(msg.stage || ''),
        detail: String(msg.detail || '')
      }).catch(() => {});
      return;
    }
    
    if (msg.type === 'result-chunk') {
      if (activeJob) {
        const bytes = msg.bytes instanceof ArrayBuffer ? msg.bytes : bufferFromChunk(msg.bytes);
        if (bytes) {
          if (typeof msg.name === 'string' && msg.name) activeJob.resultName = msg.name;
          if (typeof msg.mimeType === 'string' && msg.mimeType) activeJob.mimeType = msg.mimeType;

          const currentJob = activeJob;
          if (!currentJob.remuxWriteQueue) currentJob.remuxWriteQueue = Promise.resolve();
          currentJob.remuxWriteQueue = currentJob.remuxWriteQueue.then(async () => {
            const store = await (currentJob.remuxStorePromise || (currentJob.remuxStorePromise = createRemuxOutputStore(
              currentJob.id,
              currentJob.resultName || msg.name || 'compiled.mp4',
              currentJob.mimeType || msg.mimeType || 'application/octet-stream'
            ).then((created) => {
              currentJob.remuxStore = created;
              return created;
            })));
            await appendToRemuxStore(store, bytes, Number.isFinite(Number(msg.position)) ? Number(msg.position) : null);
          });
        }
      }
      return;
    }
    if (msg.type === 'result-done') {
      if (!activeJob) return;
      const jobRef = activeJob;
      const resolve = jobRef.resolve;
      const reject = jobRef.reject;
      activeJob = null;
      Promise.resolve(jobRef.remuxWriteQueue || Promise.resolve())
        .then(async () => {
          const store = await (jobRef.remuxStorePromise || Promise.resolve(jobRef.remuxStore));
          const file = await finalizeRemuxStore(store);
          resolve({
            name: String(jobRef.resultName || msg.name || 'compiled.mp4'),
            mimeType: String(jobRef.mimeType || msg.mimeType || file.type || 'application/octet-stream'),
            file,
            byteLength: file.size,
            uploaded: false
          });
        })
        .catch((err) => {
          reject(new Error(String(err?.message || err || 'Browser remux did not produce a remuxed MP4.')));
        });
      return;
    }
    if (!activeJob) return;
    if (msg.type === 'result') {

      const resolve = activeJob.resolve;
      activeJob = null;
      resolve(msg);
    } else if (msg.type === 'error') {
      const reject = activeJob.reject;
      activeJob = null;
      reject(new Error(msg.error || 'Remux failed.'));
    }
  };
  activeWorker.onerror = (ev) => {
    if (!activeJob) return;
    const reject = activeJob.reject;
    activeJob = null;
    reject(new Error(ev?.message || 'Worker error.'));
  };
  return activeWorker;
}

function ensureJob(jobId) {
  if (!pendingJobs.has(jobId)) {
    pendingJobs.set(jobId, {
      id: jobId,
      baseUrl: '',
      playlistName: 'index.m3u8',
      outputName: 'compiled.mp4',
      playlistText: '',
      fileCount: 0,
      files: new Map()
    });
  }
  return pendingJobs.get(jobId);
}

function bufferFromChunk(value) {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return null;
}

function bytesToBase64(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return '';
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

function chunksToBlob(chunks, type = 'application/octet-stream') {
  const filtered = Array.isArray(chunks)
    ? chunks.map((chunk) => {
        if (!chunk) return null;
        if (chunk instanceof Blob) return chunk;
        if (chunk instanceof ArrayBuffer) return chunk;
        if (ArrayBuffer.isView(chunk)) {
          return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        }
        return null;
      }).filter(Boolean)
    : [];
  return new Blob(filtered, { type });
}

function postStatus(jobId, stage, detail = '') {
  chrome.runtime.sendMessage({
    type: 'sfa-remux-status',
    id: jobId ?? null,
    stage: String(stage || ''),
    detail: String(detail || '')
  }).catch(() => {});
}

function estimateChunkCount(entry, chunkSize = 8 * 1024 * 1024) {
  const size = entry?.chunks?.reduce?.((sum, chunk) => sum + (chunk?.byteLength || 0), 0) || 0;
  return Math.max(1, Math.ceil(size / Math.max(1, Number(chunkSize) || 1)));
}

async function sendChunkedResultToServiceWorker(id, result, chunkBytes = 8 * 1024 * 1024) {
  const bytes = bufferFromChunk(result?.bytes);
  const output = bytes ? new Uint8Array(bytes) : new Uint8Array(0);
  const name = String(result?.name || 'compiled.mp4');
  const mimeType = String(result?.mimeType || '');
  const totalChunks = Math.max(1, Math.ceil(output.byteLength / chunkBytes));

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * chunkBytes;
    const end = Math.min(output.byteLength, start + chunkBytes);
    const slice = output.slice(start, end);
    await chrome.runtime.sendMessage({
      type: 'sfa-remux-result-chunk',
      id,
      chunkIndex,
      totalChunks,
      name,
      mimeType,
      base64: bytesToBase64(slice.buffer)
    });
  }

  await chrome.runtime.sendMessage({
    type: 'sfa-remux-result-done',
    id,
    name,
    mimeType,
    byteLength: output.byteLength,
    totalChunks
  });
}

function parseUploadPutUrl(url) {
  const parsed = new URL(String(url || ''), 'https://example.invalid/');
  const pathname = String(parsed.pathname || '/');
  const lastSlash = pathname.lastIndexOf('/');
  const folderPath = lastSlash >= 0 ? pathname.slice(0, lastSlash + 1) || '/' : '/';
  const rawFile = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
  let filename = rawFile;
  try {
    filename = decodeURIComponent(rawFile || '');
  } catch {}
  return {
    targetOrigin: parsed.origin,
    folderPath: folderPath.endsWith('/') ? folderPath : `${folderPath}/`,
    filename: filename || 'compiled.mp4'
  };
}

function toBlob(value, contentType = 'application/octet-stream') {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return new Blob([value], { type: contentType });
  if (ArrayBuffer.isView(value)) {
    return new Blob([value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)], { type: contentType });
  }
  return new Blob([value || new ArrayBuffer(0)], { type: contentType });
}

function xhrPutBlob(url, blob) {
  const payload = toBlob(blob);
  const contentType = String(payload.type || 'application/octet-stream');
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.withCredentials = true;
      xhr.responseType = 'text';
      xhr.timeout = 30 * 60 * 1000;
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.onload = () => {
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: Number(xhr.status || 0) || 0,
          text: String(xhr.responseText || '')
        });
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.ontimeout = () => reject(new Error('upload timed out'));
      xhr.send(payload);
    } catch (err) {
      reject(err);
    }
  });
}


async function putBlobViaFetch(url, blob) {
  const payload = toBlob(blob);
  const contentType = String(payload.type || 'application/octet-stream');
  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': contentType
      },
      body: payload
    });
  } catch (err) {
    throw new Error(`PUT upload failed: ${err?.message || err || 'Failed to fetch'}`);
  }

  let text = '';
  try {
    text = await response.text();
  } catch {}

  return {
    ok: response.ok,
    status: Number(response.status || 0) || 0,
    text
  };
}

const REMUX_TEMP_DIR = 'sfa-remux-temp';
let remuxTempRootPromise = null;

function sanitizeTempName(name) {
  return String(name || 'compiled.mp4')
    .replace(/[\\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'compiled.mp4';
}

async function getRemuxTempRoot() {
  if (!navigator?.storage?.getDirectory) {
    throw new Error('Durable temp storage is not available in this browser.');
  }
  if (!remuxTempRootPromise) remuxTempRootPromise = navigator.storage.getDirectory();
  return remuxTempRootPromise;
}

async function createRemuxOutputStore(jobId, fileName, mimeType) {
  const root = await getRemuxTempRoot();
  const dir = await root.getDirectoryHandle(REMUX_TEMP_DIR, { create: true });
  const safeName = `${Date.now()}-${String(jobId ?? 'job')}-${sanitizeTempName(fileName)}`;
  const fileHandle = await dir.getFileHandle(safeName, { create: true });
  const writable = await fileHandle.createWritable();
  return {
    dir,
    fileHandle,
    writable,
    safeName,
    mimeType: String(mimeType || 'application/octet-stream') || 'application/octet-stream',
    bytesWritten: 0,
    closed: false
  };
}

async function appendToRemuxStore(store, bytes, position = null) {
  if (!store || !(bytes instanceof ArrayBuffer) || bytes.byteLength <= 0) return;

  const payload = new Uint8Array(bytes);
  if (Number.isInteger(position) && position >= 0) {
    await store.writable.write({
      type: 'write',
      position,
      data: payload
    });
    store.bytesWritten = Math.max(store.bytesWritten, position + bytes.byteLength);
    return;
  }

  await store.writable.write(payload);
  store.bytesWritten += bytes.byteLength;
}

async function finalizeRemuxStore(store) {
  if (!store) {
    throw new Error('Browser remux did not produce a remuxed MP4.');
  }
  if (!store.closed) {
    await store.writable.close();
    store.closed = true;
  }
  const file = await store.fileHandle.getFile();
  if (!(file instanceof Blob) || file.size <= 0) {
    throw new Error('Browser remux did not produce a remuxed MP4.');
  }
  return file;
}

async function cleanupRemuxStore(store) {
  if (!store) return;
  try {
    if (!store.closed) {
      await store.writable.close().catch(() => {});
      store.closed = true;
    }
  } catch {}
  try {
    await store.dir.removeEntry(store.safeName).catch(() => {});
  } catch {}
}

async function runRemuxJob(job) {

  const worker = ensureWorker();
  const resultPromise = new Promise((resolve, reject) => {
    activeJob = { resolve, reject, remuxWriteQueue: Promise.resolve(), remuxStorePromise: null, remuxStore: null, resultName: '', mimeType: '', remuxMode: 'archive', reserveBufferOverestimationPercent: 15 };
  });

  const entries = [...job.files.entries()].sort((a, b) => a[0] - b[0]);
  const files = [];
  postStatus(job.id, 'Remux bridge', `Reassembling ${entries.length} file${entries.length === 1 ? '' : 's'}`);
  for (let i = 0; i < entries.length; i++) {
    const [fileIndex, entry] = entries[i];
    if (!entry || !entry.name) continue;
    const totalChunks = estimateChunkCount(entry);
    postStatus(job.id, 'Remux bridge', `Reassembling file ${i + 1} / ${entries.length}${entry.name ? ` • ${entry.name}` : ''}`);
    const blob = chunksToBlob(entry.chunks);
    if (blob instanceof Blob && blob.size) {
      files.push({ fileIndex, name: entry.name, mimeType: entry.mimeType || entry.blob?.type || '', blob });
    }
    if (totalChunks > 1) {
      postStatus(job.id, 'Remux bridge', `File ${i + 1} ready • ${totalChunks} chunk${totalChunks === 1 ? '' : 's'}`);
    }
    if ((i + 1) % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  postStatus(job.id, 'Remux bridge', `Sending ${files.length} assembled file${files.length === 1 ? '' : 's'} to worker`);
  worker.postMessage({
    type: 'remux',
    id: job.id,
    baseUrl: job.baseUrl,
    playlistName: job.playlistName,
    outputName: job.outputName,
    playlistText: job.playlistText,
    segmentMeta: Array.isArray(job.segmentMeta) ? job.segmentMeta : [],
    reserveBufferOverestimationPercent: Math.max(0, Number(job.reserveBufferOverestimationPercent ?? 15) || 0),
    mode: String(job.remuxMode || 'archive'),
    files
  });

  const result = await resultPromise;
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message || {};
  if (!msg || !msg.type) return;

  if (msg.type === 'sfa-remux-init') {
    const job = ensureJob(msg.id);
    job.baseUrl = typeof msg.baseUrl === 'string' && msg.baseUrl ? msg.baseUrl : chrome.runtime.getURL('mediabunny/');
    job.playlistName = typeof msg.playlistName === 'string' && msg.playlistName ? msg.playlistName : 'index.m3u8';
    job.outputName = typeof msg.outputName === 'string' && msg.outputName ? msg.outputName : 'compiled.mp4';
    job.playlistText = typeof msg.playlistText === 'string' ? msg.playlistText : '';
    job.segmentMeta = Array.isArray(msg.segmentMeta) ? msg.segmentMeta : [];
    job.fileCount = Math.max(0, Number(msg.fileCount) || 0);
    job.reserveBufferOverestimationPercent = Math.max(0, Number(msg.reserveBufferOverestimationPercent ?? 15) || 0);
    job.remuxMode = String(msg.mode || 'archive');
    job.files = new Map();
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg.type === 'sfa-remux-file-start') {
    const job = ensureJob(msg.id);
    const fileIndex = Math.max(0, Number(msg.fileIndex) || 0);
    if (!job.files.has(fileIndex)) {
      job.files.set(fileIndex, {
        name: typeof msg.name === 'string' ? msg.name : `file-${fileIndex}`,
        mimeType: typeof msg.mimeType === 'string' ? msg.mimeType : '',
        chunks: []
      });
    } else {
      const entry = job.files.get(fileIndex);
      if (typeof msg.name === 'string' && msg.name) entry.name = msg.name;
      if (typeof msg.mimeType === 'string' && msg.mimeType) entry.mimeType = msg.mimeType;
    }
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg.type === 'sfa-remux-file-chunk') {
    const job = ensureJob(msg.id);
    const fileIndex = Math.max(0, Number(msg.fileIndex) || 0);
    const entry = job.files.get(fileIndex) || { name: `file-${fileIndex}`, chunks: [] };
    const bytes = msg.base64 ? base64ToBytes(msg.base64) : bufferFromChunk(msg.bytes);
    if (bytes) {
      entry.chunks.push(bytes);
      job.files.set(fileIndex, entry);
    }
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg.type === 'sfa-remux-file-end') {
    ensureJob(msg.id);
    sendResponse?.({ ok: true });
    return true;
  }

  
  if (msg.type === 'sfa-remux-finalize') {
    enqueueTask(async () => {
      const job = ensureJob(msg.id);
      try {
        const result = await runRemuxJob(job);
        const uploadUrl = String(msg.uploadUrl || '').trim();

        if (!uploadUrl) {
          throw new Error('Upload URL is missing.');
        }

        postStatus(job.id, 'Uploading archive', `Sending ${String(result.name || job.outputName || 'compiled.mp4')}`);
        const uploadResult = await putBlobViaFetch(uploadUrl, result.file);
        if (!uploadResult.ok) {
          throw new Error(`PUT upload failed: HTTP ${Number(uploadResult.status || 0) || 'unknown'}`);
        }

        sendResponse?.({
          ok: true,
          name: String(result.name || job.outputName || 'compiled.mp4'),
          mimeType: String(result.mimeType || result.file?.type || 'application/octet-stream'),
          status: Number(uploadResult.status || 200) || 200,
          text: String(uploadResult.text || ''),
          uploaded: true
        });
      } catch (err) {
        sendResponse?.({ ok: false, error: String(err?.message || err) });
      } finally {
        try {
          await cleanupRemuxStore(job.remuxStore);
        } catch {}
        if (job.remuxStorePromise) {
          try { job.remuxStorePromise = null; } catch {}
        }
        job.remuxStore = null;
        pendingJobs.delete(msg.id);
        activeJob = null;
      }
    }).catch((err) => {
      sendResponse?.({ ok: false, error: String(err?.message || err) });
    });
    return true;
  }

  
  if (msg.type === 'sfa-upload-put') {
    enqueueTask(async () => {
      try {
        const url = typeof msg.url === 'string' ? msg.url : '';
        if (!url) throw new Error('Upload URL is missing.');
        let blob = null;

        if (typeof msg.cacheUrl === 'string' && msg.cacheUrl) {
          const cached = await caches.match(msg.cacheUrl);
          if (!cached) throw new Error('Cached upload body unavailable.');
          blob = await cached.blob();
        } else if (msg.bytes instanceof ArrayBuffer) {
          blob = new Blob([msg.bytes], { type: msg.contentType || 'application/octet-stream' });
        } else if (ArrayBuffer.isView(msg.bytes)) {
          blob = new Blob([msg.bytes.buffer.slice(msg.bytes.byteOffset, msg.bytes.byteOffset + msg.bytes.byteLength)], { type: msg.contentType || 'application/octet-stream' });
        } else if (msg.blob instanceof Blob) {
          blob = msg.blob;
        } else if (msg.blob instanceof ArrayBuffer) {
          blob = new Blob([msg.blob], { type: msg.contentType || 'application/octet-stream' });
        } else {
          throw new Error('Upload body is missing.');
        }

        if (!(blob instanceof Blob) || blob.size <= 0) {
          throw new Error('Upload body is empty.');
        }

        const result = await putBlobViaFetch(url, blob);
        sendResponse?.({ ok: true, status: result.status, text: result.text || '' });
      } catch (err) {
        sendResponse?.({ ok: false, error: String(err?.message || err) });
      }
    }).catch(() => {});
    return true;
  }

  if (msg.type === 'sfa-remux-placeholder') {

    enqueueTask(async () => {
      try {
        const worker = ensureWorker();
        const resultPromise = new Promise((resolve, reject) => {
          activeJob = { resolve, reject };
        });

        const baseUrl = (typeof msg.baseUrl === 'string' && msg.baseUrl.trim()) ? msg.baseUrl : chrome.runtime.getURL('mediabunny/');
        worker.postMessage({
          type: 'placeholder',
          id: msg.id ?? null,
          baseUrl,
          outputName: msg.outputName || 'gap.ts',
          duration: Number(msg.duration || 0) || 1,
          family: msg.family || 'ts',
          quality: msg.quality || '',
          resolution: msg.resolution || ''
        });

        const result = await resultPromise;
        await sendChunkedResultToServiceWorker(msg.id ?? null, result);
      } catch (err) {
        await chrome.runtime.sendMessage({
          type: 'sfa-remux-result-error',
          id: msg.id ?? null,
          error: String(err?.message || err)
        }).catch(() => {});
      } finally {
        pendingJobs.delete(msg.id);
        activeJob = null;
      }
    }).catch(() => {});
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg.type === 'sfa-remux') {
    // Legacy one-shot support.
    enqueueTask(async () => {
      try {
        const worker = ensureWorker();

        const resultPromise = new Promise((resolve, reject) => {
          activeJob = { resolve, reject };
        });

        const files = Array.isArray(msg.files) ? msg.files.map(f => {
          const bytes = f?.bytes;
          const base64 = f?.base64;
          const data = f?.data;
          const blob = f?.blob;
          let out = null;
          if (blob instanceof Blob) {
            out = blob;
          } else if (bytes instanceof ArrayBuffer) {
            out = new Blob([bytes]);
          } else if (ArrayBuffer.isView(bytes)) {
            out = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)]);
          } else if (base64) {
            const arr = base64ToBytes(base64);
            out = arr ? new Blob([arr]) : null;
          } else if (data instanceof ArrayBuffer) {
            out = new Blob([data]);
          } else if (ArrayBuffer.isView(data)) {
            out = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)]);
          }
          return {
            name: f?.name || '',
            type: String(f?.type || out?.type || ''),
            blob: out
          };
        }).filter(f => f.name && f.blob instanceof Blob) : [];

        const baseUrl = (typeof msg.baseUrl === 'string' && msg.baseUrl.trim())
          ? msg.baseUrl
          : chrome.runtime.getURL('mediabunny/');

        worker.postMessage({
          type: 'remux',
          id: msg.id ?? null,
          baseUrl,
          playlistName: msg.playlistName || 'index.m3u8',
          outputName: msg.outputName || 'compiled.mp4',
          playlistText: typeof msg.playlistText === 'string' ? msg.playlistText : '',
          reserveBufferOverestimationPercent: Math.max(0, Number(msg.reserveBufferOverestimationPercent ?? 15) || 0),
          mode: 'direct',
          files
        });

        const result = await resultPromise;
        const bytes = result.bytes instanceof ArrayBuffer
          ? result.bytes
          : ArrayBuffer.isView(result.bytes)
            ? result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength)
            : null;

        if (!bytes) {
          throw new Error('remux produced an empty output.');
        }

        const outName = String(result.name || msg.outputName || 'compiled.mp4');
        const mimeType = String(result.mimeType || (outName.toLowerCase().endsWith('.ts') ? 'video/mp2t' : 'video/mp4'));
        return {
          ok: true,
          base64: arrayBufferToBase64(bytes),
          byteLength: bytes.byteLength,
          name: outName,
          mimeType
        };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }).then((payload) => sendResponse(payload)).catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});
