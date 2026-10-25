// 前端入口：綁定事件、初始化各功能區塊，並把註冊器 API 掛到 window.VedioFactory 給 modules.js 與場景模組使用。
// 各功能的實作位於 assets/app/ 底下的 ES modules。

import { Capabilities, state, ui } from './app/state.js';
import { bindUi, setStatus } from './app/dom.js';
import { registerModule, getModuleById, renderModuleOptions, renderModuleDetails } from './app/registry.js';
import { syncCustomResolutionFields, renderCapabilities, selectWorkflow, loadWorkflows } from './app/workflows.js';
import { loadStoredLibrary, getLibrarySnapshot, restoreStoredLibraryPreview } from './app/library-store.js';
import { renderProjectOptions, renderLibrary, refreshLibrary, setRegenerateHandler } from './app/library.js';
import { createDelivery } from './app/delivery.js';
import { generateFromForm, renderReferenceFrame } from './app/generation.js';
import {
  syncSeedInput,
  queueInferenceBatch,
  queueInferenceJob,
  checkComfyWorkflow,
  cancelInferenceJob,
  regenerateItem,
} from './app/inference.js';
import { renderJobs, loadJobs } from './app/jobs.js';
import {
  syncPresetUi,
  loadPresets,
  applySelectedPreset,
  savePreset,
  updatePreset,
  deletePreset,
  exportPresets,
  importPresets,
} from './app/presets.js';
import { setupModelBatch } from './app/models.js';
import { syncStorageUi, pickFolder, connectOutputDir, initBackend } from './app/backend.js';
import { civitaiState, previewCivitaiModel, installCivitaiModel, loadModelInstalls } from './app/civitai.js';

setRegenerateHandler(regenerateItem);

function attachEvents() {
  ui.moduleSelect.addEventListener('change', renderModuleDetails);
  ui.generationForm.addEventListener('submit', (event) => {
    event.preventDefault();
    generateFromForm();
  });
  ui.connectOutputDirButton.addEventListener('click', connectOutputDir);
  ui.pickFolderButton.addEventListener('click', pickFolder);
  ui.refreshButton.addEventListener('click', refreshLibrary);
  ui.queueInferenceButton.addEventListener('click', queueInferenceJob);
  ui.queueBatchButton.addEventListener('click', queueInferenceBatch);
  ui.refreshJobsButton.addEventListener('click', () => loadJobs({ refresh: true }));
  ui.jobStatusFilter.addEventListener('change', renderJobs);
  document.addEventListener('vediofactory:jobs-changed', () => loadJobs());
  ui.cancelInferenceButton.addEventListener('click', cancelInferenceJob);
  ui.workflowCheckButton.addEventListener('click', checkComfyWorkflow);
  ui.setupModelBatchButton.addEventListener('click', setupModelBatch);
  ui.seedModeInput.addEventListener('change', syncSeedInput);
  ui.workflowSelect.addEventListener('change', selectWorkflow);
  ui.resolutionInput.addEventListener('change', syncCustomResolutionFields);
  ui.presetSelect.addEventListener('change', () => {
    if (!ui.presetSelect.value) state.activePresetId = '';
    syncPresetUi();
  });
  ui.applyPresetButton.addEventListener('click', applySelectedPreset);
  ui.savePresetButton.addEventListener('click', savePreset);
  ui.updatePresetButton.addEventListener('click', updatePreset);
  ui.deletePresetButton.addEventListener('click', deletePreset);
  ui.exportPresetsButton.addEventListener('click', exportPresets);
  ui.importPresetsButton.addEventListener('click', () => ui.importPresetsInput.click());
  ui.importPresetsInput.addEventListener('change', importPresets);
  ui.clientInput.addEventListener('change', renderProjectOptions);
  ui.libraryClientFilter.addEventListener('change', () => {
    state.libraryFilter.client = ui.libraryClientFilter.value;
    renderLibrary();
  });
  ui.createDeliveryButton.addEventListener('click', createDelivery);
  ui.civitaiPreviewButton.addEventListener('click', previewCivitaiModel);
  ui.civitaiInstallButton.addEventListener('click', installCivitaiModel);
  ui.civitaiUrlInput.addEventListener('input', () => {
    civitaiState.preview = null;
    ui.civitaiInstallButton.disabled = true;
  });
  ui.civitaiFolderSelect.addEventListener('change', () => {
    civitaiState.preview = null;
    ui.civitaiInstallButton.disabled = true;
  });
  ui.libraryProjectFilter.addEventListener('change', () => {
    state.libraryFilter.project = ui.libraryProjectFilter.value;
    renderLibrary();
  });
}

async function initApp() {
  bindUi();
  renderCapabilities(Capabilities.BASE_CAPABILITIES);
  loadStoredLibrary();
  restoreStoredLibraryPreview();
  renderModuleOptions();
  attachEvents();
  await initBackend();
  await loadWorkflows();
  await loadPresets();
  await loadJobs({ refresh: true });
  await loadModelInstalls();
  syncStorageUi();
  renderLibrary();
}

window.VedioFactory = Object.assign(window.VedioFactory ?? {}, {
  registerModule,
  initApp,
  getModuleById,
  getLibrarySnapshot,
  renderReferenceFrame,
});

document.addEventListener('DOMContentLoaded', () => {
  if (typeof window.VedioFactory?.initApp === 'function') {
    window.VedioFactory.initApp().catch((error) => {
      console.error(error);
      setStatus(`初始化失敗：${error.message}`);
    });
  }
});
