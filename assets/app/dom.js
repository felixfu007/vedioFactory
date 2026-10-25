// DOM 綁定與共用小工具：狀態訊息、fetchJson、檔案／圖片讀取、下拉選單輔助與格式化。

import { ui } from './state.js';

export function bindUi() {
  ui.imageInput = document.querySelector('#imageInput');
  ui.promptInput = document.querySelector('#promptInput');
  ui.storyInput = document.querySelector('#storyInput');
  ui.moduleSelect = document.querySelector('#moduleSelect');
  ui.moduleDetails = document.querySelector('#moduleDetails');
  ui.durationInput = document.querySelector('#durationInput');
  ui.fpsInput = document.querySelector('#fpsInput');
  ui.resolutionInput = document.querySelector('#resolutionInput');
  ui.qualityInput = document.querySelector('#qualityInput');
  ui.motionInput = document.querySelector('#motionInput');
  ui.captionInput = document.querySelector('#captionInput');
  ui.generateButton = document.querySelector('#generateButton');
  ui.generationForm = document.querySelector('#generationForm');
  ui.generationStatus = document.querySelector('#generationStatus');
  ui.libraryGrid = document.querySelector('#libraryGrid');
  ui.libraryEmpty = document.querySelector('#libraryEmpty');
  ui.folderName = document.querySelector('#folderName');
  ui.storageMode = document.querySelector('#storageMode');
  ui.gpuStatus = document.querySelector('#gpuStatus');
  ui.moduleCount = document.querySelector('#moduleCount');
  ui.outputDirInput = document.querySelector('#outputDirInput');
  ui.connectOutputDirButton = document.querySelector('#connectOutputDirButton');
  ui.pickFolderButton = document.querySelector('#pickFolderButton');
  ui.refreshButton = document.querySelector('#refreshButton');
  ui.inferenceRuntime = document.querySelector('#inferenceRuntime');
  ui.queueInferenceButton = document.querySelector('#queueInferenceButton');
  ui.cancelInferenceButton = document.querySelector('#cancelInferenceButton');
  ui.batchPromptsInput = document.querySelector('#batchPromptsInput');
  ui.refreshJobsButton = document.querySelector('#refreshJobsButton');
  ui.jobStatusFilter = document.querySelector('#jobStatusFilter');
  ui.jobsEmpty = document.querySelector('#jobsEmpty');
  ui.jobsTable = document.querySelector('#jobsTable');
  ui.jobsTableBody = document.querySelector('#jobsTableBody');
  ui.jobsStatus = document.querySelector('#jobsStatus');
  ui.batchSeedCountInput = document.querySelector('#batchSeedCountInput');
  ui.queueBatchButton = document.querySelector('#queueBatchButton');
  ui.workflowCheckButton = document.querySelector('#workflowCheckButton');
  ui.workflowCheckStatus = document.querySelector('#workflowCheckStatus');
  ui.inferenceStatus = document.querySelector('#inferenceStatus');
  ui.modelCatalogSummary = document.querySelector('#modelCatalogSummary');
  ui.modelCatalogGrid = document.querySelector('#modelCatalogGrid');
  ui.videoModelCatalogGrid = document.querySelector('#videoModelCatalogGrid');
  ui.videoModelSelect = document.querySelector('#videoModelSelect');
  ui.negativePromptInput = document.querySelector('#negativePromptInput');
  ui.seedModeInput = document.querySelector('#seedModeInput');
  ui.seedInput = document.querySelector('#seedInput');
  ui.modelCatalogStatus = document.querySelector('#modelCatalogStatus');
  ui.setupModelBatchButton = document.querySelector('#setupModelBatchButton');
  ui.cardTemplate = document.querySelector('#videoCardTemplate');
  ui.clientInput = document.querySelector('#clientInput');
  ui.projectInput = document.querySelector('#projectInput');
  ui.clientOptions = document.querySelector('#clientOptions');
  ui.projectOptions = document.querySelector('#projectOptions');
  ui.presetSelect = document.querySelector('#presetSelect');
  ui.presetVariables = document.querySelector('#presetVariables');
  ui.presetStatus = document.querySelector('#presetStatus');
  ui.applyPresetButton = document.querySelector('#applyPresetButton');
  ui.savePresetButton = document.querySelector('#savePresetButton');
  ui.updatePresetButton = document.querySelector('#updatePresetButton');
  ui.deletePresetButton = document.querySelector('#deletePresetButton');
  ui.exportPresetsButton = document.querySelector('#exportPresetsButton');
  ui.importPresetsButton = document.querySelector('#importPresetsButton');
  ui.importPresetsInput = document.querySelector('#importPresetsInput');
  ui.libraryClientFilter = document.querySelector('#libraryClientFilter');
  ui.civitaiUrlInput = document.querySelector('#civitaiUrlInput');
  ui.civitaiFolderSelect = document.querySelector('#civitaiFolderSelect');
  ui.civitaiPreviewButton = document.querySelector('#civitaiPreviewButton');
  ui.civitaiInstallButton = document.querySelector('#civitaiInstallButton');
  ui.civitaiPreview = document.querySelector('#civitaiPreview');
  ui.civitaiStatus = document.querySelector('#civitaiStatus');
  ui.civitaiJobs = document.querySelector('#civitaiJobs');
  ui.createDeliveryButton = document.querySelector('#createDeliveryButton');
  ui.deliveryStatus = document.querySelector('#deliveryStatus');
  ui.customResolutionFields = document.querySelector('#customResolutionFields');
  ui.customWidthInput = document.querySelector('#customWidthInput');
  ui.customHeightInput = document.querySelector('#customHeightInput');
  ui.capabilityHint = document.querySelector('#capabilityHint');
  ui.workflowSelect = document.querySelector('#workflowSelect');
  ui.workflowDetails = document.querySelector('#workflowDetails');
  ui.libraryProjectFilter = document.querySelector('#libraryProjectFilter');
}

