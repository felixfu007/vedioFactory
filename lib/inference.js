const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { BASE_CAPABILITIES } = require('../assets/capabilities.js');
const { INFERENCE_JOBS_DIR_NAME, SOURCE_IMAGES_DIR_NAME } = require('./config.js');
const { getInferenceRuntime } = require('./runtime.js');
const { samePath } = require('./workflows.js');
const {
  createRequestError,
  fileExists,
  isPlainObject,
  sha256,
} = require('./utils.js');
const {
  VIDEO_EXTENSION_PATTERN,
  readWorkflowId,
  sanitizeFileName,
  sanitizePathSegment,
  validateInferencePayload,
  validateSeed,
} = require('./validation.js');

const SOURCE_IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_BATCH_JOBS = 50;
const MAX_BATCH_SEED_COUNT = 10;

// ComfyUI 推論工作：建立、批次、狀態更新、取消與以快照重跑。工作記錄存在輸出資料夾的 inference-jobs。
function createInferenceService({ getOutputDir, comfyUI, comfy, workflows }) {
  const { requestComfyUI, uploadComfySourceImage, submitComfyWorkflow, getComfyUIVersion } = comfy;
  const { resolveWorkflow, loadComfyWorkflow, inspectComfyWorkflow, listWorkflows } = workflows;
  const inferenceRefreshes = new Map();

  async function ensureOutputDir() {
    await fs.mkdir(getOutputDir(), { recursive: true });
  }

  async function ensureInferenceJobDir() {
    await fs.mkdir(path.join(getOutputDir(), INFERENCE_JOBS_DIR_NAME), { recursive: true });
  }

  function getSourceImagesDir() {
    return path.join(getOutputDir(), INFERENCE_JOBS_DIR_NAME, SOURCE_IMAGES_DIR_NAME);
  }

  async function storeSourceImage(dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/iu.exec(dataUrl);
    if (!match) throw createRequestError('來源圖片僅支援 PNG、JPEG 或 WebP。', 400);
    const image = Buffer.from(match[2], 'base64');
    if (!image.length || image.length > 20 * 1024 * 1024) {
      throw createRequestError('來源圖片不得為空或超過 20 MB。', 400);
    }
    const mimeType = match[1].toLowerCase();
    const extension = SOURCE_IMAGE_EXTENSIONS[mimeType];
    const imageSha256 = sha256(image);
    const fileName = `${imageSha256}.${extension}`;
    const imagePath = path.join(getSourceImagesDir(), fileName);
    if (!(await fileExists(imagePath))) {
      await fs.mkdir(getSourceImagesDir(), { recursive: true });
      const temporaryPath = `${imagePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, image);
      await fs.rename(temporaryPath, imagePath);
    }
    return { image, mimeType, extension, sha256: imageSha256, fileName };
  }

  async function loadStoredSourceImage(fileName) {
    const match = /^([a-f\d]{64})\.(png|jpg|webp)$/u.exec(String(fileName || ''));
    if (!match) throw createRequestError('工作記錄的來源圖片檔名無效。', 409);
    const image = await fs.readFile(path.join(getSourceImagesDir(), fileName)).catch(() => null);
    if (!image || sha256(image) !== match[1]) {
      throw createRequestError('找不到原工作的來源圖片快照或內容已變更，無法重現。', 409);
    }
    const mimeType = Object.keys(SOURCE_IMAGE_EXTENSIONS).find((type) => SOURCE_IMAGE_EXTENSIONS[type] === match[2]);
    return { image, mimeType, extension: match[2], sha256: match[1], fileName };
  }

  function applyWorkflowVariables(value, variables) {
    if (typeof value === 'string') {
      const exactMatch = /^\{\{([^{}]+)\}\}$/u.exec(value);
      const exactKey = exactMatch?.[1].trim();
      if (exactMatch && Object.hasOwn(variables, exactKey)) return variables[exactKey];
      return value.replace(/\{\{([^{}]+)\}\}/gu, (token, rawKey) => {
        const key = rawKey.trim();
        return Object.hasOwn(variables, key) ? String(variables[key]) : token;
      });
    }
    if (Array.isArray(value)) return value.map((item) => applyWorkflowVariables(item, variables));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        applyWorkflowVariables(item, variables),
      ]));
    }
    return value;
  }

  async function persistInferenceJob(job) {
    const temporaryPath = `${job.manifestPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(job, null, 2));
    await fs.rename(temporaryPath, job.manifestPath);
  }

  async function saveComfyVideoOutputs(job, historyEntry) {
    const videos = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        if (typeof value.filename === 'string' && VIDEO_EXTENSION_PATTERN.test(value.filename)) videos.push(value);
        Object.values(value).forEach(visit);
      }
    };
    visit(historyEntry.outputs || {});
    const uniqueVideos = [...new Map(videos.map((video) => [
      `${video.type || 'output'}:${video.subfolder || ''}:${video.filename}`,
      video,
    ])).values()];
    const savedFiles = [];

    for (const [index, video] of uniqueVideos.entries()) {
      const query = new URLSearchParams({
        filename: video.filename,
        subfolder: video.subfolder || '',
        type: video.type || 'output',
      });
      const response = await requestComfyUI(`/view?${query}`, {
        signal: AbortSignal.timeout(120_000),
      });
      const extension = path.extname(video.filename).toLowerCase();
      const fileName = sanitizeFileName(`comfyui-${job.id.slice(0, 8)}-${index + 1}${extension}`);
      const videoPath = path.join(getOutputDir(), fileName);
      const temporaryPath = `${videoPath}.${crypto.randomUUID()}.tmp`;
      let stats;
      try {
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > 2 * 1024 * 1024 * 1024) {
          throw createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413);
        }
        let bytesWritten = 0;
        const sizeLimit = new Transform({
          transform(chunk, encoding, callback) {
            bytesWritten += chunk.length;
            if (bytesWritten > 2 * 1024 * 1024 * 1024) {
              callback(createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413));
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          sizeLimit,
          createWriteStream(temporaryPath, { flags: 'wx' }),
        );
        stats = await fs.stat(temporaryPath);
        if (stats.size > 2 * 1024 * 1024 * 1024) {
          throw createRequestError('ComfyUI 輸出影片超過 2 GB 上限。', 413);
        }
        await fs.rename(temporaryPath, videoPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
      const resolution = job.settings.resolution || '1280x720';
      const [width, height] = resolution.split('x').map(Number);
      const metadata = {
        id: crypto.randomUUID(),
        fileName,
        moduleId: job.moduleId,
        moduleName: 'ComfyUI',
        prompt: job.prompt,
        story: job.story,
        negativePrompt: job.negativePrompt || '',
        seed: job.seed,
        videoModelId: job.videoModelId,
        workflowSha256: job.workflowSha256,
        client: job.client || '',
        project: job.project || '',
        presetId: job.presetId || '',
        duration: Number(job.settings.duration) || 0,
        fps: Number(job.settings.fps) || 24,
        resolution,
        width,
        height,
        quality: job.settings.quality || 'balanced',
        motion: Number(job.settings.motion) || 0,
        captionStrength: Number(job.settings.captionStrength) || 0,
        createdAt: new Date().toISOString(),
        inferenceJobId: job.id,
      };
      await fs.writeFile(path.join(getOutputDir(), `${fileName}.json`), JSON.stringify(metadata, null, 2));
      savedFiles.push({ fileName, fileSize: stats.size, previewUrl: `/api/videos/${encodeURIComponent(fileName)}` });
    }
    return savedFiles;
  }

  async function refreshComfyInferenceJob(job) {
    if (!job.comfyPromptId || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    const [historyResponse, queueResponse] = await Promise.all([
      requestComfyUI(`/history/${encodeURIComponent(job.comfyPromptId)}`),
      requestComfyUI('/queue'),
    ]);
    const history = await historyResponse.json();
    const queue = await queueResponse.json();
    const historyEntry = history[job.comfyPromptId];
    if (historyEntry) {
      const status = historyEntry.status || {};
      if (status.completed) {
        const statusText = String(status.status_str || '').toLowerCase();
        if (statusText !== 'success') {
          job.status = 'failed';
          job.error = `ComfyUI 工作失敗：${statusText || '未知錯誤'}`;
        } else {
          job.outputs = await saveComfyVideoOutputs(job, historyEntry);
          job.status = 'succeeded';
          if (!job.outputs.length) {
            job.guidance = 'ComfyUI 工作已完成，但未找到 WebM/MP4/GIF/WebP 輸出；請確認工作流使用影片輸出節點。';
          }
        }
      } else {
        job.status = 'running';
      }
    } else {
      const entries = [...(queue.queue_running || []), ...(queue.queue_pending || [])];
      const queued = entries.some((entry) => Array.isArray(entry) && entry[1] === job.comfyPromptId);
      job.status = queued && (queue.queue_running || []).some(
        (entry) => Array.isArray(entry) && entry[1] === job.comfyPromptId,
      ) ? 'running' : 'queued';
    }
    job.updatedAt = new Date().toISOString();
    await persistInferenceJob(job);
    return job;
  }

  async function listInferenceJobs() {
    await ensureInferenceJobDir();
    const jobsDir = path.join(getOutputDir(), INFERENCE_JOBS_DIR_NAME);
    const entries = await fs.readdir(jobsDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(await fs.readFile(path.join(jobsDir, entry.name), 'utf8'));
        jobs.push(payload);
      } catch {
        continue;
      }
    }
    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return jobs;
  }

  async function refreshJobOnce(job) {
    if (!inferenceRefreshes.has(job.id)) {
      inferenceRefreshes.set(job.id, refreshComfyInferenceJob(job));
    }
    try {
      return await inferenceRefreshes.get(job.id);
    } finally {
      inferenceRefreshes.delete(job.id);
    }
  }

  async function getInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    const job = jobs.find((item) => item.id === jobId) || null;
    if (!job?.comfyPromptId) return job;
    return refreshJobOnce(job);
  }

  async function listInferenceJobSummaries({ refresh = false, limit = Infinity } = {}) {
    const jobs = (await listInferenceJobs()).slice(0, limit);
    const summaries = [];
    for (const job of jobs) {
      if (!refresh || !job.comfyPromptId || !['queued', 'running'].includes(job.status)) {
        summaries.push(summarizeJob(job));
        continue;
      }
      try {
        summaries.push(summarizeJob(await refreshJobOnce(job)));
      } catch (error) {
        summaries.push({ ...summarizeJob(job), refreshError: error.message });
      }
    }
    return summaries;
  }

  async function cancelInferenceJob(jobId) {
    const job = await getInferenceJob(jobId);
    if (!job) throw createRequestError('找不到推論工作。', 404);
    if (!job.comfyPromptId) throw createRequestError('此工作尚未提交至 ComfyUI。', 409);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      throw createRequestError(`工作已是終止狀態：${job.status}。`, 409);
    }

    const queueResponse = await requestComfyUI('/queue');
    const queue = await queueResponse.json();
    const promptId = job.comfyPromptId;
    if ((queue.queue_running || []).some((entry) => Array.isArray(entry) && entry[1] === promptId)) {
      throw createRequestError('工作已開始執行。ComfyUI 的 interrupt 會中斷全域執行，因此不會由此操作取消。', 409);
    }
    const isPending = (queue.queue_pending || []).some((entry) => Array.isArray(entry) && entry[1] === promptId);
    if (!isPending) {
      throw createRequestError('工作已不在待執行佇列中，請重新整理工作狀態後再試。', 409);
    }

    await requestComfyUI('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    job.guidance = '已從 ComfyUI 待執行佇列移除。';
    await persistInferenceJob(job);
    return job;
  }

  function summarizeJob(job) {
    const { submittedWorkflow, workflowPreflight, ...summary } = job;
    return { ...summary, hasWorkflowSnapshot: Boolean(submittedWorkflow) };
  }

  async function createInferenceBatch(payload) {
    if (!isPlainObject(payload)) throw createRequestError('批次資料格式錯誤。');
    const { prompts: rawPrompts, seeds: rawSeeds, seedCount: rawSeedCount, ...basePayload } = payload;
    if (rawPrompts !== undefined && (!Array.isArray(rawPrompts) || rawPrompts.some((item) => typeof item !== 'string'))) {
      throw createRequestError('prompts 必須是字串陣列。');
    }
    const cleanedPrompts = (rawPrompts || []).map((item) => item.trim()).filter(Boolean);
    const prompts = cleanedPrompts.length ? cleanedPrompts : [typeof basePayload.prompt === 'string' ? basePayload.prompt : ''];

    let seeds;
    if (rawSeeds !== undefined) {
      if (!Array.isArray(rawSeeds) || !rawSeeds.length || rawSeeds.length > MAX_BATCH_SEED_COUNT) {
        throw createRequestError(`seeds 必須是 1 至 ${MAX_BATCH_SEED_COUNT} 個 seed 的陣列。`);
      }
      seeds = rawSeeds.map(validateSeed);
    } else {
      const seedCount = rawSeedCount === undefined ? 1 : Number(rawSeedCount);
      if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > MAX_BATCH_SEED_COUNT) {
        throw createRequestError(`seedCount 必須介於 1 至 ${MAX_BATCH_SEED_COUNT}。`);
      }
      const hasBaseSeed = basePayload.seed !== undefined && basePayload.seed !== null && basePayload.seed !== '';
      // A fixed base seed expands to seed, seed+1, …; otherwise every job draws its own random seed.
      seeds = Array.from({ length: seedCount }, (_, index) => (
        hasBaseSeed ? validateSeed(validateSeed(basePayload.seed) + index) : undefined
      ));
    }
    const total = prompts.length * seeds.length;
    if (total > MAX_BATCH_JOBS) {
      throw createRequestError(`批次最多 ${MAX_BATCH_JOBS} 個工作（目前 ${prompts.length} 個提示詞 × ${seeds.length} 個 seed）。`);
    }

    const batchId = crypto.randomUUID();
    const jobs = [];
    const errors = [];
    let batchIndex = 0;
    for (const prompt of prompts) {
      for (const seed of seeds) {
        const index = batchIndex;
        batchIndex += 1;
        try {
          const job = await createInferenceJob({ ...basePayload, prompt, seed }, { batchId, batchIndex: index });
          jobs.push(summarizeJob(job));
        } catch (error) {
          errors.push({ index, prompt, seed: seed ?? null, statusCode: error.statusCode || 500, error: error.message });
        }
      }
    }
    if (!jobs.length) {
      throw createRequestError(`批次中所有工作都建立失敗：${errors[0]?.error || '未知錯誤'}`, errors[0]?.statusCode || 400);
    }
    return { batchId, total, created: jobs.length, jobs, errors };
  }

  async function createInferenceJob(payload, batch = null) {
    await ensureOutputDir();
    await ensureInferenceJobDir();

    const workflowEntry = await resolveWorkflow(readWorkflowId(isPlainObject(payload) ? payload : {}));
    if (workflowEntry?.error) throw createRequestError(workflowEntry.error);
    const inference = validateInferencePayload(payload, workflowEntry?.capabilities || BASE_CAPABILITIES);
    if (payload.personConsent !== undefined && typeof payload.personConsent !== 'boolean') {
      throw createRequestError('personConsent 必須是 true 或 false。');
    }
    const personConsent = Boolean(inference.sourceImageDataUrl) && payload.personConsent === true;
    if (workflowEntry?.requiresPersonConsent && inference.sourceImageDataUrl && !personConsent) {
      throw createRequestError('此場景模組使用真人照片，必須先確認已取得照片中人物的同意（personConsent: true）。');
    }
    const runtime = await getInferenceRuntime(getOutputDir(), comfyUI, workflowEntry ? [workflowEntry] : []);
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: 'scaffolded',
      provider: 'comfyui-local',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: inference.prompt,
      story: inference.story,
      negativePrompt: inference.negativePrompt,
      seed: inference.seed,
      seedMode: inference.seedMode,
      client: inference.client,
      project: inference.project,
      presetId: inference.presetId,
      ...(batch ? { batchId: batch.batchId, batchIndex: batch.batchIndex } : {}),
      moduleId: inference.moduleId,
      videoModelId: inference.videoModelId,
      settings: inference.settings,
      sourceImageAttached: Boolean(inference.sourceImageDataUrl),
      // Kept with the job (and therefore in delivery manifests) as the record of who-confirmed-when.
      ...(personConsent ? { personConsent: { confirmed: true, confirmedAt: new Date().toISOString() } } : {}),
      modelDir: runtime.modelDir,
      workflowConfigured: runtime.workflowConfigured,
      comfyUIUrl: comfyUI.baseUrl,
      guidance: '請設定 ComfyUI API 工作流 JSON；工作流需使用 {{prompt}} 等佔位符，並輸出 WebM 影片。',
      manifestPath: path.join(
        getOutputDir(),
        INFERENCE_JOBS_DIR_NAME,
        `${Date.now()}-${jobId}-${sanitizePathSegment(payload.moduleId, 'job')}.json`,
      ),
    };

    if (workflowEntry) {
      if (!runtime.comfyUI.available) {
        throw createRequestError('無法連線至本機 ComfyUI，請確認服務已啟動。', 503);
      }
      const { workflow, workflowSha256 } = await loadComfyWorkflow(workflowEntry);
      const preflight = inspectComfyWorkflow(
        workflow,
        inference.videoModelId,
        Boolean(inference.sourceImageDataUrl),
        workflowEntry,
      );
      if (!preflight.ready) {
        throw createRequestError(`ComfyUI 工作流預檢失敗：${preflight.errors.join(' ')}`);
      }
      job.workflowPreflight = preflight;
      job.workflowId = workflowEntry.id;
      job.workflowPath = workflowEntry.workflowPath;
      job.workflowSha256 = workflowSha256;
      let sourceImage = '';
      if (inference.sourceImageDataUrl) {
        const source = await storeSourceImage(inference.sourceImageDataUrl);
        sourceImage = await uploadComfySourceImage(source);
        job.sourceImage = { fileName: source.fileName, sha256: source.sha256, comfyName: sourceImage };
      }
      const resolution = String(job.settings.resolution || '1280x720').split('x').map(Number);
      const variables = {
        prompt: job.prompt || job.story,
        model_id: inference.videoModelId,
        story: job.story,
        negative_prompt: job.negativePrompt,
        seed: job.seed,
        width: resolution[0],
        height: resolution[1],
        duration: Number(job.settings.duration) || 6,
        fps: Number(job.settings.fps) || 24,
        quality: job.settings.quality || 'balanced',
        motion: Number(job.settings.motion) || 0,
        caption_strength: Number(job.settings.captionStrength) || 0,
        source_image: sourceImage,
        // Wan-style video latents need 4n+1 frames.
        frames: Math.max(1, Math.round(((Number(job.settings.duration) || 6) * (Number(job.settings.fps) || 24)) / 4) * 4 + 1),
      };
      const apiWorkflow = applyWorkflowVariables(workflow, variables);
      if (/\{\{[^{}]+\}\}/u.test(JSON.stringify(apiWorkflow))) {
        throw createRequestError('工作流含有未支援的佔位符。', 400);
      }
      job.submittedWorkflow = apiWorkflow;
      job.comfyUIVersion = await getComfyUIVersion();
      const submission = await submitComfyWorkflow(apiWorkflow);
      job.comfyPromptId = submission.prompt_id;
      job.queuePosition = submission.number;
      job.status = 'queued';
      job.guidance = '已提交至本機 ComfyUI。完成後 WebM/MP4/GIF/WebP 輸出會匯入專案資料夾。';
    }

    await persistInferenceJob(job);
    return job;
  }

  async function rerunInferenceJob(jobId) {
    const jobs = await listInferenceJobs();
    const original = jobs.find((item) => item.id === jobId);
    if (!original) throw createRequestError('找不到推論工作。', 404);
    return rerunFromRecord(original);
  }

  async function rerunFromRecord(original) {
    if (!original.submittedWorkflow || typeof original.submittedWorkflow !== 'object') {
      throw createRequestError('此工作沒有保存送出的工作流快照（可能建立於舊版本），無法完整重現。', 409);
    }
    const runtime = await getInferenceRuntime(getOutputDir(), comfyUI);
    if (!runtime.comfyUI.available) {
      throw createRequestError('無法連線至本機 ComfyUI，請確認服務已啟動。', 503);
    }

    const warnings = [];
    if (original.sourceImage) {
      const source = await loadStoredSourceImage(original.sourceImage.fileName);
      const comfyName = await uploadComfySourceImage(source);
      if (comfyName !== original.sourceImage.comfyName) {
        warnings.push(`ComfyUI 回傳的來源圖片名稱（${comfyName}）與原工作不同，產出可能不一致。`);
      }
    }
    const workflows = await listWorkflows();
    const currentWorkflow = workflows.find((workflow) => (
      original.workflowId ? workflow.id === original.workflowId : samePath(workflow.workflowPath, original.workflowPath || '')
    ));
    const currentWorkflowSha256 = currentWorkflow
      ? await loadComfyWorkflow(currentWorkflow).then((loaded) => loaded.workflowSha256, () => '')
      : '';
    if (currentWorkflowSha256 !== original.workflowSha256) {
      warnings.push('目前設定的工作流已變更或無法讀取；本次使用原工作保存的工作流快照重新產出，與目前工作流的結果可能不同。');
    }
    const comfyUIVersion = await getComfyUIVersion();
    if (original.comfyUIVersion && comfyUIVersion && comfyUIVersion !== original.comfyUIVersion) {
      warnings.push(`ComfyUI 版本已由 ${original.comfyUIVersion} 變更為 ${comfyUIVersion}，產出可能不一致。`);
    }

    const submission = await submitComfyWorkflow(original.submittedWorkflow);
    const rerunJobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const job = {
      id: rerunJobId,
      status: 'queued',
      provider: original.provider,
      createdAt: now,
      updatedAt: now,
      rerunOf: original.id,
      prompt: original.prompt,
      story: original.story,
      negativePrompt: original.negativePrompt || '',
      seed: original.seed,
      seedMode: 'fixed',
      client: original.client || '',
      project: original.project || '',
      presetId: original.presetId || '',
      moduleId: original.moduleId,
      videoModelId: original.videoModelId,
      settings: original.settings,
      sourceImageAttached: original.sourceImageAttached,
      sourceImage: original.sourceImage,
      ...(original.personConsent ? { personConsent: original.personConsent } : {}),
      modelDir: runtime.modelDir,
      workflowConfigured: original.workflowConfigured,
      comfyUIUrl: comfyUI.baseUrl,
      workflowId: original.workflowId || '',
      workflowPath: original.workflowPath,
      workflowSha256: original.workflowSha256,
      submittedWorkflow: original.submittedWorkflow,
      comfyUIVersion,
      warnings,
      comfyPromptId: submission.prompt_id,
      queuePosition: submission.number,
      guidance: '已使用原工作的工作流快照與 seed 重新提交至本機 ComfyUI。',
      manifestPath: path.join(
        getOutputDir(),
        INFERENCE_JOBS_DIR_NAME,
        `${Date.now()}-${rerunJobId}-${sanitizePathSegment(original.moduleId, 'job')}.json`,
      ),
    };
    await persistInferenceJob(job);
    return job;
  }

  return {
    getSourceImagesDir,
    listInferenceJobs,
    getInferenceJob,
    listInferenceJobSummaries,
    cancelInferenceJob,
    createInferenceBatch,
    createInferenceJob,
    rerunInferenceJob,
    rerunFromRecord,
  };
}

module.exports = { createInferenceService };
