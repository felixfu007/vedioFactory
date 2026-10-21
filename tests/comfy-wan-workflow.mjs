import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { listenOnFetchSafePort, startOnFetchSafePort } from './safe-port.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Tests choose single-workflow or pipeline mode explicitly; a developer's shell must not switch modes.
delete process.env.VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW;
const { startServer: startServerRaw, validateModelFileSource } = require(path.join(repoRoot, 'server.js'));
const startServer = (options) => startOnFetchSafePort(startServerRaw, options);

function testModelFileSources() {
  const civitai = {
    provider: 'civitai',
    folder: 'loras',
    file: 'example_wan22_lora.safetensors',
    sizeBytes: 123,
    sha256: 'a'.repeat(64),
    source: 'https://civitai.com/api/download/models/456',
    modelPageUrl: 'https://civitai.com/models/123',
    modelVersionId: 456,
    license: 'CreativeML OpenRAIL-M',
    commercialUse: 'Image',
  };
  assert.equal(validateModelFileSource(civitai, 'test'), civitai);
  assert.throws(() => validateModelFileSource({ ...civitai, file: 'x.ckpt' }, 'test'), /safetensors/u);
  // civitai.red (user-confirmed official Civitai domain) follows exactly the same rules as civitai.com.
  const civitaiRed = {
    ...civitai,
    source: 'https://civitai.red/api/download/models/456',
    modelPageUrl: 'https://civitai.red/models/123',
  };
  assert.equal(validateModelFileSource(civitaiRed, 'test'), civitaiRed);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, source: 'https://civitai.red.evil.com/api/download/models/456' }, 'test'), /untrusted/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, source: 'https://evil.civitai.red/api/download/models/456' }, 'test'), /untrusted/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, source: 'http://civitai.red/api/download/models/456' }, 'test'), /https:/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, file: 'example_wan22_lora.ckpt' }, 'test'), /safetensors/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, modelPageUrl: 'https://evil.civitai.red/models/123' }, 'test'), /modelPageUrl/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, modelVersionId: undefined }, 'test'), /modelVersionId/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, commercialUse: undefined }, 'test'), /commercialUse/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, license: undefined }, 'test'), /license/u);
  assert.throws(() => validateModelFileSource({ ...civitaiRed, sha256: undefined }, 'test'), /sha256/u);
  // A Civitai-hosted URL gets the Civitai rules even if the entry does not declare provider 'civitai'.
  assert.throws(() => validateModelFileSource({ ...civitaiRed, provider: 'huggingface', modelPageUrl: undefined }, 'test'), /modelPageUrl/u);
  // provider 'civitai' must actually point at a Civitai host.
  assert.throws(
    () => validateModelFileSource({ ...civitai, source: 'https://huggingface.co/api/download/models/456' }, 'test'),
    /civitai source must be on/u,
  );
  assert.throws(() => validateModelFileSource({ ...civitai, commercialUse: undefined }, 'test'), /commercialUse/u);
  assert.throws(() => validateModelFileSource({ ...civitai, sha256: undefined }, 'test'), /sha256/u);

  // L5: https only, no credentials/query/fragment, and the URL must point at exactly the declared file/version.
  const hf = {
    provider: 'huggingface',
    folder: 'vae',
    file: 'wan2.2_vae.safetensors',
    sizeBytes: 1,
    sha256: 'b'.repeat(64),
    source: 'https://huggingface.co/Comfy-Org/repo/resolve/main/split_files/vae/wan2.2_vae.safetensors',
    license: 'Apache-2.0',
  };
  assert.equal(validateModelFileSource(hf, 'test'), hf);
  const badSources = {
    'http://huggingface.co/Comfy-Org/repo/resolve/main/wan2.2_vae.safetensors': /https:/u,
    'https://user:pw@huggingface.co/Comfy-Org/repo/resolve/main/wan2.2_vae.safetensors': /credentials/u,
    'https://huggingface.co/Comfy-Org/repo/resolve/main/wan2.2_vae.safetensors?download=1': /query/u,
    'https://huggingface.co/Comfy-Org/repo/resolve/main/wan2.2_vae.safetensors#x': /fragment/u,
    'https://huggingface.co/Comfy-Org/repo/resolve/main/other.safetensors': /end with the file name/u,
    'https://huggingface.co/Comfy-Org/repo/resolve/main/wan2.2_vae.safetensors/': /end with the file name/u,
    'not a url': /valid URL/u,
  };
  for (const [source, pattern] of Object.entries(badSources)) {
    assert.throws(() => validateModelFileSource({ ...hf, source }, 'test'), pattern, source);
  }
  assert.throws(
    () => validateModelFileSource({ ...civitai, source: 'https://civitai.com/api/download/models/999' }, 'test'),
    /modelVersionId/u,
  );
}
const workflowPath = path.join(repoRoot, 'workflows', 'wan22-ti2v-5b-i2v.api.json');
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  testModelFileSources();
  const shippedWorkflow = JSON.parse(await fs.readFile(workflowPath, 'utf8'));
  const state = {
    missingModel: true,
    submitted: null,
    rejectPrompt: false,
    history: {},
    uploads: 0,
  };

  // Fake ComfyUI /object_info/{class}: every literal string input becomes a one-option combo, so the live check
  // passes unless `missingModel` hides the diffusion model (simulating an empty models/diffusion_models folder).
  const objectInfo = {};
  for (const node of Object.values(shippedWorkflow)) {
    const required = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      required[name] = typeof value === 'string' && !value.includes('{{') ? [[value]] : ['*'];
    }
    objectInfo[node.class_type] = { input: { required } };
  }

  const comfyServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/system_stats') {
      response.end('{}');
    } else if (url.pathname.startsWith('/object_info/')) {
      const classType = decodeURIComponent(url.pathname.slice('/object_info/'.length));
      const definition = structuredClone(objectInfo[classType]);
      if (!definition) {
        response.end('{}');
        return;
      }
      if (classType === 'UNETLoader' && state.missingModel) definition.input.required.unet_name = [[]];
      response.end(JSON.stringify({ [classType]: definition }));
    } else if (url.pathname === '/upload/image') {
      state.uploads += 1;
      response.end(JSON.stringify({ name: 'wan-source.png', subfolder: '' }));
    } else if (url.pathname === '/prompt') {
      if (state.rejectPrompt) {
        response.statusCode = 400;
        response.end(JSON.stringify({
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
          node_errors: {
            9: {
              class_type: 'KSampler',
              errors: [{ type: 'value_bigger_than_max', details: 'steps: 99999 bigger than max' }],
            },
          },
        }));
        return;
      }
      state.submitted = JSON.parse(body).prompt;
      response.end(JSON.stringify({ prompt_id: `prompt-${Date.now()}`, number: 1, node_errors: {} }));
    } else if (url.pathname === '/queue') {
      response.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    } else if (url.pathname.startsWith('/history/')) {
      const promptId = decodeURIComponent(url.pathname.slice('/history/'.length));
      response.end(JSON.stringify(state.history[promptId] ? { [promptId]: state.history[promptId] } : {}));
    } else if (url.pathname === '/view') {
      response.setHeader('content-type', 'video/webm');
      response.end('fake-wan-webm');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await listenOnFetchSafePort(comfyServer);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-wan-'));
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    outputDir,
    comfyUIUrl: `http://127.0.0.1:${comfyServer.address().port}`,
    comfyUIWorkflowPath: workflowPath,
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;

  try {
    // 1. Shipped workflow: static structure + live check flags the missing model file.
    const missing = await postJson(`${origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b',
      hasSourceImage: true,
    });
    assert.equal(missing.body.ready, false);
    assert.equal(missing.body.comfyUILiveCheck.checked, true);
    assert.deepEqual(missing.body.comfyUILiveCheck.missingValues.map((item) => item.value), ['wan2.2_ti2v_5B_fp16.safetensors']);
    assert.match(missing.body.errors.join(' '), /wan2\.2_ti2v_5B_fp16\.safetensors/u);
    assert.deepEqual(missing.body.videoOutputNodes, [{ id: '11', classType: 'SaveWEBM' }]);
    for (const name of ['prompt', 'source_image', 'width', 'height', 'frames', 'steps', 'seed', 'fps']) {
      assert.ok(missing.body.placeholders.includes(name), `workflow should use {{${name}}}`);
    }
    const blockedJob = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'cat',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '832x480', duration: 2, fps: 24 },
    });
    assert.equal(blockedJob.status, 400);
    assert.equal(state.submitted, null, 'nothing may be submitted when a model is missing');

    // 2. Models present: placeholders become typed values Wan accepts (4n+1 frames, steps by quality, fixed seed).
    state.missingModel = false;
    const ready = await postJson(`${origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b',
      hasSourceImage: true,
    });
    assert.equal(ready.body.ready, true, JSON.stringify(ready.body.errors));
    const created = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'a cat turns its head',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '832x480', duration: 2, fps: 24, quality: 'draft', seed: 1234 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const job = created.body;
    assert.equal(job.status, 'queued');
    assert.deepEqual(job.workflowVariables, {
      width: 832, height: 480, fps: 24, frames: 49, steps: 12, seed: 1234, source_image: 'wan-source.png',
    });
    assert.equal(state.submitted['7'].inputs.image, 'wan-source.png');
    assert.equal(state.submitted['8'].inputs.width, 832);
    assert.equal(state.submitted['8'].inputs.height, 480);
    assert.equal(state.submitted['8'].inputs.length, 49);
    assert.equal(state.submitted['9'].inputs.seed, 1234);
    assert.equal(state.submitted['9'].inputs.steps, 12);
    assert.equal(state.submitted['11'].inputs.fps, 24);
    assert.equal(state.submitted['5'].inputs.text, 'a cat turns its head');
    assert.doesNotMatch(JSON.stringify(state.submitted), /\{\{/u);

    // M2: clips over the model's frame limit are refused (with the allowed range) before the image is uploaded.
    const uploadsBeforeLong = state.uploads;
    const tooLong = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'long',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '832x480', duration: 10, fps: 24 },
    });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /241 影格.*上限 121 影格.*24 fps 時片長須為 2 至 5 秒/u);
    assert.equal(state.uploads, uploadsBeforeLong, 'no upload for a rejected job');
    // The longest allowed clip (5 s x 24 fps = 121 frames) at Wan 5B's native 1280x704 passes (the UI default);
    // random seeds are generated when none is given.
    const longJob = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'long',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '1280x704', duration: 5, fps: 24 },
    });
    assert.equal(longJob.status, 201, JSON.stringify(longJob.body));
    assert.equal(longJob.body.workflowVariables.frames, 121);
    // A single-segment workflow records no segment fields, and reports itself as not chained.
    assert.equal(longJob.body.workflowVariables.segments, undefined);
    assert.equal(longJob.body.workflowVariables.total_frames, undefined);
    const singleRuntime = await fetch(`${origin}/api/inference/runtime`).then((response) => response.json());
    assert.equal(singleRuntime.comfyUI.workflowSegments.chained, false);
    assert.equal(singleRuntime.comfyUI.workflowSegments.segments, 1);
    assert.equal(singleRuntime.comfyUI.workflowSegments.maxDurationSecondsByFps[24], 5);
    assert.equal(longJob.body.workflowVariables.width, 1280);
    assert.equal(longJob.body.workflowVariables.height, 704);
    // The frontend reads its Wan 5B defaults and frame cap from the catalog; they must agree with the server limit.
    const catalog = await fetch(`${origin}/api/models/catalog`).then((response) => response.json());
    const wan5b = catalog.videoModels.find((model) => model.id === 'wan-2.2-ti2v-5b');
    assert.equal(wan5b.recommendedMaxFrames, 121);
    assert.deepEqual(wan5b.recommendedSettings, { resolution: '1280x704', duration: 5, fps: 24, quality: 'balanced' });
    assert.ok(wan5b.timingHint);
    assert.equal(longJob.body.warnings, undefined);
    assert.ok(Number.isInteger(longJob.body.workflowVariables.seed));

    const badSeed = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'seed',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { seed: -1 },
    });
    assert.equal(badSeed.status, 400);

    // 3. Success: the .webm and its .webm.json land in the library with reproducibility fields.
    state.history[job.comfyPromptId] = {
      status: {
        status_str: 'success',
        completed: true,
        messages: [
          ['execution_start', { prompt_id: job.comfyPromptId, timestamp: 1_000 }],
          ['execution_success', { prompt_id: job.comfyPromptId, timestamp: 95_500 }],
        ],
      },
      outputs: { 11: { images: [{ filename: 'wan22-ti2v-5b_00001_.webm', subfolder: 'vediofactory', type: 'output' }] } },
    };
    const done = await fetch(`${origin}/api/inference/jobs/${job.id}`).then((response) => response.json());
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.equal(done.executionSeconds, 94.5);
    const metadata = JSON.parse(await fs.readFile(path.join(outputDir, `${done.outputs[0].fileName}.json`), 'utf8'));
    assert.equal(metadata.seed, 1234);
    assert.equal(metadata.frames, 49);
    assert.equal(metadata.steps, 12);
    assert.equal(metadata.videoModelId, 'wan-2.2-ti2v-5b');
    assert.equal(metadata.width, 832);
    const library = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.ok(library.some((item) => item.inferenceJobId === job.id));

    // 4. Failure: ComfyUI stores errors as completed:false + status_str:'error'; the job must not stay "running".
    state.history[longJob.body.comfyPromptId] = {
      status: {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { prompt_id: longJob.body.comfyPromptId, timestamp: 0 }],
          ['execution_error', {
            prompt_id: longJob.body.comfyPromptId,
            node_type: 'KSampler',
            exception_message: 'CUDA out of memory. Tried to allocate 2.00 GiB',
            timestamp: 3_000,
          }],
        ],
      },
      outputs: {},
    };
    const failed = await fetch(`${origin}/api/inference/jobs/${longJob.body.id}`).then((response) => response.json());
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /KSampler.*CUDA out of memory/u);
    assert.match(failed.guidance, /832x480/u);

    // 5. ComfyUI validation errors (HTTP 400 + node_errors) are summarized, not dumped as a 502.
    state.rejectPrompt = true;
    const rejected = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'reject',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '832x480', duration: 2, fps: 24 },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /節點 9（KSampler）：steps: 99999 bigger than max/u);

    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow' }));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => comfyServer.close(resolve));
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Failure / race / resource-release scenarios against a controllable fake ComfyUI.
// ---------------------------------------------------------------------------------------------------------------

