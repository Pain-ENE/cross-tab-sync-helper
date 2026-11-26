// 跨标签页操作同步助手（基于开源项目 aysner/Multi-Tab-Sync 修改）– Service Worker。
// 管理同步组、注入内容脚本、在标签页之间路由事件，
// 并管理"字段隔离"名单与点选模式。

importScripts('cursor-colors.js', 'clipboard-worker.js');
const cursorColors = globalThis.mtsCursorColors;

const DEFAULT_STATE = {
  revision: 0,
  enabled: false,
  tabIds: [],
  opts: {
    scroll: true,
    click: true,
    keys: true,
    nav: true,
    scrollMode: 'absolute', // 'absolute' | 'relative'
    precision: false,
    ghostColor: cursorColors.defaultColor,
    themeColor: cursorColors.defaultColor,
    ghost: true, // 镜像鼠标：在其他标签页显示主控页鼠标位置与动作
    excluded: [], // 不同步的字段：[{ key: 'name:xxx' | 'id:xxx', label: '显示名' }]
  },
};

const CATEGORY = { scroll: 'scroll', wheel: 'scroll', click: 'click', 'sheet-date': 'click', 'sheet-calendar': 'click', focus: 'click', key: 'keys', input: 'keys', change: 'keys', cursor: 'ghost', press: 'ghost', dragstart: 'click', dragmove: 'click', dragend: 'click', contextmenu: 'click' };

// 在某标签页回放事件后的一小段时间内忽略来自该页的事件，
// 防止回放引发的滚动、聚焦、输入等再次被广播出去（回环）。
const NAV_DELAY_MS = 400;
const CDP_VERSION = '1.3';

const lastReplay = new Map(); // tabId -> 最近一次回放完成时间
const queues = new Map();     // 每个目标页独立有序队列
const visualLanes = new Map(); // Cursor feedback must never delay a real action.
const attachedTabs = new Set();
let leaderTabId = null;
let pickerOn = false;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function normalize(s) {
  const opts = { ...DEFAULT_STATE.opts, ...(s?.opts || {}) };
  opts.ghostColor = cursorColors.normalize(opts.ghostColor);
  opts.themeColor = cursorColors.normalize(opts.themeColor);
  opts.excluded = Array.isArray(opts.excluded) ? opts.excluded : [];
  return { ...DEFAULT_STATE, ...s, opts, tabIds: s?.tabIds || [] };
}

let state = DEFAULT_STATE;
let syncRun = 0;
const ready = Promise.all([
  chrome.storage.session.get(['state', 'leader', 'receipts']),
  chrome.storage.local.get(['ghostColor', 'themeColor']).catch(() => ({})),
]).then(([r, saved]) => {
  state = normalize(r.state);
  state.opts.ghostColor = cursorColors.normalize(saved.ghostColor ?? state.opts.ghostColor);
  state.opts.themeColor = cursorColors.normalize(saved.themeColor ?? state.opts.themeColor);
  leaderTabId = state.tabIds.includes(r.leader) && state.enabled ? r.leader : null;
  if (state.enabled) {
    for (const id of state.tabIds) {
      const receipt = r.receipts?.[id];
      if (!receipt) continue;
      outcomes.set(id, receipt);
      eventSequence = Math.max(eventSequence, receipt.sequence);
    }
  }
});

async function getState() {
  await ready;
  return state;
}

// Popup 和快捷键提交变更指令，状态由 Service Worker 串行写入。
let stateWrites = Promise.resolve();
function updateState(mutate, opts = {}) {
  const run = stateWrites.then(async () => {
    const prev = await getState();
    const next = structuredClone(prev);
    mutate(next);
    if (next.tabIds.length < 2) next.enabled = false;
    if (prev.enabled !== next.enabled) {
      syncRun++;
      outcomes.clear();
      scheduleReceipts();
    }
    const normalized = normalize(next);
    normalized.revision = (prev.revision || 0) + 1;
    if (prev.opts.ghostColor !== normalized.opts.ghostColor || prev.opts.themeColor !== normalized.opts.themeColor) {
      await chrome.storage.local.set({
        ghostColor: normalized.opts.ghostColor,
        themeColor: normalized.opts.themeColor,
      });
    }
    await chrome.storage.session.set({ state: normalized });
    state = normalized;
    updateBadge(state);
    await reconcile(prev, state, opts.announce !== false);
    return state;
  });
  stateWrites = run.catch(() => {});
  return run;
}

