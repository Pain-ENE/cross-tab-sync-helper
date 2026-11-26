const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture({ throttled = false } = {}) {
  const observers = new Set();
  const timers = new Map();
  let tid = 0;
  const notify = () => { for (const obs of [...observers]) obs.callback(); };
  class Element extends EventTarget {
    constructor(tag = 'div') {
      super(); this.localName = tag; this.nodeType = 1; this.id = ''; this.title = ''; this.textContent = '';
      this.visible = true; this.children = []; this.attrs = {}; this.isConnected = true;
      this.classes = new Set(); this.classList = { contains: c => this.classes.has(c), add() {}, remove() {}, toggle() {} };
      this.style = { setProperty() {} };
    }
    getRootNode() { return doc; }
    closest(sel) { return this.closestMap?.[sel] || null; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    getClientRects() { return this.visible ? [{}] : []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; }
    querySelector(sel) { return sel === '.dui-calendar-date' ? this.button : null; }
    appendChild(el) { this.children.push(el); }
    remove() { this.isConnected = false; }
    click() { this.clicks = (this.clicks || 0) + 1; this.onClick?.(); }
  }
  class Input extends Element { constructor() { super('input'); this.value = ''; } }
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const address = new Input(); address.value = 'D2';
  const formula = new Element(); formula.textContent = '2026/11/28';
  const icon = new Element(); const calendar = new Element(); calendar.visible = false;
  const day = new Element('td'); day.title = '2026年11月27日';
  const button = new Element(); day.button = button;
  const iconSel = '.date-time-cell-icon-date-pc.date-time-cell-icon-active';
  const daySel = '.dui-datepicker .dui-calendar-date-panel td[title]';
  icon.closestMap = { [iconSel]: icon };
  day.closestMap = { [daySel]: day };
  icon.onClick = () => { calendar.visible = !calendar.visible; notify(); };
  button.onClick = () => { formula.textContent = '2026/11/27'; calendar.visible = false; notify(); };
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.documentElement = new Element(); doc.body = new Element('body'); doc.activeElement = doc.body;
  doc.querySelector = sel => sel === 'input.bar-label' ? address : sel === '#alloy-simple-text-editor' ? formula : null;
  doc.querySelectorAll = sel => sel === '.dui-datepicker' ? [calendar] : sel === iconSel ? [icon] : sel === daySel && calendar.visible ? [day] : [];
  doc.createElement = tag => new Element(tag);
  const win = new EventTarget(); win.top = win;
  const sent = [];
  const classes = { Element, HTMLElement: Element, HTMLInputElement: Input };
  for (const n of ['HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLLabelElement', 'HTMLButtonElement', 'HTMLIFrameElement', 'ShadowRoot']) classes[n] = class extends Element {};
  let listener;
  const context = vm.createContext({
    ...classes, window: win, document: doc, location: { hostname: 'docs.qq.com', pathname: '/sheet/test' },
    AbortController, MutationObserver: Observer, performance, Event, Node: {ELEMENT_NODE:1}, CSS: {escape:s=>s}, requestAnimationFrame:()=>1, cancelAnimationFrame(){}, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: el => ({ visibility: el.visible ? 'visible' : 'hidden' }),
    setTimeout: (cb, ms) => { const id = ++tid; timers.set(id, { cb, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: { runtime: {
      sendMessage: msg => { sent.push(msg); return Promise.resolve(); },
      onMessage: { addListener: cb => { listener = cb; }, removeListener() {} },
    } },
    mtsCursorColors: { defaultColor: '#39746c', normalize: s => s || '#39746c', appearance: () => ({light:'#fff',dark:'#000',rgb:'0,0,0'}) },
  });
  context.globalThis = context;
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  vm.runInContext(source.replace('  return (window.__archiveSyncHelper = FRAME_KEY);', `
    globalThis.testApi = { replaySheetDate, replaySheetCalendar, onClick, onWheel, flushWheel, onScroll, teardown };
    return (window.__archiveSyncHelper = FRAME_KEY);`), context);
  const config = (values = {}) => listener({ type: 'mts:config', enabled: true, ghost: false, ...values }, {}, () => {});
  config();
  const event = (values = {}) => ({ frame: 'top', cell: 'D2', date: '2026/11/27', deadline: Date.now() + 650, ...values });
  const replay = (kind, values = {}) => new Promise(resolve => listener({ type: 'mts:replay', event: event({ kind, ...values }) }, {}, resolve));
  return { Element, ...context.testApi, address, formula, icon, day, button, calendar, notify, observers, timers, config, event, sent, replay, doc };
}

test('calendar opener captures semantic state and cell instead of a structural click', () => {
  const f = fixture();
  f.onClick({ isTrusted: true, button: 0, composedPath: () => [f.icon] });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].event.kind, 'sheet-calendar');
  assert.equal(f.sent[0].event.cell, 'D2'); assert.equal(f.sent[0].event.open, true);
});
test('open and close set desired state once, including when already open', async () => {
  const f = fixture();
  assert.equal(await f.replay('sheet-calendar', { open: true }), 'applied');
  assert.equal(await f.replay('sheet-calendar', { open: true }), 'applied');
  assert.equal(f.icon.clicks, 1);
  assert.equal(await f.replay('sheet-calendar', { open: false }), 'applied');
  assert.equal(f.icon.clicks, 2); assert.equal(f.observers.size, 0);
});
test('closed popup opens immediately and picks the exact date once without any timer tick', async () => {
  const f = fixture();
  assert.equal(await f.replay('sheet-date'), 'applied');
  assert.equal(f.icon.clicks, 1); assert.equal(f.button.clicks, 1);
  assert.equal(f.observers.size, 0); assert.equal(f.timers.size, 0);
});
test('asynchronous formula confirmation wakes from mutation even when timers never run', async () => {
  const f = fixture(); f.calendar.visible = true;
  f.button.onClick = () => { f.calendar.visible = false; };
  let settled = false;
  const pending = f.replay('sheet-date').then(s => { settled = true; return s; });
  await Promise.resolve(); assert.equal(settled, false);
  // Unrelated DOM changes must not repeat the date click.
  for (let n = 0; n < 20; n++) f.notify();
  assert.equal(f.button.clicks, 1);
  f.formula.textContent = '2026/11/27'; f.notify();
  assert.equal(await pending, 'applied'); assert.equal(f.observers.size, 0);
});
test('waits for popup mounting without toggling it twice', async () => {
  const f = fixture(); f.icon.onClick = () => {};
  const pending = f.replay('sheet-date');
  f.notify(); assert.equal(f.icon.clicks, 1);
  f.calendar.visible = true; f.notify();
  assert.equal(await pending, 'applied'); assert.equal(f.button.clicks, 1);
});
test('wrong cell, missing date, disabled or isolated day never writes to a different cell', async () => {
  for (const mode of ['cell', 'month', 'disabled', 'isolated']) {
    const f = fixture(); f.calendar.visible = true;
    if (mode === 'cell') f.address.value = 'D3';
    if (mode === 'month') f.day.title = '2026年12月27日';
    if (mode === 'disabled') f.button.attrs['aria-disabled'] = 'true';
    if (mode === 'isolated') { f.button.id = 'isolated'; f.config({ excluded: [{ key: 'id:isolated' }] }); }
    const pending = f.replay('sheet-date');
    for (const timer of [...f.timers.values()]) timer.cb();
    assert.equal(await pending, mode === 'isolated' ? 'isolated' : 'missing-target');
    assert.equal(f.button.clicks, undefined); assert.equal(f.observers.size, 0);
  }
});
test('reports unconfirmed without retry when page ignores a date click', async () => {
  const f = fixture(); f.calendar.visible = true; f.button.onClick = () => {};
  const pending = f.replay('sheet-date');
  for (const timer of [...f.timers.values()]) timer.cb();
  assert.equal(await pending, 'date-unconfirmed'); assert.equal(f.button.clicks, 1);
});
test('disable and teardown cancel pending observers and prevent late clicks', async () => {
  for (const stop of [f => f.config({ enabled: false }), f => f.teardown()]) {
    const f = fixture(); f.icon.onClick = () => {};
    const pending = f.replay('sheet-date'); stop(f);
    f.calendar.visible = true; f.notify();
    assert.equal(await pending, 'expired'); assert.equal(f.button.clicks, undefined);
    assert.equal(f.observers.size, 0); assert.equal(f.timers.size, 0);
  }
});
test('already confirmed date needs no reopen or second click', async () => {
  const f = fixture(); f.formula.textContent = '2026/11/27';
  assert.equal(await f.replay('sheet-date'), 'applied'); assert.equal(f.icon.clicks, undefined);
});

test('hidden Tencent calendar reports a useful status without opening or clicking', async () => {
  const f = fixture(); f.doc.visibilityState = 'hidden';
  assert.equal(await f.replay('sheet-calendar', {open:true}), 'background-tab');
  assert.equal(await f.replay('sheet-date'), 'background-tab');
  assert.equal(f.icon.clicks, undefined); assert.equal(f.button.clicks, undefined);
  assert.equal(f.observers.size, 0);
});
test('hiding a page while waiting cancels it before delayed mount', async () => {
  const f = fixture(); f.icon.onClick = () => {};
  const pending = f.replay('sheet-date');
  f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange'));
  f.calendar.visible = true; f.notify();
  assert.equal(await pending, 'background-tab'); assert.equal(f.button.clicks, undefined);
});
test('different displayed month navigates once and then selects full date', async () => {
  const f = fixture(); f.calendar.visible = true; f.day.title='2026年12月27日';
  const year=new f.Element(); year.textContent='2026';
  const month=new f.Element(); month.textContent='12月';
  const prev=new f.Element();
  prev.onClick=()=>{ month.textContent='11月'; f.day.title='2026年11月27日'; f.notify(); };
  f.calendar.querySelector=sel=>sel.includes('header-year')?year:sel.includes('header-month')?month:sel.includes('header-prev')?prev:null;
  assert.equal(await f.replay('sheet-date'),'applied');
  assert.equal(prev.clicks,1); assert.equal(f.button.clicks,1);
});
test('month navigation never repeatedly clicks an unresponsive arrow', async () => {
  const f=fixture(); f.calendar.visible=true; f.day.title='2026年12月27日';
  const year=new f.Element(); year.textContent='2026'; const month=new f.Element(); month.textContent='12月'; const prev=new f.Element();
  f.calendar.querySelector=sel=>sel.includes('header-year')?year:sel.includes('header-month')?month:sel.includes('header-prev')?prev:null;
  const pending=f.replay('sheet-date'); for(let n=0;n<5;n++)f.notify();
  for(const timer of [...f.timers.values()])timer.cb();
  assert.equal(await pending,'missing-target'); assert.equal(prev.clicks,1); assert.equal(f.button.clicks,undefined);
});

test('a missing month header fails without guessing a navigation direction', async () => {
  const f=fixture(); f.calendar.visible=true; f.day.title='2026年12月27日';
  const year=new f.Element(); year.textContent='2026'; const arrow=new f.Element();
  f.calendar.querySelector=sel=>sel.includes('header-year')?year:sel.includes('header-month')?null:arrow;
  assert.equal(await f.replay('sheet-date'),'missing-target'); assert.equal(arrow.clicks,undefined);
});
test('custom-grid wheel batches preserve deltas within 16ms', () => {
  const f=fixture(); const canvas=new f.Element('canvas'); canvas.id='grid';
  const event={isTrusted:true,deltaX:2,deltaY:5,deltaMode:0,clientX:5,clientY:5,composedPath:()=>[canvas]};
  f.onWheel(event); f.onWheel({...event,deltaX:3,deltaY:7});
  assert.equal(f.sent.length,0); assert.ok([...f.timers.values()].some(t=>t.ms===16));
  f.flushWheel(); assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].event.deltaX,5); assert.equal(f.sent[0].event.deltaY,12);
});
test('a native scroll cancels the pending wheel replay to avoid applying it twice', () => {
  const f=fixture(); const canvas=new f.Element('canvas'); canvas.id='grid';
  f.onWheel({isTrusted:true,deltaX:0,deltaY:5,deltaMode:0,clientX:5,clientY:5,composedPath:()=>[canvas]});
  f.onScroll({target:f.doc}); f.flushWheel(); assert.equal(f.sent.length,0);
});
test('late cursor frames cannot rewind position, including after worker restart', async () => {
  const f=fixture(); f.config({ghost:true});
  const cursor=()=>f.doc.documentElement.children.find(e=>e.className==='mts-ghost-cursor');
  await f.replay('cursor',{epoch:100,sequence:5,vx:.2,vy:.2});
  assert.equal(cursor().style.transform,'translate(200px, 160px)');
  await f.replay('cursor',{epoch:100,sequence:4,vx:.1,vy:.1});
  assert.equal(cursor().style.transform,'translate(200px, 160px)');
  await f.replay('cursor',{epoch:101,sequence:1,vx:.3,vy:.3});
  assert.equal(cursor().style.transform,'translate(300px, 240px)');
  await f.replay('cursor',{epoch:100,sequence:9,vx:.4,vy:.4});
  assert.equal(cursor().style.transform,'translate(300px, 240px)');
});
