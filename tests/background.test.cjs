const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
function fixture(send) {
  const calls = [];
  const event = { addListener() {} };
  const chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}) } },
    runtime: { onMessage: event },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    debugger: { onDetach: event },
    tabs: { sendMessage: async (id, msg, route) => { calls.push({ id, msg, route }); return send?.(id, msg) ?? 'applied'; }, onUpdated: event, onRemoved: event, onReplaced: event, onActivated: event },
    windows: { onFocusChanged: event }, commands: { onCommand: event },
  };
  const timers = new Set();
  const ctx = vm.createContext({ chrome, console, URL, structuredClone, importScripts() {},
    mtsCursorColors: { defaultColor: '#39746c', normalize: s => s || '#39746c' },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); t.unref(); return t; },
    clearTimeout: t => { timers.delete(t); clearTimeout(t); },
  });
  vm.runInContext(source + `\n globalThis.api = { ready, handleEvent, invalidate, queues, visualLanes, routes, outcomes,
    init() { state = normalize({ enabled: true, tabIds: [1,2,3,4] }); leaderTabId = 1;
      for (const id of state.tabIds) routes.set(id, new Map([['top', {frameId: 0, documentId: 'doc-'+id}]])); },
    leader(id) { leaderTabId = id; }
  };`, ctx);
  return { ...ctx.api, calls, cleanup() { for (const t of timers) clearTimeout(t); } };
}

test('slow cursor acknowledgement cannot block a click or keyboard input', async () => {
  let finishCursor;
  const held = new Promise(r => { finishCursor = r; });
  const f = fixture((_id, msg) => msg.event?.kind === 'cursor' ? held : 'applied');
  await f.ready; f.init();
  await f.handleEvent({ kind: 'cursor', frame: 'top' }, { tab: {id:1}, frameId:0 });
  await f.handleEvent({ kind: 'click', frame: 'top', detail:1 }, { tab: {id:1}, frameId:0 });
  await f.handleEvent({ kind: 'key', frame: 'top', type:'keydown', key:'Enter' }, { tab: {id:1}, frameId:0 });
  await tick();
  for (const id of [2,3,4]) assert.deepEqual(f.calls.filter(c => c.id===id && c.msg.event).map(c=>c.msg.event.kind), ['cursor','click','key']);
  finishCursor('applied'); await tick(); f.cleanup();
});
test('cursor bursts retain only the latest state per frame', async () => {
  let release;
  const held = new Promise(r => { release=r; });
  const f = fixture((_id, msg) => msg.event?.vx === 0 ? held : 'applied');
  await f.ready; f.init();
  for (let x=0; x<40; x++) await f.handleEvent({kind:'cursor', frame:'top', vx:x}, {tab:{id:1}});
  assert.equal(f.calls.filter(c=>c.msg.event).length, 3);
  release('applied'); await tick();
  for (const id of [2,3,4]) assert.deepEqual(f.calls.filter(c=>c.id===id && c.msg.event).map(c=>c.msg.event.vx), [0,39]);
  assert.equal(f.visualLanes.size, 0); f.cleanup();
});
test('date, focus and later click retain action order for each follower', async () => {
  let release;
  const held = new Promise(r => {release=r;});
  const f = fixture((_id,msg)=>msg.event?.kind==='sheet-date'?held:'applied');
  await f.ready; f.init();
  for (const kind of ['sheet-calendar','sheet-date','focus','click']) await f.handleEvent({kind,frame:'top'}, {tab:{id:1}});
  await tick();
  assert.equal(f.calls.filter(c=>c.id===2 && c.msg.event).length,2);
  release('applied'); await tick();
  assert.deepEqual(f.calls.filter(c=>c.id===2 && c.msg.event).map(c=>c.msg.event.kind),['sheet-calendar','sheet-date','focus','click']);
  f.cleanup();
});
test('one disconnected follower does not hold other followers', async () => {
  const f = fixture((id,msg)=>id===2 && msg.event ? Promise.reject(new Error('disconnected')) : 'applied');
  await f.ready; f.init();
  await f.handleEvent({kind:'click',frame:'top',sentAt:Date.now()-12}, {tab:{id:1}});
  await tick();
  assert.equal(f.outcomes.get(2).code,'disconnected');
  for (const id of [3,4]) { const out=f.outcomes.get(id); assert.equal(out.code,'applied'); assert.ok(out.transportMs>=12); assert.ok(out.latency>=12); assert.ok(out.queueMs>=0); }
  f.cleanup();
});
test('navigation invalidates pending cursor updates instead of replaying into new document', async () => {
  let release;
  const held = new Promise(r=>{release=r;});
  const f=fixture((_id,msg)=>msg.event?.kind==='cursor'?held:'applied');
  await f.ready; f.init();
  for (const vx of [0,1]) await f.handleEvent({kind:'cursor',frame:'top',vx}, {tab:{id:1}});
  f.invalidate(2); release('applied'); await tick();
  assert.equal(f.calls.filter(c=>c.id===2 && c.msg.event).length,1); f.cleanup();
});
test('mouse feedback never injects a missing frame', async () => {
  const f=fixture(); await f.ready; f.init(); f.routes.delete(2);
  await f.handleEvent({kind:'press',frame:'top',on:true}, {tab:{id:1}}); await tick();
  assert.equal(f.calls.filter(c=>c.id===2 && c.msg.event).length,0); f.cleanup();
});
