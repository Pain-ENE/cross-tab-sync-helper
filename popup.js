const $ = (selector) => document.querySelector(selector);
const cursorColors = globalThis.mtsCursorColors;
const colorRows = [...document.querySelectorAll('[data-color]')];
let savedColors = {};
const blockedURL = /^(chrome|edge|about|chrome-extension|se|devtools|view-source|chrome-search):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;
const failureLabels = {
  frozen: '浏览器已冻结',
  discarded: '页面已休眠',
  loading: '正在载入',
  disconnected: '连接中断',
  'missing-frame': '未找到页面框架',
  'missing-target': '未找到控件',
  expired: '操作已过期',
  timeout: '回放超时',
  busy: '待处理操作过多',
  failed: '回放失败',
};
let state = { enabled: false, tabIds: [], opts: {} };
let diagnostics = {};
let tabs = [];
let checking = false;
let busy = false;
let initialized = false;

function feedback(message = '', error = false) {
  const el = $('#feedback');
  el.hidden = !message;
  el.textContent = message;
  el.dataset.error = error;
}

async function send(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...values });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function update(values) {
  try {
    await send('mts:update', values);
    await refreshDiagnostics();
  } catch {
    feedback('设置更新失败，请重试。', true);
    renderState();
  }
}

function urlLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol;
  } catch { return ''; }
}

function empty(label) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = label;
  return li;
}

function tabRow(tab) {
  const li = $('#tab-row').content.firstElementChild.cloneNode(true);
  li.dataset.tabId = tab.id;
  const title = tab.title || '未命名页面';
  const url = urlLabel(tab.url || tab.pendingUrl);
  const tabInput = li.querySelector('.tab-select');
  tabInput.checked = state.tabIds.includes(tab.id);
  tabInput.setAttribute('aria-label', '参与同步：' + title);
  tabInput.addEventListener('change', () => update(tabInput.checked ? { add: [tab.id] } : { remove: tab.id }));
  const tabOpen = li.querySelector('.tab-open');
  tabOpen.title = title;
  tabOpen.setAttribute('aria-label', '切换到：' + title);
  tabOpen.addEventListener('click', async () => {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
    } catch { feedback('无法打开该标签页。', true); }
  });
  li.querySelector('.tab-icon').textContent = (url.match(/^[a-z0-9]/i)?.[0] || '▤').toUpperCase();
  li.querySelector('.tab-title').textContent = title;
  li.querySelector('.tab-url').textContent = url;
  return li;
}

function renderTabs() {
  const selected = state.tabIds.map((id) => tabs.find((tab) => tab.id === id)).filter(Boolean);
  const available = tabs.filter((tab) => !state.tabIds.includes(tab.id) && !blockedURL.test(tab.url || tab.pendingUrl || ''));
  const focus = document.activeElement;
  const focusedTab = focus?.closest('[data-tab-id]')?.dataset.tabId;
  const selector = focus?.matches('.tab-select') ? '.tab-select' : '.tab-open';
  $('#tabs').replaceChildren(...(selected.length ? selected.map(tabRow) : [empty('添加至少两个页面即可同步操作。')]));
  $('#other-tabs').replaceChildren(...(available.length ? available.map(tabRow) : [empty('没有可添加的标签页。')]));
  $('#available-count').textContent = available.length ? String(available.length) : '';
  if (focusedTab) {
    const next = document.querySelector('[data-tab-id="' + focusedTab + '"] ' + selector);
    if (next?.offsetParent) next.focus({ preventScroll: true });
    else $('#available summary').focus({ preventScroll: true });
  }
  renderDiagnostics();
}

