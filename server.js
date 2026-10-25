const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { createModelInstaller } = require('./lib/model-installer.js');
const { BASE_CAPABILITIES } = require('./assets/capabilities.js');
const {
  ROOT_DIR,
  HOST,
  PORT,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_DATA_DIR,
  DEFAULT_WORKFLOWS_DIR,
  DEFAULT_MODULES_DIR,
  DEFAULT_FFMPEG_COMMAND,
  PRESETS_DIR_NAME,
} = require('./lib/config.js');
const {
  createRequestError,
  getContentType,
  parseHostList,
  readHostname,
  readJsonBody,
  sendJson,
  sendText,
} = require('./lib/utils.js');
const { WORKFLOW_ID_PATTERN, normalizeOutputDir, sanitizeFileName } = require('./lib/validation.js');
const { buildModelCatalog, createModelSetupBatch } = require('./lib/catalog.js');
const { getComfyUIConfig, getInferenceRuntime } = require('./lib/runtime.js');
const { createComfyClient } = require('./lib/comfyui.js');
const { createWorkflowRegistry } = require('./lib/workflows.js');
const { createInferenceService } = require('./lib/inference.js');
const { createPresetStore } = require('./lib/presets.js');
const { createVideoLibrary } = require('./lib/library.js');
const { createDeliveryService } = require('./lib/deliveries.js');
const fs = require('node:fs/promises');

const MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createApp(options = {}) {
  let outputDir = normalizeOutputDir(options.outputDir || DEFAULT_OUTPUT_DIR);
  const dataDir = normalizeOutputDir(options.dataDir || DEFAULT_DATA_DIR);
  const presetsDir = path.join(dataDir, PRESETS_DIR_NAME);
  const workflowsDir = path.resolve(options.workflowsDir || DEFAULT_WORKFLOWS_DIR);
  const modulesDir = path.resolve(options.modulesDir || DEFAULT_MODULES_DIR);
  const modelInstaller = createModelInstaller({
    dataDir,
    modelsDir: path.resolve(
      options.comfyUIModelsDir
      || process.env.VEDIO_FACTORY_COMFYUI_MODELS_DIR
      || path.join(os.homedir(), 'ComfyUI', 'models'),
    ),
    apiOrigin: options.civitaiOrigin || 'https://civitai.com',
    token: options.civitaiToken ?? process.env.VEDIO_FACTORY_CIVITAI_TOKEN ?? '',
    fetchImpl: options.fetchImpl,
  });
  // [command, ...prefixArgs] so tests can substitute a script run by node.
  const ffmpegCommand = options.ffmpegCommand || DEFAULT_FFMPEG_COMMAND;
  const allowedHostnames = new Set([
    ...LOOPBACK_HOSTNAMES,
    ...(options.allowedHosts ?? parseHostList(process.env.VEDIO_FACTORY_ALLOWED_HOSTS)),
  ]);
  const comfyUI = getComfyUIConfig(options);
  const getOutputDir = () => outputDir;
  const workflows = createWorkflowRegistry({ workflowsDir, modulesDir, comfyUI });
  const comfy = createComfyClient(comfyUI);
  const inference = createInferenceService({ getOutputDir, comfyUI, comfy, workflows });
  const presets = createPresetStore({ presetsDir, workflows });
  const library = createVideoLibrary({
    getOutputDir,
    ffmpegCommand,
    maxVideoUploadBytes: options.maxVideoUploadBytes ?? MAX_VIDEO_UPLOAD_BYTES,
  });
  const deliveries = createDeliveryService({ getOutputDir, inference });

  async function handleApi(request, response, requestUrl) {
    if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, { ok: true });
    }

    if (requestUrl.pathname === '/api/config' && request.method === 'GET') {
      await library.ensureOutputDir();
      return sendJson(response, 200, {
        backendAvailable: true,
        outputDir,
        presetsDir,
        modulesDir,
        ffmpeg: await library.detectFfmpeg(),
        storageMode: 'backend',
        localGpuPreferred: true,
      });
    }

    if (requestUrl.pathname === '/api/inference/runtime' && request.method === 'GET') {
      await library.ensureOutputDir();
      return sendJson(response, 200, await getInferenceRuntime(outputDir, comfyUI, await workflows.listWorkflows()));
    }

    if (requestUrl.pathname === '/api/workflows' && request.method === 'GET') {
      return sendJson(response, 200, await workflows.listWorkflows());
    }

    if (requestUrl.pathname === '/api/capabilities' && request.method === 'GET') {
      const workflowId = requestUrl.searchParams.get('workflowId') || '';
      if (!workflowId) return sendJson(response, 200, { workflowId: '', ...BASE_CAPABILITIES });
      if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw createRequestError('工作流 ID 無效。');
      const workflow = await workflows.resolveWorkflow(workflowId);
      if (workflow.error) throw createRequestError(workflow.error);
      return sendJson(response, 200, { workflowId: workflow.id, ...workflow.capabilities });
    }

    if (requestUrl.pathname === '/api/inference/workflow-check' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const report = await workflows.preflightComfyWorkflow(body);
      return sendJson(response, 200, report);
    }

    if (requestUrl.pathname === '/api/models/catalog' && request.method === 'GET') {
      const runtime = await getInferenceRuntime(outputDir, comfyUI);
      return sendJson(response, 200, buildModelCatalog(runtime.modelDir));
    }

    if (requestUrl.pathname === '/api/models/setup-batch' && request.method === 'POST') {
      return sendJson(response, 201, await createModelSetupBatch(outputDir, await getInferenceRuntime(outputDir, comfyUI)));
    }

    if (requestUrl.pathname === '/api/inference/jobs' && request.method === 'GET') {
      const limit = Number(requestUrl.searchParams.get('limit') || 500);
      return sendJson(response, 200, await inference.listInferenceJobSummaries({
        refresh: requestUrl.searchParams.get('refresh') === '1',
        limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 500,
      }));
    }

    if (requestUrl.pathname === '/api/inference/batches' && request.method === 'POST') {
      return sendJson(response, 201, await inference.createInferenceBatch(await readJsonBody(request)));
    }

    if (requestUrl.pathname === '/api/inference/jobs' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return sendJson(response, 201, await inference.createInferenceJob(body));
    }

    if (requestUrl.pathname === '/api/presets' && request.method === 'GET') {
      const allPresets = [...await workflows.listModulePresets(), ...await presets.listPresets()];
      return sendJson(response, 200, allPresets.map(presets.toPresetResponse));
    }

    if (requestUrl.pathname === '/api/model-installs' && request.method === 'GET') {
      return sendJson(response, 200, await modelInstaller.list());
    }

    if (requestUrl.pathname === '/api/model-installs/preview' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return sendJson(response, 200, await modelInstaller.preview(body.url, body.folder || ''));
    }

    if (requestUrl.pathname === '/api/model-installs' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return sendJson(response, 202, await modelInstaller.install(body.url, body.folder || ''));
    }

    const modelInstallCancel = /^\/api\/model-installs\/([^/]+)\/cancel$/u.exec(requestUrl.pathname);
    if (modelInstallCancel && request.method === 'POST') {
      return sendJson(response, 200, modelInstaller.cancel(decodeURIComponent(modelInstallCancel[1])));
    }

    if (requestUrl.pathname === '/api/scenario-modules' && request.method === 'GET') {
      return sendJson(response, 200, (await workflows.listScenarioModules()).map(workflows.toScenarioModuleResponse));
    }

    if (requestUrl.pathname === '/api/presets' && request.method === 'POST') {
      return sendJson(response, 201, await presets.createPreset(await readJsonBody(request)));
    }

    if (requestUrl.pathname === '/api/presets/export' && request.method === 'GET') {
      return sendJson(response, 200, await presets.exportPresets());
    }

    if (requestUrl.pathname === '/api/presets/import' && request.method === 'POST') {
      return sendJson(response, 200, await presets.importPresets(await readJsonBody(request)));
    }

    const presetMatch = /^\/api\/presets\/([^/]+)$/u.exec(requestUrl.pathname);
    if (presetMatch && request.method === 'PUT') {
      return sendJson(response, 200, await presets.updatePreset(decodeURIComponent(presetMatch[1]), await readJsonBody(request)));
    }
    if (presetMatch && request.method === 'DELETE') {
      return sendJson(response, 200, await presets.deletePreset(decodeURIComponent(presetMatch[1])));
    }

    if (requestUrl.pathname === '/api/deliveries' && request.method === 'POST') {
      return sendJson(response, 201, await deliveries.createDelivery(await readJsonBody(request)));
    }

    if (requestUrl.pathname === '/api/deliveries/replay' && request.method === 'POST') {
      return sendJson(response, 201, await deliveries.replayDelivery(await readJsonBody(request)));
    }

    const rerunJobMatch = /^\/api\/inference\/jobs\/([^/]+)\/rerun$/u.exec(requestUrl.pathname);
    if (rerunJobMatch && request.method === 'POST') {
      return sendJson(response, 201, await inference.rerunInferenceJob(decodeURIComponent(rerunJobMatch[1])));
    }

    const cancelJobMatch = /^\/api\/inference\/jobs\/([^/]+)\/cancel$/u.exec(requestUrl.pathname);
    if (cancelJobMatch && request.method === 'POST') {
      return sendJson(response, 200, await inference.cancelInferenceJob(decodeURIComponent(cancelJobMatch[1])));
    }

    if (requestUrl.pathname.startsWith('/api/inference/jobs/') && request.method === 'GET') {
      const jobId = requestUrl.pathname.slice('/api/inference/jobs/'.length);
      const job = await inference.getInferenceJob(jobId);
      if (!job) {
        sendJson(response, 404, { error: '找不到推論工作。' });
        return;
      }
      return sendJson(response, 200, job);
    }

    if (requestUrl.pathname === '/api/config/output-dir' && request.method === 'POST') {
      const body = await readJsonBody(request);
      outputDir = normalizeOutputDir(body.outputDir || outputDir);
      await library.ensureOutputDir();
      return sendJson(response, 200, {
        ok: true,
        outputDir,
        items: await library.listVideos(),
      });
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'GET') {
      return sendJson(response, 200, await library.listVideos());
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'POST') {
      if (request.headers['content-type'] === 'application/octet-stream') {
        return sendJson(response, 201, await library.saveStreamedVideoAsset(request));
      }
      const body = await readJsonBody(request);
      if (!body.item || typeof body.videoBase64 !== 'string') {
        throw new Error('缺少影片資料。');
      }
      return sendJson(response, 201, await library.saveVideoAsset(body.item, body.videoBase64));
    }

    const transcodeMatch = /^\/api\/videos\/([^/]+)\/transcode$/u.exec(requestUrl.pathname);
    if (transcodeMatch && request.method === 'POST') {
      return sendJson(response, 201, await library.transcodeVideoToMp4(decodeURIComponent(transcodeMatch[1])));
    }


    if (requestUrl.pathname.startsWith('/api/videos/')) {
      const encodedName = requestUrl.pathname.slice('/api/videos/'.length);
      const fileName = sanitizeFileName(decodeURIComponent(encodedName));

      if (request.method === 'GET') {
        await library.streamVideo(request, response, requestUrl, fileName);
        return;
      }

      if (request.method === 'PATCH') {
        const body = await readJsonBody(request);
        return sendJson(response, 200, await library.renameVideo(fileName, sanitizeFileName(body.nextFileName)));
      }

      if (request.method === 'DELETE') {
        await library.deleteVideo(fileName);
        return sendJson(response, 200, { ok: true });
      }
    }

    return false;
  }

  async function handleStatic(request, response, requestUrl) {
    const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    const targetPath = path.normalize(path.join(ROOT_DIR, pathname));
    const relativePath = path.relative(ROOT_DIR, targetPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      sendText(response, 403, 'Forbidden');
      return;
    }

    try {
      const stats = await fs.stat(targetPath);
      if (stats.isDirectory()) {
        sendText(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, { 'content-type': getContentType(targetPath) });
      response.end(await fs.readFile(targetPath));
    } catch {
      sendText(response, 404, 'Not found');
    }
  }

  // The API has no login, so only accept requests addressed to an allowed host name
  // (blocks DNS rebinding) and refuse state-changing requests from other origins (blocks CSRF).
  function guardRequest(request) {
    const hostHeader = String(request.headers.host || '').toLowerCase();
    const hostname = readHostname(hostHeader);
    if (!allowedHostnames.has(hostname)) {
      throw createRequestError(
        `不允許的 Host：${hostname || '（空白）'}。若需從其他主機名稱存取，請設定 VEDIO_FACTORY_ALLOWED_HOSTS。`,
        403,
      );
    }
    const { origin } = request.headers;
    if (SAFE_METHODS.has(request.method) || origin === undefined) return;
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = '';
    }
    if (originHost !== hostHeader) {
      throw createRequestError('拒絕跨來源請求。', 403);
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      guardRequest(request);
      const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
      if (requestUrl.pathname.startsWith('/scenario-modules/') && request.method === 'GET') {
        await workflows.serveScenarioModuleAsset(response, requestUrl);
        return;
      }
      if (requestUrl.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, requestUrl);
        if (handled === false) {
          sendText(response, 404, 'Not found');
        }
        return;
      }

      await handleStatic(request, response, requestUrl);
    } catch (error) {
      if (response.destroyed) return;
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(response, statusCode, { error: error.message || 'Request failed' });
    }
  });

  return {
    server,
    modelInstaller,
    getOutputDir: () => outputDir,
    setOutputDir(nextOutputDir) {
      outputDir = normalizeOutputDir(nextOutputDir);
      return outputDir;
    },
  };
}

async function startServer(options = {}) {
  const app = createApp(options);
  await fs.mkdir(app.getOutputDir(), { recursive: true });
  await new Promise((resolve) => app.server.listen(options.port ?? PORT, options.host ?? HOST, resolve));
  return app;
}

if (require.main === module) {
  startServer().then((app) => {
    const address = app.server.address();
    console.log(`vedioFactory server running at http://${address.address}:${address.port}`);
    console.log(`output directory: ${app.getOutputDir()}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  startServer,
  DEFAULT_OUTPUT_DIR,
};
