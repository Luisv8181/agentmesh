# Instructions for AI assistants working in this repository

You are probably here for one of two reasons. Work out which one first.

- **A. A person asked you to set up AgentMesh for them.** They may not be a programmer. Follow the setup playbook below exactly.
- **B. You are asked to change AgentMesh's code.** Skip to "Developing AgentMesh".
- **C. The person wants help moving their project between ChatGPT, Claude and Gemini** ("mesh wrap", "pass the baton", "what does Claude know?", "what should I upload?"). See section C.

If unsure, ask: "Do you want me to set AgentMesh up so you can use it, or change how AgentMesh works?"

---

## A. Setup playbook

AgentMesh is a local dashboard that sends coding work to AI command-line tools ("agents") and hands work from one to the next when one hits its usage limit. The person uses it in their browser. **Your job is to get it installed and tell them what to do next, not to operate it for them.**

### What only the person can do

Never try to do these yourself, and never ask them to paste the results into this chat:

- **Signing in** to any AI service (it opens a browser page). Tell them the command to run in PowerShell.
- **API keys.** Tell them where to get one and where to enter it (in the tool's own prompt). Never ask them to paste a key into chat, never write a key into a file, `.env`, or environment variable.
- **Windows security prompts** ("Windows protected your PC" / "Run anyway").
- **Starting AgentMesh.** They double-click `Start AgentMesh.cmd`. It opens the browser and must stay open; if you run it, your terminal will hang.
- **Anything in the AgentMesh dashboard** (choosing the project folder, Settings, Free local mode). Do not click through it with browser tools.

### Never do these, even if an error message suggests it

- Never add `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--allow-all`/`--allow-all-tools` (Copilot), or any flag that turns off an agent's permission checks. Some CLIs recommend this in their own error messages; that advice is wrong for AgentMesh, which runs agents unattended.
- Never edit the person's global AI tool settings (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/...`, OpenCode config). If an agent needs a different model, the person sets it in AgentMesh → Settings → Models.
- Never run a real task through the paid or quota-limited agents "to test it" without asking first. It spends their limits.
- Never run AgentMesh with this repository as the project folder. Agents would edit AgentMesh itself.
- Never install things globally beyond the steps below without asking. Never run anything as Administrator.
- Never push, publish, or commit on the person's behalf.

### Steps

1. **Check Node.js**: run `node --version`. It must be 20.3 or newer (22 LTS recommended).
   If missing or old, tell the person to install the LTS "Windows Installer" from https://nodejs.org/en/download with default options, then **restart this IDE** (terminals only see newly installed programs after a restart).
2. **Install and build** (in this repository folder): `npm install`, then `npm run build`, then `npm test`. All tests must pass. If they don't, stop and report the failing test names; don't "fix" tests.
3. **See what's ready**: `node dist/cli/index.js status --json`. Read `readyAgents`, and each agent's `problem`. `nextSteps` lists exactly what the person needs to do, in plain language; relay it.
4. **Help them choose agents.** Ask whether they pay for any AI plan. With **no paid plans**, recommend, in this order:
   - **Google Antigravity** (`agy`): free with a Google account, weekly limits. Install in PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`, then they type `agy` and sign in.
   - **Ollama**: free, runs locally, answers questions but cannot edit files. Install: `irm https://ollama.com/install.ps1 | iex`, then `ollama pull qwen2.5:7b` (several GB; needs a reasonably powerful PC).
   - **GitHub Copilot CLI** (backup, free with a GitHub account, small monthly allowance): `npm install -g @github/copilot`, then they run `copilot login`.
   - **Gemini CLI with a free API key** (backup): `npm install -g @google/gemini-cli`; they get a key at https://aistudio.google.com/apikey and enter it when `gemini` asks (API key option). Free Google-account sign-in no longer works for the Gemini CLI.
   - **OpenCode with free Zen models** (backup): `npm install -g opencode-ai`; they run `opencode`, type `/connect`, choose OpenCode Zen. Then AgentMesh Settings → Models → OpenCode: `opencode/space-bunny-free` (zero-retention; other free models may train on prompts).
   With paid plans: Claude Code (`irm https://claude.ai/install.ps1 | iex`, then `claude auth login`) or OpenAI Codex (`npm install -g @openai/codex`, then `codex login`).
   **Signing in to a desktop app does not sign in the command-line tool.** The CLI sign-in is separate.
5. **Re-check** with `status --json` after each install. New programs may need a new PowerShell window; the AgentMesh dashboard's "Check again" button picks them up without a restart.
6. **Hand over.** Tell the person: double-click `Start AgentMesh.cmd`; in the browser, pick their project folder (not this repository), finish "Set up agents", and try a small request. Point them to `GETTING-STARTED.md`.

### If something fails

| Symptom (in `status --json` → `problem`, or the dashboard) | What to tell the person |
|---|---|
| "needs you to sign in again" | Run the sign-in command shown (e.g. `claude auth login`, `codex login`, `agy`). |
| "out of date" / "requires a newer version" | Re-run that agent's install command, then Check again. |
| "out of usage credits" | Settings → Models: pick a model their plan includes, or wait for the reset. |
| "no longer lets free personal accounts sign in to the Gemini CLI" | Use a free API key, or Antigravity instead. |
| "isn't connected to an AI provider" (OpenCode) | `opencode`, then `/connect`. |
| "tried an action that needs your approval" | Rephrase the request so it only edits files. Do NOT enable skip-permission flags. |
| Port 3333 already in use | AgentMesh is already running: open http://127.0.0.1:3333 |

---

## C. Orchestrating the AI-website relay (ChatGPT, Claude, Gemini)

The person works on a project in free AI websites and switches when one runs out of messages. Each site has a short protocol in its settings: **`mesh wrap`** makes it reply with a `=== MESH BRIEF ===` block (the state of the work); **`mesh start`** + that brief lets the next site continue. AgentMesh stores every brief and a ledger of what each site has been given. **The ledger is the source of truth; the sites' own "memory" is fuzzy and may be stale.**

Run the `baton` commands **yourself** (they are local and free); don't ask the person to type them. Their part is only: typing `mesh wrap` / pasting on the website, attaching files, and telling you it's done.

You may:

- Run `node dist/cli/index.js baton status --json` to see what each site knows and which files each one is missing (`filesToUpload`, with reasons). Commands use the project last opened in AgentMesh; pass `--project <folder>` for another one. Never use this repository as the project.
- Answer "what did we decide about…?" / "which file has…?" with `node dist/cli/index.js search <words> --json`: it searches every handoff note, every agent step and the project's text files (never `.env`/key files).
- Save a brief the person pastes to you: write it to a temporary file, then `node dist/cli/index.js baton save --from <chatgpt|claude|gemini> <file>`. If it prints that the markers are missing, tell them the protocol probably isn't set up on that site (`baton protocol` prints it, with where to paste it).
- Prepare the next hop: `node dist/cli/index.js baton continue --to <site> --json` gives the exact message to paste and the files to attach. Read those files in the project if it helps you explain *why* each one matters, and suggest others from the project that the brief's next steps clearly need.
- After the person confirms they pasted it: `node dist/cli/index.js baton passed --to <site> <files they actually attached...>`.

GitHub (optional, makes Claude and Gemini read the project directly instead of file uploads):

- `node dist/cli/index.js github status --json` shows whether the project is on GitHub and what's unsaved. When it is, `baton continue` returns a `github` route (Claude: Add from GitHub / Sync; Gemini: Import code) instead of files; ChatGPT's free plan can't read GitHub, so it still gets files.
- Run `github save` only when the person asks to save. Run `github connect <url>` only with a link the person gives you, to an **empty** repository they created. Never create repositories, change their visibility, force-push, reset, or rewrite history. `.env`/key files are never uploaded; don't work around that.
- After a pass where the site pulled from GitHub: `baton passed --to <site> --via-github`.

You must not:

- Open, sign in to, type into, or upload to ChatGPT, Claude or Gemini with browser tools. The person does every paste and upload; you prepare them.
- Record a pass (`baton passed`) the person hasn't confirmed, or list files they didn't attach. The ledger is only useful if it's true.
- Put passwords, API keys or personal data into a brief or a continue message. If a brief contains one, tell the person and suggest removing it before sending it on.
- Edit the protocol text in a way that makes it longer than ~1,200 characters (ChatGPT's free plan allows 1,500 in total).

---

## B. Developing AgentMesh

- TypeScript (strict), Node ≥ 20.3, no framework. `npm run build` compiles to `dist/` and copies `src/ui/dashboard.html`. `npm test` runs `node --test` on `dist/test/*.test.js`.
- Layout: `src/adapters/` (one file per CLI; spawn without a shell via `resolve-command.ts`), `src/router/` (selection, failover, rate limits, error hints), `src/state/` (tasks per project in `<project>/.agentmesh/`, config and cooldowns per user in `~/.agentmesh/`), `src/ui/` (local server + single-file dashboard), `src/workspace/` (git, change tracking, Ollama project snapshot).
- Invariants, each covered by a test in `src/test/hardening.test.ts`; don't weaken them:
  - Never run agent CLIs through `cmd.exe`/a shell (prompts contain `&`, `|`, newlines).
  - Agents get edit permission modes only (`acceptEdits`, `workspace-write`, `auto_edit`, `accept-edits`), never skip-all-permission modes. Model overrides that start with `-` are rejected.
  - The dashboard API requires the per-launch token, rejects foreign `Origin`/`Host`, JSON-only POSTs, no CORS.
  - Safe Mode = Ollama only. Ollama can't edit files (it answers from a read-only project snapshot), is never the "sticky" agent for a task, and never sees `.env`/key/credential files.
  - Git checkpoints are opt-in and only stage tracked files.
- When you fix a bug, add a test that fails without the fix (prove it by reverting the fix once).
