// 跨标签页操作同步助手 – popup。状态写入 chrome.storage.session，
// Service Worker 据此注入脚本、连接调试器、更新角标。

const DEFAULT_STATE = {
  enabled: false,
  seq: 0,
  tabIds: [],
  opts: { scroll: true, click: true, keys: true, nav: true, scrollMode: 'absolute', precision: false, ghost: true, excluded: [] },
};

const RESTRICTED = /^(chrome|edge|about|chrome-extension|se|devtools|view-source|chrome-search):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

const $ = (sel) => document.querySelector(sel);
let state = DEFAULT_STATE;
let tabErrors = {};
let renderSeq = 0;

function normalize(s) {
  const opts = { ...DEFAULT_STATE.opts, ...(s?.opts || {}) };
  opts.excluded = Array.isArray(opts.excluded) ? opts.excluded : [];
  return { ...DEFAULT_STATE, ...s, seq: s?.seq || 0, opts, tabIds: s?.tabIds || [] };
}

async function save(mutate) {
  const next = structuredClone(state);
  next.seq = (next.seq || 0) + 1;
  mutate(next);
  state = normalize(next);
  await chrome.storage.session.set({ state });
  // 通知 Service Worker 应用新状态（消息链必定唤醒空闲的 SW，
  // 负责注入内容脚本、弹出切换提示条、更新角标）
  chrome.runtime.sendMessage({ type: 'mts:refresh' }).catch(() => {});
  render();
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url || '';
  }
}

// 检测 Chrome 交给用户决定的权限问题
async function accessProblem(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (url.startsWith('file:')) {
    return (await chrome.extension.isAllowedFileSchemeAccess()) ? null
      : '未开启本地文件访问：地址栏输入扩展管理页 → 跨标签页操作同步助手 → 详情 → 打开"允许访问文件网址"（或使用 http:// 内网地址）。';
  }
  let origin;
  try { origin = new URL(url).origin; } catch { return null; }
  if (!/^https?:/.test(origin)) return null;
  const ok = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  return ok ? null : '无网站访问权限：右键扩展图标 → "可读取和更改网站数据" → 选择"在所有网站上"。';
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({});
  const list = $('#tabs');
  const tpl = $('#tab-row');
  const seq = ++renderSeq;
  const rows = [];

  // 已勾选的在前（按加入顺序），其余按窗口排
  const selected = state.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const rest = tabs.filter((t) => !state.tabIds.includes(t.id));
  let lastWindow = null;

  for (const tab of [...selected, ...rest]) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    const cb = li.querySelector('input');
    const isSelected = state.tabIds.includes(tab.id);
    const restricted = RESTRICTED.test(tab.url || tab.pendingUrl || '');

    if (!isSelected && lastWindow !== null && tab.windowId !== lastWindow) li.classList.add('window-sep');
    if (!isSelected) lastWindow = tab.windowId;

    cb.checked = isSelected;
    cb.disabled = restricted && !isSelected;
    if (cb.disabled) li.classList.add('disabled');
    cb.addEventListener('change', () => save((s) => {
      s.tabIds = cb.checked ? [...s.tabIds, tab.id] : s.tabIds.filter((t) => t !== tab.id);
      // 注意：不自动开启同步，开关由用户手动打开，
      // 保证可以先在各标签页填好各自不同的编号。
    }));

    const img = li.querySelector('.favicon');
    if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
      img.src = tab.favIconUrl;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    } else {
      img.style.visibility = 'hidden';
    }

    li.querySelector('.title').textContent = tab.title || '(无标题)';
    li.querySelector('.url').textContent = hostOf(tab.url || tab.pendingUrl);

    const warn = li.querySelector('.warn');
    const error = restricted ? '扩展不允许在此类页面运行。'
      : isSelected ? (await accessProblem(tab)) || tabErrors[tab.id] : null;
    if (error) {
      warn.hidden = false;
      warn.title = error;
      if (isSelected) li.querySelector('.error').textContent = error;
    }
    rows.push(li);
  }
  if (seq !== renderSeq) return; // 已有更新的渲染
  list.replaceChildren(...rows);

  const n = state.tabIds.length;
  $('#count').textContent = n ? `已选 ${n} 个` : '至少勾选 2 个';
  $('#tile').disabled = n < 1;
}

