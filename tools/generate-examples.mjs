// 用本機 ComfyUI 依序產生場景模組的範例影片，並檢查影片內容。
// 用法：node tools/generate-examples.mjs [--only dance,runway,gym] [--duration 5] [--output <資料夾>]
//       [--cooldown 60] [--max-temp 83]
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { startServer } = require('../server.js');

function parseArgs(argv) {
  const options = { only: ['dance', 'runway', 'gym'], duration: null, output: '', cooldown: 60, maxTemp: 83 };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--only') options.only = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (flag === '--duration') options.duration = Number(value);
    else if (flag === '--output') options.output = path.resolve(value);
    else if (flag === '--cooldown') options.cooldown = Number(value);
    else if (flag === '--max-temp') options.maxTemp = Number(value);
    else throw new Error(`不認得的參數：${flag}`);
    index += 1;
  }
  return options;
}

function run(command, args, { encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr}`;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${message}`);

async function readGpuTemperature() {
  try {
    const output = await run('nvidia-smi', ['--query-gpu=temperature.gpu,power.draw,memory.used', '--format=csv,noheader,nounits']);
    const [temperature, power, memory] = output.trim().split(/\r?\n/u)[0].split(',').map((item) => Number(item.trim()));
    return { temperature, power, memory };
  } catch {
    return null;
  }
}

async function waitForCoolGpu(maxTemp) {
  for (;;) {
    const gpu = await readGpuTemperature();
    if (!gpu || gpu.temperature < maxTemp - 10) return;
    log(`GPU ${gpu.temperature}°C，等待降溫到 ${maxTemp - 10}°C 以下再送出下一個工作…`);
    await sleep(15_000);
  }
}

const ffmpegPath = process.env.VEDIO_FACTORY_FFMPEG || 'ffmpeg';
const ffprobePath = process.env.VEDIO_FACTORY_FFMPEG
  ? path.join(path.dirname(process.env.VEDIO_FACTORY_FFMPEG), `ffprobe${path.extname(process.env.VEDIO_FACTORY_FFMPEG)}`)
  : 'ffprobe';

async function grabGrayFrame(filePath, seconds, width) {
  const frame = await run(ffmpegPath, [
    '-v', 'error', '-ss', String(seconds), '-i', filePath, '-frames:v', '1',
    '-vf', `scale=${width}:-2,format=gray`, '-f', 'rawvideo', 'pipe:1',
  ], { encoding: 'buffer' });
  if (!frame.length) throw new Error(`無法在 ${seconds} 秒取出畫面`);
  return frame;
}

// 檢查：時長、解析度、畫面不是全黑、前後畫面有明顯差異（不是靜止畫面）。
async function verifyVideo(filePath, expected) {
  const probe = JSON.parse(await run(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,nb_read_frames:format=duration', '-of', 'json', filePath,
  ]));
  const stream = probe.streams?.[0] ?? {};
  const duration = Number(probe.format?.duration) || Number(stream.nb_read_frames) / expected.fps;
  const early = await grabGrayFrame(filePath, Math.min(0.3, duration / 4), 96);
  const late = await grabGrayFrame(filePath, duration * 0.75, 96);
  const pixels = Math.min(early.length, late.length);
  let brightness = 0;
  let difference = 0;
  for (let index = 0; index < pixels; index += 1) {
    brightness += late[index];
    difference += Math.abs(early[index] - late[index]);
  }
  const report = {
    width: stream.width,
    height: stream.height,
    frames: Number(stream.nb_read_frames),
    duration: Number(duration.toFixed(2)),
    brightness: Number((brightness / pixels).toFixed(1)),
    motion: Number((difference / pixels).toFixed(1)),
  };
  const problems = [];
  if (`${report.width}x${report.height}` !== expected.resolution) problems.push(`解析度 ${report.width}x${report.height} 與設定 ${expected.resolution} 不同`);
  if (Math.abs(report.duration - expected.duration) > 0.6) problems.push(`時長 ${report.duration} 秒與設定 ${expected.duration} 秒差太多`);
  if (report.brightness < 15) problems.push('畫面過暗，可能是黑畫面');
  if (report.motion < 2) problems.push('前後畫面幾乎沒有變化，可能是靜止畫面');
  return { ...report, passed: problems.length === 0, problems };
}

