// 客戶交付：把目前篩選出的影片連同參數 manifest 複製到交付資料夾。

import { state, ui } from './state.js';
import { fetchJson } from './dom.js';
import { getVisibleLibraryItems } from './library.js';

function setDeliveryStatus(message) {
  ui.deliveryStatus.hidden = !message;
  ui.deliveryStatus.textContent = message;
}

export async function createDelivery() {
  const items = getVisibleLibraryItems();
  if (!items.length) return;
  // Name the folder after a client/project shared by every selected video, even without an explicit filter.
  const sharedValue = (field) => {
    const values = new Set(items.map((item) => item[field] || ''));
    return values.size === 1 ? [...values][0] : '';
  };
  const client = state.libraryFilter.client || sharedValue('client');
  const project = state.libraryFilter.project || sharedValue('project');
  const scope = [client || '多個客戶', project || '多個專案'].join(' / ');
  if (!window.confirm(`將 ${items.length} 部影片（${scope}）連同參數 manifest 複製到交付資料夾？`)) return;
  ui.createDeliveryButton.disabled = true;
  setDeliveryStatus('正在建立交付資料夾…');
  try {
    const delivery = await fetchJson('/api/deliveries', {
      method: 'POST',
      body: JSON.stringify({ client, project, fileNames: items.map((item) => item.fileName) }),
    });
    setDeliveryStatus(`已建立交付資料夾（${delivery.itemCount} 部影片）：${delivery.deliveryPath}`);
  } catch (error) {
    console.error(error);
    setDeliveryStatus(`建立交付資料夾失敗：${error.message}`);
  } finally {
    ui.createDeliveryButton.disabled = false;
  }
}
