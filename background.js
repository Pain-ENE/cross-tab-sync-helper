// 跨标签页操作同步助手（基于开源项目 aysner/Multi-Tab-Sync 修改）– Service Worker。
// 管理同步组、注入内容脚本、在标签页之间路由事件，
// 并管理"字段隔离"名单与点选模式。

const DEFAULT_STATE = {
  enabled: false,
  tabIds: [],
  opts: {
    scroll: true,
    click: true,
    keys: true,
    nav: true,
    scrollMode: 'absolute', // 'absolute' | 'relative'
    precision: false,
    ghost: true, // 镜像鼠标：在其他标签页显示主控页鼠标位置与动作
    excluded: [], // 不同步的字段：[{ key: 'name:xxx' | 'id:xxx', label: '显示名' }]
  },
};

const CATEGORY = { scroll: 'scroll', click: 'click', focus: 'click', key: 'keys', input: 'keys', change: 'keys', cursor: 'ghost' };

// 在某标签页回放事件后的一小段时间内忽略来自该页的事件，
// 防止回放引发的滚动、聚焦、输入等再次被广播出去（回环）。
const REPLAY_QUIET_MS = 250;
const NAV_DELAY_MS = 400;
const CDP_VERSION = '1.3';

const lastReplay = new Map(); // tabId -> 最近一次回放完成时间
const inFlight = new Map();   // tabId -> 正在排队/执行的回放数量
const queues = new Map();     // tabId -> Promise（每个标签页的回放串行化）
const attachedTabs = new Set();
let leaderTabId = null;
let pickerOn = false;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function normalize(s) {
  const opts = { ...DEFAULT_STATE.opts, ...(s?.opts || {}) };
  opts.excluded = Array.isArray(opts.excluded) ? opts.excluded : [];
  return { ...DEFAULT_STATE, ...s, opts, tabIds: s?.tabIds || [] };
}

let state = DEFAULT_STATE;
let appliedSeq = 0; // 已应用的最新状态版本号，防止旧消息把新状态回滚
const ready = chrome.storage.session.get(['state', 'leader']).then((r) => {
  state = normalize(r.state);
  appliedSeq = state.seq || 0;
  leaderTabId = r.leader ?? null;
});

async function getState() {
  await ready;
  return state;
}

async function updateState(mutate, opts = {}) {
  const prev = await getState();
  const next = structuredClone(prev);
  next.seq = (next.seq || 0) + 1;
  mutate(next);
  state = normalize(next);
  appliedSeq = Math.max(appliedSeq, state.seq || 0);
  await chrome.storage.session.set({ state });
  await reconcile(prev, state, opts.announce !== false);
}

// popup 等外部入口改完状态后发来的刷新请求：读最新状态并应用。
// 必须走消息链（runtime.sendMessage 能唤醒空闲的 Service Worker；
// 而 storage.onChanged 不会唤醒），否则 SW 睡着时会丢失注入与提示。
// 并发到达的旧版本消息直接丢弃，避免把新状态回滚。
let refreshChain = Promise.resolve();
function refresh(opts = {}) {
  const run = refreshChain.then(async () => {
    const r = await chrome.storage.session.get('state');
    const next = normalize(r.state);
    const nextSeq = next.seq || 0;
    if (nextSeq <= appliedSeq) return; // 过期消息，丢弃
    const prev = state;
    state = next;
    appliedSeq = nextSeq;
    await reconcile(prev, next, opts.announce !== false);
  });
  refreshChain = run.catch(() => {});
  return run;
}

function setLeader(tabId) {
  if (leaderTabId === tabId) return;
  leaderTabId = tabId;
  chrome.storage.session.set({ leader: tabId });
}

