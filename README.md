# 🕸️ AgentMesh

**Multi-Agent Coding Orchestrator with Shared Work State & Rate-Limit Failover.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

AgentMesh coordinates developer subscriptions and CLI agents (**Claude Code**, **OpenAI Codex**, **Google Antigravity CLI / agy**, **OpenCode AI**, **Google Gemini**, and **Local Ollama**) across a shared workspace.

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
* **`adapters/`**: Headless CLI execution wrappers for:
  * **Claude Code** (`claude -p`)
  * **OpenAI Codex** (`codex exec --skip-git-repo-check -`)
  * **Google Antigravity CLI** (`agy --non-interactive -p`)
  * **Google Gemini** (`gemini --skip-trust -p`)
  * **OpenCode AI** (`opencode run`)
  * **Local Ollama** (HTTP `:11434` offline fallback)
* **`state/`**: Persistent task store (`.agentmesh/tasks/`) and the **Handoff Protocol** that generates structured work briefs.
* **`workspace/`**: Git coordinator that snapshots workspace changes and records handoff commits (`[agentmesh] handoff: from -> to`).
* **`ui/`**: Embedded Fleet Command Center web dashboard (`dashboard.html`) and real-time SSE server (`agentmesh ui`).
* **`cli/`**: Unified commands for managing tasks, launching the UI, inspecting rate-limit states, and running multi-agent workflows.

---

## 🛡️ Safe Mode: Zero Subscription Usage

Need to test agent behavior without risking your paid subscription quotas? AgentMesh includes a hard safety guard:

```bash
# Run with local Ollama only (blocks Claude, Codex, agy, Gemini)
agentmesh run --local-only "Generate a helper utility in src/utils.ts"

# Or launch the Web Dashboard in Safe Mode
agentmesh ui --local-only
```

When Safe Mode is enabled, AgentMesh **strictly blocks** any execution of paid CLIs, routing 100% locally to Ollama (e.g. `llama3.2`, `codellama`, `qwen2.5`). Zero tokens are charged and zero subscription limits are consumed.

---

## 🖥️ Web UI Dashboard

Launch the visual Fleet Command Center with live cooldown countdown meters and real-time SSE failover stream:

```bash
agentmesh ui
# Opens http://localhost:3333 automatically
```

Key UI Features:
* **Live Ticking Cooldown Clocks**: Second-by-second countdown for cooling providers.
* **Visual Recovery Meters**: Color-coded progress bars showing recovery percentage.
* **Direct Subscription Telemetry**: Ingests real-time token counts, active models, and cache hits from Claude Code (`~/.claude/`) and OpenAI Codex (`~/.codex/`).
* **Interactive Safe Mode Toggle**: One-click switch to lock out cloud subscriptions.
* **Real-Time Telemetry Log**: Live feed of 429 limits, failovers, and Git commits.
* **One-Click Cooldown Resets**: Clear recovery timers manually on demand.

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

Claude Code CLI              [✔ INSTALLED] [READY]
OpenAI Codex CLI             [✔ INSTALLED] [READY]
Google Antigravity CLI (agy) [✔ INSTALLED] [READY]
Google Gemini CLI            [✔ INSTALLED] [READY]
OpenCode AI CLI              [✔ INSTALLED] [READY]
Local Ollama Fallback        [✔ INSTALLED] [READY]

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
1. AgentMesh captures modified files in Git.
2. Creates a checkpoint commit: `[agentmesh] handoff: claude -> codex`.
3. Constructs a structured **Work Handoff Brief**.
4. Automatically invokes **Codex** to resume right where Claude left off with zero lost work!

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
