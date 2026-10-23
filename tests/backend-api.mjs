import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startServer } = require('../server.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function createVideoUploadBody(metadata, videoBytes) {
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const metadataLength = Buffer.alloc(4);
  metadataLength.writeUInt32BE(metadataBytes.length);
  return Buffer.concat([metadataLength, metadataBytes, videoBytes]);
}

// A stand-in for civitai.com's API and download endpoints.
async function startMockCivitai() {
  const modelBytes = Buffer.from('fake-safetensors-weights');
  const sha256 = crypto.createHash('sha256').update(modelBytes).digest('hex').toUpperCase();
  let origin = '';
  const file = (name, versionId, overrides = {}) => ({
    name,
    type: 'Model',
    sizeKB: modelBytes.length / 1024,
    primary: true,
    metadata: { format: name.endsWith('.safetensors') ? 'SafeTensor' : 'PickleTensor' },
    pickleScanResult: 'Success',
    virusScanResult: 'Success',
    hashes: { SHA256: sha256 },
    downloadUrl: `${origin}/api/download/models/${versionId}`,
    ...overrides,
  });
  const model = (id, overrides = {}, fileName = `model-${id}.safetensors`) => ({
    id,
    name: `測試模型 ${id}`,
    type: 'LORA',
    nsfw: false,
    poi: false,
    minor: false,
    allowCommercialUse: ['Image', 'Rent'],
    allowNoCredit: true,
    allowDerivatives: true,
    ...overrides,
    modelVersions: [{ id: id + 100, name: 'v1', baseModel: 'Wan Video 2.2 TI2V-5B', trainedWords: ['tst'], files: [file(fileName, id + 100)] }],
  });
  const models = {
    100: model(100),
    101: model(101, { nsfw: true }),
    102: model(102, { poi: true }),
    103: model(103, {}, 'old-format.ckpt'),
    104: model(104),
    105: model(105, { allowCommercialUse: ['None'] }),
    106: model(106, { type: 'Workflows' }),
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    const modelMatch = /^\/api\/v1\/models\/(\d+)$/u.exec(url.pathname);
    const versionMatch = /^\/api\/v1\/model-versions\/(\d+)$/u.exec(url.pathname);
    const downloadMatch = /^\/api\/download\/models\/(\d+)$/u.exec(url.pathname);
    if (modelMatch && models[modelMatch[1]]) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(models[modelMatch[1]]));
    } else if (versionMatch && Number(versionMatch[1]) === 200) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ...models[100].modelVersions[0], modelId: 100 }));
    } else if (downloadMatch && downloadMatch[1] === '200') {
      response.writeHead(302, { location: `${origin}/cdn/model-200.bin` });
      response.end();
    } else if (url.pathname === '/cdn/model-200.bin' || (downloadMatch && downloadMatch[1] === '205')) {
      response.writeHead(200, { 'content-length': String(modelBytes.length) });
      response.end(modelBytes);
    } else if (downloadMatch && downloadMatch[1] === '204') {
      response.end('tampered-content');
    } else if (downloadMatch && downloadMatch[1] === '206') {
      response.writeHead(401);
      response.end();
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const item of Object.values(models)) {
    item.modelVersions[0].files[0].downloadUrl = `${origin}/api/download/models/${item.modelVersions[0].id}`;
  }
  models[106].modelVersions[0].files[0].downloadUrl = `${origin}/api/download/models/206`;
  models[106].type = 'LORA';
  return { server, origin, modelBytes };
}

