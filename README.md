# 🕸️ AgentMesh

**Multi-Agent Coding Orchestrator with Shared Work State & Rate-Limit Failover.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

AgentMesh coordinates developer subscriptions and CLI agents (**Claude Code**, **OpenAI Codex**, **Google Antigravity CLI / agy**, **OpenCode AI**, **Google Gemini**, and **Local Ollama**) across a shared workspace.

## Which mode is for me?

AgentMesh asks you this the first time you open it. You can switch any time in Settings.

| | **Free AI mode** | **Paid AI mode** |
|---|---|---|
| **Use this if…** | You don't pay for any AI plan | You pay for Claude (Pro/Max) or ChatGPT (Plus/Pro), or use Claude Code / Codex |
| **Where you work** | ChatGPT, Claude and Gemini websites, plus free helpers on your PC | Coding agents on your PC, working directly in your project folder |
| **When one runs out** | Type `mesh wrap`, and AgentMesh hands your work to the next website with exactly the files it needs | AgentMesh switches to the next agent automatically, with a handoff brief |
| **Helpers used** | Google Antigravity (free Google account), GitHub Copilot Free, Gemini CLI (free API key), OpenCode (free models), Ollama (runs locally) | Claude Code, Codex first, then the free helpers as backup |
| **Costs** | Nothing | Only your existing plans; nothing extra |

