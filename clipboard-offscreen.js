// execCommand supports clipboard access in an offscreen extension document, which cannot take focus.
const field = document.getElementById('clipboard');

function snapshotClipboard() {
  let snapshot;
  function onPaste(event) {
    event.preventDefault();
    const data = event.clipboardData;
    snapshot = {
      text: data.getData('text/plain'),
      types: [...data.types].sort().join('\n'),
      html: data.getData('text/html'),
    };
  }
  field.value = '';
  field.focus();
  document.addEventListener('paste', onPaste, { capture: true, once: true });
  try {
    document.execCommand('paste');
    if (!snapshot) throw new Error('clipboard-read-failed');
    return snapshot;
  } finally {
    document.removeEventListener('paste', onPaste, true);
    field.value = '';
  }
}

function clearClipboard(expected) {
  const before = snapshotClipboard();
  if (expected && (before.text !== expected.text || before.types !== expected.types ||
      before.html !== expected.html)) return 'changed';
  if (!before.types && !before.text) return 'cleared';

  // Select an offscreen placeholder only to invoke Copy. Cancel the browser default
  // so the placeholder can never become the clipboard contents.
  function onCopy(event) {
    event.preventDefault();
    event.clipboardData.setData('text/plain', '');
  }
  field.value = ' ';
  field.select();
  document.addEventListener('copy', onCopy, { capture: true, once: true });
  try {
    if (!document.execCommand('copy')) return 'failed';
  } finally {
    document.removeEventListener('copy', onCopy, true);
    field.value = '';
  }
  const after = snapshotClipboard();
  return !after.text && (!after.types || after.types === 'text/plain') ? 'cleared' : 'failed';
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.target !== 'mts:offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  try {
    if (msg.action === 'read') respond({ snapshot: snapshotClipboard() });
    if (msg.action === 'clear') respond({ status: clearClipboard(msg.expected) });
  } catch { respond({ error: true }); }
});
