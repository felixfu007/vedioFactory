// 前端共用狀態：可變的 state、DOM 參照 ui、已註冊的生成模組清單與 Capabilities 全域物件。

export const Capabilities = window.VedioFactoryCapabilities;

export const modules = [];

export const state = {
  library: [],
  folderHandle: null,
  generating: false,
  backend: {
    available: false,
    outputDir: '',
    ffmpeg: { available: false, version: '' },
  },
  inference: {
    runtime: null,
    lastJob: null,
    pollTimer: null,
    pollingJobId: '',
    pollInFlight: false,
  },
  modelCatalog: null,
  jobs: {
    items: [],
    pollTimer: null,
    loading: false,
  },
  presets: [],
  activePresetId: '',
  workflows: [],
  capabilities: Capabilities.BASE_CAPABILITIES,
  libraryFilter: {
    client: '',
    project: '',
  },
};

export const ui = {};
