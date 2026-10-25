// 推論環境與模型目錄：顯示 GPU／ComfyUI 狀態、模型規劃卡片，並建立首批模型整合清單。

import { state, ui } from './state.js';
import { setModelCatalogStatus, fetchJson } from './dom.js';

export function renderInferenceRuntime() {
  const runtime = state.inference.runtime;
  ui.inferenceRuntime.replaceChildren();

  if (!runtime) {
    ui.gpuStatus.textContent = '未連線';
    ui.inferenceRuntime.textContent = '尚未取得本機推論狀態。';
    ui.queueInferenceButton.disabled = true;
    return;
  }

  ui.gpuStatus.textContent = runtime.gpu?.detected ? '已偵測 NVIDIA' : '待設定';
  ui.queueInferenceButton.disabled = !state.backend.available;

  const lines = [
    `平台：${runtime.platform}`,
    `GPU：${runtime.gpu?.detected ? `${runtime.gpu.name || 'NVIDIA'} / ${runtime.gpu.memoryTotal || '未知 VRAM'}` : '尚未偵測到 nvidia-smi'}`,
    `模型目錄：${runtime.modelDir}`,
    `ComfyUI：${runtime.comfyUI?.available ? `已連線 (${runtime.comfyUI.url})` : `未連線 (${runtime.comfyUI?.error || runtime.comfyUI?.url || '未設定'})`}`,
    `API 工作流：${runtime.comfyUI?.workflowCount ? `${runtime.comfyUI.workflowCount} 個` : '尚未設定（將 API JSON 放入 workflows 資料夾）'}`,
    `方向：${runtime.provider}`,
  ];

  const list = document.createElement('ul');
  lines.forEach((line) => {
    const item = document.createElement('li');
    item.textContent = line;
    list.append(item);
  });
  ui.inferenceRuntime.append(list);
}

export function renderModelCatalog() {
  const catalog = state.modelCatalog;
  ui.modelCatalogGrid.innerHTML = '';
  ui.videoModelCatalogGrid.innerHTML = '';

  if (!catalog) {
    ui.modelCatalogSummary.hidden = false;
    ui.modelCatalogSummary.textContent = '尚未取得模型規劃資料。';
    ui.setupModelBatchButton.disabled = true;
    return;
  }

  ui.setupModelBatchButton.disabled = false;
  ui.modelCatalogSummary.hidden = false;
  ui.modelCatalogSummary.textContent = `目前真正已整合的 AI 模型數量：${catalog.currentProjectStatus.actualIntegratedModels.length}；列出 ${catalog.videoModels.length} 個本機影片模型選項。`;

  const selectedModelId = ui.videoModelSelect.value;
  ui.videoModelSelect.replaceChildren();
  catalog.videoModels.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.priority}. ${model.name}${model.recommended ? '（優先推薦）' : ''}`;
    ui.videoModelSelect.append(option);
  });
  if (catalog.videoModels.some((model) => model.id === selectedModelId)) {
    ui.videoModelSelect.value = selectedModelId;
  } else if (catalog.videoModels.length) {
    ui.videoModelSelect.value = catalog.videoModels[0].id;
  }

  const renderModelCards = (models, grid, includeWorkflowNotes = false) => models.forEach((model) => {
    const card = document.createElement('article');
    card.className = 'catalog-card';

    const title = document.createElement('h3');
    title.textContent = `${model.priority ? `${model.priority}. ` : ''}${model.name}${model.recommended ? '（優先推薦）' : ''}`;
    const note = document.createElement('p');
    note.className = 'video-subtitle';
    note.textContent = model.notes;
    const installPath = document.createElement('p');
    installPath.className = 'summary';
    installPath.textContent = `${model.kind === 'video-model' ? '模型參考目錄' : '安裝目錄'}：${model.installPath}`;

    const chips = document.createElement('div');
    chips.className = 'catalog-chip-row';
    [...(model.taskTypes || []), model.category, model.batch, model.status, model.windowsProfile?.vramHint].filter(Boolean).forEach((value) => {
      const chip = document.createElement('span');
      chip.className = 'catalog-chip';
      chip.textContent = value;
      chips.append(chip);
    });

    const list = document.createElement('ul');
    model.bestFor.forEach((value) => {
      const entry = document.createElement('li');
      entry.textContent = value;
      list.append(entry);
    });

    card.append(title, note, chips, installPath, list);
    if (includeWorkflowNotes && model.workflowNotes) {
      const workflowNote = document.createElement('p');
      workflowNote.className = 'hint';
      workflowNote.textContent = model.workflowNotes;
      card.append(workflowNote);
    }
    if (model.sourceUrl) {
      const source = document.createElement('a');
      source.href = model.sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = '官方專案 / 模型頁';
      card.append(source);
    }
    grid.append(card);
  });
  renderModelCards(catalog.videoModels, ui.videoModelCatalogGrid, true);
  renderModelCards(
    catalog.models.filter((model) => model.kind !== 'video-model' && model.id !== 'animatediff'),
    ui.modelCatalogGrid,
  );
}

export async function setupModelBatch() {
  try {
    if (!state.backend.available) {
      setModelCatalogStatus('目前未連線到本機後端，無法建立模型整合清單。');
      return;
    }

    const payload = await fetchJson('/api/models/setup-batch', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setModelCatalogStatus(`已建立 ${payload.firstBatchModels.length} 個首批模型整合 manifest，安裝根目錄：${payload.installRoot}`);
  } catch (error) {
    console.error(error);
    setModelCatalogStatus(`建立模型整合清單失敗：${error.message}`);
  }
}
