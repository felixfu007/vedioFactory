const http = require('node:http');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { URL } = require('node:url');
const {
  BASE_CAPABILITIES,
  isResolutionAllowed,
  describeCustomRules,
  narrowCapabilities,
} = require('./assets/capabilities.js');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const ROOT_DIR = __dirname;
const DEFAULT_OUTPUT_DIR = path.resolve(
  process.env.VEDIO_FACTORY_OUTPUT_DIR || path.join(os.homedir(), 'Videos', 'vedioFactory'),
);
const DEFAULT_MODEL_DIR = path.resolve(
  process.env.VEDIO_FACTORY_MODEL_DIR || path.join(os.homedir(), 'vedioFactory', 'models'),
);
const DEFAULT_DATA_DIR = path.resolve(
  process.env.VEDIO_FACTORY_DATA_DIR || path.join(os.homedir(), 'vedioFactory'),
);
const PRESETS_DIR_NAME = 'presets';
const DEFAULT_WORKFLOWS_DIR = path.resolve(process.env.VEDIO_FACTORY_WORKFLOWS_DIR || path.join(__dirname, 'workflows'));
const WORKFLOW_ID_PATTERN = /^[\w.-]{1,80}$/u;
const WORKFLOW_META_SUFFIX = '.vf.json';
const MAX_WORKFLOW_META_BYTES = 64 * 1024;
const PRESET_SCHEMA_VERSION = 1;
const MAX_PRESETS_PER_IMPORT = 500;
const MAX_TAG_LENGTH = 100;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
const MAX_JSON_BODY = 80 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_METADATA_BYTES = 32 * 1024 * 1024;
const INFERENCE_JOBS_DIR_NAME = 'inference-jobs';
const MODEL_SETUP_DIR_NAME = 'model-setup';
const MAX_COMFY_WORKFLOW_BYTES = 10 * 1024 * 1024;
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const SOURCE_IMAGES_DIR_NAME = 'sources';
const SOURCE_IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const MODEL_CATALOG = [
  {
    id: 'sdxl',
    name: 'SDXL',
    category: 'image-generation',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 1,
    recommended: true,
    bestFor: ['文生圖', '圖生圖', 'ControlNet 擴充'],
    notes: '作為首幀、關鍵影格與風格基底模型。',
    windowsProfile: {
      runtime: 'ComfyUI / ONNX / Diffusers',
      vramHint: '建議 8GB+ VRAM',
    },
  },
  {
    id: 'animatediff',
    name: 'AnimateDiff',
    category: 'image-to-video',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 2,
    recommended: true,
    bestFor: ['照片轉短片', '鏡頭微動態', '角色動畫延展'],
    notes: '承接 SDXL 或 SD 影像輸出，補上短片運動能力。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '建議 10GB+ VRAM',
    },
  },
  {
    id: 'realesrgan',
    name: 'Real-ESRGAN',
    category: 'upscaling',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 3,
    recommended: true,
    bestFor: ['放大', '修復細節', '輸出畫質增強'],
    notes: '作為影片與單張影格後處理。',
    windowsProfile: {
      runtime: 'NCNN / PyTorch',
      vramHint: '建議 4GB+ VRAM',
    },
  },
  {
    id: 'rife',
    name: 'RIFE',
    category: 'frame-interpolation',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 4,
    recommended: true,
    bestFor: ['補幀', '提昇流暢度', '延長片段'],
    notes: '搭配 AnimateDiff 或既有影片片段提高 FPS。',
    windowsProfile: {
      runtime: 'NCNN / PyTorch',
      vramHint: '建議 6GB+ VRAM',
    },
  },
  {
    id: 'wan-2.1',
    name: 'Wan 2.1',
    category: 'video-generation',
    batch: 'advanced',
    status: 'planned',
    priority: 5,
    recommended: true,
    bestFor: ['高品質文生影片', '圖生影片'],
    notes: '適合正式導入為主力影片模型。',
    windowsProfile: {
      runtime: 'ComfyUI / Python pipeline',
      vramHint: '建議 12GB+ VRAM',
    },
  },
  {
    id: 'cogvideox',
    name: 'CogVideoX',
    category: 'video-generation',
    batch: 'advanced',
    status: 'planned',
    priority: 6,
    recommended: true,
    bestFor: ['文生影片', '長鏡頭生成'],
    notes: '可作為 Wan 2.1 之外的另一條主力影片路線。',
    windowsProfile: {
      runtime: 'Python pipeline',
      vramHint: '建議 12GB+ VRAM',
    },
  },
  {
    id: 'controlnet',
    name: 'ControlNet',
    category: 'conditioning',
    batch: 'advanced',
    status: 'planned',
    priority: 7,
    recommended: true,
    bestFor: ['姿勢控制', '構圖控制', '邊緣控制'],
    notes: '通常與 SDXL / FLUX 搭配。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '依主模型而定',
    },
  },
  {
    id: 'ip-adapter',
    name: 'IP-Adapter',
    category: 'conditioning',
    batch: 'advanced',
    status: 'planned',
    priority: 8,
    recommended: true,
    bestFor: ['參考圖一致性', '人物產品特徵保持'],
    notes: '很適合照片導向工作流。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '依主模型而定',
    },
  },
];

const VIDEO_MODEL_CATALOG = [
  {
    id: 'wan-2.2-ti2v-5b',
    name: 'Wan 2.2 TI2V-5B',
    kind: 'video-model',
    category: 'text-image-to-video',
    priority: 1,
    recommended: true,
    taskTypes: ['文生影片', '圖生影片'],
    bestFor: ['16GB 顯卡優先測試', '單一模型涵蓋 T2V / I2V', '720p 工作流'],
    notes: '建議先從較短影片與較低解析度開始；量化、卸載及節點設定會影響顯存需求與速度。',
    workflowNotes: 'Wan 2.2 TI2V 工作流；確認 ComfyUI 版本、模型檔及 WebM 輸出節點。',
    sourceUrl: 'https://github.com/Wan-Video/Wan2.2',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '16GB：優先測試，仍需調整工作流' },
  },
  {
    id: 'framepack-f1',
    name: 'FramePack-F1',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 2,
    recommended: true,
    taskTypes: ['圖生影片', '逐段延伸', '可測試文生影片'],
    bestFor: ['照片逐段動畫', '較長影片的分段生成'],
    notes: '官方專案提供 Windows 桌面程式；ComfyUI API 需另備相容節點/工作流，並非官方桌面程式本身。',
    workflowNotes: '需先確認第三方 ComfyUI 節點可輸出 WebM；也可獨立使用官方桌面程式。',
    sourceUrl: 'https://github.com/lllyasviel/FramePack',
    windowsProfile: { runtime: '官方 Windows 程式；ComfyUI 需額外整合', vramHint: '官方宣稱 6GB 起；速度依 GPU/設定而異' },
  },
  {
    id: 'wan-2.1-t2v-1.3b',
    name: 'Wan 2.1 T2V-1.3B',
    kind: 'video-model',
    category: 'text-to-video',
    priority: 3,
    recommended: true,
    taskTypes: ['文生影片'],
    bestFor: ['本機流程入門', '快速驗證提示詞與匯出'],
    notes: '較小型的文生影片選擇，適合先驗證工作流；畫面品質與動態表現可能低於較大型模型。',
    workflowNotes: '選用 Wan 2.1 T2V-1.3B 專用 API 工作流。',
    sourceUrl: 'https://github.com/Wan-Video/Wan2.1',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '較小型；實際需求依解析度與工作流' },
  },
  {
    id: 'ltx-video-098',
    name: 'LTX-Video 0.9.8',
    kind: 'video-model',
    category: 'text-image-to-video',
    priority: 4,
    recommended: false,
    taskTypes: ['文生影片', '圖生影片', '關鍵影格', '影片延伸'],
    bestFor: ['可控關鍵影格', '多種影片編輯工作流'],
    notes: '功能豐富但需仔細配對模型版本、節點與工作流；大模型可能需量化或卸載。',
    workflowNotes: '官方 ComfyUI-LTXVideo 範例工作流；匯出 API 格式後再接入本專案。',
    sourceUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
    windowsProfile: { runtime: 'ComfyUI-LTXVideo', vramHint: '依模型大小、量化與卸載設定' },
  },
  {
    id: 'ltx-2',
    name: 'LTX-2',
    kind: 'video-model',
    category: 'text-image-to-video-audio',
    priority: 5,
    recommended: false,
    taskTypes: ['文生影片', '圖生影片', '同步音訊'],
    bestFor: ['影音同步', '多關鍵影格控制'],
    notes: '較新且工作流複雜，先確認本機 ComfyUI/模型版本及 16GB 顯存可行性。',
    workflowNotes: '使用 LTX-2 專用 ComfyUI 工作流；本專案目前只匯入 WebM 影片，不匯入音軌以外的獨立音訊。',
    sourceUrl: 'https://github.com/Lightricks/LTX-2',
    windowsProfile: { runtime: '新版 ComfyUI', vramHint: '16GB 需實測；可能需要 FP8/卸載' },
  },
  {
    id: 'hunyuanvideo-1.5',
    name: 'HunyuanVideo-1.5',
    kind: 'video-model',
    category: 'text-image-to-video',
    priority: 6,
    recommended: false,
    taskTypes: ['文生影片', '圖生影片'],
    bestFor: ['通用影片生成', '官方 ComfyUI 指引'],
    notes: '官方提供 ComfyUI 使用說明；建議先測低解析度或蒸餾工作流，並檢查 VRAM。',
    workflowNotes: '依官方 HunyuanVideo-1.5 ComfyUI 指引匯出 API 工作流。',
    sourceUrl: 'https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '16GB 需量化/卸載與低負載設定驗證' },
  },
  {
    id: 'cogvideox-1.5-5b-i2v',
    name: 'CogVideoX1.5-5B-I2V',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 7,
    recommended: false,
    taskTypes: ['圖生影片'],
    bestFor: ['以單張圖片作為影片起始畫面'],
    notes: '圖生影片專用變體；安裝前確認相容的 ComfyUI 節點、模型版本及模型權重授權。',
    workflowNotes: '使用 CogVideoX1.5 5B I2V 專用工作流，輸入圖片節點需使用 {{source_image}}。',
    sourceUrl: 'https://github.com/zai-org/CogVideo',
    windowsProfile: { runtime: 'ComfyUI 相容工作流', vramHint: '依量化、解析度與卸載設定' },
  },
  {
    id: 'animatediff',
    name: 'AnimateDiff',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 8,
    recommended: false,
    taskTypes: ['圖生短片', 'Stable Diffusion 動畫'],
    bestFor: ['LoRA/風格實驗', '短動畫與輕量工作流'],
    notes: 'ComfyUI 生態成熟，適合短動畫與風格探索；與新一代影片基礎模型相比能力不同。',
    workflowNotes: '需安裝相容 AnimateDiff 節點與對應 motion module/基礎模型。',
    sourceUrl: 'https://github.com/guoyww/AnimateDiff',
    windowsProfile: { runtime: 'ComfyUI custom nodes', vramHint: '依基礎模型、影格數與解析度' },
  },
  {
    id: 'stable-video-diffusion-xt',
    name: 'Stable Video Diffusion XT',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 9,
    recommended: false,
    taskTypes: ['圖生短片'],
    bestFor: ['圖生影片基準比較', '短片動態'],
    notes: '較早期的圖生影片模型，可作為基準或相容性測試；生成時間與長度有限。',
    workflowNotes: '選用 SVD XT 相容工作流，確認輸出轉成 WebM。',
    sourceUrl: 'https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '依解析度及影格數' },
  },
  {
    id: 'mochi-1',
    name: 'Mochi 1',
    kind: 'video-model',
    category: 'text-to-video',
    priority: 10,
    recommended: false,
    taskTypes: ['文生影片'],
    bestFor: ['動作表現與提示詞遵循研究', '模型/工作流比較'],
    notes: '約 10B 參數且官方範例使用 CPU 卸載；16GB 顯卡不建議作為第一個整合目標。',
    workflowNotes: '確認現行 ComfyUI 相容節點及權重授權；模型體積與速度是主要門檻。',
    sourceUrl: 'https://github.com/genmoai/mochi',
    windowsProfile: { runtime: 'ComfyUI 相容工作流', vramHint: '16GB：不建議優先，需大量卸載' },
  },
];

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const VIDEO_EXTENSIONS = ['.webm', '.mp4', '.gif', '.webp'];
const VIDEO_EXTENSION_PATTERN = /\.(webm|mp4|gif|webp)$/iu;

function createRequestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(payload);
}

function getContentType(filePath) {
  return contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function normalizeOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    throw createRequestError('請提供輸出資料夾路徑。');
  }

  const resolved = path.resolve(outputDir.trim());
  if (!path.isAbsolute(resolved)) {
    throw createRequestError('輸出資料夾必須是絕對路徑。');
  }

  return resolved;
}

function sanitizeFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw createRequestError('缺少檔名。');
  }

  const normalized = path.basename(fileName.trim()).replace(/[\\/]+/g, '');
  if (!VIDEO_EXTENSIONS.includes(path.extname(normalized).toLowerCase()) || normalized.length <= 5) {
    throw createRequestError(`影片檔名必須以 ${VIDEO_EXTENSIONS.join('、')} 結尾。`);
  }

  return normalized;
}

function sanitizePathSegment(value, fallback = 'item') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-z0-9_-]+/giu, '-')
    .replace(/(^-|-$)/gu, '')
    .slice(0, 40) || fallback;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) {
      throw createRequestError('請求內容過大。');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw createRequestError('JSON 格式錯誤。');
  }
}

function validateVideoMetadata(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw createRequestError('影片 metadata 格式錯誤。');
  }
  if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200) {
    throw createRequestError('影片 metadata 缺少有效的影片 ID。');
  }
  if (typeof item.fileName !== 'string' || !item.fileName.trim()) {
    throw createRequestError('影片 metadata 缺少有效的檔名。');
  }
  for (const field of [
    'prompt', 'story', 'negativePrompt', 'moduleId', 'moduleName', 'resolution', 'quality', 'client', 'project', 'presetId',
  ]) {
    if (item[field] !== undefined && (typeof item[field] !== 'string' || item[field].length > 5_000)) {
      throw createRequestError(`影片 metadata 欄位無效：${field}。`);
    }
  }
  for (const field of ['duration', 'fps', 'width', 'height', 'motion', 'captionStrength']) {
    if (item[field] !== undefined && (!Number.isFinite(item[field]) || item[field] < 0 || item[field] > 100_000)) {
      throw createRequestError(`影片 metadata 欄位無效：${field}。`);
    }
  }
  if (item.sourceImageDataUrl !== undefined && (
    typeof item.sourceImageDataUrl !== 'string'
    || item.sourceImageDataUrl.length > 28 * 1024 * 1024
  )) {
    throw createRequestError('影片來源圖片資料格式錯誤或超過 20 MB。', 413);
  }
  if (item.seed !== undefined && (!Number.isSafeInteger(item.seed) || item.seed < 0 || item.seed > MAX_SEED)) {
    throw createRequestError('影片 metadata 欄位無效：seed。');
  }
  return item;
}

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

