// 瀏覽器端生成：收集表單參數、以 Canvas + MediaRecorder 錄出影片並存入影片庫。

import { state, ui } from './state.js';
import { setStatus, resolutionToSize, readFileAsDataUrl, loadImage, wait } from './dom.js';
import { qualityBitrates, getSupportedMimeType, fitImage, drawCaptionBlock } from './canvas.js';
import { getModuleById } from './registry.js';
import { readResolution } from './workflows.js';
import { serializeLibrary, makeFileName, saveAssetSet, listFolderItems } from './library-store.js';
import { renderLibrary } from './library.js';

function setGeneratingState(isGenerating) {
  state.generating = isGenerating;
  ui.generateButton.disabled = isGenerating;
  ui.generateButton.textContent = isGenerating ? '生成中…' : '生成影片';
}

export function gatherSpec(overrides = {}) {
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

export async function createAndStoreVideo(spec, suffix = '') {
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

export async function generateFromForm() {
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

export async function renderReferenceFrame(item, timestamp = item.duration / 2) {
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