function fillTemplate(template, variables) {
  return String(template || '').replace(/(?<!\{)\{([\p{L}\p{N}_]{1,40})\}(?!\})/gu, (token, name) => variables[name] ?? token);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const app = await startServer({ port: 0, host: '127.0.0.1', ...(options.output ? { outputDir: options.output } : {}) });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (url, init) => {
    const response = await fetch(`${origin}${url}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };

  const results = [];
  try {
    const outputDir = app.getOutputDir();
    const runtime = await api('/api/inference/runtime');
    if (!runtime.comfyUI.available) throw new Error(`無法連線到 ComfyUI（${runtime.comfyUI.url}）`);
    log(`ComfyUI：${runtime.comfyUI.url}；影片會匯入 ${outputDir}`);
    const scenarioModules = await api('/api/scenario-modules');
    const presets = await api('/api/presets');

    for (const [index, id] of options.only.entries()) {
      const scenarioModule = scenarioModules.find((item) => item.id === id);
      if (!scenarioModule || scenarioModule.error || !scenarioModule.workflowId) {
        results.push({ id, status: 'failed', error: scenarioModule?.error || '找不到具備工作流的場景模組' });
        continue;
      }
      const preset = presets.find((item) => item.id === scenarioModule.presetId);
      const variables = scenarioModule.example?.variables ?? {};
      const settings = { ...preset.settings, ...(options.duration ? { duration: options.duration } : {}) };
      await waitForCoolGpu(options.maxTemp);
      const startedAt = Date.now();
      let job = await api('/api/inference/jobs', {
        method: 'POST',
        body: JSON.stringify({
          prompt: fillTemplate(preset.promptTemplate, variables),
          story: fillTemplate(preset.storyTemplate, variables),
          negativePrompt: preset.negativePrompt,
          seed: scenarioModule.example?.seed ?? undefined,
          client: '範例',
          project: '場景模組',
          presetId: scenarioModule.presetId,
          workflowId: scenarioModule.workflowId,
          moduleId: scenarioModule.canvas?.moduleId,
          videoModelId: preset.videoModelId,
          settings,
        }),
      });
      log(`${scenarioModule.name}：已送出工作 ${job.id}（seed ${job.seed}，${settings.resolution}，${settings.duration} 秒）`);

      let lastLog = 0;
      while (['queued', 'running'].includes(job.status)) {
        await sleep(5_000);
        job = await api(`/api/inference/jobs/${job.id}`);
        if (Date.now() - lastLog > 30_000) {
          const gpu = await readGpuTemperature();
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          log(`${scenarioModule.name}：${job.status}，已 ${elapsed} 秒${gpu ? `；GPU ${gpu.temperature}°C、${gpu.power} W、顯存 ${gpu.memory} MiB` : ''}`);
          if (gpu && gpu.temperature >= options.maxTemp + 5) {
            log(`警告：GPU 溫度 ${gpu.temperature}°C 偏高，請確認散熱。`);
          }
          lastLog = Date.now();
        }
      }
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (job.status !== 'succeeded' || !job.outputs?.length) {
        results.push({ id, jobId: job.id, status: job.status, seconds, error: job.error || job.guidance || '沒有輸出影片' });
        log(`${scenarioModule.name}：失敗（${job.error || job.guidance || job.status}）`);
        continue;
      }
      const filePath = path.join(outputDir, job.outputs[0].fileName);
      const check = await verifyVideo(filePath, settings);
      results.push({ id, name: scenarioModule.name, jobId: job.id, seed: job.seed, status: job.status, seconds, filePath, check });
      log(`${scenarioModule.name}：完成，用時 ${seconds} 秒 → ${filePath}；檢查${check.passed ? '通過' : `未通過：${check.problems.join('、')}`}`);
      if (index < options.only.length - 1 && options.cooldown > 0) {
        log(`休息 ${options.cooldown} 秒讓 GPU 降溫…`);
        await sleep(options.cooldown * 1000);
      }
    }

    // 合併到既有報告：只跑部分模組時，保留其他模組上一次的結果。
    const reportPath = path.join(outputDir, 'examples-report.json');
    const previous = await fs.readFile(reportPath, 'utf8').then(JSON.parse, () => ({ results: [] }));
    const merged = [
      ...(previous.results || []).filter((item) => !results.some((result) => result.id === item.id)),
      ...results,
    ];
    await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results: merged }, null, 2));
    log(`報告：${reportPath}`);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
  const failed = results.filter((result) => result.status !== 'succeeded' || !result.check?.passed);
  if (failed.length) {
    console.error(`有 ${failed.length} 個範例未通過：${failed.map((result) => result.id).join('、')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
