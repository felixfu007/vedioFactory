// 載入 modules/<id> 場景模組的 Canvas 預覽，並註冊為生成模組。
async function loadScenarioModules() {
  const registry = window.VedioFactory;
  let scenarioModules = [];
  try {
    const response = await fetch('/api/scenario-modules');
    if (!response.ok) return;
    scenarioModules = await response.json();
  } catch {
    return; // 瀏覽器資料夾模式沒有後端，略過場景模組。
  }
  registry.scenarioModules = scenarioModules;

  const failures = [];
  for (const scenarioModule of scenarioModules) {
    if (scenarioModule.error) {
      failures.push(`${scenarioModule.id}：${scenarioModule.error}`);
      continue;
    }
    if (!scenarioModule.canvas) continue;
    try {
      const preview = await import(scenarioModule.canvas.url);
      const renderFrame = preview.renderFrame || preview.default?.renderFrame;
      if (typeof renderFrame !== 'function') throw new Error('preview 必須匯出 renderFrame 函式。');
      registry.registerModule({
        id: scenarioModule.canvas.moduleId,
        name: scenarioModule.name,
        tagline: scenarioModule.canvas.tagline || '場景模組',
        description: scenarioModule.description,
        bestFor: scenarioModule.canvas.bestFor || scenarioModule.tags.join('、'),
        capabilities: scenarioModule.tags.length ? scenarioModule.tags : ['場景模組'],
        scenarioModuleId: scenarioModule.id,
        renderFrame,
      });
    } catch (error) {
      failures.push(`${scenarioModule.id}：${error.message}`);
    }
  }
  if (failures.length) console.warn('部分場景模組無法載入：', failures);
  document.dispatchEvent(new CustomEvent('vediofactory:scenario-modules-loaded', {
    detail: { scenarioModules, failures },
  }));
}

loadScenarioModules();