async function setTabError(tabId, message) {
  const { tabErrors = {} } = await chrome.storage.session.get('tabErrors');
  if (message) tabErrors[tabId] = message;
  else if (tabId in tabErrors) delete tabErrors[tabId];
  else return;
  await chrome.storage.session.set({ tabErrors });
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  // 仅用于 popup 正在打开时快速同步显示；注入与提示统一由消息链（mts:refresh）驱动，
  // 不在此处 reconcile，避免 SW 空闲后被 storage 事件丢掉的时序问题
  if (area !== 'session' || !changes.state) return;
  await ready;
});

// 按新状态调整注入、调试器连接；announce=false 时不弹切换提示（冷启动）
async function reconcile(prev, next, announce = true) {
  const prevActive = prev.enabled ? prev.tabIds : [];
  const nextActive = next.enabled ? next.tabIds : [];

  // 切换提示：关 -> 先提示再拆除（内容脚本还在场）；
  // 开 -> 等待注入完成后提示（不使用裸 setTimeout：MV3 下定时器可能随 SW 空闲丢失）
  const turningOn = !prev.enabled && next.enabled;
  const turningOff = prev.enabled && !next.enabled;
  if (announce && turningOff) {
    broadcastToast(false, prevActive);
    systemNotify(false, 0);
  }

  const newActive = nextActive.filter((t) => !prevActive.includes(t));
  for (const t of newActive) inject(t);
  for (const t of prevActive) if (!nextActive.includes(t)) teardownTab(t);

  const prevDbg = prev.enabled && prev.opts.precision ? prev.tabIds : [];
  const nextDbg = next.enabled && next.opts.precision ? next.tabIds : [];
  for (const t of nextDbg) if (!prevDbg.includes(t)) attachDebugger(t).catch(() => {});
  for (const t of prevDbg) if (!nextDbg.includes(t)) detachDebugger(t);

  // 字段隔离名单 / 镜像鼠标开关有变化 -> 通知所有相关标签页
  if (JSON.stringify(prev.opts.excluded) !== JSON.stringify(next.opts.excluded)
      || !!prev.opts.ghost !== !!next.opts.ghost) {
    broadcastConfig(next);
  }

  updateBadge(next);

  if (turningOn) {
    // 等新勾选的页面全部注入完成后再广播开启提示
    if (nextActive.length) {
      await Promise.all(nextActive.map((t) => inject(t).catch(() => null)));
      broadcastToast(true, nextActive);
      systemNotify(true, nextActive.length);
    } else if (announce) {
      systemNotify(true, 0); // 无页面可提示，用系统通知提醒先勾选
    }
  }
}

// ---------------------------------------------------------------------------
// 切换提示：页面顶部提示条 + Windows 系统通知双通道
// ---------------------------------------------------------------------------

function broadcastToast(on, tabIds) {
  const msg = { type: 'mts:toast', on, count: tabIds.length };
  for (const t of tabIds) chrome.tabs.sendMessage(t, msg).catch(() => {});
}

function systemNotify(on, count) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: on ? '跨标签页操作同步助手：同步已开启' : '跨标签页操作同步助手：同步已关闭',
      message: on
        ? (count ? `${count} 个标签页将实时跟随你的操作；各页不同的字段（如编号）保持独立。`
                : '尚未勾选任何标签页：请点扩展图标，先勾选要同步的页面。')
        : '各标签页操作已恢复独立。',
      priority: 2,
    }, () => { void chrome.runtime.lastError; });
  } catch { /* 系统通知不可用时忽略，页面提示条为主 */ }
}

async function broadcastConfig(s = state) {
  const msg = { type: 'mts:config', excluded: s.opts.excluded, ghost: !!s.opts.ghost };
  for (const t of s.tabIds) chrome.tabs.sendMessage(t, msg).catch(() => {});
}

function updateBadge(s) {
  const n = s.tabIds.length;
  chrome.action.setBadgeText({ text: s.enabled && n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: s.opts.precision ? '#c2410c' : '#15803d' });
  chrome.action.setTitle({
    title: s.enabled
      ? `跨标签页操作同步助手：同步已开启（${n} 个标签页${s.opts.precision ? '，精确模式' : ''}）`
      : '跨标签页操作同步助手：同步已关闭',
  });
}

