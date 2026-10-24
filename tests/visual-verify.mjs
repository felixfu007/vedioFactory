import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const { startServer } = require('../server.js');

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

async function runPresetScenario(browser, origin, managedOutputDir) {
  await resetDirectory(managedOutputDir);
  const presetResponse = await fetch(`${origin}/api/presets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'IG 直式',
      client: '客戶A',
      project: '春季活動',
      promptTemplate: '展示 {product}',
      storyTemplate: '{product} 緩慢推近',
      negativePrompt: 'blurry',
      moduleId: 'neon-pulse',
      videoModelId: 'wan-2.1-t2v-1.3b',
      seedMode: 'fixed',
      seed: 1234,
      settings: { duration: 2, fps: 12, resolution: '720x1280', quality: 'draft', motion: 30, captionStrength: 40 },
    }),
  });
  assert.equal(presetResponse.status, 201);
  const preset = await presetResponse.json();
  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('#presetSelect option').length === 10);
    await page.select('#presetSelect', preset.id);
    await page.waitForSelector('#presetVariables input[data-variable="product"]');
    await page.type('#presetVariables input[data-variable="product"]', '新款耳機');
    await page.click('#applyPresetButton');
    await page.waitForFunction(() => document.querySelector('#presetStatus').textContent.startsWith('已套用'));
    const applied = await page.evaluate(() => ({
      prompt: document.querySelector('#promptInput').value,
      story: document.querySelector('#storyInput').value,
      negativePrompt: document.querySelector('#negativePromptInput').value,
      moduleId: document.querySelector('#moduleSelect').value,
      resolution: document.querySelector('#resolutionInput').value,
      fps: document.querySelector('#fpsInput').value,
      seedMode: document.querySelector('#seedModeInput').value,
      seed: document.querySelector('#seedInput').value,
      seedDisabled: document.querySelector('#seedInput').disabled,
      client: document.querySelector('#clientInput').value,
      project: document.querySelector('#projectInput').value,
      status: document.querySelector('#presetStatus').textContent,
    }));
    assert.deepEqual(applied, {
      prompt: '展示 新款耳機',
      story: '新款耳機 緩慢推近',
      negativePrompt: 'blurry',
      moduleId: 'neon-pulse',
      resolution: '720x1280',
      fps: '12',
      seedMode: 'fixed',
      seed: '1234',
      seedDisabled: false,
      client: '客戶A',
      project: '春季活動',
      status: '已套用「IG 直式」。',
    });

    await page.click('#generateButton');
    await page.waitForFunction(() => document.querySelectorAll('.video-card').length === 1, { timeout: 30_000 });
    const [stored] = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(stored.client, '客戶A');
    assert.equal(stored.project, '春季活動');
    assert.equal(stored.presetId, preset.id);
    const cardText = await page.$eval('.video-card .stats', (stats) => stats.textContent);
    assert.match(cardText, /客戶A \/ 春季活動/u);

    await page.select('#libraryClientFilter', '客戶A');
    assert.equal(await page.$$eval('.video-card', (cards) => cards.length), 1);
    const filterOptions = await page.$$eval('#libraryProjectFilter option', (options) => options.map((option) => option.value));
    assert.deepEqual(filterOptions, ['', '春季活動']);

    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#createDeliveryButton');
    await page.waitForFunction(() => document.querySelector('#deliveryStatus').textContent.includes('已建立交付資料夾（1 部影片）'));
    const deliveryRoot = path.join(managedOutputDir, 'deliveries', '客戶A', '春季活動');
    const [deliveryFolder] = await fs.readdir(deliveryRoot);
    const deliveryManifest = JSON.parse(await fs.readFile(path.join(deliveryRoot, deliveryFolder, 'manifest.json'), 'utf8'));
    assert.equal(deliveryManifest.items[0].fileName, stored.fileName);
    assert.equal(deliveryManifest.items[0].reproduction.type, 'canvas');

    const pageScreenshotPath = path.join(outputDir, 'preset-page.png');
    await page.screenshot({ path: pageScreenshotPath, fullPage: true });
    return { presetId: preset.id, applied, pageScreenshotPath };
  } finally {
    await page.close();
  }
}

async function runWorkflowScenario(browser, origin, managedOutputDir) {
  await resetDirectory(managedOutputDir);
  const jobsDir = path.join(managedOutputDir, 'inference-jobs');
  await fs.mkdir(jobsDir);
  await fs.writeFile(path.join(jobsDir, 'failed-job.json'), JSON.stringify({
    id: 'job-failed-1',
    status: 'failed',
    createdAt: '2026-10-22T01:00:00.000Z',
    prompt: '佇列面板測試',
    seed: 77,
    client: '客戶Q',
    project: '佇列',
    workflowId: 'z-wan',
    batchId: 'abcdef12-0000-4000-8000-000000000000',
    batchIndex: 0,
    error: 'ComfyUI 工作失敗：error',
    comfyPromptId: 'p-1',
    submittedWorkflow: { '1': { class_type: 'X', inputs: {} } },
  }));
  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('#jobsTableBody tr').length === 1);
    const jobRow = await page.$eval('#jobsTableBody tr', (row) => row.textContent);
    for (const expected of ['失敗', '客戶Q / 佇列', '佇列面板測試', '77', 'z-wan', 'abcdef12 #1', '以相同設定重跑']) {
      assert.ok(jobRow.includes(expected), `queue row should include ${expected}: ${jobRow}`);
    }
    await page.select('#jobStatusFilter', 'active');
    assert.equal(await page.$eval('#jobsTable', (table) => table.hidden), true);
    assert.equal(await page.$eval('#jobsEmpty', (empty) => empty.textContent), '沒有符合篩選條件的工作。');
    await page.waitForFunction(() => document.querySelectorAll('#workflowSelect option').length === 10);
    const optionValues = (selector) => page.$$eval(`${selector} option`, (options) => options.map((option) => option.value));
    assert.equal(await page.$eval('#workflowSelect', (select) => select.value), 'a-open');
    assert.ok((await optionValues('#resolutionInput')).includes('custom'));

    // Civitai section: a non-Civitai link is refused before anything is downloaded.
    await page.type('#civitaiUrlInput', 'https://evil.example/models/1');
    await page.click('#civitaiPreviewButton');
    await page.waitForFunction(() => document.querySelector('#civitaiStatus').textContent.includes('查詢失敗'));
    assert.equal(await page.$eval('#civitaiInstallButton', (button) => button.disabled), true);

    await page.select('#workflowSelect', 'z-wan');
    assert.deepEqual(await optionValues('#resolutionInput'), ['832x480']);
    assert.deepEqual(await optionValues('#fpsInput'), ['16']);
    assert.equal(await page.$eval('#durationInput', (input) => input.max), '4');
    assert.match(await page.$eval('#capabilityHint', (hint) => hint.textContent), /不支援自訂解析度/);
    assert.match(await page.$eval('#workflowSelect', (select) => select.selectedOptions[0].textContent), /Wan 原生測試/);
    assert.match(await page.$eval('#workflowDetails', (details) => details.textContent), /z-wan.json/);

    await page.select('#workflowSelect', 'a-open');
    await page.select('#resolutionInput', 'custom');
    assert.equal(await page.$eval('#customResolutionFields', (fields) => fields.hidden), false);
    await page.$eval('#customWidthInput', (input) => { input.value = '1000'; });
    await page.$eval('#customHeightInput', (input) => { input.value = '600'; });
    await page.$eval('#durationInput', (input) => { input.value = '2'; });
    await page.type('#promptInput', '自訂解析度測試');
    await page.click('#generateButton');
    await page.waitForFunction(() => document.querySelectorAll('.video-card').length === 1, { timeout: 30_000 });
    const [stored] = await fetch(`${origin}/api/videos`).then((response) => response.json());
    assert.equal(stored.resolution, '1000x600');
    assert.equal(stored.width, 1000);
    assert.equal(stored.height, 600);

    await page.$eval('#customWidthInput', (input) => { input.value = '1001'; });
    await page.click('#generateButton');
    assert.equal(await page.$eval('#customWidthInput', (input) => input.validity.valid), false);
    assert.equal(await page.$$eval('.video-card', (cards) => cards.length), 1);
    return { customResolution: stored.resolution };
  } finally {
    await page.close();
  }
}

const SCENARIO_MODULES = [
  { id: 'dance', resolution: '1280x704', variable: 'person' },
  { id: 'runway', resolution: '704x1280', variable: 'person' },
  { id: 'gym', resolution: '1280x704', variable: 'person' },
];

// Samples two frames of a stored video in the page and reports brightness and how much the picture changed.
async function measureVideoMotion(page, previewUrl) {
  return page.evaluate(async (url) => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('video load failed')), { once: true });
    });
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = Math.round((160 * video.videoHeight) / video.videoWidth);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const grab = async (time) => {
      video.currentTime = time;
      await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const first = await grab(0.2);
    const second = await grab(1.4);
    let brightness = 0;
    let difference = 0;
    for (let index = 0; index < first.length; index += 4) {
      brightness += (second[index] + second[index + 1] + second[index + 2]) / 3;
      difference += Math.abs(first[index] - second[index]) + Math.abs(first[index + 1] - second[index + 1]);
    }
    const pixels = first.length / 4;
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      brightness: brightness / pixels,
      difference: difference / pixels,
    };
  }, previewUrl);
}

async function runScenarioModulesScenario(browser, origin, managedOutputDir) {
  await resetDirectory(managedOutputDir);
  const page = await browser.newPage();
  const results = [];
  try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => ['scenario-dance', 'scenario-runway', 'scenario-gym']
      .every((id) => [...document.querySelectorAll('#moduleSelect option')].some((option) => option.value === id)));
    for (const [index, scenario] of SCENARIO_MODULES.entries()) {
      await page.select('#presetSelect', `module:${scenario.id}`);
      await page.waitForSelector(`#presetVariables input[data-variable="${scenario.variable}"]`);
      const prefilled = await page.$eval(`#presetVariables input[data-variable="${scenario.variable}"]`, (input) => input.value);
      assert.ok(prefilled.length > 0, `${scenario.id} example variables should prefill`);
      assert.equal(await page.$eval('#updatePresetButton', (button) => button.disabled), true);
      if (scenario.id === 'dance') {
        // 下拉選單欄位：選「自訂…」後文字框出現，自訂內容會進入提示詞。
        assert.equal(await page.$eval('#presetVariables select[data-variable="danceStyle"]', (select) => select.value), '街舞');
        assert.equal(await page.$eval('#presetVariables [data-variable-custom="danceStyle"]', (input) => input.hidden), true);
        await page.select('#presetVariables select[data-variable="danceStyle"]', '__custom__');
        assert.equal(await page.$eval('#presetVariables [data-variable-custom="danceStyle"]', (input) => input.hidden), false);
        await page.type('#presetVariables [data-variable-custom="danceStyle"]', '霹靂舞');
        await page.select('#presetVariables select[data-variable="camera"]', '中景半身');
      }
      await page.click('#applyPresetButton');
      await page.waitForFunction(() => document.querySelector('#presetStatus').textContent.startsWith('已套用'));
      const applied = await page.evaluate(() => ({
        moduleId: document.querySelector('#moduleSelect').value,
        workflowId: document.querySelector('#workflowSelect').value,
        resolution: document.querySelector('#resolutionInput').value,
        prompt: document.querySelector('#promptInput').value,
        status: document.querySelector('#presetStatus').textContent,
      }));
      assert.equal(applied.moduleId, `scenario-${scenario.id}`);
      assert.equal(applied.workflowId, `module-${scenario.id}`);
      assert.equal(applied.resolution, scenario.resolution);
      assert.ok(applied.prompt.includes(prefilled), applied.prompt);
      if (scenario.id === 'dance') {
        assert.ok(applied.prompt.includes('跳霹靂舞') && applied.prompt.startsWith('中景半身'), applied.prompt);
      }
      assert.equal(applied.status.includes('尚未填入'), false, applied.status);

      await page.$eval('#durationInput', (input) => { input.value = '2'; });
      await page.click('#generateButton');
      await page.waitForFunction((count) => document.querySelectorAll('.video-card').length === count, { timeout: 30_000 }, index + 1).catch(async (error) => {
        console.error('除錯', scenario.id, await page.$eval('#generationStatus', (status) => status.textContent), await page.evaluate(() => [...document.querySelectorAll('#generationForm :invalid')].map((el) => `${el.id}=${el.value} ${el.validationMessage}`)));
        throw error;
      });
      const stored = (await fetch(`${origin}/api/videos`).then((response) => response.json()))
        .find((item) => item.moduleId === `scenario-${scenario.id}`);
      assert.ok(stored, `${scenario.id} video should be stored`);
      assert.equal(stored.presetId, `module:${scenario.id}`);
      const motion = await measureVideoMotion(page, `${origin}${stored.previewUrl}`);
      assert.equal(`${motion.width}x${motion.height}`, scenario.resolution);
      assert.ok(motion.brightness > 12, `${scenario.id} video should not be black: ${JSON.stringify(motion)}`);
      assert.ok(motion.difference > 2, `${scenario.id} video should show motion: ${JSON.stringify(motion)}`);
      results.push({ id: scenario.id, fileName: stored.fileName, ...motion });
    }
    const pageScreenshotPath = path.join(outputDir, 'scenario-modules-page.png');
    await page.screenshot({ path: pageScreenshotPath, fullPage: true });
    return { results, pageScreenshotPath };
  } finally {
    await page.close();
  }
}

