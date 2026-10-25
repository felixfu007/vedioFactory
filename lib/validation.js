const crypto = require('node:crypto');
const path = require('node:path');
const {
  BASE_CAPABILITIES,
  isResolutionAllowed,
  describeCustomRules,
} = require('../assets/capabilities.js');
const { VIDEO_MODEL_CATALOG } = require('./catalog.js');
const { createRequestError, isPlainObject } = require('./utils.js');

const WORKFLOW_ID_PATTERN = /^[\w.-]{1,80}$/u;
const MODULE_PRESET_ID_PATTERN = /^module:[a-z\d][a-z\d-]{0,40}$/u;
const MAX_TAG_LENGTH = 100;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const VIDEO_EXTENSIONS = ['.webm', '.mp4', '.gif', '.webp'];
const VIDEO_EXTENSION_PATTERN = /\.(webm|mp4|gif|webp)$/iu;

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

function sanitizePathSegment(value, fallback = 'item') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-z0-9_-]+/giu, '-')
    .replace(/(^-|-$)/gu, '')
    .slice(0, 40) || fallback;
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

function generateSeed() {
  return crypto.randomInt(0, 2 ** 48 - 1);
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

module.exports = {
  WORKFLOW_ID_PATTERN,
  MODULE_PRESET_ID_PATTERN,
  UUID_PATTERN,
  VIDEO_EXTENSION_PATTERN,
  normalizeOutputDir,
  sanitizeFileName,
  sanitizeFolderName,
  sanitizePathSegment,
  validateVideoMetadata,
  readOptionalText,
  validateSeed,
  validateGenerationSettings,
  validateProjectTags,
  validateInferencePayload,
  extractTemplateVariables,
  readWorkflowId,
  validatePresetPayload,
};
