const fs = require('node:fs/promises');
const path = require('node:path');
const { BASE_CAPABILITIES, narrowCapabilities } = require('../assets/capabilities.js');
const { VIDEO_MODEL_CATALOG } = require('./catalog.js');
const {
  createRequestError,
  getContentType,
  isPlainObject,
  sendText,
  sha256,
} = require('./utils.js');
const {
  WORKFLOW_ID_PATTERN,
  readOptionalText,
  readWorkflowId,
  validatePresetPayload,
  validateSeed,
} = require('./validation.js');

const WORKFLOW_META_SUFFIX = '.vf.json';
const MAX_WORKFLOW_META_BYTES = 64 * 1024;
const MAX_COMFY_WORKFLOW_BYTES = 10 * 1024 * 1024;
const MODULE_ID_PATTERN = /^[a-z\d][a-z\d-]{0,40}$/u;
const MODULE_ASSET_PATTERN = /^[\w-]+(?:\.[\w-]+)*\.(?:js|json|png|jpe?g|webp|svg)$/u;
const MAX_MODULE_MANIFEST_BYTES = 256 * 1024;
const FIELD_NAME_PATTERN = /^[\p{L}\p{N}_]{1,40}$/u;
const MAX_MODULE_FIELDS = 20;
const PRESET_SCHEMA_VERSION = 1;

// 細節欄位：{ use?: 共用欄位名稱, name, label, type: 'text'|'select', options, default, help }。
// use 會先帶入 modules/_shared/fields.json 的定義，再由模組自己的值覆寫。
function validateFieldDefinition(field, sharedFields) {
  if (!isPlainObject(field)) throw new Error('fields 的每一項都必須是物件。');
  let base = {};
  if (field.use !== undefined) {
    base = sharedFields[field.use];
    if (!isPlainObject(base)) throw new Error(`找不到共用欄位：${field.use}。`);
  }
  const merged = { ...base, ...field };
  const name = String(merged.name ?? field.use ?? '');
  if (!FIELD_NAME_PATTERN.test(name)) throw new Error(`欄位名稱無效：${name || '（空白）'}。`);
  const type = merged.type ?? 'text';
  if (!['text', 'select'].includes(type)) throw new Error(`欄位 ${name} 的 type 只能是 text 或 select。`);
  let options = [];
  if (type === 'select') {
    if (!Array.isArray(merged.options) || !merged.options.length || merged.options.length > 30
      || merged.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 100)) {
      throw new Error(`欄位 ${name} 的 options 必須是 1 至 30 個、每個 100 字以內的文字。`);
    }
    options = [...new Set(merged.options.map((option) => option.trim()))];
  }
  return {
    name,
    label: readOptionalText(merged, 'label', `欄位 ${name} 的 label`, 20) || name,
    type,
    options,
    default: readOptionalText(merged, 'default', `欄位 ${name} 的 default`, 200),
    help: readOptionalText(merged, 'help', `欄位 ${name} 的 help`, 200),
  };
}

function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

// 工作流資料夾、環境變數工作流與場景模組（modules/<id>/module.json）的掃描與預檢。
function createWorkflowRegistry({ workflowsDir, modulesDir, comfyUI }) {

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
  async function readSharedFields() {
    const sharedPath = path.join(modulesDir, '_shared', 'fields.json');
    const text = await fs.readFile(sharedPath, 'utf8').catch(() => null);
    if (text === null) return {};
    try {
      const shared = JSON.parse(text);
      return isPlainObject(shared?.fields) ? shared.fields : {};
    } catch {
      return {};
    }
  }

  async function readScenarioModule(id, sharedFields = {}) {
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

    let fields = [];
    if (manifest.fields !== undefined) {
      if (!Array.isArray(manifest.fields) || manifest.fields.length > MAX_MODULE_FIELDS) {
        throw new Error(`fields 必須是最多 ${MAX_MODULE_FIELDS} 個欄位的陣列。`);
      }
      fields = manifest.fields.map((field) => validateFieldDefinition(field, sharedFields));
      const names = fields.map((field) => field.name);
      const duplicate = names.find((name, index) => names.indexOf(name) !== index);
      if (duplicate) throw new Error(`欄位名稱重複：${duplicate}。`);
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
      fields,
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
    const sharedFields = await readSharedFields();
    for (const entry of entries) {
      // Folders starting with "_" or "." hold shared assets, not modules.
      if (!entry.isDirectory() || /^[_.]/u.test(entry.name)) continue;
      if (!MODULE_ID_PATTERN.test(entry.name)) {
        scenarioModules.push({ id: entry.name, name: entry.name, error: '模組資料夾名稱只能使用小寫英數字與 -。' });
        continue;
      }
      try {
        scenarioModules.push(await readScenarioModule(entry.name, sharedFields));
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

  return {
    listWorkflows,
    listScenarioModules,
    toScenarioModuleResponse,
    listModulePresets,
    serveScenarioModuleAsset,
    resolveWorkflow,
    loadComfyWorkflow,
    inspectComfyWorkflow,
    preflightComfyWorkflow,
  };
}

module.exports = {
  PRESET_SCHEMA_VERSION,
  samePath,
  createWorkflowRegistry,
};
