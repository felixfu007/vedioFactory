// ComfyUI 工作流與能力（解析度／FPS／長度）設定：載入工作流清單並依所選工作流更新表單限制。

import { Capabilities, state, ui } from './state.js';
import { fetchJson, setSelectValue } from './dom.js';

export function syncCustomResolutionFields() {
  const isCustom = ui.resolutionInput.value === 'custom';
  ui.customResolutionFields.hidden = !isCustom;
  // Hidden fields still take part in form validation unless disabled, which would silently block "generate".
  ui.customWidthInput.disabled = !isCustom;
  ui.customHeightInput.disabled = !isCustom;
}

export function setResolutionValue(value) {
  if ([...ui.resolutionInput.options].some((option) => option.value === value && value !== 'custom')) {
    ui.resolutionInput.value = value;
  } else if (state.capabilities.customResolution.enabled && Capabilities.isResolutionAllowed(value, state.capabilities)) {
    const size = Capabilities.parseResolution(value);
    ui.resolutionInput.value = 'custom';
    ui.customWidthInput.value = String(size.width);
    ui.customHeightInput.value = String(size.height);
  } else {
    syncCustomResolutionFields();
    return false;
  }
  syncCustomResolutionFields();
  return true;
}

export function readResolution() {
  if (ui.resolutionInput.value !== 'custom') {
    return ui.resolutionInput.value || state.capabilities.defaults.resolution;
  }
  const resolution = `${Number(ui.customWidthInput.value)}x${Number(ui.customHeightInput.value)}`;
  if (!Capabilities.isResolutionAllowed(resolution, state.capabilities)) {
    throw new Error(`自訂解析度無效：${Capabilities.describeCustomRules(state.capabilities.customResolution)}。`);
  }
  return resolution;
}

export function renderCapabilities(capabilities) {
  let previousResolution = ui.resolutionInput.value;
  if (previousResolution === 'custom') {
    previousResolution = `${Number(ui.customWidthInput.value)}x${Number(ui.customHeightInput.value)}`;
  }
  const previousFps = Number(ui.fpsInput.value);
  const previousDuration = Number(ui.durationInput.value);
  state.capabilities = capabilities;

  ui.resolutionInput.replaceChildren(...capabilities.resolutions.map((item) => new Option(item.label, item.value)));
  const rules = capabilities.customResolution;
  if (rules.enabled) ui.resolutionInput.append(new Option('自訂…', 'custom'));
  [ui.customWidthInput, ui.customHeightInput].forEach((input) => {
    input.step = String(rules.multiple);
    input.min = String(rules.minSize);
  });
  ui.customWidthInput.max = String(rules.maxWidth);
  ui.customHeightInput.max = String(rules.maxHeight);
  if (!setResolutionValue(previousResolution)) setResolutionValue(capabilities.defaults.resolution);

  ui.fpsInput.replaceChildren(...capabilities.fps.map((value) => new Option(String(value), String(value))));
  ui.fpsInput.value = String(capabilities.fps.includes(previousFps) ? previousFps : capabilities.defaults.fps);

  const { min, max } = capabilities.duration;
  ui.durationInput.min = String(min);
  ui.durationInput.max = String(max);
  if (!Number.isInteger(previousDuration) || previousDuration < min || previousDuration > max) {
    ui.durationInput.value = String(capabilities.defaults.duration);
  }

  ui.capabilityHint.textContent = [
    `長度 ${min}–${max} 秒`,
    `FPS ${capabilities.fps.join('／')}`,
    rules.enabled ? `自訂解析度：${Capabilities.describeCustomRules(rules)}` : '不支援自訂解析度',
  ].join('；');
}

export function getSelectedWorkflow() {
  return state.workflows.find((workflow) => workflow.id === ui.workflowSelect.value) || null;
}

export function selectWorkflow() {
  const workflow = getSelectedWorkflow();
  if (!workflow) {
    ui.workflowDetails.textContent = state.backend.available
      ? '尚未設定工作流：將 ComfyUI 匯出的 API JSON 放入 workflows 資料夾後重新整理頁面。'
      : '需要本機後端才能使用 ComfyUI 工作流。';
    renderCapabilities(Capabilities.BASE_CAPABILITIES);
    return;
  }
  if (workflow.error) {
    ui.workflowDetails.textContent = workflow.error;
    renderCapabilities(Capabilities.BASE_CAPABILITIES);
    return;
  }
  ui.workflowDetails.textContent = [
    workflow.description,
    workflow.videoModelIds.length ? `適用模型：${workflow.videoModelIds.join('、')}` : '',
    workflow.requiresSourceImage ? '需要來源圖片' : '',
    `檔案：${workflow.workflowPath}`,
  ].filter(Boolean).join('｜');
  if (workflow.videoModelIds.length && !workflow.videoModelIds.includes(ui.videoModelSelect.value)) {
    setSelectValue(ui.videoModelSelect, workflow.videoModelIds[0]);
  }
  renderCapabilities(workflow.capabilities);
}

export async function loadWorkflows() {
  if (!state.backend.available) {
    ui.workflowSelect.replaceChildren(new Option('（需要本機後端）', ''));
    ui.workflowSelect.disabled = true;
    selectWorkflow();
    return;
  }
  try {
    state.workflows = await fetchJson('/api/workflows', { headers: {} });
  } catch (error) {
    console.error(error);
    state.workflows = [];
    ui.workflowDetails.textContent = `載入工作流失敗：${error.message}`;
  }
  const selected = ui.workflowSelect.value;
  ui.workflowSelect.replaceChildren(...(state.workflows.length
    ? state.workflows.map((workflow) => new Option(
      `${workflow.name}${workflow.isDefault ? '（預設）' : ''}${workflow.error ? '（設定錯誤）' : ''}`,
      workflow.id,
    ))
    : [new Option('（尚未設定工作流）', '')]));
  ui.workflowSelect.disabled = state.workflows.length === 0;
  if (state.workflows.some((workflow) => workflow.id === selected)) ui.workflowSelect.value = selected;
  selectWorkflow();
}
