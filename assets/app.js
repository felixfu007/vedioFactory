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
    },
  };

  const storageKey = 'vedioFactory.library';

  const ui = {};

  function registerModule(moduleDefinition) {
    if (!moduleDefinition || !moduleDefinition.id) {
      throw new Error('Module definition requires an id.');
    }

    modules.push(moduleDefinition);
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
    const payload = state.library.map(({ previewUrl, blob, ...item }) => item);
    localStorage.setItem(storageKey, JSON.stringify(payload));
  }

  function loadStoredLibrary() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      state.library = Array.isArray(saved) ? saved : [];
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
    ui.inferenceStatus = document.querySelector('#inferenceStatus');
    ui.cardTemplate = document.querySelector('#videoCardTemplate');
  }

  function getFolderLabel(input) {
    if (!input) return '尚未選擇';
    return input.split(/[\\/]/u).filter(Boolean).at(-1) || input;
  }

  function renderModuleOptions() {
    ui.moduleSelect.innerHTML = '';
    modules.forEach((moduleDefinition) => {
      const option = document.createElement('option');
      option.value = moduleDefinition.id;
      option.textContent = `${moduleDefinition.name}｜${moduleDefinition.tagline}`;
      ui.moduleSelect.append(option);
    });

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
      `推論命令：${runtime.engineCommandConfigured ? `${runtime.engineCommand} ${runtime.engineArgs.join(' ')}`.trim() : '尚未設定 VEDIO_FACTORY_LOCAL_ENGINE_COMMAND'}`,
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

  function setGeneratingState(isGenerating) {
    state.generating = isGenerating;
    ui.generateButton.disabled = isGenerating;
    ui.generateButton.textContent = isGenerating ? '生成中…' : '生成影片';
  }

  function resolutionToSize(value) {
    const [width, height] = value.split('x').map((item) => Number(item));
    return { width, height };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        resolve(dataUrl.split(',')[1] ?? '');
      };
      reader.onerror = () => reject(reader.error ?? new Error('讀取影片失敗'));
      reader.readAsDataURL(blob);
    });
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
      item.previewUrl = `/api/videos/${encodeURIComponent(item.fileName)}?t=${Date.now()}`;
      await fetchJson('/api/videos', {
        method: 'POST',
        body: JSON.stringify({
          item: stripTransientFields(item),
          videoBase64: await blobToBase64(item.blob),
        }),
      });
      return item;
    }

    if (!state.folderHandle) {
      item.previewUrl = URL.createObjectURL(item.blob);
      return item;
    }

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

  async function listFolderItems() {
    if (state.backend.available) {
      const items = await fetchJson('/api/videos');
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

    const done = new Promise((resolve) => {
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' })), { once: true });
    });

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
    return done;
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
      state.library = payload.items;
      state.inference.runtime = await fetchJson('/api/inference/runtime', { headers: {} });
      syncStorageUi();
      serializeLibrary();
      renderInferenceRuntime();
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
    } catch (error) {
      console.warn('Backend unavailable, falling back to browser mode.', error);
    } finally {
      syncStorageUi();
      renderInferenceRuntime();
    }
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

      const job = await fetchJson('/api/inference/jobs', {
        method: 'POST',
        body: JSON.stringify({
          prompt: spec.prompt,
          story: spec.story,
          moduleId: spec.moduleId,
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
      setInferenceStatus(`已建立本機推論工作：${job.id}（${job.status}）`);
    } catch (error) {
      console.error(error);
      setInferenceStatus(`建立推論工作失敗：${error.message}`);
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
      const nextFileName = `${requested.replace(/\.webm$/u, '')}.webm`;
      const updated = {
        ...item,
        fileName: nextFileName,
      };

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

      state.library = state.library.map((entry) => (entry.id === item.id ? updated : entry));
      serializeLibrary();
      renderLibrary();
      setStatus(`已重新命名為 ${nextFileName}`);
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
    video.src = URL.createObjectURL(blob);
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    await new Promise((resolve) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
    });

    const safeStart = Math.max(0, Math.min(startTime, video.duration - 0.1));
    const safeEnd = Math.max(safeStart + 0.2, Math.min(endTime, video.duration));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || item.width;
    canvas.height = video.videoHeight || item.height;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(item.fps);
    const mimeType = getSupportedMimeType();
    const chunks = [];
    const recorder = new MediaRecorder(stream, mimeType ? {
      mimeType,
      videoBitsPerSecond: qualityBitrates[item.quality] ?? qualityBitrates.balanced,
    } : {
      videoBitsPerSecond: qualityBitrates[item.quality] ?? qualityBitrates.balanced,
    });

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const done = new Promise((resolve) => {
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' })), { once: true });
    });

    recorder.start();
    video.currentTime = safeStart;
    await new Promise((resolve) => {
      video.addEventListener('seeked', resolve, { once: true });
    });

    await video.play().catch(() => undefined);
    while (video.currentTime < safeEnd) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      await wait(1000 / item.fps);
    }

    video.pause();
    recorder.stop();
    URL.revokeObjectURL(video.src);
    return {
      blob: await done,
      duration: Number((safeEnd - safeStart).toFixed(1)),
    };
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
      previewUrl: item.previewUrl ?? '',
    }));
  }

  function attachEvents() {
    ui.moduleSelect.addEventListener('change', renderModuleDetails);
    ui.generateButton.addEventListener('click', generateFromForm);
    ui.connectOutputDirButton.addEventListener('click', connectOutputDir);
    ui.pickFolderButton.addEventListener('click', pickFolder);
    ui.refreshButton.addEventListener('click', refreshLibrary);
    ui.queueInferenceButton.addEventListener('click', queueInferenceJob);
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