export function getFolderLabel(input) {
  if (!input) return '尚未選擇';
  return input.split(/[\\/]/u).filter(Boolean).at(-1) || input;
}

export function setStatus(message) {
  ui.generationStatus.textContent = message;
}

export function setInferenceStatus(message) {
  ui.inferenceStatus.textContent = message;
}

export function setModelCatalogStatus(message) {
  ui.modelCatalogStatus.textContent = message;
}

export function resolutionToSize(value) {
  const [width, height] = value.split('x').map((item) => Number(item));
  return { width, height };
}

export function createVideoUploadBody(metadata, videoBlob) {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const metadataLength = new Uint8Array(4);
  new DataView(metadataLength.buffer).setUint32(0, metadataBytes.length);
  return new Blob([metadataLength, metadataBytes, videoBlob], { type: 'application/octet-stream' });
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

export function readFileAsDataUrl(file) {
  if (!file) return Promise.resolve('');

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('讀取圖片失敗'));
    reader.readAsDataURL(file);
  });
}

export function loadImage(dataUrl) {
  if (!dataUrl) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('圖片載入失敗'));
    image.src = dataUrl;
  });
}

export function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function fillSelectOptions(select, values, emptyLabel) {
  const selected = select.value;
  select.replaceChildren(new Option(emptyLabel, ''));
  values.forEach((value) => select.append(new Option(value, value)));
  select.value = values.includes(selected) ? selected : '';
}

export function distinctValues(items, field) {
  const collator = new Intl.Collator('zh-Hant');
  return [...new Set(items.map((item) => item[field]).filter(Boolean))].sort(collator.compare);
}

export function setSelectValue(select, value) {
  if (value && [...select.options].some((option) => option.value === value)) {
    select.value = value;
    return true;
  }
  return false;
}

export function formatBytes(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
