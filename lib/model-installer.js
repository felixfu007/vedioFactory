// 從 Civitai 下載並安裝模型到 ComfyUI 的 models 資料夾。
// 只接受 .safetensors、下載後比對 SHA-256、不覆蓋既有檔案，並拒絕標示為成人內容、
// 真人肖像（poi）或涉及未成年人的模型。
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Civitai 模型類型 → ComfyUI models 子資料夾。
const TYPE_FOLDERS = {
  Checkpoint: 'checkpoints',
  LORA: 'loras',
  LoCon: 'loras',
  DoRA: 'loras',
  TextualInversion: 'embeddings',
  VAE: 'vae',
  Upscaler: 'upscale_models',
  Controlnet: 'controlnet',
};
const ALLOWED_FOLDERS = ['checkpoints', 'diffusion_models', 'loras', 'embeddings', 'vae', 'upscale_models', 'controlnet', 'text_encoders', 'clip_vision'];
const MAX_MODEL_BYTES = 64 * 1024 ** 3;
const DISK_HEADROOM_BYTES = 2 * 1024 ** 3;
const MAX_HISTORY = 200;

class InstallError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function formatBytes(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

// 接受 civitai.com/models/<id>[/<slug>][?modelVersionId=<id>] 與 civitai.com/api/download/models/<versionId>。
function parseCivitaiUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new InstallError('請貼上完整的 Civitai 網址，例如 https://civitai.com/models/12345。');
  }
  if (url.protocol !== 'https:' || !['civitai.com', 'www.civitai.com'].includes(url.hostname)) {
    throw new InstallError('只支援 https://civitai.com 的模型網址。');
  }
  const versionParam = url.searchParams.get('modelVersionId');
  const modelMatch = /^\/models\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const downloadMatch = /^\/api\/download\/models\/(\d+)\/?$/u.exec(url.pathname);
  if (modelMatch) {
    return { modelId: Number(modelMatch[1]), versionId: /^\d+$/u.test(versionParam || '') ? Number(versionParam) : null };
  }
  if (downloadMatch) return { modelId: null, versionId: Number(downloadMatch[1]) };
  throw new InstallError('看不懂這個網址；請貼上模型頁面網址，例如 https://civitai.com/models/12345。');
}

function sanitizeModelFileName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-+()[\] ]+/gu, '_').trim();
  if (!/\.safetensors$/iu.test(base) || base.length > 200 || base.startsWith('.')) {
    throw new InstallError('只接受 .safetensors 格式的模型檔。');
  }
  return base;
}

