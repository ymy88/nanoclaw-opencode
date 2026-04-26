import { ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  queueKey: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  excludeFromHistory: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  activeTaskId: string | null;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  threadKey: string | null;
  retryCount: number;
}

/**
 * Build a queue key from a chat JID and optional thread key.
 * Format: "slack:C0AJFQPFN5D:1772771784-037519" or just "slack:C0AJFQPFN5D"
 */
export function makeQueueKey(
  chatJid: string,
  threadKey?: string | null,
): string {
  return threadKey ? `${chatJid}:${threadKey}` : chatJid;
}

/**
 * Parse a queue key back into chat JID and optional thread key.
 * Handles Slack JIDs that already contain ':' (e.g., "slack:C0AJFQPFN5D").
 */
export function parseQueueKey(queueKey: string): {
  chatJid: string;
  threadKey: string | null;
} {
  if (queueKey.startsWith('slack:')) {
    // Slack JID format: "slack:{channelId}" — channelId has no colons
    const rest = queueKey.slice(6); // after "slack:"
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) {
      return { chatJid: queueKey, threadKey: null };
    }
    return {
      chatJid: 'slack:' + rest.slice(0, colonIdx),
      threadKey: rest.slice(colonIdx + 1),
    };
  }
  // Non-Slack JIDs (WhatsApp, etc.) don't use ':' in JIDs
  const colonIdx = queueKey.indexOf(':');
  if (colonIdx === -1) {
    return { chatJid: queueKey, threadKey: null };
  }
  return {
    chatJid: queueKey.slice(0, colonIdx),
    threadKey: queueKey.slice(colonIdx + 1),
  };
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((queueKey: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(queueKey: string): GroupState {
    let state = this.groups.get(queueKey);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        excludeFromHistory: false,
        pendingMessages: false,
        pendingTasks: [],
        activeTaskId: null,
        process: null,
        containerName: null,
        groupFolder: null,
        threadKey: null,
        retryCount: 0,
      };
      this.groups.set(queueKey, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (queueKey: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(queueKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(queueKey);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ queueKey }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(queueKey)) {
        this.waitingGroups.push(queueKey);
      }
      logger.debug(
        { queueKey, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(queueKey, 'messages').catch((err) =>
      logger.error({ queueKey, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(queueKey: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(queueKey);

    // Prevent double-queuing or re-running the same task
    if (state.activeTaskId === taskId) {
      logger.debug({ queueKey, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ queueKey, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, queueKey, fn });
      if (state.idleWaiting) {
        this.closeStdin(queueKey);
      }
      logger.debug({ queueKey, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, queueKey, fn });
      if (!this.waitingGroups.includes(queueKey)) {
        this.waitingGroups.push(queueKey);
      }
      logger.debug(
        { queueKey, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(queueKey, { id: taskId, queueKey, fn }).catch((err) =>
      logger.error({ queueKey, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    queueKey: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    threadKey?: string | null,
  ): void {
    const state = this.getGroup(queueKey);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    state.threadKey = threadKey || null;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(queueKey: string): void {
    const state = this.getGroup(queueKey);
    state.idleWaiting = true;
    logger.debug(
      { queueKey, pendingTasks: state.pendingTasks.length },
      'Container notified idle',
    );
    if (state.pendingTasks.length > 0) {
      this.closeStdin(queueKey);
    }
  }

  /**
   * Resolve the IPC input directory for a queue entry.
   * Thread-keyed entries use: data/ipc/{groupFolder}/{threadKey}/input/
   * Non-threaded entries use: data/ipc/{groupFolder}/input/
   */
  private resolveIpcInputDir(state: GroupState): string | null {
    if (!state.groupFolder) return null;
    if (state.threadKey) {
      return path.join(
        DATA_DIR,
        'ipc',
        state.groupFolder,
        state.threadKey,
        'input',
      );
    }
    return path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(queueKey: string, text: string): boolean {
    const state = this.getGroup(queueKey);
    if (!state.active || !state.groupFolder || state.isTaskContainer) {
      logger.debug(
        {
          queueKey,
          active: state.active,
          groupFolder: state.groupFolder,
          isTaskContainer: state.isTaskContainer,
        },
        'Host→Container: sendMessage skipped (no active container)',
      );
      return false;
    }
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = this.resolveIpcInputDir(state);
    if (!inputDir) return false;

    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      logger.info(
        { queueKey, file: filename, textLength: text.length },
        'Host→Container: IPC message written',
      );
      return true;
    } catch {
      return false;
    }
  }

  setTaskFlags(
    queueKey: string,
    flags: { isTask: boolean; excludeFromHistory: boolean },
  ): void {
    const state = this.getGroup(queueKey);
    state.isTaskContainer = flags.isTask;
    state.excludeFromHistory = flags.excludeFromHistory;
  }

  getTaskFlags(queueKey: string): {
    isTask: boolean;
    excludeFromHistory: boolean;
  } {
    const state = this.getGroup(queueKey);
    return {
      isTask: state.isTaskContainer,
      excludeFromHistory: state.excludeFromHistory,
    };
  }

  getActiveQueueKeys(): string[] {
    return [...this.groups.entries()]
      .filter(([, state]) => state.active)
      .map(([key]) => key);
  }

  killContainer(queueKey: string): boolean {
    const state = this.getGroup(queueKey);
    if (!state.active || !state.process) return false;

    logger.info(
      { queueKey, containerName: state.containerName },
      'Killing container',
    );
    // Clear pending work so drainGroup doesn't start a new container
    state.pendingMessages = false;
    state.pendingTasks = [];
    // Kill the Docker container directly — SIGKILL on the host process
    // doesn't stop the container itself
    if (state.containerName) {
      try {
        execSync(`docker kill ${state.containerName}`, { timeout: 5000 });
      } catch {
        // Container may have already exited
      }
    }
    return true;
  }

  closeStdin(queueKey: string): void {
    const state = this.getGroup(queueKey);
    if (!state.active || !state.groupFolder) return;

    logger.info({ queueKey }, 'Host→Container: writing _close sentinel');
    const inputDir = this.resolveIpcInputDir(state);
    if (!inputDir) return;

    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    queueKey: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(queueKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { queueKey, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(queueKey);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(queueKey, state);
        }
      }
    } catch (err) {
      logger.error({ queueKey, err }, 'Error processing messages for group');
      this.scheduleRetry(queueKey, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.threadKey = null;
      this.activeCount--;
      this.drainGroup(queueKey);
    }
  }

  private async runTask(queueKey: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(queueKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.activeTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { queueKey, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ queueKey, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.activeTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.threadKey = null;
      this.activeCount--;
      this.drainGroup(queueKey);
    }
  }

  private scheduleRetry(queueKey: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { queueKey, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { queueKey, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(queueKey);
      }
    }, delayMs);
  }

  private drainGroup(queueKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(queueKey);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(queueKey, task).catch((err) =>
        logger.error(
          { queueKey, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(queueKey, 'drain').catch((err) =>
        logger.error(
          { queueKey, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextKey = this.waitingGroups.shift()!;
      const state = this.getGroup(nextKey);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextKey, task).catch((err) =>
          logger.error(
            { queueKey: nextKey, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextKey, 'drain').catch((err) =>
          logger.error(
            { queueKey: nextKey, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_key, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
