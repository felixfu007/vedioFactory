// 生成模組註冊器：註冊、查詢模組，並渲染模組下拉選單與說明。

import { modules, ui } from './state.js';

export function registerModule(moduleDefinition) {
  if (!moduleDefinition || !moduleDefinition.id) {
    throw new Error('Module definition requires an id.');
  }

  modules.push(moduleDefinition);
  if (ui.moduleSelect) {
    renderModuleOptions();
  }
}

export function getModuleById(id) {
  return modules.find((item) => item.id === id) ?? modules[0];
}

export function renderModuleOptions() {
  const currentValue = ui.moduleSelect.value;
  ui.moduleSelect.innerHTML = '';
  modules.forEach((moduleDefinition) => {
    const option = document.createElement('option');
    option.value = moduleDefinition.id;
    option.textContent = `${moduleDefinition.name}｜${moduleDefinition.tagline}`;
    ui.moduleSelect.append(option);
  });

  if (currentValue && modules.some((moduleDefinition) => moduleDefinition.id === currentValue)) {
    ui.moduleSelect.value = currentValue;
  }
  ui.moduleCount.textContent = String(modules.length);
  renderModuleDetails();
}

export function renderModuleDetails() {
  const moduleDefinition = getModuleById(ui.moduleSelect.value);
  if (!moduleDefinition) {
    ui.moduleDetails.textContent = '尚未註冊任何模組。';
    return;
  }

  ui.moduleDetails.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = moduleDefinition.name;
  const description = document.createElement('p');
  description.textContent = moduleDefinition.description;
  const bestFor = document.createElement('p');
  bestFor.className = 'video-subtitle';
  bestFor.textContent = `適用情境：${moduleDefinition.bestFor}`;
  const list = document.createElement('ul');
  moduleDefinition.capabilities.forEach((item) => {
    const entry = document.createElement('li');
    entry.textContent = item;
    list.append(entry);
  });

  ui.moduleDetails.append(title, description, bestFor, list);
}
