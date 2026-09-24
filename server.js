const http = require('node:http');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const ROOT_DIR = __dirname;
const DEFAULT_OUTPUT_DIR = path.resolve(
  process.env.VEDIO_FACTORY_OUTPUT_DIR || path.join(os.homedir(), 'Videos', 'vedioFactory'),
);
const DEFAULT_MODEL_DIR = path.resolve(
  process.env.VEDIO_FACTORY_MODEL_DIR || path.join(os.homedir(), 'vedioFactory', 'models'),
);
const MAX_JSON_BODY = 80 * 1024 * 1024;
const INFERENCE_JOBS_DIR_NAME = 'inference-jobs';
const MODEL_SETUP_DIR_NAME = 'model-setup';

const MODEL_CATALOG = [
  {
    id: 'sdxl',
    name: 'SDXL',
    category: 'image-generation',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 1,
    recommended: true,
    bestFor: ['文生圖', '圖生圖', 'ControlNet 擴充'],
    notes: '作為首幀、關鍵影格與風格基底模型。',
    windowsProfile: {
      runtime: 'ComfyUI / ONNX / Diffusers',
      vramHint: '建議 8GB+ VRAM',
    },
  },
  {
    id: 'animatediff',
    name: 'AnimateDiff',
    category: 'image-to-video',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 2,
    recommended: true,
    bestFor: ['照片轉短片', '鏡頭微動態', '角色動畫延展'],
    notes: '承接 SDXL 或 SD 影像輸出，補上短片運動能力。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '建議 10GB+ VRAM',
    },
  },
  {
    id: 'realesrgan',
    name: 'Real-ESRGAN',
    category: 'upscaling',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 3,
    recommended: true,
    bestFor: ['放大', '修復細節', '輸出畫質增強'],
    notes: '作為影片與單張影格後處理。',
    windowsProfile: {
      runtime: 'NCNN / PyTorch',
      vramHint: '建議 4GB+ VRAM',
    },
  },
  {
    id: 'rife',
    name: 'RIFE',
    category: 'frame-interpolation',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 4,
    recommended: true,
    bestFor: ['補幀', '提昇流暢度', '延長片段'],
    notes: '搭配 AnimateDiff 或既有影片片段提高 FPS。',
    windowsProfile: {
      runtime: 'NCNN / PyTorch',
      vramHint: '建議 6GB+ VRAM',
    },
  },
  {
    id: 'wan-2.1',
    name: 'Wan 2.1',
    category: 'video-generation',
    batch: 'advanced',
    status: 'planned',
    priority: 5,
    recommended: true,
    bestFor: ['高品質文生影片', '圖生影片'],
    notes: '適合正式導入為主力影片模型。',
    windowsProfile: {
      runtime: 'ComfyUI / Python pipeline',
      vramHint: '建議 12GB+ VRAM',
    },
  },
  {
    id: 'cogvideox',
    name: 'CogVideoX',
    category: 'video-generation',
    batch: 'advanced',
    status: 'planned',
    priority: 6,
    recommended: true,
    bestFor: ['文生影片', '長鏡頭生成'],
    notes: '可作為 Wan 2.1 之外的另一條主力影片路線。',
    windowsProfile: {
      runtime: 'Python pipeline',
      vramHint: '建議 12GB+ VRAM',
    },
  },
  {
    id: 'controlnet',
    name: 'ControlNet',
    category: 'conditioning',
    batch: 'advanced',
    status: 'planned',
    priority: 7,
    recommended: true,
    bestFor: ['姿勢控制', '構圖控制', '邊緣控制'],
    notes: '通常與 SDXL / FLUX 搭配。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '依主模型而定',
    },
  },
  {
    id: 'ip-adapter',
    name: 'IP-Adapter',
    category: 'conditioning',
    batch: 'advanced',
    status: 'planned',
    priority: 8,
    recommended: true,
    bestFor: ['參考圖一致性', '人物產品特徵保持'],
    notes: '很適合照片導向工作流。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '依主模型而定',
    },
  },
];

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(payload);
}

function getContentType(filePath) {
  return contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function normalizeOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new Error('請提供輸出資料夾路徑。');
  }

  const resolved = path.resolve(outputDir.trim());
  if (!path.isAbsolute(resolved)) {
    throw new Error('輸出資料夾必須是絕對路徑。');
  }

  return resolved;
}

function sanitizeFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('缺少檔名。');
  }

  const normalized = path.basename(fileName.trim()).replace(/[\\/]+/g, '');
  if (!normalized.endsWith('.webm')) {
    throw new Error('影片檔名必須以 .webm 結尾。');
  }

  return normalized;
}

function sanitizePathSegment(value, fallback = 'item') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-z0-9_-]+/giu, '-')
    .replace(/(^-|-$)/gu, '')
    .slice(0, 40) || fallback;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) {
      throw new Error('請求內容過大。');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON 格式錯誤。');
  }
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function getLocalEngineConfig() {
  let args = [];
  if (process.env.VEDIO_FACTORY_LOCAL_ENGINE_ARGS) {
    try {
      const parsed = JSON.parse(process.env.VEDIO_FACTORY_LOCAL_ENGINE_ARGS);
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error('invalid args');
      }
      args = parsed;
    } catch {
      args = [process.env.VEDIO_FACTORY_LOCAL_ENGINE_ARGS];
    }
  }

  return {
    provider: 'local-nvidia-cuda',
    command: process.env.VEDIO_FACTORY_LOCAL_ENGINE_COMMAND || '',
    args,
    modelDir: DEFAULT_MODEL_DIR,
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
    const [name = '', driverVersion = '', memoryTotal = ''] = firstLine.split(',').map((item) => item.trim());
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

async function getInferenceRuntime(outputDir) {
  const engine = getLocalEngineConfig();
  const gpu = await detectNvidiaRuntime();
  return {
    provider: engine.provider,
    localGpuPreferred: true,
    platform: process.platform,
    outputDir,
    modelDir: engine.modelDir,
    engineCommandConfigured: Boolean(engine.command),
    engineCommand: engine.command,
    engineArgs: engine.args,
    gpu,
    guidance: [
      '建議在 Windows 11 安裝最新 NVIDIA 驅動、CUDA Toolkit 與 Python 3.11。',
      '將未來的本機推論入口指令寫入 VEDIO_FACTORY_LOCAL_ENGINE_COMMAND。',
      `模型權重預設放在 ${engine.modelDir}。`,
    ],
  };
}

function getCurrentProjectModelStatus() {
  return {
    actualIntegratedModels: [],
    visualModules: [
      { id: 'cinematic-motion', type: 'canvas-module' },
      { id: 'storyboard-focus', type: 'canvas-module' },
      { id: 'neon-pulse', type: 'canvas-module' },
    ],
    inferenceScaffold: {
      provider: 'local-nvidia-cuda',
      hasRuntimeDetection: true,
      hasJobManifestPersistence: true,
      hasRealModelExecution: false,
    },
  };
}

function buildModelCatalog(modelDir) {
  return {
    generatedAt: new Date().toISOString(),
    currentProjectStatus: getCurrentProjectModelStatus(),
    installRoot: modelDir,
    firstBatchOrder: MODEL_CATALOG.filter((model) => model.batch === 'first-wave')
      .sort((left, right) => left.priority - right.priority)
      .map((model) => model.id),
    models: MODEL_CATALOG.map((model) => ({
      ...model,
      installPath: path.join(modelDir, model.id),
    })),
  };
}

async function collectVideoItems(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.webm.json')) continue;
    try {
      const metadataPath = path.join(outputDir, entry.name);
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      const fileName = sanitizeFileName(metadata.fileName || entry.name.replace(/\.json$/u, ''));
      const videoPath = path.join(outputDir, fileName);
      if (!(await fileExists(videoPath))) continue;
      const stats = await fs.stat(videoPath);
      items.push({
        ...metadata,
        fileName,
        fileSize: stats.size,
        previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
      });
    } catch {
      continue;
    }
  }

  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return items;
}

