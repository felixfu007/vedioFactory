// GPU telemetry logger + watchdog (OPTIMIZATION_PLAN 6.x). The RTX 5070 Ti dropped off the bus ("GPU is lost") twice
// after a few minutes of sustained 100 % load, with nothing in the Windows event log. This records what the card was
// doing every second, fsync'ed line by line so the samples right before a crash survive, and interrupts ComfyUI when
// the card overheats or keeps hitting hardware slowdown.
//
//   node tools/gpu-guard.mjs                      # monitor only; Ctrl+C to stop
//   node tools/gpu-guard.mjs --interrupt          # also POST ComfyUI /interrupt when a limit trips
//
// Imported by tests/run-dance-e2e.mjs via startGpuGuard() / checkGpuPreflight().
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GPU_LIMITS = {
  // Default power limit we expect after tools/gpu-safe-mode.ps1 (card range 250-300 W, default 300 W).
  maxPowerLimitW: 250,
  // Don't start a job on a card that is still hot from the previous one.
  maxStartTempC: 65,
  // Trip: core temperature (the 5070 Ti throttles around 88 C).
  tripTempC: 85,
  // Trip: GDDR7 temperature when the driver reports it (usually N/A on GeForce).
  tripMemoryTempC: 98,
  // Trip: hardware slowdown (power brake / thermal) active this many consecutive samples.
  tripHwSlowdownSamples: 3,
  // Before start: GPU utilization must stay below this for the idle check (other GPU jobs running otherwise).
  maxIdleUtilization: 15,
};

const FIELDS = [
  ['timestamp', 'timestamp'],
  ['temperature.gpu', 'tempC'],
  ['temperature.memory', 'memTempC'],
  ['power.draw', 'powerW'],
  ['power.draw.instant', 'powerInstantW'],
  ['power.limit', 'powerLimitW'],
  ['clocks.gr', 'clockGrMHz'],
  ['clocks.mem', 'clockMemMHz'],
  ['utilization.gpu', 'utilPct'],
  ['memory.used', 'vramMiB'],
  ['fan.speed', 'fanPct'],
  ['pstate', 'pstate'],
  ['clocks_event_reasons.active', 'reasonsActive'],
  ['clocks_event_reasons.sw_power_cap', 'swPowerCap'],
  ['clocks_event_reasons.hw_slowdown', 'hwSlowdown'],
  ['clocks_event_reasons.hw_thermal_slowdown', 'hwThermal'],
  ['clocks_event_reasons.hw_power_brake_slowdown', 'hwPowerBrake'],
  ['clocks_event_reasons.sw_thermal_slowdown', 'swThermal'],
];
const QUERY = `--query-gpu=${FIELDS.map(([field]) => field).join(',')}`;
const GPU_LOST_PATTERN = /GPU is lost|Unable to determine the device handle|No devices were found/iu;

function parseSample(line) {
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length !== FIELDS.length) return null;
  const sample = {};
  FIELDS.forEach(([, key], index) => {
    const raw = parts[index];
    const number = Number(raw);
    sample[key] = raw === '' || /^\[?N\/A\]?$/iu.test(raw) ? null : Number.isFinite(number) && !/^0x/iu.test(raw) ? number : raw;
  });
  return sample;
}

const isActive = (value) => typeof value === 'string' && /^active$/iu.test(value);

async function querySample() {
  const { stdout } = await execFileAsync('nvidia-smi', [QUERY, '--format=csv,noheader,nounits'], { timeout: 10_000, windowsHide: true });
  const sample = parseSample(stdout.trim().split(/\r?\n/u)[0] || '');
  if (!sample) throw new Error(`unexpected nvidia-smi output: ${stdout.trim()}`);
  return sample;
}

