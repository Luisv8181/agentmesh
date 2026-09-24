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

export function fixHint(agentId: string, agentName: string, raw: string): string | null {
  const cmd = agentId === 'agy' ? 'agy' : agentId;
  if (/requires a newer version|upgrade to the latest|please update|version is no longer supported/i.test(raw)) {
    return `${agentName} is out of date. Update it with its install command (Set up agents shows it), then press Check again.`;
  }
  if (/no longer supported for gemini code assist for individuals|migrate to the antigravity/i.test(raw)) {
    return 'Google no longer supports the Gemini CLI for free personal accounts. Use Google Antigravity instead (Set up agents).';
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
    return `${agentName} needs you to sign in again: open PowerShell, type ${cmd}, and follow the sign-in steps.`;
  }
  return null;
}