function buildObjectInfo(workflow) {
  const objectInfo = {};
  for (const node of Object.values(workflow)) {
    const required = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      required[name] = typeof value === 'string' && !value.includes('{{') ? [[value]] : ['*'];
    }
    objectInfo[node.class_type] = { input: { required } };
  }
  return objectInfo;
}

// `mock` is mutated by tests: down (drop every socket), objectInfoStatus, queue, history, view behaviour, counters.
async function startMockComfy(workflow, objectInfoOverrides = {}) {
  const objectInfo = { ...buildObjectInfo(workflow), ...objectInfoOverrides };
  const mock = {
    down: false,
    objectInfoStatus: 200,
    queueRunning: [],
    queuePending: [],
    history: {},
    viewDelayMs: 0,
    viewMode: 'ok', // 'ok' | 'abort' (headers sent, socket destroyed mid-body) | '404'
    viewBodies: {},
    viewRequests: [],
    viewTypes: [],
    promptCount: 0,
    autoQueue: true, // newly submitted prompts appear in queue_pending
    uploads: [], // multipart fields of each /upload/image call
    promptError: null, // when set, /prompt answers HTTP 400 with this body
    lastPrompt: null,
  };
  const server = http.createServer(async (request, response) => {
    if (mock.down) {
      request.socket.destroy();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/system_stats') {
      response.end('{}');
    } else if (url.pathname.startsWith('/object_info/')) {
      if (mock.objectInfoStatus !== 200) {
        response.statusCode = mock.objectInfoStatus;
        response.end('internal error');
        return;
      }
      const classType = decodeURIComponent(url.pathname.slice('/object_info/'.length));
      response.end(JSON.stringify(objectInfo[classType] ? { [classType]: objectInfo[classType] } : {}));
    } else if (url.pathname === '/upload/image') {
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': request.headers['content-type'] },
      }).formData();
      const image = form.get('image');
      mock.uploads.push({
        name: image.name,
        overwrite: form.get('overwrite'),
        subfolder: form.get('subfolder'),
        type: form.get('type'),
      });
      response.end(JSON.stringify({ name: image.name, subfolder: form.get('subfolder') || '', type: 'input' }));
    } else if (url.pathname === '/prompt') {
      if (mock.promptError) {
        response.statusCode = 400;
        response.end(JSON.stringify(mock.promptError));
        return;
      }
      mock.lastPrompt = JSON.parse(body).prompt;
      mock.promptCount += 1;
      const promptId = `prompt-${mock.promptCount}-${Date.now()}`;
      if (mock.autoQueue) mock.queuePending.push([mock.promptCount, promptId, {}, {}, []]);
      response.end(JSON.stringify({ prompt_id: promptId, number: mock.promptCount, node_errors: {} }));
    } else if (url.pathname === '/queue') {
      if (request.method === 'POST') {
        const ids = JSON.parse(body).delete || [];
        mock.queuePending = mock.queuePending.filter((entry) => !ids.includes(entry[1]));
        response.end('{}');
        return;
      }
      response.end(JSON.stringify({ queue_running: mock.queueRunning, queue_pending: mock.queuePending }));
    } else if (url.pathname.startsWith('/history/')) {
      const promptId = decodeURIComponent(url.pathname.slice('/history/'.length));
      response.end(JSON.stringify(mock.history[promptId] ? { [promptId]: mock.history[promptId] } : {}));
    } else if (url.pathname === '/view') {
      const filename = url.searchParams.get('filename');
      mock.viewRequests.push(filename);
      mock.viewTypes.push(url.searchParams.get('type'));
      if (mock.viewDelayMs) await new Promise((resolve) => setTimeout(resolve, mock.viewDelayMs));
      if (mock.viewMode === '404') {
        response.statusCode = 404;
        response.end('{"error":"not found"}');
        return;
      }
      response.setHeader('content-type', 'video/webm');
      if (mock.viewMode === 'abort') {
        response.setHeader('content-length', '1000000');
        response.write(Buffer.alloc(4096, 1));
        setTimeout(() => response.socket.destroy(), 20);
        return;
      }
      response.end(mock.viewBodies[filename] ?? `webm:${filename}`);
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await listenOnFetchSafePort(server);
  return { mock, server, url: `http://127.0.0.1:${server.address().port}` };
}

function successHistory(promptId, outputs, messages) {
  return {
    status: {
      status_str: 'success',
      completed: true,
      messages: messages ?? [
        ['execution_start', { prompt_id: promptId, timestamp: 10_000 }],
        ['execution_success', { prompt_id: promptId, timestamp: 12_340 }],
      ],
    },
    outputs,
  };
}

async function listTempFiles(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.tmp')) found.push(entry.name);
  }
  return found;
}

