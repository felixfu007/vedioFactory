// 影片庫畫面：客戶／專案篩選、影片卡片渲染，以及下載、重新命名、剪輯、轉檔、刪除等卡片操作。

import { state, ui } from './state.js';
import { setStatus, fetchJson, wait, fillSelectOptions, distinctValues } from './dom.js';
import { qualityBitrates, getSupportedMimeType } from './canvas.js';
import {
  videoExtensionPattern,
  getItemFormat,
  serializeLibrary,
  makeFileName,
  writeFile,
  saveAssetSet,
  stripTransientFields,
  releasePreviewUrls,
  listFolderItems,
  getItemBlob,
} from './library-store.js';

// 「重新產出」需要生成與推論模組，由 app.js 注入，避免 library ↔ inference 循環依賴。
let regenerateItem = () => undefined;

export function setRegenerateHandler(handler) {
  regenerateItem = handler;
}

const animatedImageFormats = new Set(['gif', 'webp']);

export function renderProjectOptions() {
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

export function getVisibleLibraryItems() {
  const { client, project } = state.libraryFilter;
  return state.library.filter((item) => (
    (!client || item.client === client) && (!project || item.project === project)
  ));
}

export function renderLibrary() {
  ui.libraryGrid.innerHTML = '';
  renderLibraryFilters();
  renderProjectOptions();
  const visibleItems = getVisibleLibraryItems();
  ui.createDeliveryButton.disabled = !state.backend.available || visibleItems.length === 0;
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
    const format = getItemFormat(item);
    if (animatedImageFormats.has(format)) {
      const image = document.createElement('img');
      image.className = 'video-preview';
      image.alt = item.fileName;
      image.src = item.previewUrl ?? '';
      video.replaceWith(image);
      const clipButton = card.querySelector('[data-action="clip"]');
      clipButton.disabled = true;
      clipButton.title = `${format.toUpperCase()} 無法在瀏覽器內剪輯`;
    } else {
      video.src = item.previewUrl ?? '';
    }
    title.textContent = item.fileName;
    subtitle.textContent = `${item.moduleName} ・ ${new Date(item.createdAt).toLocaleString('zh-TW')}`;
    summary.textContent = item.story || item.prompt || '由照片與風格模組共同生成。';
    endInput.value = String(item.duration);
    endInput.max = String(item.duration);
    startInput.max = String(Math.max(item.duration - 0.1, 0.1));

    [
      ['長度', `${item.duration}s`],
      ['格式', getItemFormat(item).toUpperCase()],
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
    const transcodeButton = card.querySelector('[data-action="transcode"]');
    transcodeButton.hidden = !state.backend.available || !state.backend.ffmpeg.available || format === 'mp4';
    transcodeButton.addEventListener('click', () => transcodeItem(item, transcodeButton));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteItem(item));

    ui.libraryGrid.append(fragment);
  });
}

export async function refreshLibrary() {
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

async function transcodeItem(item, button) {
  button.disabled = true;
  setStatus(`正在以 ffmpeg 將 ${item.fileName} 轉成 MP4…`);
  try {
    const transcoded = await fetchJson(`/api/videos/${encodeURIComponent(item.fileName)}/transcode`, { method: 'POST' });
    await listFolderItems();
    renderLibrary();
    setStatus(`已轉成 MP4：${transcoded.fileName}`);
  } catch (error) {
    console.error(error);
    setStatus(`轉檔失敗：${error.message}`);
    button.disabled = false;
  }
}

async function renameItem(item) {
  try {
    const extension = `.${getItemFormat(item)}`;
    const requested = window.prompt('請輸入新的檔名', item.fileName.replace(videoExtensionPattern, ''));
    if (!requested) return;
    const normalizedName = requested.trim().replace(videoExtensionPattern, '');
    if (!normalizedName) {
      setStatus('請輸入有效的檔名。');
      return;
    }
    const nextFileName = `${normalizedName}${extension}`;
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
    if (recorder && recorder.state !== 'inactive') {
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
