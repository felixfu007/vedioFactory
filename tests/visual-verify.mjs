import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startOnFetchSafePort } from './safe-port.mjs';

import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const { startServer: startServerRaw } = require('../server.js');
const startServer = (options) => startOnFetchSafePort(startServerRaw, options);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outputDir = path.join(repoRoot, 'visual-output');
const sampleSvgPath = path.join(outputDir, 'verification-source.svg');

const scenarios = [
  {
    name: 'text-storyboard',
    prompt: '品牌火箭升空',
    story: '火箭起飛。穿越雲層。停在 TEST TITLE。',
    moduleId: 'storyboard-focus',
    uploadImage: false,
    duration: 2,
    threshold: 0.91,
  },
  {
    name: 'photo-cinematic',
    prompt: '讓火箭圖像緩慢推近，營造電影海報感',
    story: '主體推近。背景光暈加強。最後停在品牌標語。',
    moduleId: 'cinematic-motion',
    uploadImage: true,
    duration: 2,
    threshold: 0.86,
  },
];

async function resolveChromiumPath() {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }

  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium',
      ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    process.platform === 'win32'
      ? '找不到可用的 Chrome/Edge。請安裝瀏覽器，或設定 CHROMIUM_PATH 指向 chrome.exe / msedge.exe。'
      : '找不到可用的 Chromium/Chrome。請安裝瀏覽器，或設定 CHROMIUM_PATH 指向可執行檔。',
  );
}

async function ensureFixtures() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(sampleSvgPath, `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#09182f" />
  <circle cx="200" cy="160" r="80" fill="#5b8cff" />
  <path d="M420 80 L470 220 L430 205 L395 280 L360 205 L320 220 Z" fill="#ffd86b" />
  <text x="70" y="315" fill="#eff6ff" font-size="48" font-family="sans-serif">ROCKET TEST</text>
</svg>
`.trim());
}

async function saveDataUrl(targetPath, dataUrl) {
  const [, base64Payload] = dataUrl.split(',');
  await fs.writeFile(targetPath, Buffer.from(base64Payload, 'base64'));
}

async function resetDirectory(targetDir) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
}

