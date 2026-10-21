const http = require('node:http');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream, openAsBlob } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { URL, pathToFileURL } = require('node:url');

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
const MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_METADATA_BYTES = 32 * 1024 * 1024;
const INFERENCE_JOBS_DIR_NAME = 'inference-jobs';
const MODEL_SETUP_DIR_NAME = 'model-setup';
const MAX_COMFY_WORKFLOW_BYTES = 10 * 1024 * 1024;
// 832x480 / 480x832 are low-VRAM test sizes that most video models (Wan, Hunyuan, LTX) accept natively.
// 1280x704 is Wan 2.2 TI2V-5B's native 720p size (dimensions must be multiples of 32); 704x1280 is its portrait twin.
// 544x960 / 960x544 is the measured TI2V-5B sweet spot on a 16GB card (about 211 s per 121-frame segment, ~11 GB).
const SUPPORTED_RESOLUTIONS = [
  '1280x720', '1280x704', '1920x1080', '1080x1080', '720x1280', '704x1280', '960x544', '544x960', '832x480', '480x832',
];
// A chained workflow (several sampler segments in one prompt) declares its structure on any node as
// "_meta": { "vediofactory": { "segments": 3, "overlapFrames": 1 } }. ComfyUI ignores node _meta, so the marker travels
// with the workflow file (and its sha256) without a sidecar file or an unknown top-level key.
const MAX_WORKFLOW_SEGMENTS = 16;
const MAX_WORKFLOW_OVERLAP_FRAMES = 64;
const VALIDATED_FPS_VALUES = [12, 24, 30];
const MIN_DURATION_SECONDS = 2;
const MAX_DURATION_SECONDS = 30;
const MAX_WORKFLOW_SEED = 2 ** 32 - 1;
const MAX_SOURCE_IMAGE_DIMENSION = 4096;
// Uploads go to ComfyUI's input/vediofactory folder; ComfyUI has no API to delete them afterwards.
const COMFY_UPLOAD_SUBFOLDER = 'vediofactory';
const MAX_COMFY_ERROR_CHARS = 1_000;
// Default sampler steps per quality preset; workflows that need fixed steps (e.g. distilled LoRAs) hardcode them.
const QUALITY_SAMPLER_STEPS = { draft: 12, balanced: 20, premium: 30 };
const SUPPORTED_WORKFLOW_PLACEHOLDERS = [
  'prompt',
  'model_id',
  'story',
  'negative_prompt',
  'width',
  'height',
  'duration',
  'fps',
  'frames',
  'steps',
  'seed',
  'quality',
  'motion',
  'caption_strength',
  'source_image',
  'lora_name',
  'lora_strength',
];
// A LoRA is chosen by bare file name from ComfyUI's own models/loras list: no folders (/ or \), no drive letters,
// no leading dot, .safetensors only (pickle-based .ckpt/.pt can run code when loaded).
const LORA_FILE_NAME_PATTERN = /^[\w(][\w .()+-]{0,200}\.safetensors$/u;
const MAX_LORA_STRENGTH = 2;
const DEFAULT_LORA_STRENGTH = 1;
const MAX_LISTED_LORAS = 500;
// Template marker for an optional LoRA node: a LoraLoaderModelOnly whose lora_name is exactly this placeholder is
// removed (and its consumers rewired to its model input) when no LoRA is selected.
const LORA_NAME_PLACEHOLDER_PATTERN = /^\{\{\s*lora_name\s*\}\}$/u;

// Two-stage pipeline (OPTIMIZATION_PLAN 6.9): stage 1 (VEDIO_FACTORY_COMFYUI_WORKFLOW) generates the dance motion, stage 2
// (VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW, e.g. Wan Animate) re-renders it with the identity of the source photo, driven
// by the stage-1 WebM. Only the stage-2 WebM is imported into the library.
// Stage 2 gets the stage-1 output path instead of {{frames}}/{{lora_*}} (those belong to the stage-1 model).
const STAGE2_WORKFLOW_PLACEHOLDERS = [
  ...SUPPORTED_WORKFLOW_PLACEHOLDERS.filter((name) => !['frames', 'lora_name', 'lora_strength'].includes(name)),
  'driving_video',
  'reference_strength',
];
// Driving-video length the stage-2 workflow supports (wan22-animate-dance: 4 segments of 65..81 frames). A stage-2
// workflow may override it with "_meta": { "vediofactory": { "drivingFrames": { "min": 242, "max": 321 } } }.
const DEFAULT_STAGE2_DRIVING_FRAMES = { min: 242, max: 321 };
const DEFAULT_STAGE2_STEPS = 10;
const MAX_STAGE2_STEPS = 50;
const DEFAULT_REFERENCE_STRENGTH = 1.3;
const MIN_REFERENCE_STRENGTH = 0.5;
const MAX_REFERENCE_STRENGTH = 2;
const PIPELINE_STAGE_COUNT = 2;
// Stage-1 WebMs are kept here (not listed in the library) so stage 2 can be re-run or inspected.
const PIPELINE_DRAFTS_DIR_NAME = 'pipeline-drafts';
const MAX_COMFY_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'];
// GPU safety for pipeline jobs (tools/gpu-guard.mjs). Mirrors GPU_LIMITS there; the module's own values win once loaded.
const DEFAULT_GPU_LIMITS = { maxPowerLimitW: 250, maxStartTempC: 65 };
const DEFAULT_GPU_COOLING_TIMEOUT_MINUTES = 20;
const GPU_GUARD_GUIDANCE = 'GPU 過熱、硬體降頻或斷線時伺服器會中斷 ComfyUI。請改善散熱（清灰塵、調整風扇曲線）、確認已以系統管理員執行 '
  + 'tools/gpu-safe-mode.ps1，並查看 logs/gpu 內的紀錄後再重新提交。';

// Civitai hosts. civitai.red was added on 2026-10-15 after the user confirmed it is an official Civitai domain.
// Exact hostname match only: subdomains (evil.civitai.red) and look-alikes (civitai.red.evil.com) are rejected.
const CIVITAI_MODEL_SOURCE_HOSTS = ['civitai.com', 'civitai.red'];
// Hosts that catalog weight files may point to.
const TRUSTED_MODEL_SOURCE_HOSTS = ['huggingface.co', ...CIVITAI_MODEL_SOURCE_HOSTS];

function isCivitaiModelPageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password
    && CIVITAI_MODEL_SOURCE_HOSTS.includes(url.hostname) && /^\/models\/\d+(?:\/|$)/u.test(url.pathname);
}

// Validates the provenance record of a ComfyUI weight file listed in the catalog. Civitai entries must carry the
// model page, version ID, SHA-256, license and commercial-use terms because licenses vary per model.
function validateModelFileSource(entry, modelId) {
  const fail = (reason) => {
    throw new Error(`Invalid comfyUIFiles entry for ${modelId} (${entry?.file}): ${reason}`);
  };
  if (!/^[\w.-]+\.safetensors$/u.test(entry.file || '')) fail('only .safetensors files are allowed');
  if (!['diffusion_models', 'text_encoders', 'vae', 'loras', 'clip_vision'].includes(entry.folder)) fail('unknown folder');
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) fail('sizeBytes required');
  if (!/^[a-f\d]{64}$/u.test(entry.sha256 || '')) fail('sha256 required');
  if (!entry.license) fail('license required');
  let source;
  try {
    source = new URL(entry.source);
  } catch {
    fail('source must be a valid URL');
  }
  if (source.protocol !== 'https:') fail('source must use https:');
  if (source.username || source.password || source.search || source.hash) {
    fail('source must not contain credentials, query or fragment');
  }
  const host = source.hostname;
  if (!TRUSTED_MODEL_SOURCE_HOSTS.includes(host)) fail(`untrusted source host ${host}`);
  // A Civitai entry is one that declares provider 'civitai' or points at any Civitai host; both get the Civitai rules.
  const isCivitaiHost = CIVITAI_MODEL_SOURCE_HOSTS.includes(host);
  if (entry.provider === 'civitai' && !isCivitaiHost) fail(`civitai source must be on ${CIVITAI_MODEL_SOURCE_HOSTS.join(' or ')}`);
  if (entry.provider === 'civitai' || isCivitaiHost) {
    if (!isCivitaiModelPageUrl(entry.modelPageUrl || '')) fail('modelPageUrl required');
    if (!Number.isSafeInteger(entry.modelVersionId)) fail('modelVersionId required');
    if (typeof entry.commercialUse !== 'string' || !entry.commercialUse) fail('commercialUse required');
    // Civitai download URLs end in the version ID, not the file name, so bind the URL to the declared version.
    if (source.pathname !== `/api/download/models/${entry.modelVersionId}`) {
      fail('source must be /api/download/models/{modelVersionId}');
    }
  } else if (source.pathname.slice(source.pathname.lastIndexOf('/') + 1) !== entry.file) {
    fail('source URL must end with the file name');
  }
  return entry;
}

// Video diffusion models with a 4x temporal VAE (Wan, HunyuanVideo) need 4n+1 frames.
function getWorkflowFrameCount(duration, fps) {
  return Math.max(1, Math.floor((duration * fps) / 4) * 4 + 1);
}

// Reads the optional chained-segment marker. Returns { segments, overlapFrames, nodeId } (segments 1 = not chained) or
// { error } when the marker is malformed or declared inconsistently on several nodes.
function readWorkflowSegmentPlan(workflow) {
  const declarations = [];
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const marker = node && typeof node === 'object' ? node._meta?.vediofactory : undefined;
    if (marker === undefined) continue;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      return { error: `節點 ${nodeId} 的 _meta.vediofactory 必須是物件。` };
    }
    const segments = marker.segments ?? 1;
    const overlapFrames = marker.overlapFrames ?? 0;
    if (!Number.isInteger(segments) || segments < 1 || segments > MAX_WORKFLOW_SEGMENTS) {
      return { error: `節點 ${nodeId} 的 _meta.vediofactory.segments 必須是 1 至 ${MAX_WORKFLOW_SEGMENTS} 的整數。` };
    }
    if (!Number.isInteger(overlapFrames) || overlapFrames < 0 || overlapFrames > MAX_WORKFLOW_OVERLAP_FRAMES) {
      return { error: `節點 ${nodeId} 的 _meta.vediofactory.overlapFrames 必須是 0 至 ${MAX_WORKFLOW_OVERLAP_FRAMES} 的整數。` };
    }
    declarations.push({ segments, overlapFrames, nodeId });
  }
  if (declarations.some(({ segments, overlapFrames }) => (
    segments !== declarations[0].segments || overlapFrames !== declarations[0].overlapFrames
  ))) {
    return { error: '工作流有多個互相矛盾的 _meta.vediofactory 段數設定。' };
  }
  return declarations[0] || { segments: 1, overlapFrames: 0, nodeId: null };
}

// Frames for one sampler segment. A single-segment workflow keeps the original rounding (floor to 4n+1). A chained
// workflow treats duration as the TOTAL length and picks the smallest 4n+1 per segment so that
// segments x frames - (segments - 1) x overlap >= duration x fps.
function getSegmentFrameCount(duration, fps, plan = { segments: 1, overlapFrames: 0 }) {
  if (!plan || plan.segments <= 1) return getWorkflowFrameCount(duration, fps);
  const neededPerSegment = (duration * fps + (plan.segments - 1) * plan.overlapFrames) / plan.segments;
  let frames = Math.max(1, Math.ceil((neededPerSegment - 1) / 4) * 4 + 1);
  // Each segment must contribute at least one new frame beyond the overlap.
  while (frames <= plan.overlapFrames) frames += 4;
  return frames;
}

function getTotalFrameCount(segmentFrames, plan = { segments: 1, overlapFrames: 0 }) {
  if (!plan || plan.segments <= 1) return segmentFrames;
  return plan.segments * segmentFrames - (plan.segments - 1) * plan.overlapFrames;
}

// Longest whole-second duration whose per-segment frame count stays within maxFrames (0 = none fits).
function getMaxDurationSeconds(maxFrames, fps, plan) {
  let maxDuration = 0;
  for (let seconds = MIN_DURATION_SECONDS; seconds <= MAX_DURATION_SECONDS; seconds += 1) {
    if (getSegmentFrameCount(seconds, fps, plan) > maxFrames) break;
    maxDuration = seconds;
  }
  return maxDuration;
}

// Public description of a workflow's segment structure, with the longest duration per fps for a model frame limit.
function describeWorkflowSegments(plan, maxFrames) {
  return {
    segments: plan.segments,
    overlapFrames: plan.overlapFrames,
    chained: plan.segments > 1,
    durationIsTotal: true,
    ...(maxFrames ? {
      maxFramesPerSegment: maxFrames,
      maxDurationSecondsByFps: Object.fromEntries(
        VALIDATED_FPS_VALUES.map((fps) => [fps, getMaxDurationSeconds(maxFrames, fps, plan)]),
      ),
    } : {}),
  };
}