**⬇ [Download for Windows (ZIP)](https://github.com/Luisv8181/agentmesh/archive/refs/heads/main.zip)**, extract it, and double-click **Start AgentMesh**.

Not sure which mode? Choose **Free AI mode**. **Not a programmer?** Start with [GETTING-STARTED.md](GETTING-STARTED.md): double-click **Start AgentMesh** and it walks you through the rest. **Helping someone set it up with an AI assistant?** Point it at this repo; [AGENTS.md](AGENTS.md) tells it exactly what to do and what not to do. **Want it to work differently?** AgentMesh is meant to be reshaped: ask your AI to follow [AGENTS.md section D](AGENTS.md#d-making-agentmesh-fit-this-person-keep-building-into-it).

```text
             ┌────────────────────┐
             │    AgentMesh       │
             │   Orchestrator     │
             └─────────┬──────────┘
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
   Claude Code    OpenAI Codex    Antigravity (agy)
        │              │              │
        └──────────────┼──────────────┘
                       ↓
                Shared Workspace
                Git + Task State
                Tests + Handoffs
```

---

## 💡 The Core Design Principle

> **Agents don't need to share their private conversations. They share the state of the work.**

LLM context windows quickly bloat when conversational logs are dumped across models. Different CLIs have different prompt conventions, system instructions, and tool outputs.

Instead of passing conversation transcripts, **AgentMesh** passes the **State of Work**:
1. **The Objectives**: Concrete task requirements and acceptance criteria.
2. **The Codebase State**: Git commits, modified files, and unstaged diffs.
3. **The Test Results**: Concrete compiler outputs and test suite status.
4. **The Handoff Brief**: What was accomplished, what blocked the previous agent (e.g. rate limit, quota expiry, or phase completion), and the exact next actions expected.

---

## 🏛️ The Five Pieces of AgentMesh

AgentMesh is organized around five core modules:

* **`router/`**: Rate-limit awareness and fallback dispatcher. Includes **`usage-monitor.ts`** for real-time telemetry, sliding-window request counting, and Server-Sent Events (SSE) broadcasting.
* **`adapters/`**: Headless CLI execution wrappers, spawned without a shell (so prompts arrive intact on Windows), with edit-only permissions:
  * **Claude Code** (`claude -p --permission-mode acceptEdits`, prompt on stdin)
  * **OpenAI Codex** (`codex exec -s workspace-write -`)
  * **Google Antigravity CLI** (`agy --mode accept-edits --add-dir <project> -p`)
  * **GitHub Copilot CLI** (`copilot -p … -s --no-ask-user --allow-tool write`)
  * **Google Gemini** (`gemini --approval-mode auto_edit -p`)
  * **OpenCode AI** (`opencode run`)
  * **Local Ollama** (HTTP `:11434`, read-only project snapshot)
  Each reports sign-in state through the CLI's own local status command, so “Ready” means signed in.
* **`baton/`**: The AI-website relay (`mesh wrap` / `mesh start`), handoff notes, and the ledger of what ChatGPT, Claude and Gemini each know.
* **`search/`**: Full-text search (SQLite FTS5 built into Node) over notes, agent steps and project files.
* **`extension/`**: Chrome/Edge side panel that sits next to the AI websites (no copy and paste).
* **`state/`**: Persistent task store (`.agentmesh/tasks/`) and the **Handoff Protocol** that generates structured work briefs.
* **`workspace/`**: Git coordinator that snapshots workspace changes and records handoff commits (`[agentmesh] handoff: from -> to`).
* **`ui/`**: Embedded Fleet Command Center web dashboard (`dashboard.html`) and real-time SSE server (`agentmesh ui`).
* **`cli/`**: Unified commands for managing tasks, launching the UI, inspecting rate-limit states, and running multi-agent workflows.

---

## 🛡️ Safe Mode: Zero Subscription Usage

Need to test agent behavior without risking your paid subscription quotas? AgentMesh includes a hard safety guard:

```bash
# Run with local Ollama only (blocks Claude, Codex, agy, Gemini, OpenCode)
agentmesh run --local-only "Generate a helper utility in src/utils.ts"

# Or launch the Web Dashboard in Safe Mode
agentmesh ui --local-only
```

When Safe Mode is enabled, AgentMesh **strictly blocks** every CLI that can cost money (including OpenCode, which can bill API credits), routing 100% locally to Ollama (e.g. `llama3.2`, `codellama`, `qwen2.5`). Zero tokens are charged and zero subscription limits are consumed. Ollama is chat-only, so AgentMesh gives it a read-only snapshot of the project (never `.env`, keys or credential files) and it answers with suggested code rather than editing files.

---

## 🖥️ Web UI Dashboard

```bash
agentmesh            # same as: agentmesh ui  (opens http://127.0.0.1:3333)
agentmesh ui --recent  # reopen the last project folder instead of the current directory
```

Built for people who don't live in a terminal:
* **One flow**: pick a project folder, type what you want, watch the agent's output stream live, press **Stop** anytime. Handoffs appear inline ("Claude hit its usage limit, so Codex is taking over").
* **See the result**: the agent's answer, plus **which files changed** (works with or without git).
* **Tasks**: follow-up instructions stay on the same task and each agent is told what earlier steps did. Switch between tasks or mark them finished.
* **Guided setup**: detects which CLIs are installed, shows the official install command with a copy button, how to sign in, and an "Ask an AI to help" prompt for each one. **Check again** picks up newly installed CLIs without a restart.
* **Settings**: agent order (and on/off), whether agents may edit files, opt-in git checkpoints, Ollama model, today's Claude/Codex token usage.
* **AI websites relay**: magic words for ChatGPT, Claude and Gemini, handoff notes, what each site knows, which files to attach. With the **browser panel**, wrapping up and continuing are one click each.
* **GitHub** (optional): *Put on GitHub* and *Save*; Claude and Gemini then read the project from GitHub instead of attachments.
* **Search** (Ctrl+K) across notes, agent steps and files.
* Light and dark themes, works at phone width, respects reduced motion.

**Security.** The dashboard only listens on `127.0.0.1`. Every API call needs a random per-launch token, cross-origin requests and foreign `Host` headers are rejected (no drive-by requests from websites, no DNS rebinding), and the page can't be framed.

**For non-developers on Windows:** see [GETTING-STARTED.md](GETTING-STARTED.md). Double-click **Start AgentMesh** and it installs, builds and opens itself.

---

## 🚀 Quick Start

### 1. Installation

```bash
git clone https://github.com/Luisv8181/agentmesh.git
cd agentmesh
npm install
npm run build
npm link
```

### 2. Inspect Agent Pool Status

Check availability and live rate-limit cooldowns across all your subscriptions:

```bash
agentmesh status
```

Output:
```text
=== AgentMesh: Agent Pool Status ===

Claude Code                  [✔ READY TO USE] [READY]
OpenAI Codex                 [✔ READY TO USE] [READY]
Google Antigravity (agy)     [✔ READY TO USE] [READY]
Google Gemini                [✔ READY TO USE] [READY]
OpenCode                     [✔ READY TO USE] [READY]
Ollama (local, free)         [✖ Model "qwen2.5:7b" not downloaded. Run: ollama pull qwen2.5:7b] [UNAVAILABLE]

=== Active Task ===
No active task. Create one with: agentmesh new "Task title"
```

### 3. Create a Managed Task

```bash
agentmesh new "Implement User Authentication" -r "Create JWT utility" "Add login endpoint" "Write tests"
```

### 4. Execute with Automatic Failover

Run directives against the task:

```bash
agentmesh run "Implement the JWT signing and verification utility in src/jwt.ts"
```

If your primary subscription (e.g., Claude Code) hits a rate limit or quota ceiling during execution:
1. AgentMesh records which files were modified.
2. Constructs a structured **Work Handoff Brief**.
3. Automatically invokes the next agent in your priority order (e.g. **Codex**) to resume right where Claude left off.
4. Optionally (off by default, enable in Settings) creates a checkpoint commit: `[agentmesh] handoff: claude -> codex`. Only files git already tracks are committed; untracked files such as `.env` are never staged.

Agents run with file-edit permission but not "skip all permissions" modes: Claude Code uses `--permission-mode acceptEdits`, Codex `-s workspace-write`, Gemini `--approval-mode auto_edit`, agy `--mode accept-edits`. Turn off "Let agents edit files" in Settings to switch them all to read-only/plan modes.

### 5. Review Task & Handoff History

```bash
agentmesh tasks
```

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/Luisv8181/agentmesh/issues).

---

## 📄 License

Distributed under the [MIT](LICENSE) License. Built by [Luis Vasquez](https://github.com/Luisv8181).
