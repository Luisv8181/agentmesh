// Shared, DOM-free helpers for the AgentMesh extension. Also loaded by the unit tests in Node.
(function (root) {
  const START = '=== MESH BRIEF ===';
  const END = '=== END MESH BRIEF ===';
  const SITES = {
    'chatgpt.com': 'chatgpt',
    'claude.ai': 'claude',
    'gemini.google.com': 'gemini'
  };
  const SITE_URLS = { chatgpt: 'https://chatgpt.com/', claude: 'https://claude.ai/new', gemini: 'https://gemini.google.com/app' };
  const SITE_NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };

  function siteOf(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return SITES[host] || null;
    } catch {
      return null;
    }
  }

  /** Every complete MESH BRIEF block in the page text, in order. */
  function allBriefs(text) {
    const out = [];
    let from = 0;
    for (;;) {
      const s = text.indexOf(START, from);
      if (s === -1) break;
      const e = text.indexOf(END, s + START.length);
      if (e === -1) break;
      // A START inside this span means the earlier START was never closed (e.g. the protocol text).
      const inner = text.lastIndexOf(START, e);
      out.push(text.slice(inner, e + END.length));
      from = e + END.length;
    }
    return out;
  }

  /**
   * Pairing code shown by the AgentMesh dashboard: "AM1-<port>-<token>".
   * Returns null for anything else so a mistyped code gives a clear error.
   */
  function parsePairingCode(code) {
    const m = String(code || '').trim().match(/^AM1-(\d{2,5})-([A-Za-z0-9_-]{20,})$/);
    return m ? { port: Number(m[1]), token: m[2] } : null;
  }

  const lib = { START, END, SITES, SITE_URLS, SITE_NAMES, siteOf, allBriefs, parsePairingCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.AgentMeshLib = lib;
})(typeof globalThis !== 'undefined' ? globalThis : this);
