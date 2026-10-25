// 推論工作佇列：列出工作、篩選狀態、取消排隊中的工作與以相同設定重跑。

import { state, ui } from './state.js';
import { fetchJson } from './dom.js';
import { listFolderItems } from './library-store.js';
import { renderLibrary } from './library.js';
import { rerunInferenceJob } from './inference.js';

const jobStatusLabels = {
  scaffolded: '未提交',
  queued: '排隊中',
  running: '執行中',
  succeeded: '完成',
  failed: '失敗',
  cancelled: '已取消',
};

function isActiveJob(job) {
  return Boolean(job.comfyPromptId) && ['queued', 'running'].includes(job.status);
}

export function renderJobs() {
  const filter = ui.jobStatusFilter.value;
  const visibleJobs = state.jobs.items.filter((job) => (
    !filter || (filter === 'active' ? isActiveJob(job) : job.status === filter)
  ));
  ui.jobsEmpty.hidden = visibleJobs.length > 0;
  ui.jobsEmpty.textContent = state.jobs.items.length ? '沒有符合篩選條件的工作。' : '尚無推論工作。';
  ui.jobsTable.hidden = visibleJobs.length === 0;
  ui.jobsTableBody.replaceChildren(...visibleJobs.map((job) => {
    const row = document.createElement('tr');
    const cells = [
      new Date(job.createdAt).toLocaleString('zh-TW'),
      '',
      [job.client, job.project].filter(Boolean).join(' / ') || '—',
      (job.prompt || job.story || '').slice(0, 120),
      Number.isSafeInteger(job.seed) ? String(job.seed) : '—',
      job.workflowId || '—',
      job.batchId ? `${job.batchId.slice(0, 8)} #${job.batchIndex + 1}` : '—',
    ].map((text) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      return cell;
    });
    cells[3].className = 'prompt-cell';
    const status = document.createElement('span');
    status.className = 'job-status';
    status.dataset.status = job.status;
    status.textContent = jobStatusLabels[job.status] || job.status;
    cells[1].append(status);
    const notes = [
      job.outputs?.length ? `已匯入 ${job.outputs.length} 部` : '',
      job.rerunOf ? '重新產出' : '',
      job.error || job.refreshError || '',
    ].filter(Boolean).join('；');
    if (notes) cells[1].append(document.createElement('br'), notes);

    const actions = document.createElement('td');
    const actionGroup = document.createElement('div');
    actionGroup.className = 'row-actions';
    if (job.comfyPromptId && job.status === 'queued') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => cancelQueuedJob(job, cancel));
      actionGroup.append(cancel);
    }
    if (job.hasWorkflowSnapshot) {
      const rerun = document.createElement('button');
      rerun.type = 'button';
      rerun.className = 'secondary';
      rerun.textContent = '以相同設定重跑';
      rerun.addEventListener('click', async () => {
        rerun.disabled = true;
        try {
          await rerunInferenceJob(job.id);
          await loadJobs();
        } catch (error) {
          ui.jobsStatus.textContent = `重新產出失敗：${error.message}`;
        } finally {
          rerun.disabled = false;
        }
      });
      actionGroup.append(rerun);
    }
    actions.append(actionGroup);
    row.append(...cells, actions);
    return row;
  }));
}

async function cancelQueuedJob(job, button) {
  button.disabled = true;
  try {
    await fetchJson(`/api/inference/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
    await loadJobs();
  } catch (error) {
    ui.jobsStatus.textContent = `取消失敗：${error.message}`;
    button.disabled = false;
  }
}

export async function loadJobs({ refresh = false } = {}) {
  if (!state.backend.available || state.jobs.loading) return;
  state.jobs.loading = true;
  window.clearTimeout(state.jobs.pollTimer);
  const previouslyActive = new Set(state.jobs.items.filter(isActiveJob).map((job) => job.id));
  try {
    state.jobs.items = await fetchJson(`/api/inference/jobs?limit=100${refresh ? '&refresh=1' : ''}`, { headers: {} });
    renderJobs();
    const activeCount = state.jobs.items.filter(isActiveJob).length;
    ui.jobsStatus.textContent = `共 ${state.jobs.items.length} 個工作${activeCount ? `，${activeCount} 個進行中（自動更新）` : ''}。`;
    const finished = state.jobs.items.some((job) => previouslyActive.has(job.id) && job.status === 'succeeded');
    if (finished) {
      await listFolderItems();
      renderLibrary();
    }
    if (activeCount) {
      state.jobs.pollTimer = window.setTimeout(() => loadJobs({ refresh: true }), 4_000);
    }
  } catch (error) {
    console.error(error);
    ui.jobsStatus.textContent = `載入工作佇列失敗：${error.message}`;
  } finally {
    state.jobs.loading = false;
  }
}
