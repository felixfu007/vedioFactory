import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outputDir = path.join(repoRoot, 'visual-output');
const sampleSvgPath = path.join(outputDir, 'verification-source.svg');
const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';

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

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  })[extension] || 'application/octet-stream';
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

async function createStaticServer(rootDir) {
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
      const targetPath = path.join(rootDir, pathname);
      const normalizedPath = path.normalize(targetPath);

      if (!normalizedPath.startsWith(rootDir)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }

      const payload = await fs.readFile(normalizedPath);
      response.writeHead(200, { 'content-type': getContentType(normalizedPath) });
      response.end(payload);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function saveDataUrl(targetPath, dataUrl) {
  const [, base64Payload] = dataUrl.split(',');
  await fs.writeFile(targetPath, Buffer.from(base64Payload, 'base64'));
}

async function runScenario(browser, origin, scenario) {
  const page = await browser.newPage();

  try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });

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

    const verification = await page.evaluate(async () => {
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

      const video = document.querySelector('.video-card video');
      const item = window.VedioFactory.getLibrarySnapshot()[0];
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
      };
    });

    const actualFramePath = path.join(outputDir, `${scenario.name}-frame-actual.png`);
    const referenceFramePath = path.join(outputDir, `${scenario.name}-frame-reference.png`);
    await saveDataUrl(actualFramePath, verification.actualFrame);
    await saveDataUrl(referenceFramePath, verification.referenceFrame);

    assert.equal(verification.item.moduleId, scenario.moduleId);
    assert.equal(verification.item.prompt, scenario.prompt);
    assert.equal(verification.item.story, scenario.story);
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

async function main() {
  await ensureFixtures();
  const { server, origin } = await createStaticServer(repoRoot);

  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const results = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(browser, origin, scenario));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      origin,
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
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
