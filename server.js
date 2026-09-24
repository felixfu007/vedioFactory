const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const ROOT_DIR = __dirname;
const DEFAULT_OUTPUT_DIR = path.resolve(
  process.env.VEDIO_FACTORY_OUTPUT_DIR || path.join(os.homedir(), 'Videos', 'vedioFactory'),
);
const MAX_JSON_BODY = 80 * 1024 * 1024;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(payload);
}

function getContentType(filePath) {
  return contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function normalizeOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new Error('請提供輸出資料夾路徑。');
  }

  const resolved = path.resolve(outputDir.trim());
  if (!path.isAbsolute(resolved)) {
    throw new Error('輸出資料夾必須是絕對路徑。');
  }

  return resolved;
}

function sanitizeFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('缺少檔名。');
  }

  const normalized = path.basename(fileName.trim()).replace(/[\\/]+/g, '');
  if (!normalized.endsWith('.webm')) {
    throw new Error('影片檔名必須以 .webm 結尾。');
  }

  return normalized;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) {
      throw new Error('請求內容過大。');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON 格式錯誤。');
  }
}

async function collectVideoItems(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.webm.json')) continue;
    const metadataPath = path.join(outputDir, entry.name);
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const fileName = sanitizeFileName(metadata.fileName || entry.name.replace(/\.json$/u, ''));
    const videoPath = path.join(outputDir, fileName);
    const stats = await fs.stat(videoPath);
    items.push({
      ...metadata,
      fileName,
      fileSize: stats.size,
      previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
    });
  }

  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return items;
}

function createApp(options = {}) {
  let outputDir = normalizeOutputDir(options.outputDir || DEFAULT_OUTPUT_DIR);

  async function ensureOutputDir() {
    await fs.mkdir(outputDir, { recursive: true });
  }

  async function saveVideoAsset(item, videoBase64) {
    const fileName = sanitizeFileName(item.fileName);
    const videoPath = path.join(outputDir, fileName);
    const metadataPath = path.join(outputDir, `${fileName}.json`);
    const buffer = Buffer.from(videoBase64, 'base64');
    const persistedItem = {
      ...item,
      fileName,
    };

    await ensureOutputDir();
    await fs.writeFile(videoPath, buffer);
    await fs.writeFile(metadataPath, JSON.stringify(persistedItem, null, 2));

    return {
      ...persistedItem,
      fileSize: buffer.length,
      previewUrl: `/api/videos/${encodeURIComponent(fileName)}`,
    };
  }

  async function handleApi(request, response, requestUrl) {
    if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, { ok: true });
    }

    if (requestUrl.pathname === '/api/config' && request.method === 'GET') {
      await ensureOutputDir();
      return sendJson(response, 200, {
        backendAvailable: true,
        outputDir,
        storageMode: 'backend',
        localGpuPreferred: true,
      });
    }

    if (requestUrl.pathname === '/api/config/output-dir' && request.method === 'POST') {
      const body = await readJsonBody(request);
      outputDir = normalizeOutputDir(body.outputDir || outputDir);
      await ensureOutputDir();
      return sendJson(response, 200, {
        ok: true,
        outputDir,
        items: await collectVideoItems(outputDir),
      });
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'GET') {
      return sendJson(response, 200, await collectVideoItems(outputDir));
    }

    if (requestUrl.pathname === '/api/videos' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.item || typeof body.videoBase64 !== 'string') {
        throw new Error('缺少影片資料。');
      }
      return sendJson(response, 201, await saveVideoAsset(body.item, body.videoBase64));
    }

    if (requestUrl.pathname.startsWith('/api/videos/')) {
      const encodedName = requestUrl.pathname.slice('/api/videos/'.length);
      const fileName = sanitizeFileName(decodeURIComponent(encodedName));
      const videoPath = path.join(outputDir, fileName);
      const metadataPath = path.join(outputDir, `${fileName}.json`);

      if (request.method === 'GET') {
        if (!(await fileExists(videoPath))) {
          return sendText(response, 404, 'Not found');
        }
        const headers = { 'content-type': 'video/webm' };
        if (requestUrl.searchParams.get('download') === '1') {
          headers['content-disposition'] = `attachment; filename="${encodeURIComponent(fileName)}"`;
        }
        response.writeHead(200, headers);
        response.end(await fs.readFile(videoPath));
        return;
      }

      if (request.method === 'PATCH') {
        const body = await readJsonBody(request);
        const nextFileName = sanitizeFileName(body.nextFileName);
        const nextVideoPath = path.join(outputDir, nextFileName);
        const nextMetadataPath = path.join(outputDir, `${nextFileName}.json`);
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        metadata.fileName = nextFileName;
        metadata.updatedAt = new Date().toISOString();
        await fs.rename(videoPath, nextVideoPath);
        await fs.rename(metadataPath, nextMetadataPath).catch(async () => {
          await fs.writeFile(nextMetadataPath, JSON.stringify(metadata, null, 2));
          await fs.rm(metadataPath, { force: true });
        });
        await fs.writeFile(nextMetadataPath, JSON.stringify(metadata, null, 2));
        return sendJson(response, 200, {
          ...metadata,
          previewUrl: `/api/videos/${encodeURIComponent(nextFileName)}`,
        });
      }

      if (request.method === 'DELETE') {
        await fs.rm(videoPath, { force: true });
        await fs.rm(metadataPath, { force: true });
        return sendJson(response, 200, { ok: true });
      }
    }

    return false;
  }

  async function handleStatic(request, response, requestUrl) {
    const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    const targetPath = path.normalize(path.join(ROOT_DIR, pathname));
    if (!targetPath.startsWith(ROOT_DIR)) {
      sendText(response, 403, 'Forbidden');
      return;
    }

    try {
      const stats = await fs.stat(targetPath);
      if (stats.isDirectory()) {
        sendText(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, { 'content-type': getContentType(targetPath) });
      response.end(await fs.readFile(targetPath));
    } catch {
      sendText(response, 404, 'Not found');
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
      if (requestUrl.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, requestUrl);
        if (handled === false) {
          sendText(response, 404, 'Not found');
        }
        return;
      }

      await handleStatic(request, response, requestUrl);
    } catch (error) {
      sendJson(response, 400, { error: error.message || 'Request failed' });
    }
  });

  return {
    server,
    getOutputDir: () => outputDir,
    setOutputDir(nextOutputDir) {
      outputDir = normalizeOutputDir(nextOutputDir);
      return outputDir;
    },
  };
}

async function startServer(options = {}) {
  const app = createApp(options);
  await fs.mkdir(app.getOutputDir(), { recursive: true });
  await new Promise((resolve) => app.server.listen(options.port || PORT, options.host || HOST, resolve));
  return app;
}

if (require.main === module) {
  startServer().then((app) => {
    const address = app.server.address();
    console.log(`vedioFactory server running at http://${address.address}:${address.port}`);
    console.log(`output directory: ${app.getOutputDir()}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  startServer,
  DEFAULT_OUTPUT_DIR,
};