async function main() {
  await ensureFixtures();
  const managedOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-visual-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vediofactory-visual-data-'));
  const workflowsDir = path.join(dataDir, 'workflows');
  await fs.mkdir(workflowsDir);
  const sampleWorkflow = JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } });
  await fs.writeFile(path.join(workflowsDir, 'a-open.json'), sampleWorkflow);
  await fs.writeFile(path.join(workflowsDir, 'z-wan.json'), sampleWorkflow);
  await fs.writeFile(path.join(workflowsDir, 'z-wan.vf.json'), JSON.stringify({
    name: 'Wan 原生測試',
    resolutions: ['832x480'],
    allowCustomResolution: false,
    fps: [16],
    maxDuration: 4,
    defaults: { duration: 2 },
  }));
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    outputDir: managedOutputDir,
    dataDir,
    workflowsDir,
    modulesDir: path.join(repoRoot, 'modules'),
    comfyUIWorkflowPath: '',
  });
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
    const presetResult = await runPresetScenario(browser, origin, managedOutputDir);
    const workflowResult = await runWorkflowScenario(browser, origin, managedOutputDir);
    const scenarioModulesResult = await runScenarioModulesScenario(browser, origin, managedOutputDir);

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
      workflowScenario: workflowResult,
      scenarioModules: {
        results: scenarioModulesResult.results,
        pageScreenshotPath: path.relative(repoRoot, scenarioModulesResult.pageScreenshotPath),
      },
      presetScenario: {
        ...presetResult,
        pageScreenshotPath: path.relative(repoRoot, presetResult.pageScreenshotPath),
      },
    };

    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(managedOutputDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
