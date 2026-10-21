// Full two-stage dance run (OPTIMIZATION_PLAN 6.9/6.10): photo -> stage 1 TI2V-5B dance -> stage 2 Wan Animate with the
// photo's identity -> one >=10 s WebM, all through the vedioFactory API and a REAL local ComfyUI + GPU. Not part of
// `npm test`.
//
//   npm run e2e:dance:full                         # starts vedioFactory in-process in pipeline mode
//   npm run e2e:dance:full -- --duration 13        # 11..13 s at 24 fps (stage-1 frames must fit stage 2: 242..321)
//   npm run e2e:dance:full -- --server http://127.0.0.1:8000   # reuse a server started with BOTH workflow env vars
//
// GPU safety lives in the server: it refuses the job (exit 2) when the GPU is hot, busy or not in safe mode
// (tools/gpu-safe-mode.ps1), runs tools/gpu-guard.mjs while each stage is queued/running (telemetry in logs/gpu/,
// ComfyUI interrupted on overheat / HW slowdown / GPU lost), and waits for the card to cool down between the stages.
// This script refuses to run with VEDIO_FACTORY_GPU_GUARD=off. On Ctrl+C or timeout it removes our pending prompt or
// interrupts ComfyUI if our stage is executing, so nothing keeps running unguarded after the server stops.
// On success: tests/fixtures/output/dance-full-e2e.webm + .json (job manifest summary, per-stage timing/telemetry,
// ffprobe). Then run `npm run test:dance:full`.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startOnFetchSafePort } from './safe-port.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { interruptComfyUI } = await import('../tools/gpu-guard.mjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    server: { type: 'string' },
    'comfy-url': { type: 'string', default: process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188' },
    workflow: { type: 'string', default: path.join(repoRoot, 'workflows', 'wan22-ti2v-5b-dance-10s.api.json') },
    'stage2-workflow': { type: 'string', default: path.join(repoRoot, 'workflows', 'wan22-animate-dance.api.json') },
    source: { type: 'string', default: path.join(repoRoot, 'tests', 'fixtures', 'dance-source.png') },
    'output-dir': { type: 'string', default: path.join(repoRoot, 'visual-output', 'dance-full-e2e-library') },
    out: { type: 'string', default: path.join(repoRoot, 'tests', 'fixtures', 'output', 'dance-full-e2e.webm') },
    duration: { type: 'string', default: '12' },
    fps: { type: 'string', default: '24' },
    resolution: { type: 'string', default: '544x960' },
    seed: { type: 'string', default: '20261017' },
    // The stage-1 workflow appends its built-in dance prompt after {{prompt}}; this only names the subject.
    prompt: { type: 'string', default: 'The young woman from the photo dances happily.' },
    'reference-strength': { type: 'string', default: '1.3' },
    'stage2-steps': { type: 'string', default: '10' },
    // Stage 1 ~7.5 min + cooling + stage 2 ~30 min at 544x960 on the RTX 5070 Ti; generous on purpose.
    'timeout-min': { type: 'string', default: '150' },
  },
});

const MODEL_ID = 'wan-2.2-ti2v-5b';
const POLL_MS = 10_000;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

