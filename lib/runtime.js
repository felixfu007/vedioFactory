const path = require('node:path');
const { URL } = require('node:url');
const { DEFAULT_MODEL_DIR } = require('./config.js');
const { execFileAsync } = require('./utils.js');

function getComfyUIConfig(options = {}) {
  const configuredUrl = options.comfyUIUrl || process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188';
  const workflowPath = options.comfyUIWorkflowPath || process.env.VEDIO_FACTORY_COMFYUI_WORKFLOW || '';
  let baseUrl = '';
  let error = '';
  try {
    const parsed = new URL(configuredUrl);
    if (
      parsed.protocol !== 'http:'
      || !['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('ComfyUI must use unauthenticated HTTP on localhost or host.docker.internal.');
    }
    baseUrl = parsed.origin;
  } catch (configError) {
    error = configError.message;
  }
  return {
    baseUrl,
    configuredUrl,
    workflowPath: workflowPath ? path.resolve(workflowPath) : '',
    error,
  };
}

async function detectNvidiaRuntime() {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
      { timeout: 2_500 },
    );
    const [firstLine = ''] = stdout.trim().split(/\r?\n/u);
    const parts = firstLine.split(',').map((item) => item.trim());
    const memoryTotal = parts.pop() || '';
    const driverVersion = parts.pop() || '';
    const name = parts.join(', ');
    return {
      detected: Boolean(firstLine),
      name,
      driverVersion,
      memoryTotal,
      probe: 'nvidia-smi',
    };
  } catch (error) {
    return {
      detected: false,
      name: '',
      driverVersion: '',
      memoryTotal: '',
      probe: 'nvidia-smi',
      error: error.code || error.message,
    };
  }
}

async function getInferenceRuntime(outputDir, comfyUI = getComfyUIConfig(), workflows = null) {
  const [gpu, comfy] = await Promise.all([
    detectNvidiaRuntime(),
    (async () => {
      if (!comfyUI.baseUrl) {
        return { available: false, url: comfyUI.configuredUrl, error: comfyUI.error };
      }
      try {
        const response = await fetch(`${comfyUI.baseUrl}/system_stats`, {
          signal: AbortSignal.timeout(2_500),
        });
        if (!response.ok) throw new Error(`ComfyUI responded with HTTP ${response.status}`);
        return { available: true, url: comfyUI.baseUrl };
      } catch (error) {
        return { available: false, url: comfyUI.baseUrl, error: error.message };
      }
    })(),
  ]);
  return {
    provider: 'comfyui-local',
    localGpuPreferred: true,
    platform: process.platform,
    outputDir,
    modelDir: DEFAULT_MODEL_DIR,
    workflowConfigured: workflows ? workflows.length > 0 : Boolean(comfyUI.workflowPath),
    comfyUI: {
      ...comfy,
      workflowConfigured: workflows ? workflows.length > 0 : Boolean(comfyUI.workflowPath),
      workflowPath: comfyUI.workflowPath,
      workflowCount: workflows ? workflows.length : Number(Boolean(comfyUI.workflowPath)),
    },
    gpu,
    guidance: [
      '請在本機啟動 ComfyUI；Docker 部署時使用 host.docker.internal，並透過防火牆限制存取。',
      '將 ComfyUI 匯出的 API 格式工作流 JSON 放入 workflows 資料夾（可附同名 .vf.json 設定檔），或設定 VEDIO_FACTORY_COMFYUI_WORKFLOW。',
      `模型權重預設放在 ${DEFAULT_MODEL_DIR}；ComfyUI 回傳的 WebM/MP4/GIF/WebP 影片會複製到 ${outputDir}。`,
    ],
  };
}

module.exports = {
  getComfyUIConfig,
  getInferenceRuntime,
};
