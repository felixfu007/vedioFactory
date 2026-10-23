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
const DEFAULT_MODULES_DIR = path.resolve(process.env.VEDIO_FACTORY_MODULES_DIR || path.join(__dirname, 'modules'));
const MODULE_ID_PATTERN = /^[a-z\d][a-z\d-]{0,40}$/u;
const MODULE_PRESET_ID_PATTERN = /^module:[a-z\d][a-z\d-]{0,40}$/u;
const MODULE_ASSET_PATTERN = /^[\w-]+(?:\.[\w-]+)*\.(?:js|json|png|jpe?g|webp|svg)$/u;
const MAX_MODULE_MANIFEST_BYTES = 256 * 1024;
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const VIDEO_EXTENSIONS = ['.webm', '.mp4', '.gif', '.webp'];
const DEFAULT_FFMPEG_COMMAND = [process.env.VEDIO_FACTORY_FFMPEG || 'ffmpeg'];
const FFMPEG_DETECTION_TTL_MS = 30_000;
const MAX_BATCH_JOBS = 50;
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DELIVERIES_DIR_NAME = 'deliveries';
const DELIVERY_SCHEMA_VERSION = 1;
const MAX_DELIVERY_ITEMS = 500;
const MAX_BATCH_SEED_COUNT = 10;
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
        error.stderr = stderr;
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

// Keeps Unicode (e.g. Chinese client names) but drops characters Windows forbids in folder names.
function sanitizeFolderName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
    .slice(0, 60);
  if (!cleaned || /^\.+$/u.test(cleaned) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu.test(cleaned)) return fallback;
  return cleaned;
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

