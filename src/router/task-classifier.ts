/**
 * Decides whether an instruction only needs reading/answering ("read") or needs files changed ("edit").
 * Used by smart routing: questions can go to free local Ollama, edits must go to a coding agent.
 *
 * A wrong call is cheap either way: a question sent to a coding agent costs a little quota, and an
 * edit sent the read-only way changes nothing, says so, and offers "Redo with a coding agent".
 */

import { RouteDecision } from '../types.js';

/** certainty is 'clear' when the keyword rule is confident, 'unclear' when it needed (or would need) a tie-break. */
export type Classification = RouteDecision;

const EDIT_VERBS =
  /\b(add|fix|change|write|create|rename|make|translate|delete|remove|update|implement|refactor|replace|move|install|build|set ?up|convert|edit|insert|append|generate|style|redesign|clean ?up|upgrade)\b/i;
const QUESTION_START =
  /^(explain|what|why|how|which|where|when|who|is|are|does|do|can you (explain|tell)|could you (explain|tell)|list|summari[sz]e|review|compare|describe|tell me|show me|help me understand)\b/i;
const TEXT_ANSWER = /^(write|draft|give me|suggest)\b.*\b(commit message|summary|explanation|description|changelog entry|release notes|reply|email)\b/i;
const MENTIONS_FILE = /\b[\w-]+\.(md|txt|html?|js|ts|json|css|py)\b|\bfile\b/i;
const NO_CHANGES = /\b(don'?t|do not|without) (change|chang|edit|modify|touch)|\bjust (tell|explain)|\bno changes\b|\bread[- ]only\b/i;
// "…and don't change anything else / any other lines" limits an edit; it doesn't forbid one.
const LIMITS_AN_EDIT = /\b(anything|any(thing)? \w+|nothing) (else|other)\b|\bother (lines?|files?|parts?|code)\b/i;
const STARTS_WITH_EDIT = new RegExp(`^(please\\s+)?${EDIT_VERBS.source}`, 'i');

export function classifyByRule(instruction: string): Classification {
  const text = instruction.trim();
  const noChanges = NO_CHANGES.test(text) && !LIMITS_AN_EDIT.test(text) && !STARTS_WITH_EDIT.test(text);
  const asks = QUESTION_START.test(text) || /\?\s*$/.test(text);
  const edits = EDIT_VERBS.test(text);

  if (noChanges) return { kind: 'read', certainty: 'clear', by: 'rule', reason: 'you asked for no changes' };
  // "Write a commit message / summary" is answering, not editing, unless it names a file to write into.
  if (TEXT_ANSWER.test(text) && !MENTIONS_FILE.test(text)) {
    return { kind: 'read', certainty: 'clear', by: 'rule', reason: 'this asks for text, not file changes' };
  }
  if (asks && !edits) return { kind: 'read', certainty: 'clear', by: 'rule', reason: 'this looks like a question' };
  if (edits && !asks) return { kind: 'edit', certainty: 'clear', by: 'rule', reason: 'this asks for changes' };
  // Mixed ("Can you make the header sticky?") or neither: default to a coding agent unless a tie-break says otherwise.
  return { kind: 'edit', certainty: 'unclear', by: 'default', reason: 'not sure, so using a coding agent to be safe' };
}

/** Tie-break with the local Ollama model (free, private). Falls back to the rule's safe default on any problem. */
export async function classify(
  instruction: string,
  ollama?: { baseUrl: string; model: string }
): Promise<Classification> {
  const byRule = classifyByRule(instruction);
  if (byRule.certainty === 'clear' || !ollama) return byRule;

  try {
    const res = await fetch(`${ollama.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: ollama.model,
        stream: false,
        options: { temperature: 0 },
        format: { type: 'object', properties: { kind: { type: 'string', enum: ['read', 'edit'] } }, required: ['kind'] },
        messages: [
          {
            role: 'system',
            content:
              'Classify a request to a coding assistant. "edit" = fulfilling it requires creating, changing or deleting files in the project. ' +
              '"read" = it can be fully answered by reading and explaining, with no file changes. Answer as JSON.'
          },
          { role: 'user', content: instruction }
        ]
      })
    });
    if (!res.ok) return byRule;
    const kind = (JSON.parse(((await res.json()) as { message?: { content?: string } }).message?.content ?? '{}') as { kind?: string }).kind;
    if (kind === 'read' || kind === 'edit') {
      return {
        kind,
        certainty: 'unclear',
        by: 'ollama',
        reason: kind === 'read' ? 'the local model judged this a question' : 'the local model judged this needs changes'
      };
    }
  } catch {
    // Ollama not running / slow: keep the safe default.
  }
  return byRule;
}