function setLeader(tabId) {
  if (leaderTabId === tabId) return;
  leaderTabId = tabId;
  chrome.storage.session.set({ leader: tabId }).catch(() => {});
  broadcastLeader();
}

// 主控身份变更时通知所有参与页：新主控亮起绿色主控光环并开始
// 广播鼠标位置，其余页熄灭光环、停止广播（悬停划过不再改变绿鼠标）
async function broadcastLeader() {
  const s = await getState();
  if (!s.enabled) return;
  for (const t of s.tabIds) {
    chrome.tabs.sendMessage(t, { type: 'mts:leader', on: t === leaderTabId }).catch(() => {});
  }
}

const tabErrors = new Map();
function setTabError(tabId, message) {
  if (message) tabErrors.set(tabId, message);
  else tabErrors.delete(tabId);
}

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
  for (const t of prevActive) {
    if (!nextActive.includes(t)) {
      invalidate(t, true);
      availability.delete(t);
      setTabError(t, null);
      teardownTab(t);
    }
  }
  if (!nextActive.includes(leaderTabId)) setLeader(null);
  const injections = newActive.map((t) => inject(t));

  const prevDbg = prev.enabled && prev.opts.precision ? prev.tabIds : [];
  const nextDbg = next.enabled && next.opts.precision ? next.tabIds : [];
  for (const t of nextDbg) if (!prevDbg.includes(t)) attachDebugger(t).catch(() => {});
  for (const t of prevDbg) if (!nextDbg.includes(t)) detachDebugger(t);

  // 字段隔离名单 / 镜像鼠标开关有变化 -> 通知所有相关标签页
  if (JSON.stringify(prev.opts.excluded) !== JSON.stringify(next.opts.excluded)
      || !!prev.opts.ghost !== !!next.opts.ghost || prev.opts.ghostColor !== next.opts.ghostColor) {
    await broadcastConfig(next);
  }

  if (turningOn && announce) {
    // 等新勾选的页面全部注入完成后再广播开启提示
    if (nextActive.length) {
      await Promise.all(injections);
      broadcastToast(true, nextActive);
      systemNotify(true, nextActive.length);
    } else if (announce) {
      systemNotify(true, 0); // 无页面可提示，用系统通知提醒先勾选
    }
  }
  await Promise.all(injections);
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

function configFor(t, s = state) {
  return { type: 'mts:config', enabled: s.enabled, excluded: s.opts.excluded, ghost: !!s.opts.ghost, ghostColor: s.opts.ghostColor, leader: t === leaderTabId };
}

async function broadcastConfig(s = state) {
  await Promise.all(s.tabIds.map((t) =>
    deadline(chrome.tabs.sendMessage(t, configFor(t, s))).catch(() => {})));
}

function updateBadge(s) {
  const n = s.tabIds.length;
  chrome.action.setBadgeText({ text: s.enabled && n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: s.opts.precision ? '#9a471e' : '#39746c' });
  chrome.action.setTitle({
    title: s.enabled
      ? `跨标签页操作同步助手：同步已开启（${n} 个标签页${s.opts.precision ? '，精确模式' : ''}）`
      : '跨标签页操作同步助手：同步已关闭',
  });
}

// ---------------------------------------------------------------------------
// 内容脚本注入
// ---------------------------------------------------------------------------
function pageAvailability(tab) {
  if (tab.discarded) return 'discarded';
  if (tab.frozen) return 'frozen';
  if (tab.status === 'loading') return 'loading';
  return null;
}

