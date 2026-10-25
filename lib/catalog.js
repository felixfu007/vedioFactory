const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MODEL_SETUP_DIR_NAME } = require('./config.js');

const MODEL_CATALOG = [
  {
    id: 'sdxl',
    name: 'SDXL',
    category: 'image-generation',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 1,
    recommended: true,
    bestFor: ['文生圖', '圖生圖', 'ControlNet 擴充'],
    notes: '作為首幀、關鍵影格與風格基底模型。',
    windowsProfile: {
      runtime: 'ComfyUI / ONNX / Diffusers',
      vramHint: '建議 8GB+ VRAM',
    },
  },
  {
    id: 'animatediff',
    name: 'AnimateDiff',
    category: 'image-to-video',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 2,
    recommended: true,
    bestFor: ['照片轉短片', '鏡頭微動態', '角色動畫延展'],
    notes: '承接 SDXL 或 SD 影像輸出，補上短片運動能力。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '建議 10GB+ VRAM',
    },
  },
  {
    id: 'realesrgan',
    name: 'Real-ESRGAN',
    category: 'upscaling',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 3,
    recommended: true,
    bestFor: ['放大', '修復細節', '輸出畫質增強'],
    notes: '作為影片與單張影格後處理。',
    windowsProfile: {
      runtime: 'NCNN / PyTorch',
      vramHint: '建議 4GB+ VRAM',
    },
  },
  {
    id: 'rife',
    name: 'RIFE',
    category: 'frame-interpolation',
    batch: 'first-wave',
    status: 'scaffolded',
    priority: 4,
    recommended: true,
    bestFor: ['補幀', '提昇流暢度', '延長片段'],
    notes: '搭配 AnimateDiff 或既有影片片段提高 FPS。',
    windowsProfile: {
      runtime: 'NCNN / PyTorch',
      vramHint: '建議 6GB+ VRAM',
    },
  },
  {
    id: 'wan-2.1',
    name: 'Wan 2.1',
    category: 'video-generation',
    batch: 'advanced',
    status: 'planned',
    priority: 5,
    recommended: true,
    bestFor: ['高品質文生影片', '圖生影片'],
    notes: '適合正式導入為主力影片模型。',
    windowsProfile: {
      runtime: 'ComfyUI / Python pipeline',
      vramHint: '建議 12GB+ VRAM',
    },
  },
  {
    id: 'cogvideox',
    name: 'CogVideoX',
    category: 'video-generation',
    batch: 'advanced',
    status: 'planned',
    priority: 6,
    recommended: true,
    bestFor: ['文生影片', '長鏡頭生成'],
    notes: '可作為 Wan 2.1 之外的另一條主力影片路線。',
    windowsProfile: {
      runtime: 'Python pipeline',
      vramHint: '建議 12GB+ VRAM',
    },
  },
  {
    id: 'controlnet',
    name: 'ControlNet',
    category: 'conditioning',
    batch: 'advanced',
    status: 'planned',
    priority: 7,
    recommended: true,
    bestFor: ['姿勢控制', '構圖控制', '邊緣控制'],
    notes: '通常與 SDXL / FLUX 搭配。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '依主模型而定',
    },
  },
  {
    id: 'ip-adapter',
    name: 'IP-Adapter',
    category: 'conditioning',
    batch: 'advanced',
    status: 'planned',
    priority: 8,
    recommended: true,
    bestFor: ['參考圖一致性', '人物產品特徵保持'],
    notes: '很適合照片導向工作流。',
    windowsProfile: {
      runtime: 'ComfyUI / Diffusers',
      vramHint: '依主模型而定',
    },
  },
];

