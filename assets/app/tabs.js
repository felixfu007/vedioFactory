// 功能分頁：製作影片／工作佇列／影片庫／模型安裝。網址 #分頁名稱 可直接開啟指定分頁，並記住上次的分頁。

const TAB_STORAGE_KEY = 'vediofactory-active-tab';

function tabButtons() {
  return [...document.querySelectorAll('[data-tab]')];
}

function tabNames() {
  return tabButtons().map((button) => button.dataset.tab);
}

export function showTab(name, { updateHash = true } = {}) {
  if (!tabNames().includes(name)) return;
  tabButtons().forEach((button) => {
    const active = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== name;
  });
  if (updateHash && location.hash !== `#${name}`) {
    history.replaceState(null, '', `#${name}`);
  }
  try {
    localStorage.setItem(TAB_STORAGE_KEY, name);
  } catch {
    // 瀏覽器不允許儲存時，只是不記住分頁。
  }
}

function readInitialTab() {
  const fromHash = location.hash.slice(1);
  if (tabNames().includes(fromHash)) return fromHash;
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    if (tabNames().includes(stored)) return stored;
  } catch {
    // 讀不到就用第一個分頁。
  }
  return tabNames()[0];
}

export function initTabs() {
  const buttons = tabButtons();
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => showTab(button.dataset.tab));
    button.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = buttons[(index + step + buttons.length) % buttons.length];
      showTab(next.dataset.tab);
      next.focus();
    });
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1), { updateHash: false }));
  showTab(readInitialTab(), { updateHash: false });
}

export function setQueueBadge(count) {
  const badge = document.querySelector('#queueBadge');
  if (!badge) return;
  badge.hidden = count <= 0;
  badge.textContent = String(count);
}