// Checks run before a GPU job. Returns { ok, problems[], sample }; problems are human-readable reasons not to start.
export async function checkGpuPreflight({ limits = GPU_LIMITS, allowFullPower = false, idleSeconds = 5 } = {}) {
  let sample;
  try {
    sample = await querySample();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    return { ok: false, gpuLost: GPU_LOST_PATTERN.test(detail), problems: [`nvidia-smi failed: ${detail}`] };
  }
  const problems = [];
  if (!allowFullPower && sample.powerLimitW !== null && sample.powerLimitW > limits.maxPowerLimitW) {
    problems.push(`power limit is ${sample.powerLimitW} W (> ${limits.maxPowerLimitW} W). Run tools/gpu-safe-mode.ps1 as `
      + 'Administrator first (it resets on every reboot), or pass --allow-full-power.');
  }
  if (sample.tempC !== null && sample.tempC > limits.maxStartTempC) {
    problems.push(`GPU is ${sample.tempC} C (> ${limits.maxStartTempC} C); let it cool down first.`);
  }
  // WDDM hides other processes' GPU memory, so detect a parallel GPU job from utilization over a few seconds.
  let busy = 0;
  for (let index = 0; index < idleSeconds; index += 1) {
    const current = index === 0 ? sample : await querySample().catch(() => null);
    if (current && current.utilPct !== null && current.utilPct > limits.maxIdleUtilization) busy += 1;
    if (index < idleSeconds - 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (busy > idleSeconds / 2) {
    problems.push(`GPU utilization is above ${limits.maxIdleUtilization} % while idle; another GPU job is running. `
      + 'Do not run two GPU jobs in parallel.');
  }
  return { ok: problems.length === 0, problems, sample };
}

// Starts a long-lived `nvidia-smi -lms` logger. onTrip(reason, sample) is called once when a limit trips; onLost(text)
// once when the driver reports the GPU is lost. Returns { stop(): Promise<summary>, logFile, summary() }.
export function startGpuGuard({
  logDir = path.join(repoRoot, 'logs', 'gpu'),
  label = 'gpu',
  intervalMs = 1_000,
  limits = GPU_LIMITS,
  onTrip = () => {},
  onLost = () => {},
  onSample = () => {},
} = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  const logFile = path.join(logDir, `${stamp}-${label}.csv`);
  const fd = fs.openSync(logFile, 'a');
  const writeLine = (line) => {
    fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
  };
  writeLine(FIELDS.map(([, key]) => key).join(','));

  const stats = {
    logFile, samples: 0, maxTempC: null, maxMemTempC: null, maxPowerW: null, maxPowerInstantW: null,
    maxVramMiB: null, minClockGrUnderLoadMHz: null, maxClockGrMHz: null, hwSlowdownSamples: 0, swPowerCapSamples: 0,
    powerLimitW: null, tripped: null, gpuLost: null,
  };
  const max = (current, value) => (value === null || value === undefined ? current : current === null ? value : Math.max(current, value));
  let hwStreak = 0;
  let stopped = false;
  let pending = '';

  const child = spawn('nvidia-smi', [QUERY, '--format=csv,noheader,nounits', `-lms`, String(intervalMs)], { windowsHide: true });
  // Without a listener a failed spawn (ENOENT) would crash the host process, e.g. the vedioFactory server. 'close'
  // still follows and logs the unexpected exit; the server treats a guard without samples as a lost GPU.
  child.on('error', (error) => {
    if (!stopped) writeLine(`# nvidia-smi failed: ${error.message}`);
  });
  const handleText = (text) => {
    if (GPU_LOST_PATTERN.test(text) && !stats.gpuLost) {
      stats.gpuLost = { at: new Date().toISOString(), text: text.trim().slice(0, 300) };
      writeLine(`# GPU LOST ${stats.gpuLost.at}: ${stats.gpuLost.text.replace(/\r?\n/gu, ' ')}`);
      onLost(stats.gpuLost.text);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const sample = parseSample(line);
      if (!sample) {
        writeLine(`# ${line.trim()}`);
        handleText(line);
        continue;
      }
      writeLine(line.trim());
      stats.samples += 1;
      stats.maxTempC = max(stats.maxTempC, sample.tempC);
      stats.maxMemTempC = max(stats.maxMemTempC, sample.memTempC);
      stats.maxPowerW = max(stats.maxPowerW, sample.powerW);
      stats.maxPowerInstantW = max(stats.maxPowerInstantW, sample.powerInstantW);
      stats.maxVramMiB = max(stats.maxVramMiB, sample.vramMiB);
      stats.maxClockGrMHz = max(stats.maxClockGrMHz, sample.clockGrMHz);
      stats.powerLimitW = sample.powerLimitW;
      if (sample.utilPct !== null && sample.utilPct >= 90 && sample.clockGrMHz !== null) {
        stats.minClockGrUnderLoadMHz = stats.minClockGrUnderLoadMHz === null
          ? sample.clockGrMHz : Math.min(stats.minClockGrUnderLoadMHz, sample.clockGrMHz);
      }
      if (isActive(sample.swPowerCap)) stats.swPowerCapSamples += 1;
      const hw = isActive(sample.hwSlowdown) || isActive(sample.hwThermal) || isActive(sample.hwPowerBrake);
      if (hw) stats.hwSlowdownSamples += 1;
      hwStreak = hw ? hwStreak + 1 : 0;
      onSample(sample);

      let reason = null;
      if (sample.tempC !== null && sample.tempC >= limits.tripTempC) reason = `GPU temperature ${sample.tempC} C >= ${limits.tripTempC} C`;
      else if (sample.memTempC !== null && sample.memTempC >= limits.tripMemoryTempC) reason = `memory temperature ${sample.memTempC} C >= ${limits.tripMemoryTempC} C`;
      else if (hwStreak >= limits.tripHwSlowdownSamples) reason = `hardware slowdown (power brake/thermal) active for ${hwStreak} s`;
      if (reason && !stats.tripped) {
        stats.tripped = { at: sample.timestamp, reason };
        writeLine(`# TRIP ${sample.timestamp}: ${reason}`);
        onTrip(reason, sample);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', handleText);
  const exited = new Promise((resolve) => child.on('close', (code) => {
    if (!stopped) {
      writeLine(`# nvidia-smi exited unexpectedly (code ${code})`);
      handleText(pending);
    }
    resolve();
  }));

  return {
    logFile,
    summary: () => ({ ...stats }),
    async stop() {
      if (!stopped) {
        stopped = true;
        child.kill();
        await exited;
        writeLine(`# summary ${JSON.stringify(stats)}`);
        fs.closeSync(fd);
      }
      return { ...stats };
    },
  };
}

// Stops whatever ComfyUI is executing right now. Global by design: only used when the card is in danger.
export async function interruptComfyUI(comfyUrl) {
  await fetch(`${comfyUrl.replace(/\/+$/u, '')}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5_000) });
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      interrupt: { type: 'boolean', default: false },
      'comfy-url': { type: 'string', default: process.env.VEDIO_FACTORY_COMFYUI_URL || 'http://127.0.0.1:8188' },
      'interval-ms': { type: 'string', default: '1000' },
    },
  });
  const guard = startGpuGuard({
    label: 'monitor',
    intervalMs: Number(args['interval-ms']),
    onTrip: (reason) => {
      console.log(`[gpu-guard] TRIP: ${reason}`);
      if (args.interrupt) {
        interruptComfyUI(args['comfy-url']).then(
          () => console.log('[gpu-guard] ComfyUI interrupted'),
          (error) => console.log(`[gpu-guard] ComfyUI interrupt failed: ${error.message}`),
        );
      }
    },
    onLost: (text) => console.log(`[gpu-guard] GPU LOST: ${text}`),
    onSample: (sample) => {
      if (sample && new Date().getSeconds() % 15 === 0) {
        console.log(`[gpu-guard] ${sample.tempC} C  ${sample.powerW} W (instant ${sample.powerInstantW ?? '-'} W / limit ${sample.powerLimitW} W)`
          + `  ${sample.clockGrMHz} MHz  util ${sample.utilPct} %  VRAM ${sample.vramMiB} MiB`);
      }
    },
  });
  console.log(`[gpu-guard] logging to ${guard.logFile}${args.interrupt ? ' (will interrupt ComfyUI on trip)' : ''}; Ctrl+C to stop`);
  process.on('SIGINT', async () => {
    console.log(`[gpu-guard] ${JSON.stringify(await guard.stop())}`);
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