function renderDiagnostics() {
  const n = state.tabIds.length;
  const ready = diagnostics.ready || [];
  let attention = 0;
  let connected = 0;
  for (const row of document.querySelectorAll('#tabs [data-tab-id]')) {
    const id = Number(row.dataset.tabId);
    const tab = tabs.find((entry) => entry.id === id);
    const out = diagnostics.outcomes?.[id];
    const error = diagnostics.errors?.[id];
    const problem = diagnostics.availability?.[id] || (tab?.discarded ? 'discarded' : tab?.frozen ? 'frozen' : null);
    const status = row.querySelector('.tab-result');
    const online = !problem && ready.includes(id);
    if (online) connected++;
    let label = online ? '已连接' : state.enabled ? '等待连接' : '';
    let tone = online ? 'good' : '';
    let detail = '';
    if (problem || (error && !online)) {
      label = failureLabels[problem] || '连接失败';
      tone = 'warn';
      detail = error || label;
    } else if (state.enabled && diagnostics.leader === id) {
      label = '主控';
      tone = 'leader';
    } else if (state.enabled && out) {
      tone = out.code === 'applied' ? 'good' : out.code === 'isolated' ? '' : 'warn';
      label = out.code === 'applied' ? '回放 ' + out.latency + ' ms'
        : out.code === 'isolated' ? '已按规则隔离' : failureLabels[out.code] || '回放失败';
      detail = label + ' · ' + new Date(out.at).toLocaleTimeString();
    }
    if (out?.missed) {
      detail += (detail ? ' · ' : '') + '本轮有 ' + out.missed + ' 次未确认';
      if (tone === 'good') label += ' · 漏 ' + out.missed;
    }
    if (tone === 'warn' || out?.missed) attention++;
    status.hidden = !label;
    status.textContent = label;
    status.dataset.tone = tone;
    status.title = detail || label;
    status.setAttribute('aria-label', detail || label);
  }
  $('#count').textContent = n;
  $('#ready-count').textContent = n && (state.enabled || ready.length || Object.keys(diagnostics.errors || {}).length) ? connected : '—';
  $('#attention-count').textContent = n && (state.enabled || attention) ? attention : '—';
  const summary = $('#sync-state');
  const label = state.enabled ? '同步已开启' : n < 2 ? '请选择至少两个标签页' : '同步已暂停';
  if (summary.textContent !== label) summary.textContent = label;
  summary.dataset.on = state.enabled;
}

function renderExcluded() {
  const entries = state.opts.excluded || [];
  const rows = entries.map((field) => {
    const li = document.createElement('li');
    li.className = 'ex-row';
    const label = document.createElement('span');
    label.textContent = field.label || field.key;
    label.title = field.key;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', '移除隔离：' + label.textContent);
    remove.addEventListener('click', () => send('mts:remove-excluded', { key: field.key }).catch(() => feedback('移除失败。', true)));
    li.append(label, remove);
    return li;
  });
  $('#excluded').replaceChildren(...(rows.length ? rows : [empty('可隔离档案编号、提交按钮等控件。')]));
}

function renderState() {
  const n = state.tabIds.length;
  $('#enabled').checked = state.enabled;
  $('#enabled').disabled = !initialized || (!state.enabled && n < 2);
  $('#tile').disabled = n < 2;
  $('#check').disabled = checking || !n;
  $('#addExcluded').disabled = !n;
  for (const el of document.querySelectorAll('[data-opt]')) {
    if (el.type === 'checkbox') el.checked = !!state.opts[el.dataset.opt];
    else el.value = state.opts[el.dataset.opt] || 'absolute';
  }
  for (const row of colorRows) {
    const option = row.dataset.color;
    const color = currentColor(option);
    row.querySelector('.color-picker').value = color;
    const hex = row.querySelector('.color-hex');
    if (document.activeElement !== hex) hex.value = color.toUpperCase();
    previewColor(option, color);
  }
  renderExcluded();
  renderTabs();
}

async function refreshDiagnostics() {
  try {
    diagnostics = await send('mts:diagnostics') || {};
    renderDiagnostics();
  } catch { /* 扩展页面关闭时无需继续刷新。 */ }
}

async function runCheck() {
  checking = true;
  $('#check').disabled = true;
  $('#check').textContent = '正在检查…';
  try {
    await send('mts:check');
    await refreshDiagnostics();
    const ready = state.tabIds.filter((id) => diagnostics.ready?.includes(id)).length;
    feedback(ready + ' / ' + state.tabIds.length + ' 个页面已连接。点击页面标题可切过去查看。', ready < state.tabIds.length);
  } catch { feedback('连接检查失败，请重试。', true); }
  finally {
    checking = false;
    $('#check').disabled = !state.tabIds.length;
    $('#check').textContent = '检查连接';
  }
}

$('#enabled').addEventListener('change', (e) => update({ enabled: e.currentTarget.checked }));
for (const el of document.querySelectorAll('[data-opt]')) {
  el.addEventListener('change', () => update({ option: el.dataset.opt, value: el.type === 'checkbox' ? el.checked : el.value }));
}
function currentColor(option) {
  return cursorColors.normalize(state.opts[option] ?? savedColors[option]);
}

function previewColor(option, color) {
  if (option === 'themeColor') document.documentElement.style.setProperty('--theme-color', color);
}

