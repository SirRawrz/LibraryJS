// ======================================================================
// Offscreen Document – Browser-side FFmpeg remux using FFmpeg.wasm
// ======================================================================

self.addEventListener('message', async (event) => {
  const msg = event?.data || {};
  if (!msg || !msg.type) return;

  if (msg.type === 'sfa-remux-init') {
    // Store the job parameters
    self._remuxJob = {
      id: msg.id,
      playlistName: msg.playlistName,
      outputName: msg.outputName,
      playlistText: msg.playlistText,
      segmentMeta: msg.segmentMeta || [],
      fileCount: msg.fileCount || 0,
      chunkBytes: msg.chunkBytes || 8 * 1024 * 1024,
      mode: msg.mode || 'archive',
      uploadUrl: msg.uploadUrl || '',
      files: [], // will be populated by file chunks
      fileIndex: 0,
      chunkIndex: 0,
      expectedFiles: msg.fileCount
    };
    self._remuxState = 'init';
    self.postMessage({ type: 'sfa-remux-init-ack', id: msg.id });
    return;
  }

  if (msg.type === 'sfa-remux-file-start') {
    if (!self._remuxJob || self._remuxJob.id !== msg.id) return;
    // Prepare to receive chunks for this file
    self._remuxJob.files[msg.fileIndex] = {
      name: msg.name,
      mimeType: msg.mimeType || 'application/octet-stream',
      chunks: [],
      chunkCount: 0
    };
    self._remuxJob.fileIndex = msg.fileIndex;
    self._remuxJob.chunkIndex = 0;
    self.postMessage({ type: 'sfa-remux-file-start-ack', id: msg.id, fileIndex: msg.fileIndex });
    return;
  }

  if (msg.type === 'sfa-remux-file-chunk') {
    if (!self._remuxJob || self._remuxJob.id !== msg.id) return;
    const fileEntry = self._remuxJob.files[msg.fileIndex];
    if (!fileEntry) return;
    // Decode base64 to ArrayBuffer
    const binary = atob(msg.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    fileEntry.chunks.push(bytes.buffer);
    fileEntry.chunkCount = msg.chunkIndex + 1;
    self._remuxJob.chunkIndex = msg.chunkIndex;
    self.postMessage({ type: 'sfa-remux-file-chunk-ack', id: msg.id, fileIndex: msg.fileIndex, chunkIndex: msg.chunkIndex });
    return;
  }

  if (msg.type === 'sfa-remux-file-end') {
    if (!self._remuxJob || self._remuxJob.id !== msg.id) return;
    const fileEntry = self._remuxJob.files[msg.fileIndex];
    if (!fileEntry) return;
    // Reassemble the file from chunks
    const chunks = fileEntry.chunks;
    const blob = new Blob(chunks, { type: fileEntry.mimeType });
    fileEntry.blob = blob;
    delete fileEntry.chunks; // free memory
    self.postMessage({ type: 'sfa-remux-file-end-ack', id: msg.id, fileIndex: msg.fileIndex });
    // Check if all files are received
    const allFiles = self._remuxJob.files.filter(f => f && f.blob);
    if (allFiles.length === self._remuxJob.expectedFiles) {
      // All files ready, start remux
      await startRemux(self._remuxJob);
    }
    return;
  }

  if (msg.type === 'sfa-remux-finalize') {
    // If already remuxed, just reply with result
    if (self._remuxResult) {
      self.postMessage({ type: 'sfa-remux-result', ...self._remuxResult, id: msg.id });
    } else {
      // Trigger remux if not started
      await startRemux(self._remuxJob);
    }
    return;
  }
});

async function startRemux(job) {
  try {
    // Load FFmpeg.wasm
    const { createFFmpeg, fetchFile } = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
    const ffmpeg = createFFmpeg({ log: true });
    await ffmpeg.load();

    // Write all segment files into the virtual filesystem
    for (let i = 0; i < job.files.length; i++) {
      const file = job.files[i];
      if (!file || !file.blob) continue;
      const data = await file.blob.arrayBuffer();
      ffmpeg.FS('writeFile', file.name, new Uint8Array(data));
    }

    // Write the playlist file
    ffmpeg.FS('writeFile', job.playlistName, job.playlistText);

    // Run FFmpeg to concatenate and remux to MP4
    const outputName = job.outputName;
    const args = [
      '-y', // overwrite output
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
      '-i', job.playlistName,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputName
    ];
    await ffmpeg.run(...args);

    // Read the output file
    const data = ffmpeg.FS('readFile', outputName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });

    // Upload the result if uploadUrl is provided
    if (job.uploadUrl) {
      const uploadOk = await uploadBlob(job.uploadUrl, blob);
      if (!uploadOk) {
        throw new Error('Upload of remuxed file failed.');
      }
    }

    // Clean up
    ffmpeg.FS('unlink', job.playlistName);
    for (const file of job.files) {
      if (file && file.name) {
        try { ffmpeg.FS('unlink', file.name); } catch {}
      }
    }
    ffmpeg.FS('unlink', outputName);

    self._remuxResult = {
      ok: true,
      name: outputName,
      mimeType: 'video/mp4',
      uploaded: !!job.uploadUrl,
      status: 200
    };
    self.postMessage({ type: 'sfa-remux-result', ...self._remuxResult, id: job.id });
  } catch (err) {
    self._remuxResult = {
      ok: false,
      error: err.message || String(err)
    };
    self.postMessage({ type: 'sfa-remux-result-error', ...self._remuxResult, id: job.id });
  }
}

async function uploadBlob(uploadUrl, blob) {
  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: {
        'Content-Type': blob.type || 'video/mp4'
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}