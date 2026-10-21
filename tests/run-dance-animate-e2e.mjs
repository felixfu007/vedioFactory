// Stage-2 spike (OPTIMIZATION_PLAN 6.7): re-render the stage-1 dance video with the identity of the source photo via
// workflows/wan22-animate-dance.api.json (Wan Animate 2, ComfyUI core nodes only). Talks to ComfyUI directly (not via
// server.js, which has no {{driving_video}} support yet). GPU safety: checkGpuPreflight() must pass and
// tools/gpu-guard.mjs watches the card for the whole job, interrupting ComfyUI on a trip.
//
//   node tests/run-dance-animate-e2e.mjs [--width 480 --height 848 --steps 10 --seed 20261018]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkGpuPreflight, interruptComfyUI, startGpuGuard } from '../tools/gpu-guard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    'comfy-url': { type: 'string', default: process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188' },
    'comfy-dir': { type: 'string', default: 'C:/Users/User/ComfyUI' },
    workflow: { type: 'string', default: path.join(repoRoot, 'workflows', 'wan22-animate-dance.api.json') },
    video: { type: 'string', default: path.join(repoRoot, 'tests', 'fixtures', 'output', 'dance-e2e.webm') },
    source: { type: 'string', default: path.join(repoRoot, 'tests', 'fixtures', 'dance-source.png') },
    out: { type: 'string', default: path.join(repoRoot, 'tests', 'fixtures', 'output', 'dance-animate-e2e.webm') },
    width: { type: 'string', default: '480' },
    height: { type: 'string', default: '848' },
    steps: { type: 'string', default: '10' },
    seed: { type: 'string', default: '20261018' },
    'reference-strength': { type: 'string', default: '1.0' },
    prompt: { type: 'string', default: '' },
  },
});
const comfy = args['comfy-url'].replace(/\/+$/u, '');
const log = (message) => console.log(`[animate-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);

async function upload(file, name) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(file)]), name);
  form.append('subfolder', 'vediofactory');
  form.append('overwrite', 'true');
  const response = await fetch(`${comfy}/upload/image`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`upload ${name}: HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
}

// Hard gate: nothing is uploaded or submitted unless the preflight passes (power limit <= 250 W, <= 65 C, GPU idle).
// There is deliberately no --allow-full-power option. A throw here also exits before any ComfyUI call.
const preflight = await checkGpuPreflight();
if (!preflight?.ok) {
  console.error(`GPU preflight failed:\n  - ${preflight.problems.join('\n  - ')}`);
  process.exit(2);
}
log(`preflight ok: ${preflight.sample.tempC} C, limit ${preflight.sample.powerLimitW} W, VRAM ${preflight.sample.vramMiB} MiB`);

const drivingVideo = await upload(args.video, 'animate-driving.webm');
const sourceImage = await upload(args.source, 'animate-source.png');
const vars = {
  width: Number(args.width), height: Number(args.height), steps: Number(args.steps), seed: Number(args.seed),
  reference_strength: Number(args['reference-strength']),
  driving_video: drivingVideo, source_image: sourceImage, prompt: args.prompt, negative_prompt: '',
};
let text = fs.readFileSync(args.workflow, 'utf8');
for (const [key, value] of Object.entries(vars)) {
  text = typeof value === 'number'
    ? text.replaceAll(`"{{${key}}}"`, String(value))
    : text.replaceAll(`{{${key}}}`, JSON.stringify(value).slice(1, -1));
}
const leftover = text.match(/\{\{\w+\}\}/u);
if (leftover) throw new Error(`unfilled placeholder ${leftover[0]}`);
const prompt = JSON.parse(text);

let abortReason = null;
let promptId = null;
const guard = startGpuGuard({
  label: 'dance-animate',
  onTrip: (reason) => {
    abortReason = `GPU guard tripped: ${reason}`;
    log(`${abortReason}; interrupting ComfyUI`);
    interruptComfyUI(comfy).catch((error) => log(`interrupt failed: ${error.message}`));
  },
  onLost: (lost) => { abortReason = `GPU lost: ${lost}`; log(abortReason); },
});
const started = Date.now();
let exitCode = 0;
let outputFile = null;
let status = null;
try {
  const response = await fetch(`${comfy}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: 'vediofactory-animate-e2e' }),
  });
  const body = await response.json();
  if (!response.ok || !body.prompt_id) throw new Error(`prompt rejected: ${JSON.stringify(body).slice(0, 2000)}`);
  promptId = body.prompt_id;
  log(`queued ${promptId} (${vars.width}x${vars.height}, ${vars.steps} steps)`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const history = await (await fetch(`${comfy}/history/${promptId}`)).json();
    const entry = history[promptId];
    if (entry?.status?.completed || entry?.status?.status_str === 'error') {
      status = entry.status;
      const saved = entry.outputs?.['211']?.images?.[0];
      if (saved) outputFile = path.join(args['comfy-dir'], 'output', saved.subfolder || '', saved.filename);
      break;
    }
    const g = guard.summary();
    if ((Date.now() - started) % 60_000 < 5_000) log(`running… max ${g.maxTempC} C, ${g.maxPowerW} W, VRAM ${g.maxVramMiB} MiB`);
  }
} catch (error) {
  log(`error: ${error.message}`);
  exitCode = 1;
}
const telemetry = await guard.stop();
const wallSeconds = Math.round((Date.now() - started) / 1000);
if (outputFile && fs.existsSync(outputFile)) {
  fs.copyFileSync(outputFile, args.out);
  log(`saved ${args.out}`);
} else if (!exitCode) {
  log(`no output (${JSON.stringify(status?.messages?.filter(([kind]) => kind === 'execution_error') ?? status).slice(0, 3000)})`);
  exitCode = 1;
}
const report = { promptId, workflow: path.basename(args.workflow), vars, wallSeconds, abortReason, comfyOutput: outputFile, gpuTelemetry: telemetry };
fs.writeFileSync(args.out.replace(/\.webm$/u, '.json'), `${JSON.stringify(report, null, 2)}\n`);
log(`wall ${wallSeconds} s; max ${telemetry.maxTempC} C, ${telemetry.maxPowerW} W, VRAM ${telemetry.maxVramMiB} MiB, tripped=${JSON.stringify(telemetry.tripped)}`);
process.exit(abortReason ? 3 : exitCode);