async function runScenario(browser, origin, scenario, managedOutputDir) {
  await resetDirectory(managedOutputDir);
  const page = await browser.newPage();

  try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });

    await page.waitForFunction(() => document.querySelector('#storageMode')?.textContent.includes('後端'));
    const videoModelCount = await page.$$eval('#videoModelSelect option', (options) => options.length);
    assert.equal(videoModelCount, 10, 'expected the UI to expose all ten recommended video models');
    assert.equal(await page.$eval('#cancelInferenceButton', (button) => button.hidden), true);
    await page.type('#promptInput', scenario.prompt);
    await page.type('#storyInput', scenario.story);
    await page.select('#moduleSelect', scenario.moduleId);
    await page.$eval('#durationInput', (input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, scenario.duration);

    if (scenario.uploadImage) {
      const fileInput = await page.$('#imageInput');
      await fileInput.uploadFile(sampleSvgPath);
    }

    await page.click('#generateButton');
    await page.waitForFunction(() => document.querySelectorAll('.video-card').length === 1, { timeout: 30_000 });

    const pageScreenshotPath = path.join(outputDir, `${scenario.name}-page.png`);
    await page.screenshot({ path: pageScreenshotPath, fullPage: true });

    const verification = await page.evaluate(async (expected) => {
      const once = (target, eventName) => new Promise((resolve) => {
        target.addEventListener(eventName, resolve, { once: true });
      });

      const readImage = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('image load failed'));
        image.src = src;
      });

      const compareImages = async (leftSource, rightSource) => {
        const [leftImage, rightImage] = await Promise.all([readImage(leftSource), readImage(rightSource)]);
        const canvas = document.createElement('canvas');
        canvas.width = leftImage.width;
        canvas.height = leftImage.height;
        const context = canvas.getContext('2d');

        context.drawImage(leftImage, 0, 0);
        const leftPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(rightImage, 0, 0);
        const rightPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;

        let diff = 0;
        for (let index = 0; index < leftPixels.length; index += 1) {
          diff += Math.abs(leftPixels[index] - rightPixels[index]);
        }

        const normalized = 1 - diff / (leftPixels.length * 255);
        return Number(normalized.toFixed(4));
      };

      const item = window.VedioFactory.getLibrarySnapshot()[0];
      if (!item) {
        throw new Error('generated item not found in library snapshot');
      }
      const card = document.querySelector(`.video-card[data-item-id="${CSS.escape(item.id)}"]`);
      const video = card?.querySelector('video');
      if (!video) {
        throw new Error('generated video element not found');
      }
      const targetTime = Math.max(0, Math.min(item.duration / 2, video.duration - 0.1));

      if (video.readyState < 2) {
        await once(video, 'loadeddata');
      }

      video.currentTime = targetTime;
      await once(video, 'seeked');

      const actualCanvas = document.createElement('canvas');
      actualCanvas.width = video.videoWidth;
      actualCanvas.height = video.videoHeight;
      actualCanvas.getContext('2d').drawImage(video, 0, 0, actualCanvas.width, actualCanvas.height);
      const actualFrame = actualCanvas.toDataURL('image/png');
      const referenceFrame = await window.VedioFactory.renderReferenceFrame(item, targetTime);
      const similarity = await compareImages(actualFrame, referenceFrame);

      return {
        item,
        similarity,
        targetTime,
        actualFrame,
        referenceFrame,
        status: document.querySelector('#generationStatus')?.textContent,
        storageMode: document.querySelector('#storageMode')?.textContent,
      };
    }, {
      moduleId: scenario.moduleId,
      prompt: scenario.prompt,
      story: scenario.story,
    });

    const actualFramePath = path.join(outputDir, `${scenario.name}-frame-actual.png`);
    const referenceFramePath = path.join(outputDir, `${scenario.name}-frame-reference.png`);
    await saveDataUrl(actualFramePath, verification.actualFrame);
    await saveDataUrl(referenceFramePath, verification.referenceFrame);

    assert.equal(verification.item.moduleId, scenario.moduleId);
    assert.equal(verification.item.prompt, scenario.prompt);
    assert.equal(verification.item.story, scenario.story);
    assert.equal(verification.storageMode, '後端資料夾');
    assert.ok(verification.similarity >= scenario.threshold, `${scenario.name} similarity ${verification.similarity} below ${scenario.threshold}`);

    return {
      ...verification,
      pageScreenshotPath,
      actualFramePath,
      referenceFramePath,
    };
  } finally {
    await page.close();
  }
}

// ComfyUI image-to-video imports store sourceImageAttached instead of the image data URL; the card must still say
// the video came from a photo (regression: it used to show 純文字描述).
async function verifyComfyImportedCard(browser, origin, managedOutputDir) {
  await resetDirectory(managedOutputDir);
  const fileName = 'comfyui-visual-check-1.webm';
  await fs.writeFile(path.join(managedOutputDir, fileName), Buffer.from('placeholder'));
  await fs.writeFile(path.join(managedOutputDir, `${fileName}.json`), JSON.stringify({
    id: 'comfy-visual-check',
    fileName,
    moduleId: 'cinematic-motion',
    moduleName: 'ComfyUI',
    prompt: 'fox turns its head',
    story: '',
    duration: 2,
    fps: 24,
    resolution: '832x480',
    quality: 'draft',
    createdAt: new Date().toISOString(),
    videoModelId: 'wan-2.2-ti2v-5b',
    sourceImageAttached: true,
  }));
  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`.video-card[data-file-name="${fileName}"]`);
    const stats = await page.$eval(`.video-card[data-file-name="${fileName}"] .stats`, (element) => element.textContent);
    assert.match(stats, /來源照片 \+ 提示詞/u, `ComfyUI image-to-video card should show a photo source, got: ${stats}`);
  } finally {
    await page.close();
  }
}

