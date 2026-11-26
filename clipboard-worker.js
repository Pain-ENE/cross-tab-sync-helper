// Clipboard commands run only from a menu, the extension popup or the clear shortcut.
const CLIPBOARD_PAGE = 'clipboard-offscreen.html';
const PASTE_LIMIT = 9;
const PASTE_PREFIX = 'mts-paste-';
let creatingClipboardDocument;
let clipboardBusy = false;

async function clipboardCommand(action, expected) {
  const url = chrome.runtime.getURL(CLIPBOARD_PAGE);
  if (!creatingClipboardDocument) {
    creatingClipboardDocument = (async () => {
      const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
      if (open.length === 0) {
        await chrome.offscreen.createDocument({
          url: CLIPBOARD_PAGE, reasons: ['CLIPBOARD'],
          justification: 'Read or clear the system clipboard when the user invokes a clipboard command.',
        });
      }
    })().finally(() => { creatingClipboardDocument = null; });
  }
  await creatingClipboardDocument;
  const result = await deadline(chrome.runtime.sendMessage({ target: 'mts:offscreen', action, expected }), 2500);
  if (!result || result.error) throw new Error('clipboard-unavailable');
  return result;
}

function pasteAssignments(text, mode, tabIds) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = mode === 'lines' ? normalized.split('\n', PASTE_LIMIT) : null;
  return tabIds.slice(0, PASTE_LIMIT).flatMap((tabId, index) => {
    const value = lines ? lines[index] : normalized;
    return value ? [{ tabId, index, value }] : [];
  });
}

function pastePreview(text) {
  let preview = '';
  let count = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (count++ === 30) return preview + '…';
    preview += segment;
  }
  return preview;
}

function clipboardNotice(tabId, title, preview) {
  return chrome.tabs.sendMessage(tabId, { type: 'mts:clipboard-toast', title, preview }, { frameId: 0 })
    .catch(() => {
      // Some pages have no injected content script, including pages outside the sync group.
      if (preview !== undefined) return;
      return chrome.notifications.create({
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '跨标签页操作同步助手', message: title,
      }).catch(() => {});
    });
}

async function requestClipboardClear(tabId) {
  if (clipboardBusy) {
    if (tabId != null) void clipboardNotice(tabId, '正在粘贴，请稍后再清空剪贴板');
    return;
  }
  clipboardBusy = true;
  let message = '剪贴板已清空';
  try {
    const result = await clipboardCommand('clear');
    if (result.status !== 'cleared') message = '清空剪贴板失败';
  } catch {
    message = '清空剪贴板失败';
  } finally {
    clipboardBusy = false;
  }
  const target = tabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (target != null) void clipboardNotice(target, message);
}

async function requestPaste(mode, tab, { frameId, fromMenu = false } = {}) {
  if (!['all', 'lines'].includes(mode) || tab?.id == null) return { message: '找不到当前标签页。' };
  if (clipboardBusy) return { message: '另一项剪贴板操作正在进行。' };
  clipboardBusy = true;
  const source = tab.id;
  try {
    const s = await getState();
    if (!s.enabled || !s.tabIds.includes(source)) return { message: '请在已开启同步的组内页面执行粘贴。' };
    const members = s.tabIds.slice(0, PASTE_LIMIT);
    if (!members.includes(source)) return { message: '请从同步组的前 9 个标签页执行粘贴。' };
    const run = syncRun;
    const versions = new Map(members.map((id) => [id, generation(id)]));
    if (!routes.has(source)) await inject(source);
    const sourceFrames = [...(routes.get(source)?.entries() || [])];
    const candidates = frameId == null
      ? sourceFrames : sourceFrames.filter(([, route]) => route.frameId === frameId);
    const targets = await Promise.all(candidates.map(async ([key, route]) => {
      const valid = await toFrame(source, route, { type: 'mts:paste-target', fromMenu }).catch(() => false);
      return valid ? key : null;
    }));
    const validFrames = targets.filter((key) => key != null);
    if (validFrames.length !== 1) return { message: '请先将光标放入要粘贴的编辑位置。' };

    const { snapshot } = await clipboardCommand('read');
    if (!snapshot?.text) return { message: '剪贴板里没有可粘贴的纯文本。' };
    const assignments = pasteAssignments(snapshot.text, mode, members);
    if (!assignments.length) return { message: '前几行没有可粘贴的内容。' };
    if (run !== syncRun || generation(source) !== versions.get(source) || !state.enabled ||
        members.some((id, index) => state.tabIds[index] !== id) ||
        state.tabIds.slice(0, PASTE_LIMIT).length !== members.length) {
      return { message: '同步组或当前页面已变化，请重新粘贴。' };
    }

    const queuedAt = Date.now();
    const sequence = ++eventSequence;
    const results = await Promise.all(assignments.map(({ tabId, value }) => new Promise((finish) => {
      enqueue(tabId, {
        source, run, queuedAt, sequence, generation: versions.get(tabId),
        sourceGeneration: versions.get(source), finish,
        event: { kind: 'paste', frame: validFrames[0], fromMenu: fromMenu && tabId === source, text: value },
      });
    })));
    const applied = results.filter((code) => code === 'applied' || code === 'handled').length;
    let clearStatus = 'unchanged';
    if (applied) {
      const cleared = await clipboardCommand('clear', snapshot).catch(() => ({ status: 'failed' }));
      clearStatus = cleared.status;
    }
    const summary = `${applied}/${assignments.length} 页已处理 · ${{
      cleared: '剪贴板已清空', changed: '已保留新复制的内容',
      failed: '剪贴板清空失败', unchanged: '剪贴板已保留',
    }[clearStatus]}`;
    let notifiedSource = false;
    assignments.forEach(({ tabId, index, value }, position) => {
      if (generation(tabId) !== versions.get(tabId)) return;
      const code = results[position];
      const success = code === 'applied' || code === 'handled';
      const label = code === 'applied' ? '已粘贴' : code === 'handled' ? '页面已接收粘贴' : '粘贴未确认';
      const row = mode === 'lines' ? `第 ${index + 1} 行 · ` : '';
      const title = row + label + (tabId === source ? ' · ' + summary : '');
      void clipboardNotice(tabId, title, success ? pastePreview(value) : undefined);
      if (tabId === source) notifiedSource = true;
    });
    if (!notifiedSource && generation(source) === versions.get(source)) {
      void clipboardNotice(source, summary);
    }
    return { clean: applied === assignments.length && ['cleared', 'changed'].includes(clearStatus), message: summary, notified: true };
  } catch {
    return { message: '剪贴板操作失败，请重试。' };
  } finally {
    clipboardBusy = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'editable', 'selection'];
    const documentUrlPatterns = ['http://*/*', 'https://*/*', 'file:///*'];
    chrome.contextMenus.create({ id: PASTE_PREFIX + 'all', title: '同步粘贴', contexts, documentUrlPatterns });
    chrome.contextMenus.create({ id: PASTE_PREFIX + 'lines', title: '分行粘贴', contexts, documentUrlPatterns });
  });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (typeof info.menuItemId !== 'string' || !info.menuItemId.startsWith(PASTE_PREFIX)) return;
  await runPasteAction(info.menuItemId.slice(PASTE_PREFIX.length), tab, { frameId: info.frameId ?? 0, fromMenu: true });
});

async function runPasteAction(mode, tab, options) {
  const result = await requestPaste(mode, tab, options);
  if (!result.notified && tab?.id != null) await clipboardNotice(tab.id, result.message);
}
