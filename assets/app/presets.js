// 參數預設與客戶專案：預設的載入、套用（含變數欄位）、儲存、更新、刪除與匯入匯出。

import { state, ui } from './state.js';
import { fetchJson, setSelectValue } from './dom.js';
import { renderModuleDetails } from './registry.js';
import { setResolutionValue, readResolution, selectWorkflow } from './workflows.js';
import { renderProjectOptions } from './library.js';
import { syncSeedInput, readSeedSetting } from './inference.js';

function setPresetStatus(message) {
  ui.presetStatus.textContent = message;
}

function getSelectedPreset() {
  return state.presets.find((preset) => preset.id === ui.presetSelect.value) || null;
}

function describePreset(preset) {
  const scope = [preset.client, preset.project].filter(Boolean).join(' / ');
  const label = scope ? `${scope}｜${preset.name}` : preset.name;
  return preset.builtIn ? `［場景模組］${label}` : label;
}

export function syncPresetUi() {
  const hasBackend = state.backend.available;
  const preset = getSelectedPreset();
  [ui.savePresetButton, ui.exportPresetsButton, ui.importPresetsButton].forEach((button) => {
    button.disabled = !hasBackend;
  });
  ui.applyPresetButton.disabled = !hasBackend || !preset;
  [ui.updatePresetButton, ui.deletePresetButton].forEach((button) => {
    button.disabled = !hasBackend || !preset || preset.builtIn === true;
    button.title = preset?.builtIn ? '場景模組內建的預設不可修改；可另存為新預設。' : '';
  });
  renderPresetVariables(preset);
}

function renderPresetOptions() {
  const selected = ui.presetSelect.value;
  ui.presetSelect.replaceChildren(new Option('（不使用預設）', ''));
  state.presets.forEach((preset) => ui.presetSelect.append(new Option(describePreset(preset), preset.id)));
  ui.presetSelect.value = state.presets.some((preset) => preset.id === selected) ? selected : '';
  syncPresetUi();
  renderProjectOptions();
}

const CUSTOM_OPTION = '__custom__';

// 讀取預設變數欄位目前的值：文字框直接取值；下拉選單選「自訂…」時取旁邊文字框的值。
function readPresetVariableValues() {
  return Object.fromEntries([...ui.presetVariables.querySelectorAll('[data-variable]')].map((control) => {
    if (control.tagName === 'SELECT' && control.value === CUSTOM_OPTION) {
      return [control.dataset.variable, control.parentElement.querySelector('[data-variable-custom]').value.trim()];
    }
    return [control.dataset.variable, control.value.trim()];
  }));
}

function createVariableField(name, field, value) {
  const label = document.createElement('label');
  label.className = 'preset-field';
  label.append(field?.label || `變數 {${name}}`);
  if (field?.type === 'select') {
    const select = document.createElement('select');
    select.dataset.variable = name;
    field.options.forEach((option) => select.append(new Option(option, option)));
    select.append(new Option('自訂…', CUSTOM_OPTION));
    const custom = document.createElement('input');
    custom.type = 'text';
    custom.maxLength = 1000;
    custom.placeholder = '輸入自訂內容';
    custom.dataset.variableCustom = name;
    const isOption = field.options.includes(value);
    select.value = isOption || !value ? (isOption ? value : field.options[0]) : CUSTOM_OPTION;
    custom.value = isOption ? '' : value;
    custom.hidden = select.value !== CUSTOM_OPTION;
    select.addEventListener('change', () => {
      custom.hidden = select.value !== CUSTOM_OPTION;
      if (!custom.hidden) custom.focus();
    });
    label.append(select, custom);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 1000;
    input.dataset.variable = name;
    input.value = value;
    if (field?.help) input.placeholder = field.help;
    label.append(input);
  }
  if (field?.help) {
    const help = document.createElement('span');
    help.className = 'field-help';
    help.textContent = field.help;
    label.append(help);
  }
  return label;
}

