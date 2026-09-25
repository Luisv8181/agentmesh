#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { AgentSelector } from '../router/agent-selector.js';
import { TaskStore } from '../state/task-store.js';
import { ConfigStore } from '../state/config-store.js';
import { BatonStore } from '../baton/baton-store.js';
import { ProjectSearch } from '../search/project-search.js';
import { githubStatus, saveToGitHub, connectGitHub } from '../workspace/github.js';
import { PROTOCOL_TEXT, SITE_INFO, WEB_SITES, WebSite } from '../baton/protocol.js';
import { AgentId } from '../types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const program = new Command();

program
  .name('agentmesh')
  .description('Multi-Agent Coding Orchestrator with Shared Work State & Rate-Limit Failover')
  .version('0.2.0');

// STATUS
program
  .command('status')
  .description('Show status of agents, rate limits, and the active task')
  .option('--json', 'Machine-readable output (for scripts and AI assistants helping with setup)')
  .action(async (opts) => {
    const selector = new AgentSelector();
    const taskStore = new TaskStore();
    const statuses = await selector.getStatuses();

    if (opts.json) {
      const ready = statuses.filter((s) => s.available && s.priority !== null && !s.inCooldown && !s.hint);
      const config = selector.config.get();
      const nextSteps = statuses
        .filter((s) => s.priority !== null && (!s.available || s.hint))
        .map((s) => ({ agent: s.id, todo: s.hint ?? `${s.name}: ${s.detail ?? 'not available'}. See "Set up agents" in the dashboard.` }));
      console.log(JSON.stringify({
        agentmeshVersion: program.version(),
        node: process.versions.node,
        platform: process.platform,
        workspace: process.cwd(),
        readyAgents: ready.map((s) => s.id),
        agents: statuses.map((s) => ({
          id: s.id,
          name: s.name,
          installed: s.available,
          version: s.version,
          turnedOn: s.priority !== null,
          cloud: s.subscription,
          restingForSec: s.inCooldown && s.cooldownUntil ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0,
          problem: s.hint ?? (s.available ? null : s.detail ?? 'not available')
        })),
        mode: config.mode ?? 'not chosen yet (the person picks it on the AgentMesh welcome screen)',
        settings: { permission: config.permission, autoCommit: config.autoCommit, ollamaModel: config.ollamaModel, models: config.models },
        nextSteps
      }, null, 2));
      return;
    }

    console.log(chalk.bold.cyan('\n=== AgentMesh: Agent Pool Status ===\n'));

    for (const s of statuses) {
      const avail = s.available ? chalk.green('✔ READY TO USE') : chalk.red(`✖ ${s.detail ?? 'NOT FOUND'}`);
      let health = chalk.green('READY');
      if (s.priority === null) {
        health = chalk.dim('TURNED OFF');
      } else if (!s.available) {
        health = chalk.dim('UNAVAILABLE');
      } else if (s.inCooldown) {
        health = chalk.yellow.bold(`COOLDOWN (${s.cooldownUntil ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0}s)`);
      }

      console.log(`${chalk.bold(s.name.padEnd(28))} [${avail}] [${health}]`);
      if (s.version) {
        console.log(`  Version: ${chalk.dim(s.version)} | Command: ${chalk.dim(s.command)}`);
      }
      if (s.hint) {
        console.log(`  ${chalk.yellow('To fix:')} ${s.hint}`);
      } else if (s.lastError) {
        console.log(`  Last Incident: ${chalk.red(s.lastError.slice(0, 90))}`);
      }
      console.log('');
    }

    const currentTask = taskStore.getCurrentTask();
    console.log(chalk.bold.cyan('=== Active Task ===\n'));
    if (currentTask) {
      console.log(`Task ID:       ${chalk.yellow(currentTask.taskId)}`);
      console.log(`Title:         ${chalk.bold(currentTask.title)}`);
      console.log(`Status:        ${chalk.blue(currentTask.status)}`);
      console.log(`Active Agent:  ${chalk.magenta(currentTask.currentAgent || 'none assigned')}`);
      console.log(`Handoff Count: ${currentTask.handoffs.length}`);
    } else {
      console.log(chalk.dim('No active task. Create one with: agentmesh new "Task title"'));
    }
    console.log('');
  });

