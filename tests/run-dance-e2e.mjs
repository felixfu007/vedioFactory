// End-to-end dance run (OPTIMIZATION_PLAN 6.5): photo -> >=10 s dancing WebM through the vedioFactory API and a REAL
// local ComfyUI + GPU. Not part of `npm test`.
//
//   npm run e2e:dance                      # starts vedioFactory in-process with the dance workflow
//   npm run e2e:dance -- --duration 10     # 10..12 s; 12 s (3 x 97 - 2 = 289 frames) is the default
//   npm run e2e:dance -- --server http://127.0.0.1:8000   # reuse a running server (must use the dance workflow)
//
// Refuses to start (exit 2) when nvidia-smi fails, ComfyUI /system_stats is unreachable, or the GPU is not in safe
// mode (power limit > 250 W: run tools/gpu-safe-mode.ps1 as Administrator after each reboot), is still hot, or is busy
// with another job. While the job runs, tools/gpu-guard.mjs logs GPU telemetry to logs/gpu/*.csv every second and
// interrupts ComfyUI if the card overheats or keeps hitting hardware slowdown. On success it copies the imported WebM
// to tests/fixtures/output/dance-e2e.webm, writes dance-e2e.json next to it and prints the ffprobe duration and the
// GPU telemetry summary. Then run `npm run test:dance`.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startOnFetchSafePort } from './safe-port.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { checkGpuPreflight, interruptComfyUI, startGpuGuard } = await import('../tools/gpu-guard.mjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    server: { type: 'string' },
    'comfy-url': { type: 'string', default: process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188' },
    workflow: { type: 'string', default: path.join(repoRoot, 'workflows', 'wan22-ti2v-5b-dance-10s.api.json') },
    source: { type: 'string', default: path.join(repoRoot, 'tests', 'fixtures', 'dance-source.png') },
    'output-dir': { type: 'string', default: path.join(repoRoot, 'visual-output', 'dance-e2e-library') },
    out: { type: 'string', default: path.join(repoRoot, 'tests', 'fixtures', 'output', 'dance-e2e.webm') },
    duration: { type: 'string', default: '12' },
    fps: { type: 'string', default: '24' },
    resolution: { type: 'string', default: '544x960' },
    seed: { type: 'string', default: '20261017' },
    // The workflow appends its built-in dance prompt (node 5) after {{prompt}}; this only names the subject.
    prompt: { type: 'string', default: 'The young woman from the photo dances happily.' },
    'timeout-min': { type: 'string', default: '90' },
    // Skips the 250 W power-limit precondition. The card crashed twice at full power; only for diagnosis.
    'allow-full-power': { type: 'boolean', default: false },
  },
});

const MODEL_ID = 'wan-2.2-ti2v-5b';
const EXPECTED_STEPS = 20; // quality "balanced"
const POLL_MS = 5_000;

function fail(message, code = 1) {
  console.error(`[dance-e2e] ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[dance-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function queryGpuName() {
  const { stdout } = await execFileAsync(
    'nvidia-smi',
    ['--query-gpu=name', '--format=csv,noheader'],
    { timeout: 10_000, windowsHide: true },
  );
  return stdout.trim().split(/\r?\n/u)[0] || 'unknown GPU';
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
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname} -> HTTP ${response.status}: ${body?.error || text}`);
  return body;
}