const VIDEO_MODEL_CATALOG = [
  {
    id: 'wan-2.2-ti2v-5b',
    name: 'Wan 2.2 TI2V-5B',
    kind: 'video-model',
    category: 'text-image-to-video',
    priority: 1,
    recommended: true,
    taskTypes: ['文生影片', '圖生影片'],
    bestFor: ['16GB 顯卡優先測試', '單一模型涵蓋 T2V / I2V', '720p 工作流'],
    notes: '建議先從較短影片與較低解析度開始；量化、卸載及節點設定會影響顯存需求與速度。',
    workflowNotes: 'Wan 2.2 TI2V 工作流；確認 ComfyUI 版本、模型檔及 WebM 輸出節點。',
    sourceUrl: 'https://github.com/Wan-Video/Wan2.2',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '16GB：優先測試，仍需調整工作流' },
  },
  {
    id: 'framepack-f1',
    name: 'FramePack-F1',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 2,
    recommended: true,
    taskTypes: ['圖生影片', '逐段延伸', '可測試文生影片'],
    bestFor: ['照片逐段動畫', '較長影片的分段生成'],
    notes: '官方專案提供 Windows 桌面程式；ComfyUI API 需另備相容節點/工作流，並非官方桌面程式本身。',
    workflowNotes: '需先確認第三方 ComfyUI 節點可輸出 WebM；也可獨立使用官方桌面程式。',
    sourceUrl: 'https://github.com/lllyasviel/FramePack',
    windowsProfile: { runtime: '官方 Windows 程式；ComfyUI 需額外整合', vramHint: '官方宣稱 6GB 起；速度依 GPU/設定而異' },
  },
  {
    id: 'wan-2.1-t2v-1.3b',
    name: 'Wan 2.1 T2V-1.3B',
    kind: 'video-model',
    category: 'text-to-video',
    priority: 3,
    recommended: true,
    taskTypes: ['文生影片'],
    bestFor: ['本機流程入門', '快速驗證提示詞與匯出'],
    notes: '較小型的文生影片選擇，適合先驗證工作流；畫面品質與動態表現可能低於較大型模型。',
    workflowNotes: '選用 Wan 2.1 T2V-1.3B 專用 API 工作流。',
    sourceUrl: 'https://github.com/Wan-Video/Wan2.1',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '較小型；實際需求依解析度與工作流' },
  },
  {
    id: 'ltx-video-098',
    name: 'LTX-Video 0.9.8',
    kind: 'video-model',
    category: 'text-image-to-video',
    priority: 4,
    recommended: false,
    taskTypes: ['文生影片', '圖生影片', '關鍵影格', '影片延伸'],
    bestFor: ['可控關鍵影格', '多種影片編輯工作流'],
    notes: '功能豐富但需仔細配對模型版本、節點與工作流；大模型可能需量化或卸載。',
    workflowNotes: '官方 ComfyUI-LTXVideo 範例工作流；匯出 API 格式後再接入本專案。',
    sourceUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
    windowsProfile: { runtime: 'ComfyUI-LTXVideo', vramHint: '依模型大小、量化與卸載設定' },
  },
  {
    id: 'ltx-2',
    name: 'LTX-2',
    kind: 'video-model',
    category: 'text-image-to-video-audio',
    priority: 5,
    recommended: false,
    taskTypes: ['文生影片', '圖生影片', '同步音訊'],
    bestFor: ['影音同步', '多關鍵影格控制'],
    notes: '較新且工作流複雜，先確認本機 ComfyUI/模型版本及 16GB 顯存可行性。',
    workflowNotes: '使用 LTX-2 專用 ComfyUI 工作流；本專案目前只匯入 WebM 影片，不匯入音軌以外的獨立音訊。',
    sourceUrl: 'https://github.com/Lightricks/LTX-2',
    windowsProfile: { runtime: '新版 ComfyUI', vramHint: '16GB 需實測；可能需要 FP8/卸載' },
  },
  {
    id: 'hunyuanvideo-1.5',
    name: 'HunyuanVideo-1.5',
    kind: 'video-model',
    category: 'text-image-to-video',
    priority: 6,
    recommended: false,
    taskTypes: ['文生影片', '圖生影片'],
    bestFor: ['通用影片生成', '官方 ComfyUI 指引'],
    notes: '官方提供 ComfyUI 使用說明；建議先測低解析度或蒸餾工作流，並檢查 VRAM。',
    workflowNotes: '依官方 HunyuanVideo-1.5 ComfyUI 指引匯出 API 工作流。',
    sourceUrl: 'https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '16GB 需量化/卸載與低負載設定驗證' },
  },
  {
    id: 'cogvideox-1.5-5b-i2v',
    name: 'CogVideoX1.5-5B-I2V',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 7,
    recommended: false,
    taskTypes: ['圖生影片'],
    bestFor: ['以單張圖片作為影片起始畫面'],
    notes: '圖生影片專用變體；安裝前確認相容的 ComfyUI 節點、模型版本及模型權重授權。',
    workflowNotes: '使用 CogVideoX1.5 5B I2V 專用工作流，輸入圖片節點需使用 {{source_image}}。',
    sourceUrl: 'https://github.com/zai-org/CogVideo',
    windowsProfile: { runtime: 'ComfyUI 相容工作流', vramHint: '依量化、解析度與卸載設定' },
  },
  {
    id: 'animatediff',
    name: 'AnimateDiff',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 8,
    recommended: false,
    taskTypes: ['圖生短片', 'Stable Diffusion 動畫'],
    bestFor: ['LoRA/風格實驗', '短動畫與輕量工作流'],
    notes: 'ComfyUI 生態成熟，適合短動畫與風格探索；與新一代影片基礎模型相比能力不同。',
    workflowNotes: '需安裝相容 AnimateDiff 節點與對應 motion module/基礎模型。',
    sourceUrl: 'https://github.com/guoyww/AnimateDiff',
    windowsProfile: { runtime: 'ComfyUI custom nodes', vramHint: '依基礎模型、影格數與解析度' },
  },
  {
    id: 'stable-video-diffusion-xt',
    name: 'Stable Video Diffusion XT',
    kind: 'video-model',
    category: 'image-to-video',
    priority: 9,
    recommended: false,
    taskTypes: ['圖生短片'],
    bestFor: ['圖生影片基準比較', '短片動態'],
    notes: '較早期的圖生影片模型，可作為基準或相容性測試；生成時間與長度有限。',
    workflowNotes: '選用 SVD XT 相容工作流，確認輸出轉成 WebM。',
    sourceUrl: 'https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt',
    windowsProfile: { runtime: 'ComfyUI', vramHint: '依解析度及影格數' },
  },
  {
    id: 'mochi-1',
    name: 'Mochi 1',
    kind: 'video-model',
    category: 'text-to-video',
    priority: 10,
    recommended: false,
    taskTypes: ['文生影片'],
    bestFor: ['動作表現與提示詞遵循研究', '模型/工作流比較'],
    notes: '約 10B 參數且官方範例使用 CPU 卸載；16GB 顯卡不建議作為第一個整合目標。',
    workflowNotes: '確認現行 ComfyUI 相容節點及權重授權；模型體積與速度是主要門檻。',
    sourceUrl: 'https://github.com/genmoai/mochi',
    windowsProfile: { runtime: 'ComfyUI 相容工作流', vramHint: '16GB：不建議優先，需大量卸載' },
  },
];

