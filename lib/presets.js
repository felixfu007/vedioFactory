const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BASE_CAPABILITIES } = require('../assets/capabilities.js');
const { PRESET_SCHEMA_VERSION } = require('./workflows.js');
const { createRequestError, fileExists, isPlainObject } = require('./utils.js');
const {
  MODULE_PRESET_ID_PATTERN,
  UUID_PATTERN,
  extractTemplateVariables,
  readWorkflowId,
  validatePresetPayload,
} = require('./validation.js');

const MAX_PRESETS_PER_IMPORT = 500;

// 使用者自訂參數預設：presetsDir 內每筆一個 <uuid>.json；場景模組內建預設唯讀。
function createPresetStore({ presetsDir, workflows }) {
  const { listWorkflows } = workflows;

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

  return {
    toPresetResponse,
    listPresets,
    createPreset,
    updatePreset,
    deletePreset,
    exportPresets,
    importPresets,
  };
}

module.exports = { createPresetStore };