async function main() {
  const duration = Number(args.duration);
  const fps = Number(args.fps);
  const timeoutMs = Number(args['timeout-min']) * 60_000;
  if (!Number.isInteger(duration) || duration < 10 || duration > 15) fail('--duration must be an integer 10..15 (target >= 10 s).');
  if (duration > 12) log(`warning: ${duration} s exceeds the 10-12 s plan; per-segment frames grow accordingly.`);

  // --- Preconditions: a healthy, cool, idle GPU in safe mode and a reachable ComfyUI. ---
  const preflight = await checkGpuPreflight({ allowFullPower: args['allow-full-power'] });
  if (!preflight.ok) fail(`GPU preflight failed:\n  - ${preflight.problems.join('\n  - ')}`, 2);
  const gpuName = await queryGpuName();
  const start = preflight.sample;
  log(`GPU ${gpuName}: ${start.tempC} C, power limit ${start.powerLimitW} W, ${start.vramMiB} MiB used before start`);
  if (args['allow-full-power']) log('warning: --allow-full-power; the card crashed twice at full power.');
  const comfyUrl = args['comfy-url'].replace(/\/+$/u, '');
  try {
    const response = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    log(`ComfyUI ${stats.system?.comfyui_version || ''} reachable at ${comfyUrl}`);
  } catch (error) {
    fail(`ComfyUI /system_stats unreachable at ${comfyUrl}: ${error.message}`, 2);
  }

  // --- vedioFactory server: reuse --server, or start one in-process with the dance workflow. ---
  let app = null;
  let origin = args.server?.replace(/\/+$/u, '');
  if (!origin) {
    process.env.VEDIO_FACTORY_COMFYUI_WORKFLOW = path.resolve(args.workflow);
    const { startServer } = require(path.join(repoRoot, 'server.js'));
    app = await startOnFetchSafePort(startServer, {
      port: 0,
      host: '127.0.0.1',
      outputDir: path.resolve(args['output-dir']),
      comfyUIUrl: comfyUrl,
      comfyUIWorkflowPath: path.resolve(args.workflow),
    });
    origin = `http://127.0.0.1:${app.server.address().port}`;
    log(`started vedioFactory at ${origin} (library ${app.getOutputDir()})`);
  } else {
    log(`using vedioFactory at ${origin}`);
  }

  // GPU guard runs for the whole job: 1 s telemetry to logs/gpu/, interrupt ComfyUI on overheat / HW slowdown.
  let last = start;
  let abortReason = null;
  const guard = startGpuGuard({
    label: 'dance-e2e',
    onSample: (sample) => { last = sample; },
    onTrip: (reason) => {
      abortReason = `GPU guard tripped: ${reason}`;
      log(`${abortReason}; interrupting ComfyUI`);
      interruptComfyUI(comfyUrl).catch((error) => log(`warning: ComfyUI interrupt failed: ${error.message}`));
    },
    onLost: (text) => {
      abortReason = `GPU lost: ${text}`;
      log(abortReason);
    },
  });
  log(`GPU telemetry -> ${guard.logFile}`);

  try {
    const runtime = await api(origin, `/api/inference/runtime?videoModelId=${MODEL_ID}`);
    const segments = runtime.comfyUI?.workflowSegments;
    if (!segments?.chained) {
      throw new Error(`server workflow is not the chained dance workflow (workflowSegments=${JSON.stringify(segments)}).`);
    }
    log(`workflow: ${segments.segments} segments, overlap ${segments.overlapFrames}, max ${segments.maxDurationSecondsByFps?.[fps]} s @ ${fps} fps`);
    const check = await api(origin, '/api/inference/workflow-check', {
      method: 'POST',
      body: JSON.stringify({ videoModelId: MODEL_ID, hasSourceImage: true }),
    });
    if (!check.ready) throw new Error(`workflow preflight failed: ${check.errors.join(' ')}`);

    const image = await fs.readFile(path.resolve(args.source));
    const created = await api(origin, '/api/inference/jobs', {
      method: 'POST',
      timeoutMs: 300_000,
      body: JSON.stringify({
        prompt: args.prompt,
        moduleId: 'dance-e2e',
        videoModelId: MODEL_ID,
        sourceImageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
        settings: { duration, fps, resolution: args.resolution, quality: 'balanced', seed: args.seed },
      }),
    });
    const variables = created.workflowVariables || {};
    log(`job ${created.id} ${created.status}: ${variables.segments} x ${variables.frames} frames = ${variables.total_frames} total, `
      + `${variables.width}x${variables.height}, steps ${variables.steps}, seed ${variables.seed}`);
    if (variables.steps !== EXPECTED_STEPS) throw new Error(`expected ${EXPECTED_STEPS} steps, server used ${variables.steps}`);

    const startedAt = Date.now();
    let job = created;
    let lastStatus = '';
    while (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      if (abortReason) throw new Error(`${abortReason} (telemetry: ${guard.logFile})`);
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out after ${args['timeout-min']} min (job ${job.id} still ${job.status}).`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      job = await api(origin, `/api/inference/jobs/${encodeURIComponent(created.id)}`, { timeoutMs: 300_000 });
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (job.status !== lastStatus || elapsed % 30 < POLL_MS / 1000) {
        const peak = guard.summary();
        log(`${job.status.padEnd(9)} ${String(elapsed).padStart(5)} s  ${last.tempC} C  ${last.powerW} W  ${last.clockGrMHz} MHz  `
          + `VRAM ${last.vramMiB} MiB (peak ${peak.maxTempC} C / ${peak.maxPowerW} W / ${peak.maxVramMiB} MiB)`);
        lastStatus = job.status;
      }
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
      output: outFile,
      settings: job.settings,
      workflowName: job.workflowName,
      workflowSha256: job.workflowSha256,
      workflowVariables: job.workflowVariables,
      executionSeconds: job.executionSeconds,
      wallSeconds: Math.round((Date.now() - startedAt) / 1000),
      gpu: gpuName,
      vramBaselineMiB: start.vramMiB,
      gpuTelemetry: guard.summary(),
      ffprobe: probe,
    };
    await fs.writeFile(outFile.replace(/\.webm$/iu, '.json'), `${JSON.stringify(summary, null, 2)}\n`);
    log(`saved ${outFile}`);
    log(probe.error || `ffprobe: ${probe.durationSeconds.toFixed(2)} s, ${probe.frames} frames, ${probe.width}x${probe.height} @ ${probe.frameRate}`);
    const telemetry = guard.summary();
    log(`ComfyUI execution ${job.executionSeconds ?? '?'} s; peak ${telemetry.maxTempC} C, ${telemetry.maxPowerW} W `
      + `(instant ${telemetry.maxPowerInstantW ?? '-'} W), VRAM ${telemetry.maxVramMiB} MiB (baseline ${start.vramMiB} MiB, whole card); `
      + `HW slowdown ${telemetry.hwSlowdownSamples} s`);
    if (probe.error && !probe.missing) throw new Error(probe.error);
    if (!probe.error && probe.durationSeconds < 10) {
      throw new Error(`video is only ${probe.durationSeconds.toFixed(2)} s (< 10 s target).`);
    }
    log('next: npm run test:dance');
  } finally {
    const telemetry = await guard.stop();
    log(`GPU telemetry saved: ${telemetry.logFile}`);
    if (app) await new Promise((resolve) => app.server.close(resolve));
  }
}

main().catch((error) => fail(error.message));
