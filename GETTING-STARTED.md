# Getting started with AgentMesh (no coding experience needed)

AgentMesh lets AI coding assistants (Claude Code, OpenAI Codex, Google Gemini and others) work on a project folder for you. If one assistant runs out of its usage allowance, the next one picks up where it left off.

You type what you want in plain words. The assistants do the work in your folder, and AgentMesh shows you what they did.

---

## 1. Install Node.js (one time)

AgentMesh runs on Node.js.

1. Go to **https://nodejs.org/en/download**
2. Download the **LTS** version's **Windows Installer**.
3. Run it and click **Next** through the default options.

## 2. Get AgentMesh (one time)

1. Open **https://github.com/Luisv8181/agentmesh**
2. Click the green **Code** button, then **Download ZIP**.
3. Right-click the downloaded ZIP, choose **Extract All…**, and put it somewhere easy, like your Documents folder.

## 3. Start AgentMesh

Open the extracted folder and double-click **Start AgentMesh**.

- The first time, a black window appears and sets things up. This takes about a minute.
- Your browser then opens the AgentMesh page.
- **Keep the black window open** while you use AgentMesh. Closing it stops AgentMesh.

> Windows may show a security warning because the file came from the internet. Choose **Run** (or **More info**, then **Run anyway**).

## 4. First-time setup (in the browser)

A setup screen opens automatically.

**Step 1: pick your project folder.** This is the folder the assistants are allowed to work in. Click **Change**, then **Browse…**.

**Step 2: install at least one assistant.** Each one shows:

- what it costs (some need a paid plan you may already have; **Google Antigravity** works with a regular Google account),
- a command to copy, with a **Copy** button,
- how to sign in.

To run a command:

1. Press the **Windows key**, type **PowerShell**, press **Enter**.
2. Right-click inside the blue window to paste the command, then press **Enter**.
3. When it finishes, close PowerShell, open a new one, and follow the sign-in step (usually typing the assistant's name, like `agy`, and signing in through your browser).
4. Go back to AgentMesh and press **Check again**. It should now say **Ready**.

**Stuck?** Click **Ask an AI to help** next to the assistant. It copies a message you can paste into ChatGPT, Claude or Gemini, and the AI walks you through it step by step.

## 5. Using it

1. Type what you want in the big box, like you'd tell a person:
   *"Add a contact form to the homepage that emails me the message."*
2. Click **Start** (or press **Ctrl + Enter**).
3. You'll see which assistant is working and what it's writing, live. Click **Stop** anytime.
4. When it's done, you'll see what it said and **which files it changed**.
5. To keep going on the same thing, type the next step (*"Now make the button blue."*).
   For something unrelated, click **+ New** in the left sidebar first.
6. When you're happy with a task, click **Mark task finished**.

## Good to know

- **Free local mode** (switch at the top right) uses only Ollama, which runs on your own computer. Your paid subscriptions are never touched in this mode. Ollama can read your project and suggest changes, but it can't edit files itself.
- **Settings** lets you choose which assistants to use and in what order, and whether they may edit files at all.
- If an assistant hits its limit, its dot turns amber with a countdown. AgentMesh automatically moves on to the next one.
- AgentMesh only works on your own computer. Nobody else can reach the page.

## Something went wrong?

| What you see | What to do |
|---|---|
| The black window says Node.js isn't installed | Do step 1, then double-click **Start AgentMesh** again. |
| "Port 3333 is already in use" | AgentMesh is already running. Open **http://127.0.0.1:3333** in your browser. |
| The page says "Lost connection" | The black window was closed. Double-click **Start AgentMesh** again. |
| An assistant still says **Not set up** after installing | Close and reopen PowerShell, run the sign-in step, then press **Check again**. |
| "No agent could finish this" | The message lists why for each assistant. Usually one needs setting up or is resting after a limit. |
| An assistant says **Needs sign-in** even though you signed in | Signing in to the desktop app doesn't count. Sign in from PowerShell: `claude auth login` (Claude) or `codex login` (Codex). |
| An assistant says **Needs update** | Run its install command again from **Set up agents**, then press **Check again**. |
| An assistant says **Out of credits** | Its default model needs credits your plan doesn't include. In **Settings → Models**, type a model your plan covers (for Claude: `sonnet` or `opus`). |
