// AgentMesh side panel: sits beside the real ChatGPT / Claude / Gemini tab.
const lib = globalThis.AgentMeshLib;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { conn: null, data: null, tab: null, site: null, next: null };

// ---------- AgentMesh connection ----------
async function api(path, body) {
  const { port, token } = state.conn;
  const res = await fetch(`http://127.0.0.1:${port}/api/ext/${path}`, body === undefined
    ? { headers: { 'x-agentmesh-ext': token } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agentmesh-ext': token }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { await chrome.storage.local.remove('conn'); state.conn = null; show('pair'); throw new Error('Please connect again.'); }
  if (!res.ok) throw new Error(json.error || `AgentMesh said ${res.status}`);
  return json;
}

function show(view) {
  for (const v of ['pair', 'main', 'offline']) $(`#${v}`).hidden = v !== view;
  $('#conn').className = `dot ${view === 'main' ? 'ok' : view === 'offline' ? 'warn' : 'off'}`;
}

async function load() {
  const saved = await chrome.storage.local.get('conn');
  state.conn = saved.conn ?? null;
  if (!state.conn) return show('pair');
  try {
    state.data = await api('state');
    show('main');
    await updateTab();
  } catch (e) {
    if (state.conn) show('offline');
  }
}

// ---------- Which site is this tab? ----------
async function updateTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab ?? null;
  state.site = tab?.url ? lib.siteOf(tab.url) : null;
  render();
}

function render() {
  if (!state.data) return;
  const d = state.data;
  $('#project').textContent = d.project ? `· ${d.project}` : '';
  $('#here').innerHTML = state.site
    ? `You’re in <b>${lib.SITE_NAMES[state.site]}</b>.`
    : 'Open ChatGPT, Claude or Gemini in this window to use AgentMesh here.';
  $('#sites').innerHTML = ['chatgpt', 'claude', 'gemini'].map((s) => {
    const k = d.knowledge[s];
    const dot = s === state.site ? 'here' : !k.protocolInstalled ? 'off' : k.upToDate ? 'ok' : 'warn';
    return `<div class="site"><span class="dot ${dot}" style="margin-top:6px"></span><div><b>${lib.SITE_NAMES[s]}</b><div class="muted">${esc(k.protocolInstalled ? k.summary : 'Magic words not set up yet (see AI websites in AgentMesh).')}</div></div></div>`;
  }).join('');
  $('#wrap-btn').disabled = !state.site;
  $('#continue-btns').innerHTML = ['chatgpt', 'claude', 'gemini'].map((s) =>
    `<button class="btn" data-to="${s}" ${s === state.site ? 'disabled' : ''}>${lib.SITE_NAMES[s]}${s === state.site ? ' (you’re here)' : ''}</button>`).join('');
}

function status(el, kind, text) {
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = text;
}

// ---------- Talk to the page (inject the helper if the tab was open before install) ----------
async function toPage(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

// ---------- Wrap up here ----------
$('#wrap-btn').addEventListener('click', async () => {
  const el = $('#wrap-status');
  if (!state.tab || !state.site) return;
  status(el, 'wait', '<span class="pulse">Sending <b>mesh wrap</b>… waiting for the handoff note.</span>');
  try {
    const r = await toPage(state.tab.id, { type: 'wrap' });
    if (!r?.ok) status(el, 'err', esc(r?.error || 'Couldn’t send it on this page.'));
  } catch (e) {
    status(el, 'err', esc(e.message));
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'brief') return;
  const el = $('#wrap-status');
  if (!msg.text) return status(el, 'err', 'No handoff note appeared. Are the magic words set up on this site? (AgentMesh → AI websites.)');
  api('brief', { from: msg.site, text: msg.text })
    .then(async (brief) => {
      status(el, 'ok', `✓ Handoff note saved${brief.keyFiles?.length ? ` (mentions ${brief.keyFiles.length} file${brief.keyFiles.length === 1 ? '' : 's'})` : ''}. Now pick where to continue.`);
      state.data = await api('state');
      render();
    })
    .catch((e) => status(el, 'err', esc(e.message)));
});

// ---------- Continue in … ----------
$('#continue-btns').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-to]');
  if (!btn) return;
  const to = btn.dataset.to;
  const box = $('#next');
  box.hidden = false;
  const st = $('#next-status');
  status(st, 'wait', `<span class="pulse">Getting things ready for ${lib.SITE_NAMES[to]}…</span>`);
  try {
    const next = await api('continue', { to });
    state.next = { to, ...next };
    await navigator.clipboard.writeText(next.message).catch(() => {});

    // Reuse an open tab for that site in this window, or open one.
    const tabs = await chrome.tabs.query({ currentWindow: true });
    let tab = tabs.find((t) => t.url && lib.siteOf(t.url) === to);
    if (tab) await chrome.tabs.update(tab.id, { active: true });
    else tab = await chrome.tabs.create({ url: lib.SITE_URLS[to], active: true });

    let placed = null;
    for (let i = 0; i < 40 && !placed?.ok; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const t = await chrome.tabs.get(tab.id);
      if (t.status !== 'complete') continue;
      placed = await toPage(tab.id, { type: 'insert', text: next.message }).catch(() => null);
    }
    const attach = next.github
      ? `<div class="small" style="margin-top:6px">📦 ${esc(next.github.how)}</div>${next.github.inSync ? '' : '<div class="small" style="margin-top:4px"><b>Save to GitHub first</b> in AgentMesh so it sees your latest changes.</div>'}`
      : next.files.length
        ? `<div class="small" style="margin-top:6px">Attach these with the paperclip:</div><div class="files">${next.files.map((f) => `<span class="file">${esc(f.path)}</span>`).join('')}</div>`
        : '';
    status(st, placed?.ok ? 'ok' : 'err', placed?.ok
      ? `✓ Message placed in ${lib.SITE_NAMES[to]}. ${next.files.length ? 'Attach the files below, then' : 'Check it, then'} press Enter.${attach}`
      : `${esc(placed?.error || `Couldn’t reach ${lib.SITE_NAMES[to]}’s message box.`)} The message is on your clipboard: click the box and press Ctrl+V.${attach}`);
    $('#next-files').innerHTML = '';
    $('#open-folder').hidden = next.files.length === 0;
  } catch (e) {
    status(st, 'err', esc(e.message));
  }
});

