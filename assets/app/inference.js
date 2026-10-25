// 本機推論（ComfyUI）：建立單一／批次工作、工作流預檢、seed 設定、輪詢工作狀態與重新產出。

import { state, ui } from './state.js';
import { setStatus, setInferenceStatus, fetchJson, readFileAsDataUrl } from './dom.js';
import { getSelectedWorkflow } from './workflows.js';
import { listFolderItems } from './library-store.js';
import { renderLibrary } from './library.js';
import { gatherSpec, createAndStoreVideo } from './generation.js';

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

export async function restoreActiveInferenceJob() {
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

export function syncSeedInput() {
  const fixed = ui.seedModeInput.value === 'fixed';
  ui.seedInput.disabled = !fixed;
  ui.seedInput.placeholder = fixed ? '輸入 0 以上的整數' : '隨機產生';
  if (fixed && !ui.seedInput.value && Number.isSafeInteger(state.inference.lastJob?.seed)) {
    ui.seedInput.value = String(state.inference.lastJob.seed);
  }
}

export function readSeedSetting() {
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

export async function rerunInferenceJob(jobId) {
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

// Shared by single and batch submission: gathers the form and runs the workflow preflight.
async function prepareInferenceRequest({ hasBatchPrompts = false } = {}) {
  if (!state.backend.available) {
    setInferenceStatus('目前未連線到本機後端，無法建立推論工作。');
    return null;
  }

  const file = ui.imageInput.files?.[0] ?? null;
  const sourceImageDataUrl = await readFileAsDataUrl(file);
  const spec = gatherSpec({ sourceImageDataUrl });
  if (!spec.prompt && !spec.story && !hasBatchPrompts) {
    setInferenceStatus('請至少輸入提示詞或影片描述，再建立推論工作。');
    return null;
  }
  const seed = readSeedSetting();
  const scenarioModuleId = getSelectedWorkflow()?.scenarioModuleId;
  const scenarioModule = window.VedioFactory.scenarioModules?.find((item) => item.id === scenarioModuleId);
  if (file && scenarioModule?.safety?.requiresPersonConsent) {
    const notice = scenarioModule.safety.notes || '使用真人照片產生影片前，必須取得照片中人物的同意。';
    if (!window.confirm(`${notice}\n\n確認已取得照片中人物的同意後再繼續？`)) {
      setInferenceStatus('已取消：尚未確認照片人物同意。');
      return null;
    }
  }

  ui.workflowCheckButton.disabled = true;
  try {
    const workflowCheck = await fetchJson('/api/inference/workflow-check', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: ui.workflowSelect.value,
        videoModelId: ui.videoModelSelect.value,
        hasSourceImage: Boolean(file),
      }),
    });
    renderWorkflowCheck(workflowCheck);
    if (!workflowCheck.ready) {
      setInferenceStatus(`工作流預檢未通過：${workflowCheck.errors.join(' ')}`);
      return null;
    }
  } finally {
    ui.workflowCheckButton.disabled = false;
  }
  return {
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
  };
}

export async function queueInferenceBatch() {
  ui.queueBatchButton.disabled = true;
  try {
    const prompts = ui.batchPromptsInput.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const seedCount = Number(ui.batchSeedCountInput.value);
    if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > 10) {
      throw new Error('每個提示詞的 seed 數量必須介於 1 至 10。');
    }
    const total = Math.max(prompts.length, 1) * seedCount;
    if (total > 50) throw new Error(`單一批次最多 50 個工作，目前為 ${total} 個。`);
    const payload = await prepareInferenceRequest({ hasBatchPrompts: prompts.length > 0 });
    if (!payload) return;
    setInferenceStatus(`正在建立 ${total} 個批次工作…`);
    const result = await fetchJson('/api/inference/batches', {
      method: 'POST',
      body: JSON.stringify({ ...payload, prompts, seedCount }),
    });
    const failures = result.errors.length
      ? `；${result.errors.length} 個失敗（第一個錯誤：${result.errors[0].error}）`
      : '';
    setInferenceStatus(`已建立批次 ${result.batchId.slice(0, 8)}：${result.created}/${result.total} 個工作${failures}`);
    document.dispatchEvent(new CustomEvent('vediofactory:jobs-changed'));
  } catch (error) {
    console.error(error);
    setInferenceStatus(`建立批次工作失敗：${error.message}`);
  } finally {
    ui.queueBatchButton.disabled = false;
  }
}

export async function queueInferenceJob() {
  try {
    const payload = await prepareInferenceRequest();
    if (!payload) return;

    const job = await fetchJson('/api/inference/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    state.inference.lastJob = job;
    setInferenceStatus(`已建立本機推論工作：${describeInferenceJob(job)}`);
    ui.cancelInferenceButton.hidden = !job.comfyPromptId || job.status !== 'queued';
    if (job.comfyPromptId) startInferenceJobPolling(job);
    document.dispatchEvent(new CustomEvent('vediofactory:jobs-changed'));
  } catch (error) {
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

export async function checkComfyWorkflow() {
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

export async function cancelInferenceJob() {
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

export async function regenerateItem(item) {
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