async function main() {
  const managedOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-api-'));
  const civitai = await startMockCivitai();
  const comfyModelsDir = path.join(managedOutputDir, 'comfy-models');
  await fs.mkdir(comfyModelsDir);
  const app = await startServer({
    comfyUIModelsDir: comfyModelsDir,
    civitaiOrigin: civitai.origin,
    port: 0,
    host: '127.0.0.1',
    outputDir: managedOutputDir,
    dataDir: path.join(managedOutputDir, 'app-data'),
    workflowsDir: path.join(managedOutputDir, 'no-workflows'),
    modulesDir: path.join(managedOutputDir, 'no-modules'),
    ffmpegCommand: [path.join(managedOutputDir, 'missing-ffmpeg.exe')],
    maxVideoUploadBytes: 1024,
  });
  const address = app.server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const config = await fetch(`${origin}/api/config`).then((response) => response.json());
    assert.equal(config.backendAvailable, true);
    assert.deepEqual(config.ffmpeg, { available: false, version: '' });
    assert.equal(config.outputDir, managedOutputDir);

    const runtime = await fetch(`${origin}/api/inference/runtime`).then((response) => response.json());
    assert.equal(runtime.provider, 'comfyui-local');
    assert.equal(runtime.localGpuPreferred, true);
    assert.equal(runtime.outputDir, managedOutputDir);
    assert.ok(Array.isArray(runtime.guidance));
    const dockerHostApp = await startServer({
      port: 0,
      host: '127.0.0.1',
      outputDir: managedOutputDir,
      comfyUIUrl: 'http://host.docker.internal:8188',
      allowedHosts: ['studio.local'],
    });
    try {
      const lanPort = dockerHostApp.server.address().port;
      const lanHealth = await rawRequest(`http://127.0.0.1:${lanPort}/api/health`, { headers: { host: `studio.local:${lanPort}` } });
      assert.equal(lanHealth.status, 200);
      const otherLanHost = await rawRequest(`http://127.0.0.1:${lanPort}/api/health`, { headers: { host: `other.local:${lanPort}` } });
      assert.equal(otherLanHost.status, 403);
      const dockerHostRuntime = await fetch(
        `http://127.0.0.1:${dockerHostApp.server.address().port}/api/inference/runtime`,
      ).then((response) => response.json());
      assert.equal(dockerHostRuntime.comfyUI.url, 'http://host.docker.internal:8188');
    } finally {
      await new Promise((resolve, reject) => dockerHostApp.server.close((error) => error ? reject(error) : resolve()));
    }
    // Request guards: DNS-rebinding Host check and cross-origin write rejection.
    const port = address.port;
    const reboundHost = await rawRequest(`${origin}/api/config`, { headers: { host: `attacker.example:${port}` } });
    assert.equal(reboundHost.status, 403);
    assert.match(JSON.parse(reboundHost.body).error, /VEDIO_FACTORY_ALLOWED_HOSTS/);
    assert.equal((await rawRequest(`${origin}/`, { headers: { host: `attacker.example:${port}` } })).status, 403);
    assert.equal((await rawRequest(`${origin}/api/health`, { headers: { host: `localhost:${port}` } })).status, 200);
    const crossOriginWrite = await rawRequest(`${origin}/api/config/output-dir`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://attacker.example' },
      body: JSON.stringify({ outputDir: path.join(managedOutputDir, 'hijacked') }),
    });
    assert.equal(crossOriginWrite.status, 403);
    assert.equal((await fetch(`${origin}/api/config`).then((response) => response.json())).outputDir, managedOutputDir);
    const nullOriginWrite = await rawRequest(`${origin}/api/presets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(nullOriginWrite.status, 403);
    const otherPortWrite = await rawRequest(`${origin}/api/presets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port + 1}` },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(otherPortWrite.status, 403);
    const crossOriginRead = await rawRequest(`${origin}/api/health`, { headers: { origin: 'http://attacker.example' } });
    assert.equal(crossOriginRead.status, 200);
    const sameOriginWrite = await rawRequest(`${origin}/api/inference/workflow-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{}',
    });
    assert.equal(sameOriginWrite.status, 200);

    const unconfiguredWorkflow = await fetch(`${origin}/api/inference/workflow-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((response) => response.json());
    assert.equal(unconfiguredWorkflow.configured, false);
    assert.equal(unconfiguredWorkflow.ready, false);

    const catalog = await fetch(`${origin}/api/models/catalog`).then((response) => response.json());
    assert.equal(catalog.currentProjectStatus.actualIntegratedModels.length, 0);
    assert.equal(catalog.currentProjectStatus.inferenceScaffold.hasComfyUIWorkflowExecution, true);
    assert.equal(catalog.currentProjectStatus.inferenceScaffold.hasIntegratedModelWeights, false);
    assert.deepEqual(catalog.firstBatchOrder, ['sdxl', 'animatediff', 'realesrgan', 'rife']);
    assert.equal(catalog.models.some((model) => model.id === 'sdxl'), true);
    assert.equal(catalog.videoModels.length, 10);
    assert.deepEqual(catalog.videoModels.map((model) => model.priority), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(catalog.videoModels.slice(0, 3).map((model) => model.id), [
      'wan-2.2-ti2v-5b',
      'framepack-f1',
      'wan-2.1-t2v-1.3b',
    ]);
    assert.ok(catalog.videoModels.every((model) => model.sourceUrl && model.taskTypes.length));

    const setupBatch = await fetch(`${origin}/api/models/setup-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((response) => response.json());
    assert.equal(setupBatch.firstBatchModels.length, 4);
    assert.equal(setupBatch.provider, 'comfyui-local');
    assert.equal(setupBatch.installRoot, catalog.installRoot);
    assert.deepEqual(setupBatch.firstBatchModels.map((model) => model.modelId), ['sdxl', 'animatediff', 'realesrgan', 'rife']);
    for (const manifest of setupBatch.firstBatchModels) {
      assert.match(manifest.manifestPath, /model-setup/);
      const setupManifestText = await fs.readFile(manifest.manifestPath, 'utf8');
      assert.match(setupManifestText, new RegExp(manifest.modelId));
      assert.match(setupManifestText, /comfyui-local/);
      assert.ok(JSON.parse(setupManifestText).installPath.startsWith(catalog.installRoot));
    }
    const setupBatchAgain = await fetch(`${origin}/api/models/setup-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((response) => response.json());
    assert.equal(setupBatchAgain.firstBatchModels.length, 4);
    assert.equal(new Set(setupBatchAgain.firstBatchModels.map((model) => model.manifestPath)).size, 4);
    assert.equal(setupBatchAgain.firstBatchModels.some((model, index) => model.manifestPath === setupBatch.firstBatchModels[index].manifestPath), false);
    const concurrentBatches = await Promise.all([
      fetch(`${origin}/api/models/setup-batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }).then((response) => response.json()),
      fetch(`${origin}/api/models/setup-batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }).then((response) => response.json()),
    ]);
    const concurrentManifestPaths = concurrentBatches.flatMap((batch) => batch.firstBatchModels.map((model) => model.manifestPath));
    assert.equal(new Set(concurrentManifestPaths).size, 8);

    const item = {
      id: 'api-test-id',
      fileName: 'api-test.webm',
      moduleId: 'storyboard-focus',
      moduleName: 'Storyboard Focus',
      prompt: '測試影片',
      story: '後端儲存流程測試',
      duration: 2,
      fps: 24,
      resolution: '1280x720',
      width: 1280,
      height: 720,
      quality: 'balanced',
      motion: 55,
      captionStrength: 65,
      sourceImageDataUrl: '',
      createdAt: new Date().toISOString(),
    };

    const created = await fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item,
        videoBase64: Buffer.from('fake-webm-content').toString('base64'),
      }),
    }).then((response) => response.json());
    assert.equal(created.fileName, item.fileName);

    const binaryItem = { ...item, id: 'binary-upload-id', fileName: 'binary-upload.webm' };
    const binaryCreatedResponse = await fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: createVideoUploadBody(binaryItem, Buffer.from('streamed-webm-content')),
    });
    assert.equal(binaryCreatedResponse.status, 201);
    const binaryCreated = await binaryCreatedResponse.json();
    assert.equal(binaryCreated.fileSize, Buffer.byteLength('streamed-webm-content'));
    assert.equal(await fs.readFile(path.join(managedOutputDir, binaryItem.fileName), 'utf8'), 'streamed-webm-content');

    const oversizedResponse = await fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: createVideoUploadBody({ ...item, fileName: 'oversized.webm' }, Buffer.alloc(1025)),
    });
    assert.equal(oversizedResponse.status, 413);
    assert.equal(await fs.access(path.join(managedOutputDir, 'oversized.webm')).then(() => true, () => false), false);

    await new Promise((resolve) => {
      const request = http.request(`${origin}/api/videos`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      }, resolve);
      request.on('error', resolve);
      const metadataBytes = Buffer.from(JSON.stringify({ ...item, fileName: 'interrupted.webm' }));
      const metadataLength = Buffer.alloc(4);
      metadataLength.writeUInt32BE(metadataBytes.length);
      request.write(Buffer.concat([metadataLength, metadataBytes, Buffer.from('partial')]));
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 10);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fs.readdir(managedOutputDir)).some((name) => name.endsWith('.upload')), false);
    assert.equal(await fs.access(path.join(managedOutputDir, 'interrupted.webm')).then(() => true, () => false), false);

    const invalidMetadataResponse = await fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: createVideoUploadBody({ ...item, duration: 'long' }, Buffer.from('invalid-metadata-video')),
    });
    assert.equal(invalidMetadataResponse.status, 400);
    assert.equal((await invalidMetadataResponse.json()).error.includes('duration'), true);
    assert.equal((await fs.readdir(managedOutputDir)).some((name) => name.endsWith('.upload')), false);

    const listed = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(listed.length, 2);
    assert.ok(listed.some((entry) => entry.fileName === item.fileName));
    assert.ok(listed.some((entry) => entry.fileName === binaryItem.fileName));
    assert.match(listed.find((entry) => entry.fileName === item.fileName).previewUrl, /\/api\/videos\/api-test\.webm/);

    await fs.writeFile(path.join(managedOutputDir, 'broken.webm.json'), '{');
    await fs.writeFile(path.join(managedOutputDir, 'orphan.webm.json'), JSON.stringify({
      ...item,
      fileName: 'orphan.webm',
    }, null, 2));
    const stillListed = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(stillListed.length, 2);

    const renamed = await fetch(`${origin}/api/videos/${encodeURIComponent(item.fileName)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nextFileName: 'api-test-renamed.webm' }),
    }).then((response) => response.json());
    assert.equal(renamed.fileName, 'api-test-renamed.webm');

    const videoPayload = await fetch(`${origin}/api/videos/${encodeURIComponent('api-test-renamed.webm')}`).then((response) => response.arrayBuffer());
    assert.equal(Buffer.from(videoPayload).toString('utf8'), 'fake-webm-content');

    const collisionItems = ['rename-left.webm', 'rename-right.webm'];
    await Promise.all(collisionItems.map((fileName) => fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item: {
          ...item,
          id: fileName,
          fileName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        videoBase64: Buffer.from(fileName).toString('base64'),
      }),
    })));
    const renameRaceResponses = await Promise.all(collisionItems.map((fileName) => fetch(`${origin}/api/videos/${encodeURIComponent(fileName)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nextFileName: 'rename-shared.webm' }),
    })));
    const renameRaceStatuses = renameRaceResponses.map((response) => response.status).sort();
    assert.deepEqual(renameRaceStatuses, [200, 409]);
    const listedAfterRace = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(listedAfterRace.filter((entry) => entry.fileName === 'rename-shared.webm').length, 1);
    await Promise.all([
      'rename-left.webm',
      'rename-right.webm',
      'rename-shared.webm',
    ].map((fileName) => fetch(`${origin}/api/videos/${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
    })));

    const deleted = await fetch(`${origin}/api/videos/${encodeURIComponent('api-test-renamed.webm')}`, {
      method: 'DELETE',
    }).then((response) => response.json());
    assert.equal(deleted.ok, true);
    const deletedBinary = await fetch(`${origin}/api/videos/${encodeURIComponent(binaryItem.fileName)}`, {
      method: 'DELETE',
    }).then((response) => response.json());
    assert.equal(deletedBinary.ok, true);

    // Additional delivery formats: MP4 upload, typed serving, byte ranges, extension-preserving rename.
    const mp4Item = { ...item, id: 'mp4-upload-id', fileName: 'delivery.mp4' };
    const mp4Response = await fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: createVideoUploadBody(mp4Item, Buffer.from('0123456789')),
    });
    assert.equal(mp4Response.status, 201);
    const [listedMp4] = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(listedMp4.fileName, 'delivery.mp4');
    assert.equal(listedMp4.format, 'mp4');
    const mp4Get = await fetch(`${origin}/api/videos/delivery.mp4`);
    assert.equal(mp4Get.headers.get('content-type'), 'video/mp4');
    assert.equal(mp4Get.headers.get('accept-ranges'), 'bytes');
    assert.equal(await mp4Get.text(), '0123456789');
    const rangeGet = await fetch(`${origin}/api/videos/delivery.mp4`, { headers: { range: 'bytes=2-5' } });
    assert.equal(rangeGet.status, 206);
    assert.equal(rangeGet.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await rangeGet.text(), '2345');
    const suffixRangeGet = await fetch(`${origin}/api/videos/delivery.mp4`, { headers: { range: 'bytes=-3' } });
    assert.equal(await suffixRangeGet.text(), '789');
    assert.equal((await fetch(`${origin}/api/videos/delivery.mp4`, { headers: { range: 'bytes=20-30' } })).status, 416);
    const extensionChange = await fetch(`${origin}/api/videos/delivery.mp4`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nextFileName: 'delivery.webm' }),
    });
    assert.equal(extensionChange.status, 400);
    assert.match((await extensionChange.json()).error, /副檔名/);
    const badExtensionResponse = await fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: createVideoUploadBody({ ...item, id: 'txt-id', fileName: 'notes.txt' }, Buffer.from('x')),
    });
    assert.equal(badExtensionResponse.status, 400);
    assert.equal((await fetch(`${origin}/api/videos/delivery.mp4/transcode`, { method: 'POST' })).status, 409);
    await fetch(`${origin}/api/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: createVideoUploadBody({ ...item, id: 'no-ffmpeg-id', fileName: 'no-ffmpeg.webm' }, Buffer.from('x')),
    });
    const noFfmpegResponse = await fetch(`${origin}/api/videos/no-ffmpeg.webm/transcode`, { method: 'POST' });
    assert.equal(noFfmpegResponse.status, 503);
    assert.match((await noFfmpegResponse.json()).error, /ffmpeg/);
    assert.equal((await fetch(`${origin}/api/videos/missing.webm/transcode`, { method: 'POST' })).status, 404);
    await fetch(`${origin}/api/videos/no-ffmpeg.webm`, { method: 'DELETE' });
    assert.equal((await fetch(`${origin}/api/videos/delivery.mp4`, { method: 'DELETE' })).status, 200);

    const inferenceJob = await fetch(`${origin}/api/inference/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '測試本機推論工作',
        story: '建立本機 GPU 推論骨架工作',
        moduleId: 'storyboard-focus',
        videoModelId: 'wan-2.1-t2v-1.3b',
        settings: {
          duration: 2,
          resolution: '1280x720',
        },
      }),
    }).then((response) => response.json());
    assert.equal(inferenceJob.provider, 'comfyui-local');
    assert.equal(inferenceJob.videoModelId, 'wan-2.1-t2v-1.3b');
    assert.match(inferenceJob.status, /queued|scaffolded/);

    const listedJobs = await fetch(`${origin}/api/inference/jobs`).then((response) => response.json());
    assert.equal(listedJobs.length, 1);
    assert.equal(listedJobs[0].id, inferenceJob.id);

    await fs.mkdir(path.join(managedOutputDir, 'inference-jobs'), { recursive: true });
    await fs.writeFile(path.join(managedOutputDir, 'inference-jobs', 'broken.json'), '{');
    const listedJobsAfterBroken = await fetch(`${origin}/api/inference/jobs`).then((response) => response.json());
    assert.equal(listedJobsAfterBroken.length, 1);

    const fetchedJob = await fetch(`${origin}/api/inference/jobs/${inferenceJob.id}`).then((response) => response.json());
    assert.equal(fetchedJob.id, inferenceJob.id);

    const missingJobResponse = await fetch(`${origin}/api/inference/jobs/not-found`);
    assert.equal(missingJobResponse.status, 404);
    const missingJob = await missingJobResponse.json();
    assert.match(missingJob.error, /找不到推論工作/);

    const manifestText = await fs.readFile(inferenceJob.manifestPath, 'utf8');
    assert.match(manifestText, /comfyui-local/);

    const malformedJsonResponse = await fetch(`${origin}/api/inference/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt": ',
    });
    assert.equal(malformedJsonResponse.status, 400);
    const malformedJson = await malformedJsonResponse.json();
    assert.match(malformedJson.error, /JSON 格式錯誤/);
    const unknownVideoModelResponse = await fetch(`${origin}/api/inference/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'unknown model', videoModelId: 'not-a-model' }),
    });
    assert.equal(unknownVideoModelResponse.status, 400);
    for (const invalidSeed of [-1, 1.5, 'abc', Number.MAX_SAFE_INTEGER + 1]) {
      const invalidSeedResponse = await fetch(`${origin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'invalid seed', seed: invalidSeed }),
      });
      assert.equal(invalidSeedResponse.status, 400, String(invalidSeed));
      assert.match((await invalidSeedResponse.json()).error, /seed/);
    }
    const invalidNegativeResponse = await fetch(`${origin}/api/inference/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'invalid negative', negativePrompt: 123 }),
    });
    assert.equal(invalidNegativeResponse.status, 400);
    const scaffoldedRerunResponse = await fetch(`${origin}/api/inference/jobs/${inferenceJob.id}/rerun`, { method: 'POST' });
    assert.equal(scaffoldedRerunResponse.status, 409);
    assert.match((await scaffoldedRerunResponse.json()).error, /快照/);
    const missingRerunResponse = await fetch(`${origin}/api/inference/jobs/not-found/rerun`, { method: 'POST' });
    assert.equal(missingRerunResponse.status, 404);

    assert.deepEqual(await fetch(`${origin}/api/workflows`).then((response) => response.json()), []);
    const baseCapabilities = await fetch(`${origin}/api/capabilities`).then((response) => response.json());
    assert.equal(baseCapabilities.workflowId, '');
    assert.ok(baseCapabilities.resolutions.some((item) => item.value === '1080x1920'));
    assert.deepEqual(baseCapabilities.fps, [12, 16, 24, 25, 30]);
    assert.equal(baseCapabilities.customResolution.enabled, true);
    assert.equal((await fetch(`${origin}/api/capabilities?workflowId=missing`)).status, 404);
    assert.equal((await fetch(`${origin}/api/capabilities?workflowId=..%2Fx`)).status, 400);
    for (const [resolution, expectedStatus] of [['1000x600', 201], ['1001x600', 400], ['8000x600', 400], ['abc', 400]]) {
      const resolutionResponse = await fetch(`${origin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'custom resolution', settings: { resolution } }),
      });
      assert.equal(resolutionResponse.status, expectedStatus, resolution);
      if (expectedStatus === 201) await fs.rm((await resolutionResponse.json()).manifestPath);
      else assert.match((await resolutionResponse.json()).error, /解析度/);
    }

    // Civitai model installs: preview, policy refusals, verified download, no overwrite.
    const postInstall = (url, payload) => fetch(`${origin}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const previewResponse = await postInstall('/api/model-installs/preview', { url: 'https://civitai.com/models/100/test-lora' });
    assert.equal(previewResponse.status, 200);
    const modelPreview = await previewResponse.json();
    assert.equal(modelPreview.folder, 'loras');
    assert.equal(modelPreview.fileName, 'model-100.safetensors');
    assert.equal(modelPreview.license.allowsCommercialOutputs, true);
    assert.deepEqual(modelPreview.trainedWords, ['tst']);
    assert.equal(modelPreview.modelsDirReady, true);
    assert.equal('downloadUrl' in modelPreview, true);
    const versionPreview = await postInstall('/api/model-installs/preview', { url: 'https://civitai.com/api/download/models/200' })
      .then((response) => response.json());
    assert.equal(versionPreview.modelId, 100);
    for (const [url, status, pattern] of [
      ['https://evil.example/models/100', 400, /civitai\.com/],
      ['not a url', 400, /完整/],
      ['https://civitai.com/images/5', 400, /看不懂/],
      ['https://civitai.com/models/101', 403, /成人內容/],
      ['https://civitai.com/models/102', 403, /真實人物/],
      ['https://civitai.com/models/103', 400, /safetensors/],
      ['https://civitai.com/models/999', 404, /找不到/],
    ]) {
      const refused = await postInstall('/api/model-installs/preview', { url });
      assert.equal(refused.status, status, url);
      assert.match((await refused.json()).error, pattern, url);
    }
    const badFolder = await postInstall('/api/model-installs/preview', { url: 'https://civitai.com/models/100', folder: '../system32' });
    assert.equal(badFolder.status, 400);
    const noCommercial = await postInstall('/api/model-installs/preview', { url: 'https://civitai.com/models/105' })
      .then((response) => response.json());
    assert.equal(noCommercial.license.allowsCommercialOutputs, false);

    const installResponse = await postInstall('/api/model-installs', { url: 'https://civitai.com/models/100' });
    assert.equal(installResponse.status, 202);
    const installJob = await installResponse.json();
    assert.equal(installJob.status, 'queued');
    assert.equal('controller' in installJob, false);
    await postInstall('/api/model-installs', { url: 'https://civitai.com/models/104', folder: 'diffusion_models' });
    await postInstall('/api/model-installs', { url: 'https://civitai.com/models/106' });
    await app.modelInstaller.waitForIdle();
    const installs = await fetch(`${origin}/api/model-installs`).then((response) => response.json());
    const byModel = (id) => installs.jobs.find((job) => job.info.modelId === id);
    assert.equal(byModel(100).status, 'installed', JSON.stringify(byModel(100)));
    assert.equal(await fs.readFile(path.join(comfyModelsDir, 'loras', 'model-100.safetensors'), 'utf8'), civitai.modelBytes.toString());
    assert.equal(byModel(104).status, 'failed');
    assert.match(byModel(104).error, /SHA-256/);
    assert.match(byModel(106).error, /VEDIO_FACTORY_CIVITAI_TOKEN/);
    assert.deepEqual(await fs.readdir(path.join(comfyModelsDir, 'diffusion_models')), []);
    assert.equal(installs.installed.length, 1);
    assert.equal(installs.installed[0].fileName, 'model-100.safetensors');
    assert.equal('downloadUrl' in installs.installed[0], false);
    await postInstall('/api/model-installs', { url: 'https://civitai.com/models/100' });
    await app.modelInstaller.waitForIdle();
    const reinstall = (await fetch(`${origin}/api/model-installs`).then((response) => response.json())).jobs[0];
    assert.equal(reinstall.status, 'failed');
    assert.match(reinstall.error, /已存在/);
    assert.equal((await postInstall('/api/model-installs/nope/cancel', {})).status, 404);

    // Parameter presets: CRUD, validation, export/import round trip.
    const presetsDir = path.join(managedOutputDir, 'app-data', 'presets');
    assert.equal(config.presetsDir, presetsDir);
    const postJson = (url, payload, method = 'POST') => fetch(`${origin}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.deepEqual(await fetch(`${origin}/api/presets`).then((response) => response.json()), []);
    const presetPayload = {
      name: 'IG 直式 9:16',
      client: '客戶A',
      project: '春季活動',
      description: '春季活動社群短片',
      promptTemplate: '展示 {product}，畫面結尾出現 {slogan}',
      storyTemplate: '{product} 從遠景推近',
      negativePrompt: 'blurry, watermark',
      moduleId: 'cinematic-motion',
      videoModelId: 'wan-2.1-t2v-1.3b',
      seedMode: 'fixed',
      seed: 7,
      settings: { duration: 6, fps: 24, resolution: '720x1280', quality: 'premium', motion: 40, captionStrength: 50 },
    };
    for (const [invalidPreset, pattern] of [
      [{ ...presetPayload, name: '  ' }, /名稱/],
      [{ ...presetPayload, seed: undefined }, /seed/],
      [{ ...presetPayload, seedMode: 'sometimes' }, /seed 模式/],
      [{ ...presetPayload, videoModelId: 'not-a-model' }, /影片模型/],
      [{ ...presetPayload, settings: { ...presetPayload.settings, fps: 60 } }, /FPS/],
      [{ ...presetPayload, client: 'x'.repeat(101) }, /客戶名稱/],
    ]) {
      const invalidPresetResponse = await postJson('/api/presets', invalidPreset);
      assert.equal(invalidPresetResponse.status, 400);
      assert.match((await invalidPresetResponse.json()).error, pattern);
    }
    const createdPresetResponse = await postJson('/api/presets', presetPayload);
    assert.equal(createdPresetResponse.status, 201);
    const createdPreset = await createdPresetResponse.json();
    assert.match(createdPreset.id, /^[\da-f-]{36}$/u);
    assert.deepEqual(createdPreset.variables, ['product', 'slogan']);
    assert.equal(createdPreset.seed, 7);
    assert.equal(createdPreset.settings.resolution, '720x1280');
    assert.equal(JSON.parse(await fs.readFile(path.join(presetsDir, `${createdPreset.id}.json`), 'utf8')).name, 'IG 直式 9:16');
    await postJson('/api/presets', { ...presetPayload, name: '通用橫式', project: '', seedMode: 'random', seed: 99 });
    await postJson('/api/presets', { ...presetPayload, name: 'B 預設', client: '客戶B' });
    await fs.writeFile(path.join(presetsDir, 'broken.json'), '{');
    await fs.writeFile(path.join(presetsDir, '00000000-0000-0000-0000-000000000000.json'), '{');
    const listedPresets = await fetch(`${origin}/api/presets`).then((response) => response.json());
    assert.deepEqual(listedPresets.map((preset) => preset.name), ['通用橫式', 'IG 直式 9:16', 'B 預設']);
    assert.equal(listedPresets[0].seed, null);

    const updatedPresetResponse = await postJson(`/api/presets/${createdPreset.id}`, { ...presetPayload, name: 'IG 直式 v2' }, 'PUT');
    assert.equal(updatedPresetResponse.status, 200);
    const updatedPreset = await updatedPresetResponse.json();
    assert.equal(updatedPreset.name, 'IG 直式 v2');
    assert.equal(updatedPreset.id, createdPreset.id);
    assert.equal(updatedPreset.createdAt, createdPreset.createdAt);
    assert.equal((await postJson('/api/presets/0f0f0f0f-0000-4000-8000-000000000000', presetPayload, 'PUT')).status, 404);
    assert.equal((await postJson('/api/presets/..%2F..%2Fconfig', presetPayload, 'PUT')).status, 404);

    const exportedPresets = await fetch(`${origin}/api/presets/export`).then((response) => response.json());
    assert.equal(exportedPresets.schemaVersion, 1);
    assert.equal(exportedPresets.presets.length, 3);
    for (const preset of exportedPresets.presets) {
      const deletedPresetResponse = await fetch(`${origin}/api/presets/${preset.id}`, { method: 'DELETE' });
      assert.equal(deletedPresetResponse.status, 200);
    }
    assert.equal((await fetch(`${origin}/api/presets/${createdPreset.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`${origin}/api/presets`).then((response) => response.json())).length, 0);

    const partialImportResponse = await postJson('/api/presets/import', {
      presets: [exportedPresets.presets[0], { ...presetPayload, name: '' }],
    });
    assert.equal(partialImportResponse.status, 400);
    assert.match((await partialImportResponse.json()).error, /第 2 筆/);
    assert.equal((await fetch(`${origin}/api/presets`).then((response) => response.json())).length, 0);

    const importResponse = await postJson('/api/presets/import', exportedPresets);
    assert.equal(importResponse.status, 200);
    assert.equal((await importResponse.json()).imported, 3);
    const reimportedPresets = await fetch(`${origin}/api/presets/export`).then((response) => response.json());
    const withoutUpdatedAt = ({ updatedAt, ...preset }) => preset;
    assert.deepEqual(reimportedPresets.presets.map(withoutUpdatedAt), exportedPresets.presets.map(withoutUpdatedAt));

    const taggedJob = await postJson('/api/inference/jobs', {
      prompt: '客戶專案工作',
      client: '客戶A',
      project: '春季活動',
      presetId: createdPreset.id,
    }).then((response) => response.json());
    assert.equal(taggedJob.client, '客戶A');
    assert.equal(taggedJob.project, '春季活動');
    assert.equal(taggedJob.presetId, createdPreset.id);
    assert.equal((await postJson('/api/inference/jobs', { prompt: 'bad preset', presetId: '../x' })).status, 400);
    await fs.rm(taggedJob.manifestPath);

    const empty = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(empty.length, 0);

    let comfyWorkflow;
    const comfyWorkflows = [];
    let comfyRunning = false;
    let comfyFinished = false;
    let comfyPromptCount = 0;
    let mainPromptAssigned = false;
    let comfyCancelRequested = false;
    let comfyCancelPayload;
    const comfyServer = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/system_stats') {
        response.end(JSON.stringify({}));
      } else if (request.url === '/upload/image' && request.method === 'POST') {
        response.end(JSON.stringify({ name: 'test.png', subfolder: 'upload' }));
      } else if (request.url === '/prompt' && request.method === 'POST') {
        comfyPromptCount += 1;
        comfyWorkflow = JSON.parse(body).prompt;
        comfyWorkflows.push(comfyWorkflow);
        const isMainPrompt = !mainPromptAssigned && JSON.stringify(comfyWorkflow).includes('本機 ComfyUI 測試');
        if (isMainPrompt) mainPromptAssigned = true;
        response.end(JSON.stringify({
          prompt_id: isMainPrompt ? 'comfy-prompt-123' : 'comfy-prompt-cancel',
          number: comfyPromptCount,
        }));
      } else if (request.url === '/queue') {
        if (request.method === 'POST') {
          comfyCancelPayload = JSON.parse(body);
          comfyCancelRequested = true;
          response.end(JSON.stringify({}));
        } else {
          response.end(JSON.stringify({
            queue_running: comfyRunning ? [[0, 'comfy-prompt-123']] : [],
            queue_pending: [
              ...(!comfyRunning && !comfyFinished ? [[0, 'comfy-prompt-123']] : []),
              ...(comfyPromptCount > 1 && !comfyCancelRequested ? [[1, 'comfy-prompt-cancel']] : []),
            ],
          }));
        }
      } else if (request.url === '/history/comfy-prompt-123') {
        response.end(JSON.stringify(comfyFinished ? {
          'comfy-prompt-123': {
            status: { completed: true, status_str: 'success' },
            outputs: {
              '4': { videos: [{ filename: 'generated.webm', type: 'output' }] },
              '6': { gifs: [{ filename: 'generated.mp4', type: 'output', subfolder: '' }] },
              '7': { images: [{ filename: 'frame.png', type: 'output' }] },
            },
          },
        } : comfyRunning ? {
          'comfy-prompt-123': { status: { completed: false, status_str: 'running' }, outputs: {} },
        } : {}));
      } else if (request.url === '/history/comfy-prompt-cancel') {
        response.end(JSON.stringify({}));
      } else if (request.url.startsWith('/view?')) {
        response.setHeader('content-type', 'video/webm');
        response.end('fake-comfy-webm');
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise((resolve) => comfyServer.listen(0, '127.0.0.1', resolve));
    const comfyOrigin = `http://127.0.0.1:${comfyServer.address().port}`;
    const comfyOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-comfy-'));
    const workflowPath = path.join(comfyOutputDir, 'workflow.json');
    const fakeFfmpegPath = path.join(comfyOutputDir, 'fake-ffmpeg.mjs');
    await fs.writeFile(fakeFfmpegPath, `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) {
  console.log('ffmpeg version 9.9-fake');
  process.exit(0);
}
const input = args[args.indexOf('-i') + 1];
if (input.includes('fail')) {
  console.error('fake encoder failure');
  process.exit(1);
}
fs.writeFileSync(args.at(-1), 'MP4:' + fs.readFileSync(input, 'utf8'));
`);
    const workflowsDir = path.join(comfyOutputDir, 'workflows');
    await fs.mkdir(workflowsDir);
    await fs.writeFile(path.join(workflowsDir, 'wan-t2v.json'), JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '2': { class_type: 'KSampler', inputs: { seed: '{{seed}}', width: '{{width}}', height: '{{height}}', fps: '{{fps}}' } },
      '3': { class_type: 'SaveWEBM', inputs: { format: 'webm' } },
    }));
    await fs.writeFile(path.join(workflowsDir, 'wan-t2v.vf.json'), JSON.stringify({
      name: 'Wan 文生影片',
      description: '832x480 原生解析度',
      videoModelIds: ['wan-2.1-t2v-1.3b'],
      resolutions: ['832x480', '480x832'],
      allowCustomResolution: false,
      fps: [16],
      minDuration: 2,
      maxDuration: 5,
      defaults: { resolution: '832x480', fps: 16, duration: 3 },
    }));
    await fs.writeFile(path.join(workflowsDir, 'needs-image.json'), JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '2': { class_type: 'SaveWEBM', inputs: { format: 'webm' } },
    }));
    await fs.writeFile(path.join(workflowsDir, 'needs-image.vf.json'), JSON.stringify({ requiresSourceImage: true }));
    await fs.writeFile(path.join(workflowsDir, 'broken-meta.json'), JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    }));
    await fs.writeFile(path.join(workflowsDir, 'broken-meta.vf.json'), JSON.stringify({ fps: ['fast'] }));
    await fs.writeFile(path.join(workflowsDir, 'invalid id!.json'), '{}');
    const modulesDir = path.join(comfyOutputDir, 'modules');
    const demoModuleDir = path.join(modulesDir, 'demo-dance');
    await fs.mkdir(demoModuleDir, { recursive: true });
    await fs.writeFile(path.join(demoModuleDir, 'preview.js'), 'export function renderFrame() {}\n');
    await fs.writeFile(path.join(demoModuleDir, 'notes.txt'), 'not served');
    await fs.writeFile(path.join(demoModuleDir, 'workflow.json'), JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '2': { class_type: 'Wan22ImageToVideoLatent', inputs: { width: '{{width}}', height: '{{height}}', length: '{{frames}}' } },
      '3': { class_type: 'SaveWEBM', inputs: { fps: '{{fps}}' } },
    }));
    await fs.writeFile(path.join(demoModuleDir, 'module.json'), JSON.stringify({
      id: 'demo-dance',
      name: '示範舞蹈',
      description: '測試用場景模組',
      version: '1.0.0',
      tags: ['人物', '舞蹈'],
      canvas: { entry: 'preview.js', tagline: '舞蹈預覽' },
      workflow: {
        file: 'workflow.json',
        resolutions: ['1280x704', '704x1280'],
        allowCustomResolution: false,
        fps: [24],
        minDuration: 2,
        maxDuration: 5,
        defaults: { resolution: '1280x704', fps: 24, duration: 5 },
      },
      preset: {
        promptTemplate: '{dancer} 在舞台上跳{style}',
        negativePrompt: 'nsfw',
        seedMode: 'fixed',
        seed: 2026,
        settings: { resolution: '1280x704', fps: 24, duration: 5 },
      },
      safety: { requiresPersonConsent: true, notes: '使用真人照片需取得本人同意。' },
    }));
    await fs.mkdir(path.join(modulesDir, '_shared'));
    await fs.mkdir(path.join(modulesDir, 'wrong-id'));
    await fs.writeFile(path.join(modulesDir, 'wrong-id', 'module.json'), JSON.stringify({ id: 'other', name: 'x' }));
    await fs.mkdir(path.join(modulesDir, 'missing-canvas'));
    await fs.writeFile(path.join(modulesDir, 'missing-canvas', 'module.json'), JSON.stringify({
      id: 'missing-canvas', name: '缺檔模組', canvas: { entry: 'nope.js' },
    }));
    const workflowText = JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '2': { class_type: 'ModelLoader', inputs: { model: '{{model_id}}' } },
      '3': { class_type: 'LoadImage', inputs: { image: '{{source_image}}' } },
      '4': { class_type: 'SaveWEBM', inputs: { format: 'webm' } },
      '5': { class_type: 'KSampler', inputs: { seed: '{{seed}}', negative: '{{negative_prompt}}' } },
    });
    await fs.writeFile(workflowPath, workflowText);
    const workflowSha256 = crypto.createHash('sha256').update(workflowText).digest('hex');
    const comfyApp = await startServer({
      port: 0,
      host: '127.0.0.1',
      outputDir: comfyOutputDir,
      dataDir: path.join(comfyOutputDir, 'app-data'),
      workflowsDir,
      modulesDir,
      ffmpegCommand: [process.execPath, fakeFfmpegPath],
      comfyUIUrl: comfyOrigin,
      comfyUIWorkflowPath: workflowPath,
    });
    const comfyAddress = comfyApp.server.address();
    const comfyAppOrigin = `http://127.0.0.1:${comfyAddress.port}`;
    try {
      const comfyRuntime = await fetch(`${comfyAppOrigin}/api/inference/runtime`).then((response) => response.json());
      assert.equal(comfyRuntime.comfyUI.available, true);
      assert.equal(comfyRuntime.comfyUI.workflowConfigured, true);
      assert.equal(comfyRuntime.comfyUI.workflowCount, 5);

      // Scenario modules: discovery, errors, assets, workflow registration and built-in presets.
      const scenarioModules = await fetch(`${comfyAppOrigin}/api/scenario-modules`).then((response) => response.json());
      assert.deepEqual(scenarioModules.map((item) => item.id).sort(), ['demo-dance', 'missing-canvas', 'wrong-id']);
      const demoModule = scenarioModules.find((item) => item.id === 'demo-dance');
      assert.equal(demoModule.error, '');
      assert.equal(demoModule.workflowId, 'module-demo-dance');
      assert.equal(demoModule.presetId, 'module:demo-dance');
      assert.equal(demoModule.canvas.url, '/scenario-modules/demo-dance/preview.js');
      assert.equal(demoModule.canvas.moduleId, 'scenario-demo-dance');
      assert.equal(demoModule.safety.requiresPersonConsent, true);
      assert.equal('manifestPath' in demoModule, false);
      assert.match(scenarioModules.find((item) => item.id === 'wrong-id').error, /資料夾名稱/);
      assert.match(scenarioModules.find((item) => item.id === 'missing-canvas').error, /nope\.js/);
      const previewAsset = await fetch(`${comfyAppOrigin}/scenario-modules/demo-dance/preview.js`);
      assert.equal(previewAsset.status, 200);
      assert.match(previewAsset.headers.get('content-type'), /javascript/);
      assert.equal((await fetch(`${comfyAppOrigin}/scenario-modules/demo-dance/notes.txt`)).status, 404);
      assert.equal((await fetch(`${comfyAppOrigin}/scenario-modules/demo-dance/..%2Fwrong-id%2Fmodule.json`)).status, 404);
      assert.equal((await fetch(`${comfyAppOrigin}/scenario-modules/Demo/preview.js`)).status, 404);
      const moduleCapabilities = await fetch(`${comfyAppOrigin}/api/capabilities?workflowId=module-demo-dance`).then((response) => response.json());
      assert.deepEqual(moduleCapabilities.fps, [24]);
      assert.deepEqual(moduleCapabilities.duration, { min: 2, max: 5 });
      const comfyPresets = await fetch(`${comfyAppOrigin}/api/presets`).then((response) => response.json());
      const modulePreset = comfyPresets.find((preset) => preset.id === 'module:demo-dance');
      assert.equal(modulePreset.builtIn, true);
      assert.equal(modulePreset.name, '示範舞蹈');
      assert.equal(modulePreset.workflowId, 'module-demo-dance');
      assert.equal(modulePreset.moduleId, 'scenario-demo-dance');
      assert.deepEqual(modulePreset.variables, ['dancer', 'style']);
      const exportedComfyPresets = await fetch(`${comfyAppOrigin}/api/presets/export`).then((response) => response.json());
      assert.equal(exportedComfyPresets.presets.some((preset) => preset.id === 'module:demo-dance'), false);
      const editBuiltIn = await fetch(`${comfyAppOrigin}/api/presets/module:demo-dance`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      assert.equal(editBuiltIn.status, 409);
      assert.equal((await fetch(`${comfyAppOrigin}/api/presets/module:demo-dance`, { method: 'DELETE' })).status, 409);
      const moduleJob = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: '示範舞者跳街舞',
          presetId: 'module:demo-dance',
          workflowId: 'module-demo-dance',
          settings: { resolution: '704x1280', fps: 24, duration: 5 },
        }),
      }).then((response) => response.json());
      assert.equal(moduleJob.workflowId, 'module-demo-dance');
      assert.equal(moduleJob.presetId, 'module:demo-dance');
      assert.deepEqual(comfyWorkflows.at(-1)['2'].inputs, { width: 704, height: 1280, length: 121 });
      assert.equal(comfyWorkflows.at(-1)['3'].inputs.fps, 24);
      await fs.rm(moduleJob.manifestPath);

      const workflows = await fetch(`${comfyAppOrigin}/api/workflows`).then((response) => response.json());
      assert.equal(workflows[0].id, 'default');
      assert.deepEqual(
        workflows.map((workflow) => workflow.id).sort(),
        ['broken-meta', 'default', 'module-demo-dance', 'needs-image', 'wan-t2v'],
      );
      assert.equal(workflows.find((workflow) => workflow.id === 'module-demo-dance').scenarioModuleId, 'demo-dance');
      assert.equal(workflows[0].isDefault, true);
      assert.match(workflows.find((workflow) => workflow.id === 'broken-meta').error, /fps/);
      const wanWorkflow = workflows.find((workflow) => workflow.id === 'wan-t2v');
      assert.equal(wanWorkflow.name, 'Wan 文生影片');
      assert.deepEqual(wanWorkflow.videoModelIds, ['wan-2.1-t2v-1.3b']);
      const wanCapabilities = await fetch(`${comfyAppOrigin}/api/capabilities?workflowId=wan-t2v`).then((response) => response.json());
      assert.deepEqual(wanCapabilities.resolutions.map((item) => item.value), ['832x480', '480x832']);
      assert.deepEqual(wanCapabilities.fps, [16]);
      assert.deepEqual(wanCapabilities.duration, { min: 2, max: 5 });
      assert.equal(wanCapabilities.customResolution.enabled, false);
      assert.deepEqual(wanCapabilities.defaults, { resolution: '832x480', fps: 16, duration: 3 });
      assert.equal((await fetch(`${comfyAppOrigin}/api/capabilities?workflowId=broken-meta`)).status, 400);

      const wanRejected = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'wan', workflowId: 'wan-t2v', settings: { resolution: '1280x720', fps: 16, duration: 3 } }),
      });
      assert.equal(wanRejected.status, 400);
      assert.match((await wanRejected.json()).error, /832x480/);
      const wanFpsRejected = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'wan', workflowId: 'wan-t2v', settings: { resolution: '832x480', fps: 24, duration: 3 } }),
      });
      assert.equal(wanFpsRejected.status, 400);
      assert.match((await wanFpsRejected.json()).error, /FPS 僅支援 16/);
      const brokenWorkflowJob = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'broken', workflowId: 'broken-meta' }),
      });
      assert.equal(brokenWorkflowJob.status, 400);
      const missingWorkflowJob = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'missing', workflowId: 'nope' }),
      });
      assert.equal(missingWorkflowJob.status, 404);
      const needsImagePreflight = await fetch(`${comfyAppOrigin}/api/inference/workflow-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'needs-image', videoModelId: 'wan-2.1-t2v-1.3b', hasSourceImage: false }),
      }).then((response) => response.json());
      assert.equal(needsImagePreflight.ready, false);
      assert.equal(needsImagePreflight.workflowId, 'needs-image');
      assert.match(needsImagePreflight.errors.join(' '), /需要來源圖片/);
      const otherModelPreflight = await fetch(`${comfyAppOrigin}/api/inference/workflow-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'wan-t2v', videoModelId: 'ltx-video-098' }),
      }).then((response) => response.json());
      assert.equal(otherModelPreflight.ready, true);
      assert.match(otherModelPreflight.warnings.join(' '), /標示支援的模型/);
      const workflowPromptCount = comfyPromptCount;
      const preflight = await fetch(`${comfyAppOrigin}/api/inference/workflow-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoModelId: 'wan-2.1-t2v-1.3b', hasSourceImage: true }),
      }).then((response) => response.json());
      assert.equal(preflight.ready, true);
      assert.equal(preflight.nodeCount, 5);
      assert.equal(preflight.workflowSha256, workflowSha256);
      assert.deepEqual(preflight.placeholders, ['model_id', 'negative_prompt', 'prompt', 'seed', 'source_image']);
      assert.deepEqual(preflight.videoOutputNodes, [{ id: '4', classType: 'SaveWEBM' }]);
      assert.equal(preflight.warnings.length, 0);
      const noImagePreflight = await fetch(`${comfyAppOrigin}/api/inference/workflow-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoModelId: 'wan-2.1-t2v-1.3b', hasSourceImage: false }),
      }).then((response) => response.json());
      assert.equal(noImagePreflight.ready, false);
      assert.match(noImagePreflight.errors[0], /需要來源圖片/);
      const reproduciblePayload = {
        prompt: '本機 ComfyUI 測試',
        negativePrompt: 'blurry, watermark',
        seed: 42,
        client: '客戶A',
        project: '春季活動',
        moduleId: 'cinematic-motion',
        videoModelId: 'wan-2.1-t2v-1.3b',
        sourceImageDataUrl: 'data:image/png;base64,aGVsbG8=',
        settings: { resolution: '1280x720', duration: 2, fps: 24 },
      };
      const comfyJob = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reproduciblePayload),
      }).then((response) => response.json());
      assert.equal(comfyJob.status, 'queued');
      assert.equal(comfyJob.workflowId, 'default');
      assert.equal(comfyPromptCount, workflowPromptCount + 1);
      assert.equal(comfyJob.comfyPromptId, 'comfy-prompt-123');
      assert.equal(comfyWorkflow['1'].inputs.text, '本機 ComfyUI 測試');
      assert.equal(comfyWorkflow['2'].inputs.model, 'wan-2.1-t2v-1.3b');
      assert.equal(comfyWorkflow['3'].inputs.image, 'upload/test.png');
      assert.equal(comfyWorkflow['5'].inputs.seed, 42);
      assert.equal(comfyWorkflow['5'].inputs.negative, 'blurry, watermark');
      assert.equal(comfyJob.seed, 42);
      assert.equal(comfyJob.seedMode, 'fixed');
      assert.equal(comfyJob.negativePrompt, 'blurry, watermark');
      assert.equal(comfyJob.workflowSha256, workflowSha256);
      assert.deepEqual(comfyJob.submittedWorkflow, comfyWorkflow);
      const sourceImageSha256 = crypto.createHash('sha256').update('hello').digest('hex');
      assert.equal(comfyJob.sourceImage.sha256, sourceImageSha256);
      assert.equal(
        await fs.readFile(path.join(comfyOutputDir, 'inference-jobs', 'sources', `${sourceImageSha256}.png`), 'utf8'),
        'hello',
      );
      const persistedComfyJob = JSON.parse(await fs.readFile(comfyJob.manifestPath, 'utf8'));
      assert.equal(persistedComfyJob.seed, 42);
      assert.deepEqual(persistedComfyJob.submittedWorkflow, comfyWorkflow);
      const queuedJob = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}`).then((response) => response.json());
      assert.equal(queuedJob.status, 'queued');

      comfyRunning = true;
      const refreshedJobs = await fetch(`${comfyAppOrigin}/api/inference/jobs?refresh=1`).then((response) => response.json());
      const refreshedComfyJob = refreshedJobs.find((job) => job.id === comfyJob.id);
      assert.equal(refreshedComfyJob.status, 'running');
      assert.equal(refreshedComfyJob.hasWorkflowSnapshot, true);
      assert.equal('submittedWorkflow' in refreshedComfyJob, false);
      assert.equal((await fetch(`${comfyAppOrigin}/api/inference/jobs?limit=1`).then((response) => response.json())).length, 1);
      const runningJob = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}`).then((response) => response.json());
      assert.equal(runningJob.status, 'running');
      const runningCancelResponse = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}/cancel`, {
        method: 'POST',
      });
      assert.equal(runningCancelResponse.status, 409);
      assert.match((await runningCancelResponse.json()).error, /全域執行/);
      comfyFinished = true;
      const completedJob = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}`).then((response) => response.json());
      assert.equal(completedJob.status, 'succeeded', JSON.stringify(completedJob));
      assert.equal(completedJob.outputs.length, 2);
      assert.equal(await fs.readFile(path.join(comfyOutputDir, completedJob.outputs[0].fileName), 'utf8'), 'fake-comfy-webm');
      const importedVideos = await fetch(`${comfyAppOrigin}/api/videos`).then((response) => response.json());
      assert.equal(importedVideos.length, 2);
      assert.deepEqual(importedVideos.map((video) => video.format).sort(), ['mp4', 'webm']);
      assert.equal(importedVideos[0].seed, 42);
      assert.equal(importedVideos[0].negativePrompt, 'blurry, watermark');
      assert.equal(importedVideos[0].workflowSha256, workflowSha256);
      assert.equal(importedVideos[0].inferenceJobId, comfyJob.id);
      assert.equal(importedVideos[0].client, '客戶A');
      assert.equal(importedVideos[0].project, '春季活動');

      const comfyConfig = await fetch(`${comfyAppOrigin}/api/config`).then((response) => response.json());
      assert.deepEqual(comfyConfig.ffmpeg, { available: true, version: 'ffmpeg version 9.9-fake' });
      const importedWebm = importedVideos.find((video) => video.format === 'webm');
      const transcodeResponse = await fetch(`${comfyAppOrigin}/api/videos/${importedWebm.fileName}/transcode`, { method: 'POST' });
      assert.equal(transcodeResponse.status, 201);
      const transcoded = await transcodeResponse.json();
      assert.equal(transcoded.fileName, importedWebm.fileName.replace(/\.webm$/u, '.mp4'));
      assert.equal(transcoded.format, 'mp4');
      assert.equal(transcoded.transcodedFrom, importedWebm.fileName);
      assert.equal(transcoded.seed, 42);
      assert.notEqual(transcoded.id, importedWebm.id);
      assert.equal(await fs.readFile(path.join(comfyOutputDir, transcoded.fileName), 'utf8'), 'MP4:fake-comfy-webm');
      const transcodedAgain = await fetch(`${comfyAppOrigin}/api/videos/${importedWebm.fileName}/transcode`, { method: 'POST' })
        .then((response) => response.json());
      assert.equal(transcodedAgain.fileName, importedWebm.fileName.replace(/\.webm$/u, '-1.mp4'));
      await fetch(`${comfyAppOrigin}/api/videos`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: createVideoUploadBody({ id: 'fail-id', fileName: 'fail-me.webm', createdAt: new Date().toISOString() }, Buffer.from('x')),
      });
      const failedTranscode = await fetch(`${comfyAppOrigin}/api/videos/fail-me.webm/transcode`, { method: 'POST' });
      assert.equal(failedTranscode.status, 500);
      assert.match((await failedTranscode.json()).error, /fake encoder failure/);
      const filesAfterFailure = await fs.readdir(comfyOutputDir);
      assert.equal(filesAfterFailure.includes('fail-me.mp4'), false);
      assert.equal(filesAfterFailure.some((name) => name.endsWith('.transcode')), false);

      const pendingJob = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: '待取消的本機工作',
          videoModelId: 'wan-2.1-t2v-1.3b',
          sourceImageDataUrl: 'data:image/png;base64,aGVsbG8=',
          settings: { resolution: '1280x720', duration: 2, fps: 24 },
        }),
      }).then((response) => response.json());
      assert.equal(pendingJob.status, 'queued');
      assert.equal(pendingJob.seedMode, 'random');
      assert.ok(Number.isSafeInteger(pendingJob.seed) && pendingJob.seed >= 0);
      assert.equal(comfyWorkflows.at(-1)['5'].inputs.seed, pendingJob.seed);
      const persistedActiveJobs = await fetch(`${comfyAppOrigin}/api/inference/jobs`).then((response) => response.json());
      assert.ok(persistedActiveJobs.some((job) => job.id === pendingJob.id && job.comfyPromptId));
      const cancelledResponse = await fetch(`${comfyAppOrigin}/api/inference/jobs/${pendingJob.id}/cancel`, {
        method: 'POST',
      });
      assert.equal(cancelledResponse.status, 200);
      const cancelledJob = await cancelledResponse.json();
      assert.equal(cancelledJob.status, 'cancelled');
      assert.deepEqual(comfyCancelPayload, { delete: ['comfy-prompt-cancel'] });
      const persistedCancelledJob = await fetch(`${comfyAppOrigin}/api/inference/jobs/${pendingJob.id}`).then((response) => response.json());
      assert.equal(persistedCancelledJob.status, 'cancelled');

      // Same workflow + seed + parameters must produce an identical prompt JSON.
      await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reproduciblePayload),
      }).then((response) => response.json());
      assert.deepEqual(comfyWorkflows.at(-1), comfyJob.submittedWorkflow);

      const rerunResponse = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}/rerun`, { method: 'POST' });
      assert.equal(rerunResponse.status, 201);
      const rerunJob = await rerunResponse.json();
      assert.equal(rerunJob.rerunOf, comfyJob.id);
      assert.equal(rerunJob.seed, 42);
      assert.equal(rerunJob.status, 'queued');
      assert.deepEqual(rerunJob.warnings, []);
      assert.deepEqual(comfyWorkflows.at(-1), comfyJob.submittedWorkflow);

      // Batches: prompts x seeds, per-item failures isolated.
      const postBatch = (payload) => fetch(`${comfyAppOrigin}/api/inference/batches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const batchBase = { ...reproduciblePayload, prompt: '' };
      const promptsBeforeBatch = comfyWorkflows.length;
      const batchResponse = await postBatch({ ...batchBase, prompts: ['批次 A', ' ', '批次 B'], seed: 100, seedCount: 2 });
      assert.equal(batchResponse.status, 201);
      const batch = await batchResponse.json();
      assert.equal(batch.total, 4);
      assert.equal(batch.created, 4);
      assert.deepEqual(batch.errors, []);
      assert.deepEqual(batch.jobs.map((job) => job.seed), [100, 101, 100, 101]);
      assert.deepEqual(batch.jobs.map((job) => job.batchIndex), [0, 1, 2, 3]);
      assert.ok(batch.jobs.every((job) => job.batchId === batch.batchId && job.client === '客戶A'));
      assert.ok(batch.jobs.every((job) => job.hasWorkflowSnapshot && !('submittedWorkflow' in job)));
      assert.deepEqual(
        comfyWorkflows.slice(promptsBeforeBatch).map((workflow) => [workflow['1'].inputs.text, workflow['5'].inputs.seed]),
        [['批次 A', 100], ['批次 A', 101], ['批次 B', 100], ['批次 B', 101]],
      );
      const randomBatch = await postBatch({ ...batchBase, prompt: '隨機批次', seed: undefined, seedCount: 3 }).then((response) => response.json());
      assert.equal(randomBatch.created, 3);
      assert.ok(randomBatch.jobs.every((job) => job.seedMode === 'random' && Number.isSafeInteger(job.seed)));
      const partialBatch = await postBatch({ ...batchBase, prompts: ['正常', 'x'.repeat(5_001)] }).then((response) => response.json());
      assert.equal(partialBatch.created, 1);
      assert.equal(partialBatch.errors.length, 1);
      assert.equal(partialBatch.errors[0].index, 1);
      assert.equal(partialBatch.errors[0].statusCode, 400);
      const allFailedBatch = await postBatch({ ...batchBase, prompts: ['x'.repeat(5_001)] });
      assert.equal(allFailedBatch.status, 400);
      assert.match((await allFailedBatch.json()).error, /所有工作/);
      assert.equal((await postBatch({ ...batchBase, prompts: Array(6).fill('多'), seedCount: 10 })).status, 400);
      assert.equal((await postBatch({ ...batchBase, prompts: ['a'], seedCount: 0 })).status, 400);
      assert.equal((await postBatch({ ...batchBase, prompts: 'not-array' })).status, 400);
      assert.equal((await postBatch({ ...batchBase, prompts: ['a'], seeds: [1, -1] })).status, 400);

      await fs.writeFile(workflowPath, JSON.stringify({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{unknown_value}}' } },
      }));
      const invalidPreflight = await fetch(`${comfyAppOrigin}/api/inference/workflow-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoModelId: 'wan-2.1-t2v-1.3b' }),
      }).then((response) => response.json());
      assert.equal(invalidPreflight.ready, false);
      assert.match(invalidPreflight.errors[0], /不支援的佔位符/);

      // Rerun uses the stored snapshot even after the configured workflow changes, and warns about it.
      const changedRerun = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}/rerun`, { method: 'POST' })
        .then((response) => response.json());
      assert.equal(changedRerun.warnings.length, 1);
      assert.match(changedRerun.warnings[0], /工作流已變更/);
      assert.deepEqual(comfyWorkflows.at(-1), comfyJob.submittedWorkflow);

      await fs.rm(path.join(comfyOutputDir, 'inference-jobs', 'sources', `${sourceImageSha256}.png`));
      const missingSourceRerun = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}/rerun`, { method: 'POST' });
      assert.equal(missingSourceRerun.status, 409);
      assert.match((await missingSourceRerun.json()).error, /來源圖片快照/);

      // Delivery folders: copy videos + source images + manifest, then replay from the manifest.
      const sourceSnapshotPath = path.join(comfyOutputDir, 'inference-jobs', 'sources', `${sourceImageSha256}.png`);
      await fs.writeFile(sourceSnapshotPath, 'hello');
      const postDelivery = (payload) => fetch(`${comfyAppOrigin}/api/deliveries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const deliveryResponse = await postDelivery({ client: '客戶A', project: '春季活動' });
      assert.equal(deliveryResponse.status, 201);
      const delivery = await deliveryResponse.json();
      assert.equal(delivery.itemCount, 4);
      assert.ok(delivery.deliveryPath.startsWith(path.join(comfyOutputDir, 'deliveries', '客戶A', '春季活動')));
      const deliveryManifest = JSON.parse(await fs.readFile(delivery.manifestPath, 'utf8'));
      assert.equal(deliveryManifest.schemaVersion, 1);
      assert.equal(deliveryManifest.client, '客戶A');
      for (const deliveredItem of deliveryManifest.items) {
        const deliveredBytes = await fs.readFile(path.join(delivery.deliveryPath, deliveredItem.path));
        assert.equal(deliveredItem.sha256, crypto.createHash('sha256').update(deliveredBytes).digest('hex'));
        assert.equal(deliveredItem.reproduction.type, 'comfyui');
        assert.equal(deliveredItem.reproduction.job.seed, 42);
        assert.equal('manifestPath' in deliveredItem.reproduction.job, false);
        assert.deepEqual(deliveredItem.reproduction.job.submittedWorkflow, comfyJob.submittedWorkflow);
      }
      assert.equal(await fs.readFile(path.join(delivery.deliveryPath, 'sources', `${sourceImageSha256}.png`), 'utf8'), 'hello');
      await fs.rm(sourceSnapshotPath);

      const postReplay = (payload) => fetch(`${comfyAppOrigin}/api/deliveries/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const replayResponse = await postReplay({ manifestPath: delivery.manifestPath, index: 0 });
      assert.equal(replayResponse.status, 201);
      const replayed = await replayResponse.json();
      assert.equal(replayed.rerunOf, comfyJob.id);
      assert.equal(replayed.seed, 42);
      assert.deepEqual(comfyWorkflows.at(-1), comfyJob.submittedWorkflow);
      assert.equal(await fs.readFile(sourceSnapshotPath, 'utf8'), 'hello');

      const canvasDelivery = await postDelivery({ fileNames: ['fail-me.webm'] }).then((response) => response.json());
      assert.equal(canvasDelivery.itemCount, 1);
      assert.ok(canvasDelivery.deliveryPath.includes(path.join('未指定客戶', '未指定專案')));
      const canvasManifest = JSON.parse(await fs.readFile(canvasDelivery.manifestPath, 'utf8'));
      assert.equal(canvasManifest.items[0].reproduction.type, 'canvas');
      assert.equal((await postReplay({ manifestPath: canvasDelivery.manifestPath, index: 0 })).status, 409);
      assert.equal((await postReplay({ manifestPath: delivery.manifestPath, index: 99 })).status, 404);
      assert.equal((await postReplay({ manifestPath: path.join(comfyOutputDir, 'manifest.json') })).status, 400);
      assert.equal((await postReplay({ manifestPath: path.join(comfyOutputDir, 'deliveries', '..', 'manifest.json') })).status, 400);
      assert.equal((await postDelivery({})).status, 400);
      assert.equal((await postDelivery({ fileNames: ['nope.webm'] })).status, 404);
      assert.equal((await postDelivery({ client: '無此客戶' })).status, 404);
      assert.equal((await postDelivery({ client: 'CON', fileNames: ['fail-me.webm'] })).status, 201);
    } finally {
      await new Promise((resolve) => comfyApp.server.close(resolve));
      await new Promise((resolve) => comfyServer.close(resolve));
      await fs.rm(comfyOutputDir, { recursive: true, force: true });
    }

    console.log(JSON.stringify({ ok: true, origin, managedOutputDir, repoRoot }, null, 2));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => civitai.server.close(resolve));
    await fs.rm(managedOutputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
