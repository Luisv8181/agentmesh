/**
 * CLI failures arrive as raw stderr: banners, warnings and stack traces around one line that matters.
 * These helpers find that line and, for common setup problems, say what the user should do.
 */

const NOISE = /^(warning|deprecated|note|info)\b|true color|ripgrep is not available|^\s*at\s|^-{3,}|^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(WARN|INFO|DEBUG)/i;
const SIGNAL = /error|failed|denied|expired|not supported|requires|unauthori[sz]ed|forbidden|not found|invalid|refused|timeout|limit/i;

export function keyErrorLine(raw: string, max = 400): string {
  const lines = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) => !NOISE.test(l));
  const pick = [...meaningful].reverse().find((l) => SIGNAL.test(l)) ?? meaningful[meaningful.length - 1] ?? lines[lines.length - 1] ?? raw;
  return pick.length > max ? `${pick.slice(0, max)}…` : pick;
}

const SIGN_IN: Record<string, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  agy: 'agy',
  gemini: 'gemini',
  opencode: 'opencode (then type /connect)',
  copilot: 'copilot login'
};

export function fixHint(agentId: string, agentName: string, raw: string): string | null {
  const cmd = SIGN_IN[agentId] ?? agentId;
  if (/out of (usage )?credits|requires usage credits/i.test(raw)) {
    const example = agentId === 'claude' ? ' (for example sonnet or opus)' : '';
    return `${agentName} is out of usage credits for the model it's set to use. In Settings → Models, pick a model your plan includes${example}, or wait for the credits to reset.`;
  }
  if (/requires a newer version|upgrade to the latest|please update|version is no longer supported/i.test(raw)) {
    return `${agentName} is out of date. Update it with its install command (Set up agents shows it), then press Check again.`;
  }
  if (/no longer supported for gemini code assist for individuals|migrate to the antigravity/i.test(raw)) {
    return 'Google no longer lets free personal accounts sign in to the Gemini CLI. Either use it with a free API key from aistudio.google.com/apikey (type gemini and choose the API key option), or use Google Antigravity instead (Set up agents).';
  }
  if (/api key is missing|missing api key|no api key|provider .*not (configured|connected)/i.test(raw)) {
    return agentId === 'opencode'
      ? 'OpenCode isn\'t connected to an AI provider yet: open PowerShell, type opencode, then type /connect and pick one.'
      : `${agentName} has no API key or account connected yet. Open it once in PowerShell and sign in.`;
  }
  if (/permission .*(auto-denied|cannot prompt)|headless mode cannot prompt/i.test(raw)) {
    return `${agentName} tried an action that needs your approval, which can't be asked for here. Try rephrasing the request so it only edits files.`;
  }
  if (/(oauth|access) token (has )?expired|re-?authenticate|not logged in|please (log|sign) ?in|login required|invalid api key/i.test(raw)) {
    return `${agentName} needs you to sign in again from the command line (signing in to the app isn't enough): open PowerShell, type ${cmd}, and follow the sign-in steps.`;
  }
  return null;
}