function renderPresetVariables(preset) {
  const variables = preset?.variables ?? [];
  // 只有重畫同一個預設時才保留已輸入的值；換成別的預設就從該預設的範例值與預設值開始。
  const previousValues = ui.presetVariables.dataset.presetId === (preset?.id ?? '') ? readPresetVariableValues() : {};
  ui.presetVariables.dataset.presetId = preset?.id ?? '';
  const scenarioModule = window.VedioFactory.scenarioModules?.find((item) => item.id === preset?.scenarioModuleId);
  const exampleValues = scenarioModule?.example?.variables ?? {};
  const fields = new Map((scenarioModule?.fields ?? []).map((field) => [field.name, field]));
  // 有細節欄位定義的依模組排列的順序顯示，其餘變數排在後面。
  const ordered = [
    ...[...fields.keys()].filter((name) => variables.includes(name)),
    ...variables.filter((name) => !fields.has(name)),
  ];
  ui.presetVariables.replaceChildren(...ordered.map((name) => createVariableField(
    name,
    fields.get(name),
    previousValues[name] || exampleValues[name] || fields.get(name)?.default || '',
  )));
  ui.presetVariables.hidden = ordered.length === 0;
}

function fillTemplate(template, values) {
  return String(template || '').replace(/(?<!\{)\{([\p{L}\p{N}_]{1,40})\}(?!\})/gu, (token, name) => (
    values[name] ? values[name] : token
  ));
}

export async function loadPresets() {
  if (!state.backend.available) {
    setPresetStatus('參數預設需要本機後端；目前為瀏覽器模式。');
    syncPresetUi();
    return;
  }
  try {
    state.presets = await fetchJson('/api/presets', { headers: {} });
    renderPresetOptions();
    setPresetStatus(state.presets.length ? `已載入 ${state.presets.length} 個參數預設。` : '尚未建立參數預設。');
  } catch (error) {
    console.error(error);
    setPresetStatus(`載入參數預設失敗：${error.message}`);
  }
}

function collectPresetFields() {
  const seedMode = ui.seedModeInput.value;
  return {
    client: ui.clientInput.value.trim(),
    project: ui.projectInput.value.trim(),
    promptTemplate: ui.promptInput.value.trim(),
    storyTemplate: ui.storyInput.value.trim(),
    negativePrompt: ui.negativePromptInput.value.trim(),
    moduleId: ui.moduleSelect.value,
    videoModelId: ui.videoModelSelect.value,
    workflowId: ui.workflowSelect.value,
    seedMode,
    seed: readSeedSetting() ?? null,
    settings: {
      duration: Number(ui.durationInput.value),
      fps: Number(ui.fpsInput.value),
      resolution: readResolution(),
      quality: ui.qualityInput.value,
      motion: Number(ui.motionInput.value),
      captionStrength: Number(ui.captionInput.value),
    },
  };
}

export function applySelectedPreset() {
  const preset = getSelectedPreset();
  if (!preset) return;
  const values = readPresetVariableValues();
  const missing = preset.variables.filter((name) => !values[name]);
  ui.promptInput.value = fillTemplate(preset.promptTemplate, values);
  ui.storyInput.value = fillTemplate(preset.storyTemplate, values);
  ui.negativePromptInput.value = preset.negativePrompt || '';
  ui.clientInput.value = preset.client || ui.clientInput.value;
  ui.projectInput.value = preset.project || ui.projectInput.value;
  if (setSelectValue(ui.moduleSelect, preset.moduleId)) renderModuleDetails();
  const workflowMissing = Boolean(preset.workflowId) && !setSelectValue(ui.workflowSelect, preset.workflowId);
  selectWorkflow();
  setSelectValue(ui.videoModelSelect, preset.videoModelId);
  const unsupported = [];
  const { min, max } = state.capabilities.duration;
  if (preset.settings.duration >= min && preset.settings.duration <= max) {
    ui.durationInput.value = String(preset.settings.duration);
  } else {
    unsupported.push(`長度 ${preset.settings.duration} 秒`);
  }
  if (!setSelectValue(ui.fpsInput, String(preset.settings.fps))) unsupported.push(`FPS ${preset.settings.fps}`);
  if (!setResolutionValue(preset.settings.resolution)) unsupported.push(`解析度 ${preset.settings.resolution}`);
  setSelectValue(ui.qualityInput, preset.settings.quality);
  ui.motionInput.value = String(preset.settings.motion);
  ui.captionInput.value = String(preset.settings.captionStrength);
  ui.seedModeInput.value = preset.seedMode;
  ui.seedInput.value = preset.seedMode === 'fixed' ? String(preset.seed) : '';
  syncSeedInput();
  state.activePresetId = preset.id;
  renderProjectOptions();
  const notes = [];
  if (missing.length) notes.push(`尚未填入變數：${missing.map((name) => `{${name}}`).join('、')}`);
  if (workflowMissing) notes.push(`找不到工作流 ${preset.workflowId}，沿用目前工作流`);
  if (unsupported.length) notes.push(`目前工作流不支援 ${unsupported.join('、')}，已改用可用值`);
  setPresetStatus(notes.length ? `已套用「${preset.name}」，但${notes.join('；')}。` : `已套用「${preset.name}」。`);
}

