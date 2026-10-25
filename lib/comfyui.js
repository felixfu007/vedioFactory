const crypto = require('node:crypto');
const { createRequestError } = require('./utils.js');

// 本機 ComfyUI HTTP API 的薄封裝；comfyUI 來自 getComfyUIConfig()。
function createComfyClient(comfyUI) {

  async function requestComfyUI(endpoint, requestOptions = {}) {
    if (!comfyUI.baseUrl) {
      throw createRequestError(comfyUI.error || 'ComfyUI URL 設定無效。', 503);
    }
    let response;
    try {
      response = await fetch(`${comfyUI.baseUrl}${endpoint}`, {
        ...requestOptions,
        signal: requestOptions.signal || AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw createRequestError(`無法連線至本機 ComfyUI：${error.message}`, 503);
    }
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw createRequestError(`ComfyUI 請求失敗（${response.status}）：${details.slice(0, 1000)}`, 502);
    }
    return response;
  }

  async function uploadComfySourceImage(source) {
    const form = new FormData();
    // Content-addressed name keeps the submitted prompt JSON identical across reruns.
    form.append(
      'image',
      new Blob([source.image], { type: source.mimeType }),
      `vediofactory-${source.sha256.slice(0, 32)}.${source.extension}`,
    );
    form.append('overwrite', 'true');
    const response = await requestComfyUI('/upload/image', { method: 'POST', body: form });
    const result = await response.json();
    if (!result.name) throw createRequestError('ComfyUI 未回傳上傳圖片名稱。', 502);
    return [result.subfolder, result.name].filter(Boolean).join('/');
  }

  async function submitComfyWorkflow(apiWorkflow) {
    const submission = await requestComfyUI('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: apiWorkflow, client_id: crypto.randomUUID() }),
    }).then((response) => response.json());
    if (!submission.prompt_id || (submission.node_errors && Object.keys(submission.node_errors).length)) {
      throw createRequestError(`ComfyUI 拒絕工作流：${JSON.stringify(submission.node_errors || submission)}`, 400);
    }
    return submission;
  }

  async function getComfyUIVersion() {
    try {
      const response = await requestComfyUI('/system_stats', { signal: AbortSignal.timeout(5_000) });
      const stats = await response.json();
      return typeof stats?.system?.comfyui_version === 'string' ? stats.system.comfyui_version : null;
    } catch {
      return null;
    }
  }

  return {
    requestComfyUI,
    uploadComfySourceImage,
    submitComfyWorkflow,
    getComfyUIVersion,
  };
}

module.exports = { createComfyClient };