// Supported driving-video length of a stage-2 workflow: its _meta.vediofactory.drivingFrames, else the default.
// Returns { min, max } or { error }.
function readStage2DrivingFrames(workflow) {
  let declared;
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const marker = node && typeof node === 'object' ? node._meta?.vediofactory : undefined;
    if (!marker || typeof marker !== 'object' || marker.drivingFrames === undefined) continue;
    const { min, max } = marker.drivingFrames || {};
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 100_000 || min > max) {
      return { error: `節點 ${nodeId} 的 _meta.vediofactory.drivingFrames 必須是 { min, max } 整數且 min ≤ max。` };
    }
    if (declared && (declared.min !== min || declared.max !== max)) {
      return { error: '第二階段工作流有多個互相矛盾的 drivingFrames 設定。' };
    }
    declared = { min, max };
  }
  return declared || { ...DEFAULT_STAGE2_DRIVING_FRAMES };
}

// Whole-second durations whose stage-1 output (total frames) fits the stage-2 driving range and whose per-segment
// frames stay within the stage-1 model limit. Returns { min, max, seconds[] } or null when none fits.
function getPipelineDurationRange(fps, stage1Plan, maxFramesPerSegment, drivingFrames) {
  const seconds = [];
  for (let duration = MIN_DURATION_SECONDS; duration <= MAX_DURATION_SECONDS; duration += 1) {
    const frames = getSegmentFrameCount(duration, fps, stage1Plan);
    if (maxFramesPerSegment && frames > maxFramesPerSegment) continue;
    const total = getTotalFrameCount(frames, stage1Plan);
    if (total >= drivingFrames.min && total <= drivingFrames.max) seconds.push(duration);
  }
  return seconds.length ? { min: seconds[0], max: seconds[seconds.length - 1], seconds } : null;
}

function describePipelineDurations(stage1Plan, maxFramesPerSegment, drivingFrames) {
  return Object.fromEntries(VALIDATED_FPS_VALUES.map((fps) => [
    fps, getPipelineDurationRange(fps, stage1Plan, maxFramesPerSegment, drivingFrames),
  ]));
}

// Real numbers or plain decimal strings only (no true, '0x1', ' ', '1e0'); NaN otherwise.
function parseStrictDecimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && /^\d{1,3}(?:\.\d{1,4})?$/u.test(value)) return Number(value);
  return NaN;
}

function validateReferenceStrength(value) {
  const strength = parseStrictDecimal(value);
  if (!Number.isFinite(strength) || strength < MIN_REFERENCE_STRENGTH || strength > MAX_REFERENCE_STRENGTH) {
    throw createRequestError(`參考強度必須是 ${MIN_REFERENCE_STRENGTH} 至 ${MAX_REFERENCE_STRENGTH} 的數字。`);
  }
  return strength;
}

function validateStage2Steps(value) {
  const steps = typeof value === 'string' && /^\d{1,3}$/u.test(value) ? Number(value) : value;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STAGE2_STEPS) {
    throw createRequestError(`第二階段步數必須是 1 至 ${MAX_STAGE2_STEPS} 的整數。`);
  }
  return steps;
}

const isProvided = (value) => value !== undefined && value !== null && value !== '';

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
    workflowNotes: '專案附 workflows/wan22-ti2v-5b-i2v.api.json（只用 ComfyUI 內建節點，SaveWEBM 輸出）；原生 24 fps、最多 121 影格（約 5 秒），720p 原生尺寸為 1280x704。',
    workflowFile: 'workflows/wan22-ti2v-5b-i2v.api.json',
    recommendedMaxFrames: 121,
    // Measured on RTX 5070 Ti 16GB (I2V): best quality/speed balance, about 5 minutes per clip.
    recommendedSettings: { resolution: '1280x704', duration: 5, fps: 24, quality: 'balanced' },
    timingHint: '實測 RTX 5070 Ti：1280×704、5 秒、平衡品質約需 5 分鐘；832×480、2 秒約 30 秒，適合快速試跑。',
    comfyUIFiles: [
      {
        provider: 'huggingface',
        folder: 'diffusion_models',
        file: 'wan2.2_ti2v_5B_fp16.safetensors',
        sizeBytes: 9_999_658_848,
        sha256: '456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e',
        source: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
        license: 'Apache-2.0',
        commercialUse: 'Apache-2.0 允許商用（仍須遵守模型卡使用限制）',
      },
      {
        provider: 'huggingface',
        folder: 'text_encoders',
        file: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
        sizeBytes: 6_735_906_897,
        sha256: 'c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68',
        source: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
        license: 'Apache-2.0',
        commercialUse: 'Apache-2.0 允許商用',
      },
      {
        provider: 'huggingface',
        folder: 'vae',
        file: 'wan2.2_vae.safetensors',
        sizeBytes: 1_409_400_960,
        sha256: 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156',
        source: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
        license: 'Apache-2.0',
        commercialUse: 'Apache-2.0 允許商用',
      },
    ],
    license: 'Apache-2.0（權重；商用前仍請查核模型卡）',
    sourceUrl: 'https://github.com/Wan-Video/Wan2.2',
    windowsProfile: { runtime: 'ComfyUI（內建節點）', vramHint: '16GB：可跑 720p；先用 832x480、短片長驗證' },
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

for (const model of VIDEO_MODEL_CATALOG) {
  for (const entry of model.comfyUIFiles || []) validateModelFileSource(entry, model.id);
}

// Provenance and usage terms of known LoRAs, shown in the UI when a LoRA with the same file name is installed in
// ComfyUI. vedioFactory never downloads these files. Same validation rules as catalog weight files.
const LORA_CATALOG = [
  {
    id: 'dr34ml4y-ti2v-5b-v1',
    name: 'DR34ML4Y - All-In-One NSFW (TI2V-5B V1)',
    baseModel: 'Wan Video 2.2 TI2V-5B',
    compatibleVideoModelIds: ['wan-2.2-ti2v-5b'],
    nsfw: true,
    trainedWords: ['m15510n4ry', 'bl0wj0b', 'd0ubl3_bj', 'd0gg1e', 'c0wg1rl'],
    recommendedStrength: 1,
    provider: 'civitai',
    folder: 'loras',
    file: 'DR34ML4Y_TI2V_5B_V1.safetensors',
    sizeBytes: 322_511_720,
    sha256: 'd646701e1f9ec369d78146cbfd5fe71b4abaf145e33f6ab93ff698f6755354ee',
    source: 'https://civitai.com/api/download/models/2099309',
    modelPageUrl: 'https://civitai.com/models/1811313',
    modelVersionId: 2099309,
    license: 'Civitai 授權：不可商用（僅允許 Civitai 站內算力出租 RentCivit）、不可散布衍生模型、不可更換授權；不需署名。成人內容，僅限個人使用。',
    commercialUse: '不可商用（allowCommercialUse: RentCivit only）',
  },
];

for (const lora of LORA_CATALOG) validateModelFileSource(lora, lora.id);

function isValidLoraFileName(value) {
  return typeof value === 'string' && LORA_FILE_NAME_PATTERN.test(value) && !value.includes('..');
}

// Reads the lora_name combo options out of a ComfyUI /object_info node definition (old list form or COMBO form).
function getComboOptions(definition, inputName) {
  const spec = definition?.input?.required?.[inputName] ?? definition?.input?.optional?.[inputName];
  if (!Array.isArray(spec)) return [];
  const options = Array.isArray(spec[0]) ? spec[0] : spec[0] === 'COMBO' ? spec[1]?.options : null;
  return Array.isArray(options) ? options.filter((option) => typeof option === 'string') : [];
}

// Removes LoraLoaderModelOnly nodes that are only LoRA placeholders and points their consumers at the node's own
// model input, so a run without a LoRA submits exactly the graph that has no LoRA node at all.
function bypassPlaceholderLoraNodes(workflow) {
  const bypassed = new Map();
  for (const [nodeId, node] of Object.entries(workflow)) {
    const model = node?.inputs?.model;
    if (node?.class_type === 'LoraLoaderModelOnly'
      && typeof node.inputs.lora_name === 'string' && LORA_NAME_PLACEHOLDER_PATTERN.test(node.inputs.lora_name)
      && Array.isArray(model) && model.length === 2) {
      bypassed.set(nodeId, model);
    }
  }
  if (!bypassed.size) return workflow;
  const resolveLink = (value) => {
    let link = value;
    for (let hops = 0; hops <= bypassed.size; hops += 1) {
      if (!Array.isArray(link) || link.length !== 2 || link[1] !== 0 || !bypassed.has(String(link[0]))) return link;
      link = bypassed.get(String(link[0]));
    }
    throw createRequestError('工作流的 LoRA 節點形成循環連線。', 400);
  };
  const result = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (bypassed.has(nodeId)) continue;
    if (!node?.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      result[nodeId] = node;
      continue;
    }
    result[nodeId] = {
      ...node,
      inputs: Object.fromEntries(Object.entries(node.inputs).map(([name, value]) => [name, resolveLink(value)])),
    };
  }
  return result;
}

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

// Host names a browser may use to reach this server. Docker publishes container port 8000 on another host port, so
// VEDIO_FACTORY_PUBLIC_PORT (comma-separated) adds the ports the browser actually sees.
function getAllowedApiHosts(listenPort, publicPorts = process.env.VEDIO_FACTORY_PUBLIC_PORT || '') {
  const ports = new Set([String(listenPort)]);
  for (const port of String(publicPorts).split(',').map((item) => item.trim())) {
    if (/^\d{1,5}$/u.test(port)) ports.add(String(Number(port)));
  }
  const hosts = new Set();
  for (const port of ports) {
    for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
      hosts.add(`${name}:${port}`);
      if (port === '80') hosts.add(name);
    }
  }
  return hosts;
}

// CSRF / DNS-rebinding guard for /api/*: the Host must be a loopback name on our port, a present Origin must match it,
// and state-changing requests must be JSON (a content type cross-site pages cannot send without a CORS preflight).
function assertTrustedApiRequest(request, requestUrl, allowedHosts) {
  const host = String(request.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) {
    throw createRequestError('拒絕的 Host 標頭；請以 http://127.0.0.1 或 http://localhost 開啟網站。', 403);
  }
  const origin = request.headers.origin;
  if (origin !== undefined && String(origin).toLowerCase() !== `http://${host}`) {
    throw createRequestError('拒絕跨來源請求。', 403);
  }
  if (request.method === 'GET' || request.method === 'HEAD') return;

  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json') return;
  // Browsers always send Origin (or at least Sec-Fetch-Site) on non-GET requests, so a request with neither comes
  // from a non-browser client such as curl or the test suite, which cannot be driven by a malicious web page.
  const trustedCaller = request.headers['x-vediofactory-request'] === '1'
    || origin !== undefined
    || request.headers['sec-fetch-site'] === undefined;
  const isBinaryUpload = requestUrl.pathname === '/api/videos'
    && request.method === 'POST'
    && contentType === 'application/octet-stream';
  const hasBody = Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding'] !== undefined;
  const isBodyless = !contentType && !hasBody;
  if ((isBinaryUpload || isBodyless) && trustedCaller) return;
  throw createRequestError('API 請求必須使用 Content-Type: application/json。', 415);
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
  for (const field of ['prompt', 'story', 'moduleId', 'moduleName', 'resolution', 'quality']) {
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

function summarizeComfyNodeErrors(nodeErrors) {
  return Object.entries(nodeErrors).slice(0, 10).map(([nodeId, entry]) => {
    const messages = (Array.isArray(entry?.errors) ? entry.errors : [])
      .map((error) => error?.details || error?.message)
      .filter(Boolean);
    return `節點 ${nodeId}（${entry?.class_type || '未知'}）：${messages.join('；') || '驗證失敗'}`;
  }).join(' ').slice(0, MAX_COMFY_ERROR_CHARS);
}

// Decodes a source-image data URL and checks that the bytes really are the declared PNG/JPEG/WebP, reading the pixel
// size from the header so oversized images are refused before anything is uploaded to ComfyUI.
function parseSourceImageDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/iu.exec(dataUrl);
  if (!match) throw createRequestError('來源圖片僅支援 PNG、JPEG 或 WebP。', 400);
  const mimeType = match[1].toLowerCase();
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 20 * 1024 * 1024) {
    throw createRequestError('來源圖片不得為空或超過 20 MB。', 400);
  }
  let size = null;
  if (mimeType === 'image/png') {
    if (image.length >= 24 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && image.toString('latin1', 12, 16) === 'IHDR') {
      size = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
    }
  } else if (mimeType === 'image/jpeg') {
    if (image.length >= 4 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
      let offset = 2;
      while (offset + 9 <= image.length && image[offset] === 0xff) {
        const marker = image[offset + 1];
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          size = { width: image.readUInt16BE(offset + 7), height: image.readUInt16BE(offset + 5) };
          break;
        }
        if (marker === 0xd9 || marker === 0xda) break;
        offset += 2 + image.readUInt16BE(offset + 2);
      }
    }
  } else if (image.length >= 30 && image.toString('latin1', 0, 4) === 'RIFF' && image.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = image.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && image[23] === 0x9d && image[24] === 0x01 && image[25] === 0x2a) {
      size = { width: image.readUInt16LE(26) & 0x3fff, height: image.readUInt16LE(28) & 0x3fff };
    } else if (chunk === 'VP8L' && image[20] === 0x2f) {
      const bits = image.readUInt32LE(21);
      size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (chunk === 'VP8X') {
      size = { width: image.readUIntLE(24, 3) + 1, height: image.readUIntLE(27, 3) + 1 };
    }
  }
  if (!size) throw createRequestError(`來源圖片內容與宣告的格式 ${mimeType} 不符或已損毀。`, 400);
  if (!size.width || !size.height
    || size.width > MAX_SOURCE_IMAGE_DIMENSION || size.height > MAX_SOURCE_IMAGE_DIMENSION) {
    throw createRequestError(
      `來源圖片尺寸 ${size.width}x${size.height} 無效；寬高須介於 1 至 ${MAX_SOURCE_IMAGE_DIMENSION} 像素。`,
      400,
    );
  }
  return { image, mimeType, ...size };
}