// ---------------------------------------------------------------------------
// 内容脚本注入
// ---------------------------------------------------------------------------
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    await setTabError(tabId, null);
    // 注入后下发当前字段隔离名单
    chrome.tabs.sendMessage(tabId, { type: 'mts:config', excluded: state.opts.excluded, ghost: !!state.opts.ghost }).catch(() => {});
  } catch (err) {
    await setTabError(tabId, err.message || String(err));
  }
}

function teardownTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'mts:teardown' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 精确模式（Chrome DevTools Protocol）
// ---------------------------------------------------------------------------
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    // Service Worker 重启后可能仍处于连接状态
    if (!/already attached/i.test(err.message)) {
      await setTabError(tabId, `精确模式：${err.message}`);
      throw err;
    }
  }
  attachedTabs.add(tabId);
  // 让页面表现为已获得焦点——键盘事件需要
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

function detachDebugger(tabId) {
  attachedTabs.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (tabId == null) return;
  attachedTabs.delete(tabId);
  // 用户点击了浏览器顶部黄色提示条里的"取消" -> 关闭精确模式
  if (reason === 'canceled_by_user') {
    updateState((s) => { s.opts.precision = false; });
  }
});

function cdpModifiers(m = {}) {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

async function preciseClick(tabId, ev) {
  const pt = await chrome.tabs.sendMessage(tabId, { type: 'mts:locate', event: ev }, { frameId: 0 }).catch(() => null);
  // 隐藏的标签页不会渲染 -> CDP 命中测试会过期，退回普通回放
  if (!pt || !pt.visible) return false;
  try {
    await attachDebugger(tabId);
    const base = { x: pt.x, y: pt.y, modifiers: cdpModifiers(ev.mods) };
    const clickCount = ev.detail || 1;
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', button: 'left', buttons: 1, clickCount });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', button: 'left', buttons: 0, clickCount });
    return true;
  } catch {
    return false;
  }
}

