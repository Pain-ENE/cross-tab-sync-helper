// 归档同步助手（基于开源项目 aysner/Multi-Tab-Sync 修改）– content script。
// 由 Service Worker 注入到同步组各标签页的每个框架。
// 捕获真实用户事件（isTrusted）并把其他标签页发来的事件在本地回放。

(() => {
  if (window.__archiveSyncHelper) return;

  const ac = new AbortController();
  const { signal } = ac;

  // ---------------------------------------------------------------------------
  // 框架标识：各标签页的 frameId 不同，用嵌套深度+路径对应
  // ---------------------------------------------------------------------------
  const FRAME_KEY = (() => {
    if (window === window.top) return 'top';
    let depth = 0;
    let w = window;
    while (w !== w.top) { depth++; w = w.parent; }
    return `${depth}:${location.pathname}`;
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

  // ---------------------------------------------------------------------------
  // 字段隔离（不同步的字段名单，如各标签页互不相同的档案编号）
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
    let k = el instanceof Element ? fieldKey(el) : null;
    if (k && excluded.has(k)) return true;
    if (el instanceof HTMLLabelElement && el.control) {
      const ck = fieldKey(el.control);
      if (ck && excluded.has(ck)) return true;
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
  try {
    const ae = document.activeElement;
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) {
      if (ae.type !== 'checkbox' && ae.type !== 'radio' && ae.type !== 'file') {
        staleField = { name: ae.name || '', id: ae.id || '', value: ae.value };
      }
    }
  } catch { /* ignore */ }

  function isStaleFieldEvent(el, eventValue) {
    if (!staleField) return false;
    const byName = staleField.name && el.name === staleField.name;
    const byId = staleField.id && el.id === staleField.id;
    if (!byName && !byId) return false;
    if (eventValue !== undefined && eventValue !== staleField.value) return false;
    staleField = null; // 命中一次后清除，之后的输入正常广播
    return true;
  }

  // ---------------------------------------------------------------------------
  // 发送
  // ---------------------------------------------------------------------------
  function send(event) {
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
    const t = e.target;
    const target = (t === document || t === document.documentElement || t === document.scrollingElement || t === document.body && document.scrollingElement === document.body) ? null : t;
    if (target !== null && target.nodeType !== Node.ELEMENT_NODE) return;
    pendingScroll.add(target);
    if (!scrollRaf) scrollRaf = requestAnimationFrame(flushScroll);
  }

  // ---------------------------------------------------------------------------
  // 捕获：点击 / 聚焦
  // ---------------------------------------------------------------------------
  let lastClick = { el: null, t: 0 };

  function onClick(e) {
    if (!e.isTrusted || e.button !== 0) return;
    if (pickerActive) return;
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
      mods: mods(e),
    });
  }

  function onFocusIn(e) {
    if (!e.isTrusted) return;
    const el = eventTarget(e);
    if (!(el instanceof Element)) return;
    if (isExcluded(el)) return;
    send({ kind: 'focus', sel: selectorFor(el) });
  }

  // ---------------------------------------------------------------------------
  // 捕获：键盘 / 输入
  // ---------------------------------------------------------------------------
  function onKey(e) {
    if (!e.isTrusted || e.isComposing) return;
    const el = eventTarget(e);
    if (isSensitive(el)) return;
    if (el instanceof Element && isExcluded(el)) return;
    send({
      kind: 'key',
      type: e.type,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      location: e.location,
      repeat: e.repeat,
      mods: mods(e),
      editable: isEditable(el),
    });
  }

  function onInput(e) {
    if (!e.isTrusted) return;
    const el = eventTarget(e);
    if (isSensitive(el)) return;
    if (isExcluded(el)) return;
    const sel = selectorFor(el);
    if (!sel) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file')) return;
      if (isStaleFieldEvent(el, el.value)) return; // 注入前的旧输入，不广播
      send({ kind: 'input', sel, value: el.value });
    } else if (el instanceof HTMLElement && el.isContentEditable) {
      const host = el.closest('[contenteditable]:not([contenteditable="false"])') || el;
      send({ kind: 'input', sel: selectorFor(host), html: host.innerHTML });
    }
  }

  function onChange(e) {
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
    return resolveSelector(ev.sel) || elementAtViewportRatio(ev.vx, ev.vy);
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
    if (ev.sel && !target) return;
    const m = scrollMetrics(target);
    const x = ev.mode === 'relative' ? ev.rx * Math.max(0, m.maxX) : ev.x;
    const y = ev.mode === 'relative' ? ev.ry * Math.max(0, m.maxY) : ev.y;
    (target || window).scrollTo({ left: x, top: y, behavior: 'instant' });
    const after = scrollMetrics(target);
    lastApplied.set(ev.sel || '', { x: after.x, y: after.y, t: performance.now() });
  }

  const FOCUSABLE = 'input,textarea,select,button,a[href],area[href],summary,[tabindex],[contenteditable]:not([contenteditable="false"])';

  function replayClick(ev) {
    const el = resolveTarget(ev);
    if (!el) return;
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
    if (ev.detail === 2) el.dispatchEvent(new MouseEvent('dblclick', { ...base, buttons: 0 }));
  }

  function replayFocus(ev) {
    const el = resolveSelector(ev.sel);
    if (el && typeof el.focus === 'function' && deepActiveElement() !== el) el.focus({ preventScroll: true });
  }

  function replayKey(ev) {
    const target = deepActiveElement() || document.body;
    if (!target || isSensitive(target)) return;
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
    const el = resolveSelector(ev.sel);
    if (!el || isSensitive(el)) return;
    if (ev.html != null) {
      if (el.innerHTML === ev.html) return;
      el.innerHTML = ev.html;
    } else {
      if (el.value === ev.value) return;
      setNativeValue(el, ev.value);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  }

  function replayChange(ev) {
    const el = resolveSelector(ev.sel);
    if (!el || isSensitive(el)) return;
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

  const REPLAY = {
    scroll: replayScroll,
    click: replayClick,
    focus: replayFocus,
    key: replayKey,
    input: replayInput,
    change: replayChange,
  };

  // 精确模式用：计算目标元素在顶层视口中的坐标
  function locate(ev) {
    const el = resolveTarget(ev);
    if (!el) return null;
    const p = pointFor(el, ev);
    return { x: p.x, y: p.y, visible: document.visibilityState === 'visible' };
  }

  // ---------------------------------------------------------------------------
  // 切换提示条（由 Service Worker 下发：同步开启/关闭时弹出）
  // 用独立的 setTimeout 管理，不依赖 ac.signal —— 关闭同步拆除本脚本后，
  // 提示条仍能正常淡出。
  // ---------------------------------------------------------------------------
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
      + `background:${on ? '#15803d' : '#475569'};`
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
  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.type) {
      case 'mts:replay':
        if (msg.event.frame === FRAME_KEY) {
          try { REPLAY[msg.event.kind]?.(msg.event); } catch (err) { console.debug('[归档同步助手] 回放失败', err); }
        }
        return;
      case 'mts:locate':
        if (FRAME_KEY === 'top') sendResponse(locate(msg.event));
        return;
      case 'mts:ping':
        if (FRAME_KEY === 'top') sendResponse(true);
        return;
      case 'mts:toast':
        // 仅顶层框架显示，避免同页多框架叠出多层提示条
        if (FRAME_KEY === 'top') {
          showToast(msg.on, msg.count || 0);
          sendResponse(true);
        }
        return;
      case 'mts:teardown':
        teardown();
        return;
      case 'mts:config': {
        excluded.clear();
        fieldLabels = {};
        for (const f of msg.excluded || []) {
          excluded.add(f.key);
          fieldLabels[f.key] = f.label || f.key;
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
    ac.abort();
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* 上下文已失效 */ }
    delete window.__archiveSyncHelper;
  }

  const capture = { capture: true, signal };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
  document.addEventListener('click', onClick, capture);
  document.addEventListener('focusin', onFocusIn, capture);
  document.addEventListener('keydown', onKey, capture);
  document.addEventListener('keyup', onKey, capture);
  document.addEventListener('input', onInput, capture);
  document.addEventListener('change', onChange, capture);
  chrome.runtime.onMessage.addListener(onMessage);

  window.__archiveSyncHelper = true;
})();
