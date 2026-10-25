// Civitai 模型安裝：查詢模型資訊與授權、開始下載安裝，並顯示下載進度與安裝紀錄。

import { state, ui } from './state.js';
import { fetchJson, formatBytes } from './dom.js';

export const civitaiState = { preview: null, pollTimer: null };

const installStatusLabels = {
  queued: '排隊中',
  downloading: '下載中',
  verifying: '驗證中',
  installed: '已安裝',
  failed: '失敗',
  cancelled: '已取消',
};

function renderCivitaiPreview(info) {
  const lines = [
    [`${info.name}（${info.versionName}）`, true],
    [`類型：${info.type}${info.baseModel ? `｜基礎模型：${info.baseModel}` : ''}`],
    [`檔案：${info.fileName}（${formatBytes(info.sizeBytes)}）→ 安裝到 ${info.folder}`],
    [info.trainedWords.length ? `觸發詞：${info.trainedWords.join('、')}` : ''],
    [info.license.allowsCommercialOutputs
      ? `商用：允許把產出的圖片／影片用於商業用途（Civitai 授權：${info.license.commercialUse.join('、')}）`
      : `商用：作者未允許商業使用產出內容（Civitai 授權：${info.license.commercialUse.join('、') || '無'}）；用於客戶專案前請先取得作者同意。`,
    false, !info.license.allowsCommercialOutputs],
    [info.license.allowNoCredit ? '' : '使用時需標示作者名稱。'],
    ...(info.contentWarnings || []).map((warning) => [`提醒：${warning}`, false, true]),
    [info.modelsDirReady ? '' : '找不到 ComfyUI 的 models 資料夾，無法安裝；請設定 VEDIO_FACTORY_COMFYUI_MODELS_DIR。', false, true],
  ];
  ui.civitaiPreview.replaceChildren(...lines.filter(([text]) => text).map(([text, strong, warning]) => {
    const line = document.createElement(strong ? 'strong' : 'p');
    line.textContent = text;
    if (warning) line.className = 'license-warning';
    return line;
  }));
  const link = document.createElement('a');
  link.href = info.pageUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '在 Civitai 查看模型頁面';
  ui.civitaiPreview.append(link);
  ui.civitaiPreview.hidden = false;
}

export async function previewCivitaiModel() {
  civitaiState.preview = null;
  ui.civitaiInstallButton.disabled = true;
  ui.civitaiPreview.hidden = true;
  ui.civitaiPreviewButton.disabled = true;
  ui.civitaiStatus.textContent = '正在向 Civitai 查詢…';
  try {
    const info = await fetchJson('/api/model-installs/preview', {
      method: 'POST',
      body: JSON.stringify({ url: ui.civitaiUrlInput.value, folder: ui.civitaiFolderSelect.value }),
    });
    civitaiState.preview = info;
    renderCivitaiPreview(info);
    ui.civitaiInstallButton.disabled = !info.modelsDirReady;
    ui.civitaiStatus.textContent = '請確認上方資訊與授權，再按「下載並安裝」。';
  } catch (error) {
    ui.civitaiStatus.textContent = `查詢失敗：${error.message}`;
  } finally {
    ui.civitaiPreviewButton.disabled = false;
  }
}

export async function installCivitaiModel() {
  const info = civitaiState.preview;
  if (!info) return;
  if (!info.license.allowsCommercialOutputs
    && !window.confirm('此模型的作者未允許商業使用產出內容。仍要安裝（僅供非商業用途）嗎？')) {
    return;
  }
  ui.civitaiInstallButton.disabled = true;
  try {
    await fetchJson('/api/model-installs', {
      method: 'POST',
      body: JSON.stringify({ url: ui.civitaiUrlInput.value, folder: ui.civitaiFolderSelect.value }),
    });
    ui.civitaiStatus.textContent = `已開始下載 ${info.fileName}。`;
    civitaiState.preview = null;
    await loadModelInstalls();
  } catch (error) {
    ui.civitaiStatus.textContent = `安裝失敗：${error.message}`;
    ui.civitaiInstallButton.disabled = false;
  }
}

function renderModelInstalls(payload) {
  const activeIds = new Set(payload.jobs.map((job) => job.info.sha256));
  const cards = payload.jobs.map((job) => {
    const card = document.createElement('div');
    card.className = 'civitai-job';
    const title = document.createElement('strong');
    title.textContent = `${job.info.name}（${job.info.versionName}）→ ${job.info.folder}\\${job.info.fileName}`;
    const status = document.createElement('span');
    const percent = job.progress.totalBytes ? Math.min(100, (job.progress.receivedBytes / job.progress.totalBytes) * 100) : 0;
    status.textContent = `${installStatusLabels[job.status] || job.status}${job.status === 'downloading' ? `：${formatBytes(job.progress.receivedBytes)} / ${formatBytes(job.progress.totalBytes)}（${percent.toFixed(0)}%）` : ''}${job.error ? `：${job.error}` : ''}`;
    if (job.status === 'failed') status.className = 'license-warning';
    card.append(title, status);
    if (['queued', 'downloading', 'verifying'].includes(job.status)) {
      const bar = document.createElement('progress');
      bar.max = 100;
      bar.value = percent;
      card.append(bar);
    }
    if (['queued', 'downloading'].includes(job.status)) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = '取消下載';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        await fetchJson(`/api/model-installs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' }).catch(() => undefined);
        await loadModelInstalls();
      });
      card.append(cancel);
    }
    return card;
  });
  const history = payload.installed.filter((record) => !activeIds.has(record.sha256)).slice(0, 10).map((record) => {
    const card = document.createElement('div');
    card.className = 'civitai-job';
    const title = document.createElement('strong');
    title.textContent = `已安裝：${record.name}（${record.versionName}）→ ${record.folder}\\${record.fileName}`;
    const details = document.createElement('span');
    details.textContent = `${new Date(record.installedAt).toLocaleString('zh-TW')}｜${record.license.allowsCommercialOutputs ? '可商用產出' : '未授權商用產出'}${record.trainedWords.length ? `｜觸發詞：${record.trainedWords.join('、')}` : ''}`;
    card.append(title, details);
    return card;
  });
  ui.civitaiJobs.replaceChildren(...cards, ...history);
}

export async function loadModelInstalls() {
  if (!state.backend.available) {
    ui.civitaiPreviewButton.disabled = true;
    ui.civitaiStatus.textContent = '從 Civitai 安裝模型需要本機後端。';
    return;
  }
  window.clearTimeout(civitaiState.pollTimer);
  try {
    const payload = await fetchJson('/api/model-installs', { headers: {} });
    renderModelInstalls(payload);
    if (!payload.modelsDirReady) {
      ui.civitaiStatus.textContent = `找不到 ComfyUI 的 models 資料夾（${payload.modelsDir}）；請設定 VEDIO_FACTORY_COMFYUI_MODELS_DIR。`;
    }
    if (payload.jobs.some((job) => ['queued', 'downloading', 'verifying'].includes(job.status))) {
      civitaiState.pollTimer = window.setTimeout(loadModelInstalls, 2_000);
    }
  } catch (error) {
    ui.civitaiStatus.textContent = `讀取安裝紀錄失敗：${error.message}`;
  }
}