function getCurrentProjectModelStatus() {
  return {
    actualIntegratedModels: [],
    visualModules: [
      { id: 'cinematic-motion', type: 'canvas-module' },
      { id: 'storyboard-focus', type: 'canvas-module' },
      { id: 'neon-pulse', type: 'canvas-module' },
    ],
    inferenceScaffold: {
      provider: 'comfyui-local',
      hasRuntimeDetection: true,
      hasJobManifestPersistence: true,
      hasComfyUIWorkflowExecution: true,
      hasIntegratedModelWeights: false,
    },
  };
}

function buildModelCatalog(modelDir) {
  return {
    generatedAt: new Date().toISOString(),
    currentProjectStatus: getCurrentProjectModelStatus(),
    installRoot: modelDir,
    firstBatchOrder: MODEL_CATALOG.filter((model) => model.batch === 'first-wave')
      .sort((left, right) => left.priority - right.priority)
      .map((model) => model.id),
    videoModels: VIDEO_MODEL_CATALOG.map((model) => ({
      ...model,
      installPath: path.join(modelDir, model.id),
    })),
    models: [...MODEL_CATALOG, ...VIDEO_MODEL_CATALOG].map((model) => ({
      ...model,
      installPath: path.join(modelDir, model.id),
    })),
  };
}

// 依第一波模型建立安裝準備清單（只寫 manifest，不下載權重）。
async function createModelSetupBatch(outputDir, runtime) {
  await fs.mkdir(path.join(outputDir, MODEL_SETUP_DIR_NAME), { recursive: true });
  const catalog = buildModelCatalog(runtime.modelDir);
  const requestToken = crypto.randomUUID();
  const manifests = [];

  for (const model of catalog.models.filter((item) => item.batch === 'first-wave')) {
    const manifest = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      modelId: model.id,
      name: model.name,
      category: model.category,
      installPath: model.installPath,
      provider: runtime.provider,
      status: 'scaffolded',
      nextAction: '準備模型權重、推論節點與本機命令整合',
      recommendedFor: model.bestFor,
    };
    const manifestPath = path.join(outputDir, MODEL_SETUP_DIR_NAME, `${Date.now()}-${requestToken}-${model.id}.json`);
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, manifestPath }, null, 2));
    manifests.push({ ...manifest, manifestPath });
  }

  return {
    provider: runtime.provider,
    outputDir,
    installRoot: catalog.installRoot,
    firstBatchModels: manifests,
  };
}

module.exports = {
  VIDEO_MODEL_CATALOG,
  buildModelCatalog,
  createModelSetupBatch,
};
