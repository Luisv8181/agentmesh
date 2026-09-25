/**
 * The "baton" lets the person carry a project between AI websites (ChatGPT, Claude, Gemini) by hand.
 * Each site gets the same short protocol in its always-on instructions; two activation words drive it:
 *   "mesh wrap"  → the site replies with a MESH BRIEF (state of the work, not the conversation)
 *   "mesh start" → the next site receives that brief and continues from it
 * AgentMesh stores every brief and tracks what each site has been given.
 */

export type WebSite = 'chatgpt' | 'claude' | 'gemini';
export const WEB_SITES: WebSite[] = ['chatgpt', 'claude', 'gemini'];

export const SITE_INFO: Record<WebSite, { name: string; url: string; where: string }> = {
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    where: 'Profile icon → Settings → Personalization → Custom instructions. (Free plan: 1,500 characters total.)'
  },
  claude: {
    name: 'Claude',
    url: 'https://claude.ai',
    where: 'Settings → Profile → personal preferences. Tip: also make a Claude Project for this work and upload key files there once.'
  },
  gemini: {
    name: 'Gemini',
    url: 'https://gemini.google.com',
    where: 'Menu → Settings & help → Personal Intelligence → Instructions for Gemini → Add.'
  }
};

export const BRIEF_START = '=== MESH BRIEF ===';
export const BRIEF_END = '=== END MESH BRIEF ===';

/** Kept well under ChatGPT's 1,500-character free limit so the person can keep their own instructions too. */
export const PROTOCOL_TEXT = `AgentMesh handoff (my project relay between AI assistants):
- If I say "mesh wrap": reply ONLY with this, filled in from our chat:
${BRIEF_START}
Project:
Goal:
Decisions:
Done:
Open questions:
Next steps:
Key files: (one per line: files I shared or you made)
Code to carry over: (only short essential snippets, else "see Key files")
${BRIEF_END}
- If my message starts with "mesh start": it holds a MESH BRIEF from another assistant. Treat it as the current state of the project, newer than anything you remember. Reply with the next step in one line and ask for any Key files you need that I didn't attach.
- Otherwise, behave normally.`;

export interface ParsedBrief {
  text: string;
  project?: string;
  keyFiles: string[];
  /** false when the MESH BRIEF markers were missing: the site probably doesn't have the protocol installed. */
  wellFormed: boolean;
}

export function parseBrief(raw: string): ParsedBrief {
  const input = raw.replace(/\r\n/g, '\n').trim();
  const start = input.indexOf(BRIEF_START);
  const end = input.indexOf(BRIEF_END, start + 1);
  const wellFormed = start !== -1 && end !== -1;
  const text = wellFormed ? input.slice(start, end + BRIEF_END.length) : input;

  // Some models put the value on the same line ("Project: X"), others on the next line.
  const field = (name: string) => {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => new RegExp(`^\\s*[*_#-]*\\s*${name}\\s*[*_]*\\s*:`, 'i').test(l));
    if (i === -1) return undefined;
    const sameLine = lines[i].replace(/^[^:]*:[*_]*/, '').trim();
    if (sameLine) return sameLine;
    const next = lines.slice(i + 1).find((l) => l.trim());
    return next && !/^\s*[*_#]*\s*[A-Z][\w ]{1,30}\s*[*_]*\s*:/.test(next) && !next.includes(BRIEF_END) ? next.replace(/^[\s>*•-]+/, '').trim() : undefined;
  };

  // Key files: the rest of the "Key files:" line plus following lines until the next "Label:" line.
  const keyFiles: string[] = [];
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^\s*[*_#-]*\s*key files\s*[*_]*\s*:/i.test(l));
  if (idx !== -1) {
    const first = lines[idx].replace(/^[^:]*:/, '');
    const rest: string[] = [];
    for (const l of lines.slice(idx + 1)) {
      if (/^\s*[*_#]*\s*[A-Z][\w ]{1,30}\s*[*_]*\s*:/.test(l) || l.includes(BRIEF_END)) break;
      rest.push(l);
    }
    for (const part of [first, ...rest].flatMap((l) => l.split(/[,;]/))) {
      const name = part.replace(/^[\s>*`•\-\d.)]+/, '').replace(/[`*]/g, '').replace(/\s*\(.*\)\s*$/, '').trim();
      if (name && !/^(none|n\/a|-|see .*)$/i.test(name) && name.length < 200) keyFiles.push(name);
    }
  }

  return { text, project: field('Project'), keyFiles: [...new Set(keyFiles)], wellFormed };
}

export interface ContinueInput {
  to: WebSite;
  projectName: string;
  brief?: { text: string; from: string; at: number };
  /** Work done by AgentMesh's own coding agents since that brief. */
  agentWork: { instruction: string; agent?: string; summary: string; files: string[] }[];
  attachments: string[];
  /** When the next site reads the project from GitHub instead of attachments. */
  github?: string;
}

export function buildContinueMessage(input: ContinueInput): string {
  const parts = [`mesh start`, `(Via AgentMesh: continuing project "${input.projectName}" here on ${SITE_INFO[input.to].name}.)`];
  if (input.brief) {
    parts.push(`Latest brief, from ${input.brief.from} on ${new Date(input.brief.at).toLocaleString()}:`, input.brief.text);
  } else {
    parts.push('No brief yet: this is the start of the project. Ask me what we are working on.');
  }
  if (input.agentWork.length) {
    parts.push(
      'Since that brief, coding agents on my computer did:\n' +
        input.agentWork
          .map((w) => `- "${w.instruction.slice(0, 160)}"${w.agent ? ` (${w.agent})` : ''}: ${w.summary.replace(/\s+/g, ' ').slice(0, 240)}${w.files.length ? ` Files: ${w.files.slice(0, 8).join(', ')}` : ''}`)
          .join('\n')
    );
  }
  if (input.github) {
    parts.push(`The project files are in my GitHub repository ${input.github}, which I've added here. Use it as the latest version of the files.`);
  } else {
    parts.push(input.attachments.length ? `I'm attaching: ${input.attachments.join(', ')}` : 'No files attached this time.');
  }
  return parts.join('\n\n');
}