function inject(tabId, allowPaused = false) {
  if (preparing.has(tabId)) return preparing.get(tabId);
  const version = generation(tabId);
  const script = (allFrames) => deadline(chrome.scripting.executeScript({
    target: { tabId, allFrames }, files: ['cursor-colors.js', 'content.js'],
  }));
  const task = (async () => {
    const tab = await chrome.tabs.get(tabId);
    const problem = pageAvailability(tab);
    if (problem) {
      if (generation(tabId) === version) {
        routes.delete(tabId);
        availability.set(tabId, problem);
      }
      return;
    }
    let results;
    try { results = await script(true); }
    catch (error) {
      if (error.message === 'timeout') throw error;
      results = await script(false);
    }
    if (generation(tabId) !== version || !state.tabIds.includes(tabId) ||
        (!state.enabled && !allowPaused)) return;
    const frames = new Map(results.filter((r) => typeof r.result === 'string')
      .map((r) => [r.result, { frameId: r.frameId, documentId: r.documentId }]));
    if (!frames.has('top')) throw new Error('页面脚本未就绪');
    await Promise.all([...frames.values()].map((frame) =>
      toFrame(tabId, frame, configFor(tabId)).catch((error) => {
        if (frame.frameId === 0) throw error;
      })));
    if (generation(tabId) !== version) return;
    routes.set(tabId, frames);
    availability.delete(tabId);
    setTabError(tabId, null);
  })().catch((error) => {
    if (generation(tabId) === version) setTabError(tabId, error.message);
  }).finally(() => {
    if (preparing.get(tabId) === task) preparing.delete(tabId);
  });
  preparing.set(tabId, task);
  return task;
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

async function preciseClick(tabId, ev, point) {
  const base = { x: point.x, y: point.y, modifiers: cdpModifiers(ev.mods), button: 'left', clickCount: 1 };
  await deadline(cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }), 320);
  await deadline(cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }), 320);
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
  await cdp(tabId, 'Input.dispatchKeyEvent', params);
}

// ---------------------------------------------------------------------------
// 事件路由
// ---------------------------------------------------------------------------
const routes = new Map();
const preparing = new Map();
const generations = new Map();
const availability = new Map();
const outcomes = new Map();
const MAX_PENDING = 48;
const DELIVERY_MS = 700;
const MAX_EVENT_AGE = 1600;
const deliveryEpoch = Date.now();
let eventSequence = 0;
let receiptTimer;
function scheduleReceipts() {
  if (receiptTimer) return;
  receiptTimer = setTimeout(() => {
    receiptTimer = null;
    chrome.storage.session.set({ receipts: Object.fromEntries(outcomes) }).catch(() => {});
  }, 250);
}

function generation(tabId) {
  return generations.get(tabId) || 0;
}

function invalidate(tabId, clearOutcome = false) {
  generations.set(tabId, generation(tabId) + 1);
  routes.delete(tabId);
  preparing.delete(tabId);
  for (const item of queues.get(tabId) || []) item.finish?.('expired');
  queues.delete(tabId);
  visualLanes.delete(tabId);
  if (clearOutcome && outcomes.delete(tabId)) scheduleReceipts();
}