// LoRA controls: default "none" with strength disabled; a selected LoRA shows the trigger-word hint, trigger words and
// license. The list is served by request interception so the check does not depend on the real ComfyUI's loras folder,
// and a hostile name proves names are rendered as text, never HTML.
async function verifyLoraControls(browser, origin) {
  const hostileName = '<img src=x onerror="window.__loraXss=1">.safetensors';
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/inference/loras') {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            available: true,
            loras: ['DR34ML4Y_TI2V_5B_V1.safetensors', hostileName],
            maxStrength: 2,
            defaultStrength: 1,
            catalog: [{
              file: 'DR34ML4Y_TI2V_5B_V1.safetensors',
              baseModel: 'Wan Video 2.2 TI2V-5B',
              compatibleVideoModelIds: ['wan-2.2-ti2v-5b'],
              trainedWords: ['trigger_a', 'trigger_b'],
              license: '不可商用、不可散布衍生模型',
              installed: true,
            }],
          }),
        });
      } else {
        request.continue();
      }
    });
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('#loraSelect option').length === 3);
    const initial = await page.evaluate(() => ({
      value: document.querySelector('#loraSelect').value,
      firstLabel: document.querySelector('#loraSelect option').textContent,
      strengthDisabled: document.querySelector('#loraStrengthInput').disabled,
      strength: document.querySelector('#loraStrengthInput').value,
      hintHidden: document.querySelector('#loraHint').hidden,
    }));
    assert.deepEqual(initial, { value: '', firstLabel: '無', strengthDisabled: true, strength: '1', hintHidden: true });

    await page.select('#loraSelect', 'DR34ML4Y_TI2V_5B_V1.safetensors');
    const selected = await page.evaluate(() => ({
      strengthDisabled: document.querySelector('#loraStrengthInput').disabled,
      hintHidden: document.querySelector('#loraHint').hidden,
      hint: document.querySelector('#loraHint').textContent,
    }));
    assert.equal(selected.strengthDisabled, false);
    assert.equal(selected.hintHidden, false);
    assert.match(selected.hint, /LoRA 需要在提示詞中加入對應觸發詞/u);
    assert.match(selected.hint, /trigger_a, trigger_b/u);
    assert.match(selected.hint, /不可商用/u);

    await page.select('#loraSelect', hostileName);
    const hostile = await page.evaluate(() => ({
      injected: document.querySelectorAll('#loraSelect img, #loraHint img').length,
      flag: window.__loraXss ?? null,
      hint: document.querySelector('#loraHint').textContent,
    }));
    assert.deepEqual({ injected: hostile.injected, flag: hostile.flag }, { injected: 0, flag: null });
    assert.match(hostile.hint, /LoRA 需要在提示詞中加入對應觸發詞/u);

    // A catalog LoRA with an incompatible video model is warned about and never submitted.
    const jobRequests = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /^\/api\/inference\/(jobs|workflow-check)$/u.test(new URL(request.url()).pathname)) {
        jobRequests.push(new URL(request.url()).pathname);
      }
    });
    await page.select('#loraSelect', 'DR34ML4Y_TI2V_5B_V1.safetensors');
    await page.select('#videoModelSelect', 'wan-2.1-t2v-1.3b');
    assert.match(await page.$eval('#loraHint', (element) => element.textContent), /不相容/u);
    await page.$eval('#durationInput', (element) => {
      element.value = '2';
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.$eval('#promptInput', (element) => {
      element.value = 'a fox turns its head';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#queueInferenceButton');
    await page.waitForFunction(() => /未送出推論工作/u.test(document.querySelector('#inferenceStatus').textContent));
    assert.match(await page.$eval('#inferenceStatus', (element) => element.textContent), /LoRA.*不相容/u);
    assert.deepEqual(jobRequests, []);
    await page.select('#videoModelSelect', 'wan-2.2-ti2v-5b');
    assert.doesNotMatch(await page.$eval('#loraHint', (element) => element.textContent), /不相容/u);

    await page.select('#loraSelect', '');
    assert.equal(await page.$eval('#loraHint', (element) => element.hidden), true);
    assert.equal(await page.$eval('#loraStrengthInput', (element) => element.disabled), true);
  } finally {
    await page.close();
  }
}

// 「照片 → 跳舞影片」preset and two-stage job progress. The test server runs without ComfyUI/pipeline, so the pipeline
// runtime, the job list/polling, preflight, job creation and cancel are all served by request interception: nothing is
// ever submitted to a GPU. Hostile server strings prove every message is rendered as text.
const DANCE_PIPELINE = {
  enabled: true,
  stageCount: 2,
  videoModelId: 'wan-2.2-ti2v-5b',
  sourceImageRequired: true,
  durationIsTotal: true,
  drivingFrames: { min: 242, max: 321 },
  allowedDurationSecondsByFps: { 12: null, 24: { min: 11, max: 13, seconds: [11, 12, 13] }, 30: null },
  stage2Steps: { default: 10, min: 1, max: 30 },
  referenceStrength: { default: 1.3, min: 0.5, max: 2 },
  gpuGuard: { enabled: true, maxPowerLimitW: 250, maxStartTempC: 65, coolingTimeoutMinutes: 20 },
};

function makeDanceJob(overrides = {}, stage2 = {}) {
  return {
    id: 'dance-visual-job',
    comfyPromptId: 'prompt-visual-1',
    status: 'queued',
    stageLabel: '第 1/2 階段',
    pipeline: {
      stageCount: 2,
      currentStage: 1,
      stages: [
        { index: 1, name: 'motion', title: '第一階段：產生舞蹈動作', status: 'queued' },
        { index: 2, name: 'identity', title: '第二階段：以原照片重繪人物', status: 'waiting', ...stage2 },
      ],
    },
    ...overrides,
  };
}

async function interceptDanceApi(page, origin, handlers) {
  const runtime = await (await fetch(`${origin}/api/inference/runtime`)).json();
  const pipelineRuntime = { ...runtime, comfyUI: { ...runtime.comfyUI, pipeline: DANCE_PIPELINE } };
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    const respond = (body, status = 200) => request.respond({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (pathname === '/api/inference/runtime') return respond(pipelineRuntime);
    // Never let a job-related request reach the real server.
    if (pathname.startsWith('/api/inference/jobs') || pathname === '/api/inference/workflow-check') {
      const handled = handlers(request, pathname);
      if (handled) return respond(handled.body, handled.status);
      return respond({ error: `unexpected ${request.method()} ${pathname}` }, 500);
    }
    return request.continue();
  });
}

async function verifyDancePreset(browser, origin) {
  // Without the two-stage pipeline the preset stays hidden.
  const plainPage = await browser.newPage();
  try {
    await plainPage.goto(origin, { waitUntil: 'networkidle0' });
    await plainPage.waitForFunction(() => document.querySelector('#storageMode')?.textContent.includes('後端'));
    assert.equal(await plainPage.$eval('#danceSection', (element) => element.hidden), true);
  } finally {
    await plainPage.close();
  }

  // 1. Preset rendering and job submission.
  const page = await browser.newPage();
  const requests = { check: null, job: null };
  try {
    await interceptDanceApi(page, origin, (request, pathname) => {
      if (pathname === '/api/inference/jobs' && request.method() === 'GET') return { body: [] };
      if (pathname === '/api/inference/workflow-check') {
        requests.check = JSON.parse(request.postData());
        return { body: { ready: true, errors: [], warnings: [], nodeCount: 1, selectedModelId: 'wan-2.2-ti2v-5b' } };
      }
      if (pathname === '/api/inference/jobs' && request.method() === 'POST') {
        requests.job = JSON.parse(request.postData());
        return { body: makeDanceJob() };
      }
      if (pathname === '/api/inference/jobs/dance-visual-job') return { body: makeDanceJob() };
      return null;
    });
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.querySelector('#danceSection').hidden);
    const preset = await page.evaluate(() => ({
      durations: [...document.querySelectorAll('#danceDurationSelect option')].map((option) => option.value),
      duration: document.querySelector('#danceDurationSelect').value,
      resolution: document.querySelector('#danceResolutionSelect').value,
      strength: document.querySelector('#danceReferenceStrengthInput').value,
      estimate: document.querySelector('#danceEstimate').textContent,
      tips: document.querySelector('.dance-tips').textContent,
      warningHidden: document.querySelector('#danceResolutionWarning').hidden,
      startDisabled: document.querySelector('#danceStartButton').disabled,
      sectionAbovePanels: document.querySelector('#danceSection').compareDocumentPosition(document.querySelector('.controls-grid'))
        === Node.DOCUMENT_POSITION_FOLLOWING,
    }));
    assert.deepEqual(preset.durations, ['11', '12', '13']);
    assert.equal(preset.duration, '12');
    assert.equal(preset.resolution, '544x960');
    assert.equal(preset.strength, '1.3');
    assert.match(preset.estimate, /第一階段約 7 分鐘＋第二階段約 29 分鐘/u);
    assert.match(preset.tips, /全身入鏡/u);
    assert.match(preset.tips, /正面/u);
    assert.match(preset.tips, /背景單純/u);
    assert.equal(preset.warningHidden, true);
    assert.equal(preset.startDisabled, false);
    assert.equal(preset.sectionAbovePanels, true, 'the preset should come before the generic panels');

    await page.select('#danceResolutionSelect', '704x1280');
    assert.match(await page.$eval('#danceResolutionWarning', (element) => (element.hidden ? '' : element.textContent)), /16 GB 顯示記憶體/u);
    await page.select('#danceResolutionSelect', '544x960');
    assert.equal(await page.$eval('#danceResolutionWarning', (element) => element.hidden), true);

    await page.click('#danceStartButton');
    await page.waitForFunction(() => /請先選擇一張全身照片/u.test(document.querySelector('#danceStatus').textContent));
    assert.equal(requests.check, null);

    await (await page.$('#danceImageInput')).uploadFile(sampleSvgPath);
    await page.waitForFunction(() => !document.querySelector('#danceImagePreview').hidden);
    await page.click('#danceStartButton');
    await page.waitForFunction(() => /已開始產生/u.test(document.querySelector('#danceStatus').textContent));
    assert.equal(requests.check.hasSourceImage, true);
    assert.equal(requests.check.referenceStrength, 1.3);
    assert.deepEqual(requests.job.settings, {
      duration: 12, fps: 24, resolution: '544x960', quality: 'balanced', referenceStrength: 1.3,
    });
    assert.match(requests.job.sourceImageDataUrl, /^data:image\//u);
    assert.equal(requests.job.videoModelId, 'wan-2.2-ti2v-5b');

    const started = await page.evaluate(() => ({
      progress: document.querySelector('#pipelineProgress').textContent,
      progressHidden: document.querySelector('#pipelineProgress').hidden,
      cancelHidden: document.querySelector('#danceCancelButton').hidden,
      startDisabled: document.querySelector('#danceStartButton').disabled,
      // textContent: the file input's own button text comes from the browser locale, not from us.
      sectionText: document.querySelector('#danceSection').textContent,
    }));
    assert.equal(started.progressHidden, false);
    assert.match(started.progress, /第一階段：產生舞蹈動作/u);
    assert.match(started.progress, /第二階段：保持本人臉孔/u);
    assert.match(started.progress, /排隊等待中/u);
    assert.equal(started.cancelHidden, false, 'a queued job can be cancelled');
    assert.equal(started.startDisabled, true, 'only one dance job at a time');
    // "GB" (as in 16 GB) is the only Latin text allowed: a unit, not jargon.
    assert.equal(started.sectionText.replace(/\bGB\b/gu, '').match(/[A-Za-z]{2,}/u)?.[0] ?? null, null, 'the preset must not show English');
    await page.screenshot({ path: path.join(outputDir, 'dance-preset-page.png'), fullPage: true });
  } finally {
    await page.close();
  }

  // 2. Restoring a cooling job after a reload, cancel refused (409), running stage with telemetry, then a failure.
  const hostile = '<img src=x onerror="window.__danceXss=1">';
  let current = makeDanceJob({
    status: 'cooling',
    stageLabel: '第 2/2 階段（等待 GPU 冷卻）',
  });
  current.pipeline.currentStage = 2;
  current.pipeline.coolingStartedAt = new Date(Date.now() - 90_000).toISOString();
  current.pipeline.stages[0] = {
    ...current.pipeline.stages[0],
    status: 'succeeded',
    executionSeconds: 439,
    gpuTelemetry: { maxTempC: 72, maxPowerW: 180.4, maxVramMiB: 13722, samples: 440 },
  };
  current.pipeline.stages[1] = { ...current.pipeline.stages[1], status: 'cooling', gpuWait: `GPU 溫度 70°C 高於開始門檻 65°C${hostile}` };
  const cancelRequests = [];
  const progressPage = await browser.newPage();
  progressPage.on('dialog', (dialog) => dialog.accept());
  try {
    await interceptDanceApi(progressPage, origin, (request, pathname) => {
      if (pathname === '/api/inference/jobs' && request.method() === 'GET') return { body: [current] };
      if (pathname === '/api/inference/jobs/dance-visual-job/cancel') {
        cancelRequests.push(pathname);
        return { status: 409, body: { error: '第 2/2 階段已開始執行。ComfyUI 的 interrupt 會中斷全域執行，因此不會由此操作取消。' } };
      }
      if (pathname === '/api/inference/jobs/dance-visual-job') return { body: current };
      return null;
    });
    await progressPage.goto(origin, { waitUntil: 'networkidle0' });
    await progressPage.waitForFunction(() => document.querySelector('#pipelineProgress').dataset.jobStatus === 'cooling');
    const cooling = await progressPage.evaluate(() => ({
      text: document.querySelector('#pipelineProgress').textContent,
      cancelHidden: document.querySelector('#danceCancelButton').hidden,
      inferenceCancelHidden: document.querySelector('#cancelInferenceButton').hidden,
      startDisabled: document.querySelector('#danceStartButton').disabled,
      injected: document.querySelectorAll('#pipelineProgress img, #danceSection img:not(#danceImagePreview)').length,
      flag: window.__danceXss ?? null,
    }));
    assert.match(cooling.text, /顯示卡降溫中，會自動繼續/u);
    assert.match(cooling.text, /第 2\/2 階段（等待顯示卡冷卻）/u);
    assert.match(cooling.text, /最多等待 20 分鐘/u);
    assert.match(cooling.text, /產生耗時 7 分 19 秒/u);
    assert.match(cooling.text, /顯示卡最高溫度 72°C/u);
    assert.match(cooling.text, /最高功耗 180 瓦/u);
    assert.match(cooling.text, /顯示記憶體最高用量 13\.4 GB/u);
    assert.match(cooling.text, /顯示卡溫度 70°C 高於開始門檻 65°C<img src=x/u);
    assert.doesNotMatch(cooling.text, /GPU/u);
    assert.deepEqual(
      { cancelHidden: cooling.cancelHidden, inferenceCancelHidden: cooling.inferenceCancelHidden, startDisabled: cooling.startDisabled },
      { cancelHidden: false, inferenceCancelHidden: false, startDisabled: true },
    );
    assert.deepEqual({ injected: cooling.injected, flag: cooling.flag }, { injected: 0, flag: null });
    await progressPage.screenshot({ path: path.join(outputDir, 'dance-cooling-page.png'), fullPage: true });

    // The stage started between the last poll and the click: the server refuses with 409.
    await progressPage.click('#danceCancelButton');
    await progressPage.waitForFunction(() => /無法從這裡取消/u.test(document.querySelector('#danceStatus').textContent));
    assert.equal(cancelRequests.length, 1);

    current = structuredClone(current);
    current.status = 'running';
    current.stageLabel = '第 2/2 階段';
    current.pipeline.stages[1] = {
      index: 2, title: '第二階段：以原照片重繪人物', status: 'running', startedAt: new Date(Date.now() - 125_000).toISOString(),
    };
    await progressPage.waitForFunction(() => document.querySelector('#pipelineProgress').dataset.jobStatus === 'running');
    const running = await progressPage.evaluate(() => ({
      badges: [...document.querySelectorAll('.pipeline-stage .stage-badge')].map((element) => element.textContent),
      text: document.querySelector('#pipelineProgress').textContent,
      cancelHidden: document.querySelector('#danceCancelButton').hidden,
    }));
    assert.deepEqual(running.badges, ['完成', '產生中']);
    assert.match(running.text, /已執行 2 分/u);
    assert.equal(running.cancelHidden, true, 'a running stage cannot be cancelled');

    current = structuredClone(current);
    current.status = 'failed';
    current.error = `第 2/2 階段失敗：GPU 防護觸發，已中斷 ComfyUI：溫度 86°C${hostile}`;
    current.guidance = 'GPU 過熱、硬體降頻或斷線時伺服器會中斷 ComfyUI。';
    current.pipeline.stages[1] = { ...current.pipeline.stages[1], status: 'failed', gpuTelemetry: { maxTempC: 86, tripped: true } };
    await progressPage.waitForFunction(() => document.querySelector('#pipelineProgress').dataset.jobStatus === 'failed');
    const failed = await progressPage.evaluate(() => ({
      error: document.querySelector('.pipeline-error')?.textContent,
      text: document.querySelector('#pipelineProgress').textContent,
      status: document.querySelector('#danceStatus').textContent,
      cancelHidden: document.querySelector('#danceCancelButton').hidden,
      startDisabled: document.querySelector('#danceStartButton').disabled,
      injected: document.querySelectorAll('#pipelineProgress img').length,
      flag: window.__danceXss ?? null,
    }));
    assert.match(failed.error, /^失敗原因：第 2\/2 階段失敗：顯示卡防護觸發/u);
    assert.match(failed.text, /曾觸發顯示卡保護/u);
    assert.match(failed.text, /顯示卡過熱/u);
    assert.match(failed.status, /沒有成功產生影片/u);
    assert.deepEqual(
      { cancelHidden: failed.cancelHidden, startDisabled: failed.startDisabled, injected: failed.injected, flag: failed.flag },
      { cancelHidden: true, startDisabled: false, injected: 0, flag: null },
    );
    await progressPage.screenshot({ path: path.join(outputDir, 'dance-failed-page.png'), fullPage: true });
  } finally {
    await progressPage.close();
  }
}

async function main() {
  await ensureFixtures();
  const managedOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-visual-'));
  const app = await startServer({ port: 0, host: '127.0.0.1', outputDir: managedOutputDir });
  const address = app.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const chromiumPath = await resolveChromiumPath();

  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const results = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(browser, origin, scenario, managedOutputDir));
    }
    await verifyComfyImportedCard(browser, origin, managedOutputDir);
    await verifyLoraControls(browser, origin);
    await verifyDancePreset(browser, origin);

    const report = {
      generatedAt: new Date().toISOString(),
      origin,
      managedOutputDir,
      scenarios: results.map((result) => ({
        name: result.item.fileName,
        moduleId: result.item.moduleId,
        prompt: result.item.prompt,
        story: result.item.story,
        similarity: result.similarity,
        status: result.status,
        pageScreenshotPath: path.relative(repoRoot, result.pageScreenshotPath),
        actualFramePath: path.relative(repoRoot, result.actualFramePath),
        referenceFramePath: path.relative(repoRoot, result.referenceFramePath),
      })),
    };

    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(managedOutputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
