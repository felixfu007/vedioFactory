// Section 7.1 spike: run ONE step of the general "photo + any prompt" pipeline directly against ComfyUI (not via
// server.js, which has no 3-step support yet). Same GPU safety pattern as tests/run-dance-animate-e2e.mjs:
// checkGpuPreflight() must pass, tools/gpu-guard.mjs watches the card and interrupts ComfyUI on a trip.
//
//   node tests/run-general-step.mjs --workflow workflows/general-edit-qwen2511.api.json \
//     --upload source_image=tests/fixtures/dance-source.png --set prompt="riding a horse" --set seed=1 \
//     --out tests/fixtures/output/general-horse-edit.png
//
// --set key=value fills {{key}} (numbers are written unquoted when the placeholder is a whole JSON string).
// --upload key=file uploads the file to ComfyUI input/vediofactory and fills {{key}} with its name.
// An unfilled {{lora_name}} LoraLoaderModelOnly node is removed and bypassed (as server.js does without a LoRA).
// The first image/webm output of the prompt is copied to --out; a .json report with timings/telemetry goes next to it.
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
    workflow: { type: 'string' },
    set: { type: 'string', multiple: true, default: [] },
    upload: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
    label: { type: 'string', default: 'general-step' },
  },
});
if (!args.workflow || !args.out) throw new Error('--workflow and --out are required');
const comfy = args['comfy-url'].replace(/\/+$/u, '');
const log = (message) => console.log(`[${args.label} ${new Date().toISOString().slice(11, 19)}] ${message}`);
const splitPair = (pair) => {
  const index = pair.indexOf('=');
  if (index < 1) throw new Error(`expected key=value, got ${pair}`);
  return [pair.slice(0, index), pair.slice(index + 1)];
};

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

const preflight = await checkGpuPreflight();
if (!preflight?.ok) {
  console.error(`GPU preflight failed:\n  - ${preflight.problems.join('\n  - ')}`);
  process.exit(2);
}
log(`preflight ok: ${preflight.sample.tempC} C, limit ${preflight.sample.powerLimitW} W, VRAM ${preflight.sample.vramMiB} MiB`);

const vars = {};
for (const pair of args.set) {
  const [key, value] = splitPair(pair);
  vars[key] = /^-?\d+(\.\d+)?$/u.test(value) ? Number(value) : value;
}
for (const pair of args.upload) {
  const [key, file] = splitPair(pair);
  vars[key] = await upload(path.resolve(file), `${args.label}-${key}${path.extname(file)}`);
}
let text = fs.readFileSync(path.resolve(args.workflow), 'utf8');
for (const [key, value] of Object.entries(vars)) {
  text = typeof value === 'number'
    ? text.replaceAll(`"{{${key}}}"`, String(value)).replaceAll(`{{${key}}}`, String(value))
    : text.replaceAll(`{{${key}}}`, JSON.stringify(value).slice(1, -1));
}
const prompt = JSON.parse(text);
for (const [id, node] of Object.entries(prompt)) {
  if (node.class_type === 'LoraLoaderModelOnly' && node.inputs.lora_name === '{{lora_name}}') {
    const upstream = node.inputs.model;
    for (const other of Object.values(prompt)) {
      for (const [key, value] of Object.entries(other.inputs)) {
        if (Array.isArray(value) && value[0] === id) other.inputs[key] = upstream;
      }
    }
    delete prompt[id];
  }
}
const leftover = JSON.stringify(prompt).match(/\{\{\w+\}\}/u);
if (leftover) throw new Error(`unfilled placeholder ${leftover[0]}`);

let abortReason = null;
const guard = startGpuGuard({
  label: args.label,
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
let promptId = null;
let status = null;
let executionSeconds = null;
try {
  const response = await fetch(`${comfy}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: `vediofactory-${args.label}` }),
  });
  const body = await response.json();
  if (!response.ok || !body.prompt_id) throw new Error(`prompt rejected: ${JSON.stringify(body).slice(0, 3000)}`);
  promptId = body.prompt_id;
  log(`queued ${promptId}`);
  let lastLog = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const history = await (await fetch(`${comfy}/history/${promptId}`)).json();
    const entry = history[promptId];
    if (entry?.status?.completed || entry?.status?.status_str === 'error') {
      status = entry.status;
      const times = (status.messages || []).filter(([kind]) => ['execution_start', 'execution_success', 'execution_error', 'execution_interrupted'].includes(kind)).map(([, data]) => data.timestamp);
      if (times.length >= 2) executionSeconds = Math.round((times.at(-1) - times[0]) / 100) / 10;
      for (const output of Object.values(entry.outputs || {})) {
        const files = [...(output.images || []), ...(output.gifs || []), ...(output.videos || [])].filter((file) => file.type === 'output');
        const wanted = files.find((file) => path.extname(file.filename).toLowerCase() === path.extname(args.out).toLowerCase());
        if (wanted) { outputFile = path.join(args['comfy-dir'], 'output', wanted.subfolder || '', wanted.filename); break; }
      }
      break;
    }
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      const g = guard.summary();
      log(`running… max ${g.maxTempC} C, ${g.maxPowerW} W, VRAM ${g.maxVramMiB} MiB`);
    }
  }
} catch (error) {
  log(`error: ${error.message}`);
  exitCode = 1;
}
const telemetry = await guard.stop();
const wallSeconds = Math.round((Date.now() - started) / 1000);
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
if (outputFile && fs.existsSync(outputFile)) {
  fs.copyFileSync(outputFile, args.out);
  log(`saved ${args.out}`);
} else if (!exitCode) {
  log(`no output (${JSON.stringify(status?.messages?.filter(([kind]) => kind === 'execution_error') ?? status).slice(0, 3000)})`);
  exitCode = 1;
}
const report = {
  promptId, workflow: path.relative(repoRoot, path.resolve(args.workflow)), vars, wallSeconds, executionSeconds,
  abortReason, comfyOutput: outputFile, gpuTelemetry: telemetry,
};
fs.writeFileSync(args.out.replace(/\.\w+$/u, '.json'), `${JSON.stringify(report, null, 2)}\n`);
log(`wall ${wallSeconds} s (ComfyUI ${executionSeconds} s); max ${telemetry.maxTempC} C, ${telemetry.maxPowerW} W, VRAM ${telemetry.maxVramMiB} MiB, tripped=${JSON.stringify(telemetry.tripped)}`);
process.exit(abortReason ? 3 : exitCode);
