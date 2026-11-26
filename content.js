// 跨标签页操作同步助手（基于开源项目 aysner/Multi-Tab-Sync 修改）– content script。
// 由 Service Worker 注入到同步组各标签页的每个框架。
// 捕获真实用户事件（isTrusted）并把其他标签页发来的事件在本地回放。

(() => {
  if (window.__archiveSyncHelper) return window.__archiveSyncHelper;

  const ac = new AbortController();
  const { signal } = ac;

  // ---------------------------------------------------------------------------
  // 框架标识：各标签页的 frameId 不同，用嵌套深度+路径对应
  // ---------------------------------------------------------------------------
  const FRAME_KEY = (() => {
    if (window === window.top) return 'top';
    const positions = [];
    for (let frame = window; frame !== frame.top; frame = frame.parent) {
      const parent = frame.parent;
      let index = 0;
      while (index < parent.length && parent[index] !== frame) index++;
      positions.unshift(index);
    }
    return positions.join('.') + ':' + location.pathname;
  })();

  // ---------------------------------------------------------------------------
  // 选择器（含 Shadow DOM，用 " >>> " 分隔）
  // ---------------------------------------------------------------------------
  const SHADOW_SEP = ' >>> ';
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

  function isStableId(id) {
    if (!id) return false;
    // 跳过自动生成的 id（React useId、Ember、哈希、长数字）
    return !/^\d|:|^(ember|react|radix|headlessui|mui|rc-|cdk-|mat-)|\d{4,}|[a-f0-9]{8,}/i.test(id);
  }

  function segment(el) {
    const tag = el.localName;
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) return { sel: `${tag}[${attr}="${CSS.escape(v)}"]`, anchor: true };
    }
    if (isStableId(el.id)) return { sel: `#${CSS.escape(el.id)}`, anchor: true };
    const name = el.getAttribute('name');
    if (name && /^(input|select|textarea|button|form)$/.test(tag)) {
      return { sel: `${tag}[name="${CSS.escape(name)}"]`, anchor: true };
    }
    const parent = el.parentElement;
    if (!parent) return { sel: tag, anchor: false };
    const same = Array.from(parent.children).filter((c) => c.localName === tag);
    if (same.length > 1) return { sel: `${tag}:nth-of-type(${same.indexOf(el) + 1})`, anchor: false };
    return { sel: tag, anchor: false };
  }

  function pathWithinRoot(el) {
    const root = el.getRootNode();
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const seg = segment(cur);
      parts.unshift(seg.sel);
      if (seg.anchor) {
        try {
          if (root.querySelectorAll(parts.join(' > ')).length === 1) break;
        } catch { /* 无效选择器 -> 继续向上 */ }
      }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const segs = [];
    let cur = el;
    for (;;) {
      segs.unshift(pathWithinRoot(cur));
      const root = cur.getRootNode();
      if (root instanceof ShadowRoot) cur = root.host;
      else break;
    }
    return segs.join(SHADOW_SEP);
  }

  function resolveSelector(sel) {
    if (!sel) return null;
    let root = document;
    let el = null;
    for (const part of sel.split(SHADOW_SEP)) {
      if (!root) return null;
      try { el = root.querySelector(part); } catch { return null; }
      if (!el) return null;
      root = el.shadowRoot;
    }
    return el;
  }

  function elementAtViewportRatio(vx, vy) {
    if (vx == null || vy == null) return null;
    let el = document.elementFromPoint(vx * innerWidth, vy * innerHeight);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(vx * innerWidth, vy * innerHeight);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function eventTarget(e) {
    const path = e.composedPath();
    return path.length ? path[0] : e.target;
  }

  function mods(e) {
    return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
  }

  function isSensitive(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === 'password') return true;
    const acv = (el.autocomplete || '').toLowerCase();
    return acv.includes('one-time-code') || acv.startsWith('cc-') || acv.includes(' cc-');
  }

  function isEditable(el) {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);
  }

  function editingHost(el) {
    if (!isEditable(el)) return null;
    return el.isContentEditable ? el.closest('[contenteditable]:not([contenteditable="false"])') || el : el;
  }

  // ---------------------------------------------------------------------------
  // 镜像鼠标（ghost cursor，Apple 风格）：
  // 在其他标签页上显示主控页鼠标的位置与动作，方便平铺核对时
  // 一眼看到主控窗口正在哪里操作。可选颜色的渐变箭头 + 白描边 +
  // 柔光晕，与系统真实鼠标（黑箭头、无光晕）明显区分。
  // 主控身份由 Service Worker 下发：只有当前主控页广播鼠标位置，
  // 其他页的悬停划过不会引起绿鼠标跳动——点击/滚动/键盘才接管主控；
  // 主控页四边亮绿色主控光环，切换瞬间一眼可辨。
  // 绿鼠标与光环均不产生事件（pointer-events:none），不会造成回环。
  // ---------------------------------------------------------------------------
  const cursorColors = globalThis.mtsCursorColors;
  let ghostColor = cursorColors.normalize();
  let ghostOn = true;         // 由 Service Worker 下发的镜像开关
  let leaderSelf = false;     // 本页是否为当前主控（决定是否广播鼠标位置）
  let ghostEl = null;
  let ghostStyleEl = null;
  let ghostTimer = 0;
  let lastCursorSent = 0;

  function applyGhostColor(el) {
    const color = cursorColors.appearance(ghostColor);
    el.style.setProperty('--mts-ghost-light', color.light);
    el.style.setProperty('--mts-ghost-dark', color.dark);
    el.style.setProperty('--mts-ghost-rgb', color.rgb);
  }

  function ensureGhostStyle() {
    if (ghostStyleEl) return;
    ghostStyleEl = document.createElement('style');
    ghostStyleEl.textContent = `
      .mts-ghost-cursor { position: fixed; left: 0; top: 0; z-index: 2147483645;
        pointer-events: none; opacity: 0;
        transition: opacity .3s cubic-bezier(.28,.11,.32,1); will-change: transform; }
      .mts-ghost-cursor svg { display: block;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)) drop-shadow(0 0 9px rgba(var(--mts-ghost-rgb),.55));
        transition: transform .1s cubic-bezier(.28,.11,.32,1), filter .1s cubic-bezier(.28,.11,.32,1); }
      .mts-ghost-cursor.pressed svg { transform: scale(.78);
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)) drop-shadow(0 0 5px rgba(var(--mts-ghost-rgb),.45)) brightness(.92); }
      @keyframes mts-ghost-ripple { from { transform: scale(.35); opacity: .9; }
        to { transform: scale(2.3); opacity: 0; } }
      .mts-ghost-ripple { position: fixed; z-index: 2147483644; pointer-events: none;
        width: 40px; height: 40px; margin: -20px 0 0 -7px; border-radius: 50%;
        background: radial-gradient(circle, rgba(var(--mts-ghost-rgb),.38) 0%, rgba(var(--mts-ghost-rgb),.14) 55%, rgba(var(--mts-ghost-rgb),0) 72%);
        box-shadow: 0 0 14px rgba(var(--mts-ghost-rgb),.35);
        animation: mts-ghost-ripple .5s cubic-bezier(.28,.11,.32,1) forwards; }`;
    document.documentElement.appendChild(ghostStyleEl);
  }

  function ensureGhost() {
    if (ghostEl) return ghostEl;
    ensureGhostStyle();
    ghostEl = document.createElement('div');
    ghostEl.className = 'mts-ghost-cursor';
    applyGhostColor(ghostEl);
    // Apple 风格指针：渐变填充 + 白描边 + 同色光晕，
    // 与系统真实鼠标（黑箭头白边、无光晕）在深浅页面上都一眼可辨。
    // 渐变 id 加随机后缀，避免同页多框架注入时互相冲突。
    const gradId = 'mts-ghost-grad-' + Math.random().toString(36).slice(2, 8);
    ghostEl.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style="stop-color:var(--mts-ghost-light)"/>
          <stop offset="1" style="stop-color:var(--mts-ghost-dark)"/>
        </linearGradient>
      </defs>
      <path d="M5.5 2.2 L5.5 20.5 c0 .5.55.72.87.38 l4.4-4.7 a.5.5 0 0 1 .38-.17 l4.9.15
               c.4 0 .6-.5.33-.8 L6.9 2.05 a.5.5 0 0 0-.9.15 z"
        fill="url(#${gradId})" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
    document.documentElement.appendChild(ghostEl);
    return ghostEl;
  }

  function showGhost(vx, vy, pressed, click) {
    const el = ensureGhost();
    const x = Math.max(0, Math.min((vx ?? 0) * innerWidth, innerWidth - 1));
    const y = Math.max(0, Math.min((vy ?? 0) * innerHeight, innerHeight - 1));
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.opacity = '1';
    el.classList.toggle('pressed', !!pressed);
    if (click) {
      const ripple = document.createElement('div');
      ripple.className = 'mts-ghost-ripple';
      applyGhostColor(ripple);
      ripple.style.left = x + 'px';
      ripple.style.top = y + 'px';
      document.documentElement.appendChild(ripple);
      setTimeout(() => ripple.remove(), 500);
    }
    clearTimeout(ghostTimer);
    // 按住（左键未松开）时常显不淡出：长按不动也能看到绿鼠标的按住状态，
    // 直到 press(on:false) 到达后再启动淡出
    if (!pressed) ghostTimer = setTimeout(() => { if (ghostEl) ghostEl.style.opacity = '0'; }, 1500);
  }

  function removeGhost() {
    clearTimeout(ghostTimer);
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    if (ghostStyleEl) { ghostStyleEl.remove(); ghostStyleEl = null; }
  }

  // ---------------------------------------------------------------------------
  // 主控光环（leader ring，Apple focus ring 风格）：
  // 同步开启时，主控窗口四边显示一圈柔和的绿色光环。主控切换瞬间
  // 旧窗口光环熄灭、新窗口亮起，与"没有绿鼠标的窗口就是主控"
  // 形成双重确认，消除切换瞬间的歧义。仅顶层框架渲染。
  // ---------------------------------------------------------------------------
  let leaderRingEl = null;
  let leaderStyleEl = null;

  function ensureLeaderStyle() {
    if (leaderStyleEl) return;
    leaderStyleEl = document.createElement('style');
    leaderStyleEl.textContent = `
      .mts-leader-ring { position: fixed; inset: 0; z-index: 2147483643;
        pointer-events: none; opacity: 0; transition: opacity .35s cubic-bezier(.28,.11,.32,1); }
      .mts-leader-ring::before { content: ""; position: absolute; inset: 0;
        box-shadow: inset 0 0 0 2px rgba(52,199,89,.8), inset 0 0 18px rgba(52,199,89,.14); }
      .mts-leader-ring.on { opacity: 1; }`;
    document.documentElement.appendChild(leaderStyleEl);
  }

  function setLeaderRing(on) {
    if (on) {
      ensureLeaderStyle();
      if (!leaderRingEl) {
        leaderRingEl = document.createElement('div');
        leaderRingEl.className = 'mts-leader-ring';
        document.documentElement.appendChild(leaderRingEl);
      }
      leaderRingEl.classList.add('on');
    } else if (leaderRingEl) {
      leaderRingEl.classList.remove('on');
    }
  }

  function removeLeaderRing() {
    if (leaderRingEl) { leaderRingEl.remove(); leaderRingEl = null; }
    if (leaderStyleEl) { leaderStyleEl.remove(); leaderStyleEl = null; }
  }

  // 捕获真实鼠标移动（节流 ~25次/秒）；镜像元素本身不产生事件，无回环。
  // 只有主控页广播：悬停划过其他窗口不会引起绿鼠标跳动（v1.6）；
  // 按住中（拖选会话）放宽主控门控——按下本身就是接管信号（v1.6.2）。
  // 按下后位移超过阈值 → 进入拖选会话：先补发起点 mousedown，
  // 随后的按住移动在目标页逐点回放，实现跨窗口拖选复制。
  function onMouseMove(e) {
    if (replaying || precisionToken !== null) return;
    if (!e.isTrusted) return;
    if (pickerActive) return;
    if (!leaderSelf && !dragAnchor) return;
    const vx = e.clientX / innerWidth;
    const vy = e.clientY / innerHeight;
    if (dragAnchor && e.buttons === 1 && !dragging) {
      const dx = e.clientX - dragAnchor.vx * innerWidth;
      const dy = e.clientY - dragAnchor.vy * innerHeight;
      if (Math.hypot(dx, dy) > 6) {
        dragging = true;
        send({ kind: 'dragstart', vx: dragAnchor.vx, vy: dragAnchor.vy });
      }
    }
    const now = performance.now();
    if (now - lastCursorSent < 40) return;
    lastCursorSent = now;
    // 拖选会话中的移动走 dragmove 通道（受"鼠标点击"开关控制，与镜像
    // 开关无关），目标页逐点回放按住移动；非拖选时为普通 cursor
    send({ kind: dragging ? 'dragmove' : 'cursor', vx, vy, pressed: e.buttons === 1 });
  }

  function replayCursor(ev) {
    if (!ghostOn) return;
    showGhost(ev.vx, ev.vy, ev.pressed, false);
  }

  // ---------------------------------------------------------------------------
  // 字段隔离（不同步的字段名单，如各标签页互不相同的编号）
  // ---------------------------------------------------------------------------
  const excluded = new Set(); // key 形如 'name:xxx' / 'id:xxx'
  let fieldLabels = {};      // key -> 显示名

  function fieldKey(el) {
    // 表单控件：优先 name，其次 id
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (el.name) return 'name:' + el.name;
      if (el.id) return 'id:' + el.id;
    }
    // 按钮（提交/普通按钮常无 name/id）：补 name/id 后再按按钮文字登记，
    // 支持把"提交"按钮加入隔离名单（先同步填写、人工核对后再手动提交）
    if (el instanceof HTMLButtonElement ||
        (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit'))) {
      if (el.name) return 'name:' + el.name;
      if (el.id) return 'id:' + el.id;
      const text = (el.textContent || el.value || '').trim().replace(/\s+/g, ' ');
      if (text) return 'text:' + text.slice(0, 30);
    }
    if (el.id && isStableId(el.id)) return 'id:' + el.id;
    return null;
  }

  // label 被点击时浏览器会转发激活其关联控件，需一并检查
  function isExcluded(el) {
    if (!(el instanceof Element)) return false;
    const control = el.closest('button, [role="button"], label') || el;
    const key = fieldKey(el);
    const controlKey = control !== el && fieldKey(control);
    if ((key && excluded.has(key)) || (controlKey && excluded.has(controlKey))) return true;
    if (control instanceof HTMLLabelElement && control.control) {
      const linkedKey = fieldKey(control.control);
      if (linkedKey && excluded.has(linkedKey)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 迟到 change 守卫（重要修复）：
  // 浏览器里文本框的 change 事件要等失焦才触发。用户常在"同步关闭"时
  // 填好各页编号再开启同步；若某页焦点仍在编号框，开启后的第一次点击
  // 会让它失焦并触发这个"迟到的 change"。该输入属于开启前的操作，
  // 不能广播——否则会把本页早前填的编号覆盖到其他所有标签页。
  // 守卫：注入时记下当前焦点字段及其值，此后第一次来自该字段且值未变的
  // input/change 视为注入前的旧输入，不广播。
  // ---------------------------------------------------------------------------
  let staleField = null;
  let syncEnabled = false;
  function snapshotFocusedField() {
    const ae = deepActiveElement();
    staleField = (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) &&
      !['checkbox', 'radio', 'file'].includes(ae.type) ? { el: ae, value: ae.value } : null;
  }

  function isStaleFieldEvent(el, eventValue) {
    if (!staleField) return false;
    if (staleField.el !== el) return false;
    if (eventValue !== undefined && eventValue !== staleField.value) {
      staleField = null;
      return false;
    }
    staleField = null; // 命中一次后清除，之后的输入正常广播
    return true;
  }

  // ---------------------------------------------------------------------------
  // 发送
  // ---------------------------------------------------------------------------
  function send(event) {
    if (!syncEnabled || replaying || precisionToken !== null) return;
    event.frame = FRAME_KEY;
    try {
      chrome.runtime.sendMessage({ type: 'mts:event', event }).catch(() => {});
    } catch {
      // 扩展已重新加载 -> 本脚本上下文已失效
      teardown();
    }
  }

  // ---------------------------------------------------------------------------
  // 捕获：滚动
  // ---------------------------------------------------------------------------
  const lastApplied = new Map(); // key -> {x, y, t} 最近回放过的位置
  const pendingScroll = new Set();
  let scrollRaf = 0;
  let scrollVersion = 0;
  let wheelBatch = null;
  let wheelTimer = 0;
  let wheelReplayAt = -Infinity;
  let realWheelAt = -Infinity;

  function flushWheel() {
    clearTimeout(wheelTimer);
    wheelTimer = 0;
    const batch = wheelBatch;
    wheelBatch = null;
    // 普通页面已经发送滚动位置。Canvas 等自绘区域没有滚动事件时才发送滚轮。
    if (batch && batch.scrollVersion === scrollVersion) send(batch.event);
  }

  function onWheel(e) {
    if (!syncEnabled || replaying || precisionToken !== null || pickerActive || !e.isTrusted) return;
    if (e.ctrlKey || e.metaKey || (!e.deltaX && !e.deltaY)) return;
    const target = eventTarget(e);
    if (!(target instanceof Element) || isExcluded(target)) return;
    realWheelAt = performance.now();
    const modesMatch = wheelBatch && wheelBatch.target === target && wheelBatch.event.deltaMode === e.deltaMode &&
      wheelBatch.event.mods.shift === e.shiftKey && wheelBatch.event.mods.alt === e.altKey;
    if (modesMatch && wheelBatch.scrollVersion === scrollVersion) {
      wheelBatch.event.deltaX += e.deltaX;
      wheelBatch.event.deltaY += e.deltaY;
      return;
    }
    if (wheelBatch) flushWheel();
    const r = target.getBoundingClientRect();
    wheelBatch = { target, scrollVersion, event: {
      kind: 'wheel', sel: selectorFor(target), targetTag: target.localName,
      vx: e.clientX / innerWidth, vy: e.clientY / innerHeight,
      ox: r.width ? (e.clientX - r.left) / r.width : .5,
      oy: r.height ? (e.clientY - r.top) / r.height : .5,
      deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, mods: mods(e),
    } };
    wheelTimer = setTimeout(flushWheel, 45);
  }

  function scrollMetrics(target) {
    if (target === null) {
      const se = document.scrollingElement || document.documentElement;
      return {
        x: window.scrollX, y: window.scrollY,
        maxX: se.scrollWidth - window.innerWidth, maxY: se.scrollHeight - window.innerHeight,
      };
    }
    return {
      x: target.scrollLeft, y: target.scrollTop,
      maxX: target.scrollWidth - target.clientWidth, maxY: target.scrollHeight - target.clientHeight,
    };
  }

  function flushScroll() {
    scrollRaf = 0;
    for (const target of pendingScroll) {
      const sel = target === null ? null : selectorFor(target);
      if (target !== null && !sel) continue;
      const key = sel || '';
      const m = scrollMetrics(target);
      const last = lastApplied.get(key);
      if (last && performance.now() - last.t < 500 && Math.abs(last.x - m.x) <= 1 && Math.abs(last.y - m.y) <= 1) {
        continue; // 自己回放产生的滚动回声
      }
      send({
        kind: 'scroll', sel,
        x: m.x, y: m.y,
        rx: m.maxX > 0 ? m.x / m.maxX : 0,
        ry: m.maxY > 0 ? m.y / m.maxY : 0,
      });
    }
    pendingScroll.clear();
  }

  function onScroll(e) {
    if (replaying || precisionToken !== null) return;
    if (wheelReplayAt > realWheelAt && performance.now() - wheelReplayAt < 200) return;
    const t = e.target;
    const target = (t === document || t === document.documentElement || t === document.scrollingElement || t === document.body && document.scrollingElement === document.body) ? null : t;
    if (target !== null && target.nodeType !== Node.ELEMENT_NODE) return;
    scrollVersion++;
    pendingScroll.add(target);
    if (!scrollRaf) scrollRaf = requestAnimationFrame(flushScroll);
  }

  // ---------------------------------------------------------------------------
  // 捕获：点击 / 聚焦
  // ---------------------------------------------------------------------------
  let lastClick = { el: null, t: 0 };

  function onClick(e) {
    if (replaying || precisionToken !== null) return;
    if (!e.isTrusted || e.button !== 0) return;
    if (pickerActive) return;
    // 拖选结束后的补发 click 不是点击语义，不再广播（拖选已由
    // dragstart/dragend 序列完整同步），避免目标页多出一次单击
    if (dragEndAt && performance.now() - dragEndAt < 350) { dragEndAt = 0; return; }
    const el = eventTarget(e);
    if (!(el instanceof Element)) return;

    // 点击 <label> 会产生第二次作用于关联控件的点击，
    // 目标页由 label 点击自行触发 -> 跳过
    const now = performance.now();
    if (lastClick.el instanceof HTMLLabelElement && lastClick.el.control === el && now - lastClick.t < 100) return;
    lastClick = { el: el.closest('label') || el, t: now };

    if (isExcluded(el)) return;

    // 先把待发滚动事件发出去，保证目标页点击位置一致
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); flushScroll(); }

    const r = el.getBoundingClientRect();
    send({
      kind: 'click',
      sel: selectorFor(el),
      vx: e.clientX / innerWidth,
      vy: e.clientY / innerHeight,
      ox: r.width ? (e.clientX - r.left) / r.width : 0.5,
      oy: r.height ? (e.clientY - r.top) / r.height : 0.5,
      detail: e.detail || 1,
      targetTag: el.localName,
      mods: mods(e),
    });
  }

  function onFocusIn(e) {
    if (replaying || precisionToken !== null) return;
    if (!e.isTrusted) return;
    const el = eventTarget(e);
    if (!(el instanceof Element)) return;
    if (isExcluded(el)) return;
    send({ kind: 'focus', sel: selectorFor(el) });
  }

  // ---------------------------------------------------------------------------
  // 捕获：按住 / 拖选 / 右键（v1.6.2）
  // - 左键按下即广播 press：其他窗口的绿鼠标立即进入按住状态且长按不淡出；
  //   按下本身也是主控接管信号（比 click 更早，长按期间即完成切换）
  // - 按下后位移超过阈值 → 拖选会话（dragstart 补发起点 + 按住移动逐点回放
  //   + dragend 松开），跨窗口复制拖选/框选；不补发 click（拖选不是点击）
  // - 右键广播 contextmenu：目标页回放自绘菜单。浏览器原生右键菜单不受
  //   合成事件影响，无自绘菜单的页面无副作用
  // ---------------------------------------------------------------------------
  let dragAnchor = null;   // {vx, vy} 左键按下起点
  let dragging = false;    // 拖选会话进行中
  let dragEndAt = 0;       // 拖选结束时间（用于吞掉紧随的 click 广播）
  let replaying = false;
  let precisionToken = null;
  let precisionTimer = 0;

  function onPointerDown(e) {
    if (replaying || precisionToken !== null) return;
    if (!e.isTrusted || pickerActive) return;
    if (e.button !== 0) return;
    pasteGrid = gridSurface(eventTarget(e));
    dragAnchor = { vx: e.clientX / innerWidth, vy: e.clientY / innerHeight };
    dragging = false;
    send({ kind: 'press', vx: dragAnchor.vx, vy: dragAnchor.vy, on: true });
  }

  function onPointerUp(e) {
    if (replaying || precisionToken !== null) return;
    if (!e.isTrusted || pickerActive) return;
    if (e.button !== 0) return;
    const vx = e.clientX / innerWidth;
    const vy = e.clientY / innerHeight;
    if (dragging) {
      send({ kind: 'dragend', vx, vy });
      dragEndAt = performance.now();
    }
    dragging = false;
    dragAnchor = null;
    send({ kind: 'press', vx, vy, on: false });
  }

  let pasteContext;
  let pasteGrid;

  function onContextMenu(e) {
    if (replaying || precisionToken !== null) return;
    if (!e.isTrusted || pickerActive) return;
    pasteContext = eventTarget(e);
    send({ kind: 'contextmenu', vx: e.clientX / innerWidth, vy: e.clientY / innerHeight });
  }

  // ---------------------------------------------------------------------------
  // 捕获：键盘 / 输入
  // ---------------------------------------------------------------------------
  let composing = null;
  let lastImeCommit = null;
  let sheetIme = null;
  let sheetImeTimer = 0;

  function isTencentSheetEditor(host) {
    return location.hostname === 'docs.qq.com' && location.pathname.startsWith('/sheet/') &&
      ['alloy-simple-text-editor', 'alloy-rich-text-editor'].includes(host?.id);
  }

  function clearSheetIme() {
    clearTimeout(sheetImeTimer);
    sheetIme = null;
  }

  function flushSheetIme() {
    const pending = sheetIme;
    clearSheetIme();
    if (!pending || !syncEnabled || !pending.host.isConnected ||
        pending.host.textContent !== pending.value || isExcluded(pending.host)) return;
    lastImeCommit = { host: pending.host, text: pending.text, at: performance.now(), snapshot: pending.value };
    send({ kind: 'input', sel: selectorFor(pending.host), editorText: pending.value });
  }

  function canCaptureInput(e) {
    return syncEnabled && !replaying && precisionToken === null && !pickerActive && e.isTrusted;
  }

  const clipboardShortcuts = new Map([['KeyV', 'all'], ['KeyL', 'lines'], ['KeyX', 'clear']]);

  function onKey(e) {
    const clipboardAction = clipboardShortcuts.get(e.code);
    if (clipboardAction && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey &&
        canCaptureInput(e) && !e.isComposing && e.keyCode !== 229 && e.key !== 'Process') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) {
        const message = clipboardAction === 'clear' ? { type: 'mts:clear-clipboard' }
          : { type: 'mts:paste-shortcut', mode: clipboardAction };
        chrome.runtime.sendMessage(message).catch(() => {});
      }
      return;
    }
    if (!canCaptureInput(e) || e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
    const el = eventTarget(e);
    const host = editingHost(el);
    // A composing flag can outlive an editor replaced by the spreadsheet.
    // Real non-composing keys must still be sent.
    if (composing && composing !== host) composing = null;
    if (e.type === 'keydown') {
      if (sheetIme && e.key === 'Escape') clearSheetIme();
      else if (sheetIme) flushSheetIme();
      else lastImeCommit = null;
    }
    if (isSensitive(el) || isExcluded(el) || (host && isExcluded(host))) return;
    send({
      kind: 'key',
      type: e.type,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      location: e.location,
      repeat: e.repeat,
      mods: mods(e),
      editable: !!host,
      sel: host ? selectorFor(host) : null,
    });
  }

  function onCompositionStart(e) {
    if (!canCaptureInput(e)) return;
    if (sheetIme) flushSheetIme();
    composing = editingHost(eventTarget(e));
    lastImeCommit = null;
  }

  function onCompositionEnd(e) {
    if (!e.isTrusted) return;
    const host = composing || editingHost(eventTarget(e));
    composing = null;
    if (!canCaptureInput(e) || !host || !e.data || isExcluded(eventTarget(e))) {
      clearSheetIme();
      return;
    }
    if (lastImeCommit?.host === host && lastImeCommit.snapshot === host.textContent) return;
    clearSheetIme();
    if (sendEditorInput(host, e.data, true)) {
      lastImeCommit = { host, text: e.data, value: host.value, at: performance.now() };
    }
  }

  function onInput(e) {
    if (!canCaptureInput(e)) return;
    const target = eventTarget(e);
    const host = editingHost(target);
    if (!host || isExcluded(target) || isExcluded(host) || isSensitive(host)) return;
    if (e.isComposing) {
      if (isTencentSheetEditor(host) && e.inputType === 'insertCompositionText') {
        clearSheetIme();
        // Edge/Tencent Sheets can leave the selected Han text marked as composing.
        // Carry the resulting editor value so a later commit cannot append it twice.
        if (typeof e.data === 'string' && /[\u3400-\u9fff]/.test(e.data)) {
          sheetIme = { host, text: e.data, value: host.textContent };
          sheetImeTimer = setTimeout(flushSheetIme, 45);
        }
      }
      return;
    }
    if (sheetIme?.host === host && sheetIme.value === host.textContent) flushSheetIme();
    if (composing === host && e.inputType === 'insertCompositionText') return;
    composing = null;
    const commit = lastImeCommit;
    lastImeCommit = null;
    // 部分浏览器会在 compositionend 后补发同一次上屏的 input。
    if (commit?.host === host && performance.now() - commit.at < 100 &&
        (e.data === commit.text || e.inputType === 'insertFromComposition' ||
          (e.inputType === 'insertCompositionText' && host.value === commit.value))) {
      // Native controls can finalize their value after compositionend.
      if (commit.value !== undefined && host.value !== commit.value) sendEditorInput(host, null);
      return;
    }
    sendEditorInput(host, e.data ?? null, false, e.inputType);
  }

  function sendEditorInput(host, inserted, ime = false, inputType = 'insertText') {
    if (isSensitive(host) || isExcluded(host)) return false;
    const sel = selectorFor(host);
    if (!sel) return false;
    if (host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement || host instanceof HTMLSelectElement) {
      if (host instanceof HTMLInputElement && ['checkbox', 'radio', 'file'].includes(host.type)) return false;
      if (isStaleFieldEvent(host, host.value)) return false;
      send({ kind: 'input', sel, value: host.value, ins: ime ? inserted : null, data: inserted, inputType });
    } else {
      const r = host.getBoundingClientRect();
      send({
        kind: 'input', sel, html: host.innerHTML, ins: inserted, data: inserted, inputType,
        vx: r.width ? (r.left + r.width / 2) / innerWidth : null,
        vy: r.height ? (r.top + r.height / 2) / innerHeight : null,
      });
    }
    return true;
  }

  function onChange(e) {
    if (replaying || precisionToken !== null) return;
    if (!e.isTrusted) return;
    const el = eventTarget(e);
    if (isSensitive(el)) return;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
    if (el instanceof HTMLInputElement && el.type === 'file') return;
    if (isExcluded(el)) return;
    if (isStaleFieldEvent(el, el.value)) return; // 注入前的旧输入，不广播
    send({ kind: 'change', sel: selectorFor(el), value: el.value, checked: el.checked, inputType: el.type });
  }

  // ---------------------------------------------------------------------------
  // 回放
  // ---------------------------------------------------------------------------
  function resolveTarget(ev) {
    const matched = resolveSelector(ev.sel);
    if (matched && (!ev.targetTag || matched.localName === ev.targetTag)) return matched;
    // Canvas is hit-tested by position. For a DOM control, a missing selector
    // must not turn into a click on an unrelated button in another window.
    if (ev.sel && ev.targetTag !== 'canvas') return null;
    const atPoint = elementAtViewportRatio(ev.vx, ev.vy);
    return !ev.targetTag || atPoint?.localName === ev.targetTag ? atPoint : null;
  }

  function ensureVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return el.getBoundingClientRect();
    }
    return r;
  }

  function pointFor(el, ev) {
    const r = ensureVisible(el);
    return {
      x: r.left + r.width * (ev.ox ?? 0.5),
      y: r.top + r.height * (ev.oy ?? 0.5),
    };
  }

  function replayScroll(ev) {
    const target = ev.sel ? resolveSelector(ev.sel) : null;
    if (ev.sel && !target) return 'missing-target';
    const m = scrollMetrics(target);
    const x = ev.mode === 'relative' ? ev.rx * Math.max(0, m.maxX) : ev.x;
    const y = ev.mode === 'relative' ? ev.ry * Math.max(0, m.maxY) : ev.y;
    (target || window).scrollTo({ left: x, top: y, behavior: 'instant' });
    const after = scrollMetrics(target);
    lastApplied.set(ev.sel || '', { x: after.x, y: after.y, t: performance.now() });
  }

  function replayWheel(ev) {
    const target = resolveTarget(ev);
    if (!target) return 'missing-target';
    if (isExcluded(target)) return 'isolated';
    const {x, y} = pointFor(target, ev);
    const m = ev.mods || {};
    wheelReplayAt = performance.now();
    target.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, deltaX: ev.deltaX, deltaY: ev.deltaY,
      deltaMode: ev.deltaMode, shiftKey: !!m.shift, altKey: !!m.alt,
    }));
  }

  const FOCUSABLE = 'input,textarea,select,button,a[href],area[href],summary,[tabindex],[contenteditable]:not([contenteditable="false"])';

  function replayClick(ev) {
    const el = resolveTarget(ev);
    // 点击时镜像鼠标同步闪烁（即便元素定位失败，仍显示点击位置反馈）
    if (ghostOn) showGhost(ev.vx, ev.vy, false, true);
    if (!el) return 'missing-target';
    if (isExcluded(el)) return 'isolated';
    pasteGrid = gridSurface(el);
    const { x, y } = pointFor(el, ev);
    const m = ev.mods || {};
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY,
      button: 0, detail: ev.detail || 1,
      altKey: !!m.alt, ctrlKey: !!m.ctrl, metaKey: !!m.meta, shiftKey: !!m.shift,
    };
    const ptr = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    const focusable = el.closest(FOCUSABLE);
    if (focusable && typeof focusable.focus === 'function') focusable.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, ...ptr, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    if (ev.detail === 2) {
      // dblclick 派发给坐标处最顶层元素：自绘应用的监听层常与点击目标不同层
      const top = document.elementFromPoint(x, y) || el;
      top.dispatchEvent(new MouseEvent('dblclick', { ...base, buttons: 0 }));
      // 双击进入编辑态的兜底：严格检查事件可信度的自绘表格（腾讯文档等）
      // 不认合成 dblclick，但兼容 Excel 式 F2 进入编辑；F2 在普通页面无默认行为
      document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F2', code: 'F2', keyCode: 113, which: 113,
        bubbles: true, cancelable: true, composed: true, view: window,
      }));
    }
  }

  function replayFocus(ev) {
    const el = resolveSelector(ev.sel);
    if (!el) return 'missing-target';
    if (isExcluded(el)) return 'isolated';
    if (typeof el.focus === 'function' && deepActiveElement() !== el) el.focus({ preventScroll: true });
  }

  function keyboardTarget(ev, restoreFocus = false) {
    const active = deepActiveElement();
    if (!ev.sel) return active || document.body;
    const matched = resolveSelector(ev.sel);
    if (!matched) return null;
    if (active === matched || editingHost(active) === matched) return active;
    if (restoreFocus && editingHost(matched) === matched && focusEditor(matched)) return deepActiveElement();
    return null;
  }

  function replayKey(ev) {
    const target = keyboardTarget(ev, ev.type === 'keydown');
    if (!target) return 'missing-target';
    if (isSensitive(target) || isExcluded(target)) return 'isolated';
    const m = ev.mods || {};
    const kev = new KeyboardEvent(ev.type, {
      key: ev.key, code: ev.code, keyCode: ev.keyCode, which: ev.keyCode,
      location: ev.location, repeat: ev.repeat,
      altKey: !!m.alt, ctrlKey: !!m.ctrl, metaKey: !!m.meta, shiftKey: !!m.shift,
      bubbles: true, cancelable: true, composed: true, view: window,
    });
    const notCancelled = target.dispatchEvent(kev);
    // 补齐默认动作"在表单字段按 Enter -> 提交"
    if (notCancelled && ev.type === 'keydown' && ev.key === 'Enter' && !m.ctrl && !m.alt && !m.meta &&
        target instanceof HTMLInputElement && target.form) {
      const submitters = [...target.form.elements].filter((el) => el.type === 'submit' || el.type === 'image');
      if (submitters.some(isExcluded)) return 'isolated';
      target.form.requestSubmit();
    }
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function replayInput(ev) {
    if (typeof ev.editorText === 'string') {
      const host = resolveSelector(ev.sel);
      if (!isTencentSheetEditor(host)) return 'missing-target';
      if (isExcluded(host)) return 'isolated';
      if (host.textContent === ev.editorText) return 'applied';
      if (!prepareEditor(host)) return 'missing-target';
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(host);
      selection.removeAllRanges();
      selection.addRange(range);
      return insertTextInto(host, ev.editorText) ? 'applied' : 'missing-target';
    }
    // 增量文本（输入法上屏/编辑命令）优先走 execCommand：直接改 DOM + 合成 input
    // 会被自绘/受控编辑器拒收，execCommand 产生浏览器原生编辑流（带 inputType），
    // 应用模型照常更新；目标页还没打开编辑器时，在相同位置回放双击让应用
    // 打开编辑器后重试插入（自绘表格的编辑器是惰性创建的）。
    if (ev.ins && ev.html != null) {
      const findHost = () => editingHost(resolveSelector(ev.sel)) || (ev.vx != null && findEditableAt(ev.vx, ev.vy));
      const insert = (host) => {
        if (isSensitive(host) || isExcluded(host)) return 'isolated';
        return insertTextInto(host, ev.ins) ? 'applied' : 'missing-target';
      };
      const host = findHost();
      if (host) return insert(host);
      if (ev.vx != null) {
        // Give a previously replayed click time to mount its editor before reopening it.
        return (async () => {
          for (const delay of [25, 55, 100]) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            if (signal.aborted || Date.now() > ev.deadline) return 'expired';
            const editor = findHost();
            if (editor) return withoutCapture(() => insert(editor));
            if (delay !== 55) continue;
            const atPoint = elementAtViewportRatio(ev.vx, ev.vy);
            if (atPoint && isExcluded(atPoint)) return 'isolated';
            if (atPoint) withoutCapture(() => synthClickAt(ev.vx, ev.vy, 2));
          }
          return 'missing-target';
        })();
      }
    }
    const el = resolveSelector(ev.sel);
    if (!el) return 'missing-target';
    if (isSensitive(el) || isExcluded(el)) return 'isolated';
    if (ev.html != null) {
      if (el.innerHTML === ev.html) return;
      el.innerHTML = ev.html;
    } else {
      if (el.value === ev.value) return;
      setNativeValue(el, ev.value);
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, data: ev.data ?? null, inputType: ev.inputType || 'insertText',
    }));
  }

  // 视口比例坐标下找到可编辑元素（自上而下找 contenteditable 祖先）
  function findEditableAt(vx, vy) {
    let el = elementAtViewportRatio(vx, vy);
    while (el) {
      if (el instanceof HTMLElement && el.isContentEditable) return el;
      el = el.parentElement;
    }
    return null;
  }

  function focusEditor(host) {
    if (isSensitive(host) || isExcluded(host) || host.readOnly || host.disabled) return false;
    const active = deepActiveElement();
    if (editingHost(active) === host) return true;
    const bounds = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height || bounds.right <= 0 || bounds.bottom <= 0 ||
        bounds.left >= innerWidth || bounds.top >= innerHeight ||
        getComputedStyle(host).visibility !== 'visible') return false;
    host.focus({ preventScroll: true });
    return editingHost(deepActiveElement()) === host;
  }

  function prepareEditor(host) {
    if (!focusEditor(host)) return false;
    if (!host.isContentEditable) return true;
    const selection = host.getRootNode().getSelection?.() ?? document.getSelection();
    if (!selection) return false;
    if (host.contains(selection.anchorNode) && host.contains(selection.focusNode)) return true;
    const caret = document.createRange();
    caret.selectNodeContents(host);
    caret.collapse(false);
    selection.removeAllRanges();
    selection.addRange(caret);
    return true;
  }

  function insertTextInto(host, text) {
    if (!prepareEditor(host)) return false;
    try { return document.execCommand('insertText', false, text); } catch { return false; }
  }

  // 在视口坐标处回放点击序列（detail=2 为双击），让自绘应用打开编辑器。
  // 双击按真实浏览器的两次完整 down/up 序列复刻（detail 1→2），
  // 应用依赖第一次点击选中目标、第二次进入编辑态的逻辑才能正确触发。
  // 合成事件（isTrusted=false）不会被自身捕获逻辑再次广播，无回环。
  function synthClickAt(vx, vy, detail) {
    const x = Math.max(0, Math.min((vx ?? 0) * innerWidth, innerWidth - 1));
    const y = Math.max(0, Math.min((vy ?? 0) * innerHeight, innerHeight - 1));
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const ptr = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const mk = (d, buttons) => ({ bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons, detail: d });
    const focusable = el.closest(FOCUSABLE);
    if (focusable && typeof focusable.focus === 'function') focusable.focus({ preventScroll: true });
    const fireDown = (d) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...mk(d, 1), ...ptr }));
      el.dispatchEvent(new MouseEvent('mousedown', mk(d, 1)));
    };
    const fireUp = (d) => {
      el.dispatchEvent(new PointerEvent('pointerup', { ...mk(d, 0), ...ptr }));
      el.dispatchEvent(new MouseEvent('mouseup', mk(d, 0)));
      el.dispatchEvent(new MouseEvent('click', mk(d, 0)));
    };
    fireDown(1);
    fireUp(1);
    if (detail === 2) {
      fireDown(2);
      fireUp(2);
      el.dispatchEvent(new MouseEvent('dblclick', mk(2, 0)));
      // 与 replayClick 一致：严格自绘表格不认合成 dblclick，补 F2 进入编辑态
      document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F2', code: 'F2', keyCode: 113, which: 113,
        bubbles: true, cancelable: true, composed: true, view: window,
      }));
    }
  }

  function replayChange(ev) {
    const el = resolveSelector(ev.sel);
    if (!el) return 'missing-target';
    if (isSensitive(el) || isExcluded(el)) return 'isolated';
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      // 点击会像原始操作一样触发 input+change；点击回放已恢复状态时跳过
      if (el.checked !== ev.checked) el.click();
      return;
    }
    if (el.value !== ev.value) {
      setNativeValue(el, ev.value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------------------------------------------------------------------------
  // 回放：按住 / 拖选 / 右键（v1.6.2）
  // 目标页的拖选会话：dragstart 开启（补发起点按下）→ dragmove 逐点回放
  // 按住移动 → dragend 松开；合成事件 isTrusted=false 不会被自身捕获
  // 逻辑再广播，无回环。合成 contextmenu 不触发浏览器原生右键菜单，
  // 只有页面自绘菜单（如在线表格）会响应。
  // ---------------------------------------------------------------------------
  let dragSession = false;

  function synthMouseAt(vx, vy, phase, button = 0) {
    const x = Math.max(0, Math.min((vx ?? 0) * innerWidth, innerWidth - 1));
    const y = Math.max(0, Math.min((vy ?? 0) * innerHeight, innerHeight - 1));
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const buttons = phase === 'down' || phase === 'move' ? (button === 2 ? 2 : 1) : 0;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button, buttons, detail: 1 };
    const ptr = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    if (phase === 'down') {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...ptr }));
      el.dispatchEvent(new MouseEvent('mousedown', base));
    } else if (phase === 'move') {
      el.dispatchEvent(new PointerEvent('pointermove', { ...base, ...ptr }));
      el.dispatchEvent(new MouseEvent('mousemove', base));
    } else if (phase === 'up') {
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, ...ptr }));
      el.dispatchEvent(new MouseEvent('mouseup', base));
    } else if (phase === 'menu') {
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 2, buttons: 2 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 2, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 2, buttons: 0 }));
    }
    return el;
  }

  function replayPress(ev) {
    if (!ghostOn) return;
    showGhost(ev.vx, ev.vy, !!ev.on, false);
  }

  function replayDragStart(ev) {
    dragSession = true;
    synthMouseAt(ev.vx, ev.vy, 'down');
  }

  function replayDragMove(ev) {
    synthMouseAt(ev.vx, ev.vy, 'move');
    if (ghostOn) showGhost(ev.vx, ev.vy, true, false);
  }

  function replayDragEnd(ev) {
    synthMouseAt(ev.vx, ev.vy, 'up');
    dragSession = false;
  }

  function replayContextMenu(ev) {
    if (ghostOn) showGhost(ev.vx, ev.vy, false, true);
    synthMouseAt(ev.vx, ev.vy, 'menu', 2);
  }

  function gridSurface(el) {
    return el instanceof Element
      ? el.closest('canvas, [role="grid"], [role="treegrid"]') : null;
  }

  function pasteTarget(fromMenu) {
    const active = deepActiveElement();
    if (active instanceof HTMLIFrameElement) return {};
    const candidate = fromMenu && pasteContext?.isConnected ? pasteContext : active;
    const host = editingHost(candidate);
    if (host) {
      if (isSensitive(host) || isExcluded(host) || isExcluded(candidate)) return { code: 'isolated' };
      if (host.disabled || host.readOnly || host instanceof HTMLSelectElement ||
          (host instanceof HTMLInputElement && !['text', 'search', 'tel', 'url', 'email', 'number'].includes(host.type))) return {};
      return { host };
    }
    const grid = gridSurface(candidate) ||
      (!fromMenu && (active === document.body || active === document.documentElement) ? pasteGrid : null);
    if (!grid?.isConnected) return {};
    return isExcluded(grid) ? { code: 'isolated' } : { grid };
  }

  function replayPaste(ev) {
    if (!syncEnabled || pickerActive) return 'expired';
    const { host, grid, code } = pasteTarget(ev.fromMenu);
    if (!host && !grid) return code || 'missing-target';
    if (host && (composing === host || sheetIme?.host === host)) return 'busy';
    let expected;
    const nativeField = host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement;
    if (nativeField) {
      if (host instanceof HTMLInputElement && /[\r\n]/.test(ev.text)) return 'failed';
      const start = host.selectionStart ?? host.value.length;
      const end = host.selectionEnd ?? host.value.length;
      const removed = end - start;
      if (host.maxLength >= 0 && host.value.length - removed + ev.text.length > host.maxLength) return 'failed';
      if (host.selectionStart != null) expected = host.value.slice(0, start) + ev.text + host.value.slice(end);
    }
    if (host && !prepareEditor(host)) return 'missing-target';

    // Let web editors handle a plain-text paste first. Native fields fall back to browser editing.
    const data = new DataTransfer();
    data.setData('text/plain', ev.text);
    const target = host || grid;
    const preventDefault = !target.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true, composed: true,
    }));
    if (!preventDefault && (!host || !insertTextInto(host, ev.text))) return 'missing-target';
    if (nativeField) {
      // Blurring after a split paste must not rebroadcast the per-tab value.
      staleField = { el: host, value: host.value };
      if (!preventDefault && expected !== undefined && host.value !== expected) return 'failed';
    }
    return preventDefault ? 'handled' : 'applied';
  }

  const REPLAY = {
    paste: replayPaste,
    scroll: replayScroll,
    wheel: replayWheel,
    click: replayClick,
    focus: replayFocus,
    key: replayKey,
    input: replayInput,
    change: replayChange,
    cursor: replayCursor,
    press: replayPress,
    dragstart: replayDragStart,
    dragmove: replayDragMove,
    dragend: replayDragEnd,
    contextmenu: replayContextMenu,
  };

  // 精确模式用：计算目标元素在顶层视口中的坐标
  function locate(ev) {
    const el = resolveTarget(ev);
    if (!el || isExcluded(el)) return null;
    const p = pointFor(el, ev);
    return { x: p.x, y: p.y, visible: document.visibilityState === 'visible' };
  }

  // ---------------------------------------------------------------------------
  // 切换提示条（由 Service Worker 下发：同步开启/关闭时弹出）
  // 用独立的 setTimeout 管理，不依赖 ac.signal —— 关闭同步拆除本脚本后，
  // 提示条仍能正常淡出。
  // ---------------------------------------------------------------------------
  let clipboardToast;
  let clipboardToastTimer;

  function showClipboardToast(title, preview) {
    clipboardToast?.remove();
    clearTimeout(clipboardToastTimer);
    clipboardToast = document.createElement('div');
    Object.assign(clipboardToast.style, {
      all: 'initial', position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483646',
      width: 'max-content', maxWidth: 'calc(100% - 24px)', pointerEvents: 'none',
    });
    const shadow = clipboardToast.attachShadow({ mode: 'closed' });
    const panel = document.createElement('div');
    panel.setAttribute('role', 'status');
    panel.style.cssText = 'padding:10px 14px;border:1px solid #b5d9d2;border-radius:14px;'
      + 'background:#eef8f5;color:#174940;font:13px/1.45 system-ui,sans-serif;'
      + 'box-shadow:0 4px 16px #163e3626;overflow-wrap:anywhere';
    const heading = document.createElement('strong');
    heading.textContent = title;
    panel.append(heading);
    if (preview !== undefined) {
      const line = document.createElement('div');
      line.style.whiteSpace = 'pre-wrap';
      line.dir = 'auto';
      line.textContent = preview;
      panel.append(line);
    }
    shadow.append(panel);
    document.documentElement.append(clipboardToast);
    clipboardToastTimer = setTimeout(() => { clipboardToast?.remove(); clipboardToast = null; }, 4200);
  }

  let toastEl = null;
  let toastTimer = 0;

  function showToast(on, count) {
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);
    toastEl = document.createElement('div');
    toastEl.className = 'mts-toast';
    toastEl.textContent = on
      ? `✔ 同步已开启：其他 ${Math.max(count - 1, 1)} 个标签页将跟随本页操作`
      : '✖ 同步已关闭，各页操作恢复独立';
    toastEl.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483646;'
      + 'max-width:90vw;padding:10px 18px;border-radius:24px;color:#fff;'
      + `background:${on ? '#34c759' : '#48484a'};`
      + 'font:14px/1.4 "Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);'
      + 'opacity:1;transition:opacity .4s;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    document.documentElement.appendChild(toastEl);
    toastTimer = setTimeout(() => {
      if (!toastEl) return;
      toastEl.style.opacity = '0';
      toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 450);
    }, 3500);
  }

  // ---------------------------------------------------------------------------
  // 点选模式：由 popup 触发，用户在页面点击要"不同步"的字段
  // ---------------------------------------------------------------------------
  let pickerActive = false;
  let pickerOverlay = null;
  let hoverEl = null;

  function setHoverOutline(el, on) {
    if (!el || !el.style) return;
    if (on) {
      el.style.outline = '2px solid #e11d48';
      el.style.outlineOffset = '1px';
      el.style.cursor = 'pointer';
    } else {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.cursor = '';
    }
  }

  function ensureOverlay() {
    if (pickerOverlay) return;
    pickerOverlay = document.createElement('div');
    pickerOverlay.textContent = '点选模式：请点击要设为"不同步"的字段（按 Esc 取消）';
    pickerOverlay.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;'
      + 'background:#e11d48;color:#fff;font:13px/1.4 "Microsoft YaHei",sans-serif;'
      + 'padding:6px 12px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.3)';
    document.documentElement.appendChild(pickerOverlay);
  }

  function removeOverlay() {
    if (pickerOverlay) { pickerOverlay.remove(); pickerOverlay = null; }
  }

  function fieldLabel(el) {
    let text = '';
    if (el instanceof HTMLElement) {
      if (el instanceof HTMLButtonElement) text = (el.textContent || el.value || '').trim();
      if (!text) {
        const lbl = el.closest('label');
        if (lbl) text = (lbl.textContent || '').trim();
      }
      if (!text && el.placeholder) text = el.placeholder;
      if (!text && el.id) text = '#' + el.id;
      if (!text && el.name) text = el.name;
    }
    return text.slice(0, 20);
  }

  function pickerClick(e) {
    if (!pickerActive) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = eventTarget(e);
    if (!(el instanceof Element)) return;
    let target = el;
    if (el instanceof HTMLLabelElement && el.control) target = el.control;
    const k = fieldKey(target);
    setPicker(false);
    if (k) {
      chrome.runtime.sendMessage({
        type: 'mts:pick',
        field: { key: k, label: fieldLabel(target) },
      }).catch(() => {});
    }
  }

  function pickerMove(e) {
    if (!pickerActive) return;
    const el = eventTarget(e);
    if (hoverEl === el) return;
    setHoverOutline(hoverEl, false);
    hoverEl = el instanceof Element ? el : null;
    setHoverOutline(hoverEl, true);
  }

  function pickerKey(e) {
    if (!pickerActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setPicker(false);
      chrome.runtime.sendMessage({ type: 'mts:pick', cancel: true }).catch(() => {});
    }
  }

  function setPicker(on) {
    if (on === pickerActive) return;
    pickerActive = on;
    if (on) {
      ensureOverlay();
      document.addEventListener('mousemove', pickerMove, { capture: true, signal });
      document.addEventListener('click', pickerClick, { capture: true, signal });
      document.addEventListener('keydown', pickerKey, { capture: true, signal });
    } else {
      setHoverOutline(hoverEl, false);
      hoverEl = null;
      removeOverlay();
      document.removeEventListener('mousemove', pickerMove, { capture: true });
      document.removeEventListener('click', pickerClick, { capture: true });
      document.removeEventListener('keydown', pickerKey, { capture: true });
    }
  }

  // ---------------------------------------------------------------------------
  // 来自 Service Worker 的消息
  // ---------------------------------------------------------------------------
  function withoutCapture(run) {
    replaying = true;
    try { return run(); } finally { replaying = false; }
  }

  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.type) {
      case 'mts:replay': {
        if (msg.event.frame !== FRAME_KEY) {
          sendResponse('missing-frame');
          return;
        }
        if (Date.now() > msg.event.deadline) {
          sendResponse('expired');
          return;
        }
        try {
          const result = withoutCapture(() => REPLAY[msg.event.kind](msg.event));
          if (result instanceof Promise) {
            result.then((status) => sendResponse(status), () => sendResponse('failed'));
            return true;
          }
          sendResponse(result || 'applied');
        } catch { sendResponse('failed'); }
        return;
      }
      case 'mts:paste-target': {
        const target = pasteTarget(msg.fromMenu);
        sendResponse(syncEnabled && !pickerActive && !!(target.host || target.grid));
        return;
      }
      case 'mts:clipboard-toast':
        if (FRAME_KEY === 'top') {
          showClipboardToast(msg.title, msg.preview);
          sendResponse(true);
        }
        return;
      case 'mts:locate':
        if (FRAME_KEY === 'top') sendResponse(withoutCapture(() => locate(msg.event)));
        return;
      case 'mts:precision-target': {
        const ev = msg.event;
        const ready = withoutCapture(() => {
          if (document.visibilityState !== 'visible') return false;
          const target = keyboardTarget(ev, ev.kind === 'input' || ev.type === 'keydown');
          if (!target || isSensitive(target) || isExcluded(target)) return false;
          if (ev.kind === 'input') {
            const host = editingHost(target);
            return !!host && prepareEditor(host);
          }
          return !(ev.key === 'Enter' && target.form &&
            [...target.form.elements].some((el) => ['submit', 'image'].includes(el.type) && isExcluded(el)));
        });
        sendResponse(ready);
        return;
      }
      case 'mts:ping':
        if (FRAME_KEY === 'top') sendResponse(true);
        return;
      case 'mts:toast':
        if (FRAME_KEY === 'top') {
          showToast(msg.on, msg.count || 0);
          sendResponse(true);
        }
        return;
      case 'mts:leader':
        leaderSelf = !!msg.on;
        if (FRAME_KEY === 'top') setLeaderRing(leaderSelf);
        return;
      case 'mts:quiet': {
        clearTimeout(precisionTimer);
        precisionToken = msg.token;
        if (msg.wheel) wheelReplayAt = performance.now();
        precisionTimer = setTimeout(() => { precisionToken = null; }, msg.ms);
        if (FRAME_KEY === 'top') sendResponse(true);
        return;
      }
      case 'mts:unquiet':
        if (precisionToken === msg.token) {
          clearTimeout(precisionTimer);
          precisionToken = null;
        }
        if (FRAME_KEY === 'top') sendResponse(true);
        return;
      case 'mts:teardown':
        teardown();
        return;
      case 'mts:config': {
        if (msg.enabled && !syncEnabled) snapshotFocusedField();
        syncEnabled = !!msg.enabled;
        excluded.clear();
        fieldLabels = {};
        for (const f of msg.excluded || []) {
          excluded.add(f.key);
          fieldLabels[f.key] = f.label || f.key;
        }
        const nextColor = cursorColors.normalize(msg.ghostColor);
        if (nextColor !== ghostColor) {
          ghostColor = nextColor;
          if (ghostEl) applyGhostColor(ghostEl);
        }
        const wantGhost = !!msg.ghost;
        if (wantGhost !== ghostOn) {
          ghostOn = wantGhost;
          if (!ghostOn) removeGhost(); // 关闭镜像鼠标时立即移除已显示的绿鼠标
        }
        if (msg.leader !== undefined) {
          leaderSelf = !!msg.leader;
          if (FRAME_KEY === 'top') setLeaderRing(leaderSelf);
        }
        if (FRAME_KEY === 'top') sendResponse(true);
        return;
      }
      case 'mts:picker-on':
        setPicker(true);
        if (FRAME_KEY === 'top') sendResponse(true);
        return;
      case 'mts:picker-off':
        setPicker(false);
        if (FRAME_KEY === 'top') sendResponse(true);
        return;
    }
  }

  function teardown() {
    setPicker(false);
    removeGhost();
    removeLeaderRing();
    ac.abort();
    clearTimeout(precisionTimer);
    clearTimeout(wheelTimer);
    clearTimeout(clipboardToastTimer);
    clipboardToast?.remove();
    clearSheetIme();
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* 上下文已失效 */ }
    delete window.__archiveSyncHelper;
  }

  const capture = { capture: true, signal };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
  document.addEventListener('wheel', onWheel, { ...capture, passive: true });
  document.addEventListener('click', onClick, capture);
  document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true, signal });
  document.addEventListener('pointerdown', onPointerDown, capture);
  document.addEventListener('pointerup', onPointerUp, capture);
  document.addEventListener('contextmenu', onContextMenu, capture);
  document.addEventListener('focusin', onFocusIn, capture);
  window.addEventListener('keydown', onKey, capture);
  window.addEventListener('keyup', onKey, capture);
  window.addEventListener('compositionstart', onCompositionStart, capture);
  window.addEventListener('compositionend', onCompositionEnd, capture);
  window.addEventListener('input', onInput, capture);
  document.addEventListener('change', onChange, capture);
  chrome.runtime.onMessage.addListener(onMessage);

  return (window.__archiveSyncHelper = FRAME_KEY);
})();