for (const row of colorRows) {
  const option = row.dataset.color;
  const picker = row.querySelector('.color-picker');
  const hex = row.querySelector('.color-hex');
  function commit(color) {
    picker.value = color;
    hex.value = color.toUpperCase();
    hex.removeAttribute('aria-invalid');
    previewColor(option, color);
    if (color !== currentColor(option)) void update({ option, value: color });
  }
  function commitHex() {
    const color = cursorColors.parse(hex.value);
    if (color) commit(color);
    else hex.setAttribute('aria-invalid', 'true');
  }
  picker.addEventListener('input', () => {
    hex.value = picker.value.toUpperCase();
    hex.removeAttribute('aria-invalid');
    previewColor(option, picker.value);
  });
  picker.addEventListener('change', () => commit(picker.value));
  hex.addEventListener('input', () => hex.removeAttribute('aria-invalid'));
  hex.addEventListener('change', commitHex);
  hex.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitHex();
    if (event.key === 'Escape') {
      commit(currentColor(option));
      event.stopPropagation();
    }
  });
}
$('#check').addEventListener('click', runCheck);
$('#tile').addEventListener('click', async () => {
  try {
    await send('mts:tile', { screen: { left: screen.availLeft || 0, top: screen.availTop || 0, width: screen.availWidth, height: screen.availHeight } });
  } catch { feedback('平铺失败，请重试。', true); }
});
$('#dup-toggle').addEventListener('click', () => {
  const panel = $('#duplicate');
  panel.hidden = !panel.hidden;
  $('#dup-toggle').setAttribute('aria-expanded', String(!panel.hidden));
});
async function duplicate(n) {
  if (busy) return;
  if (!Number.isInteger(n) || n < 1 || n > 16) return feedback('请输入 1–16 的份数。', true);
  busy = true;
  const controls = [...document.querySelectorAll('#duplicate button, #duplicate input')];
  controls.forEach((el) => { el.disabled = true; });
  const ids = [];
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active || blockedURL.test(active.url || '')) return feedback('当前页面无法复制到同步组。', true);
    for (let i = 0; i < n; i++) {
      try { ids.push((await chrome.tabs.duplicate(active.id)).id); } catch { break; }
    }
    if (!ids.length) return feedback('复制失败，请重试。', true);
    await send('mts:update', { add: ids });
    feedback('已复制 ' + ids.length + ' / ' + n + ' 份并加入同步组。', ids.length < n);
  } catch { feedback('复制或加入同步组时出错。', true); }
  finally {
    busy = false;
    controls.forEach((el) => { el.disabled = false; });
    void refreshTabs();
  }
}
document.querySelectorAll('.dup-quick').forEach((el) => el.addEventListener('click', () => duplicate(Number(el.dataset.n))));
$('#dupGo').addEventListener('click', () => duplicate(Number($('#dupN').value)));
$('#dupN').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#dupGo').click(); });

async function pickerLabel() {
  const status = await send('mts:picker-status');
  $('#addExcluded').textContent = status?.on ? '点选中 · 按 Esc 取消' : '＋ 在页面上选取';
  return status?.on;
}
$('#addExcluded').addEventListener('click', async () => {
  try {
    const response = await send('mts:picker', { on: !(await pickerLabel()) });
    await pickerLabel();
    if (response?.on) window.close();
  } catch { feedback('无法开启点选，请先检查连接。', true); }
});

async function refreshTabs() {
  tabs = await chrome.tabs.query({});
  renderTabs();
}
chrome.tabs.onCreated.addListener(refreshTabs);
chrome.tabs.onRemoved.addListener(refreshTabs);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.title || 'discarded' in change || 'frozen' in change) void refreshTabs();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.state) return;
  state = changes.state.newValue || state;
  renderState();
  void refreshDiagnostics();
  void pickerLabel().catch(() => {});
});
(async () => {
  try {
    const [saved, open, preferences] = await Promise.all([
      chrome.storage.session.get('state'),
      chrome.tabs.query({}),
      chrome.storage.local.get(['ghostColor', 'themeColor']).catch(() => ({})),
    ]);
    savedColors = preferences;
    state = saved.state || state;
    tabs = open;
    initialized = true;
    renderState();
    await refreshDiagnostics();
    if (state.enabled && !diagnostics.ready?.length) {
      await send('mts:check');
      await refreshDiagnostics();
    }
    void pickerLabel().catch(() => {});
    setInterval(refreshDiagnostics, 750);
  } catch { feedback('无法读取扩展状态，请重新打开弹窗。', true); }
})();