async function preciseKey(tabId, ev) {
  const m = ev.mods || {};
  const printable = ev.key.length === 1 && !m.ctrl && !m.meta;
  const text = printable ? ev.key : ev.key === 'Enter' ? '\r' : undefined;
  const params = {
    key: ev.key,
    code: ev.code,
    windowsVirtualKeyCode: ev.keyCode,
    nativeVirtualKeyCode: ev.keyCode,
    location: ev.location,
    isKeypad: ev.location === 3,
    autoRepeat: !!ev.repeat,
    modifiers: cdpModifiers(m),
  };
  if (ev.type === 'keyup') {
    params.type = 'keyUp';
  } else {
    params.type = text ? 'keyDown' : 'rawKeyDown';
    if (text) { params.text = text; params.unmodifiedText = text; }
    // Ctrl/Cmd+C/V/X/A/Z 通过 CDP 需要显式编辑器命令
    let cmd = (m.ctrl || m.meta) && EDIT_COMMANDS[ev.key.toLowerCase()];
    if (cmd === 'undo' && m.shift) cmd = 'redo';
    if (cmd) params.commands = [cmd];
  }
  try {
    await attachDebugger(tabId);
    await cdp(tabId, 'Input.dispatchKeyEvent', params);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 事件路由
// ---------------------------------------------------------------------------
async function handleEvent(ev, sender) {
  const s = await getState();
  const src = sender.tab?.id;
  if (!s.enabled || src == null || !s.tabIds.includes(src)) return;
  if (isQuiet(src)) return;
  if (!s.opts[CATEGORY[ev.kind]]) return;

  setLeader(src);
  if (ev.kind === 'scroll') ev.mode = s.opts.scrollMode;
  // 精确模式只用于来自顶层框架的事件（CDP 坐标基于主视口）
  const precise = s.opts.precision && sender.frameId === 0;

  for (const t of s.tabIds) {
    if (t === src) continue;
    enqueue(t, () => replayInto(t, ev, precise));
  }
}

function isQuiet(tabId) {
  return (inFlight.get(tabId) || 0) > 0 || Date.now() - (lastReplay.get(tabId) || 0) < REPLAY_QUIET_MS;
}

function enqueue(tabId, job) {
  inFlight.set(tabId, (inFlight.get(tabId) || 0) + 1);
  const prev = queues.get(tabId) || Promise.resolve();
  const next = prev
    .then(job)
    .catch((err) => console.debug('[跨标签页操作同步助手] 回放失败', tabId, err))
    .finally(() => {
      inFlight.set(tabId, inFlight.get(tabId) - 1);
      lastReplay.set(tabId, Date.now());
    });
  queues.set(tabId, next);
}

async function replayInto(tabId, ev, precise) {
  if (precise && ev.kind === 'click' && await preciseClick(tabId, ev)) return;
  if (precise && ev.kind === 'key' && await preciseKey(tabId, ev)) return;
  // 不指定 frameId：消息发给所有框架，匹配的框架按 FRAME_KEY 过滤
  await chrome.tabs.sendMessage(tabId, { type: 'mts:replay', event: ev }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 导航同步：相同路径（适合同一系统、同构页面的批量操作）
// ---------------------------------------------------------------------------
function pathOf(u) {
  return u.pathname + u.search + u.hash;
}

async function syncNavigation(srcTabId, url) {
  if (srcTabId !== leaderTabId || isQuiet(srcTabId)) return;
  let want;
  try { want = new URL(url); } catch { return; }
  if (!/^https?:$/.test(want.protocol)) return;

  // 稍等：回放的链接点击通常会让目标页自行跳转
  await new Promise((r) => setTimeout(r, NAV_DELAY_MS));
  const s = await getState();
  if (!s.enabled || !s.opts.nav) return;

  for (const t of s.tabIds) {
    if (t === srcTabId) continue;
    const tab = await chrome.tabs.get(t).catch(() => null);
    if (!tab) continue;
    let cur;
    try { cur = new URL(tab.pendingUrl || tab.url); } catch { continue; }
    if (!/^https?:$/.test(cur.protocol) || pathOf(cur) === pathOf(want)) continue;
    lastReplay.set(t, Date.now());
    chrome.tabs.update(t, { url: cur.origin + pathOf(want) }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 标签页生命周期
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const s = await getState();
  if (!s.enabled || !s.tabIds.includes(tabId)) return;
  // 新文档 -> 重新注入内容脚本（守卫防止重复）
  if (info.status === 'complete') inject(tabId);
  if (info.url && s.opts.nav) syncNavigation(tabId, info.url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attachedTabs.delete(tabId);
  queues.delete(tabId);
  inFlight.delete(tabId);
  lastReplay.delete(tabId);
  const s = await getState();
  if (s.tabIds.includes(tabId)) await updateState((n) => { n.tabIds = n.tabIds.filter((t) => t !== tabId); });
  await setTabError(tabId, null);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const s = await getState();
  if (!s.tabIds.includes(removedTabId)) return;
  await updateState((n) => { n.tabIds = n.tabIds.map((t) => (t === removedTabId ? addedTabId : t)); });
});

// 用户当前操作的标签页作为导航同步的"主导标签页"
async function leaderFromWindow(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const s = await getState();
  if (tab && s.tabIds.includes(tab.id)) setLeader(tab.id);
}

chrome.windows.onFocusChanged.addListener(leaderFromWindow);
chrome.tabs.onActivated.addListener(({ windowId }) => leaderFromWindow(windowId));

// ---------------------------------------------------------------------------
// 窗口并排排列
// ---------------------------------------------------------------------------
async function tileTabs(screen) {
  const { tabIds } = await getState();
  const n = tabIds.length;
  if (!n) return;
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  // 窗口尺寸给下限，防止小屏/页数多时生成过小窗口导致创建失败；
  // 越界位置钳回屏幕内
  const scrW = Math.max(screen.width || 1280, 480);
  const scrH = Math.max(screen.height || 720, 320);
  const width = Math.max(480, Math.floor(scrW / cols));
  const height = Math.max(320, Math.floor(scrH / rows));
  // 给系统边框/任务栏留余量，避免窗口尺寸与屏幕精确压线导致创建被拒
  const safeW = Math.max(320, Math.min(width, scrW - 16));
  const safeH = Math.max(240, Math.min(height, scrH - 16));

  for (let i = 0; i < n; i++) {
    const tabId = tabIds[i];
    const left = Math.min(screen.left + (i % cols) * safeW, screen.left + Math.max(0, scrW - safeW));
    const top = Math.min(screen.top + Math.floor(i / cols) * safeH, screen.top + Math.max(0, scrH - safeH));
    const bounds = { left, top, width: safeW, height: safeH };
    // 单个窗口失败不中断整体平铺（如系统拒绝某组边界值时，其余窗口照常排列）
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) continue;
      const win = await chrome.windows.get(tab.windowId, { populate: true });
      if (win.tabs.length === 1) {
        if (win.state !== 'normal') await chrome.windows.update(win.id, { state: 'normal' });
        await chrome.windows.update(win.id, bounds);
      } else {
        await chrome.windows.create({ tabId, ...bounds });
      }
    } catch (err) {
      console.debug('[跨标签页操作同步助手] 平铺单个窗口失败', tabId, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 字段隔离：点选模式
// ---------------------------------------------------------------------------
function setPicker(on) {
  pickerOn = on;
  const msg = { type: on ? 'mts:picker-on' : 'mts:picker-off' };
  for (const t of state.tabIds) chrome.tabs.sendMessage(t, msg).catch(() => {});
}

// ---------------------------------------------------------------------------
// 消息与快捷键
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'mts:event':
      handleEvent(msg.event, sender);
      return;
    case 'mts:refresh':
      // popup 改完状态后的刷新请求：runtime 消息必定唤醒空闲的 SW
      refresh().then(() => sendResponse(true)).catch(() => sendResponse({ error: 'refresh failed' }));
      return true;
    case 'mts:tile':
      tileTabs(msg.screen).then(() => sendResponse(true), (err) => sendResponse({ error: err.message }));
      return true;
    case 'mts:picker':
      // popup 请求开启/关闭点选模式
      setPicker(!!msg.on);
      sendResponse(true);
      return;
    case 'mts:pick': {
      // 内容脚本上报选中的字段
      if (msg.cancel) { setPicker(false); sendResponse(true); return; }
      if (msg.field?.key) {
        updateState((s) => {
          if (!s.opts.excluded.some((f) => f.key === msg.field.key)) {
            s.opts.excluded.push({ key: msg.field.key, label: msg.field.label || msg.field.key });
          }
        });
      }
      setPicker(false);
      sendResponse(true);
      return;
    }
    case 'mts:remove-excluded':
      updateState((s) => { s.opts.excluded = s.opts.excluded.filter((f) => f.key !== msg.key); });
      sendResponse(true);
      return;
    case 'mts:picker-status':
      sendResponse({ on: pickerOn });
      return;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'sync-on' || command === 'sync-off') {
    // Ctrl+1 开 / Ctrl+2 关；状态无变化时不重复提示
    const want = command === 'sync-on';
    const s = await getState();
    if (s.enabled === want) return;
    await updateState((st) => { st.enabled = want; });
  } else if (command === 'toggle-tab') {
    const active = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!active) return;
    // 注意：不做"够 2 个就自动开启"——开关必须手动打开（或 Ctrl+1），
    // 保证用户可以先把各标签页的编号填好再开始同步。
    await updateState((s) => {
      const adding = !s.tabIds.includes(active.id);
      s.tabIds = adding ? [...s.tabIds, active.id] : s.tabIds.filter((t) => t !== active.id);
    });
  }
});

ready.then(() => updateBadge(state));