function deadline(promise, ms = DELIVERY_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function canReplay(tabId, item) {
  return state.enabled && state.tabIds.includes(tabId) &&
    state.tabIds.includes(item.source) && generation(tabId) === item.generation &&
    syncRun === item.run && (item.event.kind === 'paste'
      ? generation(item.source) === item.sourceGeneration : !!state.opts[CATEGORY[item.event.kind]]);
}

function report(tabId, item, code) {
  if (isVisual(item.event) || !canReplay(tabId, item)) return;
  const previous = outcomes.get(tabId);
  if (previous && previous.sequence > item.sequence) return;
  const latency = Date.now() - (item.capturedAt ?? item.queuedAt);
  outcomes.set(tabId, {
    code, latency, sequence: item.sequence, at: Date.now(), kind: item.event.kind,
    transportMs: item.queuedAt - (item.capturedAt ?? item.queuedAt),
    queueMs: (item.startedAt ?? item.queuedAt) - item.queuedAt,
    applyMs: Date.now() - (item.startedAt ?? item.queuedAt),
    missed: (previous?.missed || 0) + (code === 'applied' || code === 'isolated' ? 0 : 1),
  });
  scheduleReceipts();
}

function isVisual(ev) {
  return ev.kind === 'cursor' || ev.kind === 'press' || ev.kind === 'focus' ||
    ev.kind === 'dragmove' || (ev.kind === 'key' && ev.type === 'keyup');
}

function replaceable(ev) {
  return ['cursor', 'dragmove', 'scroll'].includes(ev.kind);
}

async function handleEvent(ev, sender) {
  const s = await getState();
  const src = sender.tab?.id;
  if (!ev || !s.enabled || !s.tabIds.includes(src) || !s.opts[CATEGORY[ev.kind]]) return;
  if (ev.kind === 'cursor') {
    if (src !== leaderTabId) return;
  } else {
    setLeader(src);
  }
  if (ev.kind === 'scroll') ev.mode = s.opts.scrollMode;
  const queuedAt = Date.now();
  const capturedAt = Number.isFinite(ev.sentAt) && ev.sentAt <= queuedAt && ev.sentAt >= queuedAt - MAX_EVENT_AGE
    ? ev.sentAt : queuedAt;
  const item = {
    event: ev, source: src, precise: s.opts.precision && sender.frameId === 0,
    queuedAt, capturedAt, sequence: ++eventSequence, run: syncRun,
  };
  for (const tabId of s.tabIds) {
    if (tabId === src) continue;
    const target = { ...item, generation: generation(tabId) };
    if (ev.kind === 'cursor' || ev.kind === 'press') enqueueVisual(tabId, target);
    else enqueue(tabId, target);
  }
}

// One in-flight update and one latest position per frame, independent of action queues.
// Use cached routes only: decorative traffic must not trigger injection or retries.
function enqueueVisual(tabId, item) {
  const route = routes.get(tabId)?.get(item.event.frame);
  if (!route || availability.has(tabId)) return;
  let frames = visualLanes.get(tabId);
  if (!frames) visualLanes.set(tabId, frames = new Map());
  let lane = frames.get(item.event.frame);
  if (lane) { lane.latest = item; return; }
  lane = { latest: item };
  frames.set(item.event.frame, lane);
  void (async () => {
    try {
      while (visualLanes.get(tabId) === frames && lane.latest) {
        const next = lane.latest;
        lane.latest = null;
        if (!canReplay(tabId, next) || next.source !== leaderTabId || Date.now() - next.queuedAt > 150) continue;
        await toFrame(tabId, route, { type: 'mts:replay', event: {
          ...next.event, sequence: next.sequence, epoch: deliveryEpoch, deadline: Date.now() + 150,
        } }, 150).catch(() => {});
      }
    } finally {
      if (visualLanes.get(tabId) === frames) {
        frames.delete(item.event.frame);
        if (!frames.size) visualLanes.delete(tabId);
      }
    }
  })();
}

function enqueue(tabId, item) {
  let queue = queues.get(tabId);
  if (!queue) {
    queue = [];
    queues.set(tabId, queue);
    queue.push(item);
    void drain(tabId, queue);
    return;
  }
  const last = queue.at(-1);
  if (last && replaceable(item.event) && last.source === item.source &&
      last.event.kind === item.event.kind && last.event.frame === item.event.frame &&
      last.event.sel === item.event.sel) {
    queue[queue.length - 1] = item;
    return;
  }
  if (item.event.kind === 'cursor' && queue.length) return;
  if (queue.length >= MAX_PENDING) {
    const index = queue.findIndex((entry) => isVisual(entry.event));
    if (index >= 0 && !isVisual(item.event)) queue.splice(index, 1);
    else {
      report(tabId, item, 'busy');
      item.finish?.('busy');
      return;
    }
  }
  queue.push(item);
}

async function drain(tabId, queue) {
  while (queues.get(tabId) === queue && queue.length) {
    const item = queue.shift();
    item.startedAt = Date.now();
    let status = !canReplay(tabId, item) || Date.now() - item.queuedAt > MAX_EVENT_AGE
      ? 'expired' : availability.get(tabId);
    if (!status) {
      try {
        status = await replayInto(tabId, item);
      } catch (error) {
        status = error.message === 'timeout' ? 'timeout' : 'disconnected';
      }
    }
    report(tabId, item, status === 'handled' ? 'applied' : status);
    item.finish?.(status);
  }
  if (queues.get(tabId) === queue) queues.delete(tabId);
}

function toFrame(tabId, route, msg, ms) {
  const options = route.documentId ? { documentId: route.documentId } : { frameId: route.frameId };
  return deadline(chrome.tabs.sendMessage(tabId, msg, options), ms);
}

async function replayInto(tabId, item) {
  const ev = item.event;
  let route = routes.get(tabId)?.get(ev.frame);
  if (!route) {
    // Missing iframe may have been mounted after top-document load.
    if (isVisual(ev) && routes.has(tabId)) return 'missing-frame';
    await inject(tabId);
    if (!canReplay(tabId, item)) return 'expired';
    route = routes.get(tabId)?.get(ev.frame);
  }
  if (!route) return availability.get(tabId) || (routes.has(tabId) ? 'missing-frame' : 'disconnected');
  const remaining = MAX_EVENT_AGE - (Date.now() - item.queuedAt);
  if (remaining <= 0 || !canReplay(tabId, item)) return 'expired';
  const message = {
    type: 'mts:replay',
    event: { ...ev, sequence: item.sequence, epoch: deliveryEpoch, deadline: Date.now() + Math.min(remaining, DELIVERY_MS) },
  };
  try {
    if (ev.kind === 'click' || (ev.kind === 'key' && ev.key === 'Enter')) {
      lastReplay.set(tabId, Date.now());
    }
    // Native selects replay their committed value instead of opening a browser picker.
    if (item.precise && ((ev.kind === 'key' && !ev.nativeSelect) ||
        (ev.kind === 'click' && ev.detail < 2 && ev.targetTag !== 'select') ||
        (ev.kind === 'input' && ev.ins) || (ev.kind === 'wheel' && ev.deltaMode === 0))) {
      const status = await preciseReplay(tabId, route, item);
      if (status) return status;
      if (!canReplay(tabId, item)) return 'expired';
    }
    if (Date.now() >= message.event.deadline || !canReplay(tabId, item)) return 'expired';
    return await toFrame(tabId, route, message, message.event.deadline - Date.now()) || 'disconnected';
  } catch (error) {
    // 下一项会重新探测。当前动作可能已经执行，不能补发点击。
    if (error.message !== 'timeout') routes.delete(tabId);
    throw error;
  }
}

async function preciseReplay(tabId, route, item) {
  const ev = item.event;
  // 输入事件会回放实际文本；避免 CDP 在富文本中把同一个字符插入两次。
  if (ev.kind === 'key' && ev.editable && ev.key.length === 1 &&
      !ev.mods?.ctrl && !ev.mods?.meta && !ev.mods?.alt) return null;
  let point;
  try {
    if (ev.kind === 'click' || ev.kind === 'wheel') {
      point = await toFrame(tabId, route, { type: 'mts:locate', event: ev });
      if (!point?.visible) return null;
    } else if (!(await toFrame(tabId, route, { type: 'mts:precision-target', event: ev }))) {
      return null;
    }
    await deadline(attachDebugger(tabId));
    if (!canReplay(tabId, item) || Date.now() - item.queuedAt > MAX_EVENT_AGE) return 'expired';
  } catch { return null; }
  const token = item.sequence;
  try {
    await toFrame(tabId, route, { type: 'mts:quiet', token, ms: DELIVERY_MS + 200, wheel: ev.kind === 'wheel' });
    if (!canReplay(tabId, item) || Date.now() - item.queuedAt > MAX_EVENT_AGE) return 'expired';
    if (ev.kind === 'click') await deadline(preciseClick(tabId, ev, point));
    else if (ev.kind === 'key') await deadline(preciseKey(tabId, ev));
    else if (ev.kind === 'wheel') {
      await deadline(cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: point.x, y: point.y, deltaX: ev.deltaX,
        deltaY: ev.deltaY, modifiers: cdpModifiers(ev.mods),
      }));
    } else await deadline(cdp(tabId, 'Input.insertText', { text: ev.ins }));
    return 'applied';
  } catch (error) {
    return error.message === 'timeout' ? 'timeout' : 'failed';
  } finally {
    chrome.tabs.sendMessage(tabId, { type: 'mts:unquiet', token }, { frameId: 0 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 导航同步：相同路径（适合同一系统、同构页面的批量操作）
// ---------------------------------------------------------------------------
function pathOf(u) {
  return u.pathname + u.search + u.hash;
}

let navSequence = 0;
async function syncNavigation(srcTabId, url) {
  if (srcTabId !== leaderTabId || Date.now() - (lastReplay.get(srcTabId) || 0) < NAV_DELAY_MS) return;
  const run = syncRun;
  const token = ++navSequence;
  let want;
  try { want = new URL(url); } catch { return; }
  if (!/^https?:$/.test(want.protocol)) return;

  // 稍等：回放的链接点击通常会让目标页自行跳转
  await new Promise((r) => setTimeout(r, NAV_DELAY_MS));
  const s = await getState();
  if (!s.enabled || !s.opts.nav || token !== navSequence || run !== syncRun || leaderTabId !== srcTabId) return;

  for (const t of s.tabIds) {
    if (t === srcTabId) continue;
    const tab = await chrome.tabs.get(t).catch(() => null);
    if (!tab || pageAvailability(tab) || token !== navSequence || run !== syncRun || leaderTabId !== srcTabId || !state.tabIds.includes(t)) continue;
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
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const s = await getState();
  if (!s.enabled || !s.tabIds.includes(tabId)) return;
  if ('status' in info || 'frozen' in info || 'discarded' in info) {
    const problem = pageAvailability(tab);
    if (problem) {
      if (availability.get(tabId) !== problem) invalidate(tabId);
      availability.set(tabId, problem);
    } else {
      availability.delete(tabId);
      void inject(tabId);
    }
  }
  if (info.url && s.opts.nav) void syncNavigation(tabId, info.url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attachedTabs.delete(tabId);
  invalidate(tabId, true);
  availability.delete(tabId);
  lastReplay.delete(tabId);
  setTabError(tabId, null);
  const s = await getState();
  if (s.tabIds.includes(tabId)) await updateState((n) => { n.tabIds = n.tabIds.filter((t) => t !== tabId); });
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const s = await getState();
  if (!s.tabIds.includes(removedTabId)) return;
  await updateState((n) => { n.tabIds = n.tabIds.map((t) => (t === removedTabId ? addedTabId : t)); });
});

// 用户当前操作的标签页作为导航同步的"主导标签页"
let focusChange = 0;
async function leaderFromWindow(windowId) {
  const change = ++focusChange;
  if (tileTask || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tabs, window, s] = await Promise.all([
    chrome.tabs.query({ active: true, windowId }).catch(() => []),
    chrome.windows.get(windowId).catch(() => null),
    getState(),
  ]);
  const tab = tabs[0];
  if (change === focusChange && !tileTask && window?.focused && tab && s.tabIds.includes(tab.id)) {
    setLeader(tab.id);
  }
}

chrome.windows.onFocusChanged.addListener(leaderFromWindow);
chrome.tabs.onActivated.addListener(({ windowId }) => leaderFromWindow(windowId));

// ---------------------------------------------------------------------------
// 窗口并排排列
// ---------------------------------------------------------------------------
let tileTask = null;
function tileTabs(screen, sourceTab) {
  if (!tileTask) {
    focusChange++;
    tileTask = arrangeTiles(screen, sourceTab).finally(() => { tileTask = null; });
  }
  return tileTask;
}

async function arrangeTiles(screen, sourceTab) {
  const { tabIds } = await getState();
  const n = tabIds.length;
  if (!n) return;
  const leader = leaderTabId;
  if (!sourceTab) {
    [sourceTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  }
  // 画布先与所在显示器的工作区求交集：主窗口被拖出屏幕、DPI 混合缩放或多显示器
  // 负坐标时，按画布直接算出的子窗口 bounds 可能超出可用区——浏览器会拒绝整套
  // 坐标，导致所有新窗口叠在默认位置。钳制进工作区后请求始终合法。
  try {
    const displays = await chrome.system.display.getAll();
    let best = null, bestArea = 0;
    for (const d of displays) {
      const wa = d.workArea;
      const ix = Math.max(0, Math.min(screen.left + screen.width, wa.left + wa.width) - Math.max(screen.left, wa.left));
      const iy = Math.max(0, Math.min(screen.top + screen.height, wa.top + wa.height) - Math.max(screen.top, wa.top));
      if (ix * iy > bestArea) { bestArea = ix * iy; best = wa; }
    }
    if (best) {
      const l = Math.max(screen.left, best.left);
      const t = Math.max(screen.top, best.top);
      const r = Math.min(screen.left + screen.width, best.left + best.width);
      const b = Math.min(screen.top + screen.height, best.top + best.height);
      // 交集太小（如窗口大部分在屏外）时保留原画布，避免生成过小窗口
      if (r - l >= 480 && b - t >= 320) screen = { left: l, top: t, width: r - l, height: b - t };
    }
  } catch { /* 拿不到显示器信息时按原画布计算，不阻断平铺 */ }
  // Chromium 在 Windows 的最小窗口宽约 500px：低于它窗口会被钳到最小宽甚至整套拒绝，
  // 导致同列窗口叠压。列数按“画布能容纳几个最小宽窗口”钳制，放不下时自动改竖排
  const MIN_W = 520;
  const scrW = Math.max(screen.width || 1280, 480);
  const scrH = Math.max(screen.height || 720, 320);
  const maxCols = Math.max(1, Math.floor(scrW / MIN_W));
  const cols = Math.min(n <= 3 ? n : Math.ceil(Math.sqrt(n)), maxCols);
  const rows = Math.ceil(n / cols);
  // 窗口尺寸给下限，防止小屏/页数多时生成过小窗口导致创建失败；
  // 越界位置钳回屏幕内
  const width = Math.max(MIN_W, Math.floor(scrW / cols));
  const height = Math.max(320, Math.floor(scrH / rows));
  // 给系统边框/任务栏留余量，避免窗口尺寸与屏幕精确压线导致创建被拒
  const safeW = Math.max(320, Math.min(width, scrW - 16));
  const safeH = Math.max(240, Math.min(height, scrH - 16));

  const placed = new Map();
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
        placed.set(tabId, win.id);
      } else {
        const created = await chrome.windows.create({ tabId, ...bounds, focused: false });
        // create 的 bounds 在部分环境（最小窗宽限制、窗口超出屏幕、虚拟显示）会被整套忽略，
        // 窗口落到默认位置尺寸；实测 update 对已存在窗口的摆位宽容得多。
        // create 负责拆窗、update 负责摆位，两步配合保证窗口真正各就各位
        if (!Number.isInteger(created?.id)) continue;
        placed.set(tabId, created.id);
        await chrome.windows.update(created.id, bounds);
      }
    } catch (err) {
      console.debug('[跨标签页操作同步助手] 平铺单个窗口失败', tabId, err.message);
    }
  }

  // 顺次提升窗口的 Z 顺序。并发提交焦点请求会使最后一个前台窗口不可预测。
  if (!placed.size) throw new Error('无法排列所选窗口');
  const primary = [leader, sourceTab?.id].find((id) => placed.has(id)) ?? placed.keys().next().value;
  const order = [...placed.keys()].filter((id) => id !== primary).concat(primary);
  let focusedTabId;
  for (const id of order) {
    try {
      await chrome.windows.update(placed.get(id), { focused: true });
      focusedTabId = id;
    } catch (err) {
      console.debug('[跨标签页操作同步助手] 窗口无法置前', id, err.message);
    }
  }
  if (focusedTabId == null) throw new Error('无法激活所选窗口');
  if ((await getState()).tabIds.includes(focusedTabId)) setLeader(focusedTabId);
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
    case 'mts:paste-from-popup':
      if (sender.url !== chrome.runtime.getURL('popup.html')) return;
      chrome.tabs.query({ active: true, currentWindow: true })
        .then(([tab]) => requestPaste(msg.mode, tab))
        .then(sendResponse, () => sendResponse({ error: '粘贴失败。' }));
      return true;
    case 'mts:paste-shortcut':
      if (sender.tab?.id != null) {
        void runPasteAction(msg.mode, sender.tab, { frameId: sender.frameId });
      }
      return;
    case 'mts:clear-clipboard':
      if (sender.tab?.id != null) void requestClipboardClear(sender.tab.id);
      return;
    case 'mts:event':
      void handleEvent(msg.event, sender);
      return;
    case 'mts:diagnostics':
      getState().then(() => sendResponse({
        state,
        leader: state.enabled ? leaderTabId : null,
        ready: [...routes.keys()],
        availability: Object.fromEntries(availability),
        outcomes: Object.fromEntries(outcomes),
        errors: Object.fromEntries(tabErrors),
      }));
      return true;
    case 'mts:update':
      updateState((s) => {
        if (typeof msg.enabled === 'boolean') s.enabled = msg.enabled && s.tabIds.length >= 2;
        if (msg.option && msg.option !== 'excluded' && Object.prototype.hasOwnProperty.call(DEFAULT_STATE.opts, msg.option)) {
          s.opts[msg.option] = msg.value;
        }
        if (Array.isArray(msg.add)) s.tabIds = [...new Set([...s.tabIds, ...msg.add.filter(Number.isInteger)])];
        if (Number.isInteger(msg.remove)) s.tabIds = s.tabIds.filter((id) => id !== msg.remove);
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    case 'mts:tile':
      tileTabs(msg.screen).then(() => sendResponse(true), (err) => sendResponse({ error: err.message }));
      return true;
    case 'mts:picker':
      // popup 请求开启/关闭点选模式
      getState().then(async (s) => {
        if (msg.on) await Promise.all(s.tabIds.map((tabId) => inject(tabId, true)));
        setPicker(!!msg.on);
        return { on: pickerOn };
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
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
      updateState((s) => { s.opts.excluded = s.opts.excluded.filter((f) => f.key !== msg.key); })
        .then(() => sendResponse(true), (error) => sendResponse({ error: error.message }));
      return true;
    case 'mts:check':
      getState().then((s) => Promise.all(s.tabIds.map((tabId) => inject(tabId, true))))
        .then(() => sendResponse(true), () => sendResponse(false));
      return true;
    case 'mts:picker-status':
      sendResponse({ on: pickerOn });
      return;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'clear-clipboard') {
    await requestClipboardClear(tab?.id);
  } else if (command === 'paste-all' || command === 'paste-lines') {
    const active = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (active) await runPasteAction(command === 'paste-all' ? 'all' : 'lines', active);
  } else if (command === 'sync-on' || command === 'sync-off') {
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
  } else if (command === 'tile') {
    // Alt+Shift+S：一键把勾选的标签页并排平铺。
    // 以当前主窗口区域为基准铺网格——页面缩放或窗口挪动后视野受限时，
    // 不用回到弹窗点按钮，直接按快捷键以当前窗口为画布重排
    const win = await chrome.windows.getLastFocused().catch(() => null);
    if (!win) return;
    await tileTabs({ left: win.left || 0, top: win.top || 0, width: win.width || 1280, height: win.height || 720 }, tab)
      .catch((err) => console.debug('[跨标签页操作同步助手] 快捷键平铺失败', err.message));
  }
});

ready.then(() => updateBadge(state));