function createModelInstaller(options) {
  const {
    dataDir,
    modelsDir,
    apiOrigin = 'https://civitai.com',
    token = '',
    fetchImpl = fetch,
  } = options;
  const historyPath = path.join(dataDir, 'model-installs.json');
  const jobs = new Map();
  let queue = Promise.resolve();

  async function civitaiJson(apiPath) {
    let response;
    try {
      response = await fetchImpl(`${apiOrigin}/api/v1${apiPath}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new InstallError(`無法連線到 Civitai：${error.message}`, 502);
    }
    if (response.status === 404) throw new InstallError('Civitai 上找不到這個模型或版本。', 404);
    if (!response.ok) throw new InstallError(`Civitai 回應錯誤（HTTP ${response.status}）。`, 502);
    return response.json();
  }

  async function readHistory() {
    try {
      const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));
      return Array.isArray(history) ? history : [];
    } catch {
      return [];
    }
  }

  async function appendHistory(record) {
    const history = [record, ...await readHistory()].slice(0, MAX_HISTORY);
    await fs.mkdir(dataDir, { recursive: true });
    const temporaryPath = `${historyPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(history, null, 2));
    await fs.rename(temporaryPath, historyPath);
  }

  async function modelsDirAvailable() {
    return Boolean(modelsDir) && (await fs.stat(modelsDir).catch(() => null))?.isDirectory() === true;
  }

  // 解析網址並查詢 Civitai，回傳安裝前要給使用者確認的資訊（不下載）。
  async function preview(input, requestedFolder = '') {
    const { modelId, versionId } = parseCivitaiUrl(input);
    let model;
    let version;
    if (modelId) {
      model = await civitaiJson(`/models/${modelId}`);
      const versions = Array.isArray(model.modelVersions) ? model.modelVersions : [];
      version = versionId ? versions.find((item) => item.id === versionId) : versions[0];
      if (!version) throw new InstallError('找不到指定的模型版本。', 404);
    } else {
      version = await civitaiJson(`/model-versions/${versionId}`);
      model = await civitaiJson(`/models/${version.modelId}`);
    }

    // 安全防護：不自動安裝作者標示為成人內容、描繪特定真實人物（可能被用於冒充）或涉及未成年人的模型。
    const refusals = [];
    if (model.nsfw === true) refusals.push('作者標示為成人內容');
    if (model.poi === true) refusals.push('描繪特定真實人物（可能被用於冒充）');
    if (model.minor === true) refusals.push('涉及未成年人');
    if (refusals.length) {
      throw new InstallError(`此模型不提供自動安裝：${refusals.join('、')}。`, 403);
    }

    const files = Array.isArray(version.files) ? version.files : [];
    const safetensors = files.filter((file) => /\.safetensors$/iu.test(file.name || '') || file.metadata?.format === 'SafeTensor');
    const file = safetensors.find((item) => item.primary) || safetensors[0];
    if (!file) {
      throw new InstallError('這個版本沒有 .safetensors 檔；舊式 .ckpt／.pt 載入時可能執行程式碼，因此不提供自動安裝。');
    }
    if (file.pickleScanResult && file.pickleScanResult !== 'Success') {
      throw new InstallError(`Civitai 的安全掃描未通過（${file.pickleScanResult}），不安裝。`);
    }
    if (file.virusScanResult && file.virusScanResult !== 'Success') {
      throw new InstallError(`Civitai 的病毒掃描未通過（${file.virusScanResult}），不安裝。`);
    }
    const sha256 = String(file.hashes?.SHA256 || '').toLowerCase();
    if (!/^[\da-f]{64}$/u.test(sha256)) throw new InstallError('Civitai 沒有提供這個檔案的 SHA-256，無法驗證，不安裝。');

    const downloadUrl = new URL(file.downloadUrl || '');
    if (downloadUrl.origin !== new URL(apiOrigin).origin || !downloadUrl.pathname.startsWith('/api/download/')) {
      throw new InstallError('Civitai 回傳的下載網址不正確，不安裝。', 502);
    }
    const folder = requestedFolder || TYPE_FOLDERS[model.type];
    if (!folder) {
      throw new InstallError(`ComfyUI 沒有對應「${model.type}」類型的資料夾，請手動指定要安裝到哪個資料夾。`);
    }
    if (!ALLOWED_FOLDERS.includes(folder)) throw new InstallError(`不支援的安裝資料夾：${folder}。`);
    const sizeBytes = Math.round((Number(file.sizeKB) || 0) * 1024);
    if (sizeBytes > MAX_MODEL_BYTES) throw new InstallError(`檔案 ${formatBytes(sizeBytes)} 超過 64 GB 上限。`);

    const commercial = Array.isArray(model.allowCommercialUse)
      ? model.allowCommercialUse
      : [model.allowCommercialUse].filter((item) => typeof item === 'string' && item !== 'None');
    return {
      modelId: model.id,
      versionId: version.id,
      name: String(model.name || ''),
      versionName: String(version.name || ''),
      type: String(model.type || ''),
      baseModel: String(version.baseModel || ''),
      trainedWords: Array.isArray(version.trainedWords) ? version.trainedWords.filter((word) => typeof word === 'string') : [],
      fileName: sanitizeModelFileName(file.name),
      sizeBytes,
      sha256,
      downloadUrl: downloadUrl.toString(),
      folder,
      suggestedFolder: TYPE_FOLDERS[model.type] || '',
      license: {
        commercialUse: commercial,
        // Civitai 的 Image = 可商用產出的圖片／影片；Rent／Sell 為出租或販售模型本身。
        allowsCommercialOutputs: commercial.includes('Image'),
        allowNoCredit: model.allowNoCredit === true,
        allowDerivatives: model.allowDerivatives === true,
      },
      pageUrl: `https://civitai.com/models/${model.id}?modelVersionId=${version.id}`,
      modelsDirReady: await modelsDirAvailable(),
    };
  }

  function publicJob(job) {
    const { controller, ...rest } = job;
    return rest;
  }

  async function runDownload(job) {
    const targetDir = path.join(modelsDir, job.info.folder);
    const targetPath = path.join(targetDir, job.info.fileName);
    const partPath = `${targetPath}.${job.id.slice(0, 8)}.vediofactory-part`;
    job.status = 'downloading';
    try {
      await fs.mkdir(targetDir, { recursive: true });
      if (await fs.stat(targetPath).catch(() => null)) {
        throw new InstallError(`${job.info.folder}\\${job.info.fileName} 已存在，為避免覆蓋已停止安裝。`, 409);
      }
      const disk = await fs.statfs(targetDir).catch(() => null);
      if (disk && disk.bavail * disk.bsize < job.info.sizeBytes + DISK_HEADROOM_BYTES) {
        throw new InstallError(`磁碟空間不足：需要約 ${formatBytes(job.info.sizeBytes + DISK_HEADROOM_BYTES)}。`, 507);
      }
      const response = await fetchImpl(job.info.downloadUrl, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: job.controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new InstallError('這個模型需要登入 Civitai 才能下載：請在 .env 設定 VEDIO_FACTORY_CIVITAI_TOKEN（Civitai 帳號設定裡的 API Key）。', 401);
      }
      if (!response.ok || !response.body) throw new InstallError(`下載失敗（HTTP ${response.status}）。`, 502);
      job.progress.totalBytes = Number(response.headers.get('content-length')) || job.info.sizeBytes;
      const hash = crypto.createHash('sha256');
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          job.progress.receivedBytes += chunk.length;
          if (job.progress.receivedBytes > MAX_MODEL_BYTES) {
            callback(new InstallError('下載內容超過 64 GB 上限。', 413));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partPath, { flags: 'wx' }));
      job.status = 'verifying';
      const actual = hash.digest('hex');
      if (actual !== job.info.sha256) {
        throw new InstallError('下載的檔案 SHA-256 與 Civitai 紀錄不符，可能下載不完整或被竄改，已刪除。', 502);
      }
      await fs.rename(partPath, targetPath);
      job.status = 'installed';
      job.installedPath = targetPath;
      job.finishedAt = new Date().toISOString();
      const { downloadUrl, modelsDirReady, ...info } = job.info;
      await appendHistory({ ...info, installedPath: targetPath, installedAt: job.finishedAt });
    } catch (error) {
      await fs.rm(partPath, { force: true });
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.status === 'cancelled' ? '已取消。' : error.message;
      job.finishedAt = new Date().toISOString();
    }
  }

  async function install(input, requestedFolder = '') {
    if (!(await modelsDirAvailable())) {
      throw new InstallError(`找不到 ComfyUI 的 models 資料夾（${modelsDir || '未設定'}）；請設定 VEDIO_FACTORY_COMFYUI_MODELS_DIR。`, 503);
    }
    const info = await preview(input, requestedFolder);
    const duplicate = [...jobs.values()].find((job) => (
      ['queued', 'downloading', 'verifying'].includes(job.status)
      && job.info.versionId === info.versionId
      && job.info.folder === info.folder
    ));
    if (duplicate) throw new InstallError('這個模型已在下載中。', 409);
    const job = {
      id: crypto.randomUUID(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      info,
      progress: { receivedBytes: 0, totalBytes: info.sizeBytes },
      error: '',
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    // 一次只下載一個，避免佔滿頻寬與磁碟。
    queue = queue.then(() => (job.status === 'queued' ? runDownload(job) : undefined));
    return publicJob(job);
  }

  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new InstallError('找不到這個安裝工作。', 404);
    if (!['queued', 'downloading'].includes(job.status)) throw new InstallError('這個安裝工作已經結束。', 409);
    job.controller.abort();
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.error = '已取消。';
    }
    return publicJob(job);
  }

  async function list() {
    return {
      modelsDir,
      modelsDirReady: await modelsDirAvailable(),
      tokenConfigured: Boolean(token),
      jobs: [...jobs.values()].map(publicJob).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      installed: await readHistory(),
    };
  }

  return { preview, install, cancel, list, waitForIdle: () => queue };
}

module.exports = { createModelInstaller, parseCivitaiUrl, InstallError, ALLOWED_FOLDERS };
