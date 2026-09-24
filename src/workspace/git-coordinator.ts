import * as cp from 'child_process';
import { AgentId } from '../types.js';

export interface GitWorkspaceSnapshot {
  isGitRepo: boolean;
  branch: string | null;
  modifiedFiles: string[];
  untrackedFiles: string[];
  headCommit: string | null;
}

export class GitCoordinator {
  private workspaceRoot: string;

  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  public getSnapshot(): GitWorkspaceSnapshot {
    try {
      const branchRes = cp.spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.workspaceRoot,
        encoding: 'utf8'
      });

      if (branchRes.status !== 0) {
        return {
          isGitRepo: false,
          branch: null,
          modifiedFiles: [],
          untrackedFiles: [],
          headCommit: null
        };
      }

      const branch = branchRes.stdout.trim();

      const commitRes = cp.spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.workspaceRoot,
        encoding: 'utf8'
      });
      const headCommit = commitRes.status === 0 ? commitRes.stdout.trim() : null;

      const statusRes = cp.spawnSync('git', ['status', '--porcelain'], {
        cwd: this.workspaceRoot,
        encoding: 'utf8'
      });

      const modifiedFiles: string[] = [];
      const untrackedFiles: string[] = [];

      if (statusRes.status === 0 && statusRes.stdout) {
        const lines = statusRes.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (const line of lines) {
          const code = line.slice(0, 2);
          const file = line.slice(3).trim();
          if (code.includes('?')) {
            untrackedFiles.push(file);
          } else {
            modifiedFiles.push(file);
          }
        }
      }

      return {
        isGitRepo: true,
        branch,
        modifiedFiles,
        untrackedFiles,
        headCommit
      };
    } catch {
      return {
        isGitRepo: false,
        branch: null,
        modifiedFiles: [],
        untrackedFiles: [],
        headCommit: null
      };
    }
  }

  /**
   * Commits modifications to files git already tracks. Untracked files are never
   * staged, so a stray .env or scratch file can't end up in history.
   */
  public commitCheckpoint(taskId: string, fromAgent: AgentId, toAgent: AgentId): string | null {
    try {
      const addRes = cp.spawnSync('git', ['add', '-u'], { cwd: this.workspaceRoot });
      if (addRes.status !== 0) return null;

      const staged = cp.spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: this.workspaceRoot });
      if (staged.status === 0) return null;

      const message = `[agentmesh] handoff: ${fromAgent} -> ${toAgent} (${taskId})`;
      const commitRes = cp.spawnSync('git', ['commit', '-m', message], {
        cwd: this.workspaceRoot,
        encoding: 'utf8'
      });

      if (commitRes.status === 0) {
        const hashRes = cp.spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: this.workspaceRoot,
          encoding: 'utf8'
        });
        return hashRes.stdout.trim();
      }
    } catch {
      // not a git repo or nothing to commit
    }
    return null;
  }
}