function createApp(options = {}) {
  let outputDir = normalizeOutputDir(options.outputDir || DEFAULT_OUTPUT_DIR);

  async function ensureOutputDir() {
    await fs.mkdir(outputDir, { recursive: true });
  }

  async function ensureInferenceJobDir() {
    await fs.mkdir(path.join(outputDir, INFERENCE_JOBS_DIR_NAME), { recursive: true });
  }

  async function ensureModelSetupDir() {
    await fs.mkdir(path.join(outputDir, MODEL_SETUP_DIR_NAME), { recursive: true });
  }

  async function listInferenceJobs() {
    await ensureInferenceJobDir();
    const jobsDir = path.join(outputDir, INFERENCE_JOBS_DIR_NAME);
    const entries = await fs.readdir(jobsDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(await fs.readFile(path.join(jobsDir, entry.name), 'utf8'));
        jobs.push(payload);
      } catch {
        continue;
      }
    }
    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return jobs;
  }

  async function getInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    return jobs.find((item) => item.id === jobId) || null;
  }

  async function createModelSetupBatch() {
    await ensureOutputDir();
    await ensureModelSetupDir();
    const runtime = await getInferenceRuntime(outputDir);
    const catalog = buildModelCatalog(runtime.modelDir);
    const requestToken = crypto.randomUUID();
    const manifests = [];

    for (const model of catalog.models.filter((item) => item.batch === 'first-wave')) {
      const manifest = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        modelId: model.id,
        name: model.name,
        category: model.category,
        installPath: model.installPath,
        provider: runtime.provider,
        status: 'scaffolded',
        nextAction: '準備模型權重、推論節點與本機命令整合',
        recommendedFor: model.bestFor,
      };
      const manifestPath = path.join(outputDir, MODEL_SETUP_DIR_NAME, `${Date.now()}-${requestToken}-${model.id}.json`);
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, manifestPath }, null, 2));
      manifests.push({ ...manifest, manifestPath });
    }

    return {
      provider: runtime.provider,
      outputDir,
      installRoot: catalog.installRoot,
      firstBatchModels: manifests,
    };
  }

  async function saveVideoAsset(item, videoBase64) {
    const fileName = sanitizeFileName(item.fileName);
    const videoPath = path.join(outputDir, fileName);
    const metadataPath = path.join(outputDir, `${fileName}.json`);
    const buffer = Buffer.from(videoBase64, 'base64');
    const persistedItem = {
      ...item,
      fileName,
    };

    await ensureOutputDir();
    await fs.writeFile(videoPath, buffer);
    await fs.writeFile(metadataPath, JSON.stringify(persistedItem, null, 2));

    return {
      ...persistedItem,
      fileSize: buffer.length,
      previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
    };
  }

  async function createInferenceJob(payload) {
    await ensureOutputDir();
    await ensureInferenceJobDir();

    const runtime = await getInferenceRuntime(outputDir);
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: runtime.engineCommandConfigured ? 'queued' : 'scaffolded',
      provider: runtime.provider,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: payload.prompt || '',
      story: payload.story || '',
      moduleId: payload.moduleId || '',
      settings: payload.settings || {},
      sourceImageDataUrl: payload.sourceImageDataUrl || '',
      modelDir: runtime.modelDir,
      engineCommandConfigured: runtime.engineCommandConfigured,
      engineCommand: runtime.engineCommand,
      engineArgs: runtime.engineArgs,
      guidance: runtime.engineCommandConfigured
        ? '已偵測到本機推論命令，可在後續版本接上真正模型執行流程。'
        : '尚未設定本機推論命令。請先設定 VEDIO_FACTORY_LOCAL_ENGINE_COMMAND 與模型目錄。',
      manifestPath: path.join(
        outputDir,
        INFERENCE_JOBS_DIR_NAME,
        `${Date.now()}-${jobId}-${sanitizePathSegment(payload.moduleId, 'job')}.json`,
      ),
    };

    await fs.writeFile(job.manifestPath, JSON.stringify(job, null, 2));
    return job;
  }

  async function handleApi(request, response, requestUrl) {
    if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, { ok: true });
    }

    if (requestUrl.pathname === '/api/config' && request.method === 'GET') {
      await ensureOutputDir();
      return sendJson(response, 200, {
        backendAvailable: true,
        outputDir,
        storageMode: 'backend',
        localGpuPreferred: true,
      });
    }

    if (requestUrl.pathname === '/api/inference/runtime' && request.method === 'GET') {
      await ensureOutputDir();
      return sendJson(response, 200, await getInferenceRuntime(outputDir));
    }

    if (requestUrl.pathname === '/api/models/catalog' && request.method === 'GET') {
      const runtime = await getInferenceRuntime(outputDir);
      return sendJson(response, 200, buildModelCatalog(runtime.modelDir));
    }

    if (requestUrl.pathname === '/api/models/setup-batch' && request.method === 'POST') {
      return sendJson(response, 201, await createModelSetupBatch());
    }

    if (requestUrl.pathname === '/api/inference/jobs' && request.method === 'GET') {
      return sendJson(response, 200, await listInferenceJobs());
    }

    if (requestUrl.pathname === '/api/inference/jobs' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return sendJson(response, 201, await createInferenceJob(body));
    }

    if (requestUrl.pathname.startsWith('/api/inference/jobs/') && request.method === 'GET') {
      const jobId = requestUrl.pathname.slice('/api/inference/jobs/'.length);
      const job = await getInferenceJob(jobId);
      if (!job) {
        sendJson(response, 404, { error: '找不到推論工作。' });
        return;
      }
      return sendJson(response, 200, job);
    }

    if (requestUrl.pathname === '/api/config/output-dir' && request.method === 'POST') {
      const body = await readJsonBody(request);
      outputDir = normalizeOutputDir(body.outputDir || outputDir);
      await ensureOutputDir();
      return sendJson(response, 200, {
        ok: true,
        outputDir,
        items: await collectVideoItems(outputDir),
      });
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'GET') {
      return sendJson(response, 200, await collectVideoItems(outputDir));
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.item || typeof body.videoBase64 !== 'string') {
        throw new Error('缺少影片資料。');
      }
      return sendJson(response, 201, await saveVideoAsset(body.item, body.videoBase64));
    }

    if (requestUrl.pathname.startsWith('/api/videos/')) {
      const encodedName = requestUrl.pathname.slice('/api/videos/'.length);
      const fileName = sanitizeFileName(decodeURIComponent(encodedName));
      const videoPath = path.join(outputDir, fileName);
      const metadataPath = path.join(outputDir, `${fileName}.json`);

      if (request.method === 'GET') {
        if (!(await fileExists(videoPath))) {
          return sendText(response, 404, 'Not found');
        }
        const headers = { 'content-type': 'video/webm' };
        if (requestUrl.searchParams.get('download') === '1') {
          headers['content-disposition'] = `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
        }
        response.writeHead(200, headers);
        response.end(await fs.readFile(videoPath));
        return;
      }

      if (request.method === 'PATCH') {
        const body = await readJsonBody(request);
        const nextFileName = sanitizeFileName(body.nextFileName);
        if (nextFileName === fileName) {
          const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
          return sendJson(response, 200, {
            ...metadata,
            fileName,
            previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
          });
        }
        const nextVideoPath = path.join(outputDir, nextFileName);
        const nextMetadataPath = path.join(outputDir, `${nextFileName}.json`);
        if (!(await fileExists(videoPath)) || !(await fileExists(metadataPath))) {
          sendJson(response, 404, { error: '找不到要重新命名的影片。' });
          return;
        }
        if ((await fileExists(nextVideoPath)) || (await fileExists(nextMetadataPath))) {
          sendJson(response, 409, { error: '目標檔名已存在。' });
          return;
        }
        const originalMetadataText = await fs.readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(originalMetadataText);
        metadata.fileName = nextFileName;
        metadata.updatedAt = new Date().toISOString();
        await fs.rename(videoPath, nextVideoPath);
        try {
          await fs.rename(metadataPath, nextMetadataPath).catch(async () => {
            await fs.writeFile(nextMetadataPath, JSON.stringify(metadata, null, 2));
            await fs.rm(metadataPath, { force: true });
          });
          await fs.writeFile(nextMetadataPath, JSON.stringify(metadata, null, 2));
        } catch (error) {
          await fs.rename(nextVideoPath, videoPath).catch(() => undefined);
          if (await fileExists(nextMetadataPath)) {
            await fs.rename(nextMetadataPath, metadataPath).catch(async () => {
              await fs.writeFile(metadataPath, originalMetadataText);
              await fs.rm(nextMetadataPath, { force: true });
            });
          } else if (!(await fileExists(metadataPath))) {
            await fs.writeFile(metadataPath, originalMetadataText).catch(() => undefined);
          }
          throw error;
        }
        return sendJson(response, 200, {
          ...metadata,
          previewUrl: `/api/videos/${encodeURIComponent(nextFileName)}`,
        });
      }

      if (request.method === 'DELETE') {
        await fs.rm(videoPath, { force: true });
        await fs.rm(metadataPath, { force: true });
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

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
      if (requestUrl.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, requestUrl);
        if (handled === false) {
          sendText(response, 404, 'Not found');
        }
        return;
      }

      await handleStatic(request, response, requestUrl);
    } catch (error) {
      sendJson(response, 400, { error: error.message || 'Request failed' });
    }
  });

  return {
    server,
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
  await new Promise((resolve) => app.server.listen(options.port || PORT, options.host || HOST, resolve));
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