function renderExcluded() {
  const list = $('#excluded');
  const tpl = $('#excluded-row');
  const rows = [];
  for (const f of state.opts.excluded) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.querySelector('.ex-label').textContent = f.label || '';
    li.querySelector('.ex-key').textContent = f.key;
    li.querySelector('.ex-remove').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'mts:remove-excluded', key: f.key }).then(() => {});
    });
    rows.push(li);
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '（尚未隔离任何字段）';
    rows.push(li);
  }
  list.replaceChildren(...rows);
}

function render() {
  $('#enabled').checked = state.enabled;
  for (const el of document.querySelectorAll('[data-opt]')) {
    const v = state.opts[el.dataset.opt];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  // 勾选计数与平铺按钮状态先于列表同步更新：批量复制后立即可见反馈，
  // 不被标签页列表的异步渲染（逐行权限探测）拖慢
  const n = state.tabIds.length;
  $('#count').textContent = n ? `已选 ${n} 个` : '至少勾选 2 个';
  $('#tile').disabled = n < 1;
  renderExcluded();
  renderTabs();
}

$('#enabled').addEventListener('change', (e) => save((s) => { s.enabled = e.target.checked; }));

for (const el of document.querySelectorAll('[data-opt]')) {
  el.addEventListener('change', () => save((s) => {
    s.opts[el.dataset.opt] = el.type === 'checkbox' ? el.checked : el.value;
  }));
}

$('#tile').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'mts:tile',
    screen: {
      left: screen.availLeft ?? 0,
      top: screen.availTop ?? 0,
      width: screen.availWidth,
      height: screen.availHeight,
    },
  });
});

// ---------------------------------------------------------------------------
// 批量复制当前标签页：复制 N 份并自动加入同步组。
// 与勾选一样不自动开启同步，保证“先填各自编号再开同步”的流程
// 不被打断；复制会连带已填的表单内容，建议在空白模板页上复制。
// ---------------------------------------------------------------------------
let dupMsgTimer = 0;

function showDupMsg(text, isError) {
  const el = $('#dupMsg');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  clearTimeout(dupMsgTimer);
  dupMsgTimer = setTimeout(() => { el.textContent = ''; el.classList.remove('error'); }, 2600);
}

async function duplicateActive(n) {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) return showDupMsg('未找到当前标签页', true);
  const url = active.url || active.pendingUrl || '';
  if (RESTRICTED.test(url)) return showDupMsg('当前页面类型不允许加入同步组', true);
  const ids = [];
  for (let i = 0; i < n; i++) {
    try { ids.push((await chrome.tabs.duplicate(active.id)).id); } catch { break; }
  }
  if (!ids.length) return showDupMsg('复制失败，请重试', true);
  await save((s) => {
    const fresh = ids.filter((id) => !s.tabIds.includes(id));
    s.tabIds = [...s.tabIds, ...fresh];
  });
  showDupMsg(`已复制 ${ids.length} 份并加入同步组`);
}

for (const btn of document.querySelectorAll('.dup-quick')) {
  btn.addEventListener('click', () => duplicateActive(Number(btn.dataset.n)));
}
$('#dupGo').addEventListener('click', () => {
  const n = Number($('#dupN').value);
  if (!Number.isInteger(n) || n < 1 || n > 16) return showDupMsg('请输入 1–16 的份数', true);
  duplicateActive(n);
});
$('#dupN').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#dupGo').click();
});

const addBtn = $('#addExcluded');
addBtn.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'mts:picker-status' }).catch(() => ({ on: false }));
  const on = !status?.on;
  await chrome.runtime.sendMessage({ type: 'mts:picker', on }).catch(() => {});
  addBtn.textContent = on ? '● 点选进行中：到标签页点击字段（Esc 取消）' : '＋ 点击页面选择要隔离的字段';
  addBtn.classList.toggle('active', on);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.state) state = normalize(changes.state.newValue);
  if (changes.tabErrors) tabErrors = changes.tabErrors.newValue || {};
  // 隔离名单变化通常来自页面点选完成 -> 复位点选按钮
  addBtn.textContent = '＋ 点击页面选择要隔离的字段';
  addBtn.classList.remove('active');
  render();
});

chrome.runtime.sendMessage({ type: 'mts:picker-status' }).then((status) => {
  if (status?.on) {
    addBtn.textContent = '● 点选进行中：到标签页点击字段（Esc 取消）';
    addBtn.classList.add('active');
  }
}).catch(() => {});

chrome.storage.session.get(['state', 'tabErrors']).then((r) => {
  state = normalize(r.state);
  tabErrors = r.tabErrors || {};
  render();
});
