#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { AgentSelector } from '../router/agent-selector.js';
import { TaskStore } from '../state/task-store.js';
import { GitCoordinator } from '../workspace/git-coordinator.js';
import { HandoffProtocol } from '../state/handoff-protocol.js';
import { AgentId } from '../types.js';

const program = new Command();
const selector = new AgentSelector();
const taskStore = new TaskStore();
const git = new GitCoordinator();

program
  .name('agentmesh')
  .description('Multi-Agent Coding Orchestrator with Shared Work State & Rate-Limit Failover')
  .version('0.1.0');

// STATUS
program
  .command('status')
  .description('Show status of agents, rate limits, and the active task')
  .action(() => {
    console.log(chalk.bold.cyan('\n=== AgentMesh: Agent Pool Status ===\n'));
    const statuses = selector.getStatuses();

    for (const s of statuses) {
      const avail = s.available ? chalk.green('✔ INSTALLED') : chalk.red('✖ NOT FOUND');
      let health = chalk.green('READY');
      if (!s.available) {
        health = chalk.dim('UNAVAILABLE');
      } else if (s.inCooldown) {
        health = chalk.yellow.bold(`COOLDOWN (${s.cooldownUntil ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0}s)`);
      }

      console.log(`${chalk.bold(s.name.padEnd(28))} [${avail}] [${health}]`);
      if (s.version) {
        console.log(`  Version: ${chalk.dim(s.version)} | Command: ${chalk.dim(s.command)}`);
      }
      if (s.lastError) {
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
    const task = taskStore.createTask(title, requirements);
    console.log(chalk.green(`\n✔ Created Task ${chalk.bold(task.taskId)}: "${task.title}"`));
    console.log(chalk.dim(`Set as active task. Run with: agentmesh run "your instructions"`));
  });

// RUN / DISPATCH
program
  .command('run [instruction...]')
  .description('Execute work on the current task with automatic rate-limit failover and state handoffs')
  .option('-a, --agent <agent>', 'Force a specific agent (claude, codex, agy, gemini, opencode, ollama)')
  .option('-l, --local-only', 'Strictly use local Ollama and block subscription CLIs (Safe Mode)')
  .action(async (instructionParts, opts) => {
    const instruction = instructionParts.join(' ').trim();
    if (!instruction) {
      console.error(chalk.red('Error: Instruction cannot be empty.'));
      process.exit(1);
    }

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
      const res = await selector.executeTask(task, instruction, forced);

      console.log(chalk.bold.green(`\n✔ Completed by [${res.agent}] in ${(res.durationMs / 1000).toFixed(2)}s\n`));
      console.log(res.output);
    } catch (err: any) {
      console.error(chalk.red(`\nExecution failed: ${err.message}`));
      process.exit(1);
    }
  });

// TASKS
program
  .command('tasks')
  .description('List all managed tasks and their handoff histories')
  .action(() => {
    const tasks = taskStore.listTasks();
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

// UI DASHBOARD
program
  .command('ui')
  .description('Launch the AgentMesh Fleet Command Center web dashboard')
  .option('-p, --port <number>', 'Port to listen on', '3333')
  .option('-l, --local-only', 'Start in Local-Only Safe Mode (Ollama)')
  .action(async (opts) => {
    const { startUiServer } = await import('../ui/server.js');
    const port = parseInt(opts.port, 10) || 3333;
    const safeMode = !!opts.localOnly;

    console.log(chalk.bold.cyan('\n🚀 Launching AgentMesh Fleet Command Center...'));
    try {
      const instance = await startUiServer(port, process.cwd(), safeMode);
      console.log(chalk.green(`✔ Web Dashboard running at: ${chalk.bold.underline(instance.url)}`));
      if (safeMode) {
        console.log(chalk.magenta('🛡️  Local-Only Safe Mode: ACTIVE (Subscriptions protected)'));
      }
      console.log(chalk.dim('Press Ctrl+C to stop the dashboard server.\n'));

      // Auto-open browser
      const isWin = process.platform === 'win32';
      const openCmd = isWin ? `start ${instance.url}` : process.platform === 'darwin' ? `open ${instance.url}` : `xdg-open ${instance.url}`;
      import('child_process').then((cp) => cp.exec(openCmd));
    } catch (err: any) {
      console.error(chalk.red(`Failed to start UI server: ${err.message}`));
      process.exit(1);
    }
  });

// RESET
program
  .command('reset')
  .description('Reset all agent rate-limit cooldowns')
  .action(() => {
    selector.resetCooldowns();
    console.log(chalk.green('✔ All AgentMesh rate-limit cooldowns have been reset.'));
  });

program.parse(process.argv);