function parseHostList(value) {
  return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function readHostname(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return '';
  }
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
  if (presetId && !UUID_PATTERN.test(presetId) && !MODULE_PRESET_ID_PATTERN.test(presetId)) {
    throw createRequestError('預設 ID 無效。');
  }
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
  const modulesDir = path.resolve(options.modulesDir || DEFAULT_MODULES_DIR);
  // [command, ...prefixArgs] so tests can substitute a script run by node.
  const ffmpegCommand = options.ffmpegCommand || DEFAULT_FFMPEG_COMMAND;
  const allowedHostnames = new Set([
    ...LOOPBACK_HOSTNAMES,
    ...(options.allowedHosts ?? parseHostList(process.env.VEDIO_FACTORY_ALLOWED_HOSTS)),
  ]);
  let ffmpegDetection = null;
  let transcodeQueue = Promise.resolve();
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
      const { metaPath, meta } = entry.meta
        ? { metaPath: entry.metaPath, meta: entry.meta }
        : await readWorkflowMeta(entry.workflowPath);
      workflow.metaPath = metaPath;
      if (entry.scenarioModuleId) workflow.scenarioModuleId = entry.scenarioModuleId;
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
    for (const scenarioModule of await listScenarioModules()) {
      if (scenarioModule.error || !scenarioModule.workflow) continue;
      const id = scenarioModule.workflow.id;
      const duplicateIndex = entries.findIndex((entry) => entry.id === id);
      if (duplicateIndex !== -1) entries.splice(duplicateIndex, 1);
      entries.push({
        id,
        workflowPath: scenarioModule.workflow.path,
        meta: scenarioModule.workflow.meta,
        metaPath: scenarioModule.manifestPath,
        scenarioModuleId: scenarioModule.id,
      });
    }
    const workflows = await Promise.all(entries.map(describeWorkflow));
    const collator = new Intl.Collator('zh-Hant');
    // Default first, then the user's own workflows, then scenario-module workflows.
    return workflows.sort((left, right) => (
      Number(right.isDefault) - Number(left.isDefault)
      || Number(Boolean(left.scenarioModuleId)) - Number(Boolean(right.scenarioModuleId))
      || collator.compare(left.name, right.name)
    ));
  }

  // Scenario modules: modules/<id>/module.json bundles a Canvas preview, a ComfyUI workflow and a preset.
  async function readScenarioModule(id) {
    const moduleDir = path.join(modulesDir, id);
    const manifestPath = path.join(moduleDir, 'module.json');
    const stats = await fs.stat(manifestPath).catch(() => null);
    if (!stats?.isFile()) throw new Error('缺少 module.json。');
    if (stats.size > MAX_MODULE_MANIFEST_BYTES) throw new Error('module.json 超過 256 KB。');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error('module.json 不是有效的 JSON。');
    }
    if (!isPlainObject(manifest)) throw new Error('module.json 必須是 JSON 物件。');
    if (manifest.id !== id) throw new Error(`module.json 的 id 必須與資料夾名稱「${id}」相同。`);
    const name = readOptionalText(manifest, 'name', 'name', 100);
    if (!name) throw new Error('module.json 缺少 name。');
    if (manifest.tags !== undefined && (
      !Array.isArray(manifest.tags) || manifest.tags.length > 10
      || manifest.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 30)
    )) {
      throw new Error('tags 必須是最多 10 個、每個 30 字以內的字串陣列。');
    }

    async function readModuleFile(field, value, extension) {
      if (typeof value !== 'string' || !MODULE_ASSET_PATTERN.test(value) || !value.endsWith(extension)) {
        throw new Error(`${field} 必須是模組資料夾內的 ${extension} 檔名。`);
      }
      const filePath = path.join(moduleDir, value);
      if (!(await fs.stat(filePath).catch(() => null))?.isFile()) throw new Error(`找不到 ${field}：${value}。`);
      return filePath;
    }

    let canvas = null;
    if (manifest.canvas !== undefined) {
      if (!isPlainObject(manifest.canvas)) throw new Error('canvas 必須是物件。');
      await readModuleFile('canvas.entry', manifest.canvas.entry, '.js');
      canvas = {
        moduleId: `scenario-${id}`,
        url: `/scenario-modules/${id}/${manifest.canvas.entry}`,
        tagline: readOptionalText(manifest.canvas, 'tagline', 'canvas.tagline', 100),
        bestFor: readOptionalText(manifest.canvas, 'bestFor', 'canvas.bestFor', 200),
      };
    }

    let workflow = null;
    let capabilities = BASE_CAPABILITIES;
    if (manifest.workflow !== undefined) {
      if (!isPlainObject(manifest.workflow)) throw new Error('workflow 必須是物件。');
      const { file, ...meta } = manifest.workflow;
      const workflowPath = await readModuleFile('workflow.file', file, '.json');
      capabilities = narrowCapabilities(meta);
      workflow = {
        id: `module-${id}`,
        path: workflowPath,
        meta: { ...meta, name: meta.name || `${name}（場景模組）` },
      };
    }

    let preset = null;
    if (manifest.preset !== undefined) {
      if (!isPlainObject(manifest.preset)) throw new Error('preset 必須是物件。');
      preset = validatePresetPayload({
        ...manifest.preset,
        name: manifest.preset.name || name,
        moduleId: manifest.preset.moduleId ?? canvas?.moduleId ?? '',
        workflowId: manifest.preset.workflowId ?? workflow?.id ?? '',
      }, capabilities);
    }

    let example = null;
    if (manifest.example !== undefined) {
      if (!isPlainObject(manifest.example)) throw new Error('example 必須是物件。');
      const variables = manifest.example.variables ?? {};
      if (!isPlainObject(variables) || Object.entries(variables).some(([key, value]) => (
        !/^[\p{L}\p{N}_]{1,40}$/u.test(key) || typeof value !== 'string' || value.length > 200
      ))) {
        throw new Error('example.variables 必須是「變數名稱: 200 字以內文字」的物件。');
      }
      example = {
        variables,
        seed: manifest.example.seed === undefined ? null : validateSeed(manifest.example.seed),
      };
    }

    const safety = isPlainObject(manifest.safety) ? manifest.safety : {};
    if (safety.requiresPersonConsent !== undefined && typeof safety.requiresPersonConsent !== 'boolean') {
      throw new Error('safety.requiresPersonConsent 必須是 true 或 false。');
    }
    return {
      id,
      name,
      description: readOptionalText(manifest, 'description', 'description', 1_000),
      version: readOptionalText(manifest, 'version', 'version', 40),
      tags: (manifest.tags || []).map((tag) => tag.trim()),
      manifestPath,
      canvas,
      workflow,
      preset,
      example,
      safety: {
        requiresPersonConsent: safety.requiresPersonConsent === true,
        notes: readOptionalText(safety, 'notes', 'safety.notes', 1_000),
      },
      error: '',
    };
  }

  async function listScenarioModules() {
    const entries = await fs.readdir(modulesDir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const scenarioModules = [];
    for (const entry of entries) {
      // Folders starting with "_" or "." hold shared assets, not modules.
      if (!entry.isDirectory() || /^[_.]/u.test(entry.name)) continue;
      if (!MODULE_ID_PATTERN.test(entry.name)) {
        scenarioModules.push({ id: entry.name, name: entry.name, error: '模組資料夾名稱只能使用小寫英數字與 -。' });
        continue;
      }
      try {
        scenarioModules.push(await readScenarioModule(entry.name));
      } catch (error) {
        scenarioModules.push({ id: entry.name, name: entry.name, error: `場景模組無效：${error.message}` });
      }
    }
    const collator = new Intl.Collator('zh-Hant');
    return scenarioModules.sort((left, right) => collator.compare(left.name, right.name));
  }

  function toScenarioModuleResponse(scenarioModule) {
    const { manifestPath, workflow, ...rest } = scenarioModule;
    return {
      ...rest,
      workflowId: workflow?.id || '',
      presetId: scenarioModule.preset ? `module:${scenarioModule.id}` : '',
    };
  }

  async function listModulePresets() {
    return (await listScenarioModules())
      .filter((scenarioModule) => !scenarioModule.error && scenarioModule.preset)
      .map((scenarioModule) => ({
        schemaVersion: PRESET_SCHEMA_VERSION,
        id: `module:${scenarioModule.id}`,
        ...scenarioModule.preset,
        builtIn: true,
        scenarioModuleId: scenarioModule.id,
      }));
  }

  async function serveScenarioModuleAsset(response, requestUrl) {
    const match = /^\/scenario-modules\/([^/]+)\/([^/]+)$/u.exec(requestUrl.pathname);
    let id = '';
    let fileName = '';
    try {
      id = decodeURIComponent(match?.[1] || '');
      fileName = decodeURIComponent(match?.[2] || '');
    } catch {
      id = '';
    }
    if (!MODULE_ID_PATTERN.test(id) || !MODULE_ASSET_PATTERN.test(fileName)) {
      sendText(response, 404, 'Not found');
      return;
    }
    const filePath = path.join(modulesDir, id, fileName);
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      sendText(response, 404, 'Not found');
      return;
    }
    response.writeHead(200, { 'content-type': getContentType(filePath), 'cache-control': 'no-cache' });
    response.end(await fs.readFile(filePath));
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
      'frames',
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

  async function refreshJobOnce(job) {
    if (!inferenceRefreshes.has(job.id)) {
      inferenceRefreshes.set(job.id, refreshComfyInferenceJob(job));
    }
    try {
      return await inferenceRefreshes.get(job.id);
    } finally {
      inferenceRefreshes.delete(job.id);
    }
  }

  async function getInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    const job = jobs.find((item) => item.id === jobId) || null;
    if (!job?.comfyPromptId) return job;
    return refreshJobOnce(job);
  }

  async function listInferenceJobSummaries({ refresh = false, limit = Infinity } = {}) {
    const jobs = (await listInferenceJobs()).slice(0, limit);
    const summaries = [];
    for (const job of jobs) {
      if (!refresh || !job.comfyPromptId || !['queued', 'running'].includes(job.status)) {
        summaries.push(summarizeJob(job));
        continue;
      }
      try {
        summaries.push(summarizeJob(await refreshJobOnce(job)));
      } catch (error) {
        summaries.push({ ...summarizeJob(job), refreshError: error.message });
      }
    }
    return summaries;
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

  function summarizeJob(job) {
    const { submittedWorkflow, workflowPreflight, ...summary } = job;
    return { ...summary, hasWorkflowSnapshot: Boolean(submittedWorkflow) };
  }

  async function createInferenceBatch(payload) {
    if (!isPlainObject(payload)) throw createRequestError('批次資料格式錯誤。');
    const { prompts: rawPrompts, seeds: rawSeeds, seedCount: rawSeedCount, ...basePayload } = payload;
    if (rawPrompts !== undefined && (!Array.isArray(rawPrompts) || rawPrompts.some((item) => typeof item !== 'string'))) {
      throw createRequestError('prompts 必須是字串陣列。');
    }
    const cleanedPrompts = (rawPrompts || []).map((item) => item.trim()).filter(Boolean);
    const prompts = cleanedPrompts.length ? cleanedPrompts : [typeof basePayload.prompt === 'string' ? basePayload.prompt : ''];

    let seeds;
    if (rawSeeds !== undefined) {
      if (!Array.isArray(rawSeeds) || !rawSeeds.length || rawSeeds.length > MAX_BATCH_SEED_COUNT) {
        throw createRequestError(`seeds 必須是 1 至 ${MAX_BATCH_SEED_COUNT} 個 seed 的陣列。`);
      }
      seeds = rawSeeds.map(validateSeed);
    } else {
      const seedCount = rawSeedCount === undefined ? 1 : Number(rawSeedCount);
      if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > MAX_BATCH_SEED_COUNT) {
        throw createRequestError(`seedCount 必須介於 1 至 ${MAX_BATCH_SEED_COUNT}。`);
      }
      const hasBaseSeed = basePayload.seed !== undefined && basePayload.seed !== null && basePayload.seed !== '';
      // A fixed base seed expands to seed, seed+1, …; otherwise every job draws its own random seed.
      seeds = Array.from({ length: seedCount }, (_, index) => (
        hasBaseSeed ? validateSeed(validateSeed(basePayload.seed) + index) : undefined
      ));
    }
    const total = prompts.length * seeds.length;
    if (total > MAX_BATCH_JOBS) {
      throw createRequestError(`批次最多 ${MAX_BATCH_JOBS} 個工作（目前 ${prompts.length} 個提示詞 × ${seeds.length} 個 seed）。`);
    }

    const batchId = crypto.randomUUID();
    const jobs = [];
    const errors = [];
    let batchIndex = 0;
    for (const prompt of prompts) {
      for (const seed of seeds) {
        const index = batchIndex;
        batchIndex += 1;
        try {
          const job = await createInferenceJob({ ...basePayload, prompt, seed }, { batchId, batchIndex: index });
          jobs.push(summarizeJob(job));
        } catch (error) {
          errors.push({ index, prompt, seed: seed ?? null, statusCode: error.statusCode || 500, error: error.message });
        }
      }
    }
    if (!jobs.length) {
      throw createRequestError(`批次中所有工作都建立失敗：${errors[0]?.error || '未知錯誤'}`, errors[0]?.statusCode || 400);
    }
    return { batchId, total, created: jobs.length, jobs, errors };
  }

  async function createInferenceJob(payload, batch = null) {
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
      ...(batch ? { batchId: batch.batchId, batchIndex: batch.batchIndex } : {}),
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
        // Wan-style video latents need 4n+1 frames.
        frames: Math.max(1, Math.round(((Number(job.settings.duration) || 6) * (Number(job.settings.fps) || 24)) / 4) * 4 + 1),
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

  function assertEditablePreset(presetId) {
    if (MODULE_PRESET_ID_PATTERN.test(String(presetId))) {
      throw createRequestError('場景模組內建的預設不可修改或刪除；請另存為新預設。', 409);
    }
  }

  async function updatePreset(presetId, payload) {
    assertEditablePreset(presetId);
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
    assertEditablePreset(presetId);
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
    const sourcePath = path.join(outputDir, source);
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
      for (let suffix = 1; await fileExists(path.join(outputDir, targetName)); suffix += 1) {
        targetName = sanitizeFileName(`${baseName}-${suffix}.mp4`);
      }
      const targetPath = path.join(outputDir, targetName);
      const temporaryPath = path.join(outputDir, `.${crypto.randomUUID()}.transcode`);
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

    const items = await collectVideoItems(outputDir);
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
      outputDir,
      DELIVERIES_DIR_NAME,
      sanitizeFolderName(client, '未指定客戶'),
      sanitizeFolderName(project, '未指定專案'),
      `${createdAt.replace(/[:.]/gu, '-')}-${crypto.randomUUID().slice(0, 8)}`,
    );
    await fs.mkdir(path.join(deliveryDir, 'videos'), { recursive: true });

    const manifestItems = [];
    for (const item of selected) {
      const { fileSize, previewUrl, ...metadata } = item;
      await fs.copyFile(path.join(outputDir, item.fileName), path.join(deliveryDir, 'videos', item.fileName));
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
    const deliveriesRoot = path.join(outputDir, DELIVERIES_DIR_NAME);
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

  async function rerunInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    const original = jobs.find((item) => item.id === jobId);
    if (!original) throw createRequestError('找不到推論工作。', 404);
    return rerunFromRecord(original);
  }

  async function rerunFromRecord(original) {
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
        modulesDir,
        ffmpeg: await detectFfmpeg(),
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
      const limit = Number(requestUrl.searchParams.get('limit') || 500);
      return sendJson(response, 200, await listInferenceJobSummaries({
        refresh: requestUrl.searchParams.get('refresh') === '1',
        limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 500,
      }));
    }

    if (requestUrl.pathname === '/api/inference/batches' && request.method === 'POST') {
      return sendJson(response, 201, await createInferenceBatch(await readJsonBody(request)));
    }

    if (requestUrl.pathname === '/api/inference/jobs' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return sendJson(response, 201, await createInferenceJob(body));
    }

    if (requestUrl.pathname === '/api/presets' && request.method === 'GET') {
      const presets = [...await listModulePresets(), ...await listPresets()];
      return sendJson(response, 200, presets.map(toPresetResponse));
    }

    if (requestUrl.pathname === '/api/scenario-modules' && request.method === 'GET') {
      return sendJson(response, 200, (await listScenarioModules()).map(toScenarioModuleResponse));
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

    if (requestUrl.pathname === '/api/deliveries' && request.method === 'POST') {
      return sendJson(response, 201, await createDelivery(await readJsonBody(request)));
    }

    if (requestUrl.pathname === '/api/deliveries/replay' && request.method === 'POST') {
      return sendJson(response, 201, await replayDelivery(await readJsonBody(request)));
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

    const transcodeMatch = /^\/api\/videos\/([^/]+)\/transcode$/u.exec(requestUrl.pathname);
    if (transcodeMatch && request.method === 'POST') {
      return sendJson(response, 201, await transcodeVideoToMp4(decodeURIComponent(transcodeMatch[1])));
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

  // The API has no login, so only accept requests addressed to an allowed host name
  // (blocks DNS rebinding) and refuse state-changing requests from other origins (blocks CSRF).
  function guardRequest(request) {
    const hostHeader = String(request.headers.host || '').toLowerCase();
    const hostname = readHostname(hostHeader);
    if (!allowedHostnames.has(hostname)) {
      throw createRequestError(
        `不允許的 Host：${hostname || '（空白）'}。若需從其他主機名稱存取，請設定 VEDIO_FACTORY_ALLOWED_HOSTS。`,
        403,
      );
    }
    const { origin } = request.headers;
    if (SAFE_METHODS.has(request.method) || origin === undefined) return;
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = '';
    }
    if (originHost !== hostHeader) {
      throw createRequestError('拒絕跨來源請求。', 403);
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      guardRequest(request);
      const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
      if (requestUrl.pathname.startsWith('/scenario-modules/') && request.method === 'GET') {
        await serveScenarioModuleAsset(response, requestUrl);
        return;
      }
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