$('#open-folder').addEventListener('click', () => api('open-folder', {}).catch(() => {}));

$('#done-btn').addEventListener('click', async () => {
  if (!state.next) return;
  try {
    await api('pass', { to: state.next.to, files: state.next.files.map((f) => f.path), viaGitHub: !!state.next.github });
    status($('#next-status'), 'ok', `✓ ${lib.SITE_NAMES[state.next.to]} is up to date. Keep working there; click <b>Wrap up here</b> when you switch again.`);
    state.next = null;
    $('#open-folder').hidden = true;
    state.data = await api('state');
    render();
  } catch (e) {
    status($('#next-status'), 'err', esc(e.message));
  }
});

// ---------- Pairing ----------
$('#pair-btn').addEventListener('click', async () => {
  const conn = lib.parsePairingCode($('#pair-code').value);
  const err = $('#pair-error');
  if (!conn) { err.hidden = false; err.textContent = 'That isn’t a pairing code. Copy it again from AgentMesh → AI websites → Connect your browser.'; return; }
  state.conn = conn;
  try {
    state.data = await api('state');
    await chrome.storage.local.set({ conn });
    show('main');
    await updateTab();
  } catch (e) {
    state.conn = null;
    err.hidden = false;
    err.textContent = /fetch/i.test(e.message) ? 'Can’t reach AgentMesh. Is it running?' : e.message;
  }
});

$('#retry').addEventListener('click', load);
$('#disconnect').addEventListener('click', async (e) => { e.preventDefault(); await chrome.storage.local.remove('conn'); state.conn = null; show('pair'); });
$('#open-dashboard').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: `http://127.0.0.1:${state.conn.port}/` }); });

chrome.tabs.onActivated.addListener(updateTab);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && info.url) updateTab(); });
setInterval(() => { if (state.conn && !$('#main').hidden) api('state').then((d) => { state.data = d; render(); }).catch(() => show('offline')); }, 30_000);

load();
