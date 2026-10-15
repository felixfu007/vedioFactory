const http = require('node:http');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { URL } = require('node:url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const ROOT_DIR = __dirname;
const DEFAULT_OUTPUT_DIR = path.resolve(
  process.env.VEDIO_FACTORY_OUTPUT_DIR || path.join(os.homedir(), 'Videos', 'vedioFactory'),
);
const DEFAULT_MODEL_DIR = path.resolve(
  process.env.VEDIO_FACTORY_MODEL_DIR || path.join(os.homedir(), 'vedioFactory', 'models'),
);
const MAX_JSON_BODY = 80 * 1024 * 1024;
const INFERENCE_JOBS_DIR_NAME = 'inference-jobs';
const MODEL_SETUP_DIR_NAME = 'model-setup';
const MAX_COMFY_WORKFLOW_BYTES = 10 * 1024 * 1024;

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
};

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
  if (!normalized.endsWith('.webm')) {
    throw createRequestError('影片檔名必須以 .webm 結尾。');
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

function getComfyUIConfig(options = {}) {
  const configuredUrl = options.comfyUIUrl || process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188';
  const workflowPath = options.comfyUIWorkflowPath || process.env.VEDIO_FACTORY_COMFYUI_WORKFLOW || '';
  let baseUrl = '';
  let error = '';
  try {
    const parsed = new URL(configuredUrl);
    if (
      parsed.protocol !== 'http:'
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('ComfyUI must use an unauthenticated HTTP URL on localhost.');
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

function validateInferencePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
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
  const requestedModelId = typeof payload.videoModelId === 'string' ? payload.videoModelId : '';
  const videoModel = VIDEO_MODEL_CATALOG.find((model) => model.id === requestedModelId);
  if (requestedModelId && !videoModel) throw createRequestError('找不到所選影片模型。');
  const settings = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)
    ? payload.settings
    : {};
  const duration = Number(settings.duration ?? 6);
  const fps = Number(settings.fps ?? 24);
  const resolution = String(settings.resolution || '1280x720');
  const quality = String(settings.quality || 'balanced');
  const motion = Number(settings.motion ?? 0);
  const captionStrength = Number(settings.captionStrength ?? 0);
  if (!Number.isInteger(duration) || duration < 2 || duration > 30) {
    throw createRequestError('影片長度必須介於 2 至 30 秒。');
  }
  if (![12, 24, 30].includes(fps)) throw createRequestError('FPS 僅支援 12、24 或 30。');
  if (!['1280x720', '1920x1080', '1080x1080', '720x1280'].includes(resolution)) {
    throw createRequestError('不支援此影片解析度。');
  }
  if (!['draft', 'balanced', 'premium'].includes(quality)) {
    throw createRequestError('不支援此影片品質設定。');
  }
  if (![motion, captionStrength].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
    throw createRequestError('運鏡與文字強度必須介於 0 至 100。');
  }
  return {
    prompt,
    story,
    moduleId: typeof payload.moduleId === 'string' ? payload.moduleId.slice(0, 100) : '',
    videoModelId: videoModel?.id || VIDEO_MODEL_CATALOG[0].id,
    sourceImageDataUrl: payload.sourceImageDataUrl || '',
    settings: { duration, fps, resolution, quality, motion, captionStrength },
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

async function getInferenceRuntime(outputDir, comfyUI = getComfyUIConfig()) {
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
    workflowConfigured: Boolean(comfyUI.workflowPath),
    comfyUI: {
      ...comfy,
      workflowConfigured: Boolean(comfyUI.workflowPath),
      workflowPath: comfyUI.workflowPath,
    },
    gpu,
    guidance: [
      '請在本機啟動 ComfyUI，並將服務限制在 localhost。',
      '設定 VEDIO_FACTORY_COMFYUI_WORKFLOW 指向 ComfyUI 匯出的 API 格式工作流 JSON。',
      `模型權重預設放在 ${DEFAULT_MODEL_DIR}；ComfyUI 回傳的 .webm 影片會複製到 ${outputDir}。`,
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
    if (!entry.isFile() || !entry.name.endsWith('.webm.json')) continue;
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
  const renameLocks = new Map();
  const inferenceRefreshes = new Map();
  const comfyUI = getComfyUIConfig(options);

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

  async function loadComfyWorkflow() {
    if (!comfyUI.workflowPath) {
      throw createRequestError('尚未設定 VEDIO_FACTORY_COMFYUI_WORKFLOW。', 503);
    }
    const stats = await fs.stat(comfyUI.workflowPath).catch(() => null);
    if (!stats?.isFile() || stats.size > MAX_COMFY_WORKFLOW_BYTES) {
      throw createRequestError('ComfyUI 工作流不存在或超過 10 MB。', 400);
    }
    try {
      const workflow = JSON.parse(await fs.readFile(comfyUI.workflowPath, 'utf8'));
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        throw new Error('workflow must be an object');
      }
      return workflow;
    } catch {
      throw createRequestError('ComfyUI 工作流必須是有效的 API 格式 JSON。', 400);
    }
  }

  function inspectComfyWorkflow(workflow, modelId, hasSourceImage = false) {
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
    const selectedModel = VIDEO_MODEL_CATALOG.find((model) => model.id === modelId);
    if (selectedModel?.category === 'image-to-video' && !placeholders.has('source_image')) {
      warnings.push('所選模型以圖生影片為主，但工作流沒有 {{source_image}}；請確認它確實支援目前的輸入方式。');
    }

    const videoOutputNodes = nodeSummaries.filter(({ classType }) => /video|webm/iu.test(classType));
    if (!videoOutputNodes.length) {
      warnings.push('找不到名稱含 video/webm 的節點，請確認工作流有影片輸出節點。');
    } else {
      const outputText = videoOutputNodes
        .map(({ id }) => JSON.stringify(workflow[id].inputs))
        .join(' ');
      if (!/webm/iu.test(outputText) && !videoOutputNodes.some(({ classType }) => /webm/iu.test(classType))) {
        warnings.push('無法從輸出節點設定確認 WebM 格式；目前只有 WebM 會匯入影片庫。');
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
    if (!comfyUI.workflowPath) {
      return {
        configured: false,
        ready: false,
        selectedModelId: modelId,
        nodeCount: 0,
        nodeTypes: [],
        placeholders: [],
        videoOutputNodes: [],
        errors: ['尚未設定 VEDIO_FACTORY_COMFYUI_WORKFLOW。'],
        warnings: [],
        limitations: [],
      };
    }
    const workflow = await loadComfyWorkflow();
    return inspectComfyWorkflow(workflow, modelId, payload.hasSourceImage === true);
  }

  async function uploadComfySourceImage(dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/iu.exec(dataUrl);
    if (!match) throw createRequestError('來源圖片僅支援 PNG、JPEG 或 WebP。', 400);
    const image = Buffer.from(match[2], 'base64');
    if (!image.length || image.length > 20 * 1024 * 1024) {
      throw createRequestError('來源圖片不得為空或超過 20 MB。', 400);
    }
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[match[1].toLowerCase()];
    const form = new FormData();
    form.append('image', new Blob([image], { type: match[1] }), `vediofactory-${crypto.randomUUID()}.${extension}`);
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
        if (typeof value.filename === 'string' && /\.webm$/iu.test(value.filename)) videos.push(value);
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
      const fileName = sanitizeFileName(`comfyui-${job.id.slice(0, 8)}-${index + 1}.webm`);
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
            job.guidance = 'ComfyUI 工作已完成，但未找到 .webm 輸出；請確認工作流使用影片輸出節點並輸出 WebM。';
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

  async function createInferenceJob(payload) {
    await ensureOutputDir();
    await ensureInferenceJobDir();

    const inference = validateInferencePayload(payload);
    const runtime = await getInferenceRuntime(outputDir, comfyUI);
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: 'scaffolded',
      provider: 'comfyui-local',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: inference.prompt,
      story: inference.story,
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

    if (comfyUI.workflowPath) {
      if (!runtime.comfyUI.available) {
        throw createRequestError('無法連線至本機 ComfyUI，請確認服務已啟動。', 503);
      }
      const workflow = await loadComfyWorkflow();
      const preflight = inspectComfyWorkflow(
        workflow,
        inference.videoModelId,
        Boolean(inference.sourceImageDataUrl),
      );
      if (!preflight.ready) {
        throw createRequestError(`ComfyUI 工作流預檢失敗：${preflight.errors.join(' ')}`);
      }
      job.workflowPreflight = preflight;
      const sourceImage = inference.sourceImageDataUrl
        ? await uploadComfySourceImage(inference.sourceImageDataUrl)
        : '';
      const resolution = String(job.settings.resolution || '1280x720').split('x').map(Number);
      const variables = {
        prompt: job.prompt || job.story,
        model_id: inference.videoModelId,
        story: job.story,
        negative_prompt: '',
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
      const submission = await requestComfyUI('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: apiWorkflow, client_id: crypto.randomUUID() }),
      }).then((response) => response.json());
      if (!submission.prompt_id || (submission.node_errors && Object.keys(submission.node_errors).length)) {
        throw createRequestError(`ComfyUI 拒絕工作流：${JSON.stringify(submission.node_errors || submission)}`, 400);
      }
      job.comfyPromptId = submission.prompt_id;
      job.queuePosition = submission.number;
      job.status = 'queued';
      job.guidance = '已提交至本機 ComfyUI。請確認工作流輸出 .webm，完成後影片會匯入專案資料夾。';
    }

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
        storageMode: 'backend',
        localGpuPreferred: true,
      });
    }

    if (requestUrl.pathname === '/api/inference/runtime' && request.method === 'GET') {
      await ensureOutputDir();
      return sendJson(response, 200, await getInferenceRuntime(outputDir, comfyUI));
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
        const headers = { 'content-type': 'video/webm' };
        if (requestUrl.searchParams.get('download') === '1') {
          headers['content-disposition'] = `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
        }
        response.writeHead(200, headers);
        response.end(await fs.readFile(videoPath));
        return;
      }

      if (request.method === 'PATCH') {
        const body = await readJsonBody(request);
        const nextFileName = sanitizeFileName(body.nextFileName);
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