function fail(message, code = 1) {
  console.error(`[dance-full-e2e] ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[dance-full-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function ffprobe(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=nb_read_frames,width,height,r_frame_rate',
      '-of', 'json', file,
    ], { timeout: 120_000, windowsHide: true });
    const probe = JSON.parse(stdout);
    const stream = probe.streams?.[0] || {};
    return {
      durationSeconds: Number(probe.format?.duration),
      frames: Number(stream.nb_read_frames),
      width: stream.width,
      height: stream.height,
      frameRate: stream.r_frame_rate,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'ffprobe not found in PATH; duration not checked', missing: true };
    const detail = String(error.stderr || error.message).trim().split(/\r?\n/u).pop();
    return { error: `ffprobe could not read the video: ${detail}` };
  }
}

async function api(origin, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    const error = new Error(`${options.method || 'GET'} ${pathname} -> HTTP ${response.status}: ${body?.error || text}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function describeStage(job) {
  const stage = job.pipeline?.stages?.[job.pipeline.currentStage - 1];
  if (!stage) return job.status;
  const extra = stage.status === 'cooling' ? ` (${stage.gpuWait})` : '';
  return `${job.stageLabel || ''} ${stage.status}${extra}`.trim();
}

async function main() {
  const duration = Number(args.duration);
  const fps = Number(args.fps);
  const timeoutMs = Number(args['timeout-min']) * 60_000;
  if (/^(?:0|off|false|no|disabled)$/iu.test(String(process.env.VEDIO_FACTORY_GPU_GUARD || '').trim())) {
    fail('VEDIO_FACTORY_GPU_GUARD is off; the full GPU run must use the server-side GPU guard.', 2);
  }
  const comfyUrl = args['comfy-url'].replace(/\/+$/u, '');
  try {
    const response = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    log(`ComfyUI ${stats.system?.comfyui_version || ''} reachable at ${comfyUrl}`);
  } catch (error) {
    fail(`ComfyUI /system_stats unreachable at ${comfyUrl}: ${error.message}`, 2);
  }

  let app = null;
  let origin = args.server?.replace(/\/+$/u, '');
  if (!origin) {
    const { startServer } = require(path.join(repoRoot, 'server.js'));
    app = await startOnFetchSafePort(startServer, {
      port: 0,
      host: '127.0.0.1',
      outputDir: path.resolve(args['output-dir']),
      comfyUIUrl: comfyUrl,
      comfyUIWorkflowPath: path.resolve(args.workflow),
      comfyUIStage2WorkflowPath: path.resolve(args['stage2-workflow']),
    });
    origin = `http://127.0.0.1:${app.server.address().port}`;
    log(`started vedioFactory at ${origin} (library ${app.getOutputDir()})`);
  } else {
    log(`using vedioFactory at ${origin}`);
  }

  let job = null;
  let stopping = false;
  // Leaves nothing running unguarded: our pending prompt is removed, our executing prompt is interrupted.
  const abortJob = async (reason) => {
    if (!job || TERMINAL.includes(job.status)) return;
    log(`aborting job ${job.id}: ${reason}`);
    try {
      job = await api(origin, `/api/inference/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', timeoutMs: 60_000 });
      log(`cancelled (${describeStage(job)})`);
    } catch (error) {
      if (job.status === 'running') {
        await interruptComfyUI(comfyUrl).then(
          () => log('ComfyUI interrupted (our stage was executing)'),
          (interruptError) => log(`warning: ComfyUI interrupt failed: ${interruptError.message}`),
        );
      } else {
        log(`cancel failed: ${error.message}`);
      }
    }
  };
  process.on('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    abortJob('Ctrl+C').finally(async () => {
      if (app) await new Promise((resolve) => app.server.close(resolve));
      process.exit(130);
    });
  });

  try {
    const runtime = await api(origin, `/api/inference/runtime?videoModelId=${MODEL_ID}`);
    const pipeline = runtime.comfyUI?.pipeline;
    if (!pipeline?.enabled) {
      throw new Error(`server is not in pipeline mode (set VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW): ${JSON.stringify(pipeline)}`);
    }
    if (!pipeline.gpuGuard?.enabled) throw new Error('server GPU guard is disabled (VEDIO_FACTORY_GPU_GUARD); refusing to run on the GPU.');
    const range = pipeline.allowedDurationSecondsByFps?.[fps];
    log(`pipeline ${pipeline.stage1Workflow} -> ${pipeline.stage2Workflow}; driving ${pipeline.drivingFrames.min}-${pipeline.drivingFrames.max} `
      + `frames; ${fps} fps allows ${range ? `${range.min}-${range.max} s` : 'nothing'}; GPU start <= ${pipeline.gpuGuard.maxStartTempC} C, `
      + `power limit <= ${pipeline.gpuGuard.maxPowerLimitW} W, cooling wait <= ${pipeline.gpuGuard.coolingTimeoutMinutes} min`);
    if (!range?.seconds.includes(duration)) {
      fail(`--duration ${duration} is outside the pipeline range at ${fps} fps (${range ? `${range.min}-${range.max} s` : 'none'}).`, 2);
    }
    const settings = {
      duration, fps, resolution: args.resolution, quality: 'balanced', seed: args.seed,
      referenceStrength: args['reference-strength'], stage2Steps: args['stage2-steps'],
    };
    const check = await api(origin, '/api/inference/workflow-check', {
      method: 'POST',
      body: JSON.stringify({ videoModelId: MODEL_ID, hasSourceImage: true, settings }),
    });
    if (!check.ready) throw new Error(`workflow preflight failed: ${check.errors.join(' ')}`);

    const image = await fs.readFile(path.resolve(args.source));
    try {
      // The server runs the GPU preflight (about 5 s) before submitting stage 1.
      job = await api(origin, '/api/inference/jobs', {
        method: 'POST',
        timeoutMs: 300_000,
        body: JSON.stringify({
          prompt: args.prompt,
          moduleId: 'dance-full-e2e',
          videoModelId: MODEL_ID,
          sourceImageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
          settings,
        }),
      });
    } catch (error) {
      if (error.status === 409) fail(error.message, 2);
      throw error;
    }
    const stage1Vars = job.workflowVariables || {};
    const stage2Vars = job.pipeline.stages[1].workflowVariables || {};
    log(`job ${job.id} ${describeStage(job)}: stage 1 ${stage1Vars.segments} x ${stage1Vars.frames} = ${stage1Vars.total_frames} frames, `
      + `${stage1Vars.width}x${stage1Vars.height}, ${stage1Vars.steps} steps, seed ${stage1Vars.seed}; stage 2 ${stage2Vars.steps} steps, `
      + `reference strength ${stage2Vars.reference_strength}`);

    const startedAt = Date.now();
    let lastLine = '';
    while (!TERMINAL.includes(job.status)) {
      if (Date.now() - startedAt > timeoutMs) {
        await abortJob(`timed out after ${args['timeout-min']} min`);
        throw new Error(`timed out after ${args['timeout-min']} min (job ${job.id} ${describeStage(job)}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      job = await api(origin, `/api/inference/jobs/${encodeURIComponent(job.id)}`, { timeoutMs: 300_000 });
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const line = describeStage(job);
      if (line !== lastLine || elapsed % 60 < POLL_MS / 1000) {
        log(`${String(elapsed).padStart(5)} s  ${line}`);
        lastLine = line;
      }
    }
    const stageSummary = job.pipeline.stages.map((stage) => ({
      index: stage.index,
      status: stage.status,
      workflowName: stage.workflowName,
      executionSeconds: stage.executionSeconds,
      coolingSeconds: stage.coolingSeconds,
      gpuGuardLog: stage.gpuGuard?.logFile,
      gpuTelemetry: stage.gpuTelemetry,
      error: stage.error,
    }));
    for (const stage of stageSummary) {
      const t = stage.gpuTelemetry || {};
      log(`stage ${stage.index} ${stage.status}: ComfyUI ${stage.executionSeconds ?? '?'} s`
        + `${stage.coolingSeconds !== undefined ? `, waited ${stage.coolingSeconds} s for cooling` : ''}; `
        + `peak ${t.maxTempC ?? '?'} C / ${t.maxPowerW ?? '?'} W / VRAM ${t.maxVramMiB ?? '?'} MiB; HW slowdown ${t.hwSlowdownSamples ?? '?'} s`
        + `${stage.gpuGuardLog ? ` (logs/gpu/${stage.gpuGuardLog})` : ''}`);
    }
    if (job.status !== 'succeeded') throw new Error(`job ${job.status}: ${job.error || ''} ${job.guidance || ''}`.trim());
    // Exactly one imported WebM is expected; more means the server also imported something else (e.g. ComfyUI's
    // LoadVideo preview of the INPUT driving video) and outputs[0] could be the wrong file.
    if ((job.outputs?.length ?? 0) > 1) {
      throw new Error(`job imported ${job.outputs.length} videos, expected exactly 1: ${job.outputs.map((item) => item.fileName).join(', ')}`);
    }
    const output = job.outputs?.[0];
    if (!output) throw new Error(`job succeeded but produced no WebM: ${job.guidance || ''}`);

    const outFile = path.resolve(args.out);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const download = await fetch(`${origin}${output.previewUrl}`, { signal: AbortSignal.timeout(300_000) });
    if (!download.ok) throw new Error(`downloading ${output.fileName} failed: HTTP ${download.status}`);
    await fs.writeFile(outFile, Buffer.from(await download.arrayBuffer()));
    const probe = await ffprobe(outFile);
    const summary = {
      jobId: job.id,
      libraryFile: output.fileName,
      stage1Draft: job.pipeline.stages[0].draftFile,
      output: outFile,
      settings: job.settings,
      workflowVariables: job.workflowVariables,
      stage2WorkflowVariables: job.pipeline.stages[1].workflowVariables,
      executionSeconds: job.executionSeconds,
      wallSeconds: Math.round((Date.now() - startedAt) / 1000),
      stages: stageSummary,
      ffprobe: probe,
    };
    await fs.writeFile(outFile.replace(/\.webm$/iu, '.json'), `${JSON.stringify(summary, null, 2)}\n`);
    log(`saved ${outFile}`);
    log(probe.error || `ffprobe: ${probe.durationSeconds.toFixed(2)} s, ${probe.frames} frames, ${probe.width}x${probe.height} @ ${probe.frameRate}`);
    if (probe.error && !probe.missing) throw new Error(probe.error);
    if (!probe.error && probe.durationSeconds < 10) throw new Error(`video is only ${probe.durationSeconds.toFixed(2)} s (< 10 s target).`);
    log('next: npm run test:dance:full');
  } finally {
    if (app && !stopping) await new Promise((resolve) => app.server.close(resolve));
  }
}

main().catch((error) => fail(error.message));