// NEW TASK
program
  .command('new <title>')
  .description('Create a new coordinated task')
  .option('-r, --requirements <items...>', 'List of requirements')
  .action((title, opts) => {
    const requirements = opts.requirements || ['Implement requested functionality', 'Verify tests'];
    const task = new TaskStore().createTask(title, requirements);
    console.log(chalk.green(`\n✔ Created Task ${chalk.bold(task.taskId)}: "${task.title}"`));
    console.log(chalk.dim(`Set as active task. Run with: agentmesh run "your instructions"`));
  });

// RUN / DISPATCH
program
  .command('run [instruction...]')
  .description('Execute work on the current task with automatic rate-limit failover and state handoffs')
  .option('-a, --agent <agent>', 'Force a specific agent (claude, codex, agy, gemini, opencode, ollama)')
  .option('-l, --local-only', 'Strictly use local Ollama and block subscription CLIs (Safe Mode)')
  .action(async (instructionParts: string[], opts) => {
    const instruction = instructionParts.join(' ').trim();
    if (!instruction) {
      console.error(chalk.red('Error: Instruction cannot be empty.'));
      process.exit(1);
    }

    const selector = new AgentSelector();
    const taskStore = new TaskStore();

    if (opts.localOnly) {
      selector.setSafeMode(true);
      console.log(chalk.bold.magenta('[Safe Mode Active] Paid subscription CLIs blocked. Using local Ollama only.\n'));
    }

    let task = taskStore.getCurrentTask();
    if (!task) {
      task = taskStore.createTask(instruction.slice(0, 50), [instruction]);
      console.log(chalk.dim(`No active task found. Created ${task.taskId}`));
    }

    console.log(chalk.cyan(`\n[AgentMesh] Dispatching task: ${task.taskId} ("${task.title}")...`));

    try {
      const forced = opts.agent ? (opts.agent.toLowerCase() as AgentId) : undefined;
      const res = await selector.executeTask(task, instruction, forced, {
        onAgentStart: (id) => console.log(chalk.dim(`→ ${id} is working…`)),
        onHandoff: (from, to, reason) => console.log(chalk.yellow(`↪ ${from} stopped (${reason}); ${to} is taking over`))
      });

      if (!res.success) {
        console.error(chalk.red(`\n${res.error}`));
        process.exit(1);
      }
      console.log(chalk.bold.green(`\n✔ Completed by [${res.agent}] in ${(res.durationMs / 1000).toFixed(2)}s\n`));
      console.log(res.output);
    } catch (err) {
      console.error(chalk.red(`\nExecution failed: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// TASKS
program
  .command('tasks')
  .description('List all managed tasks and their handoff histories')
  .action(() => {
    const tasks = new TaskStore().listTasks();
    console.log(chalk.bold.cyan(`\n=== Managed Tasks (${tasks.length}) ===\n`));
    if (tasks.length === 0) {
      console.log(chalk.dim('No tasks found.'));
      return;
    }
    for (const t of tasks) {
      console.log(`[${chalk.yellow(t.taskId)}] ${chalk.bold(t.title)} (${t.status})`);
      console.log(`  Current Agent: ${t.currentAgent || 'none'} | Handoffs: ${t.handoffs.length}`);
    }
    console.log('');
  });

// UI DASHBOARD (default when run with no command)
program
  .command('ui', { isDefault: true })
  .description('Launch the AgentMesh web dashboard (default)')
  .option('-p, --port <number>', 'Port to listen on', '3333')
  .option('-l, --local-only', 'Start in Local-Only Safe Mode (Ollama)')
  .option('--no-open', 'Do not open the browser automatically')
  .option('--recent', 'Open the most recently used project folder instead of the current directory')
  .action(async (opts) => {
    const { startUiServer } = await import('../ui/server.js');
    const port = parseInt(opts.port, 10) || 3333;
    const safeMode = !!opts.localOnly;
    const folder = opts.recent ? recentOrDocuments() : process.cwd();

    console.log(chalk.bold.cyan('\n🚀 Starting AgentMesh...'));
    try {
      const instance = await startUiServer(port, folder, safeMode);
      console.log(chalk.green(`✔ Dashboard running at: ${chalk.bold.underline(instance.url)}`));
      if (safeMode) {
        console.log(chalk.magenta('🛡️  Local-Only Safe Mode: ACTIVE (Subscriptions protected)'));
      }
      console.log(chalk.dim('Keep this window open while you use AgentMesh. Press Ctrl+C to stop.\n'));

      if (opts.open) {
        const cp = await import('child_process');
        if (process.platform === 'win32') {
          cp.spawn('cmd.exe', ['/c', 'start', '""', instance.url], { stdio: 'ignore', windowsHide: true });
        } else {
          cp.spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [instance.url], { stdio: 'ignore' });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(chalk.red(`Port ${port} is already in use. AgentMesh may already be running: open http://127.0.0.1:${port}`));
        console.error(chalk.dim(`Or use another port: agentmesh ui --port ${port + 1}`));
      } else {
        console.error(chalk.red(`Failed to start dashboard: ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exit(1);
    }
  });

// RESET
program
  .command('reset')
  .description('Reset all agent rate-limit cooldowns')
  .action(() => {
    new AgentSelector().resetCooldowns();
    console.log(chalk.green('✔ All AgentMesh rate-limit cooldowns have been reset.'));
  });

// SEARCH: everything AgentMesh knows about a project (notes, agent steps, files)
program
  .command('search <words...>')
  .description('Search the project: handoff notes, agent steps and files')
  .option('--project <folder>', 'Defaults to the project last opened in AgentMesh')
  .option('--json')
  .action((words: string[], opts) => {
    const dir = opts.project ? path.resolve(opts.project) : new ConfigStore().get().recentWorkspaces.find((d) => fs.existsSync(d)) ?? process.cwd();
    const hits = new ProjectSearch(dir).search(words.join(' '));
    if (opts.json) return console.log(JSON.stringify({ project: dir, hits: hits.map(({ text, ...h }) => h) }, null, 2));
    console.error(chalk.dim(`Project: ${dir}`));
    if (!hits.length) return console.log('No matches.');
    for (const h of hits) {
      const snippet = h.snippet.replace(/\s+/g, ' ').replace(/⟦(.*?)⟧/g, (_m, w: string) => chalk.yellow(w));
      console.log(`${chalk.bold(h.title)} ${chalk.dim(`[${h.kind}]`)}\n  ${snippet}`);
    }
  });

// GITHUB: for people who don't use git (see AGENTS.md: only on the person's request)
const ghCmd = program.command('github').description('Put the project on GitHub and save changes there');
const ghProject = (opt?: string) => {
  const dir = opt ? path.resolve(opt) : new ConfigStore().get().recentWorkspaces.find((d) => fs.existsSync(d));
  if (!dir) throw new Error('No project yet. Open AgentMesh and choose a project folder, or pass --project <folder>.');
  console.error(chalk.dim(`Project: ${dir}`));
  return dir;
};
ghCmd.command('status').option('--project <folder>').option('--json').description('Is the project on GitHub, and is everything saved?').action((opts) => {
  const s = githubStatus(ghProject(opts.project));
  if (opts.json) return console.log(JSON.stringify(s, null, 2));
  if (!s.gitInstalled) return console.log('Git isn’t installed.');
  if (!s.webUrl) return console.log('Not on GitHub yet.');
  console.log(`${s.webUrl}
${s.inSync ? chalk.green('✔ Everything is saved to GitHub.') : chalk.yellow(`${s.unsaved.length} unsaved change(s)${s.ahead ? `, ${s.ahead} not uploaded` : ''}.`)}`);
  if (s.skipped.length) console.log(chalk.dim(`Never uploaded (secret-looking or too large): ${s.skipped.join(', ')}`));
});
ghCmd.command('save').option('--project <folder>').option('-m, --message <text>').description('Save changes to GitHub (never secrets)').action((opts) => {
  const r = saveToGitHub(ghProject(opts.project), opts.message);
  console.log(r.ok ? chalk.green(r.committed ? '✔ Saved to GitHub.' : '✔ Already up to date on GitHub.') : chalk.red(r.error ?? 'Failed'));
  if (!r.ok) process.exitCode = 1;
});
ghCmd.command('connect <url>').option('--project <folder>').description('Connect to an EMPTY GitHub repository the person created, and upload the project').action((url: string, opts) => {
  const r = connectGitHub(ghProject(opts.project), url);
  console.log(r.ok ? chalk.green(`✔ Connected and uploaded: ${r.webUrl}`) : chalk.red(r.error ?? 'Failed'));
  if (!r.ok) process.exitCode = 1;
});

// BATON: carry a project between ChatGPT, Claude and Gemini by hand (see AGENTS.md section C)
const batonCmd = program.command('baton').description('Hand a project between AI websites (ChatGPT, Claude, Gemini)');
const siteArg = (v: string): WebSite => {
  if (!(WEB_SITES as string[]).includes(v)) throw new Error(`Site must be one of: ${WEB_SITES.join(', ')}`);
  return v as WebSite;
};
/** Defaults to the project last opened in the dashboard, never the AgentMesh repo an assistant happens to be in. */
function batonProject(opt?: string): BatonStore {
  const dir = opt ? path.resolve(opt) : new ConfigStore().get().recentWorkspaces.find((d) => fs.existsSync(d));
  if (!dir) throw new Error('No project yet. Open AgentMesh, choose a project folder, or pass --project <folder>.');
  console.error(chalk.dim(`Project: ${dir}`));
  return new BatonStore(dir);
}

batonCmd
  .command('protocol')
  .description('Print the text to paste into each AI website’s instructions (one time)')
  .action(() => {
    console.log(PROTOCOL_TEXT);
    console.error('');
    for (const s of WEB_SITES) console.error(chalk.dim(`${SITE_INFO[s].name}: ${SITE_INFO[s].where}`));
  });

batonCmd
  .command('status')
  .description('What each AI website knows about the project, and what to upload next')
  .option('--project <folder>')
  .option('--json')
  .action((opts) => {
    const store = batonProject(opts.project);
    const knowledge = store.knowledge();
    const latest = store.latestBrief();
    const out = {
      latestBrief: latest ? { from: latest.from, at: new Date(latest.at).toISOString(), project: latest.project, keyFiles: latest.keyFiles, wellFormed: latest.wellFormed } : null,
      sites: Object.fromEntries(WEB_SITES.map((s) => [s, { ...knowledge[s], filesToUpload: store.suggestFiles(s) }]))
    };
    if (opts.json) return console.log(JSON.stringify(out, null, 2));
    console.log(latest ? `Latest brief: from ${latest.from}, ${new Date(latest.at).toLocaleString()}` : 'No briefs yet.');
    for (const s of WEB_SITES) {
      const k = out.sites[s];
      console.log(`\n${chalk.bold(SITE_INFO[s].name)}${k.protocolInstalled ? '' : chalk.yellow(' (protocol not installed yet)')}\n  ${k.summary}`);
      for (const f of k.filesToUpload) console.log(`  upload: ${f.path} ${chalk.dim(`(${f.reason})`)}`);
    }
  });

batonCmd
  .command('save')
  .description('Save a MESH BRIEF (the reply to "mesh wrap") from a file, or from stdin')
  .requiredOption('--from <site>', 'chatgpt | claude | gemini')
  .argument('[file]')
  .option('--project <folder>')
  .action((file: string | undefined, opts) => {
    const text = fs.readFileSync(file ?? 0, 'utf8');
    const brief = batonProject(opts.project).addBrief(siteArg(opts.from), text);
    console.log(brief.wellFormed ? chalk.green('✔ Brief saved.') : chalk.yellow('Saved, but no MESH BRIEF markers were found. Is the protocol installed on that site?'));
    if (brief.keyFiles.length) console.log(`Key files mentioned: ${brief.keyFiles.join(', ')}`);
  });

batonCmd
  .command('continue')
  .description('Print the message to paste into the next AI website, plus the files to attach')
  .requiredOption('--to <site>', 'chatgpt | claude | gemini')
  .option('--project <folder>')
  .option('--json')
  .action((opts) => {
    const next = batonProject(opts.project).continueOn(siteArg(opts.to));
    if (opts.json) return console.log(JSON.stringify(next, null, 2));
    console.log(next.message);
    console.error(chalk.bold(`\nAttach in ${SITE_INFO[opts.to as WebSite].name}:`) + (next.files.length ? '' : ' nothing new'));
    for (const f of next.files) console.error(`  ${f.path} ${chalk.dim(`(${f.reason})`)}`);
  });

batonCmd
  .command('passed')
  .description('Record that the person pasted the latest brief (and attached these files) on a site')
  .requiredOption('--to <site>', 'chatgpt | claude | gemini')
  .argument('[files...]')
  .option('--project <folder>')
  .option('--via-github', 'The site pulled the project from GitHub (Sync / Import code)')
  .action((files: string[], opts) => {
    batonProject(opts.project).recordPass(siteArg(opts.to), files, !!opts.viaGithub);
    console.log(chalk.green(`✔ Recorded. ${SITE_INFO[opts.to as WebSite].name} is now up to date.`));
  });

/** Last project the user worked in; on first run, their Documents folder (they pick a real project in setup). */
function recentOrDocuments(): string {
  const recent = new ConfigStore().get().recentWorkspaces.find((d) => fs.existsSync(d));
  if (recent) return recent;
  const docs = path.join(os.homedir(), 'Documents');
  return fs.existsSync(docs) ? docs : os.homedir();
}

program.parse(process.argv);