function getComfyUIConfig(options = {}) {
  const configuredUrl = options.comfyUIUrl || process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188';
  const workflowPath = options.comfyUIWorkflowPath || process.env.VEDIO_FACTORY_COMFYUI_WORKFLOW || '';
  const stage2WorkflowPath = options.comfyUIStage2WorkflowPath ?? process.env.VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW ?? '';
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
    stage2WorkflowPath: stage2WorkflowPath ? path.resolve(stage2WorkflowPath) : '',
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
  if (!Number.isInteger(duration) || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    throw createRequestError(`影片長度必須介於 ${MIN_DURATION_SECONDS} 至 ${MAX_DURATION_SECONDS} 秒。`);
  }
  if (!VALIDATED_FPS_VALUES.includes(fps)) throw createRequestError('FPS 僅支援 12、24 或 30。');
  if (!SUPPORTED_RESOLUTIONS.includes(resolution)) {
    throw createRequestError('不支援此影片解析度。');
  }
  const hasSeed = settings.seed !== undefined && settings.seed !== null && settings.seed !== '';
  // Only integer numbers or plain decimal digit strings; Number() would also accept true, '0x10', ' ' and '1e3'.
  const seedIsWellFormed = !hasSeed
    || Number.isSafeInteger(settings.seed)
    || (typeof settings.seed === 'string' && /^\d{1,10}$/u.test(settings.seed));
  const seed = !hasSeed ? crypto.randomInt(0, MAX_WORKFLOW_SEED + 1) : seedIsWellFormed ? Number(settings.seed) : NaN;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_WORKFLOW_SEED) {
    throw createRequestError(`種子必須是 0 至 ${MAX_WORKFLOW_SEED} 的整數。`);
  }
  if (!['draft', 'balanced', 'premium'].includes(quality)) {
    throw createRequestError('不支援此影片品質設定。');
  }
  if (![motion, captionStrength].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
    throw createRequestError('運鏡與文字強度必須介於 0 至 100。');
  }
  const hasLora = settings.loraName !== undefined && settings.loraName !== null && settings.loraName !== '';
  if (hasLora && !isValidLoraFileName(settings.loraName)) {
    throw createRequestError('LoRA 必須是 ComfyUI models/loras 資料夾中的 .safetensors 檔名（不可含路徑）。');
  }
  const videoModelId = videoModel?.id || VIDEO_MODEL_CATALOG[0].id;
  const knownLora = hasLora ? LORA_CATALOG.find((lora) => lora.file === settings.loraName) : null;
  if (knownLora && !knownLora.compatibleVideoModelIds.includes(videoModelId)) {
    throw createRequestError(`LoRA ${knownLora.file} 與所選影片模型不相容（基底模型：${knownLora.baseModel}）。`);
  }
  const hasLoraStrength = settings.loraStrength !== undefined && settings.loraStrength !== null && settings.loraStrength !== '';
  // Same strictness as the seed: real numbers or plain decimal strings only (no true, '0x1', ' ', '1e0').
  const loraStrengthIsWellFormed = !hasLoraStrength
    || (typeof settings.loraStrength === 'number' && Number.isFinite(settings.loraStrength))
    || (typeof settings.loraStrength === 'string' && /^\d{1,2}(?:\.\d{1,4})?$/u.test(settings.loraStrength));
  const loraStrength = !hasLoraStrength ? DEFAULT_LORA_STRENGTH : loraStrengthIsWellFormed ? Number(settings.loraStrength) : NaN;
  if (!Number.isFinite(loraStrength) || loraStrength < 0 || loraStrength > MAX_LORA_STRENGTH) {
    throw createRequestError(`LoRA 強度必須是 0 至 ${MAX_LORA_STRENGTH} 的數字。`);
  }
  // Two-stage pipeline settings; validated whenever sent, only used (and stored) in pipeline mode.
  const referenceStrength = isProvided(settings.referenceStrength) ? validateReferenceStrength(settings.referenceStrength) : undefined;
  const stage2Steps = isProvided(settings.stage2Steps) ? validateStage2Steps(settings.stage2Steps) : undefined;
  return {
    referenceStrength,
    stage2Steps,
    prompt,
    story,
    moduleId: typeof payload.moduleId === 'string' ? payload.moduleId.slice(0, 100) : '',
    videoModelId,
    sourceImageDataUrl: payload.sourceImageDataUrl || '',
    // LoRA fields only exist when a LoRA is chosen, so runs without one keep the exact pre-LoRA job shape.
    settings: {
      duration, fps, resolution, quality, motion, captionStrength, seed,
      ...(hasLora ? { loraName: settings.loraName, loraStrength } : {}),
    },
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
      '請在本機啟動 ComfyUI；Docker 部署時使用 host.docker.internal，並透過防火牆限制存取。',
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
  const maxVideoUploadBytes = options.maxVideoUploadBytes ?? MAX_VIDEO_UPLOAD_BYTES;
  let allowedApiHosts = null;
  const pipelineMode = Boolean(comfyUI.stage2WorkflowPath);
  // GPU guard for pipeline jobs: options.gpuGuard = false disables it, an object replaces tools/gpu-guard.mjs (tests);
  // otherwise VEDIO_FACTORY_GPU_GUARD=off|0|false|no disables it (CI / machines without an NVIDIA GPU). Default on.
  const gpuGuardEnabled = options.gpuGuard === false ? false
    : options.gpuGuard && typeof options.gpuGuard === 'object' ? true
      : !/^(?:0|off|false|no|disabled)$/iu.test(String(process.env.VEDIO_FACTORY_GPU_GUARD || '').trim());
  const coolingMinutesFromEnv = Number(process.env.VEDIO_FACTORY_GPU_COOLING_MINUTES);
  const gpuCoolingTimeoutMs = options.gpuCoolingTimeoutMs ?? (
    Number.isFinite(coolingMinutesFromEnv) && coolingMinutesFromEnv > 0 ? coolingMinutesFromEnv : DEFAULT_GPU_COOLING_TIMEOUT_MINUTES
  ) * 60_000;
  const gpuCoolingCheckIntervalMs = options.gpuCoolingCheckIntervalMs ?? 30_000;
  // A guard whose sample count stops growing this long is treated as a lost GPU (nvidia-smi hung or exited).
  const gpuGuardStaleMs = options.gpuGuardStaleMs ?? 60_000;
  // Background polling that advances pipeline jobs without a browser open; 0 disables it (tests drive by polling).
  const pipelinePollIntervalMs = options.pipelinePollIntervalMs ?? 5_000;
  const jobLocks = new Map();
  const pipelineDrivers = new Map();
  const activeGpuGuards = new Map();
  const gpuGuardAlarms = new Map();
  let gpuModulePromise = null;
  let appClosed = false;

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
      let parsed = null;
      try {
        parsed = JSON.parse(details);
      } catch {
        parsed = null;
      }
      // /prompt answers HTTP 400 with node_errors when validation fails (e.g. a model file is missing).
      if (parsed?.node_errors && Object.keys(parsed.node_errors).length) {
        throw createRequestError(`ComfyUI 拒絕工作流：${summarizeComfyNodeErrors(parsed.node_errors)}`, 400);
      }
      if (parsed?.error?.message) {
        const extra = parsed.error.details ? `（${String(parsed.error.details)}）` : '';
        throw createRequestError(
          `ComfyUI 拒絕工作流：${`${parsed.error.message}${extra}`.slice(0, MAX_COMFY_ERROR_CHARS)}`,
          400,
        );
      }
      const error = createRequestError(
        `ComfyUI 請求失敗（${response.status}）：${details.slice(0, MAX_COMFY_ERROR_CHARS)}`,
        502,
      );
      error.comfyStatus = response.status;
      throw error;
    }
    return response;
  }

  // Compares a workflow against the running ComfyUI's node definitions: missing node classes usually mean a
  // missing custom node; combo values not offered by ComfyUI usually mean a missing model file.
  async function checkWorkflowAgainstComfyUI(workflow) {
    const result = { checked: false, missingNodeTypes: [], missingValues: [], errors: [] };
    const classTypes = [...new Set(Object.values(workflow)
      .filter((node) => node && typeof node.class_type === 'string')
      .map((node) => node.class_type))];
    let definitions;
    try {
      const responses = await Promise.all(classTypes.map((classType) => (
        requestComfyUI(`/object_info/${encodeURIComponent(classType)}`, { signal: AbortSignal.timeout(15_000) })
          .then((response) => response.json())
      )));
      definitions = Object.assign({}, ...responses);
    } catch (error) {
      result.error = `無法取得 ComfyUI 節點定義，略過即時檢查：${error.message}`;
      return result;
    }
    result.checked = true;
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (!node || typeof node.class_type !== 'string' || !node.inputs) continue;
      const definition = definitions[node.class_type];
      if (!definition) {
        result.missingNodeTypes.push({ nodeId, classType: node.class_type });
        continue;
      }
      const specs = { ...definition.input?.required, ...definition.input?.optional };
      for (const [inputName, value] of Object.entries(node.inputs)) {
        if (typeof value !== 'string' || value.includes('{{')) continue;
        const spec = specs[inputName];
        if (!Array.isArray(spec) || spec[1]?.image_upload || spec[1]?.multiselect) continue;
        const options = Array.isArray(spec[0]) ? spec[0] : spec[0] === 'COMBO' ? spec[1]?.options : null;
        if (!Array.isArray(options) || options.some((option) => option && typeof option === 'object')) continue;
        if (!options.map(String).includes(value)) {
          result.missingValues.push({ nodeId, classType: node.class_type, input: inputName, value });
        }
      }
    }
    for (const { nodeId, classType } of result.missingNodeTypes) {
      result.errors.push(`ComfyUI 沒有節點 ${classType}（節點 ${nodeId}）；請更新 ComfyUI 或安裝對應的 custom node。`);
    }
    for (const { nodeId, classType, input, value } of result.missingValues) {
      result.errors.push(`ComfyUI 找不到 ${classType}.${input} = "${value}"（節點 ${nodeId}）；請確認模型檔已放入 ComfyUI 對應的 models 資料夾。`);
    }
    return result;
  }

  async function loadComfyWorkflow(workflowPath = comfyUI.workflowPath) {
    if (!workflowPath) {
      throw createRequestError('尚未設定 VEDIO_FACTORY_COMFYUI_WORKFLOW。', 503);
    }
    const stats = await fs.stat(workflowPath).catch(() => null);
    if (!stats?.isFile() || stats.size > MAX_COMFY_WORKFLOW_BYTES) {
      throw createRequestError('ComfyUI 工作流不存在或超過 10 MB。', 400);
    }
    try {
      const bytes = await fs.readFile(workflowPath);
      const workflow = JSON.parse(bytes.toString('utf8'));
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        throw new Error('workflow must be an object');
      }
      // Not enumerable, so it never leaks into the workflow sent to ComfyUI.
      Object.defineProperty(workflow, 'sha256', {
        value: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
      return workflow;
    } catch {
      throw createRequestError('ComfyUI 工作流必須是有效的 API 格式 JSON。', 400);
    }
  }

  // LoRA file names offered by ComfyUI's LoraLoaderModelOnly node, i.e. what is in its models/loras folder(s).
  // Entries in subfolders or with other extensions are dropped: only bare .safetensors names can be selected.
  async function listComfyLoras() {
    const response = await requestComfyUI('/object_info/LoraLoaderModelOnly', { signal: AbortSignal.timeout(15_000) });
    const info = await response.json().catch(() => null);
    const definition = info?.LoraLoaderModelOnly;
    if (!definition) throw createRequestError('ComfyUI 沒有 LoraLoaderModelOnly 節點；請更新 ComfyUI。', 502);
    return [...new Set(getComboOptions(definition, 'lora_name').filter(isValidLoraFileName))]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_LISTED_LORAS);
  }

  async function describeComfyLoras() {
    const catalog = LORA_CATALOG.map((lora) => ({
      id: lora.id,
      name: lora.name,
      file: lora.file,
      baseModel: lora.baseModel,
      compatibleVideoModelIds: lora.compatibleVideoModelIds,
      nsfw: lora.nsfw,
      trainedWords: lora.trainedWords,
      recommendedStrength: lora.recommendedStrength,
      sha256: lora.sha256,
      sizeBytes: lora.sizeBytes,
      modelPageUrl: lora.modelPageUrl,
      modelVersionId: lora.modelVersionId,
      license: lora.license,
      commercialUse: lora.commercialUse,
    }));
    const base = { maxStrength: MAX_LORA_STRENGTH, defaultStrength: DEFAULT_LORA_STRENGTH };
    try {
      const loras = await listComfyLoras();
      return {
        available: true,
        loras,
        ...base,
        catalog: catalog.map((entry) => ({ ...entry, installed: loras.includes(entry.file) })),
      };
    } catch (error) {
      return {
        available: false,
        loras: [],
        ...base,
        catalog: catalog.map((entry) => ({ ...entry, installed: false })),
        error: String(error.message || error).slice(0, MAX_COMFY_ERROR_CHARS),
      };
    }
  }

  // stage 2 = the identity re-render of a pipeline: other placeholder set, {{driving_video}} and a source image required.
  function inspectComfyWorkflow(workflow, modelId, hasSourceImage = false, { stage = 0 } = {}) {
    const isStage2 = stage === 2;
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

    const supportedPlaceholders = new Set(isStage2 ? STAGE2_WORKFLOW_PLACEHOLDERS : SUPPORTED_WORKFLOW_PLACEHOLDERS);
    const unsupportedPlaceholders = [...placeholders].filter((name) => !supportedPlaceholders.has(name));
    if (unsupportedPlaceholders.length) {
      const stageOnly = !isStage2 && unsupportedPlaceholders.some((name) => STAGE2_WORKFLOW_PLACEHOLDERS.includes(name))
        ? '（{{driving_video}}／{{reference_strength}} 只能用於第二階段工作流 VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW）'
        : '';
      errors.push(`工作流包含不支援的佔位符：${unsupportedPlaceholders.map((name) => `{{${name}}}`).join('、')}${stageOnly}`);
    }
    if (isStage2) {
      if (!placeholders.has('driving_video')) errors.push('第二階段工作流必須使用 {{driving_video}} 讀取第一階段影片。');
      if (!placeholders.has('source_image')) errors.push('第二階段工作流必須使用 {{source_image}} 作為人物參考照片。');
      if (!placeholders.has('reference_strength')) {
        warnings.push('第二階段工作流沒有 {{reference_strength}}；參考強度設定不會生效。');
      }
    }
    if (placeholders.has('source_image') && !hasSourceImage) {
      errors.push('此工作流需要來源圖片，但目前沒有選取圖片。');
    }
    if (!placeholders.has('prompt') && !placeholders.has('story')) {
      warnings.push('工作流沒有提示詞或影片描述佔位符，網站輸入的文字不會傳入工作流。');
    }
    if (!isStage2 && !placeholders.has('model_id')) {
      warnings.push('工作流未使用 {{model_id}}；所選模型只會記錄在工作清單，不會改變工作流中的模型節點。');
    }
    const selectedModel = VIDEO_MODEL_CATALOG.find((model) => model.id === modelId);
    const segmentPlan = readWorkflowSegmentPlan(workflow);
    if (segmentPlan.error) errors.push(segmentPlan.error);
    // Stage 2 derives its segment lengths from the driving video, so it has no {{frames}} by design.
    if (!isStage2 && segmentPlan.segments > 1 && !placeholders.has('frames')) {
      warnings.push('工作流宣告了多段串接，但沒有 {{frames}}；伺服器無法控制每段影格數。');
    }
    if (isStage2) {
      const drivingFrames = readStage2DrivingFrames(workflow);
      if (drivingFrames.error) errors.push(drivingFrames.error);
    }
    if (!isStage2 && selectedModel?.category === 'image-to-video' && !placeholders.has('source_image')) {
      warnings.push('所選模型以圖生影片為主，但工作流沒有 {{source_image}}；請確認它確實支援目前的輸入方式。');
    }

    // Loaders/latent nodes such as Wan22ImageToVideoLatent also contain "video", so require a save/combine verb.
    const videoOutputNodes = nodeSummaries.filter(({ classType }) => (
      /webm/iu.test(classType) || (/video/iu.test(classType) && /save|combine|write|output/iu.test(classType))
    ));
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
      workflowSegments: describeWorkflowSegments(
        segmentPlan.error ? { segments: 1, overlapFrames: 0 } : segmentPlan,
        selectedModel?.recommendedMaxFrames,
      ),
      errors,
      warnings,
      limitations: [
        '預檢不會執行 ComfyUI 工作流，也無法確認模型權重、custom nodes、VRAM 或節點間的實際相容性。',
        '影片輸出節點與 WebM 格式只能依節點名稱/設定做靜態提示，最終仍需實際生成驗證。',
      ],
    };
  }

  function describeGpuGuardConfig(limits = DEFAULT_GPU_LIMITS) {
    return {
      enabled: gpuGuardEnabled,
      maxPowerLimitW: limits.maxPowerLimitW,
      maxStartTempC: limits.maxStartTempC,
      coolingTimeoutMinutes: Math.round((gpuCoolingTimeoutMs / 60_000) * 10) / 10,
      ...(gpuGuardEnabled ? {} : { warning: 'GPU 防護已停用（VEDIO_FACTORY_GPU_GUARD）；只適用於沒有 GPU 的測試環境。' }),
    };
  }

  // Static description of the pipeline (no ComfyUI calls): durations the UI may offer and the stage-2 defaults.
  function describePipeline(stage1Workflow, stage2Workflow, modelId) {
    const model = VIDEO_MODEL_CATALOG.find((item) => item.id === modelId) || VIDEO_MODEL_CATALOG[0];
    const plan = readWorkflowSegmentPlan(stage1Workflow);
    const segmentPlan = plan.error ? { segments: 1, overlapFrames: 0 } : plan;
    const drivingFrames = readStage2DrivingFrames(stage2Workflow);
    const usesFrames = JSON.stringify(stage1Workflow).includes('{{frames}}');
    const maxFrames = usesFrames ? model.recommendedMaxFrames : undefined;
    return {
      enabled: true,
      stageCount: PIPELINE_STAGE_COUNT,
      stage1Workflow: path.basename(comfyUI.workflowPath),
      stage2Workflow: path.basename(comfyUI.stage2WorkflowPath),
      sourceImageRequired: true,
      durationIsTotal: true,
      videoModelId: model.id,
      ...(drivingFrames.error ? { error: drivingFrames.error } : {
        drivingFrames,
        allowedDurationSecondsByFps: describePipelineDurations(segmentPlan, maxFrames, drivingFrames),
      }),
      stage2Steps: { default: DEFAULT_STAGE2_STEPS, min: 1, max: MAX_STAGE2_STEPS },
      referenceStrength: { default: DEFAULT_REFERENCE_STRENGTH, min: MIN_REFERENCE_STRENGTH, max: MAX_REFERENCE_STRENGTH },
      gpuGuard: describeGpuGuardConfig(),
    };
  }

  async function readConfiguredPipeline(videoModelId) {
    try {
      if (!comfyUI.workflowPath) {
        return { enabled: false, error: '兩階段流程需同時設定 VEDIO_FACTORY_COMFYUI_WORKFLOW（第一階段）。' };
      }
      return describePipeline(
        await loadComfyWorkflow(),
        await loadComfyWorkflow(comfyUI.stage2WorkflowPath),
        videoModelId,
      );
    } catch (error) {
      return { enabled: false, error: String(error.message || error).slice(0, MAX_COMFY_ERROR_CHARS) };
    }
  }

  // Loads, inspects and live-checks both pipeline workflows. Errors are prefixed with their stage.
  async function inspectPipeline({ modelId, hasSourceImage, hasLora }) {
    if (!comfyUI.workflowPath) {
      throw createRequestError('兩階段流程需同時設定 VEDIO_FACTORY_COMFYUI_WORKFLOW（第一階段）。', 503);
    }
    const stage1Template = await loadComfyWorkflow();
    const stage1Workflow = hasLora ? stage1Template : bypassPlaceholderLoraNodes(stage1Template);
    const stage2Workflow = await loadComfyWorkflow(comfyUI.stage2WorkflowPath);
    const [live1, live2] = await Promise.all([
      checkWorkflowAgainstComfyUI(stage1Workflow),
      checkWorkflowAgainstComfyUI(stage2Workflow),
    ]);
    const stage1Report = withLiveComfyCheck(inspectComfyWorkflow(stage1Workflow, modelId, hasSourceImage), live1);
    const stage2Report = withLiveComfyCheck(
      inspectComfyWorkflow(stage2Workflow, modelId, hasSourceImage, { stage: 2 }),
      live2,
    );
    const errors = [
      ...stage1Report.errors.map((error) => `第 1 階段：${error}`),
      ...stage2Report.errors.map((error) => `第 2 階段：${error}`),
    ];
    if (!hasSourceImage) errors.push('兩階段流程需要來源照片：第二階段以原照片作為人物參考。');
    return {
      stage1Template,
      stage1Workflow,
      stage2Workflow,
      stage1Report,
      stage2Report,
      errors,
      warnings: [
        ...stage1Report.warnings.map((warning) => `第 1 階段：${warning}`),
        ...stage2Report.warnings.map((warning) => `第 2 階段：${warning}`),
      ],
      pipeline: describePipeline(stage1Workflow, stage2Workflow, modelId),
    };
  }

  // Rejects a duration whose stage-1 output does not fit the stage-2 driving range (clear Chinese message).
  function assertPipelineDuration(duration, fps, pipelineInfo, stage1Plan, totalFrames) {
    const { drivingFrames } = pipelineInfo;
    if (totalFrames >= drivingFrames.min && totalFrames <= drivingFrames.max) return;
    const range = pipelineInfo.allowedDurationSecondsByFps?.[fps];
    const allowed = range ? `${fps} fps 時片長須為 ${range.min} 至 ${range.max} 秒` : `${fps} fps 沒有可用片長，請改用 24 fps`;
    const structure = stage1Plan.segments > 1 ? `（${stage1Plan.segments} 段串接）` : '';
    throw createRequestError(
      `兩階段流程：${duration} 秒 × ${fps} fps 的第一階段影片${structure}為 ${totalFrames} 影格，`
      + `超出第二階段支援的 ${drivingFrames.min}–${drivingFrames.max} 影格；${allowed}。`,
      400,
    );
  }

  async function preflightComfyWorkflow(payload = {}) {
    const modelId = typeof payload.videoModelId === 'string' && payload.videoModelId
      ? payload.videoModelId
      : VIDEO_MODEL_CATALOG[0].id;
    if (!VIDEO_MODEL_CATALOG.some((model) => model.id === modelId)) {
      throw createRequestError('找不到所選影片模型。');
    }
    if (pipelineMode && comfyUI.workflowPath) {
      const inspected = await inspectPipeline({
        modelId, hasSourceImage: payload.hasSourceImage === true, hasLora: payload.hasLora === true,
      });
      const errors = [...inspected.errors];
      const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
      const strength = payload.referenceStrength ?? settings.referenceStrength;
      if (isProvided(strength)) {
        try {
          validateReferenceStrength(strength);
        } catch (error) {
          errors.push(error.message);
        }
      }
      const stage2Steps = payload.stage2Steps ?? settings.stage2Steps;
      if (isProvided(stage2Steps)) {
        try {
          validateStage2Steps(stage2Steps);
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (isProvided(settings.duration) && !inspected.pipeline.error) {
        const duration = Number(settings.duration);
        const fps = Number(settings.fps ?? 24);
        const range = inspected.pipeline.allowedDurationSecondsByFps?.[fps];
        if (!range || !range.seconds.includes(duration)) {
          errors.push(range
            ? `兩階段流程：${fps} fps 時片長須為 ${range.min} 至 ${range.max} 秒（第二階段支援 `
              + `${inspected.pipeline.drivingFrames.min}–${inspected.pipeline.drivingFrames.max} 影格的驅動影片）。`
            : `兩階段流程：${fps} fps 沒有可用片長，請改用 24 fps。`);
        }
      }
      return {
        ...inspected.stage1Report,
        ready: errors.length === 0,
        errors,
        warnings: inspected.warnings,
        pipeline: { ...inspected.pipeline, stage2: inspected.stage2Report },
      };
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
    const templateWorkflow = await loadComfyWorkflow();
    // Checks the graph that would actually be submitted: the placeholder LoRA node only stays when a LoRA is chosen.
    const workflow = payload.hasLora === true ? templateWorkflow : bypassPlaceholderLoraNodes(templateWorkflow);
    const report = inspectComfyWorkflow(workflow, modelId, payload.hasSourceImage === true);
    return withLiveComfyCheck(report, await checkWorkflowAgainstComfyUI(workflow));
  }

  function withLiveComfyCheck(report, liveCheck) {
    const errors = [...report.errors, ...liveCheck.errors];
    return {
      ...report,
      ready: errors.length === 0,
      errors,
      comfyUILiveCheck: {
        checked: liveCheck.checked,
        missingNodeTypes: liveCheck.missingNodeTypes,
        missingValues: liveCheck.missingValues,
        ...(liveCheck.error ? { error: liveCheck.error } : {}),
      },
    };
  }

  // Takes the result of parseSourceImageDataUrl. The name is derived from the content hash and overwrite is off, so
  // ComfyUI reuses an identical earlier upload instead of storing another copy and never replaces someone else's file.
  async function uploadComfySourceImage({ image, mimeType }) {
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mimeType];
    const digest = crypto.createHash('sha256').update(image).digest('hex').slice(0, 32);
    const form = new FormData();
    form.append('image', new Blob([image], { type: mimeType }), `vediofactory-${digest}.${extension}`);
    form.append('type', 'input');
    form.append('subfolder', COMFY_UPLOAD_SUBFOLDER);
    form.append('overwrite', 'false');
    const response = await requestComfyUI('/upload/image', { method: 'POST', body: form });
    const result = await response.json();
    if (!result.name) throw createRequestError('ComfyUI 未回傳上傳圖片名稱。', 502);
    return [result.subfolder, result.name].filter(Boolean).join('/');
  }

  // Uploads the stage-1 WebM to ComfyUI's input/vediofactory folder (same endpoint as images; LoadVideo reads input
  // subfolder paths). Content-hash name + overwrite off, as for source images. Returns "vediofactory/<name>".
  async function uploadComfyDrivingVideo(filePath) {
    const hash = crypto.createHash('sha256');
    await pipeline(createReadStream(filePath), hash);
    const digest = hash.digest('hex').slice(0, 32);
    const form = new FormData();
    form.append('image', await openAsBlob(filePath, { type: 'video/webm' }), `vediofactory-stage1-${digest}.webm`);
    form.append('type', 'input');
    form.append('subfolder', COMFY_UPLOAD_SUBFOLDER);
    form.append('overwrite', 'false');
    const response = await requestComfyUI('/upload/image', {
      method: 'POST', body: form, signal: AbortSignal.timeout(300_000),
    });
    const result = await response.json();
    if (typeof result.name !== 'string' || !result.name) {
      throw createRequestError('ComfyUI 未回傳上傳的驅動影片名稱。', 502);
    }
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

  // WebM outputs of a ComfyUI history entry. The same file is often reported both as a temp preview and as a saved
  // output; keep one, preferring "output". Entries of type "input" are previews of input files (e.g. LoadVideo
  // showing the stage-2 driving video), not generated results, so they are never imported.
  function findComfyWebmOutputs(historyEntry) {
    const videos = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        if (typeof value.filename === 'string' && /\.webm$/iu.test(value.filename) && value.type !== 'input') videos.push(value);
        Object.values(value).forEach(visit);
      }
    };
    visit(historyEntry.outputs || {});
    const videosByName = new Map();
    for (const video of videos) {
      const key = `${video.subfolder || ''}:${video.filename}`;
      const existing = videosByName.get(key);
      if (!existing || ((existing.type || 'output') !== 'output' && (video.type || 'output') === 'output')) {
        videosByName.set(key, video);
      }
    }
    return [...videosByName.values()];
  }

  // Streams one ComfyUI output (/view) to destinationPath through a temp file with a 2 GB cap. Request errors are
  // thrown as-is (error.comfyStatus 404 = the output was deleted).
  async function downloadComfyOutput(video, destinationPath) {
    const query = new URLSearchParams({
      filename: video.filename,
      subfolder: video.subfolder || '',
      type: video.type || 'output',
    });
    const response = await requestComfyUI(`/view?${query}`, {
      signal: AbortSignal.timeout(120_000),
    });
    const temporaryPath = `${destinationPath}.${crypto.randomUUID()}.tmp`;
    try {
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_COMFY_OUTPUT_BYTES) {
        throw createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413);
      }
      let bytesWritten = 0;
      const sizeLimit = new Transform({
        transform(chunk, encoding, callback) {
          bytesWritten += chunk.length;
          if (bytesWritten > MAX_COMFY_OUTPUT_BYTES) {
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
      const stats = await fs.stat(temporaryPath);
      if (stats.size > MAX_COMFY_OUTPUT_BYTES) {
        throw createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413);
      }
      await fs.rename(temporaryPath, destinationPath);
      return stats;
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async function saveComfyVideoOutputs(job, historyEntry) {
    const uniqueVideos = findComfyWebmOutputs(historyEntry);
    const savedFiles = [];
    const missingFiles = [];

    for (const [index, video] of uniqueVideos.entries()) {
      const fileName = sanitizeFileName(`comfyui-${job.id.slice(0, 8)}-${index + 1}.webm`);
      const videoPath = path.join(outputDir, fileName);
      let stats;
      try {
        stats = await downloadComfyOutput(video, videoPath);
      } catch (error) {
        // 404 is permanent (the output was deleted); anything else is retried on the next poll.
        if (error.comfyStatus !== 404) throw error;
        missingFiles.push(video.filename);
        continue;
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
        videoModelId: job.videoModelId,
        sourceImageAttached: Boolean(job.sourceImageAttached),
        ...(job.workflowVariables?.seed !== undefined ? { seed: job.workflowVariables.seed } : {}),
        ...(job.workflowVariables?.frames !== undefined ? { frames: job.workflowVariables.frames } : {}),
        // Chained workflows: frames is per segment, totalFrames is what the WebM holds.
        ...(job.workflowVariables?.segments !== undefined ? {
          segments: job.workflowVariables.segments,
          totalFrames: job.workflowVariables.total_frames,
        } : {}),
        ...(job.workflowVariables?.steps !== undefined ? { steps: job.workflowVariables.steps } : {}),
        ...(job.workflowVariables?.lora_name !== undefined ? {
          loraName: job.workflowVariables.lora_name,
          loraStrength: job.workflowVariables.lora_strength,
        } : {}),
        ...(job.executionSeconds !== undefined ? { executionSeconds: job.executionSeconds } : {}),
        // Pipeline: frames/segments/steps above describe stage 1 (the motion); these describe the final re-render.
        ...(job.pipeline ? {
          pipelineStages: job.pipeline.stageCount,
          stage2Steps: job.pipeline.stages[1].workflowVariables?.steps,
          referenceStrength: job.pipeline.stages[1].workflowVariables?.reference_strength,
          stage2WorkflowName: job.pipeline.stages[1].workflowName,
        } : {}),
      };
      await fs.writeFile(path.join(outputDir, `${fileName}.json`), JSON.stringify(metadata, null, 2));
      savedFiles.push({ fileName, fileSize: stats.size, previewUrl: `/api/videos/${encodeURIComponent(fileName)}` });
    }
    return { savedFiles, missingFiles };
  }

  // Outcome of a prompt's ComfyUI history entry: { outcome: 'failed'|'completed'|'running', executionSeconds?, error?,
  // guidance? }.
  function parseComfyHistoryEntry(historyEntry) {
    const status = historyEntry.status || {};
    const statusText = String(status.status_str || '').toLowerCase();
    const messages = Array.isArray(status.messages) ? status.messages : [];
    const findMessage = (event) => messages.find((message) => Array.isArray(message) && message[0] === event)?.[1];
    // Only real numbers count: Number(null) is 0 and would turn a missing start into "since 1970".
    const toTimestamp = (value) => (typeof value === 'number' ? value : NaN);
    const startedAt = toTimestamp(findMessage('execution_start')?.timestamp);
    const finishedAt = toTimestamp((findMessage('execution_success') || findMessage('execution_error')
      || findMessage('execution_interrupted'))?.timestamp);
    const result = { outcome: 'running' };
    if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) {
      result.executionSeconds = Math.round((finishedAt - startedAt) / 100) / 10;
    }
    // ComfyUI records failures as { status_str: 'error', completed: false }, so check the status text first.
    if (statusText === 'error' || (status.completed && statusText !== 'success')) {
      const failure = findMessage('execution_error') || findMessage('execution_interrupted');
      result.outcome = 'failed';
      result.error = failure?.exception_message
        ? `ComfyUI 工作失敗（${failure.node_type || '未知節點'}）：${String(failure.exception_message).slice(0, 1_000)}`
        : `ComfyUI 工作失敗：${statusText || '未知錯誤'}`;
      if (/out of memory|OutOfMemory|allocat/iu.test(result.error)) {
        result.guidance = 'VRAM 不足：請改用 832x480 / 480x832、縮短片長或降低 FPS 後重試。';
      }
    } else if (status.completed) {
      result.outcome = 'completed';
    }
    return result;
  }

  // 'running' | 'pending' | null (not in the ComfyUI queue).
  function findInComfyQueue(queue, promptId) {
    const matches = (entry) => Array.isArray(entry) && entry[1] === promptId;
    if ((queue.queue_running || []).some(matches)) return 'running';
    if ((queue.queue_pending || []).some(matches)) return 'pending';
    return null;
  }

  async function refreshComfyInferenceJob(job) {
    if (!job.comfyPromptId || TERMINAL_JOB_STATUSES.includes(job.status)) return job;
    if (job.pipeline) return refreshPipelineJob(job);
    // Queue first, then history: ComfyUI moves a prompt from the queue into history atomically, so reading in this
    // order never misses a prompt that finishes between the two requests (parallel reads could).
    const queue = await (await requestComfyUI('/queue')).json();
    const history = await (await requestComfyUI(`/history/${encodeURIComponent(job.comfyPromptId)}`)).json();
    const historyEntry = history[job.comfyPromptId];
    if (historyEntry) delete job.comfyMissingChecks;
    if (historyEntry) {
      const result = parseComfyHistoryEntry(historyEntry);
      if (result.executionSeconds !== undefined) job.executionSeconds = result.executionSeconds;
      if (result.outcome === 'failed') {
        job.status = 'failed';
        job.error = result.error;
        if (result.guidance) job.guidance = result.guidance;
      } else if (result.outcome === 'completed') {
        const { savedFiles, missingFiles } = await saveComfyVideoOutputs(job, historyEntry);
        job.outputs = savedFiles;
        job.status = 'succeeded';
        if (missingFiles.length) {
          job.status = 'failed';
          job.error = `ComfyUI 找不到輸出影片（HTTP 404）：${missingFiles.join('、')}`.slice(0, MAX_COMFY_ERROR_CHARS);
          job.guidance = '輸出檔可能已從 ComfyUI 的 output 資料夾刪除；請重新提交工作。';
        } else if (!job.outputs.length) {
          job.guidance = 'ComfyUI 工作已完成，但未找到 .webm 輸出；請確認工作流使用影片輸出節點並輸出 WebM。';
        }
      } else {
        job.status = 'running';
      }
    } else {
      const entries = [...(queue.queue_running || []), ...(queue.queue_pending || [])];
      const queued = entries.some((entry) => Array.isArray(entry) && entry[1] === job.comfyPromptId);
      if (queued) {
        delete job.comfyMissingChecks;
        job.status = (queue.queue_running || []).some(
          (entry) => Array.isArray(entry) && entry[1] === job.comfyPromptId,
        ) ? 'running' : 'queued';
      } else {
        // Neither queued nor in history: ComfyUI was restarted or its history was cleared. Require two consecutive
        // misses before failing so the job reaches a terminal state and the UI stops polling.
        job.comfyMissingChecks = (Number(job.comfyMissingChecks) || 0) + 1;
        if (job.comfyMissingChecks >= 2) {
          job.status = 'failed';
          job.error = 'ComfyUI 佇列與歷史紀錄都找不到此工作（ComfyUI 可能已重新啟動或清除了歷史紀錄）。';
          job.guidance = '請重新提交工作；若 ComfyUI 已產出影片，可從其 output 資料夾手動匯入。';
        }
      }
    }
    job.updatedAt = new Date().toISOString();
    await persistInferenceJob(job);
    return job;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Two-stage pipeline (OPTIMIZATION_PLAN 6.9). The manifest is the state machine, so a restarted server resumes it:
  //   pipeline.currentStage 1: stage 1 queued/running in ComfyUI (job.comfyPromptId = its prompt)
  //   stage 1 done -> its WebM is kept in pipeline-drafts/ and uploaded to ComfyUI input/vediofactory
  //   pipeline.currentStage 2: pending -> cooling (GPU preflight not passed yet) -> queued/running -> imported
  // A GPU guard (tools/gpu-guard.mjs) runs while a stage is queued or running; a trip interrupts ComfyUI and fails the job.
  // ---------------------------------------------------------------------------------------------------------------

  // Serializes refreshes and cancellation of one job, so a cancel can never be overwritten by a concurrent hand-over.
  function withJobLock(jobId, operation) {
    const previous = jobLocks.get(jobId) || Promise.resolve();
    const current = previous.then(operation);
    const tail = current.catch(() => {});
    jobLocks.set(jobId, tail);
    tail.then(() => {
      if (jobLocks.get(jobId) === tail) jobLocks.delete(jobId);
    });
    return current;
  }

  function loadGpuModule() {
    if (options.gpuGuard && typeof options.gpuGuard === 'object') return Promise.resolve(options.gpuGuard);
    if (!gpuModulePromise) {
      gpuModulePromise = import(pathToFileURL(path.join(ROOT_DIR, 'tools', 'gpu-guard.mjs')).href);
      gpuModulePromise.catch(() => {
        gpuModulePromise = null;
      });
    }
    return gpuModulePromise;
  }

  // { ok: true } or { ok: false, hard, message }. hard = waiting will not help (no nvidia-smi reading, GPU lost, power
  // limit above safe mode); otherwise the card is still hot or busy and the pipeline waits ("cooling").
  async function runGpuPreflight() {
    if (!gpuGuardEnabled) return { ok: true, disabled: true };
    let gpu;
    try {
      gpu = await loadGpuModule();
    } catch (error) {
      return { ok: false, hard: true, message: `無法載入 GPU 防護模組 tools/gpu-guard.mjs：${error.message}` };
    }
    const limits = { ...DEFAULT_GPU_LIMITS, ...(gpu.GPU_LIMITS || {}) };
    let result;
    try {
      result = await gpu.checkGpuPreflight(options.gpuIdleSeconds !== undefined ? { idleSeconds: options.gpuIdleSeconds } : {});
    } catch (error) {
      result = { ok: false, problems: [error.message] };
    }
    if (result?.ok) return { ok: true, sample: result.sample };
    const sample = result?.sample;
    const detail = (Array.isArray(result?.problems) ? result.problems : []).join('；').slice(0, 500);
    if (result?.gpuLost) {
      return { ok: false, hard: true, message: 'GPU 已斷線（nvidia-smi 回報 GPU is lost）；請重新開機並檢查散熱後再試。' };
    }
    if (!sample) {
      return {
        ok: false,
        hard: true,
        message: `無法讀取 nvidia-smi（${detail || '未知錯誤'}）。沒有 NVIDIA GPU 的測試環境可設定 VEDIO_FACTORY_GPU_GUARD=off。`,
      };
    }
    if (typeof sample.powerLimitW === 'number' && sample.powerLimitW > limits.maxPowerLimitW) {
      return {
        ok: false,
        hard: true,
        message: `GPU 功耗上限為 ${sample.powerLimitW} W，高於安全上限 ${limits.maxPowerLimitW} W；`
          + '請以系統管理員執行 tools/gpu-safe-mode.ps1（每次重開機後都要重跑）。',
      };
    }
    const reasons = [];
    if (typeof sample.tempC === 'number' && sample.tempC > limits.maxStartTempC) {
      reasons.push(`GPU 溫度 ${sample.tempC}°C 高於開始門檻 ${limits.maxStartTempC}°C`);
    }
    if (!reasons.length) reasons.push('GPU 使用率偏高，可能有其他 GPU 工作正在執行（不可同時執行兩個 GPU 工作）');
    return { ok: false, hard: false, message: reasons.join('；') };
  }

  function raiseGpuGuardAlarm(jobId, message) {
    if (gpuGuardAlarms.has(jobId)) return;
    gpuGuardAlarms.set(jobId, { message, at: new Date().toISOString() });
    console.error(`[gpu-guard] job ${jobId}: ${message}`);
    loadGpuModule()
      .then((gpu) => gpu.interruptComfyUI(comfyUI.baseUrl))
      .catch((error) => console.error(`[gpu-guard] ComfyUI interrupt failed: ${error.message}`));
    // Record the failure now instead of on the next poll.
    getInferenceJob(jobId).catch(() => {});
  }

  // Starts the guard for a queued/running stage (also after a server restart). A guard that cannot start counts as a
  // trip: GPU work must never run unguarded.
  async function startStageGuard(job, stage) {
    if (!gpuGuardEnabled || activeGpuGuards.has(job.id) || gpuGuardAlarms.has(job.id)) return;
    const jobId = job.id;
    try {
      const gpu = await loadGpuModule();
      const entry = { guard: null, stageIndex: stage.index, samples: 0, changedAt: Date.now() };
      const isCurrent = () => activeGpuGuards.get(jobId) === entry;
      entry.guard = gpu.startGpuGuard({
        label: `vediofactory-${sanitizePathSegment(jobId).slice(0, 8)}-stage${stage.index}`,
        onTrip: (reason) => {
          if (isCurrent()) raiseGpuGuardAlarm(jobId, `GPU 防護觸發，已中斷 ComfyUI：${String(reason).slice(0, 300)}`);
        },
        onLost: (text) => {
          if (isCurrent()) raiseGpuGuardAlarm(jobId, `GPU 已斷線（GPU is lost），已中斷 ComfyUI：${String(text).slice(0, 300)}`);
        },
      });
      activeGpuGuards.set(jobId, entry);
      stage.gpuGuard = {
        startedAt: new Date().toISOString(),
        ...(entry.guard.logFile ? { logFile: path.basename(entry.guard.logFile) } : {}),
      };
    } catch (error) {
      gpuGuardAlarms.set(jobId, { message: `無法啟動 GPU 防護：${error.message}`, at: new Date().toISOString() });
      // Only interrupt when our stage may already be executing (restart recovery), never before it was submitted.
      if (stage.comfyPromptId) loadGpuModule().then((gpu) => gpu.interruptComfyUI(comfyUI.baseUrl)).catch(() => {});
    }
  }

  async function stopStageGuard(jobId, stage) {
    const entry = activeGpuGuards.get(jobId);
    if (!entry) return;
    activeGpuGuards.delete(jobId);
    let summary;
    try {
      summary = (await entry.guard.stop()) || {};
    } catch (error) {
      summary = { error: error.message };
    }
    if (stage) {
      stage.gpuTelemetry = Object.fromEntries([
        'samples', 'maxTempC', 'maxPowerW', 'maxPowerInstantW', 'maxVramMiB', 'hwSlowdownSamples', 'tripped', 'gpuLost', 'error',
      ].filter((key) => summary[key] !== undefined && summary[key] !== null).map((key) => [key, summary[key]]));
    }
  }

  // nvidia-smi that stops producing samples (hung driver, GPU off the bus) must not leave a stage unguarded.
  function checkGpuGuardStale(jobId) {
    const entry = activeGpuGuards.get(jobId);
    if (!entry || typeof entry.guard.summary !== 'function') return;
    const samples = Number(entry.guard.summary()?.samples) || 0;
    if (samples !== entry.samples) {
      entry.samples = samples;
      entry.changedAt = Date.now();
    } else if (Date.now() - entry.changedAt > gpuGuardStaleMs) {
      raiseGpuGuardAlarm(jobId, `GPU 防護已 ${Math.round(gpuGuardStaleMs / 1000)} 秒沒有收到 nvidia-smi 資料`
        + '（GPU 可能已斷線或 nvidia-smi 停止回應），已中斷 ComfyUI。');
    }
  }

  function schedulePipelineDriver(jobId, delayMs = pipelinePollIntervalMs) {
    if (!pipelinePollIntervalMs || appClosed || pipelineDrivers.has(jobId)) return;
    const timer = setTimeout(() => {
      pipelineDrivers.delete(jobId);
      tickPipelineDriver(jobId);
    }, delayMs);
    timer.unref?.();
    pipelineDrivers.set(jobId, timer);
  }

  async function tickPipelineDriver(jobId) {
    if (appClosed) return;
    checkGpuGuardStale(jobId);
    let job;
    try {
      job = await getInferenceJob(jobId);
    } catch (error) {
      // ComfyUI briefly unreachable and the like: keep driving, the manifest is unchanged.
      job = undefined;
    }
    if (job === null) return;
    if (job && TERMINAL_JOB_STATUSES.includes(job.status)) {
      await stopStageGuard(jobId);
      return;
    }
    schedulePipelineDriver(jobId);
  }

  // Called once the server listens: pipeline jobs persisted by an earlier process are driven (and guarded) again.
  async function resumePipelineJobs() {
    if (!(await fileExists(path.join(outputDir, INFERENCE_JOBS_DIR_NAME)))) return [];
    const jobs = await listInferenceJobs();
    const active = jobs.filter((job) => job.pipeline && !TERMINAL_JOB_STATUSES.includes(job.status));
    for (const job of active) schedulePipelineDriver(job.id, 0);
    return active.map((job) => job.id);
  }

  function setPipelineLabel(job) {
    const { currentStage, stageCount } = job.pipeline;
    job.stageLabel = `第 ${currentStage}/${stageCount} 階段${job.status === 'cooling' ? '（等待 GPU 冷卻）' : ''}`;
    const seconds = job.pipeline.stages.map((stage) => stage.executionSeconds).filter((value) => typeof value === 'number');
    if (seconds.length) job.executionSeconds = Math.round(seconds.reduce((sum, value) => sum + value, 0) * 10) / 10;
  }

  async function failPipelineJob(job, stage, message, guidance) {
    stage.status = 'failed';
    stage.error = String(message).slice(0, MAX_COMFY_ERROR_CHARS);
    stage.finishedAt ??= new Date().toISOString();
    job.status = 'failed';
    job.error = `第 ${stage.index}/${job.pipeline.stageCount} 階段失敗：${stage.error}`;
    if (guidance) job.guidance = guidance;
    await stopStageGuard(job.id, stage);
  }

  async function applyGpuGuardAlarm(job, stage) {
    const alarm = gpuGuardAlarms.get(job.id);
    if (!alarm || TERMINAL_JOB_STATUSES.includes(job.status)) return;
    gpuGuardAlarms.delete(job.id);
    if (stage.comfyPromptId && stage.status !== 'running') {
      // Keep a still-pending stage from starting later on a card that just tripped.
      await requestComfyUI('/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: [stage.comfyPromptId] }),
      }).catch(() => {});
    }
    await failPipelineJob(job, stage, alarm.message, GPU_GUARD_GUIDANCE);
  }

  function getPipelineDraftPath(job) {
    return path.join(outputDir, PIPELINE_DRAFTS_DIR_NAME, `${sanitizePathSegment(job.id, 'job')}-stage1.webm`);
  }

  async function submitComfyPrompt(apiWorkflow) {
    const submission = await requestComfyUI('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: apiWorkflow, client_id: crypto.randomUUID() }),
    }).then((response) => response.json());
    if (!submission.prompt_id || (submission.node_errors && Object.keys(submission.node_errors).length)) {
      const reason = submission.node_errors && Object.keys(submission.node_errors).length
        ? summarizeComfyNodeErrors(submission.node_errors)
        : JSON.stringify(submission).slice(0, MAX_COMFY_ERROR_CHARS);
      throw createRequestError(`ComfyUI 拒絕工作流：${reason}`, 400);
    }
    return submission;
  }

  function buildWorkflowVariables(job, overrides = {}) {
    const resolution = String(job.settings.resolution || '1280x720').split('x').map(Number);
    return {
      prompt: job.prompt || job.story,
      model_id: job.videoModelId,
      story: job.story,
      negative_prompt: '',
      width: resolution[0],
      height: resolution[1],
      duration: Number(job.settings.duration) || 6,
      fps: Number(job.settings.fps) || 24,
      steps: QUALITY_SAMPLER_STEPS[job.settings.quality] || QUALITY_SAMPLER_STEPS.balanced,
      seed: job.settings.seed,
      quality: job.settings.quality || 'balanced',
      motion: Number(job.settings.motion) || 0,
      caption_strength: Number(job.settings.captionStrength) || 0,
      source_image: '',
      ...overrides,
    };
  }

  async function submitPipelineStage2(job) {
    const stage = job.pipeline.stages[1];
    if (!comfyUI.stage2WorkflowPath) {
      await failPipelineJob(job, stage, '伺服器已不再設定 VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW，無法執行第二階段。');
      return;
    }
    const workflow = await loadComfyWorkflow(comfyUI.stage2WorkflowPath);
    if (workflow.sha256 !== stage.workflowSha256) {
      await failPipelineJob(
        job,
        stage,
        '第二階段工作流在工作進行中被修改；為了能重現結果，請重新提交工作。',
        `第一階段影片保留於 ${job.pipeline.stages[0].draftFile}。`,
      );
      return;
    }
    const report = inspectComfyWorkflow(workflow, job.videoModelId, true, { stage: 2 });
    const variables = buildWorkflowVariables(job, {
      steps: stage.workflowVariables.steps,
      source_image: stage.workflowVariables.source_image,
      reference_strength: stage.workflowVariables.reference_strength,
      driving_video: stage.drivingVideo,
    });
    const unresolved = report.placeholders.filter((name) => !Object.hasOwn(variables, name));
    if (!report.ready || unresolved.length) {
      await failPipelineJob(job, stage, `第二階段工作流預檢失敗：${[
        ...report.errors,
        ...(unresolved.length ? [`未支援的佔位符 ${unresolved.map((name) => `{{${name}}}`).join('、')}`] : []),
      ].join(' ')}`);
      return;
    }
    stage.workflowVariables.driving_video = stage.drivingVideo;
    // The guard runs before the prompt can start.
    await startStageGuard(job, stage);
    if (gpuGuardAlarms.has(job.id)) return;
    let submission;
    try {
      submission = await submitComfyPrompt(applyWorkflowVariables(workflow, variables));
    } catch (error) {
      await stopStageGuard(job.id, stage);
      // Unreachable ComfyUI is retried on the next poll; a rejected workflow is final.
      if (error.statusCode !== 400) throw error;
      await failPipelineJob(job, stage, error.message);
      return;
    }
    stage.comfyPromptId = submission.prompt_id;
    stage.queuePosition = submission.number;
    stage.submittedAt = new Date().toISOString();
    stage.status = 'queued';
    job.comfyPromptId = submission.prompt_id;
    job.queuePosition = submission.number;
    job.status = 'queued';
    job.guidance = '第 2 階段已提交至本機 ComfyUI（以原照片重繪人物）；完成後只匯入最終影片。';
  }

  // Stage 1 finished: keep its WebM as a draft, upload it as the driving video, wait for a cool GPU, submit stage 2.
  // Every step is idempotent and checkpointed, so it can be retried by any later poll or a restarted server.
  async function advancePipelineToStage2(job) {
    const plan = job.pipeline;
    const stage1 = plan.stages[0];
    const stage = plan.stages[1];
    if (!stage.drivingVideo) {
      const draftPath = getPipelineDraftPath(job);
      if (!(await fileExists(draftPath))) {
        await fs.mkdir(path.dirname(draftPath), { recursive: true });
        try {
          await downloadComfyOutput(stage1.output, draftPath);
        } catch (error) {
          if (error.comfyStatus !== 404) throw error;
          await failPipelineJob(
            job,
            stage,
            `ComfyUI 找不到第一階段輸出影片（HTTP 404）：${stage1.output.filename}`,
            '輸出檔可能已從 ComfyUI 的 output 資料夾刪除；請重新提交工作。',
          );
          return;
        }
      }
      stage1.draftFile = `${PIPELINE_DRAFTS_DIR_NAME}/${path.basename(draftPath)}`;
      stage.drivingVideo = await uploadComfyDrivingVideo(draftPath);
      await persistInferenceJob(job);
    }

    const startedMs = Date.now();
    if (stage.status === 'cooling' && plan.lastGpuCheckAt
      && startedMs - Date.parse(plan.lastGpuCheckAt) < gpuCoolingCheckIntervalMs) {
      return;
    }
    const gpu = await runGpuPreflight();
    plan.lastGpuCheckAt = new Date().toISOString();
    if (!gpu.ok) {
      if (gpu.hard) {
        await failPipelineJob(job, stage, `GPU 預檢未通過：${gpu.message}`, GPU_GUARD_GUIDANCE);
        return;
      }
      plan.coolingStartedAt ??= new Date(startedMs).toISOString();
      const waitedMs = startedMs - Date.parse(plan.coolingStartedAt);
      if (waitedMs >= gpuCoolingTimeoutMs) {
        await failPipelineJob(
          job,
          stage,
          `等待 GPU 冷卻逾時（已等待 ${Math.round((waitedMs / 60_000) * 10) / 10} 分鐘）：${gpu.message}。`,
          `第一階段影片保留於 ${stage1.draftFile}。${GPU_GUARD_GUIDANCE}`,
        );
        return;
      }
      stage.status = 'cooling';
      stage.gpuWait = gpu.message;
      job.status = 'cooling';
      job.guidance = `第 1 階段已完成，等待 GPU 冷卻後開始第 2 階段：${gpu.message}。`;
      return;
    }
    if (plan.coolingStartedAt) {
      stage.coolingSeconds = Math.round((Date.now() - Date.parse(plan.coolingStartedAt)) / 1000);
    }
    delete stage.gpuWait;
    await submitPipelineStage2(job);
  }

  async function completePipelineStage(job, stage, historyEntry) {
    stage.finishedAt = new Date().toISOString();
    await stopStageGuard(job.id, stage);
    if (stage.index === 1) {
      const [video] = findComfyWebmOutputs(historyEntry);
      if (!video) {
        await failPipelineJob(job, stage, 'ComfyUI 工作已完成，但沒有 .webm 輸出；第一階段工作流必須輸出 WebM。');
        return;
      }
      stage.status = 'succeeded';
      stage.output = { filename: video.filename, subfolder: video.subfolder || '', type: video.type || 'output' };
      job.pipeline.currentStage = 2;
      job.pipeline.stages[1].status = 'pending';
      job.status = 'running';
      job.guidance = '第 1 階段完成，準備第 2 階段。';
      setPipelineLabel(job);
      // Checkpoint: stage 1 stays done even if the hand-over below fails and is retried.
      await persistInferenceJob(job);
      await advancePipelineToStage2(job);
      return;
    }
    setPipelineLabel(job);
    await persistInferenceJob(job);
    // Only the stage-2 WebM goes into the library.
    const { savedFiles, missingFiles } = await saveComfyVideoOutputs(job, historyEntry);
    job.outputs = savedFiles;
    if (missingFiles.length) {
      await failPipelineJob(
        job,
        stage,
        `ComfyUI 找不到輸出影片（HTTP 404）：${missingFiles.join('、')}`,
        '輸出檔可能已從 ComfyUI 的 output 資料夾刪除；請重新提交工作。',
      );
    } else if (!savedFiles.length) {
      await failPipelineJob(job, stage, 'ComfyUI 工作已完成，但沒有 .webm 輸出；第二階段工作流必須輸出 WebM。');
    } else {
      stage.status = 'succeeded';
      job.status = 'succeeded';
      job.guidance = `兩階段完成，已匯入最終影片；第一階段影片保留於 ${job.pipeline.stages[0].draftFile}（不列入影片庫）。`;
    }
  }

  async function refreshPipelineJob(job) {
    const plan = job.pipeline;
    const stage = plan.stages[plan.currentStage - 1];
    const now = new Date().toISOString();
    await applyGpuGuardAlarm(job, stage);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) {
      // Failed by the alarm above.
    } else if (!stage.comfyPromptId) {
      await advancePipelineToStage2(job);
    } else {
      const queue = await (await requestComfyUI('/queue')).json();
      const history = await (await requestComfyUI(`/history/${encodeURIComponent(stage.comfyPromptId)}`)).json();
      const historyEntry = history[stage.comfyPromptId];
      if (historyEntry) {
        delete stage.comfyMissingChecks;
        const result = parseComfyHistoryEntry(historyEntry);
        if (result.executionSeconds !== undefined) stage.executionSeconds = result.executionSeconds;
        if (result.outcome === 'failed') {
          await failPipelineJob(job, stage, result.error, result.guidance);
        } else if (result.outcome === 'completed') {
          await completePipelineStage(job, stage, historyEntry);
        } else {
          stage.status = 'running';
          stage.startedAt ??= now;
          job.status = 'running';
          await startStageGuard(job, stage);
        }
      } else {
        const where = findInComfyQueue(queue, stage.comfyPromptId);
        if (where) {
          delete stage.comfyMissingChecks;
          stage.status = where === 'running' ? 'running' : 'queued';
          if (where === 'running') stage.startedAt ??= now;
          job.status = stage.status;
          // After a restart this process has no guard yet for the stage an earlier process submitted.
          await startStageGuard(job, stage);
        } else {
          stage.comfyMissingChecks = (Number(stage.comfyMissingChecks) || 0) + 1;
          if (stage.comfyMissingChecks >= 2) {
            await failPipelineJob(
              job,
              stage,
              'ComfyUI 佇列與歷史紀錄都找不到此工作（ComfyUI 可能已重新啟動或清除了歷史紀錄）。',
              '請重新提交工作。',
            );
          }
        }
      }
    }
    // A guard that tripped (or could not start) during this refresh.
    const current = plan.stages[plan.currentStage - 1];
    await applyGpuGuardAlarm(job, current);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) await stopStageGuard(job.id, current);
    setPipelineLabel(job);
    job.updatedAt = new Date().toISOString();
    await persistInferenceJob(job);
    return job;
  }

  async function cancelPipelineJob(job) {
    const plan = job.pipeline;
    const stage = plan.stages[plan.currentStage - 1];
    const label = `第 ${stage.index}/${plan.stageCount} 階段`;
    if (stage.comfyPromptId) {
      // Same semantics as single jobs: only a prompt still waiting in the ComfyUI queue can be removed.
      const queue = await (await requestComfyUI('/queue')).json();
      const where = findInComfyQueue(queue, stage.comfyPromptId);
      if (where === 'running') {
        throw createRequestError(`${label}已開始執行。ComfyUI 的 interrupt 會中斷全域執行，因此不會由此操作取消。`, 409);
      }
      if (where !== 'pending') {
        throw createRequestError('工作已不在待執行佇列中，請重新整理工作狀態後再試。', 409);
      }
      await requestComfyUI('/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: [stage.comfyPromptId] }),
      });
      job.guidance = `已在${label}從 ComfyUI 待執行佇列移除。`;
    } else {
      // Between stages (pending / cooling) nothing is queued in ComfyUI; stage 2 is simply never submitted.
      job.guidance = `已在${label}開始前取消；第一階段影片保留於 ${plan.stages[0].draftFile || '（尚未下載）'}。`;
    }
    stage.status = 'cancelled';
    stage.finishedAt = new Date().toISOString();
    await stopStageGuard(job.id, stage);
    job.status = 'cancelled';
    setPipelineLabel(job);
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

  // The manifest read is inside the shared promise: reading it outside let a poll load a pre-completion snapshot,
  // miss the finished refresh in the map, and download + re-import the same outputs again.
  async function loadAndRefreshInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    const job = jobs.find((item) => item.id === jobId) || null;
    return job?.comfyPromptId ? refreshComfyInferenceJob(job) : job;
  }

  function getInferenceJob(jobId) {
    if (!inferenceRefreshes.has(jobId)) {
      const pending = withJobLock(jobId, () => loadAndRefreshInferenceJob(jobId));
      inferenceRefreshes.set(jobId, pending);
      pending.finally(() => {
        if (inferenceRefreshes.get(jobId) === pending) inferenceRefreshes.delete(jobId);
      }).catch(() => {});
    }
    return inferenceRefreshes.get(jobId);
  }

  function cancelInferenceJob(jobId) {
    return withJobLock(jobId, () => cancelInferenceJobLocked(jobId));
  }

  async function cancelInferenceJobLocked(jobId) {
    const job = await loadAndRefreshInferenceJob(jobId);
    if (!job) throw createRequestError('找不到推論工作。', 404);
    if (!job.comfyPromptId) throw createRequestError('此工作尚未提交至 ComfyUI。', 409);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      throw createRequestError(`工作已是終止狀態：${job.status}。`, 409);
    }
    if (job.pipeline) return cancelPipelineJob(job);

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

    if (inference.settings.loraName && !comfyUI.workflowPath) {
      throw createRequestError('LoRA 需要已設定的 ComfyUI 工作流（VEDIO_FACTORY_COMFYUI_WORKFLOW）。', 400);
    }
    if (comfyUI.workflowPath) {
      if (!runtime.comfyUI.available) {
        throw createRequestError('無法連線至本機 ComfyUI，請確認服務已啟動。', 503);
      }
      const loraName = inference.settings.loraName || '';
      let templateWorkflow;
      let workflow;
      let preflight;
      let pipelineInfo = null;
      if (pipelineMode) {
        if (!inference.sourceImageDataUrl) {
          throw createRequestError('兩階段流程需要來源照片：第二階段以原照片作為人物參考。', 400);
        }
        // The pipeline re-renders a real person's face from the uploaded photo, so it never loads third-party LoRAs:
        // that would turn it into a tool for putting real people into content they never agreed to.
        if (loraName) {
          throw createRequestError('照片轉本人影片流程不支援 LoRA：此流程會保留照片中真人的臉孔，因此只使用內建的一般內容模型。', 400);
        }
        // One pipeline job at a time: two would put two GPU jobs on the card (stage 2 of one, stage 1 of the other).
        const active = (await listInferenceJobs()).find((item) => item.pipeline && !TERMINAL_JOB_STATUSES.includes(item.status));
        if (active) {
          throw createRequestError(
            `已有兩階段工作進行中（${active.stageLabel || active.status}，工作 ${active.id}）；請等它完成或取消後再提交。`,
            409,
          );
        }
        const inspected = await inspectPipeline({
          modelId: inference.videoModelId, hasSourceImage: true, hasLora: Boolean(loraName),
        });
        if (inspected.errors.length) {
          throw createRequestError(`ComfyUI 工作流預檢失敗：${inspected.errors.join(' ')}`);
        }
        if (inspected.pipeline.error) throw createRequestError(`第 2 階段：${inspected.pipeline.error}`);
        templateWorkflow = inspected.stage1Template;
        workflow = inspected.stage1Workflow;
        preflight = inspected.stage1Report;
        pipelineInfo = inspected;
      } else {
        templateWorkflow = await loadComfyWorkflow();
        // Without a LoRA the placeholder LoRA node is removed before any check, so preflight and submission see the
        // same graph as a workflow that never had a LoRA node.
        workflow = loraName ? templateWorkflow : bypassPlaceholderLoraNodes(templateWorkflow);
        preflight = withLiveComfyCheck(
          inspectComfyWorkflow(workflow, inference.videoModelId, Boolean(inference.sourceImageDataUrl)),
          await checkWorkflowAgainstComfyUI(workflow),
        );
        if (!preflight.ready) {
          throw createRequestError(`ComfyUI 工作流預檢失敗：${preflight.errors.join(' ')}`);
        }
      }
      job.workflowPreflight = preflight;
      if (loraName) {
        if (!preflight.placeholders.includes('lora_name')) {
          throw createRequestError('目前的 ComfyUI 工作流沒有 {{lora_name}} LoRA 節點，無法套用 LoRA。', 400);
        }
        const availableLoras = await listComfyLoras();
        if (!availableLoras.includes(loraName)) {
          throw createRequestError('ComfyUI 的 LoRA 清單中沒有此檔案；請確認它已放入 ComfyUI/models/loras。', 400);
        }
      }
      const duration = Number(job.settings.duration) || 6;
      const fps = Number(job.settings.fps) || 24;
      // inspectComfyWorkflow already rejected a malformed marker, so the plan is valid here.
      const segmentPlan = readWorkflowSegmentPlan(workflow);
      const chained = segmentPlan.segments > 1;
      // {{frames}} is the per-segment length; for a chained workflow duration is the total length.
      const frames = getSegmentFrameCount(duration, fps, segmentPlan);
      const totalFrames = getTotalFrameCount(frames, segmentPlan);
      const selectedModel = VIDEO_MODEL_CATALOG.find((model) => model.id === inference.videoModelId);
      const maxFrames = selectedModel?.recommendedMaxFrames;
      if (preflight.placeholders.includes('frames') && maxFrames && frames > maxFrames) {
        const maxDuration = getMaxDurationSeconds(maxFrames, fps, segmentPlan);
        const allowed = maxDuration
          ? `${fps} fps 時片長須為 ${MIN_DURATION_SECONDS} 至 ${maxDuration} 秒`
          : `${fps} fps 無可用片長，請降低 FPS`;
        const requested = chained
          ? `${duration} 秒 × ${fps} fps 需 ${segmentPlan.segments} 段 × 每段 ${frames} 影格`
          : `${duration} 秒 × ${fps} fps = ${frames} 影格`;
        throw createRequestError(
          `${requested}，超過 ${selectedModel.name} ${chained ? '每段' : ''}上限 ${maxFrames} 影格；${allowed}。`,
          400,
        );
      }
      // Pipeline: the stage-1 video is stage 2's driving video, so its frame count must fit stage 2.
      if (pipelineInfo) assertPipelineDuration(duration, fps, pipelineInfo.pipeline, segmentPlan, totalFrames);
      // Every check runs before the upload: ComfyUI has no API to delete an uploaded input image.
      const sourceImageFile = inference.sourceImageDataUrl ? parseSourceImageDataUrl(inference.sourceImageDataUrl) : null;
      const variables = buildWorkflowVariables(job, {
        duration,
        fps,
        frames,
        ...(loraName ? { lora_name: loraName, lora_strength: inference.settings.loraStrength } : {}),
      });
      // Only the template is checked: user text substituted into it may legitimately contain "{{...}}".
      const unresolved = preflight.placeholders.filter((name) => !Object.hasOwn(variables, name));
      if (unresolved.length) {
        throw createRequestError(`工作流含有未支援的佔位符：${unresolved.map((name) => `{{${name}}}`).join('、')}`, 400);
      }
      let stage2Variables = null;
      if (pipelineInfo) {
        stage2Variables = {
          steps: inference.stage2Steps ?? DEFAULT_STAGE2_STEPS,
          reference_strength: inference.referenceStrength ?? DEFAULT_REFERENCE_STRENGTH,
        };
        const stage2Unresolved = pipelineInfo.stage2Report.placeholders.filter((name) => (
          !Object.hasOwn(buildWorkflowVariables(job, { ...stage2Variables, driving_video: '' }), name)
        ));
        if (stage2Unresolved.length) {
          throw createRequestError(`第二階段工作流含有未支援的佔位符：${stage2Unresolved.map((name) => `{{${name}}}`).join('、')}`, 400);
        }
        // Last check before anything reaches ComfyUI: a hot, busy or not-in-safe-mode GPU refuses the job.
        const gpu = await runGpuPreflight();
        if (!gpu.ok) throw createRequestError(`GPU 預檢未通過，未提交工作：${gpu.message}`, 409);
      }
      if (sourceImageFile) variables.source_image = await uploadComfySourceImage(sourceImageFile);
      // Recorded so a successful run can be reproduced (seed, frames, steps, uploaded image name). Only the workflow's
      // file name and content hash are stored, not its absolute path.
      job.workflowName = path.basename(comfyUI.workflowPath);
      job.workflowSha256 = templateWorkflow.sha256;
      job.workflowVariables = Object.fromEntries(
        ['width', 'height', 'duration', 'fps', 'frames', 'steps', 'seed', 'source_image', 'lora_name', 'lora_strength']
          .filter((key) => preflight.placeholders.includes(key))
          .map((key) => [key, variables[key]]),
      );
      if (chained) {
        Object.assign(job.workflowVariables, {
          segments: segmentPlan.segments,
          overlap_frames: segmentPlan.overlapFrames,
          total_frames: totalFrames,
        });
      }
      if (pipelineInfo) {
        job.settings.referenceStrength = stage2Variables.reference_strength;
        job.settings.stage2Steps = stage2Variables.steps;
        const stage2Placeholders = pipelineInfo.stage2Report.placeholders;
        job.pipeline = {
          stageCount: PIPELINE_STAGE_COUNT,
          currentStage: 1,
          drivingFrames: pipelineInfo.pipeline.drivingFrames,
          gpuGuard: gpuGuardEnabled ? 'enabled' : 'disabled',
          stages: [
            {
              index: 1,
              name: 'motion',
              title: '第一階段：產生舞蹈動作',
              status: 'pending',
              workflowName: job.workflowName,
              workflowSha256: job.workflowSha256,
              totalFrames,
            },
            {
              index: 2,
              name: 'identity',
              title: '第二階段：以原照片重繪人物',
              status: 'waiting',
              workflowName: path.basename(comfyUI.stage2WorkflowPath),
              workflowSha256: pipelineInfo.stage2Workflow.sha256,
              workflowVariables: Object.fromEntries(Object.entries({
                width: variables.width,
                height: variables.height,
                fps: variables.fps,
                seed: variables.seed,
                source_image: variables.source_image,
                ...stage2Variables,
              }).filter(([key]) => stage2Placeholders.includes(key) || ['steps', 'reference_strength'].includes(key))),
            },
          ],
        };
        // The guard runs before the stage-1 prompt can start.
        await startStageGuard(job, job.pipeline.stages[0]);
        const alarm = gpuGuardAlarms.get(job.id);
        if (alarm) {
          gpuGuardAlarms.delete(job.id);
          throw createRequestError(`${alarm.message}；未提交工作。`, 503);
        }
      }
      const apiWorkflow = applyWorkflowVariables(workflow, variables);
      let submission;
      try {
        submission = await submitComfyPrompt(apiWorkflow);
      } catch (error) {
        if (job.pipeline) await stopStageGuard(job.id);
        throw error;
      }
      job.comfyPromptId = submission.prompt_id;
      job.queuePosition = submission.number;
      job.status = 'queued';
      job.guidance = '已提交至本機 ComfyUI。請確認工作流輸出 .webm，完成後影片會匯入專案資料夾。';
      if (job.pipeline) {
        Object.assign(job.pipeline.stages[0], {
          status: 'queued',
          comfyPromptId: submission.prompt_id,
          queuePosition: submission.number,
          submittedAt: new Date().toISOString(),
          workflowVariables: job.workflowVariables,
        });
        job.guidance = '第 1 階段已提交至本機 ComfyUI（產生舞蹈動作）；完成後自動進行第 2 階段，只匯入最終影片。';
        setPipelineLabel(job);
      }
    }

    await persistInferenceJob(job);
    if (job.pipeline) schedulePipelineDriver(job.id);
    return job;
  }

  // Segment structure of the configured workflow for the UI ("最長 N 秒"); null when none is configured or readable.
  // The frame limit comes from the requested video model, or the default one.
  async function readConfiguredWorkflowSegments(videoModelId) {
    if (!comfyUI.workflowPath) return null;
    const model = VIDEO_MODEL_CATALOG.find((item) => item.id === videoModelId) || VIDEO_MODEL_CATALOG[0];
    try {
      const plan = readWorkflowSegmentPlan(await loadComfyWorkflow());
      if (plan.error) return { error: plan.error };
      return { ...describeWorkflowSegments(plan, model.recommendedMaxFrames), videoModelId: model.id };
    } catch (error) {
      return { error: String(error.message || error).slice(0, MAX_COMFY_ERROR_CHARS) };
    }
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
      const runtime = await getInferenceRuntime(outputDir, comfyUI);
      const videoModelId = requestUrl.searchParams.get('videoModelId');
      runtime.comfyUI.workflowSegments = await readConfiguredWorkflowSegments(videoModelId);
      if (pipelineMode) {
        const pipelineInfo = await readConfiguredPipeline(videoModelId);
        runtime.comfyUI.pipeline = pipelineInfo;
        runtime.comfyUI.stage2WorkflowConfigured = true;
        runtime.comfyUI.stage2WorkflowPath = comfyUI.stage2WorkflowPath;
        // The UI's "最長 N 秒" must follow the pipeline range, which is narrower than stage 1 alone.
        const segments = runtime.comfyUI.workflowSegments;
        if (segments && !segments.error && pipelineInfo.allowedDurationSecondsByFps) {
          const ranges = pipelineInfo.allowedDurationSecondsByFps;
          segments.maxDurationSecondsByFps = Object.fromEntries(Object.entries(ranges).map(([fps, range]) => [fps, range?.max ?? 0]));
          segments.minDurationSecondsByFps = Object.fromEntries(Object.entries(ranges).map(([fps, range]) => [fps, range?.min ?? 0]));
        }
        runtime.guidance.push('兩階段流程：第一階段產生舞蹈動作，第二階段以原照片重繪人物；只匯入第二階段影片。');
      }
      return sendJson(response, 200, runtime);
    }

    if (requestUrl.pathname === '/api/inference/workflow-check' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const report = await preflightComfyWorkflow(body);
      return sendJson(response, 200, report);
    }

    if (requestUrl.pathname === '/api/inference/loras' && request.method === 'GET') {
      return sendJson(response, 200, await describeComfyLoras());
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
        const headers = { 'content-type': 'video/webm' };
        if (requestUrl.searchParams.get('download') === '1') {
          // Node rejects non-Latin-1 header values, so filename= gets an ASCII fallback; filename* carries the real name.
          const asciiFileName = fileName.replace(/[^\x20-\x7e]|["\\]/gu, '_');
          headers['content-disposition'] = `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
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
        const listenPort = server.address()?.port ?? PORT;
        if (allowedApiHosts?.port !== listenPort) {
          allowedApiHosts = { port: listenPort, hosts: getAllowedApiHosts(listenPort, options.publicPorts) };
        }
        assertTrustedApiRequest(request, requestUrl, allowedApiHosts.hosts);
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

  server.on('close', () => {
    appClosed = true;
    for (const timer of pipelineDrivers.values()) clearTimeout(timer);
    pipelineDrivers.clear();
    for (const jobId of [...activeGpuGuards.keys()]) {
      // The stage keeps running in ComfyUI; a restarted server re-attaches a guard when it resumes the job.
      console.warn(`[gpu-guard] server closing; GPU guard for job ${jobId} stopped.`);
      stopStageGuard(jobId).catch(() => {});
    }
  });

  return {
    server,
    resumePipelineJobs,
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
  // Pipeline jobs left running by an earlier process are tracked (and GPU-guarded) again.
  await app.resumePipelineJobs().catch((error) => console.error(`Unable to resume pipeline jobs: ${error.message}`));
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
  validateModelFileSource,
};
