import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AgentId, HandoffRecord, TaskState, TaskStatus } from '../types.js';

export class TaskStore {
  private baseDir: string;

  constructor(workspaceRoot = process.cwd()) {
    this.baseDir = path.join(workspaceRoot, '.agentmesh');
    if (!fs.existsSync(this.baseDir)) {
      try {
        fs.mkdirSync(path.join(this.baseDir, 'tasks'), { recursive: true });
      } catch {}
    }
  }

  public createTask(title: string, requirements: string[], acceptanceCriteria: string[] = []): TaskState {
    const taskId = `task-${uuidv4().slice(0, 8)}`;
    const task: TaskState = {
      taskId,
      title,
      status: 'pending',
      requirements,
      acceptanceCriteria,
      filesChanged: [],
      handoffs: [],
      workspaceRoot: process.cwd(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.saveTask(task);
    this.setCurrentTaskId(taskId);
    return task;
  }

  public getTask(taskId: string): TaskState | null {
    const filePath = path.join(this.baseDir, 'tasks', `${taskId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {}
    }
    return null;
  }

  public getCurrentTask(): TaskState | null {
    const currentIdPath = path.join(this.baseDir, 'current-task.json');
    if (fs.existsSync(currentIdPath)) {
      try {
        const { currentTaskId } = JSON.parse(fs.readFileSync(currentIdPath, 'utf8'));
        if (currentTaskId) {
          return this.getTask(currentTaskId);
        }
      } catch {}
    }
    return null;
  }

  public setCurrentTaskId(taskId: string): void {
    const currentIdPath = path.join(this.baseDir, 'current-task.json');
    fs.writeFileSync(currentIdPath, JSON.stringify({ currentTaskId: taskId }, null, 2), 'utf8');
  }

  public saveTask(task: TaskState): void {
    task.updatedAt = Date.now();
    const tasksDir = path.join(this.baseDir, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      fs.mkdirSync(tasksDir, { recursive: true });
    }
    const filePath = path.join(tasksDir, `${task.taskId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf8');
  }

  public recordHandoff(task: TaskState, handoff: HandoffRecord): void {
    task.handoffs.push(handoff);
    task.currentAgent = handoff.toAgent;
    task.status = 'in_progress';
    this.saveTask(task);
  }

  public updateTaskStatus(task: TaskState, status: TaskStatus): void {
    task.status = status;
    this.saveTask(task);
  }

  public listTasks(): TaskState[] {
    const tasksDir = path.join(this.baseDir, 'tasks');
    if (!fs.existsSync(tasksDir)) return [];

    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    const list: TaskState[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(tasksDir, f), 'utf8');
        list.push(JSON.parse(raw));
      } catch {}
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
