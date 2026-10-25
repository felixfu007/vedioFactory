// 影片庫儲存層：後端、瀏覽器資料夾與暫存三種模式的讀寫、localStorage 快取與預覽網址。

import { state } from './state.js';
import { createVideoUploadBody, fetchJson } from './dom.js';

const storageKey = 'vedioFactory.library';

export const videoExtensionPattern = /\.(webm|mp4|gif|webp)$/iu;

export function getItemFormat(item) {
  return (item.format || videoExtensionPattern.exec(item.fileName || '')?.[1] || 'webm').toLowerCase();
}

export function serializeLibrary() {
  const payload = state.library
    .filter((item) => item.storageOrigin === 'backend')
    .map(({ previewUrl, blob, ...item }) => item);
  localStorage.setItem(storageKey, JSON.stringify(payload));
}

export function loadStoredLibrary() {
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

export function makeFileName(spec, suffix = '') {
  const clean = (spec.prompt || spec.story || 'video')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 36);
  return `${clean || 'video'}${suffix}.webm`;
}

export async function writeFile(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function saveAssetSet(item) {
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

export function stripTransientFields(item) {
  const { previewUrl, blob, ...persisted } = item;
  return persisted;
}

export function releasePreviewUrls(items) {
  items.forEach((item) => {
    if (typeof item.previewUrl === 'string' && item.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(item.previewUrl);
    }
  });
}

export async function listFolderItems() {
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
    if (entry.kind !== 'file' || !videoExtensionPattern.test(entryName.replace(/\.json$/u, ''))) continue;
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

export async function getItemBlob(item) {
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

export function getLibrarySnapshot() {
  return state.library.map((item) => ({ ...item }));
}

export function restoreStoredLibraryPreview() {
  state.library = state.library.map((item) => ({
    ...item,
    previewUrl: `/api/videos/${encodeURIComponent(item.fileName)}?t=${Date.now()}`,
  }));
}
