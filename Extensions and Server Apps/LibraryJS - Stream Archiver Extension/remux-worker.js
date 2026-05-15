import * as Mb from './mediabunny/mediabunny.mjs';

(() => {
  const CHUNK_SIZE = 1024 * 1024;
  const PROGRESS_THROTTLE_MS = 120;
  const RESERVE_PACKET_MULTIPLIERS = {
    video: 10.0,
    audio: 16.0,
    subtitle: 24.0,
    text: 24.0,
    default: 12.0
  };
  const RESERVE_PACKET_PAD = {
    video: 4096,
    audio: 8192,
    subtitle: 12288,
    text: 12288,
    default: 6144
  };
  const RESERVE_PACKET_ALIGNMENT = 256;
  let lastProgressAt = 0;
  let lastProgressPct = -1;

  function postStatus(id, stage, detail = '') {
    self.postMessage({
      id: id ?? null,
      type: 'status',
      stage: String(stage || ''),
      detail: String(detail || '')
    });
  }

  function postError(id, error) {
    self.postMessage({
      id: id ?? null,
      type: 'error',
      error: String(error?.message || error || 'Remux failed.')
    });
  }

  function toUint8Array(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function chunkToBytes(chunk) {
    if (!chunk) return null;
    if (chunk.data) return toUint8Array(chunk.data);
    return toUint8Array(chunk);
  }

  function bytesToTransfer(bytes) {
    const out = bytes instanceof Uint8Array ? bytes : toUint8Array(bytes);
    if (!out || !out.byteLength) return null;
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }

  function blobFromFileEntry(entry) {
    if (!entry) return null;
    if (entry.blob instanceof Blob) return entry.blob;
    const bytes = chunkToBytes(entry.bytes || entry.data || entry.buffer || null);
    if (bytes) return new Blob([bytes], { type: String(entry.type || 'application/octet-stream') });
    return null;
  }

  function isTsLikeName(name) {
    return /(?:\.(?:ts|m2ts|mp2t))(?:$|[?#])/i.test(String(name || ''));
  }

  function isMp4LikeName(name) {
    return /(?:\.(?:mp4|m4v|mov|m4s))(?:$|[?#])/i.test(String(name || ''));
  }

  function normalizeMimeTypeHint(value) {
    const mime = String(value || '').trim().toLowerCase();
    if (!mime) return '';
    if (mime.startsWith('video/mp2t') || mime.startsWith('application/x-mpegurl')) return 'video/mp2t';
    if (mime.startsWith('video/mp4') || mime.startsWith('audio/mp4') || mime.startsWith('application/mp4')) return 'video/mp4';
    return mime;
  }

  function inferBlobType(file) {
    const explicit = normalizeMimeTypeHint(file?.mimeType || file?.type || file?.blob?.type || '');
    if (explicit) return explicit;
    const name = String(file?.name || '');
    if (isTsLikeName(name)) return 'video/mp2t';
    if (isMp4LikeName(name)) return 'video/mp4';
    return 'application/octet-stream';
  }

  function inferArchiveProfile(files, remuxMode = 'archive') {
    const ordered = Array.isArray(files)
      ? [...files].sort((a, b) => {
          const ai = Number.isFinite(Number(a?.fileIndex)) ? Number(a.fileIndex) : Number.MAX_SAFE_INTEGER;
          const bi = Number.isFinite(Number(b?.fileIndex)) ? Number(b.fileIndex) : Number.MAX_SAFE_INTEGER;
          if (ai !== bi) return ai - bi;
          return String(a?.name || '').localeCompare(String(b?.name || ''));
        })
      : [];

    const totalFiles = ordered.length;
    let tsLike = 0;
    let mp4Like = 0;
    let hintedMime = '';

    for (const file of ordered) {
      const mime = inferBlobType(file);
      if (!hintedMime && mime && mime !== 'application/octet-stream') hintedMime = mime;
      const name = String(file?.name || '');
      if (isTsLikeName(name) || mime === 'video/mp2t') tsLike += 1;
      if (isMp4LikeName(name) || mime === 'video/mp4') mp4Like += 1;
    }

    const bundleMode = String(remuxMode || (totalFiles > 1 ? 'archive' : 'direct')).toLowerCase();
    const likelyTs = tsLike > 0 && tsLike >= mp4Like;
    const likelyMp4 = mp4Like > 0 && mp4Like > tsLike;
    const sourceMimeType = likelyTs ? 'video/mp2t' : (likelyMp4 ? 'video/mp4' : hintedMime || 'application/octet-stream');

    const preferredFormats = likelyTs
      ? [Mb.MPEG_TS, Mb.MP4]
      : (likelyMp4
        ? [Mb.MP4, Mb.MPEG_TS]
        : Mb.ALL_FORMATS);

    const fallbackFormats = Mb.ALL_FORMATS;

    const planLabel = bundleMode === 'archive'
      ? (likelyTs ? 'Archive bundle detected as TS' : (likelyMp4 ? 'Archive bundle detected as MP4' : 'Archive bundle detected as generic media'))
      : (likelyTs ? 'Single source detected as TS' : (likelyMp4 ? 'Single source detected as MP4' : 'Single source detected as generic media'));

    const plans = [
      {
        label: `${planLabel} — preferred`,
        mimeType: sourceMimeType,
        formats: preferredFormats
      }
    ];

    const preferredSignature = JSON.stringify({
      mimeType: plans[0].mimeType,
      formats: (plans[0].formats || []).map((fmt) => fmt?.constructor?.name || String(fmt?.name || fmt || ''))
    });
    const fallbackSignature = JSON.stringify({
      mimeType: 'application/octet-stream',
      formats: (fallbackFormats || []).map((fmt) => fmt?.constructor?.name || String(fmt?.name || fmt || ''))
    });

    if (fallbackSignature !== preferredSignature) {
      plans.push({
        label: `${planLabel} — generic fallback`,
        mimeType: 'application/octet-stream',
        formats: fallbackFormats
      });
    }

    return { ordered, totalFiles, tsLike, mp4Like, sourceMimeType, plans, bundleMode, likelyTs, likelyMp4 };
  }

  function scoreTsSyncOffset(bytes, maxPacketsToCheck = 12) {
    if (!bytes || bytes.byteLength < 188) return { offset: -1, packetsChecked: 0, syncHits: 0 };
    const limitPackets = Math.max(1, Math.min(Number(maxPacketsToCheck) || 12, Math.floor(bytes.byteLength / 188)));
    let bestOffset = -1;
    let bestHits = 0;
    let bestPackets = 0;

    for (let offset = 0; offset < 188; offset += 1) {
      let hits = 0;
      let packetsChecked = 0;
      for (let i = 0; i < limitPackets; i += 1) {
        const pos = offset + (i * 188);
        if (pos >= bytes.byteLength) break;
        packetsChecked += 1;
        if (bytes[pos] === 0x47) hits += 1;
      }
      if (packetsChecked > 0 && (hits > bestHits || (hits === bestHits && packetsChecked > bestPackets))) {
        bestOffset = offset;
        bestHits = hits;
        bestPackets = packetsChecked;
      }
    }

    return { offset: bestOffset, packetsChecked: bestPackets, syncHits: bestHits };
  }

  async function normalizeTsBlob(blob, fileName = '') {
    const original = blobFromFileEntry({ blob });
    if (!(original instanceof Blob) || original.size < 188) {
      return { blob: original, changed: false, reason: 'too-small' };
    }

    const headBytes = new Uint8Array(await original.slice(0, Math.min(original.size, 188 * 32)).arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (!headBytes.byteLength) {
      return { blob: original, changed: false, reason: 'unreadable' };
    }

    const exactPacketAligned = original.size % 188 === 0 && headBytes[0] === 0x47;
    const score = scoreTsSyncOffset(headBytes, 12);
    const strongOffset = score.offset >= 0 && score.packetsChecked >= 4 && score.syncHits >= Math.max(4, Math.ceil(score.packetsChecked * 0.75));

    if (exactPacketAligned && score.offset === 0) {
      return { blob: original, changed: false, reason: 'aligned' };
    }

    if (!strongOffset && headBytes[0] !== 0x47) {
      return {
        blob: original,
        changed: false,
        reason: `ts-sync-unconfirmed${fileName ? `:${fileName}` : ''}`
      };
    }

    const offset = Math.max(0, score.offset);
    const alignedLength = Math.max(0, original.size - offset - ((original.size - offset) % 188));
    if (alignedLength < 188) {
      return { blob: original, changed: false, reason: 'insufficient-aligned-data' };
    }

    if (offset === 0 && original.size % 188 === 0 && headBytes[0] === 0x47) {
      return { blob: original, changed: false, reason: 'aligned' };
    }

    const trimmed = original.slice(offset, offset + alignedLength, 'video/mp2t');
    return {
      blob: trimmed,
      changed: offset > 0 || alignedLength !== original.size,
      reason: `resynced${offset > 0 ? `@${offset}` : ''}`
    };
  }

  async function buildCombinedBlob(files, typeHint = 'application/octet-stream', sourcePlan = null) {
    const ordered = Array.isArray(files)
      ? [...files].sort((a, b) => {
          const ai = Number.isFinite(Number(a?.fileIndex)) ? Number(a.fileIndex) : Number.MAX_SAFE_INTEGER;
          const bi = Number.isFinite(Number(b?.fileIndex)) ? Number(b.fileIndex) : Number.MAX_SAFE_INTEGER;
          if (ai !== bi) return ai - bi;
          return String(a?.name || '').localeCompare(String(b?.name || ''));
        })
      : [];
    const blobs = [];
    let normalizedCount = 0;
    const likelyTs = !!sourcePlan?.tsLike || normalizeMimeTypeHint(typeHint) === 'video/mp2t';

    for (const file of ordered) {
      let blob = blobFromFileEntry(file);
      if (!blob || !blob.size) continue;

      const fileName = String(file?.name || '');
      const fileMime = normalizeMimeTypeHint(file?.mimeType || file?.type || blob?.type || '');
      const shouldNormalizeTs = likelyTs && (isTsLikeName(fileName) || fileMime === 'video/mp2t' || file?.family === 'ts');
      if (shouldNormalizeTs) {
        const cleaned = await normalizeTsBlob(blob, fileName);
        if (cleaned?.blob instanceof Blob && cleaned.blob.size) {
          if (cleaned.changed) normalizedCount += 1;
          blob = cleaned.blob;
        }
      }

      blobs.push(blob);
    }

    if (!blobs.length) return { blob: null, normalizedCount: 0 };
    const mimeType = normalizeMimeTypeHint(typeHint) || normalizeMimeTypeHint(blobs[0]?.type) || 'application/octet-stream';
    const blob = blobs.length === 1 ? blobs[0] : new Blob(blobs, { type: mimeType });
    return { blob, normalizedCount };
  }

  function makeStreamTarget(postId) {
    let chunkIndex = 0;
    let sentBytes = 0;
    const writable = new WritableStream({
      write(chunk) {
        const bytes = chunkToBytes(chunk);
        if (!bytes || !bytes.byteLength) return;
        const transfer = bytesToTransfer(bytes);
        if (!transfer) return;

        sentBytes += bytes.byteLength;
        self.postMessage({
          id: postId ?? null,
          type: 'result-chunk',
          name: '',
          mimeType: '',
          chunkIndex,
          totalChunks: 0,
          byteLength: bytes.byteLength,
          position: Number(chunk?.position || sentBytes - bytes.byteLength) || 0,
          bytes: transfer
        }, [transfer]);
        chunkIndex += 1;
      }
    });

    return { writable, getChunkCount: () => chunkIndex };
  }

  async function yieldToEventLoop() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }


  function getTrackPacketRateHint(trackType = 'default') {
    const typeKey = String(trackType || 'default').toLowerCase();
    if (typeKey === 'video') return 60;
    if (typeKey === 'audio') return 100;
    if (typeKey === 'subtitle' || typeKey === 'text') return 6;
    return 60;
  }

  function estimateReservePacketBudget(packetCount, trackType = 'default', reserveBufferOverestimationPercent = 15) {
    const count = Number(packetCount);
    if (!Number.isFinite(count) || count <= 0) return 1;

    const typeKey = String(trackType || 'default').toLowerCase();
    const pad = Number(RESERVE_PACKET_PAD[typeKey] || RESERVE_PACKET_PAD.default);
    const overPct = Math.max(0, Number(reserveBufferOverestimationPercent) || 0);
    const overFactor = 1 + (overPct / 100);

    // The metadata value is a packet-count ceiling, not a byte reserve.
    // Keep a meaningful but still conservative headroom margin.
    const scaled = Math.ceil(count * overFactor) + pad;
    const aligned = Math.ceil(scaled / RESERVE_PACKET_ALIGNMENT) * RESERVE_PACKET_ALIGNMENT;
    return Math.max(1, aligned);
  }

  async function estimateTrackPacketBudget(jobId, inputTrack, reserveBufferOverestimationPercent = 15) {
    if (!inputTrack) return 1;

    const label = `${String(inputTrack?.type || 'track')} #${Number(inputTrack?.number || 0) || '?'}`;
    let stats = null;
    let duration = null;

    try {
      duration = await inputTrack.computeDuration();
    } catch {}

    try {
      // A full scan is still the most accurate packet-count input when available.
      stats = await inputTrack.computePacketStats();
    } catch (error) {
      postStatus(jobId, 'Sizing reserve window', `Falling back to duration estimate for ${label}`);
    }

    const packetCount = Number(stats?.packetCount);
    if (Number.isFinite(packetCount) && packetCount > 0) {
      return {
        packetCount,
        budget: estimateReservePacketBudget(packetCount, inputTrack?.type, reserveBufferOverestimationPercent),
        source: 'packet-stats'
      };
    }

    const rateHint = getTrackPacketRateHint(inputTrack?.type);
    const durationSeconds = Number(duration);
    const estimatedCount = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.max(1, Math.ceil(durationSeconds * rateHint))
      : 1;

    return {
      packetCount: estimatedCount,
      budget: estimateReservePacketBudget(estimatedCount, inputTrack?.type, reserveBufferOverestimationPercent),
      source: 'duration-estimate'
    };
  }

  async function applyReservePacketBudgets(jobId, conversion, reserveBufferOverestimationPercent = 15) {
    const utilizedTracks = Array.isArray(conversion?.utilizedTracks) ? conversion.utilizedTracks : [];
    const outputTracks = Array.isArray(conversion?.output?._tracks) ? conversion.output._tracks : [];

    if (!outputTracks.length) {
      throw new Error('No output tracks were found for reserve sizing.');
    }

    for (let i = 0; i < outputTracks.length; i += 1) {
      const inputTrack = utilizedTracks[i] || outputTracks[i];
      const outputTrack = outputTracks[i];
      const label = `${String(inputTrack?.type || outputTrack?.type || 'track')} #${Number(inputTrack?.number || outputTrack?.id || i + 1)}`;

      postStatus(jobId, 'Sizing reserve window', `Scanning ${label}`);
      await yieldToEventLoop();

      const estimate = await estimateTrackPacketBudget(jobId, inputTrack, reserveBufferOverestimationPercent);
      if (!outputTrack || !outputTrack.metadata) {
        throw new Error(`Could not access output metadata for ${label}.`);
      }
      outputTrack.metadata.maximumPacketCount = estimate.budget;
      postStatus(jobId, 'Sizing reserve window', `${label}: ${estimate.packetCount} packets (${estimate.source}) → reserve ${estimate.budget}`);
      await yieldToEventLoop();
    }
  }

  async function remuxFiles(job) {
    const outputName = String(job.outputName || 'compiled.mp4');
    const wantsTs = /\.(?:ts|m2ts|mp2t)$/i.test(outputName);
    const reserveBufferOverestimationPercent = Math.max(0, Number(job?.reserveBufferOverestimationPercent ?? 15) || 0);
    const sourcePlan = inferArchiveProfile(job.files, job?.mode || (Array.isArray(job.files) && job.files.length > 1 ? 'archive' : 'direct'));

    postStatus(job.id, 'Preparing input', `Combining ${sourcePlan.totalFiles} file${sourcePlan.totalFiles === 1 ? '' : 's'}${sourcePlan.bundleMode === 'archive' ? ' as archive bundle' : ''}`);
    await yieldToEventLoop();

    const combined = await buildCombinedBlob(job.files, sourcePlan.sourceMimeType, sourcePlan);
    const sourceBlob = combined?.blob || null;

    if (!sourceBlob || !sourceBlob.size) {
      throw new Error('No media files were provided to remux.');
    }

    if (combined?.normalizedCount > 0) {
      postStatus(job.id, 'Preparing input', `Normalized ${combined.normalizedCount} TS segment${combined.normalizedCount === 1 ? '' : 's'} to packet boundaries`);
      await yieldToEventLoop();
    }

    postStatus(job.id, 'Preparing input', `${Math.round(sourceBlob.size / (1024 * 1024)) || 0} MB`);
    await yieldToEventLoop();

    const { writable, getChunkCount } = makeStreamTarget(job.id);
    const format = wantsTs
      ? new Mb.MpegTsOutputFormat()
      : new Mb.Mp4OutputFormat({ fastStart: 'reserve' });

    const candidatePlans = Array.isArray(sourcePlan.plans) && sourcePlan.plans.length
      ? sourcePlan.plans
      : [{ label: 'Generic media scan', mimeType: 'application/octet-stream', formats: Mb.ALL_FORMATS }];

    let selected = null;
    let lastError = null;

    for (let i = 0; i < candidatePlans.length; i += 1) {
      const plan = candidatePlans[i];
      const planLabel = `${plan.label}${i > 0 ? ' (retry)' : ''}`;
      const input = new Mb.Input({
        source: new Mb.BlobSource(sourceBlob, { maxCacheSize: 8 * 1024 * 1024 }),
        formats: Array.isArray(plan.formats) && plan.formats.length ? plan.formats : Mb.ALL_FORMATS
      });
      const output = new Mb.Output({
        format,
        target: new Mb.StreamTarget(writable, { chunked: true, chunkSize: CHUNK_SIZE })
      });

      postStatus(job.id, 'Validating input', planLabel);
      await yieldToEventLoop();

      try {
        const conversion = await Mb.Conversion.init({ input, output });
        if (!conversion.isValid) {
          const discarded = Array.isArray(conversion.discardedTracks)
            ? conversion.discardedTracks.map((track) => `${track?.track?.type || 'track'}${track?.reason ? `: ${track.reason}` : ''}`).join('; ')
            : '';
          throw new Error(discarded ? `Media cannot be remuxed: ${discarded}` : 'Media cannot be remuxed with the current browser codec support.');
        }

        selected = { input, output, conversion, planLabel };
        break;
      } catch (error) {
        lastError = error;
        try { input.dispose(); } catch {}
      }
    }

    if (!selected) {
      throw lastError || new Error('Input has an unsupported or unrecognizable format.');
    }

    const { input, output, conversion, planLabel } = selected;
    try {
      if (!wantsTs) {
        await applyReservePacketBudgets(job.id, conversion, reserveBufferOverestimationPercent);
      }

      conversion.onProgress = (progress) => {
        const pct = Math.max(0, Math.min(100, Math.round((Number(progress) || 0) * 100)));
        const now = Date.now();
        if (pct === lastProgressPct && now - lastProgressAt < PROGRESS_THROTTLE_MS && pct < 100) return;
        lastProgressPct = pct;
        lastProgressAt = now;
        postStatus(job.id, 'Remuxing', `${pct}%`);
      };

      postStatus(job.id, 'Remuxing', planLabel);
      await yieldToEventLoop();
      postStatus(job.id, 'Remuxing', 'Executing remux');
      await conversion.execute();

      postStatus(job.id, 'Finalizing', 'Flushing output');
      await yieldToEventLoop();
      const resultMimeType = String(output.format?.mimeType || (wantsTs ? 'video/mp2t' : 'video/mp4') || 'application/octet-stream');
      const chunkCount = getChunkCount();

      self.postMessage({
        id: job.id ?? null,
        type: 'result-done',
        name: outputName,
        mimeType: resultMimeType,
        byteLength: 0,
        totalChunks: Math.max(1, chunkCount)
      });
    } finally {
      try { input.dispose(); } catch {}
    }
  }

  async function generatePlaceholder(job) {
    const outputName = String(job.outputName || (String(job.family || '').toLowerCase() === 'ts' ? 'gap.ts' : 'gap.mp4'));
    const wantsTs = /\.(?:ts|m2ts|mp2t)$/i.test(outputName) || String(job.family || '').toLowerCase() === 'ts';
    const width = 1280;
    const height = 720;
    const duration = Math.max(0.25, Math.min(30, Number(job.duration) || 1));
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : null;

    if (!canvas) {
      throw new Error('Placeholder generation requires OffscreenCanvas in this browser context.');
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create a canvas context for placeholder generation.');
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const targetBlobType = wantsTs ? 'video/mp2t' : 'video/mp4';
    const format = wantsTs
      ? new Mb.MpegTsOutputFormat()
      : new Mb.Mp4OutputFormat({ fastStart: 'reserve' });

    const output = new Mb.Output({
      format,
      target: new Mb.BufferTarget()
    });

    const videoSource = new Mb.CanvasSource(canvas, {
      codec: 'avc',
      bitrate: 750_000
    });

    output.addVideoTrack(videoSource);
    postStatus(job.id, 'Generating placeholder', 'Encoding');
    await output.start();
    await videoSource.add(0, duration);
    await output.finalize();

    const bytes = toUint8Array(output.target.buffer);
    if (!bytes || !bytes.byteLength) {
      throw new Error('Placeholder generation produced an empty output.');
    }

    const transfer = bytesToTransfer(bytes);
    if (!transfer) {
      throw new Error('Could not transfer placeholder bytes.');
    }

    self.postMessage({
      id: job.id ?? null,
      type: 'result-chunk',
      name: outputName,
      mimeType: String(output.format?.mimeType || targetBlobType),
      chunkIndex: 0,
      totalChunks: 1,
      byteLength: bytes.byteLength,
      position: 0,
      bytes: transfer
    }, [transfer]);

    self.postMessage({
      id: job.id ?? null,
      type: 'result-done',
      name: outputName,
      mimeType: String(output.format?.mimeType || targetBlobType),
      byteLength: bytes.byteLength,
      totalChunks: 1
    });
  }

  self.onmessage = async (event) => {
    const msg = event?.data || {};
    const id = msg.id ?? null;

    try {
      if (msg.type === 'remux') {
        await remuxFiles({
          id,
          baseUrl: msg.baseUrl,
          playlistName: msg.playlistName,
          outputName: msg.outputName,
          playlistText: msg.playlistText,
          segmentMeta: Array.isArray(msg.segmentMeta) ? msg.segmentMeta : [],
          mode: String(msg.mode || 'archive'),
          files: Array.isArray(msg.files) ? msg.files : []
        });
        return;
      }

      if (msg.type === 'placeholder') {
        await generatePlaceholder({
          id,
          baseUrl: msg.baseUrl,
          outputName: msg.outputName,
          duration: Number(msg.duration || 0) || 1,
          family: msg.family || 'ts',
          quality: msg.quality || '',
          resolution: msg.resolution || ''
        });
        return;
      }

      throw new Error(`Unknown remux worker message type: ${String(msg.type || '')}`);
    } catch (err) {
      postError(id, err);
    }
  };
})();