function getComfyUIConfig(options = {}) {
  const configuredUrl = options.comfyUIUrl || process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188';
  const workflowPath = options.comfyUIWorkflowPath || process.env.VEDIO_FACTORY_COMFYUI_WORKFLOW || '';
  let baseUrl = '';
  let error = '';
  try {
    const parsed = new URL(configuredUrl);
    if (
      parsed.protocol !== 'http:'
      || !['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('ComfyUI must use unauthenticated HTTP on localhost or host.docker.internal.');
    }
    baseUrl = parsed.origin;
  } catch (configError) {
    error = configError.message;
  }
  return {
    baseUrl,
    configuredUrl,
    workflowPath: workflowPath ? path.resolve(workflowPath) : '',
    error,
  };
}

function generateSeed() {
  return crypto.randomInt(0, 2 ** 48 - 1);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalText(payload, field, label, maxLength) {
  const value = payload[field];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw createRequestError(`${label}格式錯誤。`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw createRequestError(`${label}不可超過 ${maxLength.toLocaleString('en-US')} 字。`);
  }
  return trimmed;
}

function validateSeed(value) {
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw createRequestError(`seed 必須是 0 至 ${MAX_SEED} 的整數。`);
  }
  return seed;
}

function validateVideoModelId(value) {
  const requestedModelId = typeof value === 'string' ? value : '';
  const videoModel = VIDEO_MODEL_CATALOG.find((model) => model.id === requestedModelId);
  if (requestedModelId && !videoModel) throw createRequestError('找不到所選影片模型。');
  return videoModel?.id || '';
}

function validateGenerationSettings(value, capabilities = BASE_CAPABILITIES) {
  const settings = isPlainObject(value) ? value : {};
  const duration = Number(settings.duration ?? capabilities.defaults.duration);
  const fps = Number(settings.fps ?? capabilities.defaults.fps);
  const resolution = String(settings.resolution || capabilities.defaults.resolution);
  const quality = String(settings.quality || 'balanced');
  const motion = Number(settings.motion ?? 0);
  const captionStrength = Number(settings.captionStrength ?? 0);
  const { min, max } = capabilities.duration;
  if (!Number.isInteger(duration) || duration < min || duration > max) {
    throw createRequestError(`影片長度必須介於 ${min} 至 ${max} 秒。`);
  }
  if (!capabilities.fps.includes(fps)) {
    throw createRequestError(`FPS 僅支援 ${capabilities.fps.join('、')}。`);
  }
  if (!isResolutionAllowed(resolution, capabilities)) {
    const allowed = capabilities.resolutions.map((item) => item.value).join('、');
    const custom = capabilities.customResolution.enabled
      ? `；或自訂（${describeCustomRules(capabilities.customResolution)}）`
      : '';
    throw createRequestError(`不支援此影片解析度：${resolution}。可用：${allowed || '無預設選項'}${custom}。`);
  }
  if (!['draft', 'balanced', 'premium'].includes(quality)) {
    throw createRequestError('不支援此影片品質設定。');
  }
  if (![motion, captionStrength].every((item) => Number.isFinite(item) && item >= 0 && item <= 100)) {
    throw createRequestError('運鏡與文字強度必須介於 0 至 100。');
  }
  return { duration, fps, resolution, quality, motion, captionStrength };
}

function validateProjectTags(payload) {
  return {
    client: readOptionalText(payload, 'client', '客戶名稱', MAX_TAG_LENGTH),
    project: readOptionalText(payload, 'project', '專案名稱', MAX_TAG_LENGTH),
  };
}

function validateInferencePayload(payload, capabilities = BASE_CAPABILITIES) {
  if (!isPlainObject(payload)) {
    throw createRequestError('推論工作資料格式錯誤。');
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const story = typeof payload.story === 'string' ? payload.story.trim() : '';
  if ((!prompt && !story) || prompt.length > 5_000 || story.length > 5_000) {
    throw createRequestError('提示詞與影片描述至少填一項，且不可超過 5,000 字。');
  }
  if (payload.sourceImageDataUrl && (
    typeof payload.sourceImageDataUrl !== 'string'
    || payload.sourceImageDataUrl.length > 28 * 1024 * 1024
  )) {
    throw createRequestError('來源圖片資料格式錯誤或超過 20 MB。', 413);
  }
  const negativePrompt = readOptionalText(payload, 'negativePrompt', '負面提示詞', 5_000);
  const hasSeed = payload.seed !== undefined && payload.seed !== null && payload.seed !== '';
  const seed = hasSeed ? validateSeed(payload.seed) : generateSeed();
  const presetId = readOptionalText(payload, 'presetId', '預設 ID', 100);
  if (presetId && !UUID_PATTERN.test(presetId)) throw createRequestError('預設 ID 無效。');
  return {
    prompt,
    story,
    negativePrompt,
    seed,
    seedMode: hasSeed ? 'fixed' : 'random',
    ...validateProjectTags(payload),
    presetId,
    moduleId: typeof payload.moduleId === 'string' ? payload.moduleId.slice(0, 100) : '',
    videoModelId: validateVideoModelId(payload.videoModelId) || VIDEO_MODEL_CATALOG[0].id,
    sourceImageDataUrl: payload.sourceImageDataUrl || '',
    settings: validateGenerationSettings(payload.settings, capabilities),
  };
}

function extractTemplateVariables(...templates) {
  const names = new Set();
  for (const template of templates) {
    for (const match of String(template || '').matchAll(/(?<!\{)\{([\p{L}\p{N}_]{1,40})\}(?!\})/gu)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

function readWorkflowId(payload) {
  const workflowId = readOptionalText(payload, 'workflowId', '工作流 ID', 80);
  if (workflowId && !WORKFLOW_ID_PATTERN.test(workflowId)) throw createRequestError('工作流 ID 無效。');
  return workflowId;
}

function validatePresetPayload(payload, capabilities = BASE_CAPABILITIES) {
  if (!isPlainObject(payload)) throw createRequestError('預設資料格式錯誤。');
  const name = readOptionalText(payload, 'name', '預設名稱', MAX_TAG_LENGTH);
  if (!name) throw createRequestError('預設名稱不可為空。');
  const seedMode = payload.seedMode ?? 'random';
  if (!['random', 'fixed'].includes(seedMode)) throw createRequestError('seed 模式僅支援 random 或 fixed。');
  if (seedMode === 'fixed' && (payload.seed === undefined || payload.seed === null || payload.seed === '')) {
    throw createRequestError('固定 seed 模式需要提供 seed。');
  }
  return {
    name,
    ...validateProjectTags(payload),
    description: readOptionalText(payload, 'description', '預設說明', 1_000),
    promptTemplate: readOptionalText(payload, 'promptTemplate', '提示詞範本', 5_000),
    storyTemplate: readOptionalText(payload, 'storyTemplate', '影片描述範本', 5_000),
    negativePrompt: readOptionalText(payload, 'negativePrompt', '負面提示詞', 5_000),
    moduleId: readOptionalText(payload, 'moduleId', '生成模組', 100),
    videoModelId: validateVideoModelId(payload.videoModelId),
    workflowId: readWorkflowId(payload),
    seedMode,
    seed: seedMode === 'fixed' ? validateSeed(payload.seed) : null,
    settings: validateGenerationSettings(payload.settings, capabilities),
  };
}

async function detectNvidiaRuntime() {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
      { timeout: 2_500 },
    );
    const [firstLine = ''] = stdout.trim().split(/\r?\n/u);
    const parts = firstLine.split(',').map((item) => item.trim());
    const memoryTotal = parts.pop() || '';
    const driverVersion = parts.pop() || '';
    const name = parts.join(', ');
    return {
      detected: Boolean(firstLine),
      name,
      driverVersion,
      memoryTotal,
      probe: 'nvidia-smi',
    };
  } catch (error) {
    return {
      detected: false,
      name: '',
      driverVersion: '',
      memoryTotal: '',
      probe: 'nvidia-smi',
      error: error.code || error.message,
    };
  }
}

async function getInferenceRuntime(outputDir, comfyUI = getComfyUIConfig(), workflows = null) {
  const [gpu, comfy] = await Promise.all([
    detectNvidiaRuntime(),
    (async () => {
      if (!comfyUI.baseUrl) {
        return { available: false, url: comfyUI.configuredUrl, error: comfyUI.error };
      }
      try {
        const response = await fetch(`${comfyUI.baseUrl}/system_stats`, {
          signal: AbortSignal.timeout(2_500),
        });
        if (!response.ok) throw new Error(`ComfyUI responded with HTTP ${response.status}`);
        return { available: true, url: comfyUI.baseUrl };
      } catch (error) {
        return { available: false, url: comfyUI.baseUrl, error: error.message };
      }
    })(),
  ]);
  return {
    provider: 'comfyui-local',
    localGpuPreferred: true,
    platform: process.platform,
    outputDir,
    modelDir: DEFAULT_MODEL_DIR,
    workflowConfigured: workflows ? workflows.length > 0 : Boolean(comfyUI.workflowPath),
    comfyUI: {
      ...comfy,
      workflowConfigured: workflows ? workflows.length > 0 : Boolean(comfyUI.workflowPath),
      workflowPath: comfyUI.workflowPath,
      workflowCount: workflows ? workflows.length : Number(Boolean(comfyUI.workflowPath)),
    },
    gpu,
    guidance: [
      '請在本機啟動 ComfyUI；Docker 部署時使用 host.docker.internal，並透過防火牆限制存取。',
      '將 ComfyUI 匯出的 API 格式工作流 JSON 放入 workflows 資料夾（可附同名 .vf.json 設定檔），或設定 VEDIO_FACTORY_COMFYUI_WORKFLOW。',
      `模型權重預設放在 ${DEFAULT_MODEL_DIR}；ComfyUI 回傳的 WebM/MP4/GIF/WebP 影片會複製到 ${outputDir}。`,
    ],
  };
}

function getCurrentProjectModelStatus() {
  return {
    actualIntegratedModels: [],
    visualModules: [
      { id: 'cinematic-motion', type: 'canvas-module' },
      { id: 'storyboard-focus', type: 'canvas-module' },
      { id: 'neon-pulse', type: 'canvas-module' },
    ],
    inferenceScaffold: {
      provider: 'comfyui-local',
      hasRuntimeDetection: true,
      hasJobManifestPersistence: true,
      hasComfyUIWorkflowExecution: true,
      hasIntegratedModelWeights: false,
    },
  };
}

function buildModelCatalog(modelDir) {
  return {
    generatedAt: new Date().toISOString(),
    currentProjectStatus: getCurrentProjectModelStatus(),
    installRoot: modelDir,
    firstBatchOrder: MODEL_CATALOG.filter((model) => model.batch === 'first-wave')
      .sort((left, right) => left.priority - right.priority)
      .map((model) => model.id),
    videoModels: VIDEO_MODEL_CATALOG.map((model) => ({
      ...model,
      installPath: path.join(modelDir, model.id),
    })),
    models: [...MODEL_CATALOG, ...VIDEO_MODEL_CATALOG].map((model) => ({
      ...model,
      installPath: path.join(modelDir, model.id),
    })),
  };
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

function createApp(options = {}) {
  let outputDir = normalizeOutputDir(options.outputDir || DEFAULT_OUTPUT_DIR);
  const dataDir = normalizeOutputDir(options.dataDir || DEFAULT_DATA_DIR);
  const presetsDir = path.join(dataDir, PRESETS_DIR_NAME);
  const workflowsDir = path.resolve(options.workflowsDir || DEFAULT_WORKFLOWS_DIR);
  const renameLocks = new Map();
  const inferenceRefreshes = new Map();
  const comfyUI = getComfyUIConfig(options);
  const maxVideoUploadBytes = options.maxVideoUploadBytes ?? MAX_VIDEO_UPLOAD_BYTES;

  async function ensureOutputDir() {
    await fs.mkdir(outputDir, { recursive: true });
  }

  async function ensureInferenceJobDir() {
    await fs.mkdir(path.join(outputDir, INFERENCE_JOBS_DIR_NAME), { recursive: true });
  }

  async function ensureModelSetupDir() {
    await fs.mkdir(path.join(outputDir, MODEL_SETUP_DIR_NAME), { recursive: true });
  }

  async function requestComfyUI(endpoint, requestOptions = {}) {
    if (!comfyUI.baseUrl) {
      throw createRequestError(comfyUI.error || 'ComfyUI URL 設定無效。', 503);
    }
    let response;
    try {
      response = await fetch(`${comfyUI.baseUrl}${endpoint}`, {
        ...requestOptions,
        signal: requestOptions.signal || AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw createRequestError(`無法連線至本機 ComfyUI：${error.message}`, 503);
    }
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw createRequestError(`ComfyUI 請求失敗（${response.status}）：${details.slice(0, 1000)}`, 502);
    }
    return response;
  }

  function samePath(left, right) {
    const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
    return normalize(left) === normalize(right);
  }

  async function readWorkflowMeta(workflowPath) {
    const metaPath = `${workflowPath.slice(0, -'.json'.length)}${WORKFLOW_META_SUFFIX}`;
    const stats = await fs.stat(metaPath).catch(() => null);
    if (!stats?.isFile()) return { metaPath: '', meta: {} };
    if (stats.size > MAX_WORKFLOW_META_BYTES) throw new Error('設定檔超過 64 KB。');
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      throw new Error(`${path.basename(metaPath)} 不是有效的 JSON。`);
    }
    if (!isPlainObject(meta)) throw new Error(`${path.basename(metaPath)} 必須是 JSON 物件。`);
    return { metaPath, meta };
  }

  async function describeWorkflow(entry) {
    const workflow = {
      id: entry.id,
      name: entry.id,
      description: '',
      isDefault: Boolean(entry.isDefault),
      workflowPath: entry.workflowPath,
      metaPath: '',
      videoModelIds: [],
      requiresSourceImage: false,
      capabilities: BASE_CAPABILITIES,
      error: '',
    };
    try {
      const { metaPath, meta } = await readWorkflowMeta(entry.workflowPath);
      workflow.metaPath = metaPath;
      const fields = readOptionalText(meta, 'name', 'name', 100);
      if (fields) workflow.name = fields;
      else if (entry.isDefault && entry.id === 'default') workflow.name = '預設工作流（VEDIO_FACTORY_COMFYUI_WORKFLOW）';
      workflow.description = readOptionalText(meta, 'description', 'description', 1_000);
      if (meta.videoModelIds !== undefined) {
        if (!Array.isArray(meta.videoModelIds) || meta.videoModelIds.some((id) => typeof id !== 'string')) {
          throw new Error('videoModelIds 必須是字串陣列。');
        }
        const unknown = meta.videoModelIds.filter((id) => !VIDEO_MODEL_CATALOG.some((model) => model.id === id));
        if (unknown.length) throw new Error(`videoModelIds 包含未知模型：${unknown.join('、')}`);
        workflow.videoModelIds = [...new Set(meta.videoModelIds)];
      }
      if (meta.requiresSourceImage !== undefined && typeof meta.requiresSourceImage !== 'boolean') {
        throw new Error('requiresSourceImage 必須是 true 或 false。');
      }
      workflow.requiresSourceImage = meta.requiresSourceImage === true;
      workflow.capabilities = narrowCapabilities(meta);
    } catch (error) {
      workflow.error = `工作流設定檔無效：${error.message}`;
    }
    return workflow;
  }

  async function listWorkflows() {
    const entries = [];
    const files = await fs.readdir(workflowsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name.endsWith(WORKFLOW_META_SUFFIX)) continue;
      const id = file.name.slice(0, -'.json'.length);
      if (WORKFLOW_ID_PATTERN.test(id)) entries.push({ id, workflowPath: path.join(workflowsDir, file.name) });
    }
    if (comfyUI.workflowPath) {
      const existing = entries.find((entry) => samePath(entry.workflowPath, comfyUI.workflowPath));
      if (existing) {
        existing.isDefault = true;
      } else {
        const id = entries.some((entry) => entry.id === 'default') ? 'env-default' : 'default';
        entries.push({ id, workflowPath: comfyUI.workflowPath, isDefault: true });
      }
    }
    const workflows = await Promise.all(entries.map(describeWorkflow));
    const collator = new Intl.Collator('zh-Hant');
    return workflows.sort((left, right) => (
      Number(right.isDefault) - Number(left.isDefault) || collator.compare(left.name, right.name)
    ));
  }

  async function resolveWorkflow(workflowId = '') {
    const workflows = await listWorkflows();
    if (!workflowId) return workflows.find((workflow) => workflow.isDefault) || workflows[0] || null;
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) throw createRequestError(`找不到工作流：${workflowId}。`, 404);
    return workflow;
  }

  async function loadComfyWorkflow(workflowEntry) {
    if (!workflowEntry) {
      throw createRequestError('尚未設定任何 ComfyUI 工作流。', 503);
    }
    const stats = await fs.stat(workflowEntry.workflowPath).catch(() => null);
    if (!stats?.isFile() || stats.size > MAX_COMFY_WORKFLOW_BYTES) {
      throw createRequestError('ComfyUI 工作流不存在或超過 10 MB。', 400);
    }
    try {
      const raw = await fs.readFile(workflowEntry.workflowPath);
      const workflow = JSON.parse(raw.toString('utf8'));
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        throw new Error('workflow must be an object');
      }
      return { workflow, workflowSha256: sha256(raw) };
    } catch {
      throw createRequestError('ComfyUI 工作流必須是有效的 API 格式 JSON。', 400);
    }
  }

  function inspectComfyWorkflow(workflow, modelId, hasSourceImage = false, workflowEntry = null) {
    const errors = [];
    const warnings = [];
    const nodes = Object.entries(workflow);
    if (!nodes.length) errors.push('工作流沒有節點。');
    const nodeSummaries = [];
    const placeholders = new Set();

    for (const [nodeId, node] of nodes) {
      if (!node || typeof node !== 'object' || Array.isArray(node)
        || typeof node.class_type !== 'string'
        || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
        errors.push(`節點 ${nodeId} 格式不正確；需要 class_type 與 inputs。`);
        continue;
      }

      const serializedInputs = JSON.stringify(node.inputs);
      for (const match of serializedInputs.matchAll(/\{\{([^{}]+)\}\}/gu)) {
        placeholders.add(match[1].trim());
      }
      nodeSummaries.push({
        id: nodeId,
        classType: node.class_type,
      });
    }

    const supportedPlaceholders = new Set([
      'prompt',
      'model_id',
      'story',
      'negative_prompt',
      'seed',
      'width',
      'height',
      'duration',
      'fps',
      'quality',
      'motion',
      'caption_strength',
      'source_image',
    ]);
    const unsupportedPlaceholders = [...placeholders].filter((name) => !supportedPlaceholders.has(name));
    if (unsupportedPlaceholders.length) {
      errors.push(`工作流包含不支援的佔位符：${unsupportedPlaceholders.map((name) => `{{${name}}}`).join('、')}`);
    }
    if (placeholders.has('source_image') && !hasSourceImage) {
      errors.push('此工作流需要來源圖片，但目前沒有選取圖片。');
    }
    if (!placeholders.has('prompt') && !placeholders.has('story')) {
      warnings.push('工作流沒有提示詞或影片描述佔位符，網站輸入的文字不會傳入工作流。');
    }
    if (!placeholders.has('model_id')) {
      warnings.push('工作流未使用 {{model_id}}；所選模型只會記錄在工作清單，不會改變工作流中的模型節點。');
    }
    if (workflowEntry?.requiresSourceImage && !hasSourceImage && !placeholders.has('source_image')) {
      errors.push('此工作流設定為需要來源圖片，但目前沒有選取圖片。');
    }
    if (workflowEntry?.videoModelIds.length && !workflowEntry.videoModelIds.includes(modelId)) {
      warnings.push(`此工作流標示支援的模型為 ${workflowEntry.videoModelIds.join('、')}，與所選模型 ${modelId} 不同。`);
    }
    const selectedModel = VIDEO_MODEL_CATALOG.find((model) => model.id === modelId);
    if (selectedModel?.category === 'image-to-video' && !placeholders.has('source_image')) {
      warnings.push('所選模型以圖生影片為主，但工作流沒有 {{source_image}}；請確認它確實支援目前的輸入方式。');
    }

    const videoOutputNodes = nodeSummaries.filter(({ classType }) => /video|webm|animated|gif|mp4/iu.test(classType));
    if (!videoOutputNodes.length) {
      warnings.push('找不到名稱含 video/webm/animated/gif 的節點，請確認工作流有影片輸出節點。');
    } else {
      const outputText = videoOutputNodes
        .map(({ id }) => `${workflow[id].class_type} ${JSON.stringify(workflow[id].inputs)}`)
        .join(' ');
      if (!/webm|mp4|h26[45]|gif|webp/iu.test(outputText)) {
        warnings.push('無法從輸出節點設定確認輸出格式；只有 WebM、MP4、GIF、WebP 會匯入影片庫。');
      }
    }

    return {
      configured: true,
      ready: errors.length === 0,
      selectedModelId: modelId,
      nodeCount: nodeSummaries.length,
      nodeTypes: [...new Set(nodeSummaries.map(({ classType }) => classType))],
      placeholders: [...placeholders].sort(),
      videoOutputNodes,
      errors,
      warnings,
      limitations: [
        '預檢不會執行 ComfyUI 工作流，也無法確認模型權重、custom nodes、VRAM 或節點間的實際相容性。',
        '影片輸出節點與 WebM 格式只能依節點名稱/設定做靜態提示，最終仍需實際生成驗證。',
      ],
    };
  }

  async function preflightComfyWorkflow(payload = {}) {
    const modelId = typeof payload.videoModelId === 'string' && payload.videoModelId
      ? payload.videoModelId
      : VIDEO_MODEL_CATALOG[0].id;
    if (!VIDEO_MODEL_CATALOG.some((model) => model.id === modelId)) {
      throw createRequestError('找不到所選影片模型。');
    }
    const workflowEntry = await resolveWorkflow(readWorkflowId(isPlainObject(payload) ? payload : {}));
    const emptyReport = {
      configured: false,
      ready: false,
      workflowId: workflowEntry?.id || '',
      selectedModelId: modelId,
      nodeCount: 0,
      nodeTypes: [],
      placeholders: [],
      videoOutputNodes: [],
      errors: ['尚未設定任何工作流：請將 API 格式 JSON 放入 workflows 資料夾，或設定 VEDIO_FACTORY_COMFYUI_WORKFLOW。'],
      warnings: [],
      limitations: [],
    };
    if (!workflowEntry) return emptyReport;
    if (workflowEntry.error) return { ...emptyReport, configured: true, errors: [workflowEntry.error] };
    const { workflow, workflowSha256 } = await loadComfyWorkflow(workflowEntry);
    return {
      ...inspectComfyWorkflow(workflow, modelId, payload.hasSourceImage === true, workflowEntry),
      workflowId: workflowEntry.id,
      workflowSha256,
    };
  }

  function getSourceImagesDir() {
    return path.join(outputDir, INFERENCE_JOBS_DIR_NAME, SOURCE_IMAGES_DIR_NAME);
  }

  async function storeSourceImage(dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/iu.exec(dataUrl);
    if (!match) throw createRequestError('來源圖片僅支援 PNG、JPEG 或 WebP。', 400);
    const image = Buffer.from(match[2], 'base64');
    if (!image.length || image.length > 20 * 1024 * 1024) {
      throw createRequestError('來源圖片不得為空或超過 20 MB。', 400);
    }
    const mimeType = match[1].toLowerCase();
    const extension = SOURCE_IMAGE_EXTENSIONS[mimeType];
    const imageSha256 = sha256(image);
    const fileName = `${imageSha256}.${extension}`;
    const imagePath = path.join(getSourceImagesDir(), fileName);
    if (!(await fileExists(imagePath))) {
      await fs.mkdir(getSourceImagesDir(), { recursive: true });
      const temporaryPath = `${imagePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, image);
      await fs.rename(temporaryPath, imagePath);
    }
    return { image, mimeType, extension, sha256: imageSha256, fileName };
  }

  async function loadStoredSourceImage(fileName) {
    const match = /^([a-f\d]{64})\.(png|jpg|webp)$/u.exec(String(fileName || ''));
    if (!match) throw createRequestError('工作記錄的來源圖片檔名無效。', 409);
    const image = await fs.readFile(path.join(getSourceImagesDir(), fileName)).catch(() => null);
    if (!image || sha256(image) !== match[1]) {
      throw createRequestError('找不到原工作的來源圖片快照或內容已變更，無法重現。', 409);
    }
    const mimeType = Object.keys(SOURCE_IMAGE_EXTENSIONS).find((type) => SOURCE_IMAGE_EXTENSIONS[type] === match[2]);
    return { image, mimeType, extension: match[2], sha256: match[1], fileName };
  }

  async function uploadComfySourceImage(source) {
    const form = new FormData();
    // Content-addressed name keeps the submitted prompt JSON identical across reruns.
    form.append(
      'image',
      new Blob([source.image], { type: source.mimeType }),
      `vediofactory-${source.sha256.slice(0, 32)}.${source.extension}`,
    );
    form.append('overwrite', 'true');
    const response = await requestComfyUI('/upload/image', { method: 'POST', body: form });
    const result = await response.json();
    if (!result.name) throw createRequestError('ComfyUI 未回傳上傳圖片名稱。', 502);
    return [result.subfolder, result.name].filter(Boolean).join('/');
  }

  function applyWorkflowVariables(value, variables) {
    if (typeof value === 'string') {
      const exactMatch = /^\{\{([^{}]+)\}\}$/u.exec(value);
      const exactKey = exactMatch?.[1].trim();
      if (exactMatch && Object.hasOwn(variables, exactKey)) return variables[exactKey];
      return value.replace(/\{\{([^{}]+)\}\}/gu, (token, rawKey) => {
        const key = rawKey.trim();
        return Object.hasOwn(variables, key) ? String(variables[key]) : token;
      });
    }
    if (Array.isArray(value)) return value.map((item) => applyWorkflowVariables(item, variables));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        applyWorkflowVariables(item, variables),
      ]));
    }
    return value;
  }

  async function persistInferenceJob(job) {
    const temporaryPath = `${job.manifestPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(job, null, 2));
    await fs.rename(temporaryPath, job.manifestPath);
  }

  async function saveComfyVideoOutputs(job, historyEntry) {
    const videos = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        if (typeof value.filename === 'string' && VIDEO_EXTENSION_PATTERN.test(value.filename)) videos.push(value);
        Object.values(value).forEach(visit);
      }
    };
    visit(historyEntry.outputs || {});
    const uniqueVideos = [...new Map(videos.map((video) => [
      `${video.type || 'output'}:${video.subfolder || ''}:${video.filename}`,
      video,
    ])).values()];
    const savedFiles = [];

    for (const [index, video] of uniqueVideos.entries()) {
      const query = new URLSearchParams({
        filename: video.filename,
        subfolder: video.subfolder || '',
        type: video.type || 'output',
      });
      const response = await requestComfyUI(`/view?${query}`, {
        signal: AbortSignal.timeout(120_000),
      });
      const extension = path.extname(video.filename).toLowerCase();
      const fileName = sanitizeFileName(`comfyui-${job.id.slice(0, 8)}-${index + 1}${extension}`);
      const videoPath = path.join(outputDir, fileName);
      const temporaryPath = `${videoPath}.${crypto.randomUUID()}.tmp`;
      let stats;
      try {
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > 2 * 1024 * 1024 * 1024) {
          throw createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413);
        }
        let bytesWritten = 0;
        const sizeLimit = new Transform({
          transform(chunk, encoding, callback) {
            bytesWritten += chunk.length;
            if (bytesWritten > 2 * 1024 * 1024 * 1024) {
              callback(createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413));
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          sizeLimit,
          createWriteStream(temporaryPath, { flags: 'wx' }),
        );
        stats = await fs.stat(temporaryPath);
        if (stats.size > 2 * 1024 * 1024 * 1024) {
          throw createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413);
        }
        await fs.rename(temporaryPath, videoPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
      const resolution = job.settings.resolution || '1280x720';
      const [width, height] = resolution.split('x').map(Number);
      const metadata = {
        id: crypto.randomUUID(),
        fileName,
        moduleId: job.moduleId,
        moduleName: 'ComfyUI',
        prompt: job.prompt,
        story: job.story,
        negativePrompt: job.negativePrompt || '',
        seed: job.seed,
        videoModelId: job.videoModelId,
        workflowSha256: job.workflowSha256,
        client: job.client || '',
        project: job.project || '',
        presetId: job.presetId || '',
        duration: Number(job.settings.duration) || 0,
        fps: Number(job.settings.fps) || 24,
        resolution,
        width,
        height,
        quality: job.settings.quality || 'balanced',
        motion: Number(job.settings.motion) || 0,
        captionStrength: Number(job.settings.captionStrength) || 0,
        createdAt: new Date().toISOString(),
        inferenceJobId: job.id,
      };
      await fs.writeFile(path.join(outputDir, `${fileName}.json`), JSON.stringify(metadata, null, 2));
      savedFiles.push({ fileName, fileSize: stats.size, previewUrl: `/api/videos/${encodeURIComponent(fileName)}` });
    }
    return savedFiles;
  }

  async function refreshComfyInferenceJob(job) {
    if (!job.comfyPromptId || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    const [historyResponse, queueResponse] = await Promise.all([
      requestComfyUI(`/history/${encodeURIComponent(job.comfyPromptId)}`),
      requestComfyUI('/queue'),
    ]);
    const history = await historyResponse.json();
    const queue = await queueResponse.json();
    const historyEntry = history[job.comfyPromptId];
    if (historyEntry) {
      const status = historyEntry.status || {};
      if (status.completed) {
        const statusText = String(status.status_str || '').toLowerCase();
        if (statusText !== 'success') {
          job.status = 'failed';
          job.error = `ComfyUI 工作失敗：${statusText || '未知錯誤'}`;
        } else {
          job.outputs = await saveComfyVideoOutputs(job, historyEntry);
          job.status = 'succeeded';
          if (!job.outputs.length) {
            job.guidance = 'ComfyUI 工作已完成，但未找到 WebM/MP4/GIF/WebP 輸出；請確認工作流使用影片輸出節點。';
          }
        }
      } else {
        job.status = 'running';
      }
    } else {
      const entries = [...(queue.queue_running || []), ...(queue.queue_pending || [])];
      const queued = entries.some((entry) => Array.isArray(entry) && entry[1] === job.comfyPromptId);
      job.status = queued && (queue.queue_running || []).some(
        (entry) => Array.isArray(entry) && entry[1] === job.comfyPromptId,
      ) ? 'running' : 'queued';
    }
    job.updatedAt = new Date().toISOString();
    await persistInferenceJob(job);
    return job;
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

  async function listInferenceJobs() {
    await ensureInferenceJobDir();
    const jobsDir = path.join(outputDir, INFERENCE_JOBS_DIR_NAME);
    const entries = await fs.readdir(jobsDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(await fs.readFile(path.join(jobsDir, entry.name), 'utf8'));
        jobs.push(payload);
      } catch {
        continue;
      }
    }
    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return jobs;
  }

  async function getInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    const job = jobs.find((item) => item.id === jobId) || null;
    if (!job?.comfyPromptId) return job;
    if (!inferenceRefreshes.has(jobId)) {
      inferenceRefreshes.set(jobId, refreshComfyInferenceJob(job));
    }
    try {
      return await inferenceRefreshes.get(jobId);
    } finally {
      inferenceRefreshes.delete(jobId);
    }
  }

  async function cancelInferenceJob(jobId) {
    const job = await getInferenceJob(jobId);
    if (!job) throw createRequestError('找不到推論工作。', 404);
    if (!job.comfyPromptId) throw createRequestError('此工作尚未提交至 ComfyUI。', 409);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      throw createRequestError(`工作已是終止狀態：${job.status}。`, 409);
    }

    const queueResponse = await requestComfyUI('/queue');
    const queue = await queueResponse.json();
    const promptId = job.comfyPromptId;
    if ((queue.queue_running || []).some((entry) => Array.isArray(entry) && entry[1] === promptId)) {
      throw createRequestError('工作已開始執行。ComfyUI 的 interrupt 會中斷全域執行，因此不會由此操作取消。', 409);
    }
    const isPending = (queue.queue_pending || []).some((entry) => Array.isArray(entry) && entry[1] === promptId);
    if (!isPending) {
      throw createRequestError('工作已不在待執行佇列中，請重新整理工作狀態後再試。', 409);
    }

    await requestComfyUI('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    job.guidance = '已從 ComfyUI 待執行佇列移除。';
    await persistInferenceJob(job);
    return job;
  }

  async function createModelSetupBatch() {
    await ensureOutputDir();
    await ensureModelSetupDir();
    const runtime = await getInferenceRuntime(outputDir, comfyUI);
    const catalog = buildModelCatalog(runtime.modelDir);
    const requestToken = crypto.randomUUID();
    const manifests = [];

    for (const model of catalog.models.filter((item) => item.batch === 'first-wave')) {
      const manifest = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        modelId: model.id,
        name: model.name,
        category: model.category,
        installPath: model.installPath,
        provider: runtime.provider,
        status: 'scaffolded',
        nextAction: '準備模型權重、推論節點與本機命令整合',
        recommendedFor: model.bestFor,
      };
      const manifestPath = path.join(outputDir, MODEL_SETUP_DIR_NAME, `${Date.now()}-${requestToken}-${model.id}.json`);
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, manifestPath }, null, 2));
      manifests.push({ ...manifest, manifestPath });
    }

    return {
      provider: runtime.provider,
      outputDir,
      installRoot: catalog.installRoot,
      firstBatchModels: manifests,
    };
  }

  async function saveVideoAsset(item, videoBase64) {
    validateVideoMetadata(item);
    const fileName = sanitizeFileName(item.fileName);
    const videoPath = path.join(outputDir, fileName);
    const metadataPath = path.join(outputDir, `${fileName}.json`);
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
    const temporaryVideoPath = path.join(outputDir, `.${temporaryToken}.upload`);
    const temporaryMetadataPath = path.join(outputDir, `.${temporaryToken}.json`);
    try {
      const { fileSize, metadata: item } = await receiveVideoUpload(request, temporaryVideoPath, maxVideoUploadBytes);
      const fileName = sanitizeFileName(item.fileName);
      const videoPath = path.join(outputDir, fileName);
      const metadataPath = path.join(outputDir, `${fileName}.json`);
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

  async function createInferenceJob(payload) {
    await ensureOutputDir();
    await ensureInferenceJobDir();

    const workflowEntry = await resolveWorkflow(readWorkflowId(isPlainObject(payload) ? payload : {}));
    if (workflowEntry?.error) throw createRequestError(workflowEntry.error);
    const inference = validateInferencePayload(payload, workflowEntry?.capabilities || BASE_CAPABILITIES);
    const runtime = await getInferenceRuntime(outputDir, comfyUI, workflowEntry ? [workflowEntry] : []);
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: 'scaffolded',
      provider: 'comfyui-local',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: inference.prompt,
      story: inference.story,
      negativePrompt: inference.negativePrompt,
      seed: inference.seed,
      seedMode: inference.seedMode,
      client: inference.client,
      project: inference.project,
      presetId: inference.presetId,
      moduleId: inference.moduleId,
      videoModelId: inference.videoModelId,
      settings: inference.settings,
      sourceImageAttached: Boolean(inference.sourceImageDataUrl),
      modelDir: runtime.modelDir,
      workflowConfigured: runtime.workflowConfigured,
      comfyUIUrl: comfyUI.baseUrl,
      guidance: '請設定 ComfyUI API 工作流 JSON；工作流需使用 {{prompt}} 等佔位符，並輸出 WebM 影片。',
      manifestPath: path.join(
        outputDir,
        INFERENCE_JOBS_DIR_NAME,
        `${Date.now()}-${jobId}-${sanitizePathSegment(payload.moduleId, 'job')}.json`,
      ),
    };

    if (workflowEntry) {
      if (!runtime.comfyUI.available) {
        throw createRequestError('無法連線至本機 ComfyUI，請確認服務已啟動。', 503);
      }
      const { workflow, workflowSha256 } = await loadComfyWorkflow(workflowEntry);
      const preflight = inspectComfyWorkflow(
        workflow,
        inference.videoModelId,
        Boolean(inference.sourceImageDataUrl),
        workflowEntry,
      );
      if (!preflight.ready) {
        throw createRequestError(`ComfyUI 工作流預檢失敗：${preflight.errors.join(' ')}`);
      }
      job.workflowPreflight = preflight;
      job.workflowId = workflowEntry.id;
      job.workflowPath = workflowEntry.workflowPath;
      job.workflowSha256 = workflowSha256;
      let sourceImage = '';
      if (inference.sourceImageDataUrl) {
        const source = await storeSourceImage(inference.sourceImageDataUrl);
        sourceImage = await uploadComfySourceImage(source);
        job.sourceImage = { fileName: source.fileName, sha256: source.sha256, comfyName: sourceImage };
      }
      const resolution = String(job.settings.resolution || '1280x720').split('x').map(Number);
      const variables = {
        prompt: job.prompt || job.story,
        model_id: inference.videoModelId,
        story: job.story,
        negative_prompt: job.negativePrompt,
        seed: job.seed,
        width: resolution[0],
        height: resolution[1],
        duration: Number(job.settings.duration) || 6,
        fps: Number(job.settings.fps) || 24,
        quality: job.settings.quality || 'balanced',
        motion: Number(job.settings.motion) || 0,
        caption_strength: Number(job.settings.captionStrength) || 0,
        source_image: sourceImage,
      };
      const apiWorkflow = applyWorkflowVariables(workflow, variables);
      if (/\{\{[^{}]+\}\}/u.test(JSON.stringify(apiWorkflow))) {
        throw createRequestError('工作流含有未支援的佔位符。', 400);
      }
      job.submittedWorkflow = apiWorkflow;
      job.comfyUIVersion = await getComfyUIVersion();
      const submission = await submitComfyWorkflow(apiWorkflow);
      job.comfyPromptId = submission.prompt_id;
      job.queuePosition = submission.number;
      job.status = 'queued';
      job.guidance = '已提交至本機 ComfyUI。完成後 WebM/MP4/GIF/WebP 輸出會匯入專案資料夾。';
    }

    await persistInferenceJob(job);
    return job;
  }

  async function submitComfyWorkflow(apiWorkflow) {
    const submission = await requestComfyUI('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: apiWorkflow, client_id: crypto.randomUUID() }),
    }).then((response) => response.json());
    if (!submission.prompt_id || (submission.node_errors && Object.keys(submission.node_errors).length)) {
      throw createRequestError(`ComfyUI 拒絕工作流：${JSON.stringify(submission.node_errors || submission)}`, 400);
    }
    return submission;
  }

  async function getComfyUIVersion() {
    try {
      const response = await requestComfyUI('/system_stats', { signal: AbortSignal.timeout(5_000) });
      const stats = await response.json();
      return typeof stats?.system?.comfyui_version === 'string' ? stats.system.comfyui_version : null;
    } catch {
      return null;
    }
  }

  function getPresetPath(presetId) {
    if (typeof presetId !== 'string' || !UUID_PATTERN.test(presetId)) {
      throw createRequestError('找不到參數預設。', 404);
    }
    return path.join(presetsDir, `${presetId}.json`);
  }

  function toPresetResponse(preset) {
    return { ...preset, variables: extractTemplateVariables(preset.promptTemplate, preset.storyTemplate) };
  }

  async function writePreset(preset) {
    await fs.mkdir(presetsDir, { recursive: true });
    const presetPath = getPresetPath(preset.id);
    const temporaryPath = `${presetPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(preset, null, 2));
    await fs.rename(temporaryPath, presetPath);
  }

  async function readPreset(presetId) {
    const text = await fs.readFile(getPresetPath(presetId), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw createRequestError('參數預設檔案已損毀。', 500);
    }
  }

  async function listPresets() {
    const entries = await fs.readdir(presetsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const presets = [];
    for (const entry of entries) {
      const match = /^(.+)\.json$/u.exec(entry.name);
      if (!entry.isFile() || !match || !UUID_PATTERN.test(match[1])) continue;
      try {
        const preset = JSON.parse(await fs.readFile(path.join(presetsDir, entry.name), 'utf8'));
        if (preset?.id === match[1]) presets.push(preset);
      } catch {
        continue;
      }
    }
    const collator = new Intl.Collator('zh-Hant');
    presets.sort((left, right) => (
      collator.compare(left.client || '', right.client || '')
      || collator.compare(left.project || '', right.project || '')
      || collator.compare(left.name || '', right.name || '')
    ));
    return presets;
  }

  async function getPresetCapabilities(payload, workflows) {
    const workflowId = readWorkflowId(isPlainObject(payload) ? payload : {});
    const workflow = workflowId ? (workflows || await listWorkflows()).find((item) => item.id === workflowId) : null;
    return workflow && !workflow.error ? workflow.capabilities : BASE_CAPABILITIES;
  }

  async function createPreset(payload) {
    const now = new Date().toISOString();
    const preset = {
      schemaVersion: PRESET_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      ...validatePresetPayload(payload, await getPresetCapabilities(payload)),
      createdAt: now,
      updatedAt: now,
    };
    await writePreset(preset);
    return toPresetResponse(preset);
  }

  async function updatePreset(presetId, payload) {
    const existing = await readPreset(presetId);
    if (!existing) throw createRequestError('找不到參數預設。', 404);
    const preset = {
      schemaVersion: PRESET_SCHEMA_VERSION,
      id: existing.id,
      ...validatePresetPayload(payload, await getPresetCapabilities(payload)),
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await writePreset(preset);
    return toPresetResponse(preset);
  }

  async function deletePreset(presetId) {
    const presetPath = getPresetPath(presetId);
    if (!(await fileExists(presetPath))) throw createRequestError('找不到參數預設。', 404);
    await fs.rm(presetPath, { force: true });
    return { ok: true };
  }

  async function exportPresets() {
    return {
      schemaVersion: PRESET_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      presets: await listPresets(),
    };
  }

  async function importPresets(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.presets)) {
      throw createRequestError('匯入資料需要 presets 陣列。');
    }
    if (payload.presets.length > MAX_PRESETS_PER_IMPORT) {
      throw createRequestError(`單次最多匯入 ${MAX_PRESETS_PER_IMPORT} 筆預設。`, 413);
    }
    const now = new Date().toISOString();
    const workflows = await listWorkflows();
    const capabilitiesList = await Promise.all(payload.presets.map((entry) => (
      getPresetCapabilities(entry, workflows).catch(() => BASE_CAPABILITIES)
    )));
    // Validate every entry before writing so a bad file never half-imports.
    const presets = payload.presets.map((entry, index) => {
      try {
        const fields = validatePresetPayload(entry, capabilitiesList[index]);
        const createdAt = typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt))
          ? entry.createdAt
          : now;
        return {
          schemaVersion: PRESET_SCHEMA_VERSION,
          id: typeof entry.id === 'string' && UUID_PATTERN.test(entry.id) ? entry.id : crypto.randomUUID(),
          ...fields,
          createdAt,
          updatedAt: now,
        };
      } catch (error) {
        throw createRequestError(`第 ${index + 1} 筆預設無效：${error.message}`, error.statusCode || 400);
      }
    });
    for (const preset of presets) await writePreset(preset);
    return { imported: presets.length, presets: presets.map(toPresetResponse) };
  }

  async function rerunInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    const original = jobs.find((item) => item.id === jobId);
    if (!original) throw createRequestError('找不到推論工作。', 404);
    if (!original.submittedWorkflow || typeof original.submittedWorkflow !== 'object') {
      throw createRequestError('此工作沒有保存送出的工作流快照（可能建立於舊版本），無法完整重現。', 409);
    }
    const runtime = await getInferenceRuntime(outputDir, comfyUI);
    if (!runtime.comfyUI.available) {
      throw createRequestError('無法連線至本機 ComfyUI，請確認服務已啟動。', 503);
    }

    const warnings = [];
    if (original.sourceImage) {
      const source = await loadStoredSourceImage(original.sourceImage.fileName);
      const comfyName = await uploadComfySourceImage(source);
      if (comfyName !== original.sourceImage.comfyName) {
        warnings.push(`ComfyUI 回傳的來源圖片名稱（${comfyName}）與原工作不同，產出可能不一致。`);
      }
    }
    const workflows = await listWorkflows();
    const currentWorkflow = workflows.find((workflow) => (
      original.workflowId ? workflow.id === original.workflowId : samePath(workflow.workflowPath, original.workflowPath || '')
    ));
    const currentWorkflowSha256 = currentWorkflow
      ? await loadComfyWorkflow(currentWorkflow).then((loaded) => loaded.workflowSha256, () => '')
      : '';
    if (currentWorkflowSha256 !== original.workflowSha256) {
      warnings.push('目前設定的工作流已變更或無法讀取；本次使用原工作保存的工作流快照重新產出，與目前工作流的結果可能不同。');
    }
    const comfyUIVersion = await getComfyUIVersion();
    if (original.comfyUIVersion && comfyUIVersion && comfyUIVersion !== original.comfyUIVersion) {
      warnings.push(`ComfyUI 版本已由 ${original.comfyUIVersion} 變更為 ${comfyUIVersion}，產出可能不一致。`);
    }

    const submission = await submitComfyWorkflow(original.submittedWorkflow);
    const rerunJobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const job = {
      id: rerunJobId,
      status: 'queued',
      provider: original.provider,
      createdAt: now,
      updatedAt: now,
      rerunOf: original.id,
      prompt: original.prompt,
      story: original.story,
      negativePrompt: original.negativePrompt || '',
      seed: original.seed,
      seedMode: 'fixed',
      client: original.client || '',
      project: original.project || '',
      presetId: original.presetId || '',
      moduleId: original.moduleId,
      videoModelId: original.videoModelId,
      settings: original.settings,
      sourceImageAttached: original.sourceImageAttached,
      sourceImage: original.sourceImage,
      modelDir: runtime.modelDir,
      workflowConfigured: original.workflowConfigured,
      comfyUIUrl: comfyUI.baseUrl,
      workflowId: original.workflowId || '',
      workflowPath: original.workflowPath,
      workflowSha256: original.workflowSha256,
      submittedWorkflow: original.submittedWorkflow,
      comfyUIVersion,
      warnings,
      comfyPromptId: submission.prompt_id,
      queuePosition: submission.number,
      guidance: '已使用原工作的工作流快照與 seed 重新提交至本機 ComfyUI。',
      manifestPath: path.join(
        outputDir,
        INFERENCE_JOBS_DIR_NAME,
        `${Date.now()}-${rerunJobId}-${sanitizePathSegment(original.moduleId, 'job')}.json`,
      ),
    };
    await persistInferenceJob(job);
    return job;
  }

  async function handleApi(request, response, requestUrl) {
    if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, { ok: true });
    }

    if (requestUrl.pathname === '/api/config' && request.method === 'GET') {
      await ensureOutputDir();
      return sendJson(response, 200, {
        backendAvailable: true,
        outputDir,
        presetsDir,
        storageMode: 'backend',
        localGpuPreferred: true,
      });
    }

    if (requestUrl.pathname === '/api/inference/runtime' && request.method === 'GET') {
      await ensureOutputDir();
      return sendJson(response, 200, await getInferenceRuntime(outputDir, comfyUI, await listWorkflows()));
    }

    if (requestUrl.pathname === '/api/workflows' && request.method === 'GET') {
      return sendJson(response, 200, await listWorkflows());
    }

    if (requestUrl.pathname === '/api/capabilities' && request.method === 'GET') {
      const workflowId = requestUrl.searchParams.get('workflowId') || '';
      if (!workflowId) return sendJson(response, 200, { workflowId: '', ...BASE_CAPABILITIES });
      if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw createRequestError('工作流 ID 無效。');
      const workflow = await resolveWorkflow(workflowId);
      if (workflow.error) throw createRequestError(workflow.error);
      return sendJson(response, 200, { workflowId: workflow.id, ...workflow.capabilities });
    }

    if (requestUrl.pathname === '/api/inference/workflow-check' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const report = await preflightComfyWorkflow(body);
      return sendJson(response, 200, report);
    }

    if (requestUrl.pathname === '/api/models/catalog' && request.method === 'GET') {
      const runtime = await getInferenceRuntime(outputDir, comfyUI);
      return sendJson(response, 200, buildModelCatalog(runtime.modelDir));
    }

    if (requestUrl.pathname === '/api/models/setup-batch' && request.method === 'POST') {
      return sendJson(response, 201, await createModelSetupBatch());
    }

    if (requestUrl.pathname === '/api/inference/jobs' && request.method === 'GET') {
      return sendJson(response, 200, await listInferenceJobs());
    }

    if (requestUrl.pathname === '/api/inference/jobs' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return sendJson(response, 201, await createInferenceJob(body));
    }

    if (requestUrl.pathname === '/api/presets' && request.method === 'GET') {
      return sendJson(response, 200, (await listPresets()).map(toPresetResponse));
    }

    if (requestUrl.pathname === '/api/presets' && request.method === 'POST') {
      return sendJson(response, 201, await createPreset(await readJsonBody(request)));
    }

    if (requestUrl.pathname === '/api/presets/export' && request.method === 'GET') {
      return sendJson(response, 200, await exportPresets());
    }

    if (requestUrl.pathname === '/api/presets/import' && request.method === 'POST') {
      return sendJson(response, 200, await importPresets(await readJsonBody(request)));
    }

    const presetMatch = /^\/api\/presets\/([^/]+)$/u.exec(requestUrl.pathname);
    if (presetMatch && request.method === 'PUT') {
      return sendJson(response, 200, await updatePreset(decodeURIComponent(presetMatch[1]), await readJsonBody(request)));
    }
    if (presetMatch && request.method === 'DELETE') {
      return sendJson(response, 200, await deletePreset(decodeURIComponent(presetMatch[1])));
    }

    const rerunJobMatch = /^\/api\/inference\/jobs\/([^/]+)\/rerun$/u.exec(requestUrl.pathname);
    if (rerunJobMatch && request.method === 'POST') {
      return sendJson(response, 201, await rerunInferenceJob(decodeURIComponent(rerunJobMatch[1])));
    }

    const cancelJobMatch = /^\/api\/inference\/jobs\/([^/]+)\/cancel$/u.exec(requestUrl.pathname);
    if (cancelJobMatch && request.method === 'POST') {
      return sendJson(response, 200, await cancelInferenceJob(decodeURIComponent(cancelJobMatch[1])));
    }

    if (requestUrl.pathname.startsWith('/api/inference/jobs/') && request.method === 'GET') {
      const jobId = requestUrl.pathname.slice('/api/inference/jobs/'.length);
      const job = await getInferenceJob(jobId);
      if (!job) {
        sendJson(response, 404, { error: '找不到推論工作。' });
        return;
      }
      return sendJson(response, 200, job);
    }

    if (requestUrl.pathname === '/api/config/output-dir' && request.method === 'POST') {
      const body = await readJsonBody(request);
      outputDir = normalizeOutputDir(body.outputDir || outputDir);
      await ensureOutputDir();
      return sendJson(response, 200, {
        ok: true,
        outputDir,
        items: await collectVideoItems(outputDir),
      });
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'GET') {
      return sendJson(response, 200, await collectVideoItems(outputDir));
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'POST') {
      if (request.headers['content-type'] === 'application/octet-stream') {
        return sendJson(response, 201, await saveStreamedVideoAsset(request));
      }
      const body = await readJsonBody(request);
      if (!body.item || typeof body.videoBase64 !== 'string') {
        throw new Error('缺少影片資料。');
      }
      return sendJson(response, 201, await saveVideoAsset(body.item, body.videoBase64));
    }

    if (requestUrl.pathname.startsWith('/api/videos/')) {
      const encodedName = requestUrl.pathname.slice('/api/videos/'.length);
      const fileName = sanitizeFileName(decodeURIComponent(encodedName));
      const videoPath = path.join(outputDir, fileName);
      const metadataPath = path.join(outputDir, `${fileName}.json`);

      if (request.method === 'GET') {
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

      if (request.method === 'PATCH') {
        const body = await readJsonBody(request);
        const nextFileName = sanitizeFileName(body.nextFileName);
        if (path.extname(nextFileName).toLowerCase() !== path.extname(fileName).toLowerCase()) {
          throw createRequestError('重新命名不可變更影片副檔名。');
        }
        const nextVideoPath = path.join(outputDir, nextFileName);
        const nextMetadataPath = path.join(outputDir, `${nextFileName}.json`);
        return withRenameLocks([fileName, nextFileName], async () => {
          if (!(await fileExists(videoPath)) || !(await fileExists(metadataPath))) {
            sendJson(response, 404, { error: '找不到要重新命名的影片。' });
            return;
          }
          if (nextFileName === fileName) {
            const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
            return sendJson(response, 200, {
              ...metadata,
              fileName,
              previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
            });
          }
          if ((await fileExists(nextVideoPath)) || (await fileExists(nextMetadataPath))) {
            sendJson(response, 409, { error: '目標檔名已存在。' });
            return;
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
          return sendJson(response, 200, {
            ...metadata,
            previewUrl: `/api/videos/${encodeURIComponent(nextFileName)}`,
          });
        });
      }

      if (request.method === 'DELETE') {
        await fs.rm(videoPath, { force: true });
        await fs.rm(metadataPath, { force: true });
        return sendJson(response, 200, { ok: true });
      }
    }

    return false;
  }

  async function handleStatic(request, response, requestUrl) {
    const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    const targetPath = path.normalize(path.join(ROOT_DIR, pathname));
    const relativePath = path.relative(ROOT_DIR, targetPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      sendText(response, 403, 'Forbidden');
      return;
    }

    try {
      const stats = await fs.stat(targetPath);
      if (stats.isDirectory()) {
        sendText(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, { 'content-type': getContentType(targetPath) });
      response.end(await fs.readFile(targetPath));
    } catch {
      sendText(response, 404, 'Not found');
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
      if (requestUrl.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, requestUrl);
        if (handled === false) {
          sendText(response, 404, 'Not found');
        }
        return;
      }

      await handleStatic(request, response, requestUrl);
    } catch (error) {
      if (response.destroyed) return;
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(response, statusCode, { error: error.message || 'Request failed' });
    }
  });

  return {
    server,
    getOutputDir: () => outputDir,
    setOutputDir(nextOutputDir) {
      outputDir = normalizeOutputDir(nextOutputDir);
      return outputDir;
    },
  };
}

async function startServer(options = {}) {
  const app = createApp(options);
  await fs.mkdir(app.getOutputDir(), { recursive: true });
  await new Promise((resolve) => app.server.listen(options.port ?? PORT, options.host ?? HOST, resolve));
  return app;
}

if (require.main === module) {
  startServer().then((app) => {
    const address = app.server.address();
    console.log(`vedioFactory server running at http://${address.address}:${address.port}`);
    console.log(`output directory: ${app.getOutputDir()}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  startServer,
  DEFAULT_OUTPUT_DIR,
};
