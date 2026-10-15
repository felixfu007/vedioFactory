import assert from 'node:assert/strict';
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
    assert.equal(runtime.provider, 'comfyui-local');
    assert.equal(runtime.localGpuPreferred, true);
    assert.equal(runtime.outputDir, managedOutputDir);
    assert.ok(Array.isArray(runtime.guidance));
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

    const empty = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(empty.length, 0);

    let comfyWorkflow;
    let comfyRunning = false;
    let comfyFinished = false;
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
        comfyWorkflow = JSON.parse(body).prompt;
        response.end(JSON.stringify({ prompt_id: 'comfy-prompt-123', number: 1 }));
      } else if (request.url === '/queue') {
        response.end(JSON.stringify({
          queue_running: comfyRunning ? [[0, 'comfy-prompt-123']] : [],
          queue_pending: comfyRunning || comfyFinished ? [] : [[0, 'comfy-prompt-123']],
        }));
      } else if (request.url === '/history/comfy-prompt-123') {
        response.end(JSON.stringify(comfyFinished ? {
          'comfy-prompt-123': {
            status: { completed: true, status_str: 'success' },
            outputs: { '4': { videos: [{ filename: 'generated.webm', type: 'output' }] } },
          },
        } : comfyRunning ? {
          'comfy-prompt-123': { status: { completed: false, status_str: 'running' }, outputs: {} },
        } : {}));
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
    await fs.writeFile(workflowPath, JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '2': { class_type: 'ModelLoader', inputs: { model: '{{model_id}}' } },
      '3': { class_type: 'LoadImage', inputs: { image: '{{source_image}}' } },
      '4': { class_type: 'SaveWEBM', inputs: { format: 'webm' } },
    }));
    const comfyApp = await startServer({
      port: 0,
      host: '127.0.0.1',
      outputDir: comfyOutputDir,
      comfyUIUrl: comfyOrigin,
      comfyUIWorkflowPath: workflowPath,
    });
    const comfyAddress = comfyApp.server.address();
    const comfyAppOrigin = `http://127.0.0.1:${comfyAddress.port}`;
    try {
      const comfyRuntime = await fetch(`${comfyAppOrigin}/api/inference/runtime`).then((response) => response.json());
      assert.equal(comfyRuntime.comfyUI.available, true);
      assert.equal(comfyRuntime.comfyUI.workflowConfigured, true);
      const preflight = await fetch(`${comfyAppOrigin}/api/inference/workflow-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoModelId: 'wan-2.1-t2v-1.3b', hasSourceImage: true }),
      }).then((response) => response.json());
      assert.equal(preflight.ready, true);
      assert.equal(preflight.nodeCount, 4);
      assert.deepEqual(preflight.placeholders, ['model_id', 'prompt', 'source_image']);
      assert.deepEqual(preflight.videoOutputNodes, [{ id: '4', classType: 'SaveWEBM' }]);
      assert.equal(preflight.warnings.length, 0);
      const noImagePreflight = await fetch(`${comfyAppOrigin}/api/inference/workflow-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoModelId: 'wan-2.1-t2v-1.3b', hasSourceImage: false }),
      }).then((response) => response.json());
      assert.equal(noImagePreflight.ready, false);
      assert.match(noImagePreflight.errors[0], /需要來源圖片/);
      const comfyJob = await fetch(`${comfyAppOrigin}/api/inference/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: '本機 ComfyUI 測試',
          moduleId: 'cinematic-motion',
          videoModelId: 'wan-2.1-t2v-1.3b',
          sourceImageDataUrl: 'data:image/png;base64,aGVsbG8=',
          settings: { resolution: '1280x720', duration: 2, fps: 24 },
        }),
      }).then((response) => response.json());
      assert.equal(comfyJob.status, 'queued');
      assert.equal(comfyJob.comfyPromptId, 'comfy-prompt-123');
      assert.equal(comfyWorkflow['1'].inputs.text, '本機 ComfyUI 測試');
      assert.equal(comfyWorkflow['2'].inputs.model, 'wan-2.1-t2v-1.3b');
      assert.equal(comfyWorkflow['3'].inputs.image, 'upload/test.png');
      const queuedJob = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}`).then((response) => response.json());
      assert.equal(queuedJob.status, 'queued');

      comfyRunning = true;
      const runningJob = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}`).then((response) => response.json());
      assert.equal(runningJob.status, 'running');
      comfyFinished = true;
      const completedJob = await fetch(`${comfyAppOrigin}/api/inference/jobs/${comfyJob.id}`).then((response) => response.json());
      assert.equal(completedJob.status, 'succeeded', JSON.stringify(completedJob));
      assert.equal(completedJob.outputs.length, 1);
      assert.equal(await fs.readFile(path.join(comfyOutputDir, completedJob.outputs[0].fileName), 'utf8'), 'fake-comfy-webm');
      const importedVideos = await fetch(`${comfyAppOrigin}/api/videos`).then((response) => response.json());
      assert.equal(importedVideos.length, 1);
      assert.match(importedVideos[0].fileName, /\.webm$/u);

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
    } finally {
      await new Promise((resolve) => comfyApp.server.close(resolve));
      await new Promise((resolve) => comfyServer.close(resolve));
      await fs.rm(comfyOutputDir, { recursive: true, force: true });
    }

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
