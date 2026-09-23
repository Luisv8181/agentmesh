import { HandoffRecord, TaskState } from '../types.js';

export class HandoffProtocol {
  /**
   * Builds the work briefing string that is injected into the incoming agent.
   * Core principle: Agents don't need private conversation history; they need
   * the objective state of the work, test status, files touched, and explicit next steps.
   */
  public static buildHandoffBrief(task: TaskState, handoff: HandoffRecord): string {
    const lines: string[] = [];

    lines.push('================================================================================');
    lines.push('                       AGENTMESH WORK HANDOFF BRIEF');
    lines.push('================================================================================');
    lines.push(`Task: ${task.title} (ID: ${task.taskId})`);
    lines.push(`Handoff Route: [${handoff.fromAgent}] ──> [${handoff.toAgent}]`);
    lines.push(`Reason: ${handoff.reason.toUpperCase()}`);
    lines.push(`Timestamp: ${new Date(handoff.timestamp).toISOString()}`);
    lines.push('');

    lines.push('## Objectives & Acceptance Criteria:');
    task.requirements.forEach((req, idx) => lines.push(`  ${idx + 1}. ${req}`));
    if (task.acceptanceCriteria.length > 0) {
      lines.push('\n## Acceptance Criteria:');
      task.acceptanceCriteria.forEach((crit, idx) => lines.push(`  [ ] ${crit}`));
    }
    lines.push('');

    lines.push('## Work Accomplished So Far:');
    if (handoff.workDone.length > 0) {
      handoff.workDone.forEach((w) => lines.push(`  ✔ ${w}`));
    } else {
      lines.push('  (Initial assignment - starting implementation)');
    }
    lines.push('');

    lines.push('## Files Touched / Modified:');
    if (handoff.filesModified.length > 0) {
      handoff.filesModified.forEach((f) => lines.push(`  • ${f}`));
    } else {
      lines.push('  (No file modifications recorded yet)');
    }
    lines.push('');

    if (handoff.testResults) {
      lines.push('## Verification / Test Status:');
      lines.push(`  Status: ${handoff.testResults.passed ? 'PASSED' : 'FAILING / PENDING'}`);
      lines.push(`  Output: ${handoff.testResults.summary}`);
      lines.push('');
    }

    lines.push('## Immediate Next Actions Expected:');
    if (handoff.nextSteps.length > 0) {
      handoff.nextSteps.forEach((step, idx) => lines.push(`  ${idx + 1}. ${step}`));
    } else {
      lines.push('  1. Review existing code and continue completing requirements.');
    }

    lines.push('================================================================================');
    return lines.join('\n');
  }
}
