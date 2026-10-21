(() => {
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
      // Settings snapshot taken before a model's recommended defaults were applied, restored when switching away.
      modelDefaults: null,
    },
    modelCatalog: null,
    // GET /api/inference/loras: file names ComfyUI offers plus metadata of known LoRAs.
    loras: null,
    dance: {
      // Blob URL of the selected photo preview; revoked whenever it is replaced.
      previewUrl: '',
      ready: false,
      starting: false,
    },
  };

  // Used only when an older backend's catalog lacks these fields; the /api/models/catalog values win.
  const VIDEO_MODEL_FALLBACKS = {
    'wan-2.2-ti2v-5b': {
      recommendedMaxFrames: 121,
      recommendedSettings: { resolution: '1280x704', duration: 5, fps: 24, quality: 'balanced' },
      timingHint: '實測 RTX 5070 Ti：1280×704、5 秒、平衡品質約需 5 分鐘；832×480、2 秒約 30 秒，適合快速試跑。',
    },
  };

  // 「照片 → 跳舞影片」preset (two-stage pipeline, OPTIMIZATION_PLAN 6.6/6.9).
  // The stage-1 workflow appends its own built-in dance prompt after {{prompt}}; this only names the subject.
  const DANCE_DEFAULT_PROMPT = 'The person from the photo dances happily.';
  const DANCE_DEFAULT_DURATION = 12;
  const DANCE_DEFAULT_RESOLUTION = '544x960';
  // Measured on this machine (RTX 5070 Ti 16GB, 544x960, 12 s): stage 1 about 7 min, stage 2 about 29 min.
  const DANCE_BASE_ESTIMATE = { pixels: 544 * 960, duration: 12, stage1Minutes: 7, stage2Minutes: 29 };
  const DANCE_RISKY_RESOLUTIONS = ['704x1280'];
  const JOB_STATUS_TEXT = {
    queued: '排隊等待中',
    running: '產生中',
    cooling: '顯示卡降溫中，會自動繼續',
    succeeded: '已完成',
    failed: '失敗',
    cancelled: '已取消',
  };
  const STAGE_STATUS_TEXT = {
    waiting: '尚未開始',
    pending: '準備中',
    queued: '排隊等待中',
    running: '產生中',
    cooling: '顯示卡降溫中',
    succeeded: '完成',
    failed: '失敗',
    cancelled: '已取消',
  };
  const STAGE_TITLES = {
    1: '第一階段：產生舞蹈動作',
    2: '第二階段：保持本人臉孔',
  };
  const ACTIVE_JOB_STATUSES = ['queued', 'running', 'cooling'];
  const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'];

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
    ui.videoModelHint = document.querySelector('#videoModelHint');
    ui.frameLimitWarning = document.querySelector('#frameLimitWarning');
    ui.applyModelDefaultsButton = document.querySelector('#applyModelDefaultsButton');
    ui.loraSelect = document.querySelector('#loraSelect');
    ui.loraStrengthInput = document.querySelector('#loraStrengthInput');
    ui.loraHint = document.querySelector('#loraHint');
    ui.modelCatalogStatus = document.querySelector('#modelCatalogStatus');
    ui.setupModelBatchButton = document.querySelector('#setupModelBatchButton');
    ui.cardTemplate = document.querySelector('#videoCardTemplate');
    ui.danceSection = document.querySelector('#danceSection');
    ui.danceImageInput = document.querySelector('#danceImageInput');
    ui.danceImagePreview = document.querySelector('#danceImagePreview');
    ui.danceDurationSelect = document.querySelector('#danceDurationSelect');
    ui.danceDurationHint = document.querySelector('#danceDurationHint');
    ui.danceResolutionSelect = document.querySelector('#danceResolutionSelect');
    ui.danceResolutionWarning = document.querySelector('#danceResolutionWarning');
    ui.danceReferenceStrengthInput = document.querySelector('#danceReferenceStrengthInput');
    ui.danceReferenceStrengthHint = document.querySelector('#danceReferenceStrengthHint');
    ui.dancePromptInput = document.querySelector('#dancePromptInput');
    ui.danceEstimate = document.querySelector('#danceEstimate');
    ui.danceSetupStatus = document.querySelector('#danceSetupStatus');
    ui.danceGuardWarning = document.querySelector('#danceGuardWarning');
    ui.danceStartButton = document.querySelector('#danceStartButton');
    ui.danceStatus = document.querySelector('#danceStatus');
    ui.pipelineProgress = document.querySelector('#pipelineProgress');
    ui.danceCancelButton = document.querySelector('#danceCancelButton');
    ui.librarySection = document.querySelector('#librarySection');
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
      renderDancePreset();
      return;
    }

    ui.gpuStatus.textContent = runtime.gpu?.detected ? '已偵測 NVIDIA' : '待設定';
    ui.queueInferenceButton.disabled = !state.backend.available;

    const lines = [
      `平台：${runtime.platform}`,
      `GPU：${runtime.gpu?.detected ? `${runtime.gpu.name || 'NVIDIA'} / ${runtime.gpu.memoryTotal || '未知 VRAM'}` : '尚未偵測到 nvidia-smi'}`,
      `模型目錄：${runtime.modelDir}`,
      `ComfyUI：${runtime.comfyUI?.available ? `已連線 (${runtime.comfyUI.url})` : `未連線 (${runtime.comfyUI?.error || runtime.comfyUI?.url || '未設定'})`}`,
      `API 工作流：${runtime.comfyUI?.workflowConfigured ? runtime.comfyUI.workflowPath : '尚未設定 VEDIO_FACTORY_COMFYUI_WORKFLOW'}`,
      `方向：${runtime.provider}`,
    ];
    const pipeline = runtime.comfyUI?.pipeline;
    if (pipeline) {
      lines.push(pipeline.enabled
        ? '照片 → 跳舞影片（兩階段）：已啟用'
        : `照片 → 跳舞影片（兩階段）：設定有問題（${localizeServerText(pipeline.error || '未知原因')}）`);
    }

    const list = document.createElement('ul');
    lines.forEach((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      list.append(item);
    });
    ui.inferenceRuntime.append(list);
    renderDancePreset();
  }

  // Server messages are Chinese but still carry a few hardware terms; the user reads no English.
  function localizeServerText(value) {
    return String(value ?? '')
      .replace(/GPU is lost/giu, '顯示卡斷線')
      // Drop the space a Chinese sentence puts around the Latin word: 「等待 GPU 冷卻」→「等待顯示卡冷卻」.
      .replace(/([㐀-鿿（，：；、]) GPU\b/gu, '$1GPU')
      .replace(/\bGPU ?(?=[㐀-鿿])/gu, '顯示卡')
      .replace(/\bGPU\b/gu, '顯示卡')
      .replace(/\bVRAM\b/gu, '顯示記憶體');
  }

  function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function formatDurationText(totalSeconds) {
    const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分鐘`;
  }

  function finiteNumber(value) {
    const number = Number(value);
    return value !== null && value !== '' && Number.isFinite(number) ? number : null;
  }

  function getPipelineInfo() {
    return state.inference.runtime?.comfyUI?.pipeline ?? null;
  }

  // { fps, seconds[] } from the server's allowedDurationSecondsByFps (24 fps preferred), or null.
  function getDanceDurationRange(pipeline) {
    const ranges = pipeline?.allowedDurationSecondsByFps;
    if (!ranges || typeof ranges !== 'object') return null;
    const usable = (fps) => Array.isArray(ranges[fps]?.seconds) && ranges[fps].seconds.some(Number.isInteger);
    const fpsKey = usable('24') ? '24' : Object.keys(ranges).find(usable);
    if (!fpsKey) return null;
    return { fps: Number(fpsKey), seconds: ranges[fpsKey].seconds.filter(Number.isInteger) };
  }

  function renderDancePreset() {
    const pipeline = getPipelineInfo();
    const visible = Boolean(state.backend.available && pipeline && (pipeline.enabled || pipeline.error));
    ui.danceSection.hidden = !visible;
    if (!visible) {
      state.dance.ready = false;
      return;
    }

    const problems = [];
    if (pipeline.error) problems.push(`兩階段流程設定有問題：${localizeServerText(pipeline.error)}`);
    const range = pipeline.error ? null : getDanceDurationRange(pipeline);
    if (!pipeline.error && !range) problems.push('目前的工作流設定沒有可用的影片長度，請檢查兩個工作流設定。');

    const previous = Number(ui.danceDurationSelect.value);
    ui.danceDurationSelect.replaceChildren();
    const seconds = range?.seconds ?? [];
    seconds.forEach((value) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value} 秒`;
      ui.danceDurationSelect.append(option);
    });
    if (seconds.length) {
      const preferred = seconds.includes(previous) ? previous
        : seconds.includes(DANCE_DEFAULT_DURATION) ? DANCE_DEFAULT_DURATION
          : seconds.reduce((best, value) => (
            Math.abs(value - DANCE_DEFAULT_DURATION) < Math.abs(best - DANCE_DEFAULT_DURATION) ? value : best
          ), seconds[0]);
      ui.danceDurationSelect.value = String(preferred);
    }
    ui.danceDurationSelect.dataset.fps = String(range?.fps ?? 24);
    ui.danceDurationSelect.disabled = !seconds.length;
    ui.danceDurationHint.textContent = seconds.length
      ? `目前設定可選 ${seconds[0]}–${seconds[seconds.length - 1]} 秒（每秒 ${range.fps} 張畫面）。`
      : '目前沒有可選的影片長度。';

    const strength = pipeline.referenceStrength || {};
    const min = finiteNumber(strength.min) ?? 0.5;
    const max = finiteNumber(strength.max) ?? 2;
    const defaultStrength = finiteNumber(strength.default) ?? 1.3;
    ui.danceReferenceStrengthInput.min = String(min);
    ui.danceReferenceStrengthInput.max = String(max);
    ui.danceReferenceStrengthInput.dataset.default = String(defaultStrength);
    if (ui.danceReferenceStrengthInput.value.trim() === '') {
      ui.danceReferenceStrengthInput.value = String(defaultStrength);
    }
    ui.danceReferenceStrengthHint.textContent = `可設定 ${min}–${max}，預設 ${defaultStrength}。數值越高越像照片中的本人，但動作可能較不自然。`;

    const guardOff = pipeline.gpuGuard && pipeline.gpuGuard.enabled === false;
    ui.danceGuardWarning.textContent = guardOff
      ? '顯示卡保護目前已關閉，只適用於沒有顯示卡的測試環境；正式產生影片前請重新開啟。'
      : '';
    ui.danceGuardWarning.hidden = !guardOff;

    ui.danceSetupStatus.textContent = problems.join(' ');
    ui.danceSetupStatus.hidden = !problems.length;
    state.dance.ready = !problems.length;
    updateDanceResolutionWarning();
    updateDanceEstimate();
    syncDanceStartButton();
  }

  function updateDanceResolutionWarning() {
    const risky = DANCE_RISKY_RESOLUTIONS.includes(ui.danceResolutionSelect.value);
    ui.danceResolutionWarning.textContent = risky
      ? '注意：這個解析度可能超過顯示卡的 16 GB 顯示記憶體而失敗，花費時間也會長很多。建議使用 544 × 960。'
      : '';
    ui.danceResolutionWarning.hidden = !risky;
  }

  function updateDanceEstimate() {
    const resolution = ui.danceResolutionSelect.value || DANCE_DEFAULT_RESOLUTION;
    const { width, height } = resolutionToSize(resolution);
    const duration = Number(ui.danceDurationSelect.value) || DANCE_DEFAULT_DURATION;
    const scale = ((width * height) / DANCE_BASE_ESTIMATE.pixels) * (duration / DANCE_BASE_ESTIMATE.duration);
    const stage1 = Math.max(1, Math.round(DANCE_BASE_ESTIMATE.stage1Minutes * scale));
    const stage2 = Math.max(1, Math.round(DANCE_BASE_ESTIMATE.stage2Minutes * scale));
    const measured = resolution === DANCE_DEFAULT_RESOLUTION && duration === DANCE_BASE_ESTIMATE.duration;
    const coolingMinutes = finiteNumber(getPipelineInfo()?.gpuGuard?.coolingTimeoutMinutes);
    ui.danceEstimate.textContent = [
      `${measured ? '預估時間' : '粗估時間'}（這台電腦，${width} × ${height}、${duration} 秒）：`
        + `第一階段約 ${stage1} 分鐘＋第二階段約 ${stage2} 分鐘，合計約 ${stage1 + stage2} 分鐘。`,
      `兩個階段之間若顯示卡溫度偏高，會先降溫再自動繼續${coolingMinutes ? `（最多等待 ${coolingMinutes} 分鐘）` : ''}，時間會再拉長。`,
      '產生期間可以關閉或重新整理這個頁面，回來後會自動恢復顯示進度。',
    ].join('');
  }

  function hasActiveTrackedJob() {
    const job = state.inference.lastJob;
    return Boolean(job && !TERMINAL_JOB_STATUSES.includes(job.status) && state.inference.pollingJobId === job.id);
  }

  function syncDanceStartButton() {
    if (!ui.danceStartButton) return;
    const busy = state.dance.starting || hasActiveTrackedJob();
    ui.danceStartButton.disabled = !state.dance.ready || busy;
    ui.danceStartButton.textContent = state.dance.starting ? '正在送出…' : busy ? '已有工作進行中' : '開始產生跳舞影片';
  }

  function setDanceStatus(message) {
    ui.danceStatus.textContent = message;
  }

  function handleDanceImageChange() {
    if (state.dance.previewUrl) {
      URL.revokeObjectURL(state.dance.previewUrl);
      state.dance.previewUrl = '';
    }
    const file = ui.danceImageInput.files?.[0] ?? null;
    if (!file) {
      ui.danceImagePreview.removeAttribute('src');
      ui.danceImagePreview.hidden = true;
      return;
    }
    state.dance.previewUrl = URL.createObjectURL(file);
    ui.danceImagePreview.src = state.dance.previewUrl;
    ui.danceImagePreview.hidden = false;
  }

  function readDanceReferenceStrength() {
    const input = ui.danceReferenceStrengthInput;
    const raw = input.value.trim();
    const value = raw === '' ? Number(input.dataset.default || 1.3) : Number(raw);
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`本人相似度必須介於 ${min} 至 ${max}。`);
    }
    return value;
  }

  async function startDanceJob() {
    if (state.dance.starting) return;
    if (!state.backend.available) {
      setDanceStatus('目前沒有連線到本機服務，無法開始。');
      return;
    }
    if (hasActiveTrackedJob()) {
      setDanceStatus('已有工作正在進行，請等它完成或取消後再開始新的影片。');
      return;
    }
    const pipeline = getPipelineInfo();
    const file = ui.danceImageInput.files?.[0] ?? null;
    if (!file) {
      setDanceStatus('請先選擇一張全身照片。');
      return;
    }
    let referenceStrength;
    try {
      referenceStrength = readDanceReferenceStrength();
    } catch (error) {
      setDanceStatus(error.message);
      return;
    }
    const duration = Number(ui.danceDurationSelect.value);
    const fps = Number(ui.danceDurationSelect.dataset.fps) || 24;
    const resolution = ui.danceResolutionSelect.value || DANCE_DEFAULT_RESOLUTION;
    const videoModelId = pipeline?.videoModelId || 'wan-2.2-ti2v-5b';
    const settings = { duration, fps, resolution, quality: 'balanced', referenceStrength };

    state.dance.starting = true;
    syncDanceStartButton();
    try {
      setDanceStatus('正在檢查設定與顯示卡狀態…');
      const check = await fetchJson('/api/inference/workflow-check', {
        method: 'POST',
        body: JSON.stringify({ videoModelId, hasSourceImage: true, hasLora: false, referenceStrength, settings }),
      });
      if (!check.ready) {
        const errors = Array.isArray(check.errors) ? check.errors.map(localizeServerText) : [];
        setDanceStatus(`無法開始：${errors.join(' ') || '設定檢查未通過。'}`);
        return;
      }

      setDanceStatus('正在上傳照片並送出工作…');
      const sourceImageDataUrl = await readFileAsDataUrl(file);
      const prompt = ui.dancePromptInput.value.trim() || DANCE_DEFAULT_PROMPT;
      const job = await fetchJson('/api/inference/jobs', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          story: '',
          moduleId: ui.moduleSelect.value,
          videoModelId,
          sourceImageDataUrl,
          settings,
        }),
      });
      state.inference.lastJob = job;
      if (job.comfyPromptId) startInferenceJobPolling(job);
      renderJobStatus(job);
      setDanceStatus('已開始產生。完成後影片會自動加入下方「本機影片管理」。');
    } catch (error) {
      console.error(error);
      setDanceStatus(`無法開始：${localizeServerText(error.message)}`);
    } finally {
      state.dance.starting = false;
      syncDanceStartButton();
    }
  }

  function getCurrentPipelineStage(job) {
    const stages = job?.pipeline?.stages;
    if (!Array.isArray(stages)) return null;
    return stages[(Number(job.pipeline.currentStage) || 1) - 1] ?? null;
  }

  // Cancellable: queued / cooling, or a pipeline between stages. A stage already running is never interrupted (409).
  function isJobCancellable(job) {
    if (!job?.id || !job.comfyPromptId) return false;
    if (job.status === 'queued' || job.status === 'cooling') return true;
    const stage = getCurrentPipelineStage(job);
    return Boolean(job.pipeline && job.status === 'running' && stage && ['pending', 'waiting', 'cooling'].includes(stage.status));
  }

  function updateCancelButtons(job) {
    const cancellable = isJobCancellable(job);
    ui.cancelInferenceButton.hidden = !cancellable;
    ui.danceCancelButton.hidden = !(cancellable && job?.pipeline);
  }

  function describeStageDetails(stage) {
    const details = [];
    const executionSeconds = finiteNumber(stage.executionSeconds);
    if (executionSeconds !== null) {
      details.push(`產生耗時 ${formatDurationText(executionSeconds)}`);
    } else if (stage.status === 'running' && stage.startedAt && Number.isFinite(Date.parse(stage.startedAt))) {
      details.push(`已執行 ${formatDurationText((Date.now() - Date.parse(stage.startedAt)) / 1000)}`);
    }
    const coolingSeconds = finiteNumber(stage.coolingSeconds);
    if (coolingSeconds) details.push(`開始前降溫等待 ${formatDurationText(coolingSeconds)}`);
    const telemetry = stage.gpuTelemetry && typeof stage.gpuTelemetry === 'object' ? stage.gpuTelemetry : {};
    const maxTemp = finiteNumber(telemetry.maxTempC);
    if (maxTemp !== null) details.push(`顯示卡最高溫度 ${Math.round(maxTemp)}°C`);
    const maxPower = finiteNumber(telemetry.maxPowerW);
    if (maxPower !== null) details.push(`最高功耗 ${Math.round(maxPower)} 瓦`);
    const maxVram = finiteNumber(telemetry.maxVramMiB);
    if (maxVram !== null) details.push(`顯示記憶體最高用量 ${(maxVram / 1024).toFixed(1)} GB`);
    if (telemetry.tripped) details.push('曾觸發顯示卡保護');
    if (telemetry.gpuLost) details.push('顯示卡曾斷線');
    return details;
  }

  function renderPipelineProgress(job) {
    const container = ui.pipelineProgress;
    container.replaceChildren();
    if (!job?.pipeline) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.dataset.jobStatus = String(job.status ?? '');

    const headline = createTextElement('p', 'pipeline-headline', `目前狀態：${JOB_STATUS_TEXT[job.status] || localizeServerText(job.status)}`);
    if (job.stageLabel) {
      headline.append(createTextElement('span', 'pipeline-stage-label', `・${localizeServerText(job.stageLabel)}`));
    }
    container.append(headline);

    const list = createTextElement('ol', 'pipeline-stages');
    const stages = Array.isArray(job.pipeline.stages) ? job.pipeline.stages : [];
    stages.forEach((stage, position) => {
      const index = Number(stage?.index) || position + 1;
      const item = createTextElement('li', 'pipeline-stage');
      item.dataset.stageStatus = String(stage?.status ?? '');
      const head = createTextElement('div', 'pipeline-stage-head');
      head.append(
        createTextElement('strong', '', STAGE_TITLES[index] || localizeServerText(stage?.title) || `第 ${index} 階段`),
        createTextElement('span', 'stage-badge', STAGE_STATUS_TEXT[stage?.status] || localizeServerText(stage?.status)),
      );
      item.append(head);
      const details = stage ? describeStageDetails(stage) : [];
      if (details.length) item.append(createTextElement('p', 'hint', details.join('・')));
      list.append(item);
    });
    container.append(list);

    if (job.status === 'cooling') {
      const stage = getCurrentPipelineStage(job);
      const parts = ['顯示卡降溫中，會自動繼續，不需要任何操作。'];
      if (stage?.gpuWait) parts.push(`原因：${localizeServerText(stage.gpuWait)}。`);
      const startedMs = Date.parse(job.pipeline.coolingStartedAt ?? '');
      const timeout = finiteNumber(getPipelineInfo()?.gpuGuard?.coolingTimeoutMinutes);
      if (Number.isFinite(startedMs)) {
        parts.push(`已等待 ${formatDurationText((Date.now() - startedMs) / 1000)}${timeout ? `，最多等待 ${timeout} 分鐘` : ''}。`);
      }
      container.append(createTextElement('p', 'pipeline-cooling', parts.join('')));
    }
    if (job.status === 'failed') {
      container.append(createTextElement('p', 'pipeline-error', `失敗原因：${localizeServerText(job.error || '未知錯誤')}`));
    }
    if (TERMINAL_JOB_STATUSES.includes(job.status) && job.guidance) {
      container.append(createTextElement('p', 'hint', localizeServerText(job.guidance)));
    }
    if (job.status === 'succeeded') {
      const button = createTextElement('button', 'secondary', '查看完成的影片');
      button.type = 'button';
      button.addEventListener('click', () => ui.librarySection?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      container.append(button);
    }
  }

  function describeJobStatus(job) {
    if (job.pipeline) {
      return [
        `跳舞影片工作：${JOB_STATUS_TEXT[job.status] || localizeServerText(job.status)}`,
        job.stageLabel ? localizeServerText(job.stageLabel) : '',
        job.status === 'failed' ? localizeServerText(job.error) : '',
        TERMINAL_JOB_STATUSES.includes(job.status) ? localizeServerText(job.guidance) : '',
      ].filter(Boolean).join('；');
    }
    return [
      `ComfyUI 工作：${job.status}`,
      job.outputs?.length ? `已匯入 ${job.outputs.length} 部影片` : '',
      job.executionSeconds ? `耗時 ${job.executionSeconds} 秒` : '',
      job.status === 'failed' ? job.error : '',
      job.status === 'failed' || (job.status === 'succeeded' && !job.outputs?.length) ? job.guidance : '',
    ].filter(Boolean).join('；');
  }

  function renderJobStatus(job) {
    setInferenceStatus(describeJobStatus(job));
    renderPipelineProgress(job);
    updateCancelButtons(job);
    syncDanceStartButton();
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
    if (ui.videoModelSelect.value !== selectedModelId) {
      handleVideoModelChange();
    } else {
      updateVideoModelGuidance();
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

  function getSelectedVideoModel() {
    const model = state.modelCatalog?.videoModels?.find((entry) => entry.id === ui.videoModelSelect.value);
    return model ? { ...VIDEO_MODEL_FALLBACKS[model.id], ...model } : null;
  }

  // Mirrors server.js getWorkflowFrameCount: 4x temporal VAE models need 4n+1 frames.
  function getWorkflowFrameCount(duration, fps) {
    return Math.max(1, Math.floor((duration * fps) / 4) * 4 + 1);
  }

  function readGenerationSettings() {
    return {
      resolution: ui.resolutionInput.value || '1280x720',
      duration: Math.max(2, Number(ui.durationInput.value) || 6),
      fps: Math.max(12, Number(ui.fpsInput.value) || 24),
      quality: ui.qualityInput.value,
    };
  }

  function writeGenerationSettings(settings) {
    ui.resolutionInput.value = settings.resolution;
    ui.durationInput.value = String(settings.duration);
    ui.fpsInput.value = String(settings.fps);
    ui.qualityInput.value = settings.quality;
  }

  function isSameGenerationSettings(left, right) {
    return ['resolution', 'duration', 'fps', 'quality'].every((key) => String(left[key]) === String(right[key]));
  }

  // Returns a warning when duration x fps exceeds the model's frame cap (the backend rejects that with 400).
  function getFrameLimitProblem(model, duration, fps) {
    const maxFrames = Number(model?.recommendedMaxFrames);
    if (!maxFrames) return '';
    const frames = getWorkflowFrameCount(duration, fps);
    if (frames <= maxFrames) return '';
    let maxDuration = 0;
    for (let seconds = 2; seconds <= 30 && getWorkflowFrameCount(seconds, fps) <= maxFrames; seconds += 1) {
      maxDuration = seconds;
    }
    const allowed = maxDuration
      ? `${fps} fps 時片長最多 ${maxDuration} 秒`
      : `${fps} fps 沒有可用片長，請降低 FPS`;
    return `${model.name} 最多 ${maxFrames} 影格：${allowed}（目前 ${duration} 秒 × ${fps} fps = ${frames} 影格），送出本機推論會被拒絕。請在「3. 設定影片參數」調整長度或 FPS。`;
  }

  function updateVideoModelGuidance() {
    const model = getSelectedVideoModel();
    const hint = model?.timingHint || '';
    ui.videoModelHint.textContent = hint;
    ui.videoModelHint.hidden = !hint;
    const { duration, fps } = readGenerationSettings();
    const problem = getFrameLimitProblem(model, duration, fps);
    ui.frameLimitWarning.textContent = problem;
    ui.frameLimitWarning.hidden = !problem;
    ui.applyModelDefaultsButton.hidden = !(problem && model?.recommendedSettings);
  }

  function applyVideoModelDefaults() {
    const model = getSelectedVideoModel();
    if (!model?.recommendedSettings) return;
    const snapshot = state.inference.modelDefaults?.snapshot ?? readGenerationSettings();
    writeGenerationSettings(model.recommendedSettings);
    state.inference.modelDefaults = { modelId: model.id, snapshot, applied: readGenerationSettings() };
    updateVideoModelGuidance();
  }

  function handleVideoModelChange() {
    // Undo the previous model's defaults only if the user has not edited them since, so its limits do not linger.
    const previous = state.inference.modelDefaults;
    if (previous && isSameGenerationSettings(readGenerationSettings(), previous.applied)) {
      writeGenerationSettings(previous.snapshot);
    }
    state.inference.modelDefaults = null;
    applyVideoModelDefaults();
    updateVideoModelGuidance();
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
      const error = new Error(payload.error || `Request failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function loadLoras() {
    try {
      state.loras = await fetchJson('/api/inference/loras', { headers: {} });
    } catch (error) {
      console.warn('LoRA list unavailable.', error);
      state.loras = null;
    }
    renderLoraOptions();
  }

  // All names and metadata come from ComfyUI / the backend, so they are only ever written with textContent.
  function renderLoraOptions() {
    const selected = ui.loraSelect.value;
    const names = Array.isArray(state.loras?.loras) ? state.loras.loras.filter((name) => typeof name === 'string') : [];
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = '無';
    ui.loraSelect.replaceChildren(noneOption);
    names.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      ui.loraSelect.append(option);
    });
    ui.loraSelect.value = names.includes(selected) ? selected : '';
    updateLoraGuidance();
  }

  function getSelectedLoraInfo() {
    const name = ui.loraSelect.value;
    if (!name) return null;
    return state.loras?.catalog?.find((entry) => entry.file === name) ?? null;
  }

  function updateLoraGuidance() {
    const name = ui.loraSelect.value;
    ui.loraStrengthInput.disabled = !name;
    const lines = [];
    if (name) {
      lines.push('LoRA 需要在提示詞中加入對應觸發詞。');
      const info = getSelectedLoraInfo();
      if (info) {
        if (Array.isArray(info.trainedWords) && info.trainedWords.length) {
          lines.push(`觸發詞：${info.trainedWords.join(', ')}`);
        }
        if (info.baseModel) lines.push(`基底模型：${info.baseModel}`);
        if (Array.isArray(info.compatibleVideoModelIds) && !info.compatibleVideoModelIds.includes(ui.videoModelSelect.value)) {
          lines.push('注意：此 LoRA 與目前選擇的影片模型不相容。');
        }
        if (info.license) lines.push(`授權：${info.license}`);
      }
    } else if (state.loras && state.loras.available === false) {
      lines.push(`無法取得 ComfyUI 的 LoRA 清單：${state.loras.error || '未知錯誤'}`);
    }
    ui.loraHint.textContent = lines.join('\n');
    ui.loraHint.hidden = !lines.length;
  }

  // Returns { loraName, loraStrength } for the job payload, or throws with a user-facing message.
  function readLoraSettings() {
    const loraName = ui.loraSelect.value;
    if (!loraName) return {};
    const info = getSelectedLoraInfo();
    if (Array.isArray(info?.compatibleVideoModelIds) && !info.compatibleVideoModelIds.includes(ui.videoModelSelect.value)) {
      throw new Error('所選 LoRA 與目前的影片模型不相容；請改選相容的影片模型，或將 LoRA 設為「無」。');
    }
    const loraStrength = Number(ui.loraStrengthInput.value);
    const maxStrength = Number(state.loras?.maxStrength) || 2;
    if (ui.loraStrengthInput.value.trim() === '' || !Number.isFinite(loraStrength) || loraStrength < 0 || loraStrength > maxStrength) {
      throw new Error(`LoRA 強度必須介於 0 至 ${maxStrength}。`);
    }
    return { loraName, loraStrength };
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

  function gatherSpec(overrides = {}) {
    const duration = Math.max(2, Number(ui.durationInput.value) || 6);
    const fps = Math.max(12, Number(ui.fpsInput.value) || 24);
    const resolution = ui.resolutionInput.value || '1280x720';
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
        headers: { 'content-type': 'application/octet-stream', 'x-vediofactory-request': '1' },
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

  function renderLibrary() {
    ui.libraryGrid.innerHTML = '';
    ui.libraryEmpty.hidden = state.library.length > 0;

    state.library.forEach((item) => {
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
        // ComfyUI imports record only sourceImageAttached; the image itself is not kept in the metadata.
        ['來源', item.sourceImageDataUrl || item.sourceImageAttached ? '照片 + 提示詞' : '純文字描述'],
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
      await loadLoras();
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
      await loadLoras();
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
    let consecutiveFailures = 0;
    const refreshJob = async () => {
      if (state.inference.pollInFlight || state.inference.pollingJobId !== job.id) return;
      state.inference.pollInFlight = true;
      try {
        const updated = await fetchJson(`/api/inference/jobs/${encodeURIComponent(job.id)}`, { headers: {} });
        if (state.inference.pollingJobId !== job.id) return;
        consecutiveFailures = 0;
        state.inference.lastJob = updated;
        if (TERMINAL_JOB_STATUSES.includes(updated.status)) stopInferenceJobPolling();
        renderJobStatus(updated);
        if (updated.pipeline && TERMINAL_JOB_STATUSES.includes(updated.status)) {
          setDanceStatus({
            succeeded: '跳舞影片已完成，已加入下方「本機影片管理」。',
            failed: '這次沒有成功產生影片，請看下方的失敗原因。',
            cancelled: '工作已取消。',
          }[updated.status]);
        }
        if (updated.status === 'succeeded') {
          await listFolderItems();
          renderLibrary();
        }
      } catch (error) {
        if (state.inference.pollingJobId !== job.id) return;
        // Outputs are imported by the polling request, so a single ComfyUI hiccup must not end tracking for good.
        consecutiveFailures += 1;
        if (consecutiveFailures < 5) {
          setInferenceStatus(`查詢 ComfyUI 工作失敗，稍後重試（${consecutiveFailures}/5）：${error.message}`);
          return;
        }
        setInferenceStatus(`查詢 ComfyUI 工作失敗：${error.message}（重新整理頁面可恢復追蹤）`);
        stopInferenceJobPolling();
        syncDanceStartButton();
        if (job.pipeline) {
          setDanceStatus(`暫時無法取得進度：${localizeServerText(error.message)}（工作仍在本機繼續，重新整理頁面可恢復顯示）`);
        }
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
      const activeJob = Array.isArray(jobs) ? jobs.find((job) => (
        job?.comfyPromptId && ACTIVE_JOB_STATUSES.includes(job.status)
      )) : null;
      if (!activeJob) return;
      state.inference.lastJob = activeJob;
      startInferenceJobPolling(activeJob);
      renderJobStatus(activeJob);
      if (activeJob.pipeline) {
        setDanceStatus('已恢復顯示進行中的跳舞影片工作。');
      } else {
        setInferenceStatus(`恢復追蹤 ComfyUI 工作：${activeJob.id}（${activeJob.status}）`);
      }
    } catch (error) {
      console.warn('Unable to restore active inference job.', error);
    }
  }

  async function queueInferenceJob() {
    try {
      if (!state.backend.available) {
        setInferenceStatus('目前未連線到本機後端，無法建立推論工作。');
        return;
      }

      const { duration, fps } = readGenerationSettings();
      const frameLimitProblem = getFrameLimitProblem(getSelectedVideoModel(), duration, fps);
      if (frameLimitProblem) {
        updateVideoModelGuidance();
        setInferenceStatus(`未送出推論工作：${frameLimitProblem}`);
        return;
      }

      let loraSettings;
      try {
        loraSettings = readLoraSettings();
      } catch (loraError) {
        setInferenceStatus(`未送出推論工作：${loraError.message}`);
        return;
      }

      const file = ui.imageInput.files?.[0] ?? null;
      const sourceImageDataUrl = await readFileAsDataUrl(file);
      const spec = gatherSpec({ sourceImageDataUrl });
      if (!spec.prompt && !spec.story) {
        setInferenceStatus('請至少輸入提示詞或影片描述，再建立推論工作。');
        return;
      }

      ui.workflowCheckButton.disabled = true;
      const workflowCheck = await fetchJson('/api/inference/workflow-check', {
        method: 'POST',
        body: JSON.stringify({
          videoModelId: ui.videoModelSelect.value,
          hasSourceImage: Boolean(file),
          hasLora: Boolean(loraSettings.loraName),
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
            ...loraSettings,
          },
        }),
      });

      state.inference.lastJob = job;
      setInferenceStatus([
        `已建立本機推論工作：${job.id}（${job.status}）`,
        job.workflowVariables?.seed !== undefined ? `種子 ${job.workflowVariables.seed}` : '',
        job.workflowVariables?.lora_name ? `LoRA ${job.workflowVariables.lora_name} × ${job.workflowVariables.lora_strength}` : '',
        ...(job.warnings || []),
      ].filter(Boolean).join('；'));
      if (job.comfyPromptId) startInferenceJobPolling(job);
      updateCancelButtons(job);
      renderPipelineProgress(job);
      syncDanceStartButton();
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
          videoModelId: ui.videoModelSelect.value,
          hasSourceImage: Boolean(ui.imageInput.files?.[0]),
          hasLora: Boolean(ui.loraSelect.value),
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
    if (job.pipeline && !window.confirm('確定要取消這個跳舞影片工作嗎？已經完成的階段不會保留在影片庫中。')) return;
    ui.cancelInferenceButton.disabled = true;
    ui.danceCancelButton.disabled = true;
    try {
      const cancelled = await fetchJson(`/api/inference/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      state.inference.lastJob = cancelled;
      stopInferenceJobPolling();
      renderJobStatus(cancelled);
      if (cancelled.pipeline) {
        setDanceStatus('工作已取消。');
      } else {
        setInferenceStatus(`已取消待執行工作：${cancelled.id}`);
      }
    } catch (error) {
      let message;
      if (error.status === 409 && /已開始執行/u.test(error.message)) {
        message = '這個階段已經開始產生，為了避免中斷顯示卡上的運算，無法從這裡取消；請等它完成，進度會繼續更新。';
      } else if (error.status === 409) {
        message = `工作狀態剛好有變化，暫時無法取消；請稍候再試。（${localizeServerText(error.message)}）`;
      } else {
        message = `取消工作失敗：${localizeServerText(error.message)}`;
      }
      if (job.pipeline) setDanceStatus(message);
      setInferenceStatus(message);
      // The job moved on (e.g. the stage started); keep or resume tracking so the display catches up.
      if (state.inference.pollingJobId !== job.id && ACTIVE_JOB_STATUSES.includes(job.status)) {
        startInferenceJobPolling(job);
      }
    } finally {
      ui.cancelInferenceButton.disabled = false;
      ui.danceCancelButton.disabled = false;
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
    ui.videoModelSelect.addEventListener('change', handleVideoModelChange);
    ui.applyModelDefaultsButton.addEventListener('click', applyVideoModelDefaults);
    ui.loraSelect.addEventListener('change', updateLoraGuidance);
    ui.videoModelSelect.addEventListener('change', updateLoraGuidance);
    ui.durationInput.addEventListener('input', updateVideoModelGuidance);
    ui.durationInput.addEventListener('change', updateVideoModelGuidance);
    ui.fpsInput.addEventListener('change', updateVideoModelGuidance);
    ui.danceImageInput.addEventListener('change', handleDanceImageChange);
    ui.danceDurationSelect.addEventListener('change', updateDanceEstimate);
    ui.danceResolutionSelect.addEventListener('change', () => {
      updateDanceResolutionWarning();
      updateDanceEstimate();
    });
    ui.danceStartButton.addEventListener('click', startDanceJob);
    ui.danceCancelButton.addEventListener('click', cancelInferenceJob);
  }

  async function initApp() {
    bindUi();
    loadStoredLibrary();
    restoreStoredLibraryPreview();
    renderModuleOptions();
    attachEvents();
    await initBackend();
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