export async function savePreset() {
  try {
    const fields = collectPresetFields();
    const name = window.prompt('請輸入預設名稱', getSelectedPreset()?.name ?? '')?.trim();
    if (!name) return;
    const preset = await fetchJson('/api/presets', {
      method: 'POST',
      body: JSON.stringify({ ...fields, name }),
    });
    await loadPresets();
    ui.presetSelect.value = preset.id;
    state.activePresetId = preset.id;
    syncPresetUi();
    setPresetStatus(`已儲存預設「${preset.name}」${preset.variables.length ? `，含變數 ${preset.variables.map((item) => `{${item}}`).join('、')}` : ''}。`);
  } catch (error) {
    console.error(error);
    setPresetStatus(`儲存預設失敗：${error.message}`);
  }
}

export async function updatePreset() {
  const preset = getSelectedPreset();
  if (!preset) return;
  try {
    if (!window.confirm(`確定以目前設定覆蓋預設「${preset.name}」嗎？`)) return;
    const updated = await fetchJson(`/api/presets/${encodeURIComponent(preset.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ ...collectPresetFields(), name: preset.name, description: preset.description }),
    });
    await loadPresets();
    ui.presetSelect.value = updated.id;
    syncPresetUi();
    setPresetStatus(`已更新預設「${updated.name}」。`);
  } catch (error) {
    console.error(error);
    setPresetStatus(`更新預設失敗：${error.message}`);
  }
}

export async function deletePreset() {
  const preset = getSelectedPreset();
  if (!preset) return;
  try {
    if (!window.confirm(`確定刪除預設「${preset.name}」嗎？`)) return;
    await fetchJson(`/api/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
    if (state.activePresetId === preset.id) state.activePresetId = '';
    ui.presetSelect.value = '';
    await loadPresets();
    setPresetStatus(`已刪除預設「${preset.name}」。`);
  } catch (error) {
    console.error(error);
    setPresetStatus(`刪除預設失敗：${error.message}`);
  }
}

export async function exportPresets() {
  try {
    const payload = await fetchJson('/api/presets/export', { headers: {} });
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `vediofactory-presets-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setPresetStatus(`已匯出 ${payload.presets.length} 個預設。`);
  } catch (error) {
    console.error(error);
    setPresetStatus(`匯出預設失敗：${error.message}`);
  }
}

export async function importPresets() {
  const file = ui.importPresetsInput.files?.[0];
  ui.importPresetsInput.value = '';
  if (!file) return;
  try {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error('檔案不是有效的 JSON。');
    }
    const result = await fetchJson('/api/presets/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await loadPresets();
    setPresetStatus(`已匯入 ${result.imported} 個預設（相同 ID 的預設會被覆蓋）。`);
  } catch (error) {
    console.error(error);
    setPresetStatus(`匯入預設失敗：${error.message}`);
  }
}
