/**
 * Unified platform detection and file operations.
 * Reads /platform.txt from the given base URL (or current origin) and caches per origin.
 *
 * Supported platforms:
 *   - windows    : direct PUT to the same origin (port 80/443)
 *   - android    : POST to /api/file/upload with FormData (files[])
 *   - iphone     : PUT to the same path (direct file upload, no FormData)
 *   - iphones    : same as iphone
 *   - arduino/esp: PUT to port 81 at /upload?path=...  (chunked upload with ranged fetches)
 *
 * @version 2.2 - Improved error handling, Android uses POST for multipart.
 */
(function() {
  // Per-origin cache: baseUrl -> platform string
  const platformCache = new Map();
  const loadingPromises = new Map();

  const PLATFORM_CONFIG = {
    windows:   { uploadPort: null, uploadPath: null, method: 'PUT', useFormData: false, supportsRemoteCopy: true },
    android:   { uploadPort: null, uploadPath: '/api/file/upload', method: 'POST', useFormData: true, supportsRemoteCopy: true },
    iphone:    { uploadPort: null, uploadPath: null, method: 'PUT', useFormData: false, supportsRemoteCopy: true },
    iphones:   { uploadPort: null, uploadPath: null, method: 'PUT', useFormData: false, supportsRemoteCopy: true },
    arduino:   { uploadPort: 81,   uploadPath: '/upload', method: 'PUT', useFormData: false, supportsRemoteCopy: false },
    esp:       { uploadPort: 81,   uploadPath: '/upload', method: 'PUT', useFormData: false, supportsRemoteCopy: false }
  };

  function normalizeBaseUrl(base) {
    let url = String(base || '').trim();
    try {
      const u = new URL(url, window.location.href);
      return u.origin;
    } catch (e) {
      const qIdx = url.indexOf('?');
      if (qIdx !== -1) url = url.substring(0, qIdx);
      const hIdx = url.indexOf('#');
      if (hIdx !== -1) url = url.substring(0, hIdx);
      return url.replace(/\/+$/, '');
    }
  }

  function normalizeHttpsServerBase(text) {
    const raw = String(text || '').trim().replace(/\?I\s*$/i, '').replace(/\/+$/, '');
    if (!raw) return '';
    try {
      if (/^https?:\/\//i.test(raw)) {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:') return '';
        return `https://${parsed.host}`;
      }
      const hostPart = raw.split(/[/?#]/)[0].trim();
      if (!hostPart) return '';
      if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(hostPart) || /^[A-Za-z0-9.-]+(?::\d+)?$/.test(hostPart)) {
        return `https://${hostPart}`;
      }
    } catch {
      return '';
    }
    return '';
  }

  async function loadPlatformForBase(baseUrl) {
    const key = normalizeBaseUrl(baseUrl);
    if (platformCache.has(key)) return platformCache.get(key);
    if (loadingPromises.has(key)) return loadingPromises.get(key);

    const promise = (async () => {
      try {
        const url = `${key}/platform.txt`;
        console.log(`[loadplatform] Fetching ${url} ...`);
        const res = await fetch(url, { cache: 'no-store' });
        let platform = 'windows';
        if (res.ok) {
          const text = await res.text();
          const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          if (lines.length) {
            let p = lines[0].toLowerCase();
            if (lines[0].includes('=')) {
              const parsed = Object.fromEntries(lines.map(line => {
                const [key, ...vals] = line.split('=');
                return [key.trim().toLowerCase(), vals.join('=').trim()];
              }));
              p = parsed.platform || parsed['platform.txt'] || p;
            }
            platform = p || 'windows';
          }
        } else {
          console.warn(`[loadplatform] ${url} returned ${res.status} – falling back to windows`);
        }
        console.log(`[loadplatform] ✅ Platform for ${key} is "${platform}"`);
        platformCache.set(key, platform);
        return platform;
      } catch (e) {
        console.warn(`[loadplatform] Could not fetch platform from ${key}, falling back to windows:`, e.message);
        platformCache.set(key, 'windows');
        return 'windows';
      } finally {
        loadingPromises.delete(key);
      }
    })();

    loadingPromises.set(key, promise);
    return promise;
  }

  function parseTargetPath(targetPath) {
    const lastSlash = targetPath.lastIndexOf('/');
    if (lastSlash === -1) {
      return { dirPath: '', fileName: targetPath };
    }
    return {
      dirPath: targetPath.substring(0, lastSlash + 1),
      fileName: targetPath.substring(lastSlash + 1)
    };
  }

  function getOrigin(url) {
    try {
      return new URL(url).origin;
    } catch (_) {
      return url;
    }
  }

  function makeUploadId(baseName) {
    const safe = baseName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'upload';
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `${safe}-${stamp}-${rand}`;
  }

  // ── CHUNKED UPLOAD FROM URL (generic, for any platform) ──
  async function uploadFromUrlToPlatform(sourceUrl, targetUrl, destPlatform, totalSize, onProgress) {
    console.log(`[uploadFromUrlToPlatform] source=${sourceUrl}, target=${targetUrl}, dest=${destPlatform}, size=${totalSize}`);
    if (!totalSize) {
      // Try to get size via HEAD
      try {
        const headRes = await fetch(sourceUrl, { method: 'HEAD', cache: 'no-store' });
        const cl = headRes.headers.get('content-length');
        if (cl) totalSize = parseInt(cl, 10);
      } catch (e) {
        console.warn('[uploadFromUrlToPlatform] HEAD failed:', e.message);
      }
      if (!totalSize) {
        try {
          const rangeRes = await fetch(sourceUrl, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
          const range = rangeRes.headers.get('content-range');
          if (range) {
            const match = range.match(/bytes\s+\d+-\d+\/(\d+)/);
            if (match) totalSize = parseInt(match[1], 10);
          }
        } catch (e) {
          console.warn('[uploadFromUrlToPlatform] Range request failed:', e.message);
        }
      }
      if (!totalSize) {
        throw new Error('Cannot determine source file size. HEAD and Range requests failed.');
      }
    }

    // If destination uses FormData (iPhone), we must download the whole file
    if (destPlatform === 'iphone' || destPlatform === 'iphones') {
      console.log('[uploadFromUrlToPlatform] iPhone destination – downloading whole file');
      const blob = await fetch(sourceUrl, { cache: 'no-store' }).then(r => r.blob());
      // Recurse with blob
      return uploadFile(blob, targetUrl, null, onProgress);
    }

    // For PUT-based platforms, use chunked upload with Content-Range
    const chunkSize = 5 * 1024 * 1024;
    const partCount = Math.max(1, Math.ceil(totalSize / chunkSize));
    const uploadId = makeUploadId(sourceUrl.split('/').pop() || 'upload');
    let sent = 0;
    console.log(`[uploadFromUrlToPlatform] Starting ${partCount} chunks of ${chunkSize} bytes`);

    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      const start = partIndex * chunkSize;
      const end = Math.min(totalSize, start + chunkSize);
      console.log(`[uploadFromUrlToPlatform] Fetching chunk ${partIndex+1}/${partCount}: ${start}-${end-1}`);

      const rangeRes = await fetch(sourceUrl, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        cache: 'no-store'
      });
      if (!rangeRes.ok && rangeRes.status !== 206) {
        throw new Error(`Failed to fetch range ${start}-${end - 1}: HTTP ${rangeRes.status}`);
      }
      const chunk = await rangeRes.blob();
      console.log(`[uploadFromUrlToPlatform] Chunk size: ${chunk.size}`);

      const res = await fetch(targetUrl, {
        method: 'PUT',
        body: chunk,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
          'Content-Length': String(chunk.size),
          'X-LibraryJS-Upload-Id': uploadId,
          'X-LibraryJS-Upload-Name': sourceUrl.split('/').pop() || 'upload',
          'X-LibraryJS-Upload-Size': String(totalSize),
          'X-LibraryJS-Upload-Offset': String(start),
          'X-LibraryJS-Chunk-Index': String(partIndex),
          'X-LibraryJS-Chunk-Count': String(partCount),
          'X-Upload-Id': uploadId,
          'X-Upload-Name': sourceUrl.split('/').pop() || 'upload',
          'X-Upload-Size': String(totalSize),
          'X-Upload-Offset': String(start),
          'X-Upload-Part': String(partIndex),
          'X-Upload-Count': String(partCount)
        }
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Upload slice ${partIndex + 1}/${partCount} failed: HTTP ${res.status}${body ? ` - ${body.slice(0, 240)}` : ''}`);
      }

      sent = end;
      onProgress?.(sent, totalSize, partIndex + 1, partCount);
    }

    console.log(`[uploadFromUrlToPlatform] Upload complete: ${sent}/${totalSize} bytes`);
    return { ok: true, status: 200, slices: partCount };
  }

  // ── LEGACY CHUNKED UPLOAD FROM BLOB (fallback) ──
  async function uploadFileInSlices(targetUrl, file, onProgress) {
    const total = Number(file?.size || 0);
    if (!total) throw new Error('Selected file is empty.');

    const chunkSize = 5 * 1024 * 1024;
    const partCount = Math.max(1, Math.ceil(total / chunkSize));
    const uploadId = makeUploadId(file.name || targetUrl);
    let sent = 0;

    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      const start = partIndex * chunkSize;
      const end = Math.min(total, start + chunkSize);
      const chunk = file.slice(start, end, file.type || 'application/octet-stream');

      const res = await fetch(targetUrl, {
        method: 'PUT',
        body: chunk,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'Content-Range': `bytes ${start}-${end - 1}/${total}`,
          'Content-Length': String(chunk.size),
          'X-LibraryJS-Upload-Id': uploadId,
          'X-LibraryJS-Upload-Name': file.name || 'upload',
          'X-LibraryJS-Upload-Size': String(total),
          'X-LibraryJS-Upload-Offset': String(start),
          'X-LibraryJS-Chunk-Index': String(partIndex),
          'X-LibraryJS-Chunk-Count': String(partCount),
          'X-Upload-Id': uploadId,
          'X-Upload-Name': file.name || 'upload',
          'X-Upload-Size': String(total),
          'X-Upload-Offset': String(start),
          'X-Upload-Part': String(partIndex),
          'X-Upload-Count': String(partCount)
        }
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Upload slice ${partIndex + 1}/${partCount} failed: HTTP ${res.status}${body ? ` - ${body.slice(0, 240)}` : ''}`);
      }

      sent = end;
      onProgress?.(sent, total, partIndex + 1, partCount);
    }

    return { ok: true, status: 200, slices: partCount };
  }

  const platformAPI = {

    getPlatform: async function(baseUrl) {
      const key = normalizeBaseUrl(baseUrl);
      return loadPlatformForBase(key);
    },

    getConfig: async function(baseUrl) {
      const platform = await this.getPlatform(baseUrl);
      const defaults = {
        maxConcurrentUploads: 6,
        timeoutMs: 600000,
        supportsRemoteCopy: false,
        chunkSize: 0
      };

      const configs = {
        windows:   { maxConcurrentUploads: 6, timeoutMs: 600000, supportsRemoteCopy: true },
        android:   { maxConcurrentUploads: 3, timeoutMs: 900000, supportsRemoteCopy: true, chunkSize: 8 * 1024 * 1024 },
        iphone:    { maxConcurrentUploads: 2, timeoutMs: 900000, supportsRemoteCopy: true },
        iphones:   { maxConcurrentUploads: 2, timeoutMs: 900000, supportsRemoteCopy: true },
        arduino:   { maxConcurrentUploads: 1, timeoutMs: 600000, supportsRemoteCopy: false, chunkSize: 5 * 1024 * 1024 },
        esp:       { maxConcurrentUploads: 1, timeoutMs: 600000, supportsRemoteCopy: false, chunkSize: 5 * 1024 * 1024 }
      };

      return { ...defaults, ...(configs[platform] || configs.windows) };
    },

    clearCache: function(baseUrl) {
      if (baseUrl) {
        const key = normalizeBaseUrl(baseUrl);
        platformCache.delete(key);
        loadingPromises.delete(key);
        console.log(`[loadplatform] Cleared cache for ${key}`);
      } else {
        platformCache.clear();
        loadingPromises.clear();
        console.log('[loadplatform] Cleared all platform cache');
      }
    },

    refreshPlatform: async function(baseUrl) {
      const key = normalizeBaseUrl(baseUrl);
      platformCache.delete(key);
      loadingPromises.delete(key);
      return this.getPlatform(baseUrl);
    },

    forcePlatform: function(baseUrl, platform) {
      const key = normalizeBaseUrl(baseUrl);
      platformCache.set(key, platform);
      loadingPromises.delete(key);
      console.log(`[loadplatform] Platform for ${key} forced to ${platform}`);
    },

    getPlatformInfo: async function(baseUrl) {
      const key = normalizeBaseUrl(baseUrl);
      const platform = await this.getPlatform(baseUrl);
      let method = 'put';
      let endpoint = '';
      let httpsBase = '';

      try {
        const res = await fetch(`${key}/platform.txt`, { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          for (const line of lines) {
            const m = line.match(/^([a-z0-9_-]+)\s*=\s*(.+)$/i);
            if (m) {
              const k = m[1].toLowerCase();
              const v = m[2].trim();
              if (k === 'method' || k === 'uploadmethod' || k === 'transfermethod') {
                method = v.toLowerCase();
              }
              if (k === 'endpoint' || k === 'uploadendpoint' || k === 'transferendpoint') {
                endpoint = v;
              }
            }
          }
        }
      } catch (_) {}

      try {
        const httpsRes = await fetch(`${key}/httpsserverip.txt`, { cache: 'no-store' });
        if (httpsRes.ok) {
          const httpsText = (await httpsRes.text()).trim();
          if (httpsText) {
            httpsBase = normalizeHttpsServerBase(httpsText);
          }
        }
      } catch (_) {}

      const alias = {
        'direct-put': 'put',
        'http-put': 'put',
        'put-direct': 'put',
        'direct': 'put',
        'webdav': 'put',
        'filesystem': 'filesystem',
        'fs': 'filesystem',
        'post-form': 'post',
        'multipart': 'post',
        'post': 'post',
        'remote-copy': 'copy',
        'copy': 'copy'
      };
      method = alias[method] || method || 'put';
      if (!['put', 'post', 'filesystem', 'copy'].includes(method)) method = 'put';

      return { platform, method, endpoint, httpsBase };
    },

    getUploadUrl: async function(baseUrl, targetPath) {
      if (typeof targetPath === 'undefined') {
        targetPath = baseUrl;
        baseUrl = window.location.href;
      }
      if (!targetPath) return targetPath;

      // Normalize accidental full URLs into server-relative paths.
      try {
        const parsed = new URL(targetPath);
        targetPath = decodeURIComponent(parsed.pathname);
        if (!targetPath.startsWith('/')) {
          targetPath = '/' + targetPath;
        }
      } catch (_) {
        // Already a relative path.
      }

      targetPath = decodeURIComponent(targetPath);

      const platform = await this.getPlatform(baseUrl);
      if (!platform) return targetPath;

      const config = PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.windows;
      const origin = getOrigin(baseUrl) || window.location.origin;

      if (platform === 'arduino' || platform === 'esp') {
        let filePath = targetPath;
        filePath = filePath.replace(/^\.\//, '').replace(/^\.\.\//, '');
        if (!filePath.startsWith('/')) filePath = '/' + filePath;
        const host = new URL(origin).hostname;
        const port = config.uploadPort || 81;
        const url = `http://${host}:${port}${config.uploadPath}?path=${encodeURIComponent(filePath)}`;
        console.log('[platformAPI] Upload URL (Arduino):', url);
        return url;
      } else if (platform === 'android') {
        const url = new URL(config.uploadPath, origin);
        const { dirPath, fileName } = parseTargetPath(targetPath);
        url.searchParams.set('path', decodeURIComponent(dirPath));
        if (fileName) {
          url.searchParams.set('name', decodeURIComponent(fileName));
        }
        console.log('[platformAPI] Upload URL (Android):', url.toString());
        return url.toString();
      } else {
        // All other platforms (windows, iphone, iphones) use PUT to the target path
        const cleanPath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        const url = new URL(cleanPath, origin);
        console.log('[platformAPI] Upload URL (PUT):', url.toString());
        return url;
      }
    },

    // ----------------------------------------------------------------------
    //  FIX: Use direct URL for ALL platforms – no special download endpoint.
    // ----------------------------------------------------------------------
    getDownloadUrl: async function(baseUrl, targetPath) {
      if (typeof targetPath === 'undefined') {
        targetPath = baseUrl;
        baseUrl = window.location.href;
      }
      if (!targetPath) return targetPath;

      const platform = await this.getPlatform(baseUrl);
      if (!platform) return targetPath;

      const origin = getOrigin(baseUrl) || window.location.origin;
      const cleanPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;

      // All platforms serve static files directly.  No custom download API needed.
      const url = new URL(cleanPath, origin);
      console.log('[platformAPI] Download URL (direct):', url.toString(), 'platform:', platform);
      return url.toString();
    },

    upload: async function(fileOrUrl, targetPath, baseUrl, onProgress, options) {
      return this.uploadFile(fileOrUrl, targetPath, baseUrl, onProgress, options);
    },

    uploadFile: async function(fileOrUrl, targetPath, baseUrl, onProgress, options = {}) {
      if (typeof baseUrl === 'function') {
        onProgress = baseUrl;
        baseUrl = window.location.href;
      }
      baseUrl = baseUrl || window.location.href;

      // Use explicitly provided destination platform if available, otherwise detect
      let destPlatform = options.destPlatform;
      if (!destPlatform) {
        destPlatform = await this.getPlatform(baseUrl);
      }
      console.log(`[platformAPI] uploadFile: destination platform = ${destPlatform}, baseUrl=${baseUrl}`);

      const config = PLATFORM_CONFIG[destPlatform] || PLATFORM_CONFIG.windows;

      console.log('[platformAPI] uploadFile targetPath =', targetPath);

      const targetUrl = await this.getUploadUrl(baseUrl, targetPath);
      console.log(`[platformAPI] uploadFile: targetUrl = ${targetUrl}`);

      // ---- If fileOrUrl is a URL string, use chunked upload (streaming) ----
      if (typeof fileOrUrl === 'string' && /^https?:\/\//i.test(fileOrUrl)) {
        // Determine total size
        let totalSize = null;
        try {
          const headRes = await fetch(fileOrUrl, { method: 'HEAD', cache: 'no-store' });
          const contentLength = headRes.headers.get('content-length');
          if (contentLength) totalSize = parseInt(contentLength, 10);
        } catch (e) {
          console.warn('[platformAPI] HEAD request failed:', e.message);
        }
        if (!totalSize) {
          try {
            const rangeRes = await fetch(fileOrUrl, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
            const range = rangeRes.headers.get('content-range');
            if (range) {
              const match = range.match(/bytes\s+\d+-\d+\/(\d+)/);
              if (match) totalSize = parseInt(match[1], 10);
            }
          } catch (e) {
            console.warn('[platformAPI] Range request failed:', e.message);
          }
        }
        if (!totalSize) {
          console.warn('[platformAPI] Could not get file size from URL, downloading entire file.');
          const blob = await fetch(fileOrUrl, { cache: 'no-store' }).then(r => r.blob());
          // Recursively call with blob
          return this.uploadFile(blob, targetPath, baseUrl, onProgress, options);
        }
        // Use chunked upload from URL
        return uploadFromUrlToPlatform(fileOrUrl, targetUrl, destPlatform, totalSize, onProgress);
      }

      // ---- If fileOrUrl is a Blob/File ----
      // For Arduino/ESP destination, use chunked blob slicing
      if (destPlatform === 'arduino' || destPlatform === 'esp') {
        return uploadFileInSlices(targetUrl, fileOrUrl, onProgress);
      }

      // ---- For other platforms, use the existing logic (single PUT or FormData) ----
      const method = config.method || 'PUT';
      const useFormData = config.useFormData;

      let body;
      if (useFormData) {
        const formData = new FormData();
        const fileName = decodeURIComponent(
          targetPath.split('/').pop() || 'file'
        );
        formData.append('files[]', fileOrUrl, fileName);
        if (destPlatform === 'iphone' || destPlatform === 'iphones') {
          const { dirPath } = parseTargetPath(targetPath);
          formData.append('targetDir', dirPath);
        }
        body = formData;
      } else {
        body = fileOrUrl;
      }

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, targetUrl, true);

        if (!useFormData) {
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        }

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) {
            onProgress(e.loaded, e.total);
          }
        };

        xhr.onload = () => {
          console.log('[platformAPI] Upload response status:', xhr.status);
          console.log('[platformAPI] Upload response text:', xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.responseText);
          } else {
            // Include response text in error for debugging
            const errorMsg = `Upload failed: HTTP ${xhr.status} – ${xhr.responseText || 'No response body'}`;
            reject(new Error(errorMsg));
          }
        };

        xhr.onerror = () => {
          console.error('[platformAPI] Upload network error');
          reject(new Error('Network error during upload'));
        };

        xhr.send(body);
      });
    },

    getPlatformSync: function(baseUrl) {
      const key = normalizeBaseUrl(baseUrl);
      return platformCache.has(key) ? platformCache.get(key) : null;
    },

    // ---- server-side copy (only for platforms that support it) ----
    copyFile: async function(sourceUrl, targetPath, baseUrl) {
      const config = await this.getConfig(baseUrl);
      if (!config.supportsRemoteCopy) {
        throw new Error('Remote copy not supported on this platform.');
      }
      const key = normalizeBaseUrl(baseUrl);
      const url = `${key}/api/file/copy`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl, targetPath })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Remote copy failed: ${response.status} ${text}`);
      }
      return await response.json();
    }
  };

  window.platformAPI = platformAPI;
  console.log('[loadplatform] version 2.2 – Improved error handling and Android POST support');
})();