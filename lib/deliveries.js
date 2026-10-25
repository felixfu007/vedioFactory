const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DELIVERIES_DIR_NAME } = require('./config.js');
const { collectVideoItems } = require('./library.js');
const {
  createRequestError,
  fileExists,
  hashFile,
  isPlainObject,
} = require('./utils.js');
const {
  readOptionalText,
  sanitizeFileName,
  sanitizeFolderName,
  validateProjectTags,
} = require('./validation.js');

const DELIVERY_SCHEMA_VERSION = 1;
const MAX_DELIVERY_ITEMS = 500;

// 交付資料夾：deliveries/<客戶>/<專案>/<時間>/，含影片、來源圖片與可重新產出的 manifest.json。
function createDeliveryService({ getOutputDir, inference }) {
  const { getSourceImagesDir, listInferenceJobs, rerunFromRecord } = inference;

  async function createDelivery(payload) {
    if (!isPlainObject(payload)) throw createRequestError('交付資料格式錯誤。');
    const { client, project } = validateProjectTags(payload);
    const { fileNames } = payload;
    if (fileNames !== undefined && (
      !Array.isArray(fileNames)
      || !fileNames.length
      || fileNames.length > MAX_DELIVERY_ITEMS
      || fileNames.some((name) => typeof name !== 'string')
    )) {
      throw createRequestError(`fileNames 必須是 1 至 ${MAX_DELIVERY_ITEMS} 個檔名的陣列。`);
    }
    if (!fileNames && !client && !project) throw createRequestError('請指定客戶、專案或影片檔名。');

    const items = await collectVideoItems(getOutputDir());
    const selected = fileNames
      ? [...new Set(fileNames.map(sanitizeFileName))].map((fileName) => {
        const item = items.find((candidate) => candidate.fileName === fileName);
        if (!item) throw createRequestError(`找不到影片：${fileName}。`, 404);
        return item;
      })
      : items.filter((item) => (!client || item.client === client) && (!project || item.project === project));
    if (!selected.length) throw createRequestError('沒有符合條件的影片。', 404);
    if (selected.length > MAX_DELIVERY_ITEMS) {
      throw createRequestError(`單次交付最多 ${MAX_DELIVERY_ITEMS} 部影片。`);
    }

    const jobsById = new Map((await listInferenceJobs()).map((job) => [job.id, job]));
    const createdAt = new Date().toISOString();
    const deliveryDir = path.join(
      getOutputDir(),
      DELIVERIES_DIR_NAME,
      sanitizeFolderName(client, '未指定客戶'),
      sanitizeFolderName(project, '未指定專案'),
      `${createdAt.replace(/[:.]/gu, '-')}-${crypto.randomUUID().slice(0, 8)}`,
    );
    await fs.mkdir(path.join(deliveryDir, 'videos'), { recursive: true });

    const manifestItems = [];
    for (const item of selected) {
      const { fileSize, previewUrl, ...metadata } = item;
      await fs.copyFile(path.join(getOutputDir(), item.fileName), path.join(deliveryDir, 'videos', item.fileName));
      const job = item.inferenceJobId ? jobsById.get(item.inferenceJobId) : null;
      if (job?.sourceImage?.fileName) {
        const sourcePath = path.join(getSourceImagesDir(), path.basename(job.sourceImage.fileName));
        if (await fileExists(sourcePath)) {
          await fs.mkdir(path.join(deliveryDir, 'sources'), { recursive: true });
          await fs.copyFile(sourcePath, path.join(deliveryDir, 'sources', path.basename(job.sourceImage.fileName)));
        }
      }
      let reproduction = { type: 'canvas', spec: metadata };
      if (job) {
        const { manifestPath, ...jobRecord } = job;
        reproduction = { type: 'comfyui', job: jobRecord };
      } else if (item.inferenceJobId) {
        reproduction = { type: 'unavailable', reason: '找不到對應的推論工作記錄。' };
      }
      manifestItems.push({
        fileName: item.fileName,
        path: `videos/${item.fileName}`,
        size: fileSize,
        sha256: await hashFile(path.join(deliveryDir, 'videos', item.fileName)),
        metadata,
        reproduction,
      });
    }
    const manifest = {
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      generator: 'vedioFactory',
      createdAt,
      client,
      project,
      itemCount: manifestItems.length,
      items: manifestItems,
    };
    const manifestPath = path.join(deliveryDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return { deliveryPath: deliveryDir, manifestPath, itemCount: manifestItems.length };
  }

  async function replayDelivery(payload) {
    if (!isPlainObject(payload)) throw createRequestError('重新產出資料格式錯誤。');
    const deliveriesRoot = path.join(getOutputDir(), DELIVERIES_DIR_NAME);
    const manifestPath = path.resolve(readOptionalText(payload, 'manifestPath', 'manifestPath', 4_096));
    const relativePath = path.relative(deliveriesRoot, manifestPath);
    if (path.basename(manifestPath) !== 'manifest.json'
      || !relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw createRequestError('manifestPath 必須是輸出資料夾 deliveries 內的 manifest.json。');
    }
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      throw createRequestError('無法讀取交付 manifest。', 404);
    }
    const index = Number(payload.index ?? 0);
    const item = Number.isInteger(index) && Array.isArray(manifest?.items) ? manifest.items[index] : null;
    if (!item) throw createRequestError('交付 manifest 中找不到指定項目。', 404);
    if (item.reproduction?.type !== 'comfyui' || !isPlainObject(item.reproduction.job)) {
      throw createRequestError('此項目不是 ComfyUI 產出；Canvas 影片請在影片庫使用「以相同設定重新產出」。', 409);
    }
    const job = item.reproduction.job;
    validateProjectTags(job);
    if (job.sourceImage?.fileName) {
      const fileName = path.basename(String(job.sourceImage.fileName));
      const storedPath = path.join(getSourceImagesDir(), fileName);
      const deliveredPath = path.join(path.dirname(manifestPath), 'sources', fileName);
      if (!(await fileExists(storedPath)) && await fileExists(deliveredPath)) {
        await fs.mkdir(getSourceImagesDir(), { recursive: true });
        await fs.copyFile(deliveredPath, storedPath);
      }
    }
    return rerunFromRecord(job);
  }

  return {
    createDelivery,
    replayDelivery,
  };
}

module.exports = { createDeliveryService };
