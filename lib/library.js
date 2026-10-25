const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  createRequestError,
  execFileAsync,
  fileExists,
  getContentType,
  sendText,
} = require('./utils.js');
const {
  VIDEO_EXTENSION_PATTERN,
  sanitizeFileName,
  validateVideoMetadata,
} = require('./validation.js');

const MAX_VIDEO_METADATA_BYTES = 32 * 1024 * 1024;
const FFMPEG_DETECTION_TTL_MS = 30_000;

async function receiveVideoUpload(request, temporaryPath, maxBytes) {
  const iterator = request[Symbol.asyncIterator]();
  let prefix = Buffer.alloc(0);
  while (prefix.length < 4) {
    const { value, done } = await iterator.next();
    if (done) throw createRequestError('影片上傳缺少 metadata。');
    prefix = Buffer.concat([prefix, value]);
  }
  const metadataLength = prefix.readUInt32BE(0);
  if (!metadataLength || metadataLength > MAX_VIDEO_METADATA_BYTES) {
    request.resume();
    throw createRequestError('影片 metadata 過大或格式錯誤。', metadataLength > MAX_VIDEO_METADATA_BYTES ? 413 : 400);
  }

  let metadataBuffer = prefix.subarray(4);
  while (metadataBuffer.length < metadataLength) {
    const { value, done } = await iterator.next();
    if (done) throw createRequestError('影片上傳的 metadata 不完整。');
    metadataBuffer = Buffer.concat([metadataBuffer, value]);
  }
  let metadata;
  try {
    metadata = validateVideoMetadata(JSON.parse(metadataBuffer.subarray(0, metadataLength).toString('utf8')));
  } catch (error) {
    request.resume();
    if (error instanceof SyntaxError) throw createRequestError('影片 metadata 格式錯誤。');
    throw error;
  }
  const firstVideoChunk = metadataBuffer.subarray(metadataLength);

  let size = 0;
  const sizeLimiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(createRequestError('影片檔案過大。', 413));
        return;
      }
      callback(null, chunk);
    },
  });

  async function* videoChunks() {
    if (firstVideoChunk.length) yield firstVideoChunk;
    for await (const chunk of iterator) yield chunk;
  }

  await pipeline(Readable.from(videoChunks()), sizeLimiter, createWriteStream(temporaryPath, { flags: 'wx' }));
  if (size === 0) {
    throw createRequestError('影片檔案不可為空。');
  }
  return { fileSize: size, metadata };
}

async function collectVideoItems(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_EXTENSION_PATTERN.test(entry.name.replace(/\.json$/u, ''))) continue;
    try {
      const metadataPath = path.join(outputDir, entry.name);
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      const fileName = sanitizeFileName(metadata.fileName || entry.name.replace(/\.json$/u, ''));
      const videoPath = path.join(outputDir, fileName);
      if (!(await fileExists(videoPath))) continue;
      const stats = await fs.stat(videoPath);
      items.push({
        ...metadata,
        fileName,
        format: path.extname(fileName).slice(1).toLowerCase(),
        fileSize: stats.size,
        previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
      });
    } catch {
      continue;
    }
  }

  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return items;
}