async function testFailureRaceAndCleanup() {
  const workflow = JSON.parse(await fs.readFile(workflowPath, 'utf8'));
  const comfy = await startMockComfy(workflow);
  const { mock } = comfy;
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-wan-race-'));
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    outputDir,
    comfyUIUrl: comfy.url,
    comfyUIWorkflowPath: workflowPath,
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const getJob = async (id) => {
    const response = await fetch(`${origin}/api/inference/jobs/${encodeURIComponent(id)}`);
    return { status: response.status, body: await response.json() };
  };
  const createJob = async (settings = {}) => {
    const created = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'race',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '832x480', duration: 2, fps: 24, seed: 7, ...settings },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
  };
  const readManifest = async (job) => JSON.parse(await fs.readFile(job.manifestPath, 'utf8'));
  const comfyItems = async (jobId) => (await fetch(`${origin}/api/videos`).then((response) => response.json()))
    .filter((item) => item.inferenceJobId === jobId);

  try {
    // A. Frame count stays 4n+1 at the validated extremes (2 s x 12 fps, 30 s x 30 fps); fractional durations rejected.
    const shortest = await createJob({ duration: 2, fps: 12 });
    assert.equal(shortest.workflowVariables.frames, 25);
    assert.equal(shortest.workflowVariables.frames % 4, 1);
    assert.equal(shortest.warnings, undefined);
    const longest = await createJob({ duration: 4, fps: 30 });
    assert.equal(longest.workflowVariables.frames, 121);
    for (const [duration, fps, range] of [[30, 30, /901 影格.*2 至 4 秒/u], [11, 12, /133 影格.*2 至 10 秒/u]]) {
      const refused = await postJson(`${origin}/api/inference/jobs`, {
        prompt: 'x', videoModelId: 'wan-2.2-ti2v-5b', sourceImageDataUrl: PNG_DATA_URL, settings: { duration, fps },
      });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, range);
    }
    const fractional = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'x', videoModelId: 'wan-2.2-ti2v-5b', sourceImageDataUrl: PNG_DATA_URL, settings: { duration: 2.5 },
    });
    assert.equal(fractional.status, 400);
    for (const seed of [MAX_SEED_PLUS_ONE, 1.5, 'abc']) {
      const rejected = await postJson(`${origin}/api/inference/jobs`, {
        prompt: 'x', videoModelId: 'wan-2.2-ti2v-5b', sourceImageDataUrl: PNG_DATA_URL, settings: { seed },
      });
      assert.equal(rejected.status, 400, `seed ${seed} must be rejected`);
    }
    const maxSeed = await createJob({ seed: 2 ** 32 - 1 });
    assert.equal(maxSeed.workflowVariables.seed, 2 ** 32 - 1);
    const zeroSeed = await createJob({ seed: 0 });
    assert.equal(zeroSeed.workflowVariables.seed, 0, 'seed 0 is valid and must not be replaced by a random seed');

    // B. /object_info failing (older ComfyUI or transient 500) skips the live check instead of blocking submission.
    mock.objectInfoStatus = 500;
    const skipped = await postJson(`${origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true,
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.ready, true, JSON.stringify(skipped.body.errors));
    assert.equal(skipped.body.comfyUILiveCheck.checked, false);
    assert.match(skipped.body.comfyUILiveCheck.error, /略過即時檢查/u);
    const submittedWithoutLiveCheck = await createJob();
    assert.equal(submittedWithoutLiveCheck.status, 'queued');
    assert.equal(submittedWithoutLiveCheck.workflowPreflight.comfyUILiveCheck.checked, false);
    mock.objectInfoStatus = 200;

    // C. ComfyUI fully offline: workflow-check still answers (live check skipped), job creation is refused with 503
    //    and leaves no manifest or temp file behind.
    mock.down = true;
    const offlineCheck = await postJson(`${origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true,
    });
    assert.equal(offlineCheck.status, 200);
    assert.equal(offlineCheck.body.comfyUILiveCheck.checked, false);
    const jobsBefore = await fetch(`${origin}/api/inference/jobs`).then((response) => response.json());
    const offlineCreate = await postJson(`${origin}/api/inference/jobs`, {
      prompt: 'offline', videoModelId: 'wan-2.2-ti2v-5b', sourceImageDataUrl: PNG_DATA_URL, settings: {},
    });
    assert.equal(offlineCreate.status, 503);
    const jobsAfter = await fetch(`${origin}/api/inference/jobs`).then((response) => response.json());
    assert.equal(jobsAfter.length, jobsBefore.length);
    mock.down = false;

    // D. ComfyUI drops out while a job is in flight: polling gets 503, the persisted status is untouched, and the job
    //    completes normally once ComfyUI is back.
    const midJob = await createJob();
    mock.queuePending = mock.queuePending.filter((entry) => entry[1] !== midJob.comfyPromptId);
    mock.queueRunning = [[1, midJob.comfyPromptId, {}, {}, []]];
    assert.equal((await getJob(midJob.id)).body.status, 'running');
    mock.down = true;
    const unreachable = await getJob(midJob.id);
    assert.equal(unreachable.status, 503);
    assert.match(unreachable.body.error, /無法連線至本機 ComfyUI/u);
    assert.equal((await readManifest(midJob)).status, 'running');
    mock.down = false;
    mock.queueRunning = [];
    mock.history[midJob.comfyPromptId] = successHistory(midJob.comfyPromptId, {
      11: { images: [{ filename: 'mid_00001_.webm', subfolder: 'vediofactory', type: 'output' }], animated: [true] },
    });
    const recovered = await getJob(midJob.id);
    assert.equal(recovered.body.status, 'succeeded');
    assert.equal(recovered.body.executionSeconds, 2.3);

    // E. Prompt vanished from both queue and history (ComfyUI restarted, or history cleared): the job must reach a
    //    terminal state, otherwise the UI polls forever every 2.5 s and restores it on every page load.
    const lost = await createJob();
    mock.queuePending = mock.queuePending.filter((entry) => entry[1] !== lost.comfyPromptId);
    let lostStatus = '';
    for (let attempt = 0; attempt < 3 && lostStatus !== 'failed'; attempt += 1) {
      lostStatus = (await getJob(lost.id)).body.status;
    }
    assert.equal(lostStatus, 'failed', 'a prompt missing from queue and history must fail, not stay queued');
    assert.match((await getJob(lost.id)).body.error, /找不到/u);
    assert.equal((await readManifest(lost)).status, 'failed');

    // F. A prompt that is still pending is not mistaken for a lost one.
    const pending = await createJob();
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await getJob(pending.id)).body.status, 'queued');

    // G. Error variants: interrupted (no exception_message), and status_str:'error' without messages.
    const interrupted = await createJob();
    mock.history[interrupted.comfyPromptId] = {
      status: {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { prompt_id: interrupted.comfyPromptId, timestamp: 1_000 }],
          ['execution_interrupted', { prompt_id: interrupted.comfyPromptId, node_type: 'KSampler', timestamp: 1_500 }],
        ],
      },
      outputs: {},
    };
    const interruptedJob = (await getJob(interrupted.id)).body;
    assert.equal(interruptedJob.status, 'failed');
    assert.equal(interruptedJob.executionSeconds, 0.5);
    assert.match(interruptedJob.error, /error/u);
    assert.equal(interruptedJob.guidance && /VRAM/u.test(interruptedJob.guidance), false);
    const bareError = await createJob();
    mock.history[bareError.comfyPromptId] = { status: { status_str: 'error', completed: false }, outputs: {} };
    const bareErrorJob = (await getJob(bareError.id)).body;
    assert.equal(bareErrorJob.status, 'failed');
    assert.equal(bareErrorJob.executionSeconds, undefined);

    // H. executionSeconds is omitted (never NaN/negative) when timestamps are missing, null, or out of order.
    const timestampCases = [
      [['execution_success', { timestamp: 5_000 }]],
      [['execution_start', { timestamp: 5_000 }]],
      [['execution_start', { timestamp: null }], ['execution_success', { timestamp: 5_000 }]],
      [['execution_start', { timestamp: 'x' }], ['execution_success', { timestamp: 5_000 }]],
      [['execution_start', { timestamp: 9_000 }], ['execution_success', { timestamp: 5_000 }]],
      [['execution_start'], 'garbage', null, ['execution_success', {}]],
    ];
    for (const messages of timestampCases) {
      const timed = await createJob();
      mock.history[timed.comfyPromptId] = successHistory(timed.comfyPromptId, {}, messages);
      const timedJob = (await getJob(timed.id)).body;
      assert.equal(timedJob.status, 'succeeded', JSON.stringify(messages));
      assert.equal(timedJob.executionSeconds, undefined, `executionSeconds for ${JSON.stringify(messages)}`);
      assert.match(timedJob.guidance, /未找到 \.webm/u);
    }

    // I. Multiple outputs: duplicates collapse, non-WebM files are ignored, each WebM keeps its own bytes.
    const multi = await createJob();
    mock.viewBodies['wan_00001_.webm'] = 'first-video';
    mock.viewBodies['wan_00002_.webm'] = 'second-video';
    mock.viewRequests = [];
    mock.history[multi.comfyPromptId] = successHistory(multi.comfyPromptId, {
      11: {
        images: [
          { filename: 'wan_00001_.webm', subfolder: 'vediofactory', type: 'output' },
          { filename: 'wan_00001_.webm', subfolder: 'vediofactory', type: 'output' },
        ],
        animated: [true],
      },
      12: { images: [{ filename: 'wan_00002_.webm', subfolder: '', type: 'output' }] },
      13: { images: [{ filename: 'preview_00001_.png', subfolder: '', type: 'temp' }] },
    });
    const multiJob = (await getJob(multi.id)).body;
    assert.equal(multiJob.status, 'succeeded');
    assert.deepEqual(mock.viewRequests.sort(), ['wan_00001_.webm', 'wan_00002_.webm']);
    assert.equal(multiJob.outputs.length, 2);
    const savedBodies = await Promise.all(multiJob.outputs.map((output) => fs.readFile(path.join(outputDir, output.fileName), 'utf8')));
    assert.deepEqual(savedBodies.sort(), ['first-video', 'second-video']);
    assert.equal(new Set(multiJob.outputs.map((output) => output.fileName)).size, 2);

    // J. Same ComfyUI filename reused by two different jobs (ComfyUI counter reset after a restart) must not make the
    //    second job overwrite the first job's library file.
    const reuseA = await createJob();
    const reuseB = await createJob();
    for (const [job, bytes] of [[reuseA, 'job-a'], [reuseB, 'job-b']]) {
      mock.viewBodies['same_00001_.webm'] = bytes;
      mock.history[job.comfyPromptId] = successHistory(job.comfyPromptId, {
        11: { images: [{ filename: 'same_00001_.webm', subfolder: 'vediofactory', type: 'output' }] },
      });
      assert.equal((await getJob(job.id)).body.status, 'succeeded');
    }
    const reuseAItems = await comfyItems(reuseA.id);
    assert.equal(reuseAItems.length, 1);
    assert.equal(await fs.readFile(path.join(outputDir, reuseAItems[0].fileName), 'utf8'), 'job-a');

    // K. Concurrent polls (two tabs, list + poll) at the moment of completion import each output exactly once.
    //    Old manifests make listInferenceJobs slow (as after weeks of use), which widens the read-then-dedupe window.
    const jobsDir = path.join(outputDir, 'inference-jobs');
    for (let index = 0; index < 300; index += 1) {
      await fs.writeFile(path.join(jobsDir, `9999999999999-later-${index}.json`), JSON.stringify({
        id: `old-${index}`, createdAt: '2020-01-01T00:00:00.000Z', status: 'succeeded', padding: 'x'.repeat(5_000),
      }));
    }
    const racing = await createJob();
    mock.viewRequests = [];
    mock.viewDelayMs = 0;
    mock.history[racing.comfyPromptId] = successHistory(racing.comfyPromptId, {
      11: { images: [{ filename: 'race_00001_.webm', subfolder: 'vediofactory', type: 'output' }] },
    });
    const staggered = [];
    for (let index = 0; index < 30; index += 1) {
      staggered.push(getJob(racing.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const raceResults = await Promise.all(staggered);
    mock.viewDelayMs = 0;
    for (const result of raceResults) assert.equal(result.body.status, 'succeeded', JSON.stringify(result.body));
    assert.equal(mock.viewRequests.length, 1, `output downloaded ${mock.viewRequests.length} times`);
    const raceItems = await comfyItems(racing.id);
    assert.equal(raceItems.length, 1);
    const raceMetadataIds = new Set(raceResults.map((result) => result.body.outputs[0].fileName));
    assert.equal(raceMetadataIds.size, 1);

    // L. Download aborted mid-stream: temp file removed, nothing half-written appears in the library, job stays
    //    non-terminal and a later poll imports it once ComfyUI serves the file.
    const aborted = await createJob();
    mock.viewMode = 'abort';
    mock.history[aborted.comfyPromptId] = successHistory(aborted.comfyPromptId, {
      11: { images: [{ filename: 'abort_00001_.webm', subfolder: 'vediofactory', type: 'output' }] },
    });
    const abortedPoll = await getJob(aborted.id);
    assert.notEqual(abortedPoll.status, 200);
    assert.deepEqual(await listTempFiles(outputDir), []);
    assert.deepEqual(await comfyItems(aborted.id), []);
    assert.notEqual((await readManifest(aborted)).status, 'succeeded');
    mock.viewMode = 'ok';
    assert.equal((await getJob(aborted.id)).body.status, 'succeeded');
    assert.equal((await comfyItems(aborted.id)).length, 1);

    // M. Cancel: pending prompt is removed from the ComfyUI queue; a lost prompt cannot be "cancelled".
    const toCancel = await createJob();
    const cancelResponse = await fetch(`${origin}/api/inference/jobs/${toCancel.id}/cancel`, { method: 'POST' });
    assert.equal(cancelResponse.status, 200);
    assert.equal(mock.queuePending.some((entry) => entry[1] === toCancel.comfyPromptId), false);
    const cancelLost = await fetch(`${origin}/api/inference/jobs/${lost.id}/cancel`, { method: 'POST' });
    assert.equal(cancelLost.status, 409);

    assert.deepEqual(await listTempFiles(outputDir), [], 'no .tmp files may be left in the output folder');
    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow:failure-race-cleanup' }));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => comfy.server.close(resolve));
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

// N. Windows paths: workflow and output folder with spaces + CJK characters; paths round-trip through JSON manifests
//    and the imported video is reachable through its URL-encoded preview URL.
async function testWindowsStylePaths() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory 路徑 測試-'));
  const workflowCopy = path.join(baseDir, '工作流 目錄', 'Wan 2.2 圖生影片.api.json');
  await fs.mkdir(path.dirname(workflowCopy), { recursive: true });
  await fs.copyFile(workflowPath, workflowCopy);
  const workflow = JSON.parse(await fs.readFile(workflowCopy, 'utf8'));
  const comfy = await startMockComfy(workflow);
  const outputDir = path.join(baseDir, '輸出 影片');
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    outputDir,
    comfyUIUrl: comfy.url,
    comfyUIWorkflowPath: workflowCopy,
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const check = await postJson(`${origin}/api/inference/workflow-check`, { videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true });
    assert.equal(check.body.ready, true, JSON.stringify(check.body.errors));
    const created = await postJson(`${origin}/api/inference/jobs`, {
      prompt: '貓咪轉頭 "quoted" \\ backslash',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '480x832', duration: 2, fps: 24 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const manifest = JSON.parse(await fs.readFile(created.body.manifestPath, 'utf8'));
    // L6: only the workflow's file name and content hash are stored, never its absolute path.
    assert.equal(manifest.workflowPath, undefined);
    assert.equal(manifest.workflowName, 'Wan 2.2 圖生影片.api.json');
    assert.equal(manifest.workflowSha256, crypto.createHash('sha256').update(await fs.readFile(workflowCopy)).digest('hex'));
    assert.equal(Object.values(manifest).some((value) => typeof value === 'string' && value.includes('工作流 目錄')), false);
    assert.ok(manifest.manifestPath.startsWith(outputDir));
    comfy.mock.history[created.body.comfyPromptId] = successHistory(created.body.comfyPromptId, {
      11: { images: [{ filename: '貓 影片_00001_.webm', subfolder: '子 資料夾', type: 'output' }] },
    });
    const done = await fetch(`${origin}/api/inference/jobs/${created.body.id}`).then((response) => response.json());
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.deepEqual(comfy.mock.viewRequests, ['貓 影片_00001_.webm']);
    const preview = await fetch(`${origin}${done.outputs[0].previewUrl}`);
    assert.equal(preview.status, 200);
    assert.equal(await preview.text(), 'webm:貓 影片_00001_.webm');
    const metadata = JSON.parse(await fs.readFile(path.join(outputDir, `${done.outputs[0].fileName}.json`), 'utf8'));
    assert.equal(metadata.prompt, '貓咪轉頭 "quoted" \\ backslash');
    assert.equal(metadata.width, 480);
    assert.equal(metadata.height, 832);
    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow:windows-paths' }));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => comfy.server.close(resolve));
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Security review round: CSRF/DNS rebinding guard, frame limit, image checks, upload target, seed parsing, template-only
// placeholder check, workflow provenance in manifests, bounded ComfyUI errors, /view 404 and temp/output dedupe.
// ---------------------------------------------------------------------------------------------------------------

function pngHeader(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function jpegHeader(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webpVp8xHeader(width, height) {
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(22, 4);
  header.write('WEBPVP8X', 8, 'latin1');
  header.writeUInt32LE(10, 16);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return header;
}

const toDataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;

// Raw request so tests can set Host / Origin / Sec-Fetch-Site, which fetch() would override or forbid.
function rawRequest(port, { method = 'GET', path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, body: json, text });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function testSecurityReviewFixes() {
  const workflow = JSON.parse(await fs.readFile(workflowPath, 'utf8'));
  const comfy = await startMockComfy(workflow);
  const { mock } = comfy;
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-wan-sec-'));
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    outputDir,
    comfyUIUrl: comfy.url,
    comfyUIWorkflowPath: workflowPath,
    publicPorts: '18080',
  });
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const jobPayload = (overrides = {}) => ({
    prompt: 'security',
    videoModelId: 'wan-2.2-ti2v-5b',
    sourceImageDataUrl: PNG_DATA_URL,
    ...overrides,
    settings: { resolution: '832x480', duration: 2, fps: 24, seed: 5, ...overrides.settings },
  });
  const listJobs = () => fetch(`${origin}/api/inference/jobs`).then((response) => response.json());

  try {
    // M1a: Host must be a loopback name on our port (or a configured public port) -- blocks DNS rebinding.
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, `192.168.1.10:${port}`, `localhost`]) {
      const rebinding = await rawRequest(port, { path: '/api/config', headers: { host } });
      assert.equal(rebinding.status, 403, `Host "${host}" must be refused`);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`, 'localhost:18080']) {
      assert.equal((await rawRequest(port, { path: '/api/config', headers: { host } })).status, 200, host);
    }
    // Static pages are not API calls and stay reachable regardless of Host.
    assert.equal((await rawRequest(port, { path: '/', headers: { host: `evil.example:${port}` } })).status, 200);

    // M1b: a present Origin must be same-origin with the Host.
    const jobsBefore = (await listJobs()).length;
    const crossOrigin = await rawRequest(port, {
      method: 'POST',
      path: '/api/inference/jobs',
      headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify(jobPayload()),
    });
    assert.equal(crossOrigin.status, 403);
    for (const badOrigin of ['null', `http://localhost:${port}`, `https://127.0.0.1:${port}`]) {
      const response = await rawRequest(port, {
        method: 'POST',
        path: '/api/inference/workflow-check',
        headers: { host: `127.0.0.1:${port}`, origin: badOrigin, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403, `Origin ${badOrigin}`);
    }
    const sameOrigin = await rawRequest(port, {
      method: 'POST',
      path: '/api/inference/workflow-check',
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true }),
    });
    assert.equal(sameOrigin.status, 200);

    // M1c: CORS "simple" requests (text/plain, form posts) cannot reach state-changing routes.
    const uploadsBefore = mock.uploads.length;
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const simple = await rawRequest(port, {
        method: 'POST',
        path: '/api/inference/jobs',
        headers: { host: `127.0.0.1:${port}`, 'content-type': contentType },
        body: JSON.stringify(jobPayload()),
      });
      assert.equal(simple.status, 415, contentType);
    }
    const outputDirChange = await rawRequest(port, {
      method: 'POST',
      path: '/api/config/output-dir',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' },
      body: JSON.stringify({ outputDir: path.join(os.tmpdir(), 'attacker-chosen') }),
    });
    assert.equal(outputDirChange.status, 415);
    assert.equal(app.getOutputDir(), outputDir);
    assert.equal((await listJobs()).length, jobsBefore);
    assert.equal(mock.uploads.length, uploadsBefore);
    // "application/json; charset=utf-8" is still JSON.
    const jsonWithCharset = await rawRequest(port, {
      method: 'POST',
      path: '/api/inference/workflow-check',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    assert.equal(jsonWithCharset.status, 200);

    // Binary upload keeps application/octet-stream, but a browser request needs the custom header or same Origin.
    const metadataBytes = Buffer.from(JSON.stringify({ id: 'sec', fileName: 'sec-upload.webm' }));
    const uploadBody = Buffer.concat([Buffer.alloc(4), metadataBytes, Buffer.from('webm-bytes')]);
    uploadBody.writeUInt32BE(metadataBytes.length, 0);
    const upload = (headers) => rawRequest(port, {
      method: 'POST',
      path: '/api/videos',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/octet-stream', ...headers },
      body: uploadBody,
    });
    assert.equal((await upload({ 'sec-fetch-site': 'cross-site' })).status, 415);
    assert.equal((await upload({ origin: 'http://evil.example', 'x-vediofactory-request': '1' })).status, 403);
    assert.equal((await upload({ 'sec-fetch-site': 'same-origin', 'x-vediofactory-request': '1' })).status, 201);
    assert.equal((await upload({ 'sec-fetch-site': 'same-origin', origin })).status, 201);
    // Bodiless non-GET requests (DELETE, cancel) from a browser also need the header or the same Origin.
    const bodilessDelete = await rawRequest(port, {
      method: 'DELETE',
      path: '/api/videos/sec-upload.webm',
      headers: { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(bodilessDelete.status, 415);
    assert.ok(await fs.stat(path.join(outputDir, 'sec-upload.webm')));
    const sameOriginDelete = await rawRequest(port, {
      method: 'DELETE',
      path: '/api/videos/sec-upload.webm',
      headers: { host: `127.0.0.1:${port}`, origin, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(sameOriginDelete.status, 200);

    // L1: bytes must match the declared MIME type; width and height are capped at 4096.
    const imageCases = [
      [toDataUrl('image/png', jpegHeader(64, 64)), 400, /不符/u],
      [toDataUrl('image/jpeg', pngHeader(64, 64)), 400, /不符/u],
      [toDataUrl('image/webp', Buffer.from('RIFF0000WAVEfmt ')), 400, /不符/u],
      [toDataUrl('image/png', Buffer.from('hello')), 400, /不符/u],
      [toDataUrl('image/png', pngHeader(4097, 16)), 400, /4097x16.*4096/u],
      [toDataUrl('image/jpeg', jpegHeader(16, 5000)), 400, /16x5000/u],
      [toDataUrl('image/webp', webpVp8xHeader(8192, 8)), 400, /8192x8/u],
      [toDataUrl('image/png', pngHeader(0, 16)), 400, /0x16/u],
      [toDataUrl('image/png', pngHeader(4096, 4096)), 201],
      [toDataUrl('image/jpeg', jpegHeader(1280, 720)), 201],
      [toDataUrl('image/webp', webpVp8xHeader(832, 480)), 201],
    ];
    for (const [dataUrl, status, pattern] of imageCases) {
      const uploadsBeforeImage = mock.uploads.length;
      const response = await postJson(`${origin}/api/inference/jobs`, jobPayload({ sourceImageDataUrl: dataUrl }));
      assert.equal(response.status, status, `${dataUrl.slice(0, 40)}: ${JSON.stringify(response.body)}`);
      if (pattern) {
        assert.match(response.body.error, pattern);
        assert.equal(mock.uploads.length, uploadsBeforeImage, 'rejected images must not be uploaded');
      }
    }

    // L2: uploads go to input/vediofactory without overwrite; LoadImage gets the matching "subfolder/name" value.
    const uploaded = await postJson(`${origin}/api/inference/jobs`, jobPayload());
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const lastUpload = mock.uploads.at(-1);
    assert.deepEqual(
      { overwrite: lastUpload.overwrite, subfolder: lastUpload.subfolder, type: lastUpload.type },
      { overwrite: 'false', subfolder: 'vediofactory', type: 'input' },
    );
    assert.match(lastUpload.name, /^vediofactory-[a-f\d]{32}\.png$/u);
    assert.equal(uploaded.body.workflowVariables.source_image, `vediofactory/${lastUpload.name}`);
    assert.equal(mock.lastPrompt['7'].inputs.image, `vediofactory/${lastUpload.name}`);
    // Same image, same content-hash name: ComfyUI dedupes it instead of storing another copy.
    await postJson(`${origin}/api/inference/jobs`, jobPayload());
    assert.equal(mock.uploads.at(-1).name, lastUpload.name);

    // L3: seed is an integer number or a decimal digit string of at most 10 digits.
    for (const seed of [true, false, '0x10', ' ', '1e3', '1.0', '-1', '+5', ' 5', '12345678901', [], {}, 1e21, 2.5]) {
      const rejected = await postJson(`${origin}/api/inference/jobs`, jobPayload({ settings: { seed } }));
      assert.equal(rejected.status, 400, `seed ${JSON.stringify(seed)} must be rejected`);
      assert.match(rejected.body.error, /種子/u);
    }
    for (const [seed, expected] of [['42', 42], ['0', 0], ['4294967295', 2 ** 32 - 1], [77, 77]]) {
      const accepted = await postJson(`${origin}/api/inference/jobs`, jobPayload({ settings: { seed } }));
      assert.equal(accepted.status, 201, `seed ${JSON.stringify(seed)}: ${JSON.stringify(accepted.body)}`);
      assert.equal(accepted.body.workflowVariables.seed, expected);
    }
    assert.equal((await postJson(`${origin}/api/inference/jobs`, jobPayload({ settings: { seed: '4294967296' } }))).status, 400);

    // L4: only the template is scanned for placeholders, so user text containing "{{x}}" is passed through verbatim.
    const braces = await postJson(`${origin}/api/inference/jobs`, jobPayload({ prompt: 'a {{cat}} and {{prompt}}' }));
    assert.equal(braces.status, 201, JSON.stringify(braces.body));
    assert.equal(mock.lastPrompt['5'].inputs.text, 'a {{cat}} and {{prompt}}');

    // L7: ComfyUI error text is bounded to 1,000 characters (error.message and the node_errors summary).
    const prefixLength = 'ComfyUI 拒絕工作流：'.length;
    mock.promptError = { error: { type: 'x', message: 'M'.repeat(5_000), details: 'D'.repeat(5_000) } };
    const longMessage = await postJson(`${origin}/api/inference/jobs`, jobPayload());
    assert.equal(longMessage.status, 400);
    assert.ok(longMessage.body.error.length <= 1_000 + prefixLength, `${longMessage.body.error.length}`);
    mock.promptError = {
      error: { type: 'prompt_outputs_failed_validation', message: 'failed' },
      node_errors: Object.fromEntries(Array.from({ length: 10 }, (unused, index) => [index, {
        class_type: 'KSampler',
        errors: [{ details: 'Z'.repeat(800) }],
      }])),
    };
    const longNodeErrors = await postJson(`${origin}/api/inference/jobs`, jobPayload());
    assert.equal(longNodeErrors.status, 400);
    assert.match(longNodeErrors.body.error, /節點 0（KSampler）/u);
    assert.ok(longNodeErrors.body.error.length <= 1_000 + prefixLength, `${longNodeErrors.body.error.length}`);
    mock.promptError = null;

    // QA: a /view 404 (output deleted in ComfyUI) fails the job instead of retrying on every poll.
    const deleted = await postJson(`${origin}/api/inference/jobs`, jobPayload());
    mock.viewMode = '404';
    mock.viewRequests = [];
    mock.history[deleted.body.comfyPromptId] = successHistory(deleted.body.comfyPromptId, {
      11: { images: [{ filename: 'gone_00001_.webm', subfolder: 'vediofactory', type: 'output' }] },
    });
    const deletedJob = await fetch(`${origin}/api/inference/jobs/${deleted.body.id}`).then((response) => response.json());
    assert.equal(deletedJob.status, 'failed', JSON.stringify(deletedJob));
    assert.match(deletedJob.error, /404.*gone_00001_\.webm/u);
    assert.deepEqual(deletedJob.outputs, []);
    const deletedAgain = await fetch(`${origin}/api/inference/jobs/${deleted.body.id}`).then((response) => response.json());
    assert.equal(deletedAgain.status, 'failed');
    assert.equal(mock.viewRequests.length, 1, 'a failed job must not be downloaded again');
    assert.equal(JSON.parse(await fs.readFile(deleted.body.manifestPath, 'utf8')).status, 'failed');
    mock.viewMode = 'ok';

    // QA: the same file reported as temp preview and as output is imported once, from "output".
    const dedupe = await postJson(`${origin}/api/inference/jobs`, jobPayload());
    mock.viewRequests = [];
    mock.viewTypes = [];
    mock.history[dedupe.body.comfyPromptId] = successHistory(dedupe.body.comfyPromptId, {
      10: { images: [{ filename: 'dup_00001_.webm', subfolder: 'vediofactory', type: 'temp' }] },
      11: { images: [{ filename: 'dup_00001_.webm', subfolder: 'vediofactory', type: 'output' }] },
      12: { images: [{ filename: 'dup_00001_.webm', subfolder: 'other', type: 'temp' }] },
    });
    const dedupeJob = await fetch(`${origin}/api/inference/jobs/${dedupe.body.id}`).then((response) => response.json());
    assert.equal(dedupeJob.status, 'succeeded');
    assert.equal(dedupeJob.outputs.length, 2, 'different subfolders are different files');
    assert.deepEqual(mock.viewTypes, ['output', 'temp']);

    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow:security-review-fixes' }));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => comfy.server.close(resolve));
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Optional LoRA: placeholder node removed without a LoRA, filled from ComfyUI's own list with one, strict validation.
// ---------------------------------------------------------------------------------------------------------------

const TEST_LORA = 'DR34ML4Y_TI2V_5B_V1.safetensors';

async function testLoraSupport() {
  const workflow = JSON.parse(await fs.readFile(workflowPath, 'utf8'));
  // The shipped template carries the LoRA node between UNETLoader and ModelSamplingSD3.
  assert.equal(workflow['12'].class_type, 'LoraLoaderModelOnly');
  assert.deepEqual(workflow['12'].inputs, { model: ['1', 0], lora_name: '{{lora_name}}', strength_model: '{{lora_strength}}' });
  assert.deepEqual(workflow['4'].inputs.model, ['12', 0]);
  // The pre-LoRA graph: what a run without a LoRA must submit (node 12 gone, sampler fed by the UNET directly).
  const preLoraWorkflow = structuredClone(workflow);
  delete preLoraWorkflow['12'];
  preLoraWorkflow['4'].inputs.model = ['1', 0];

  // ComfyUI's lora_name combo also lists entries vedioFactory must never offer: subfolders, traversal, non-safetensors.
  const comfyLoraList = [
    TEST_LORA, 'style.safetensors', 'old.ckpt', 'wan\\nested.safetensors', 'wan/nested2.safetensors',
    '..\\evil.safetensors', '.hidden.safetensors',
  ];
  const comfy = await startMockComfy(workflow, {
    LoraLoaderModelOnly: {
      input: {
        required: {
          model: ['MODEL'],
          lora_name: [comfyLoraList],
          strength_model: ['FLOAT', { default: 1, min: -100, max: 100, step: 0.01 }],
        },
      },
    },
  });
  const { mock } = comfy;
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-wan-lora-'));
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    outputDir,
    comfyUIUrl: comfy.url,
    comfyUIWorkflowPath: workflowPath,
  });
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const jobPayload = (settings = {}) => ({
    prompt: 'a fox turns its head',
    videoModelId: 'wan-2.2-ti2v-5b',
    sourceImageDataUrl: PNG_DATA_URL,
    settings: { resolution: '832x480', duration: 2, fps: 24, quality: 'draft', seed: 7, ...settings },
  });
  const readMetadata = async (jobId, promptId, fileName) => {
    mock.history[promptId] = successHistory(promptId, {
      11: { images: [{ filename: fileName, subfolder: 'vediofactory', type: 'output' }] },
    });
    const done = await fetch(`${origin}/api/inference/jobs/${jobId}`).then((response) => response.json());
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    return JSON.parse(await fs.readFile(path.join(outputDir, `${done.outputs[0].fileName}.json`), 'utf8'));
  };
  const readManifest = async (jobId) => {
    const dir = path.join(outputDir, 'inference-jobs');
    const name = (await fs.readdir(dir)).find((entry) => entry.includes(jobId) && entry.endsWith('.json'));
    return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
  };

  try {
    // 1. LoRA list API: only bare .safetensors names from ComfyUI's list, plus known-LoRA metadata.
    const list = await fetch(`${origin}/api/inference/loras`).then((response) => response.json());
    assert.equal(list.available, true);
    assert.deepEqual(list.loras, [TEST_LORA, 'style.safetensors']);
    assert.equal(list.maxStrength, 2);
    assert.equal(list.defaultStrength, 1);
    const known = list.catalog.find((entry) => entry.file === TEST_LORA);
    assert.equal(known.installed, true);
    assert.equal(known.modelVersionId, 2099309);
    assert.equal(known.sha256, 'd646701e1f9ec369d78146cbfd5fe71b4abaf145e33f6ab93ff698f6755354ee');
    assert.ok(known.trainedWords.includes('m15510n4ry'));
    assert.match(known.license, /不可商用/u);
    assert.match(known.license, /衍生/u);
    assert.equal(validateModelFileSource({ ...known, provider: 'civitai', folder: 'loras', source: 'https://civitai.com/api/download/models/2099309' }, 'lora').file, TEST_LORA);
    // M1: the new GET route sits behind the same Host / Origin guard as every /api route.
    assert.equal((await rawRequest(port, { path: '/api/inference/loras', headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await rawRequest(port, {
      path: '/api/inference/loras',
      headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example' },
    })).status, 403);

    // 2. Workflow check: without a LoRA the report describes the 11-node pre-LoRA graph.
    const plainCheck = await postJson(`${origin}/api/inference/workflow-check`, { videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true });
    assert.equal(plainCheck.body.ready, true, JSON.stringify(plainCheck.body.errors));
    assert.equal(plainCheck.body.nodeCount, 11);
    assert.ok(!plainCheck.body.nodeTypes.includes('LoraLoaderModelOnly'));
    assert.ok(!plainCheck.body.placeholders.includes('lora_name'));
    const loraCheck = await postJson(`${origin}/api/inference/workflow-check`, { videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true, hasLora: true });
    assert.equal(loraCheck.body.ready, true, JSON.stringify(loraCheck.body.errors));
    assert.equal(loraCheck.body.nodeCount, 12);
    assert.ok(loraCheck.body.placeholders.includes('lora_name') && loraCheck.body.placeholders.includes('lora_strength'));

    // 3. No LoRA: the submitted graph is exactly the pre-LoRA graph (same nodes, links and literal values).
    const plain = await postJson(`${origin}/api/inference/jobs`, jobPayload());
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const submittedPlain = mock.lastPrompt;
    assert.deepEqual(Object.keys(submittedPlain).sort(), Object.keys(preLoraWorkflow).sort());
    assert.equal(submittedPlain['12'], undefined);
    assert.deepEqual(submittedPlain['4'].inputs.model, ['1', 0]);
    for (const [nodeId, node] of Object.entries(preLoraWorkflow)) {
      assert.equal(submittedPlain[nodeId].class_type, node.class_type, nodeId);
      for (const [name, value] of Object.entries(node.inputs)) {
        if (typeof value === 'string' && value.includes('{{')) continue;
        assert.deepEqual(submittedPlain[nodeId].inputs[name], value, `${nodeId}.${name}`);
      }
    }
    assert.doesNotMatch(JSON.stringify(submittedPlain), /\{\{|LoraLoader/u);
    assert.equal(plain.body.settings.loraName, undefined);
    assert.equal(plain.body.settings.loraStrength, undefined);
    assert.deepEqual(Object.keys(plain.body.workflowVariables).sort(), ['fps', 'frames', 'height', 'seed', 'source_image', 'steps', 'width']);
    // An explicit "none" ('' / null) is the same as omitting it; a strength without a LoRA is validated but unused.
    for (const settings of [{ loraName: '' }, { loraName: null }, { loraName: '', loraStrength: 1.5 }]) {
      const none = await postJson(`${origin}/api/inference/jobs`, jobPayload(settings));
      assert.equal(none.status, 201, JSON.stringify(none.body));
      assert.equal(mock.lastPrompt['12'], undefined);
      assert.equal(none.body.settings.loraName, undefined);
    }

    // 4. With a LoRA: node 12 is kept and filled in, and the sampler still reads the LoRA output.
    const withLora = await postJson(`${origin}/api/inference/jobs`, jobPayload({ loraName: TEST_LORA, loraStrength: 0.75 }));
    assert.equal(withLora.status, 201, JSON.stringify(withLora.body));
    const submittedLora = mock.lastPrompt;
    assert.deepEqual(submittedLora['12'], {
      class_type: 'LoraLoaderModelOnly',
      _meta: workflow['12']._meta,
      inputs: { model: ['1', 0], lora_name: TEST_LORA, strength_model: 0.75 },
    });
    assert.deepEqual(submittedLora['4'].inputs.model, ['12', 0]);
    assert.doesNotMatch(JSON.stringify(submittedLora), /\{\{/u);
    assert.equal(withLora.body.settings.loraName, TEST_LORA);
    assert.equal(withLora.body.settings.loraStrength, 0.75);
    assert.equal(withLora.body.workflowVariables.lora_name, TEST_LORA);
    assert.equal(withLora.body.workflowVariables.lora_strength, 0.75);
    // Default strength is 1; a plain decimal string is accepted.
    const defaultStrength = await postJson(`${origin}/api/inference/jobs`, jobPayload({ loraName: TEST_LORA }));
    assert.equal(defaultStrength.status, 201, JSON.stringify(defaultStrength.body));
    assert.equal(mock.lastPrompt['12'].inputs.strength_model, 1);
    const stringStrength = await postJson(`${origin}/api/inference/jobs`, jobPayload({ loraName: 'style.safetensors', loraStrength: '2' }));
    assert.equal(stringStrength.status, 201, JSON.stringify(stringStrength.body));
    assert.equal(mock.lastPrompt['12'].inputs.strength_model, 2);
    assert.equal(mock.lastPrompt['12'].inputs.lora_name, 'style.safetensors');
    const zeroStrength = await postJson(`${origin}/api/inference/jobs`, jobPayload({ loraName: TEST_LORA, loraStrength: 0 }));
    assert.equal(zeroStrength.status, 201, JSON.stringify(zeroStrength.body));
    assert.equal(mock.lastPrompt['12'].inputs.strength_model, 0);

    // 5. Rejections: 400, nothing submitted and nothing uploaded (ComfyUI cannot delete uploads).
    const rejected = {
      'not in ComfyUI list': { loraName: 'missing.safetensors' },
      'forward-slash path (listed by ComfyUI)': { loraName: 'wan/nested2.safetensors' },
      'backslash path (listed by ComfyUI)': { loraName: 'wan\\nested.safetensors' },
      traversal: { loraName: '..\\evil.safetensors' },
      'absolute Windows path': { loraName: 'C:\\Users\\User\\ComfyUI\\models\\loras\\DR34ML4Y_TI2V_5B_V1.safetensors' },
      'absolute POSIX path': { loraName: '/etc/x.safetensors' },
      'dot file': { loraName: '.hidden.safetensors' },
      'ckpt (listed by ComfyUI)': { loraName: 'old.ckpt' },
      'pt file': { loraName: 'model.pt' },
      'no extension': { loraName: 'DR34ML4Y_TI2V_5B_V1' },
      'non-string name': { loraName: ['DR34ML4Y_TI2V_5B_V1.safetensors'] },
      'strength above 2': { loraName: TEST_LORA, loraStrength: 2.01 },
      'strength below 0': { loraName: TEST_LORA, loraStrength: -0.1 },
      'strength NaN-ish string': { loraName: TEST_LORA, loraStrength: 'abc' },
      'strength exponent string': { loraName: TEST_LORA, loraStrength: '1e0' },
      'strength boolean': { loraName: TEST_LORA, loraStrength: true },
      'strength out of range without LoRA': { loraStrength: 5 },
    };
    for (const [label, settings] of Object.entries(rejected)) {
      const promptsBefore = mock.promptCount;
      const uploadsBefore = mock.uploads.length;
      const result = await postJson(`${origin}/api/inference/jobs`, jobPayload(settings));
      assert.equal(result.status, 400, `${label}: ${JSON.stringify(result.body)}`);
      assert.match(result.body.error, /LoRA/u, label);
      assert.equal(mock.promptCount, promptsBefore, `${label}: nothing may be submitted`);
      assert.equal(mock.uploads.length, uploadsBefore, `${label}: nothing may be uploaded`);
    }
    // A catalog LoRA whose compatibleVideoModelIds excludes the selected video model is refused (the UI warns
    // "不相容"); LoRAs without catalog metadata stay allowed for any model.
    {
      const promptsBefore = mock.promptCount;
      const uploadsBefore = mock.uploads.length;
      const incompatible = await postJson(`${origin}/api/inference/jobs`, {
        ...jobPayload({ loraName: TEST_LORA }), videoModelId: 'wan-2.1-t2v-1.3b',
      });
      assert.equal(incompatible.status, 400, JSON.stringify(incompatible.body));
      assert.match(incompatible.body.error, /LoRA.*不相容/u);
      assert.equal(mock.promptCount, promptsBefore, 'incompatible LoRA: nothing may be submitted');
      assert.equal(mock.uploads.length, uploadsBefore, 'incompatible LoRA: nothing may be uploaded');
    }

    // 6. Metadata and job manifest record the LoRA; runs without one have no LoRA fields.
    const loraMetadata = await readMetadata(withLora.body.id, withLora.body.comfyPromptId, 'lora_00001_.webm');
    assert.equal(loraMetadata.loraName, TEST_LORA);
    assert.equal(loraMetadata.loraStrength, 0.75);
    const loraManifest = await readManifest(withLora.body.id);
    assert.equal(loraManifest.settings.loraName, TEST_LORA);
    assert.equal(loraManifest.settings.loraStrength, 0.75);
    assert.equal(loraManifest.workflowVariables.lora_name, TEST_LORA);
    assert.equal(loraManifest.workflowVariables.lora_strength, 0.75);
    const plainMetadata = await readMetadata(plain.body.id, plain.body.comfyPromptId, 'plain_00001_.webm');
    assert.equal(plainMetadata.loraName, undefined);
    assert.equal(plainMetadata.loraStrength, undefined);
    const plainManifest = await readManifest(plain.body.id);
    assert.equal(plainManifest.settings.loraName, undefined);
    assert.equal(plainManifest.workflowVariables.lora_name, undefined);

    // 7. ComfyUI unreachable: the list API degrades to available:false instead of failing the page.
    mock.down = true;
    const offline = await fetch(`${origin}/api/inference/loras`).then((response) => response.json());
    assert.equal(offline.available, false);
    assert.deepEqual(offline.loras, []);
    assert.ok(offline.error);
    mock.down = false;

    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow:lora' }));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => comfy.server.close(resolve));
    await fs.rm(outputDir, { recursive: true, force: true });
  }

  // 8. A workflow without a {{lora_name}} node refuses a LoRA rather than silently ignoring it.
  const a14bPath = path.join(repoRoot, 'workflows', 'wan22-i2v-a14b-4step.api.json');
  const a14b = JSON.parse(await fs.readFile(a14bPath, 'utf8'));
  const comfyA14b = await startMockComfy(a14b, {
    LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: [[TEST_LORA]], strength_model: ['FLOAT', {}] } } },
  });
  const outputDirA14b = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-wan-lora-a14b-'));
  const appA14b = await startServer({
    port: 0, host: '127.0.0.1', outputDir: outputDirA14b, comfyUIUrl: comfyA14b.url, comfyUIWorkflowPath: a14bPath,
  });
  try {
    const result = await postJson(`http://127.0.0.1:${appA14b.server.address().port}/api/inference/jobs`, {
      prompt: 'fox',
      videoModelId: 'wan-2.2-ti2v-5b',
      sourceImageDataUrl: PNG_DATA_URL,
      settings: { resolution: '832x480', duration: 2, fps: 24, loraName: TEST_LORA },
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error, /lora_name/u);
    assert.equal(comfyA14b.mock.promptCount, 0);
    assert.equal(comfyA14b.mock.uploads.length, 0);
    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow:lora-unsupported-workflow' }));
  } finally {
    await new Promise((resolve) => appA14b.server.close(resolve));
    await new Promise((resolve) => comfyA14b.server.close(resolve));
    await fs.rm(outputDirA14b, { recursive: true, force: true });
  }
}

// 9. The chained >=10 s dance workflow: {{frames}} is per segment, segments 2/3 start from the previous segment's last
// decoded frame, duplicated first frames are dropped before concatenation, and each segment gets its own seed.
async function testDanceChainWorkflow() {
  const dancePath = path.join(repoRoot, 'workflows', 'wan22-ti2v-5b-dance-10s.api.json');
  const dance = JSON.parse(await fs.readFile(dancePath, 'utf8'));
  for (const [nodeId, node] of Object.entries(dance)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(dance[value[0]], `node ${nodeId} links to missing node ${value[0]}`);
    }
  }
  assert.equal(JSON.stringify(dance).includes('DR34ML4Y'), false);
  // Real ComfyUI declares expression as a free STRING, not a combo (the generic mock turns literals into combos).
  const comfy = await startMockComfy(dance, {
    ComfyMathExpression: { input: { required: { expression: ['STRING', { multiline: true }], values: ['COMFY_AUTOGROW_V3', {}] } } },
  });
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-wan-dance-'));
  const app = await startServer({
    port: 0, host: '127.0.0.1', outputDir, comfyUIUrl: comfy.url, comfyUIWorkflowPath: dancePath,
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const submitDance = (settings) => postJson(`${origin}/api/inference/jobs`, {
    prompt: 'A woman dances.',
    videoModelId: 'wan-2.2-ti2v-5b',
    sourceImageDataUrl: PNG_DATA_URL,
    settings: { resolution: '544x960', fps: 24, quality: 'balanced', seed: 7, ...settings },
  });
  try {
    // The workflow declares its chain on the output node; ComfyUI ignores node _meta.
    assert.deepEqual(dance['11']._meta.vediofactory, { segments: 3, overlapFrames: 1 });
    // The UI can read "最長 N 秒" from the runtime and the preflight report: 3 x 121 - 2 = 361 frames = 15 s @ 24 fps.
    const runtime = await fetch(`${origin}/api/inference/runtime?videoModelId=wan-2.2-ti2v-5b`).then((r) => r.json());
    assert.deepEqual(runtime.comfyUI.workflowSegments, {
      segments: 3,
      overlapFrames: 1,
      chained: true,
      durationIsTotal: true,
      maxFramesPerSegment: 121,
      maxDurationSecondsByFps: { 12: 30, 24: 15, 30: 12 },
      videoModelId: 'wan-2.2-ti2v-5b',
    });
    const check = await postJson(`${origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true,
    });
    assert.equal(check.status, 200);
    assert.equal(check.body.ready, true, JSON.stringify(check.body.errors));
    assert.equal(check.body.workflowSegments.maxDurationSecondsByFps[24], 15);

    // Duration is the TOTAL length: smallest 4n+1 per segment with 3 x frames - 2 >= duration x fps.
    for (const [duration, fps, perSegment, total] of [[10, 24, 81, 241], [12, 24, 97, 289], [15, 24, 121, 361], [10, 30, 101, 301]]) {
      const accepted = await submitDance({ duration, fps });
      assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
      const variables = accepted.body.workflowVariables;
      assert.equal(variables.frames, perSegment, `${duration}s@${fps}`);
      assert.equal(variables.frames % 4, 1);
      assert.equal(variables.segments, 3);
      assert.equal(variables.overlap_frames, 1);
      assert.equal(variables.total_frames, total);
      assert.ok(total >= duration * fps);
      assert.equal(variables.width, 544);
      assert.equal(variables.height, 960);
      for (const latentId of ['8', '22', '32']) assert.equal(comfy.mock.lastPrompt[latentId].inputs.length, perSegment);
    }
    // Too long: per segment exceeds the 121-frame model limit; rejected before any upload.
    const uploadsBefore = comfy.mock.uploads.length;
    const promptsBefore = comfy.mock.promptCount;
    for (const [duration, fps, pattern] of [
      [16, 24, /3 段 × 每段 129 影格.*每段上限 121 影格.*24 fps 時片長須為 2 至 15 秒/u],
      [13, 30, /3 段 × 每段 133 影格.*30 fps 時片長須為 2 至 12 秒/u],
    ]) {
      const refused = await submitDance({ duration, fps });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, pattern);
    }
    assert.equal(comfy.mock.uploads.length, uploadsBefore);
    assert.equal(comfy.mock.promptCount, promptsBefore);

    // The imported video's metadata records per-segment and total frames.
    const finished = await submitDance({ duration: 10, fps: 24 });
    assert.equal(finished.status, 201);
    const promptId = finished.body.comfyPromptId;
    comfy.mock.history[promptId] = successHistory(promptId, {
      11: { images: [{ filename: 'dance_00001_.webm', subfolder: 'vediofactory', type: 'output' }] },
    });
    const done = await fetch(`${origin}/api/inference/jobs/${finished.body.id}`).then((r) => r.json());
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const metadata = JSON.parse(await fs.readFile(path.join(outputDir, `${done.outputs[0].fileName}.json`), 'utf8'));
    assert.equal(metadata.frames, 81);
    assert.equal(metadata.segments, 3);
    assert.equal(metadata.totalFrames, 241);
    assert.equal(metadata.duration, 10);
    assert.equal(metadata.resolution, '544x960');

    // A malformed or contradictory marker fails preflight instead of silently running as one segment.
    for (const [marker, pattern] of [
      [{ segments: 0 }, /segments 必須是 1 至 16/u],
      [{ segments: 3, overlapFrames: -1 }, /overlapFrames 必須是 0 至 64/u],
      ['3', /必須是物件/u],
    ]) {
      const badPath = path.join(outputDir, 'bad-marker.api.json');
      const bad = structuredClone(dance);
      bad['11']._meta.vediofactory = marker;
      await fs.writeFile(badPath, JSON.stringify(bad));
      const badApp = await startServer({
        port: 0, host: '127.0.0.1', outputDir, comfyUIUrl: comfy.url, comfyUIWorkflowPath: badPath,
      });
      try {
        const badOrigin = `http://127.0.0.1:${badApp.server.address().port}`;
        const badCheck = await postJson(`${badOrigin}/api/inference/workflow-check`, { videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true });
        assert.equal(badCheck.body.ready, false);
        assert.match(badCheck.body.errors.join(' '), pattern);
        const badJob = await postJson(`${badOrigin}/api/inference/jobs`, {
          prompt: 'x', videoModelId: 'wan-2.2-ti2v-5b', sourceImageDataUrl: PNG_DATA_URL, settings: { duration: 10 },
        });
        assert.equal(badJob.status, 400);
        assert.match(badJob.body.error, pattern);
      } finally {
        await new Promise((resolve) => badApp.server.close(resolve));
      }
    }
    const contradictoryPath = path.join(outputDir, 'contradictory.api.json');
    const contradictory = structuredClone(dance);
    contradictory['5']._meta.vediofactory = { segments: 2, overlapFrames: 1 };
    await fs.writeFile(contradictoryPath, JSON.stringify(contradictory));
    const contradictoryApp = await startServer({
      port: 0, host: '127.0.0.1', outputDir, comfyUIUrl: comfy.url, comfyUIWorkflowPath: contradictoryPath,
    });
    try {
      const contradictoryRuntime = await fetch(
        `http://127.0.0.1:${contradictoryApp.server.address().port}/api/inference/runtime`,
      ).then((r) => r.json());
      assert.match(contradictoryRuntime.comfyUI.workflowSegments.error, /互相矛盾/u);
    } finally {
      await new Promise((resolve) => contradictoryApp.server.close(resolve));
    }

    const result = await submitDance({ resolution: '480x832', duration: 15 });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const submitted = comfy.mock.lastPrompt;
    assert.doesNotMatch(JSON.stringify(submitted), /\{\{/u);
    assert.equal(submitted['12'], undefined, 'optional LoRA node is bypassed');
    assert.deepEqual(submitted['4'].inputs.model, ['1', 0]);
    for (const latentId of ['8', '22', '32']) {
      assert.equal(submitted[latentId].inputs.length, 121);
      assert.equal(submitted[latentId].inputs.width, 480);
      assert.equal(submitted[latentId].inputs.height, 832);
    }
    assert.deepEqual(submitted['8'].inputs.start_image, ['7', 0]);
    assert.deepEqual(submitted['22'].inputs.start_image, ['20', 0]);
    assert.deepEqual(submitted['32'].inputs.start_image, ['30', 0]);
    assert.deepEqual([submitted['20'].inputs.image, submitted['20'].inputs.batch_index], [['10', 0], -1]);
    assert.deepEqual([submitted['30'].inputs.image, submitted['30'].inputs.batch_index], [['24', 0], -1]);
    assert.equal(submitted['25'].inputs.batch_index, 1);
    assert.equal(submitted['35'].inputs.batch_index, 1);
    assert.equal(submitted['9'].inputs.seed, 7);
    assert.equal(submitted['21'].inputs['values.a'], 7);
    assert.equal(submitted['31'].inputs['values.a'], 7);
    assert.deepEqual(submitted['23'].inputs.seed, ['21', 1]);
    assert.deepEqual(submitted['33'].inputs.seed, ['31', 1]);
    assert.deepEqual(submitted['11'].inputs.images, ['41', 0]);
    assert.equal(submitted['11'].inputs.fps, 24);
    assert.match(submitted['5'].inputs.text, /^A woman dances\. The same person/u);
    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow:dance-10s-chain' }));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => comfy.server.close(resolve));
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

const MAX_SEED_PLUS_ONE = 2 ** 32;

// ---------------------------------------------------------------------------------------------------------------
// 10. Two-stage pipeline (OPTIMIZATION_PLAN 6.9): stage 1 TI2V dance -> stage-1 WebM uploaded as {{driving_video}} ->
//     stage 2 Wan Animate with the same source photo -> only the stage-2 WebM is imported. GPU preflight and guard are
//     a fake module injected through options.gpuGuard; ComfyUI is the controllable mock.
// ---------------------------------------------------------------------------------------------------------------

// Object info for several workflows on one mock: literal combo values of the same class/input are merged.
function mergeObjectInfo(...workflows) {
  const merged = {};
  for (const workflow of workflows) {
    for (const node of Object.values(workflow)) {
      merged[node.class_type] ??= { input: { required: {} } };
      const required = merged[node.class_type].input.required;
      for (const [name, value] of Object.entries(node.inputs)) {
        if (typeof value === 'string' && !value.includes('{{')) {
          if (!required[name]) required[name] = [[value]];
          else if (Array.isArray(required[name][0]) && !required[name][0].includes(value)) required[name][0].push(value);
        } else if (!required[name]) {
          required[name] = ['*'];
        }
      }
    }
  }
  return merged;
}

function createFakeGpu() {
  const gpu = {
    GPU_LIMITS: { maxPowerLimitW: 250, maxStartTempC: 65 },
    sample: { tempC: 50, powerLimitW: 250, utilPct: 0 },
    lost: false,
    preflightCalls: 0,
    interrupts: [],
    guards: [],
    async checkGpuPreflight() {
      gpu.preflightCalls += 1;
      if (gpu.lost) return { ok: false, gpuLost: true, problems: ['nvidia-smi failed: GPU is lost'] };
      const sample = { ...gpu.sample };
      const problems = [];
      if (sample.powerLimitW > gpu.GPU_LIMITS.maxPowerLimitW) problems.push('power limit');
      if (sample.tempC > gpu.GPU_LIMITS.maxStartTempC) problems.push('hot');
      if (sample.utilPct > 15) problems.push('busy');
      return { ok: problems.length === 0, problems, sample };
    },
    startGpuGuard({ label, onTrip, onLost }) {
      const guard = {
        label,
        onTrip,
        onLost,
        stopped: false,
        samples: 1,
        logFile: path.join(os.tmpdir(), `${label}.csv`),
        summary: () => ({ samples: guard.samples }),
        async stop() {
          guard.stopped = true;
          return { samples: guard.samples, maxTempC: 71, maxPowerW: 180, maxVramMiB: 13_700, hwSlowdownSamples: 0, tripped: null };
        },
      };
      gpu.guards.push(guard);
      return guard;
    },
    async interruptComfyUI(url) {
      gpu.interrupts.push(url);
    },
    activeGuards: () => gpu.guards.filter((guard) => !guard.stopped),
  };
  return gpu;
}

async function testTwoStagePipeline() {
  const stage1Path = path.join(repoRoot, 'workflows', 'wan22-ti2v-5b-dance-10s.api.json');
  const stage2Path = path.join(repoRoot, 'workflows', 'wan22-animate-dance.api.json');
  const stage1 = JSON.parse(await fs.readFile(stage1Path, 'utf8'));
  const stage2 = JSON.parse(await fs.readFile(stage2Path, 'utf8'));
  // Real ComfyUI declares these as free STRING inputs, not combos.
  const comfy = await startMockComfy(stage1, {
    ...mergeObjectInfo(stage1, stage2),
    ComfyMathExpression: { input: { required: { expression: ['STRING', { multiline: true }], values: ['COMFY_AUTOGROW_V3', {}] } } },
    SaveWEBM: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}], codec: [['vp9']], fps: ['FLOAT'], crf: ['FLOAT'] } } },
  });
  const { mock } = comfy;
  const gpu = createFakeGpu();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory 兩階段-'));
  const pipelineOptions = {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    comfyUIUrl: comfy.url,
    comfyUIWorkflowPath: stage1Path,
    comfyUIStage2WorkflowPath: stage2Path,
    gpuGuard: gpu,
    pipelinePollIntervalMs: 0, // tests drive the pipeline by polling; one case below enables the background driver
    gpuCoolingCheckIntervalMs: 0,
    gpuCoolingTimeoutMs: 60_000,
  };
  const apps = [];
  const start = async (overrides = {}) => {
    const app = await startServer({ ...pipelineOptions, ...overrides });
    apps.push(app);
    return { app, origin: `http://127.0.0.1:${app.server.address().port}` };
  };
  const close = async (app) => {
    if (!app.server.listening) return;
    await new Promise((resolve) => app.server.close(resolve));
  };
  let { app, origin } = await start();
  const getJob = async (id, base = origin) => (await fetch(`${base}/api/inference/jobs/${encodeURIComponent(id)}`)).json();
  const cancel = async (id, base = origin) => {
    const response = await fetch(`${base}/api/inference/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    return { status: response.status, body: await response.json() };
  };
  const submit = (settings = {}, extra = {}, base = origin) => postJson(`${base}/api/inference/jobs`, {
    prompt: 'The woman from the photo dances.',
    videoModelId: 'wan-2.2-ti2v-5b',
    sourceImageDataUrl: PNG_DATA_URL,
    settings: { resolution: '544x960', fps: 24, duration: 12, quality: 'balanced', seed: 7, ...settings },
    ...extra,
  });
  const created = async (settings, base) => {
    const result = await submit(settings, {}, base);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const dequeue = (promptId) => {
    mock.queuePending = mock.queuePending.filter((entry) => entry[1] !== promptId);
  };
  const finishPrompt = (promptId, nodeId, filename, bytes) => {
    dequeue(promptId);
    mock.queueRunning = mock.queueRunning.filter((entry) => entry[1] !== promptId);
    mock.viewBodies[filename] = bytes;
    const outputs = {
      [nodeId]: { images: [{ filename, subfolder: 'vediofactory', type: 'output' }], animated: [true] },
    };
    // Real ComfyUI (seen in the GPU e2e): stage 2's LoadVideo node reports a preview of its INPUT driving video in
    // the history outputs, listed before SaveWEBM. It must never be imported.
    if (nodeId === 211) {
      const driving = String(mock.lastPrompt?.['14']?.inputs?.file || 'vediofactory/driving.webm');
      const [subfolder, inputName] = driving.includes('/') ? driving.split('/') : ['', driving];
      mock.viewBodies[inputName] = 'INPUT-DRIVING-VIDEO';
      mock.history[promptId] = successHistory(promptId, {
        14: { images: [{ filename: inputName, subfolder, type: 'input' }], animated: [true] },
        ...outputs,
      });
      return;
    }
    mock.history[promptId] = successHistory(promptId, outputs);
  };
  const failPrompt = (promptId, message) => {
    dequeue(promptId);
    mock.history[promptId] = {
      status: {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { prompt_id: promptId, timestamp: 1_000 }],
          ['execution_error', { prompt_id: promptId, node_type: 'KSampler', exception_message: message, timestamp: 2_000 }],
        ],
      },
      outputs: {},
    };
  };
  const libraryItems = async (jobId, base = origin) => (await fetch(`${base}/api/videos`).then((r) => r.json()))
    .filter((item) => item.inferenceJobId === jobId);
  // Runs stage 1 to completion and returns the job right after the hand-over poll.
  const completeStage1 = async (job, base = origin) => {
    finishPrompt(job.comfyPromptId, 11, `dance-${job.id.slice(0, 8)}_00001_.webm`, `stage1:${job.id}`);
    return getJob(job.id, base);
  };

  try {
    // A. Runtime exposes the pipeline and the allowed total durations (stage-1 frames must fit 242..321).
    const runtime = await fetch(`${origin}/api/inference/runtime?videoModelId=wan-2.2-ti2v-5b`).then((r) => r.json());
    const pipelineInfo = runtime.comfyUI.pipeline;
    assert.equal(pipelineInfo.enabled, true);
    assert.equal(pipelineInfo.stageCount, 2);
    assert.equal(pipelineInfo.stage1Workflow, 'wan22-ti2v-5b-dance-10s.api.json');
    assert.equal(pipelineInfo.stage2Workflow, 'wan22-animate-dance.api.json');
    assert.deepEqual(pipelineInfo.drivingFrames, { min: 242, max: 321 });
    assert.deepEqual(pipelineInfo.allowedDurationSecondsByFps[24], { min: 11, max: 13, seconds: [11, 12, 13] });
    assert.deepEqual(pipelineInfo.referenceStrength, { default: 1.3, min: 0.5, max: 2 });
    assert.equal(pipelineInfo.stage2Steps.default, 10);
    assert.equal(pipelineInfo.gpuGuard.enabled, true);
    assert.equal(pipelineInfo.gpuGuard.maxStartTempC, 65);
    assert.equal(runtime.comfyUI.workflowSegments.maxDurationSecondsByFps[24], 13);
    assert.equal(runtime.comfyUI.workflowSegments.minDurationSecondsByFps[24], 11);
    assert.equal(gpu.preflightCalls, 0, 'runtime must not run the GPU preflight');

    // B. Preflight validates both stages, including {{driving_video}}, {{reference_strength}} and the source image.
    const check = await postJson(`${origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true, settings: { duration: 12, fps: 24, referenceStrength: 1.3 },
    });
    assert.equal(check.status, 200);
    assert.equal(check.body.ready, true, JSON.stringify(check.body.errors));
    assert.ok(check.body.pipeline.stage2.placeholders.includes('driving_video'));
    assert.ok(check.body.pipeline.stage2.placeholders.includes('reference_strength'));
    assert.equal(check.body.pipeline.stage2.comfyUILiveCheck.checked, true);
    const badCheck = await postJson(`${origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: false, settings: { duration: 10, fps: 24, referenceStrength: 2.5 },
    });
    assert.equal(badCheck.body.ready, false);
    const badErrors = badCheck.body.errors.join(' ');
    assert.match(badErrors, /兩階段流程需要來源照片/u);
    assert.match(badErrors, /參考強度必須是 0\.5 至 2/u);
    assert.match(badErrors, /24 fps 時片長須為 11 至 13 秒/u);
    // A stage-2 workflow missing {{driving_video}} fails preflight; stage-2 placeholders are refused in stage 1.
    const noDrivingPath = path.join(outputDir, 'no-driving.api.json');
    const noDriving = structuredClone(stage2);
    noDriving['14'].inputs.file = 'fixed.webm';
    await fs.writeFile(noDrivingPath, JSON.stringify(noDriving));
    const noDrivingApp = await start({ comfyUIStage2WorkflowPath: noDrivingPath });
    const noDrivingCheck = await postJson(`${noDrivingApp.origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true,
    });
    assert.equal(noDrivingCheck.body.ready, false);
    assert.match(noDrivingCheck.body.errors.join(' '), /第 2 階段：第二階段工作流必須使用 \{\{driving_video\}\}/u);
    await close(noDrivingApp.app);
    const singleWithStage2 = await start({ comfyUIWorkflowPath: stage2Path, comfyUIStage2WorkflowPath: '' });
    const singleWithStage2Check = await postJson(`${singleWithStage2.origin}/api/inference/workflow-check`, {
      videoModelId: 'wan-2.2-ti2v-5b', hasSourceImage: true,
    });
    assert.equal(singleWithStage2Check.body.ready, false);
    assert.match(singleWithStage2Check.body.errors.join(' '), /\{\{driving_video\}\}.*只能用於第二階段工作流/u);
    await close(singleWithStage2.app);

    // C. Duration / settings outside the pipeline range are rejected before any GPU check, upload or prompt.
    const before = { uploads: mock.uploads.length, prompts: mock.promptCount, preflight: gpu.preflightCalls };
    for (const [settings, pattern] of [
      [{ duration: 10 }, /10 秒 × 24 fps 的第一階段影片（3 段串接）為 241 影格，超出第二階段支援的 242–321 影格；24 fps 時片長須為 11 至 13 秒/u],
      [{ duration: 14 }, /337 影格.*24 fps 時片長須為 11 至 13 秒/u],
      [{ referenceStrength: 3 }, /參考強度必須是 0\.5 至 2/u],
      [{ referenceStrength: '1e0' }, /參考強度/u],
      [{ stage2Steps: 0 }, /第二階段步數/u],
    ]) {
      const refused = await submit(settings);
      assert.equal(refused.status, 400, JSON.stringify(settings));
      assert.match(refused.body.error, pattern);
    }
    const noImage = await submit({}, { sourceImageDataUrl: undefined });
    assert.equal(noImage.status, 400);
    assert.match(noImage.body.error, /兩階段流程需要來源照片/u);
    assert.deepEqual(
      { uploads: mock.uploads.length, prompts: mock.promptCount, preflight: gpu.preflightCalls },
      before,
    );
    // A hot or non-safe-mode GPU refuses the job before anything reaches ComfyUI.
    gpu.sample.tempC = 74;
    const hot = await submit();
    assert.equal(hot.status, 409);
    assert.match(hot.body.error, /GPU 預檢未通過，未提交工作：GPU 溫度 74°C 高於開始門檻 65°C/u);
    gpu.sample.tempC = 50;
    gpu.sample.powerLimitW = 300;
    const fullPower = await submit();
    assert.equal(fullPower.status, 409);
    assert.match(fullPower.body.error, /功耗上限為 300 W.*gpu-safe-mode\.ps1/u);
    gpu.sample.powerLimitW = 250;
    assert.equal(mock.uploads.length, before.uploads);
    assert.equal(mock.promptCount, before.prompts);
    assert.equal(gpu.guards.length, 0);

    // D. Happy path.
    const job = await created();
    assert.equal(job.status, 'queued');
    assert.equal(job.stageLabel, '第 1/2 階段');
    assert.equal(job.pipeline.currentStage, 1);
    assert.equal(job.pipeline.stages[0].comfyPromptId, job.comfyPromptId);
    assert.equal(job.pipeline.stages[0].status, 'queued');
    assert.equal(job.pipeline.stages[1].status, 'waiting');
    assert.equal(job.workflowVariables.total_frames, 289);
    // Only placeholders stage 2 uses are recorded (its fps follows the driving video).
    assert.deepEqual(job.pipeline.stages[1].workflowVariables, {
      width: 544, height: 960, seed: 7, source_image: job.workflowVariables.source_image, steps: 10, reference_strength: 1.3,
    });
    assert.equal(job.settings.referenceStrength, 1.3);
    assert.equal(mock.lastPrompt['8'].inputs.length, 97);
    assert.equal(gpu.activeGuards().length, 1, 'stage 1 runs under a GPU guard');
    assert.match(gpu.guards[0].label, /stage1$/u);
    // Only one pipeline job at a time.
    const second = await submit();
    assert.equal(second.status, 409);
    assert.match(second.body.error, /已有兩階段工作進行中/u);

    mock.queuePending = mock.queuePending.filter((entry) => entry[1] !== job.comfyPromptId);
    mock.queueRunning = [[1, job.comfyPromptId, {}, {}, []]];
    const running = await getJob(job.id);
    assert.equal(running.status, 'running');
    assert.equal(running.pipeline.stages[0].status, 'running');
    assert.ok(running.pipeline.stages[0].startedAt);
    const runningCancel = await cancel(job.id);
    assert.equal(runningCancel.status, 409);
    assert.match(runningCancel.body.error, /第 1\/2 階段已開始執行/u);

    const stage1Prompt = job.comfyPromptId;
    const promptsBeforeStage2 = mock.promptCount;
    const stage1Uploads = mock.uploads.length;
    const handedOver = await completeStage1(job);
    assert.equal(handedOver.status, 'queued', JSON.stringify(handedOver));
    assert.equal(handedOver.stageLabel, '第 2/2 階段');
    assert.equal(handedOver.pipeline.currentStage, 2);
    assert.equal(handedOver.pipeline.stages[0].status, 'succeeded');
    assert.equal(handedOver.pipeline.stages[0].executionSeconds, 2.3);
    assert.equal(handedOver.pipeline.stages[0].comfyPromptId, stage1Prompt);
    assert.equal(handedOver.pipeline.stages[0].gpuTelemetry.maxTempC, 71);
    assert.equal(mock.promptCount, promptsBeforeStage2 + 1);
    assert.notEqual(handedOver.comfyPromptId, stage1Prompt);
    assert.equal(handedOver.pipeline.stages[1].comfyPromptId, handedOver.comfyPromptId);
    // The stage-1 WebM was uploaded to input/vediofactory and stage 2 reads exactly that file.
    assert.equal(mock.uploads.length, stage1Uploads + 1);
    const drivingUpload = mock.uploads.at(-1);
    assert.match(drivingUpload.name, /^vediofactory-stage1-[a-f\d]{32}\.webm$/u);
    assert.deepEqual([drivingUpload.subfolder, drivingUpload.type, drivingUpload.overwrite], ['vediofactory', 'input', 'false']);
    assert.equal(handedOver.pipeline.stages[1].drivingVideo, `vediofactory/${drivingUpload.name}`);
    const stage2Prompt = mock.lastPrompt;
    assert.equal(stage2Prompt['14'].class_type, 'LoadVideo');
    assert.equal(stage2Prompt['14'].inputs.file, `vediofactory/${drivingUpload.name}`);
    assert.equal(stage2Prompt['13'].inputs.image, job.workflowVariables.source_image, 'stage 2 uses the same uploaded photo');
    for (const nodeId of ['100', '110', '120', '130']) {
      assert.equal(stage2Prompt[nodeId].inputs.reference_image_strength, 1.3);
      assert.equal(stage2Prompt[nodeId].inputs.width, 544);
      assert.equal(stage2Prompt[nodeId].inputs.height, 960);
    }
    assert.equal(stage2Prompt['8'].inputs.steps, 10);
    assert.equal(stage2Prompt['101'].inputs.noise_seed, 7);
    assert.match(stage2Prompt['12'].inputs.text, /^The woman from the photo dances\. A person dancing/u);
    assert.doesNotMatch(JSON.stringify(stage2Prompt), /\{\{/u);
    // The stage-1 draft is kept outside the library.
    const draftPath = path.join(outputDir, 'pipeline-drafts', `${job.id}-stage1.webm`);
    assert.equal(await fs.readFile(draftPath, 'utf8'), `stage1:${job.id}`);
    assert.equal(handedOver.pipeline.stages[0].draftFile, `pipeline-drafts/${job.id}-stage1.webm`);
    assert.deepEqual(await libraryItems(job.id), []);
    assert.ok(gpu.guards[0].stopped, 'stage-1 guard stopped');
    assert.equal(gpu.activeGuards().length, 1, 'stage 2 runs under its own guard');
    assert.match(gpu.activeGuards()[0].label, /stage2$/u);

    mock.viewRequests = [];
    finishPrompt(handedOver.comfyPromptId, 211, 'wan22-animate-dance_00001_.webm', 'final-video');
    const done = await getJob(job.id);
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.equal(done.pipeline.stages[1].status, 'succeeded');
    assert.equal(done.executionSeconds, 4.6, 'both stages');
    assert.deepEqual(mock.viewRequests, ['wan22-animate-dance_00001_.webm']);
    assert.equal(mock.history[handedOver.comfyPromptId].outputs['14'].images[0].type, 'input', 'realistic history shape');
    assert.equal(done.outputs.length, 1, JSON.stringify(done.outputs));
    const items = await libraryItems(job.id);
    assert.equal(items.length, 1, 'only the stage-2 SaveWEBM video is imported (not the LoadVideo input preview)');
    assert.equal(await fs.readFile(path.join(outputDir, items[0].fileName), 'utf8'), 'final-video');
    const metadata = JSON.parse(await fs.readFile(path.join(outputDir, `${items[0].fileName}.json`), 'utf8'));
    assert.equal(metadata.pipelineStages, 2);
    assert.equal(metadata.referenceStrength, 1.3);
    assert.equal(metadata.stage2Steps, 10);
    assert.equal(metadata.totalFrames, 289);
    assert.equal(metadata.stage2WorkflowName, 'wan22-animate-dance.api.json');
    assert.equal(gpu.activeGuards().length, 0);
    const manifest = JSON.parse(await fs.readFile(done.manifestPath, 'utf8'));
    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.pipeline.stages[1].gpuTelemetry.maxVramMiB, 13_700);
    assert.equal(gpu.interrupts.length, 0);

    // E. Stage-1 failure stops the pipeline: no driving-video upload, no stage-2 prompt.
    const failing = await created({ duration: 11, referenceStrength: '0.8', stage2Steps: 12 });
    assert.deepEqual(
      [failing.pipeline.stages[1].workflowVariables.reference_strength, failing.pipeline.stages[1].workflowVariables.steps],
      [0.8, 12],
    );
    const uploadsAtFailure = mock.uploads.length;
    const promptsAtFailure = mock.promptCount;
    failPrompt(failing.comfyPromptId, 'CUDA out of memory');
    const failed = await getJob(failing.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /^第 1\/2 階段失敗：ComfyUI 工作失敗（KSampler）：CUDA out of memory/u);
    assert.match(failed.guidance, /VRAM 不足/u);
    assert.equal(failed.pipeline.stages[0].status, 'failed');
    assert.equal(failed.pipeline.stages[1].status, 'waiting');
    assert.equal(mock.uploads.length, uploadsAtFailure);
    assert.equal(mock.promptCount, promptsAtFailure);
    assert.equal(gpu.activeGuards().length, 0);

    // F. Guard trip while stage 1 runs: ComfyUI is interrupted and the job fails with the reason.
    const tripped = await created();
    mock.queuePending = mock.queuePending.filter((entry) => entry[1] !== tripped.comfyPromptId);
    mock.queueRunning = [[1, tripped.comfyPromptId, {}, {}, []]];
    assert.equal((await getJob(tripped.id)).status, 'running');
    gpu.activeGuards()[0].onTrip('GPU temperature 86 C >= 85 C', { tempC: 86 });
    const trippedJob = await getJob(tripped.id);
    assert.equal(trippedJob.status, 'failed', JSON.stringify(trippedJob));
    assert.match(trippedJob.error, /^第 1\/2 階段失敗：GPU 防護觸發，已中斷 ComfyUI：GPU temperature 86 C >= 85 C/u);
    assert.match(trippedJob.guidance, /gpu-safe-mode\.ps1/u);
    assert.deepEqual(gpu.interrupts, [comfy.url]);
    assert.equal(gpu.activeGuards().length, 0);
    mock.queueRunning = [];
    // ComfyUI later reports the interrupted prompt; the guard reason stays.
    mock.history[tripped.comfyPromptId] = { status: { status_str: 'error', completed: false, messages: [] }, outputs: {} };
    assert.match((await getJob(tripped.id)).error, /GPU 防護觸發/u);

    // Trip while stage 2 is still pending in the ComfyUI queue: the pending prompt is removed as well.
    const trippedLater = await created();
    const trippedLaterStage2 = await completeStage1(trippedLater);
    assert.equal(trippedLaterStage2.status, 'queued');
    gpu.activeGuards()[0].onLost('Unable to determine the device handle for GPU0: GPU is lost');
    const lostJob = await getJob(trippedLater.id);
    assert.equal(lostJob.status, 'failed');
    assert.match(lostJob.error, /^第 2\/2 階段失敗：GPU 已斷線（GPU is lost）/u);
    assert.equal(mock.queuePending.some((entry) => entry[1] === trippedLaterStage2.comfyPromptId), false);
    assert.equal(gpu.interrupts.length, 2);

    // G. Cooling between stages: stage 2 waits for the card, then starts; the wait is recorded.
    const cooling = await created();
    gpu.sample.tempC = 78;
    const promptsAtCooling = mock.promptCount;
    const coolingJob = await completeStage1(cooling);
    assert.equal(coolingJob.status, 'cooling');
    assert.equal(coolingJob.stageLabel, '第 2/2 階段（等待 GPU 冷卻）');
    assert.equal(coolingJob.pipeline.stages[1].status, 'cooling');
    assert.match(coolingJob.pipeline.stages[1].gpuWait, /GPU 溫度 78°C 高於開始門檻 65°C/u);
    assert.ok(coolingJob.pipeline.stages[1].drivingVideo, 'driving video is uploaded before waiting');
    assert.equal(mock.promptCount, promptsAtCooling);
    assert.equal(gpu.activeGuards().length, 0, 'no guard while nothing runs');
    const uploadsWhileCooling = mock.uploads.length;
    assert.equal((await getJob(cooling.id)).status, 'cooling');
    gpu.sample.tempC = 60;
    const cooled = await getJob(cooling.id);
    assert.equal(cooled.status, 'queued');
    assert.equal(typeof cooled.pipeline.stages[1].coolingSeconds, 'number');
    assert.equal(mock.uploads.length, uploadsWhileCooling, 'the driving video is uploaded once');
    assert.equal(mock.promptCount, promptsAtCooling + 1);
    // Stage 2 still pending: cancel removes it from the ComfyUI queue.
    const cancelledStage2 = await cancel(cooling.id);
    assert.equal(cancelledStage2.status, 200, JSON.stringify(cancelledStage2.body));
    assert.equal(cancelledStage2.body.status, 'cancelled');
    assert.match(cancelledStage2.body.guidance, /第 2\/2 階段從 ComfyUI 待執行佇列移除/u);
    assert.equal(mock.queuePending.some((entry) => entry[1] === cooled.comfyPromptId), false);
    assert.equal(gpu.activeGuards().length, 0);

    // H. Cancellation in stage 1 (pending) and while cooling; a cancelled job never submits stage 2.
    const cancelStage1 = await created();
    const cancelledStage1 = await cancel(cancelStage1.id);
    assert.equal(cancelledStage1.status, 200);
    assert.equal(cancelledStage1.body.pipeline.stages[0].status, 'cancelled');
    assert.equal(mock.queuePending.some((entry) => entry[1] === cancelStage1.comfyPromptId), false);
    assert.equal(gpu.activeGuards().length, 0);
    const cancelCooling = await created();
    gpu.sample.tempC = 80;
    assert.equal((await completeStage1(cancelCooling)).status, 'cooling');
    const cancelledCooling = await cancel(cancelCooling.id);
    assert.equal(cancelledCooling.status, 200);
    assert.match(cancelledCooling.body.guidance, /第 2\/2 階段開始前取消/u);
    gpu.sample.tempC = 50;
    const promptsAfterCancel = mock.promptCount;
    assert.equal((await getJob(cancelCooling.id)).status, 'cancelled');
    assert.equal(mock.promptCount, promptsAfterCancel);
    assert.equal((await cancel(cancelCooling.id)).status, 409);

    // I. Cooling timeout and a hard GPU problem between stages fail the job with a clear reason.
    await close(app);
    ({ app, origin } = await start({ gpuCoolingTimeoutMs: 0 }));
    const timeout = await created(undefined, origin);
    gpu.sample.tempC = 82;
    const timedOut = await completeStage1(timeout);
    assert.equal(timedOut.status, 'failed');
    assert.match(timedOut.error, /^第 2\/2 階段失敗：等待 GPU 冷卻逾時.*GPU 溫度 82°C/u);
    assert.match(timedOut.guidance, /第一階段影片保留於 pipeline-drafts\//u);
    gpu.sample.tempC = 50;
    const hardJob = await created(undefined, origin);
    gpu.sample.powerLimitW = 300;
    const hardFailed = await completeStage1(hardJob);
    assert.equal(hardFailed.status, 'failed');
    assert.match(hardFailed.error, /GPU 預檢未通過：GPU 功耗上限為 300 W/u);
    gpu.sample.powerLimitW = 250;

    // J. Restart recovery mid-pipeline: stage 2 queued when the server stops; a new server resumes tracking with a
    //    fresh guard and imports the final video once.
    const restart = await created(undefined, origin);
    const restartStage2 = await completeStage1(restart);
    assert.equal(restartStage2.status, 'queued');
    await close(app);
    assert.equal(gpu.activeGuards().length, 0, 'closing the server stops its guards');
    ({ app, origin } = await start());
    const resumed = await getJob(restart.id);
    assert.equal(resumed.status, 'queued');
    assert.equal(resumed.pipeline.currentStage, 2);
    assert.equal(gpu.activeGuards().length, 1, 'the restarted server guards the resumed stage');
    assert.match(gpu.activeGuards()[0].label, /stage2$/u);
    finishPrompt(restartStage2.comfyPromptId, 211, 'restart_00001_.webm', 'restart-final');
    const resumedDone = await getJob(restart.id);
    assert.equal(resumedDone.status, 'succeeded');
    assert.equal((await libraryItems(restart.id)).length, 1);

    // Restart while cooling: the new server re-checks the GPU and submits stage 2 without re-uploading.
    const restartCooling = await created();
    gpu.sample.tempC = 79;
    assert.equal((await completeStage1(restartCooling)).status, 'cooling');
    await close(app);
    gpu.sample.tempC = 55;
    const uploadsBeforeResume = mock.uploads.length;
    // This server drives the job in the background (no polling), as it does for a browser that was closed.
    ({ app, origin } = await start({ pipelinePollIntervalMs: 20 }));
    const manifestPath = restartCooling.manifestPath;
    let background;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      background = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (background.status === 'queued') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(background.status, 'queued', 'background driver submits stage 2 after a restart');
    assert.equal(mock.uploads.length, uploadsBeforeResume);
    finishPrompt(background.comfyPromptId, 211, 'background_00001_.webm', 'background-final');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      background = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (background.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(background.status, 'succeeded', 'background driver imports the final video');
    assert.equal((await libraryItems(restartCooling.id)).length, 1);
    assert.equal(gpu.activeGuards().length, 0);

    // K. Single-workflow mode is unchanged: no pipeline fields, no GPU preflight/guard.
    const single = await start({ comfyUIStage2WorkflowPath: '' });
    const singleRuntime = await fetch(`${single.origin}/api/inference/runtime`).then((r) => r.json());
    assert.equal(singleRuntime.comfyUI.pipeline, undefined);
    assert.equal(singleRuntime.comfyUI.workflowSegments.maxDurationSecondsByFps[24], 15);
    const preflightsBeforeSingle = gpu.preflightCalls;
    const guardsBeforeSingle = gpu.guards.length;
    const singleJob = await created({ duration: 10 }, single.origin);
    assert.equal(singleJob.pipeline, undefined);
    assert.equal(singleJob.stageLabel, undefined);
    assert.equal(singleJob.settings.referenceStrength, undefined);
    assert.equal(singleJob.workflowVariables.total_frames, 241);
    assert.equal(gpu.preflightCalls, preflightsBeforeSingle);
    assert.equal(gpu.guards.length, guardsBeforeSingle);
    // Single-workflow import also ignores input previews (e.g. a LoadVideo node in a video-to-video workflow).
    dequeue(singleJob.comfyPromptId);
    mock.viewRequests = [];
    mock.viewBodies['single-input.webm'] = 'INPUT-PREVIEW';
    mock.viewBodies['single_00001_.webm'] = 'single-output';
    mock.history[singleJob.comfyPromptId] = successHistory(singleJob.comfyPromptId, {
      3: { images: [{ filename: 'single-input.webm', subfolder: 'vediofactory', type: 'input' }], animated: [true] },
      11: { images: [{ filename: 'single_00001_.webm', subfolder: 'vediofactory', type: 'output' }], animated: [true] },
    });
    const singleDone = await getJob(singleJob.id, single.origin);
    assert.equal(singleDone.status, 'succeeded');
    assert.equal(singleDone.outputs.length, 1, JSON.stringify(singleDone.outputs));
    assert.deepEqual(mock.viewRequests, ['single_00001_.webm']);
    const singleItems = await libraryItems(singleJob.id, single.origin);
    assert.equal(singleItems.length, 1);
    assert.equal(await fs.readFile(path.join(outputDir, singleItems[0].fileName), 'utf8'), 'single-output');

    // L. A guard that cannot start refuses the job; a guard that stops producing samples counts as a lost GPU.
    const realStart = gpu.startGpuGuard;
    gpu.startGpuGuard = () => {
      throw new Error('spawn nvidia-smi ENOENT');
    };
    const promptsBeforeNoGuard = mock.promptCount;
    const noGuard = await submit();
    assert.equal(noGuard.status, 503);
    assert.match(noGuard.body.error, /無法啟動 GPU 防護：spawn nvidia-smi ENOENT；未提交工作/u);
    assert.equal(mock.promptCount, promptsBeforeNoGuard);
    gpu.startGpuGuard = realStart;
    await close(app);
    ({ app, origin } = await start({ pipelinePollIntervalMs: 20, gpuGuardStaleMs: 60 }));
    const interruptsBeforeStale = gpu.interrupts.length;
    const stale = await created(undefined, origin);
    let staleManifest;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      staleManifest = JSON.parse(await fs.readFile(stale.manifestPath, 'utf8'));
      if (staleManifest.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(staleManifest.status, 'failed');
    assert.match(staleManifest.error, /沒有收到 nvidia-smi 資料/u);
    assert.equal(gpu.interrupts.length, interruptsBeforeStale + 1);
    assert.equal(gpu.activeGuards().length, 0);

    assert.deepEqual(await listTempFiles(outputDir), []);
    console.log(JSON.stringify({ ok: true, test: 'comfy-wan-workflow:two-stage-pipeline' }));
  } finally {
    for (const started of apps) await close(started);
    await new Promise((resolve) => comfy.server.close(resolve));
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

main()
  .then(() => (process.exitCode ? undefined : testFailureRaceAndCleanup()))
  .then(() => (process.exitCode ? undefined : testWindowsStylePaths()))
  .then(() => (process.exitCode ? undefined : testSecurityReviewFixes()))
  .then(() => (process.exitCode ? undefined : testLoraSupport()))
  .then(() => (process.exitCode ? undefined : testDanceChainWorkflow()))
  .then(() => (process.exitCode ? undefined : testTwoStagePipeline()))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
