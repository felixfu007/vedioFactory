import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startServer } = require('../server.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const managedOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-api-'));
  const app = await startServer({ port: 0, host: '127.0.0.1', outputDir: managedOutputDir });
  const address = app.server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const config = await fetch(`${origin}/api/config`).then((response) => response.json());
    assert.equal(config.backendAvailable, true);
    assert.equal(config.outputDir, managedOutputDir);

    const runtime = await fetch(`${origin}/api/inference/runtime`).then((response) => response.json());
    assert.equal(runtime.provider, 'local-nvidia-cuda');
    assert.equal(runtime.localGpuPreferred, true);
    assert.equal(runtime.outputDir, managedOutputDir);
    assert.ok(Array.isArray(runtime.guidance));

    const catalog = await fetch(`${origin}/api/models/catalog`).then((response) => response.json());
    assert.equal(catalog.currentProjectStatus.actualIntegratedModels.length, 0);
    assert.deepEqual(catalog.firstBatchOrder, ['sdxl', 'animatediff', 'realesrgan', 'rife']);
    assert.equal(catalog.models.some((model) => model.id === 'sdxl'), true);

    const setupBatch = await fetch(`${origin}/api/models/setup-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((response) => response.json());
    assert.equal(setupBatch.firstBatchModels.length, 4);
    assert.equal(setupBatch.provider, 'local-nvidia-cuda');
    assert.equal(setupBatch.installRoot, catalog.installRoot);
    assert.deepEqual(setupBatch.firstBatchModels.map((model) => model.modelId), ['sdxl', 'animatediff', 'realesrgan', 'rife']);
    for (const manifest of setupBatch.firstBatchModels) {
      assert.match(manifest.manifestPath, /model-setup/);
      const setupManifestText = await fs.readFile(manifest.manifestPath, 'utf8');
      assert.match(setupManifestText, new RegExp(manifest.modelId));
      assert.match(setupManifestText, /local-nvidia-cuda/);
      assert.match(setupManifestText, new RegExp(catalog.installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    const setupBatchAgain = await fetch(`${origin}/api/models/setup-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((response) => response.json());
    assert.equal(setupBatchAgain.firstBatchModels.length, 4);
    assert.equal(new Set(setupBatchAgain.firstBatchModels.map((model) => model.manifestPath)).size, 4);
    assert.equal(setupBatchAgain.firstBatchModels.some((model, index) => model.manifestPath === setupBatch.firstBatchModels[index].manifestPath), false);

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

    const listed = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(listed.length, 1);
    assert.equal(listed[0].fileName, item.fileName);
    assert.match(listed[0].previewUrl, /\/api\/videos\/api-test\.webm/);

    await fs.writeFile(path.join(managedOutputDir, 'broken.webm.json'), '{');
    await fs.writeFile(path.join(managedOutputDir, 'orphan.webm.json'), JSON.stringify({
      ...item,
      fileName: 'orphan.webm',
    }, null, 2));
    const stillListed = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(stillListed.length, 1);

    const renamed = await fetch(`${origin}/api/videos/${encodeURIComponent(item.fileName)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nextFileName: 'api-test-renamed.webm' }),
    }).then((response) => response.json());
    assert.equal(renamed.fileName, 'api-test-renamed.webm');

    const videoPayload = await fetch(`${origin}/api/videos/${encodeURIComponent('api-test-renamed.webm')}`).then((response) => response.arrayBuffer());
    assert.equal(Buffer.from(videoPayload).toString('utf8'), 'fake-webm-content');

    const deleted = await fetch(`${origin}/api/videos/${encodeURIComponent('api-test-renamed.webm')}`, {
      method: 'DELETE',
    }).then((response) => response.json());
    assert.equal(deleted.ok, true);

    const inferenceJob = await fetch(`${origin}/api/inference/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '測試本機推論工作',
        story: '建立本機 GPU 推論骨架工作',
        moduleId: 'storyboard-focus',
        settings: {
          duration: 2,
          resolution: '1280x720',
        },
      }),
    }).then((response) => response.json());
    assert.equal(inferenceJob.provider, 'local-nvidia-cuda');
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
    assert.match(manifestText, /local-nvidia-cuda/);

    const malformedJsonResponse = await fetch(`${origin}/api/inference/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt": ',
    });
    assert.equal(malformedJsonResponse.status, 400);
    const malformedJson = await malformedJsonResponse.json();
    assert.match(malformedJson.error, /JSON 格式錯誤/);

    const empty = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(empty.length, 0);

    console.log(JSON.stringify({ ok: true, origin, managedOutputDir, repoRoot }, null, 2));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(managedOutputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
