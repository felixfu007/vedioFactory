// 後端連線與輸出資料夾：初始化後端、切換後端資料夾或瀏覽器資料夾，並同步儲存模式顯示。

import { state, ui } from './state.js';
import { getFolderLabel, setStatus, fetchJson } from './dom.js';
import { serializeLibrary, releasePreviewUrls, listFolderItems } from './library-store.js';
import { renderLibrary } from './library.js';
import { restoreActiveInferenceJob } from './inference.js';
import { renderInferenceRuntime, renderModelCatalog } from './models.js';

export function syncStorageUi() {
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

export async function pickFolder() {
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

export async function connectOutputDir() {
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

export async function initBackend() {
  try {
    const payload = await fetchJson('/api/config', { headers: {} });
    state.backend.available = true;
    state.backend.outputDir = payload.outputDir;
    state.backend.ffmpeg = payload.ffmpeg || { available: false, version: '' };
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