// 輸出資料夾內的影片庫：每部影片一個影片檔加同名 .json metadata。
function createVideoLibrary({ getOutputDir, ffmpegCommand, maxVideoUploadBytes }) {
  let ffmpegDetection = null;
  let transcodeQueue = Promise.resolve();
  const renameLocks = new Map();

  async function ensureOutputDir() {
    await fs.mkdir(getOutputDir(), { recursive: true });
  }

  async function withRenameLocks(lockKeys, operation) {
    const normalizedKeys = [...new Set(lockKeys)].sort();
    const previousLocks = normalizedKeys.map((lockKey) => renameLocks.get(lockKey) || Promise.resolve());
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    normalizedKeys.forEach((lockKey, index) => {
      renameLocks.set(lockKey, previousLocks[index].then(() => current));
    });

    await Promise.all(previousLocks);
    try {
      return await operation();
    } finally {
      release();
      normalizedKeys.forEach((lockKey) => {
        if (renameLocks.get(lockKey) === current) {
          renameLocks.delete(lockKey);
        }
      });
    } 
  }

  async function saveVideoAsset(item, videoBase64) {
    validateVideoMetadata(item);
    const fileName = sanitizeFileName(item.fileName);
    const videoPath = path.join(getOutputDir(), fileName);
    const metadataPath = path.join(getOutputDir(), `${fileName}.json`);
    const buffer = Buffer.from(videoBase64, 'base64');
    const persistedItem = {
      ...item,
      fileName,
    };

    await ensureOutputDir();
    await fs.writeFile(videoPath, buffer);
    await fs.writeFile(metadataPath, JSON.stringify(persistedItem, null, 2));

    return {
      ...persistedItem,
      fileSize: buffer.length,
      previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
    };
  }

  async function saveStreamedVideoAsset(request) {
    await ensureOutputDir();
    const temporaryToken = crypto.randomUUID();
    const temporaryVideoPath = path.join(getOutputDir(), `.${temporaryToken}.upload`);
    const temporaryMetadataPath = path.join(getOutputDir(), `.${temporaryToken}.json`);
    try {
      const { fileSize, metadata: item } = await receiveVideoUpload(request, temporaryVideoPath, maxVideoUploadBytes);
      const fileName = sanitizeFileName(item.fileName);
      const videoPath = path.join(getOutputDir(), fileName);
      const metadataPath = path.join(getOutputDir(), `${fileName}.json`);
      const persistedItem = { ...item, fileName };
      await fs.writeFile(temporaryMetadataPath, JSON.stringify(persistedItem, null, 2), { flag: 'wx' });
      await fs.rename(temporaryVideoPath, videoPath);
      await fs.rename(temporaryMetadataPath, metadataPath);

      return {
        ...persistedItem,
        fileSize,
        previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
      };
    } catch (error) {
      await Promise.all([
        fs.rm(temporaryVideoPath, { force: true }),
        fs.rm(temporaryMetadataPath, { force: true }),
      ]);
      throw error;
    }
  }

  function runFfmpeg(args, execOptions = {}) {
    return execFileAsync(ffmpegCommand[0], [...ffmpegCommand.slice(1), ...args], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      ...execOptions,
    });
  }

  async function detectFfmpeg() {
    if (!ffmpegDetection || Date.now() - ffmpegDetection.checkedAt > FFMPEG_DETECTION_TTL_MS) {
      const result = await runFfmpeg(['-hide_banner', '-version'], { timeout: 5_000 }).then(
        ({ stdout }) => ({ available: true, version: stdout.split(/\r?\n/u)[0].trim().slice(0, 200) }),
        () => ({ available: false, version: '' }),
      );
      ffmpegDetection = { ...result, checkedAt: Date.now() };
    }
    return { available: ffmpegDetection.available, version: ffmpegDetection.version };
  }

  async function transcodeVideoToMp4(fileName) {
    const source = sanitizeFileName(fileName);
    const sourcePath = path.join(getOutputDir(), source);
    const sourceMetadataPath = `${sourcePath}.json`;
    if (!(await fileExists(sourcePath)) || !(await fileExists(sourceMetadataPath))) {
      throw createRequestError('找不到要轉檔的影片。', 404);
    }
    if (path.extname(source).toLowerCase() === '.mp4') throw createRequestError('影片已是 MP4。', 409);
    if (!(await detectFfmpeg()).available) {
      throw createRequestError('找不到 ffmpeg：請安裝 ffmpeg 並加入 PATH，或設定 VEDIO_FACTORY_FFMPEG。', 503);
    }

    // One transcode at a time keeps CPU/GPU free for inference.
    const run = transcodeQueue.then(async () => {
      const baseName = source.slice(0, -path.extname(source).length);
      let targetName = sanitizeFileName(`${baseName}.mp4`);
      for (let suffix = 1; await fileExists(path.join(getOutputDir(), targetName)); suffix += 1) {
        targetName = sanitizeFileName(`${baseName}-${suffix}.mp4`);
      }
      const targetPath = path.join(getOutputDir(), targetName);
      const temporaryPath = path.join(getOutputDir(), `.${crypto.randomUUID()}.transcode`);
      try {
        await runFfmpeg([
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', sourcePath,
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          '-f', 'mp4', temporaryPath,
        ], { timeout: 30 * 60_000 });
        await fs.rename(temporaryPath, targetPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        const details = String(error.stderr || error.message || '').trim().slice(0, 1_000);
        throw createRequestError(`ffmpeg 轉檔失敗：${details || '未知錯誤'}`, 500);
      }
      const metadata = JSON.parse(await fs.readFile(sourceMetadataPath, 'utf8'));
      const transcoded = {
        ...metadata,
        id: crypto.randomUUID(),
        fileName: targetName,
        format: 'mp4',
        transcodedFrom: source,
        createdAt: new Date().toISOString(),
      };
      delete transcoded.updatedAt;
      await fs.writeFile(`${targetPath}.json`, JSON.stringify(transcoded, null, 2));
      const stats = await fs.stat(targetPath);
      return { ...transcoded, fileSize: stats.size, previewUrl: `/api/videos/${encodeURIComponent(targetName)}` };
    });
    transcodeQueue = run.catch(() => undefined);
    return run;
  }

  async function streamVideo(request, response, requestUrl, fileName) {
    const videoPath = path.join(getOutputDir(), fileName);
    if (!(await fileExists(videoPath))) {
      return sendText(response, 404, 'Not found');
    }
    const { size } = await fs.stat(videoPath);
    const headers = { 'content-type': getContentType(videoPath), 'accept-ranges': 'bytes' };
    if (requestUrl.searchParams.get('download') === '1') {
      const asciiName = fileName.replace(/[^\x20-\x7e]|"/gu, '_');
      headers['content-disposition'] = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }
    const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range || '');
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` });
        response.end();
        return;
      }
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(Math.max(end - start + 1, 0));
    response.writeHead(range && (range[1] || range[2]) ? 206 : 200, headers);
    if (size === 0) {
      response.end();
      return;
    }
    await pipeline(createReadStream(videoPath, { start, end }), response);
    return;
  }

  async function renameVideo(fileName, nextFileName) {
    const videoPath = path.join(getOutputDir(), fileName);
    const metadataPath = path.join(getOutputDir(), `${fileName}.json`);
    if (path.extname(nextFileName).toLowerCase() !== path.extname(fileName).toLowerCase()) {
      throw createRequestError('重新命名不可變更影片副檔名。');
    }
    const nextVideoPath = path.join(getOutputDir(), nextFileName);
    const nextMetadataPath = path.join(getOutputDir(), `${nextFileName}.json`);
    return withRenameLocks([fileName, nextFileName], async () => {
      if (!(await fileExists(videoPath)) || !(await fileExists(metadataPath))) {
        throw createRequestError('找不到要重新命名的影片。', 404);
      }
      if (nextFileName === fileName) {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        return {
          ...metadata,
          fileName,
          previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
        };
      }
      if ((await fileExists(nextVideoPath)) || (await fileExists(nextMetadataPath))) {
        throw createRequestError('目標檔名已存在。', 409);
      }
      const originalMetadataText = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(originalMetadataText);
      metadata.fileName = nextFileName;
      metadata.updatedAt = new Date().toISOString();
      await fs.rename(videoPath, nextVideoPath);
      try {
        await fs.rename(metadataPath, nextMetadataPath).catch(async () => {
          await fs.writeFile(nextMetadataPath, JSON.stringify(metadata, null, 2));
          await fs.rm(metadataPath, { force: true });
        });
        await fs.writeFile(nextMetadataPath, JSON.stringify(metadata, null, 2));
      } catch (error) {
        await fs.rename(nextVideoPath, videoPath).catch(() => undefined);
        if (await fileExists(nextMetadataPath)) {
          await fs.rename(nextMetadataPath, metadataPath).catch(async () => {
            await fs.writeFile(metadataPath, originalMetadataText);
            await fs.rm(nextMetadataPath, { force: true });
          });
        } else if (!(await fileExists(metadataPath))) {
          await fs.writeFile(metadataPath, originalMetadataText).catch(() => undefined);
        }
        throw error;
      }
      return {
        ...metadata,
        previewUrl: `/api/videos/${encodeURIComponent(nextFileName)}`,
      };
    });
  }

  async function deleteVideo(fileName) {
    await fs.rm(path.join(getOutputDir(), fileName), { force: true });
    await fs.rm(path.join(getOutputDir(), `${fileName}.json`), { force: true });
  }

  return {
    ensureOutputDir,
    listVideos: () => collectVideoItems(getOutputDir()),
    saveVideoAsset,
    saveStreamedVideoAsset,
    detectFfmpeg,
    transcodeVideoToMp4,
    streamVideo,
    renameVideo,
    deleteVideo,
  };
}

module.exports = {
  collectVideoItems,
  createVideoLibrary,
};
