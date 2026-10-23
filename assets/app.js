(() => {
  const Capabilities = window.VedioFactoryCapabilities;
  const modules = [];
  const qualityBitrates = {
    draft: 1_200_000,
    balanced: 2_500_000,
    premium: 4_200_000,
  };

  const state = {
    library: [],
    folderHandle: null,
    generating: false,
    backend: {
      available: false,
      outputDir: '',
    },
    inference: {
      runtime: null,
      lastJob: null,
      pollTimer: null,
      pollingJobId: '',
      pollInFlight: false,
    },
    modelCatalog: null,
    presets: [],
    activePresetId: '',
    workflows: [],
    capabilities: Capabilities.BASE_CAPABILITIES,
    libraryFilter: {
      client: '',
      project: '',
    },
  };

  const storageKey = 'vedioFactory.library';

  const ui = {};

  function registerModule(moduleDefinition) {
    if (!moduleDefinition || !moduleDefinition.id) {
      throw new Error('Module definition requires an id.');
    }

    modules.push(moduleDefinition);
    if (ui.moduleSelect) {
      renderModuleOptions();
    }
  }

  function getModuleById(id) {
    return modules.find((item) => item.id === id) ?? modules[0];
  }

  function getSupportedMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];

    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
  }

  function serializeLibrary() {
    const payload = state.library
      .filter((item) => item.storageOrigin === 'backend')
      .map(({ previewUrl, blob, ...item }) => item);
    localStorage.setItem(storageKey, JSON.stringify(payload));
  }

  function loadStoredLibrary() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      state.library = Array.isArray(saved)
        ? saved.filter((item) => item?.storageOrigin === 'backend' && item?.fileName)
        : [];
    } catch (error) {
      console.warn('Unable to restore library.', error);
      state.library = [];
    }
  }

  function bindUi() {
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
    ui.customResolutionFields = document.querySelector('#customResolutionFields');
    ui.customWidthInput = document.querySelector('#customWidthInput');
    ui.customHeightInput = document.querySelector('#customHeightInput');
    ui.capabilityHint = document.querySelector('#capabilityHint');
    ui.workflowSelect = document.querySelector('#workflowSelect');
    ui.workflowDetails = document.querySelector('#workflowDetails');
    ui.libraryProjectFilter = document.querySelector('#libraryProjectFilter');
  }

  function getFolderLabel(input) {
    if (!input) return '尚未選擇';
    return input.split(/[\\/]/u).filter(Boolean).at(-1) || input;
  }

  function renderModuleOptions() {
    const currentValue = ui.moduleSelect.value;
    ui.moduleSelect.innerHTML = '';
    modules.forEach((moduleDefinition) => {
      const option = document.createElement('option');
      option.value = moduleDefinition.id;
      option.textContent = `${moduleDefinition.name}｜${moduleDefinition.tagline}`;
      ui.moduleSelect.append(option);
    });

    if (currentValue && modules.some((moduleDefinition) => moduleDefinition.id === currentValue)) {
      ui.moduleSelect.value = currentValue;
    }
    ui.moduleCount.textContent = String(modules.length);
    renderModuleDetails();
  }

  function renderModuleDetails() {
    const moduleDefinition = getModuleById(ui.moduleSelect.value);
    if (!moduleDefinition) {
      ui.moduleDetails.textContent = '尚未註冊任何模組。';
      return;
    }

    ui.moduleDetails.replaceChildren();

    const title = document.createElement('h3');
    title.textContent = moduleDefinition.name;
    const description = document.createElement('p');
    description.textContent = moduleDefinition.description;
    const bestFor = document.createElement('p');
    bestFor.className = 'video-subtitle';
    bestFor.textContent = `適用情境：${moduleDefinition.bestFor}`;
    const list = document.createElement('ul');
    moduleDefinition.capabilities.forEach((item) => {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.append(entry);
    });

    ui.moduleDetails.append(title, description, bestFor, list);
  }

  function setStatus(message) {
    ui.generationStatus.textContent = message;
  }

  function setInferenceStatus(message) {
    ui.inferenceStatus.textContent = message;
  }

  function setModelCatalogStatus(message) {
    ui.modelCatalogStatus.textContent = message;
  }

  function syncStorageUi() {
    if (state.backend.available) {
      ui.storageMode.textContent = '後端資料夾';
      ui.folderName.textContent = getFolderLabel(state.backend.outputDir);
      ui.outputDirInput.value = state.backend.outputDir;
      return;
    }

    if (state.folderHandle) {
      ui.storageMode.textContent = '瀏覽器資料夾';
      ui.folderName.textContent = state.folderHandle.name;
      return;
    }

    ui.storageMode.textContent = '瀏覽器暫存';
    ui.folderName.textContent = '尚未選擇';
  }

  function renderInferenceRuntime() {
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

  function renderModelCatalog() {
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

  function setGeneratingState(isGenerating) {
    state.generating = isGenerating;
    ui.generateButton.disabled = isGenerating;
    ui.generateButton.textContent = isGenerating ? '生成中…' : '生成影片';
  }

  function resolutionToSize(value) {
    const [width, height] = value.split('x').map((item) => Number(item));
    return { width, height };
  }

  function createVideoUploadBody(metadata, videoBlob) {
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
    const metadataLength = new Uint8Array(4);
    new DataView(metadataLength.buffer).setUint32(0, metadataBytes.length);
    return new Blob([metadataLength, metadataBytes, videoBlob], { type: 'application/octet-stream' });
  }

  async function fetchJson(url, options = {}) {
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

  function readFileAsDataUrl(file) {
    if (!file) return Promise.resolve('');

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error ?? new Error('讀取圖片失敗'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('圖片載入失敗'));
      image.src = dataUrl;
    });
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function fitImage(image, canvas, scaleBoost = 0) {
    const ratio = Math.max(canvas.width / image.width, canvas.height / image.height) * (1 + scaleBoost);
    const width = image.width * ratio;
    const height = image.height * ratio;
    return {
      width,
      height,
      x: (canvas.width - width) / 2,
      y: (canvas.height - height) / 2,
    };
  }

  function wrapText(ctx, text, maxWidth) {
    const splitByWhitespace = /\s/u.test(text);
    const words = splitByWhitespace ? text.split(/\s+/u).filter(Boolean) : Array.from(text);
    if (!words.length) return [''];

    const lines = [];
    let current = words.shift() ?? '';

    words.forEach((word) => {
      const candidate = splitByWhitespace ? `${current} ${word}` : `${current}${word}`;
      if (ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });

    lines.push(current);
    return lines;
  }

  function drawCaptionBlock(ctx, text, canvas, emphasis) {
    if (!text) return;
    const padding = 28;
    ctx.save();
    ctx.font = `${Math.max(26, Math.round(canvas.width * 0.028))}px sans-serif`;
    const lines = wrapText(ctx, text, canvas.width - padding * 2);
    const lineHeight = Math.max(36, Math.round(canvas.height * 0.06));
    const boxHeight = lineHeight * lines.length + 24;
    const y = canvas.height - boxHeight - 24;
    const alpha = 0.35 + emphasis / 220;
    ctx.fillStyle = `rgba(2, 7, 13, ${Math.min(alpha, 0.85)})`;
    ctx.fillRect(18, y, canvas.width - 36, boxHeight);
    ctx.fillStyle = '#ffffff';
    lines.forEach((line, index) => {
      ctx.fillText(line, padding, y + 40 + index * lineHeight);
    });
    ctx.restore();
  }

  function syncCustomResolutionFields() {
    ui.customResolutionFields.hidden = ui.resolutionInput.value !== 'custom';
  }

  function setResolutionValue(value) {
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

  function readResolution() {
    if (ui.resolutionInput.value !== 'custom') {
      return ui.resolutionInput.value || state.capabilities.defaults.resolution;
    }
    const resolution = `${Number(ui.customWidthInput.value)}x${Number(ui.customHeightInput.value)}`;
    if (!Capabilities.isResolutionAllowed(resolution, state.capabilities)) {
      throw new Error(`自訂解析度無效：${Capabilities.describeCustomRules(state.capabilities.customResolution)}。`);
    }
    return resolution;
  }

  function renderCapabilities(capabilities) {
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

  function getSelectedWorkflow() {
    return state.workflows.find((workflow) => workflow.id === ui.workflowSelect.value) || null;
  }

  function selectWorkflow() {
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

  async function loadWorkflows() {
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

  function gatherSpec(overrides = {}) {
    const duration = Number(ui.durationInput.value) || state.capabilities.defaults.duration;
    const fps = Number(ui.fpsInput.value) || state.capabilities.defaults.fps;
    const resolution = readResolution();
    const size = resolutionToSize(resolution);
    return {
      id: crypto.randomUUID(),
      moduleId: ui.moduleSelect.value,
      prompt: ui.promptInput.value.trim(),
      story: ui.storyInput.value.trim(),
      duration,
      fps,
      resolution,
      width: size.width,
      height: size.height,
      quality: ui.qualityInput.value,
      motion: Number(ui.motionInput.value),
      captionStrength: Number(ui.captionInput.value),
      client: ui.clientInput.value.trim(),
      project: ui.projectInput.value.trim(),
      presetId: state.activePresetId,
      sourceImageDataUrl: '',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeFileName(spec, suffix = '') {
    const clean = (spec.prompt || spec.story || 'video')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 36);
    return `${clean || 'video'}${suffix}.webm`;
  }

  async function writeFile(handle, blob) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async function saveAssetSet(item) {
    if (state.backend.available) {
      item.storageOrigin = 'backend';
      item.previewUrl = `/api/videos/${encodeURIComponent(item.fileName)}?t=${Date.now()}`;
      await fetchJson('/api/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: createVideoUploadBody(stripTransientFields(item), item.blob),
      });
      return item;
    }

    if (!state.folderHandle) {
      item.storageOrigin = 'temporary';
      item.previewUrl = URL.createObjectURL(item.blob);
      return item;
    }

    item.storageOrigin = 'folder';
    const videoHandle = await state.folderHandle.getFileHandle(item.fileName, { create: true });
    const metadataHandle = await state.folderHandle.getFileHandle(`${item.fileName}.json`, { create: true });
    await writeFile(videoHandle, item.blob);
    await writeFile(metadataHandle, new Blob([JSON.stringify(stripTransientFields(item), null, 2)], { type: 'application/json' }));
    return item;
  }

  function stripTransientFields(item) {
    const { previewUrl, blob, ...persisted } = item;
    return persisted;
  }

  function releasePreviewUrls(items) {
    items.forEach((item) => {
      if (typeof item.previewUrl === 'string' && item.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(item.previewUrl);
      }
    });
  }

  async function listFolderItems() {
    if (state.backend.available) {
      const items = await fetchJson('/api/videos');
      releasePreviewUrls(state.library);
      state.library = items;
      serializeLibrary();
      return items;
    }

    if (!state.folderHandle) return state.library;

    const nextLibrary = [];
    for await (const [entryName, entry] of state.folderHandle.entries()) {
      if (entry.kind !== 'file' || !entryName.endsWith('.webm.json')) continue;
      try {
        const file = await entry.getFile();
        const metadata = JSON.parse(await file.text());
        metadata.previewUrl = await getPreviewUrl(metadata.fileName);
        nextLibrary.push(metadata);
      } catch {
        continue;
      }
    }

    nextLibrary.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    releasePreviewUrls(state.library);
    state.library = nextLibrary;
    serializeLibrary();
    return nextLibrary;
  }

  async function getPreviewUrl(fileName) {
    if (state.backend.available) {
      return `/api/videos/${encodeURIComponent(fileName)}?t=${Date.now()}`;
    }
    if (!state.folderHandle) return '';
    const fileHandle = await state.folderHandle.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return URL.createObjectURL(file);
  }

  function fillSelectOptions(select, values, emptyLabel) {
    const selected = select.value;
    select.replaceChildren(new Option(emptyLabel, ''));
    values.forEach((value) => select.append(new Option(value, value)));
    select.value = values.includes(selected) ? selected : '';
  }

  function distinctValues(items, field) {
    const collator = new Intl.Collator('zh-Hant');
    return [...new Set(items.map((item) => item[field]).filter(Boolean))].sort(collator.compare);
  }

  function renderProjectOptions() {
    const sources = [...state.library, ...state.presets];
    const clients = distinctValues(sources, 'client');
    const client = ui.clientInput.value.trim();
    const projects = distinctValues(sources.filter((item) => !client || item.client === client), 'project');
    ui.clientOptions.replaceChildren(...clients.map((value) => new Option(value)));
    ui.projectOptions.replaceChildren(...projects.map((value) => new Option(value)));
  }

  function renderLibraryFilters() {
    fillSelectOptions(ui.libraryClientFilter, distinctValues(state.library, 'client'), '全部客戶');
    const client = ui.libraryClientFilter.value;
    const projectSource = state.library.filter((item) => !client || item.client === client);
    fillSelectOptions(ui.libraryProjectFilter, distinctValues(projectSource, 'project'), '全部專案');
    state.libraryFilter.client = ui.libraryClientFilter.value;
    state.libraryFilter.project = ui.libraryProjectFilter.value;
  }

  function renderLibrary() {
    ui.libraryGrid.innerHTML = '';
    renderLibraryFilters();
    renderProjectOptions();
    const { client, project } = state.libraryFilter;
    const visibleItems = state.library.filter((item) => (
      (!client || item.client === client) && (!project || item.project === project)
    ));
    ui.libraryEmpty.hidden = visibleItems.length > 0;
    ui.libraryEmpty.textContent = state.library.length
      ? '沒有符合篩選條件的影片。'
      : '尚未找到影片。先生成一段影片，或重新選擇已有產出的本機資料夾。';

    visibleItems.forEach((item) => {
      const fragment = ui.cardTemplate.content.cloneNode(true);
      const card = fragment.querySelector('.video-card');
      const video = fragment.querySelector('video');
      const title = fragment.querySelector('h3');
      const subtitle = fragment.querySelector('.video-subtitle');
      const stats = fragment.querySelector('.stats');
      const summary = fragment.querySelector('.summary');
      const startInput = fragment.querySelector('[data-role="clip-start"]');
      const endInput = fragment.querySelector('[data-role="clip-end"]');

      card.dataset.itemId = item.id;
      card.dataset.fileName = item.fileName;
      video.src = item.previewUrl ?? '';
      title.textContent = item.fileName;
      subtitle.textContent = `${item.moduleName} ・ ${new Date(item.createdAt).toLocaleString('zh-TW')}`;
      summary.textContent = item.story || item.prompt || '由照片與風格模組共同生成。';
      endInput.value = String(item.duration);
      endInput.max = String(item.duration);
      startInput.max = String(Math.max(item.duration - 0.1, 0.1));

      [
        ['長度', `${item.duration}s`],
        ['畫質', item.quality],
        ['解析度', item.resolution],
        ['來源', item.sourceImageDataUrl ? '照片 + 提示詞' : '純文字描述'],
        ...(Number.isSafeInteger(item.seed) ? [['Seed', String(item.seed)]] : []),
        ...(item.client || item.project ? [['客戶／專案', [item.client, item.project].filter(Boolean).join(' / ')]] : []),
      ].forEach(([label, value]) => {
        const wrapper = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        wrapper.append(dt, dd);
        stats.append(wrapper);
      });

      card.querySelector('[data-action="download"]').addEventListener('click', () => downloadItem(item));
      card.querySelector('[data-action="rename"]').addEventListener('click', () => renameItem(item));
      card.querySelector('[data-action="clip"]').addEventListener('click', () => clipItem(item, Number(startInput.value), Number(endInput.value)));
      card.querySelector('[data-action="regenerate"]').addEventListener('click', () => regenerateItem(item));
      card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteItem(item));

      ui.libraryGrid.append(fragment);
    });
  }

  async function generateVideoBlob(spec) {
    const moduleDefinition = getModuleById(spec.moduleId);
    const image = await loadImage(spec.sourceImageDataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = spec.width;
    canvas.height = spec.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    const stream = canvas.captureStream(spec.fps);
    const mimeType = getSupportedMimeType();
    const chunks = [];
    const recorder = new MediaRecorder(stream, mimeType ? {
      mimeType,
      videoBitsPerSecond: qualityBitrates[spec.quality] ?? qualityBitrates.balanced,
    } : {
      videoBitsPerSecond: qualityBitrates[spec.quality] ?? qualityBitrates.balanced,
    });

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const done = new Promise((resolve, reject) => {
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' })), { once: true });
      recorder.addEventListener('error', (event) => reject(event.error || new Error('影片錄製失敗')), { once: true });
    });

    try {
      recorder.start();
      const totalFrames = Math.max(1, Math.round(spec.duration * spec.fps));
      const frameDuration = 1000 / spec.fps;
      for (let frame = 0; frame < totalFrames; frame += 1) {
        const progress = frame / Math.max(totalFrames - 1, 1);
        moduleDefinition.renderFrame({
          ctx,
          canvas,
          progress,
          image,
          spec,
          fitImage,
          drawCaptionBlock,
        });
        await wait(frameDuration);
      }
      recorder.stop();
      return await done;
    } catch (error) {
      if (recorder.state !== 'inactive') {
        recorder.stop();
        await done.catch(() => undefined);
      }
      throw error;
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  }

  async function createAndStoreVideo(spec, suffix = '') {
    const moduleDefinition = getModuleById(spec.moduleId);
    setGeneratingState(true);
    setStatus(`正在使用 ${moduleDefinition.name} 生成影片…`);
    try {
      const blob = await generateVideoBlob(spec);
      const item = {
        ...spec,
        blob,
        fileName: makeFileName(spec, suffix),
        moduleName: moduleDefinition.name,
      };
      await saveAssetSet(item);
      if (state.backend.available) {
        await listFolderItems();
      } else if (!state.folderHandle) {
        state.library = [{ ...stripTransientFields(item), previewUrl: item.previewUrl }, ...state.library];
      } else {
        await listFolderItems();
      }
      serializeLibrary();
      renderLibrary();
      setStatus(`影片已完成：${item.fileName}`);
      return item;
    } finally {
      setGeneratingState(false);
    }
  }

  async function generateFromForm() {
    if (state.generating) return;
    try {
      const file = ui.imageInput.files?.[0] ?? null;
      const sourceImageDataUrl = await readFileAsDataUrl(file);
      const spec = gatherSpec({ sourceImageDataUrl });

      if (!spec.prompt && !spec.story) {
        setStatus('請至少輸入提示詞或影片描述。');
        return;
      }

      await createAndStoreVideo(spec);
    } catch (error) {
      console.error(error);
      setStatus(`生成失敗：${error.message}`);
    }
  }

  async function pickFolder() {
    if (!('showDirectoryPicker' in window)) {
      setStatus('此瀏覽器不支援直接指定資料夾，將改用下載模式。');
      return;
    }

    try {
      state.backend.available = false;
      state.backend.outputDir = '';
      state.folderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      syncStorageUi();
      renderInferenceRuntime();
      ui.setupModelBatchButton.disabled = true;
      await listFolderItems();
      renderLibrary();
      setStatus(`已連線到資料夾：${state.folderHandle.name}`);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error(error);
        setStatus('選擇資料夾失敗，請稍後再試。');
      }
    }
  }

  async function connectOutputDir() {
    try {
      const outputDir = ui.outputDirInput.value.trim();
      if (!outputDir) {
        setStatus('請先輸入後端輸出資料夾絕對路徑。');
        return;
      }

      const payload = await fetchJson('/api/config/output-dir', {
        method: 'POST',
        body: JSON.stringify({ outputDir }),
      });

      state.backend.available = true;
      state.backend.outputDir = payload.outputDir;
      state.folderHandle = null;
      releasePreviewUrls(state.library);
      state.library = payload.items;
      state.inference.runtime = await fetchJson('/api/inference/runtime', { headers: {} });
      state.modelCatalog = await fetchJson('/api/models/catalog', { headers: {} });
      syncStorageUi();
      serializeLibrary();
      renderInferenceRuntime();
      renderModelCatalog();
      renderLibrary();
      setStatus(`已套用後端資料夾：${payload.outputDir}`);
    } catch (error) {
      console.error(error);
      setStatus(`設定後端資料夾失敗：${error.message}`);
    }
  }

  async function initBackend() {
    try {
      const payload = await fetchJson('/api/config', { headers: {} });
      state.backend.available = true;
      state.backend.outputDir = payload.outputDir;
      state.folderHandle = null;
      await listFolderItems();
      state.inference.runtime = await fetchJson('/api/inference/runtime', { headers: {} });
      state.modelCatalog = await fetchJson('/api/models/catalog', { headers: {} });
    } catch (error) {
      console.warn('Backend unavailable, falling back to browser mode.', error);
    } finally {
      syncStorageUi();
      renderInferenceRuntime();
      renderModelCatalog();
      await restoreActiveInferenceJob();
    }
  }

  function stopInferenceJobPolling() {
    if (state.inference.pollTimer) {
      window.clearInterval(state.inference.pollTimer);
      state.inference.pollTimer = null;
    }
    state.inference.pollingJobId = '';
    state.inference.pollInFlight = false;
  }

  function startInferenceJobPolling(job) {
    stopInferenceJobPolling();
    if (!job?.comfyPromptId) return;
    state.inference.pollingJobId = job.id;
    const refreshJob = async () => {
      if (state.inference.pollInFlight || state.inference.pollingJobId !== job.id) return;
      state.inference.pollInFlight = true;
      try {
        const updated = await fetchJson(`/api/inference/jobs/${encodeURIComponent(job.id)}`, { headers: {} });
        if (state.inference.pollingJobId !== job.id) return;
        state.inference.lastJob = updated;
        setInferenceStatus(`ComfyUI 工作：${updated.status}${updated.outputs?.length ? `；已匯入 ${updated.outputs.length} 部影片` : ''}`);
        ui.cancelInferenceButton.hidden = updated.status !== 'queued';
        if (['succeeded', 'failed', 'cancelled'].includes(updated.status)) {
          stopInferenceJobPolling();
          if (updated.status === 'succeeded') {
            await listFolderItems();
            renderLibrary();
          }
        }
      } catch (error) {
        setInferenceStatus(`查詢 ComfyUI 工作失敗：${error.message}`);
        stopInferenceJobPolling();
      } finally {
        state.inference.pollInFlight = false;
      }
    };
    refreshJob();
    state.inference.pollTimer = window.setInterval(refreshJob, 2_500);
  }

  async function restoreActiveInferenceJob() {
    if (!state.backend.available) return;
    try {
      const jobs = await fetchJson('/api/inference/jobs', { headers: {} });
      const activeJob = jobs.find((job) => (
        job.comfyPromptId && ['queued', 'running'].includes(job.status)
      ));
      if (!activeJob) return;
      state.inference.lastJob = activeJob;
      setInferenceStatus(`恢復追蹤 ComfyUI 工作：${activeJob.id}（${activeJob.status}）`);
      ui.cancelInferenceButton.hidden = activeJob.status !== 'queued';
      startInferenceJobPolling(activeJob);
    } catch (error) {
      console.warn('Unable to restore active inference job.', error);
    }
  }

  function syncSeedInput() {
    const fixed = ui.seedModeInput.value === 'fixed';
    ui.seedInput.disabled = !fixed;
    ui.seedInput.placeholder = fixed ? '輸入 0 以上的整數' : '隨機產生';
    if (fixed && !ui.seedInput.value && Number.isSafeInteger(state.inference.lastJob?.seed)) {
      ui.seedInput.value = String(state.inference.lastJob.seed);
    }
  }

  function readSeedSetting() {
    if (ui.seedModeInput.value !== 'fixed') return undefined;
    const value = ui.seedInput.value.trim();
    const seed = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(seed)) {
      throw new Error('固定 seed 必須是 0 以上的整數。');
    }
    return seed;
  }

  function describeInferenceJob(job) {
    const warnings = job.warnings?.length ? `；注意：${job.warnings.join(' ')}` : '';
    return `${job.id}（${job.status}${Number.isSafeInteger(job.seed) ? `，seed ${job.seed}` : ''}）${warnings}`;
  }

  function setPresetStatus(message) {
    ui.presetStatus.textContent = message;
  }

  function getSelectedPreset() {
    return state.presets.find((preset) => preset.id === ui.presetSelect.value) || null;
  }

  function describePreset(preset) {
    const scope = [preset.client, preset.project].filter(Boolean).join(' / ');
    return scope ? `${scope}｜${preset.name}` : preset.name;
  }

  function syncPresetUi() {
    const hasBackend = state.backend.available;
    const preset = getSelectedPreset();
    [ui.savePresetButton, ui.exportPresetsButton, ui.importPresetsButton].forEach((button) => {
      button.disabled = !hasBackend;
    });
    [ui.applyPresetButton, ui.updatePresetButton, ui.deletePresetButton].forEach((button) => {
      button.disabled = !hasBackend || !preset;
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

  function renderPresetVariables(preset) {
    const variables = preset?.variables ?? [];
    const previousValues = Object.fromEntries(
      [...ui.presetVariables.querySelectorAll('input')].map((input) => [input.dataset.variable, input.value]),
    );
    ui.presetVariables.replaceChildren(...variables.map((name) => {
      const label = document.createElement('label');
      label.textContent = `變數 {${name}}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 1000;
      input.dataset.variable = name;
      input.value = previousValues[name] ?? '';
      label.append(input);
      return label;
    }));
    ui.presetVariables.hidden = variables.length === 0;
  }

  function fillTemplate(template, values) {
    return String(template || '').replace(/(?<!\{)\{([\p{L}\p{N}_]{1,40})\}(?!\})/gu, (token, name) => (
      values[name] ? values[name] : token
    ));
  }

  async function loadPresets() {
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

  function setSelectValue(select, value) {
    if (value && [...select.options].some((option) => option.value === value)) {
      select.value = value;
      return true;
    }
    return false;
  }

  function applySelectedPreset() {
    const preset = getSelectedPreset();
    if (!preset) return;
    const values = Object.fromEntries(
      [...ui.presetVariables.querySelectorAll('input')].map((input) => [input.dataset.variable, input.value.trim()]),
    );
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

  async function savePreset() {
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

  async function updatePreset() {
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

  async function deletePreset() {
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

  async function exportPresets() {
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

  async function importPresets() {
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

  async function rerunInferenceJob(jobId) {
    if (!state.backend.available) {
      throw new Error('目前未連線到本機後端，無法重新產出 ComfyUI 影片。');
    }
    const job = await fetchJson(`/api/inference/jobs/${encodeURIComponent(jobId)}/rerun`, { method: 'POST' });
    state.inference.lastJob = job;
    setInferenceStatus(`已以相同設定重新提交：${describeInferenceJob(job)}`);
    ui.cancelInferenceButton.hidden = job.status !== 'queued';
    startInferenceJobPolling(job);
    return job;
  }

  async function queueInferenceJob() {
    try {
      if (!state.backend.available) {
        setInferenceStatus('目前未連線到本機後端，無法建立推論工作。');
        return;
      }

      const file = ui.imageInput.files?.[0] ?? null;
      const sourceImageDataUrl = await readFileAsDataUrl(file);
      const spec = gatherSpec({ sourceImageDataUrl });
      if (!spec.prompt && !spec.story) {
        setInferenceStatus('請至少輸入提示詞或影片描述，再建立推論工作。');
        return;
      }
      const seed = readSeedSetting();

      ui.workflowCheckButton.disabled = true;
      const workflowCheck = await fetchJson('/api/inference/workflow-check', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: ui.workflowSelect.value,
          videoModelId: ui.videoModelSelect.value,
          hasSourceImage: Boolean(file),
        }),
      });
      renderWorkflowCheck(workflowCheck);
      ui.workflowCheckButton.disabled = false;
      if (!workflowCheck.ready) {
        setInferenceStatus(`工作流預檢未通過：${workflowCheck.errors.join(' ')}`);
        return;
      }

      const job = await fetchJson('/api/inference/jobs', {
        method: 'POST',
        body: JSON.stringify({
          prompt: spec.prompt,
          story: spec.story,
          negativePrompt: ui.negativePromptInput.value.trim(),
          seed,
          client: spec.client,
          project: spec.project,
          presetId: spec.presetId,
          workflowId: ui.workflowSelect.value,
          moduleId: spec.moduleId,
          videoModelId: ui.videoModelSelect.value,
          sourceImageDataUrl: spec.sourceImageDataUrl,
          settings: {
            duration: spec.duration,
            fps: spec.fps,
            resolution: spec.resolution,
            quality: spec.quality,
            motion: spec.motion,
            captionStrength: spec.captionStrength,
          },
        }),
      });

      state.inference.lastJob = job;
      setInferenceStatus(`已建立本機推論工作：${describeInferenceJob(job)}`);
      ui.cancelInferenceButton.hidden = !job.comfyPromptId || job.status !== 'queued';
      if (job.comfyPromptId) startInferenceJobPolling(job);
    } catch (error) {
      ui.workflowCheckButton.disabled = false;
      ui.cancelInferenceButton.hidden = true;
      console.error(error);
      setInferenceStatus(`建立推論工作失敗：${error.message}`);
    }
  }

  function renderWorkflowCheck(report) {
    const details = [
      `預檢：${report.ready ? '通過' : '未通過'}`,
      `節點：${report.nodeCount}`,
      `模型：${report.selectedModelId}`,
      ...report.errors.map((message) => `錯誤：${message}`),
      ...report.warnings.map((message) => `注意：${message}`),
    ];
    ui.workflowCheckStatus.textContent = details.join(' ');
  }

  async function checkComfyWorkflow() {
    ui.workflowCheckButton.disabled = true;
    ui.workflowCheckStatus.textContent = '正在檢查本機 API 工作流…';
    try {
      const report = await fetchJson('/api/inference/workflow-check', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: ui.workflowSelect.value,
          videoModelId: ui.videoModelSelect.value,
          hasSourceImage: Boolean(ui.imageInput.files?.[0]),
        }),
      });
      renderWorkflowCheck(report);
    } catch (error) {
      ui.workflowCheckStatus.textContent = `工作流檢查失敗：${error.message}`;
    } finally {
      ui.workflowCheckButton.disabled = false;
    }
  }

  async function cancelInferenceJob() {
    const job = state.inference.lastJob;
    if (!job?.id || !job.comfyPromptId) return;
    ui.cancelInferenceButton.disabled = true;
    try {
      const cancelled = await fetchJson(`/api/inference/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      state.inference.lastJob = cancelled;
      ui.cancelInferenceButton.hidden = true;
      setInferenceStatus(`已取消待執行工作：${cancelled.id}`);
      stopInferenceJobPolling();
    } catch (error) {
      setInferenceStatus(`取消工作失敗：${error.message}`);
    } finally {
      ui.cancelInferenceButton.disabled = false;
    }
  }

  async function setupModelBatch() {
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

  async function refreshLibrary() {
    try {
      if (state.backend.available || state.folderHandle) {
        await listFolderItems();
      }
      renderLibrary();
      setStatus('已重新整理影片清單。');
    } catch (error) {
      console.error(error);
      setStatus(`重新整理失敗：${error.message}`);
    }
  }

  async function getItemBlob(item) {
    if (state.backend.available) {
      const response = await fetch(`/api/videos/${encodeURIComponent(item.fileName)}`);
      if (!response.ok) {
        throw new Error(`讀取影片失敗：${response.status}`);
      }
      return response.blob();
    }
    if (state.folderHandle) {
      const fileHandle = await state.folderHandle.getFileHandle(item.fileName);
      return fileHandle.getFile();
    }
    if (item.previewUrl) {
      const response = await fetch(item.previewUrl);
      return response.blob();
    }
    throw new Error('找不到影片檔案，請重新選擇資料夾。');
  }

  async function downloadItem(item) {
    try {
      const link = document.createElement('a');
      if (state.backend.available) {
        link.href = `/api/videos/${encodeURIComponent(item.fileName)}?download=1`;
      } else {
        const blob = await getItemBlob(item);
        const url = URL.createObjectURL(blob);
        link.href = url;
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
      link.download = item.fileName;
      link.click();
    } catch (error) {
      console.error(error);
      setStatus(`下載失敗：${error.message}`);
    }
  }

  async function renameItem(item) {
    try {
      const requested = window.prompt('請輸入新的檔名', item.fileName.replace(/\.webm$/u, ''));
      if (!requested) return;
      const normalizedName = requested.trim().replace(/\.webm$/u, '');
      if (!normalizedName) {
        setStatus('請輸入有效的檔名。');
        return;
      }
      const nextFileName = `${normalizedName}.webm`;
      const updated = {
        ...item,
        fileName: nextFileName,
      };

      if (nextFileName === item.fileName) {
        setStatus(`檔名沒有變更：${nextFileName}`);
        return;
      }

      if (state.backend.available) {
        await fetchJson(`/api/videos/${encodeURIComponent(item.fileName)}`, {
          method: 'PATCH',
          body: JSON.stringify({ nextFileName }),
        });
        await listFolderItems();
        renderLibrary();
        setStatus(`已重新命名為 ${nextFileName}`);
        return;
      }

      if (state.folderHandle) {
        try {
          await state.folderHandle.getFileHandle(nextFileName);
          setStatus(`重新命名失敗：${nextFileName} 已存在。`);
          return;
        } catch (error) {
          if (error?.name !== 'NotFoundError') {
            throw error;
          }
        }
        const blob = await getItemBlob(item);
        await writeFile(await state.folderHandle.getFileHandle(nextFileName, { create: true }), blob);
        await writeFile(await state.folderHandle.getFileHandle(`${nextFileName}.json`, { create: true }), new Blob([JSON.stringify(stripTransientFields(updated), null, 2)], { type: 'application/json' }));
        await state.folderHandle.removeEntry(item.fileName);
        await state.folderHandle.removeEntry(`${item.fileName}.json`);
        await listFolderItems();
        renderLibrary();
        setStatus(`已重新命名為 ${nextFileName}`);
        return;
      }

      state.library = state.library.map((entry) => (entry.id === item.id ? { ...updated, previewUrl: entry.previewUrl } : entry));
      serializeLibrary();
      renderLibrary();
      setStatus(
        item.storageOrigin === 'temporary'
          ? `已重新命名為 ${nextFileName}（瀏覽器暫存模式下重新整理後會清空）`
          : `已重新命名為 ${nextFileName}`,
      );
    } catch (error) {
      console.error(error);
      setStatus(`重新命名失敗：${error.message}`);
    }
  }

  async function deleteItem(item) {
    try {
      if (!window.confirm(`確定刪除 ${item.fileName} 嗎？`)) return;

      if (state.backend.available) {
        await fetchJson(`/api/videos/${encodeURIComponent(item.fileName)}`, {
          method: 'DELETE',
        });
        await listFolderItems();
      } else if (state.folderHandle) {
        await state.folderHandle.removeEntry(item.fileName);
        await state.folderHandle.removeEntry(`${item.fileName}.json`);
        await listFolderItems();
      } else {
        releasePreviewUrls([item]);
        state.library = state.library.filter((entry) => entry.id !== item.id);
      }

      serializeLibrary();
      renderLibrary();
      setStatus(`已刪除 ${item.fileName}`);
    } catch (error) {
      console.error(error);
      setStatus(`刪除失敗：${error.message}`);
    }
  }

  async function trimBlob(blob, item, startTime, endTime) {
    const video = document.createElement('video');
    const videoUrl = URL.createObjectURL(blob);
    let stream;
    let recorder;
    let done;
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    try {
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('載入剪輯來源影片失敗。')), { once: true });
      });

      const safeStart = Math.max(0, Math.min(startTime, video.duration - 0.1));
      const safeEnd = Math.max(safeStart + 0.2, Math.min(endTime, video.duration));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || item.width;
      canvas.height = video.videoHeight || item.height;
      const ctx = canvas.getContext('2d');
      stream = canvas.captureStream(item.fps);
      const mimeType = getSupportedMimeType();
      const chunks = [];
      recorder = new MediaRecorder(stream, mimeType ? {
        mimeType,
        videoBitsPerSecond: qualityBitrates[item.quality] ?? qualityBitrates.balanced,
      } : {
        videoBitsPerSecond: qualityBitrates[item.quality] ?? qualityBitrates.balanced,
      });

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });

      done = new Promise((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' })), { once: true });
        recorder.addEventListener('error', (event) => reject(event.error || new Error('影片剪輯失敗。')), { once: true });
      });

      recorder.start();
      video.currentTime = safeStart;
      await new Promise((resolve, reject) => {
        video.addEventListener('seeked', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('定位剪輯起點失敗。')), { once: true });
      });

      await video.play().catch(() => undefined);
      while (video.currentTime < safeEnd) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        await wait(1000 / item.fps);
      }

      video.pause();
      recorder.stop();
      return {
        blob: await done,
        duration: Number((safeEnd - safeStart).toFixed(1)),
      };
    } catch (error) {
      if (recorder?.state !== 'inactive') {
        recorder.stop();
        await done?.catch(() => undefined);
      }
      throw error;
    } finally {
      video.pause();
      stream?.getTracks().forEach((track) => track.stop());
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(videoUrl);
    }
  }

  async function clipItem(item, startTime, endTime) {
    try {
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
        setStatus('剪輯設定無效，請確認起點與終點秒數。');
        return;
      }

      setStatus(`正在剪輯 ${item.fileName}…`);
      const sourceBlob = await getItemBlob(item);
      const trimmed = await trimBlob(sourceBlob, item, startTime, endTime);
      const cloned = {
        ...item,
        id: crypto.randomUUID(),
        duration: trimmed.duration,
        createdAt: new Date().toISOString(),
        blob: trimmed.blob,
        fileName: makeFileName(item, '-clip'),
        story: `${item.story || item.prompt || '影片'}（${startTime}s - ${endTime}s 剪輯版）`,
      };
      await saveAssetSet(cloned);
      if (state.backend.available || state.folderHandle) {
        await listFolderItems();
      } else {
        state.library.unshift({ ...stripTransientFields(cloned), previewUrl: cloned.previewUrl });
        serializeLibrary();
      }
      renderLibrary();
      setStatus(`已輸出剪輯版本：${cloned.fileName}`);
    } catch (error) {
      console.error(error);
      setStatus(`剪輯失敗：${error.message}`);
    }
  }

  async function regenerateItem(item) {
    try {
      if (item.inferenceJobId) {
        setStatus(`正在以 ${item.fileName} 的工作流快照與 seed 重新提交 ComfyUI…`);
        await rerunInferenceJob(item.inferenceJobId);
        setStatus(`已重新提交 ComfyUI 工作，完成後會匯入影片庫。`);
        return;
      }
      setStatus(`正在依照 ${item.fileName} 的設定重新產出…`);
      const cloneSpec = {
        ...item,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await createAndStoreVideo(cloneSpec, '-rerender');
    } catch (error) {
      console.error(error);
      setStatus(`重新產出失敗：${error.message}`);
    }
  }

  function getLibrarySnapshot() {
    return state.library.map((item) => ({ ...item }));
  }

  async function renderReferenceFrame(item, timestamp = item.duration / 2) {
    const moduleDefinition = getModuleById(item.moduleId);
    if (!moduleDefinition) {
      throw new Error(`找不到模組：${item.moduleId}`);
    }

    const image = await loadImage(item.sourceImageDataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = item.width;
    canvas.height = item.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    const safeTimestamp = Math.max(0, Math.min(timestamp, item.duration || timestamp));
    const progress = item.duration > 0 ? safeTimestamp / item.duration : 0;

    moduleDefinition.renderFrame({
      ctx,
      canvas,
      progress,
      image,
      spec: item,
      fitImage,
      drawCaptionBlock,
    });

    return canvas.toDataURL('image/png');
  }

  function restoreStoredLibraryPreview() {
    state.library = state.library.map((item) => ({
      ...item,
      previewUrl: `/api/videos/${encodeURIComponent(item.fileName)}?t=${Date.now()}`,
    }));
  }

  function attachEvents() {
    ui.moduleSelect.addEventListener('change', renderModuleDetails);
    ui.generationForm.addEventListener('submit', (event) => {
      event.preventDefault();
      generateFromForm();
    });
    ui.connectOutputDirButton.addEventListener('click', connectOutputDir);
    ui.pickFolderButton.addEventListener('click', pickFolder);
    ui.refreshButton.addEventListener('click', refreshLibrary);
    ui.queueInferenceButton.addEventListener('click', queueInferenceJob);
    ui.cancelInferenceButton.addEventListener('click', cancelInferenceJob);
    ui.workflowCheckButton.addEventListener('click', checkComfyWorkflow);
    ui.setupModelBatchButton.addEventListener('click', setupModelBatch);
    ui.seedModeInput.addEventListener('change', syncSeedInput);
    ui.workflowSelect.addEventListener('change', selectWorkflow);
    ui.resolutionInput.addEventListener('change', syncCustomResolutionFields);
    ui.presetSelect.addEventListener('change', () => {
      if (!ui.presetSelect.value) state.activePresetId = '';
      syncPresetUi();
    });
    ui.applyPresetButton.addEventListener('click', applySelectedPreset);
    ui.savePresetButton.addEventListener('click', savePreset);
    ui.updatePresetButton.addEventListener('click', updatePreset);
    ui.deletePresetButton.addEventListener('click', deletePreset);
    ui.exportPresetsButton.addEventListener('click', exportPresets);
    ui.importPresetsButton.addEventListener('click', () => ui.importPresetsInput.click());
    ui.importPresetsInput.addEventListener('change', importPresets);
    ui.clientInput.addEventListener('change', renderProjectOptions);
    ui.libraryClientFilter.addEventListener('change', () => {
      state.libraryFilter.client = ui.libraryClientFilter.value;
      renderLibrary();
    });
    ui.libraryProjectFilter.addEventListener('change', () => {
      state.libraryFilter.project = ui.libraryProjectFilter.value;
      renderLibrary();
    });
  }

  async function initApp() {
    bindUi();
    renderCapabilities(Capabilities.BASE_CAPABILITIES);
    loadStoredLibrary();
    restoreStoredLibraryPreview();
    renderModuleOptions();
    attachEvents();
    await initBackend();
    await loadWorkflows();
    await loadPresets();
    syncStorageUi();
    renderLibrary();
  }

  window.VedioFactory = Object.assign(window.VedioFactory ?? {}, {
    registerModule,
    initApp,
    getModuleById,
    getLibrarySnapshot,
    renderReferenceFrame,
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof window.VedioFactory?.initApp === 'function') {
      window.VedioFactory.initApp().catch((error) => {
        console.error(error);
        setStatus(`初始化失敗：${error.message}`);
      });
    }
  });
})();
