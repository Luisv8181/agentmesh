// Runs inside chatgpt.com, claude.ai and gemini.google.com. It only ever:
//  1. puts text into the message box (and presses send for "mesh wrap"),
//  2. watches for the MESH BRIEF the person asked for, and hands that block to the side panel.
// It reads nothing else from the page and stores nothing.
(function () {
  const lib = globalThis.AgentMeshLib;

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden';
  }

  /** The chat's message box: known selectors first, then the lowest editable box on screen. */
  function findComposer() {
    const known = ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'rich-textarea [contenteditable="true"]', 'textarea[aria-label]'];
    for (const sel of known) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return el;
    }
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].filter(visible);
    candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return candidates[0] || null;
  }

  function currentText(el) {
    return el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  }

  function insertText(text) {
    const el = findComposer();
    if (!el) return { ok: false, error: 'Couldn’t find the message box on this page. Click into it once and try again.' };
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, (el.value ? `${el.value}\n` : '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Put the caret at the end, then insert the way typing would (works with ProseMirror/Quill editors).
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      sel.collapseToEnd();
      const ok = document.execCommand('insertText', false, text);
      if (!ok || !currentText(el).includes(text.slice(0, 40))) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }
    return currentText(el).includes(text.slice(0, 40))
      ? { ok: true }
      : { ok: false, error: 'The site didn’t accept the text. Click into the message box, press Ctrl+V, and paste it yourself (it’s on your clipboard).' };
  }

  function findSendButton() {
    const sel = ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="Submit" i]', 'button.send-button'];
    for (const s of sel) {
      const b = [...document.querySelectorAll(s)].find((x) => visible(x) && !x.disabled);
      if (b) return b;
    }
    return null;
  }

  async function send() {
    // Editors enable the send button a moment after text arrives.
    for (let i = 0; i < 20; i++) {
      const b = findSendButton();
      if (b) { b.click(); return { ok: true }; }
      await new Promise((r) => setTimeout(r, 100));
    }
    const el = findComposer();
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return { ok: true, pressedEnter: true };
  }

  let watcher = null;
  /**
   * Waits for a new complete brief (more than `baseline` in the page), then for it to stop changing
   * (the reply finished streaming), and reports it once.
   */
  function watchForBrief(baseline, onBrief) {
    if (watcher) clearInterval(watcher);
    let last = '';
    let stableSince = 0;
    const started = Date.now();
    watcher = setInterval(() => {
      const briefs = lib.allBriefs(document.body.innerText);
      if (briefs.length > baseline) {
        const latest = briefs[briefs.length - 1];
        if (latest !== last) { last = latest; stableSince = Date.now(); }
        else if (Date.now() - stableSince > 1500) {
          clearInterval(watcher); watcher = null;
          onBrief(latest);
        }
      } else if (Date.now() - started > 5 * 60_000) {
        clearInterval(watcher); watcher = null;
        onBrief(null);
      }
    }, 500);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    (async () => {
      if (msg.type === 'ping') return reply({ ok: true, site: lib.siteOf(location.href), composer: !!findComposer() });
      if (msg.type === 'insert') return reply(insertText(msg.text));
      if (msg.type === 'wrap') {
        const baseline = lib.allBriefs(document.body.innerText).length;
        const r = insertText('mesh wrap');
        if (!r.ok) return reply(r);
        await send();
        watchForBrief(baseline, (text) => chrome.runtime.sendMessage({ type: 'brief', site: lib.siteOf(location.href), text }));
        return reply({ ok: true });
      }
      reply({ ok: false, error: 'Unknown request' });
    })();
    return true; // async reply
  });
})();
