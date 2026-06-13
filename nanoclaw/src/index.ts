import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SLACK_ONLY,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { SlackChannel } from './channels/slack.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  deleteMessageById,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getMessagesSinceForThread,
  getLastMessagePerChannel,
  getNewMessages,
  getRecentMessages,
  getRecentTaskOutput,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
} from './db.js';
import { GroupQueue, makeQueueKey, parseQueueKey } from './group-queue.js';
import {
  resolveGroupFolderPath,
  sanitizeThreadKey,
  unsanitizeThreadKey,
} from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { startHostTaskScheduler } from './host-tasks.js';
import {
  findChannel,
  formatChannelContext,
  formatMessages,
  formatOutbound,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  NewMessage,
  RegisteredGroup,
  SendMessageOptions,
} from './types.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const STOP_PATTERN = /^\s*(?:@\S+\s+)?\/stop\s*$/;

function isStopCommand(content: string): boolean {
  return STOP_PATTERN.test(content);
}

const COMPACT_HISTORY_PATTERN =
  /^\s*(?:@\S+\s+)?\/compact-history(?:\s+(\d+))?\s*$/;

function parseCompactHistoryCommand(content: string): number | null {
  const match = content.match(COMPACT_HISTORY_PATTERN);
  if (!match) return null;
  return match[1] ? parseInt(match[1], 10) : 60;
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
// Queue keys that were stopped via /stop — skip cursor rollback on error
const stoppedQueueKeys = new Set<string>();

let whatsapp: WhatsAppChannel;
let slack: SlackChannel | undefined;
const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group (or thread).
 * Called by the GroupQueue when it's this queue key's turn.
 * queueKey format: "chatJid" or "chatJid:threadKey"
 */
async function processGroupMessages(queueKey: string): Promise<boolean> {
  const { chatJid, threadKey } = parseQueueKey(queueKey);
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // For threaded messages, use thread-specific query; otherwise get all messages
  const sinceTimestamp = lastAgentTimestamp[queueKey] || '';
  let missedMessages = threadKey
    ? getMessagesSinceForThread(
        chatJid,
        sinceTimestamp,
        ASSISTANT_NAME,
        unsanitizeThreadKey(threadKey),
      )
    : getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  // Filter out commands handled in the message loop
  missedMessages = missedMessages.filter(
    (m) =>
      !isStopCommand(m.content) &&
      parseCompactHistoryCommand(m.content) === null,
  );
  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // For threaded messages, prepend recent channel history as context
  // so the agent knows what's been discussed in the channel.
  // Cap to messages since the last bot mention (last conversation turn).
  let channelContext = '';
  if (threadKey) {
    const recentMessages = getRecentMessages(chatJid, 50, ASSISTANT_NAME);
    // Find the last bot mention (skipping the current trigger) and start after it
    let startIdx = 0;
    for (let i = recentMessages.length - 2; i >= 0; i--) {
      if (TRIGGER_PATTERN.test(recentMessages[i].content.trim())) {
        startIdx = i + 1;
        break;
      }
    }
    const contextMessages = recentMessages.slice(startIdx);
    channelContext = formatChannelContext(contextMessages);
  }

  // Inject recent visible task output as context
  const taskOutput = getRecentTaskOutput(chatJid, sinceTimestamp);
  const taskContext = taskOutput.length > 0
    ? '<scheduled-task-output>\n' +
      taskOutput.map((m) => `[${m.sender_name || 'Task'}]: ${m.content}`).join('\n') +
      '\n</scheduled-task-output>\n\n'
    : '';

  const prompt = channelContext + taskContext + formatMessages(missedMessages);

  // Extract sender timezone from the most recent non-bot message
  const senderTimezone = [...missedMessages]
    .reverse()
    .find((m) => !m.is_bot_message && m.senderTimezone)?.senderTimezone;

  // Compute reply thread ts from threadKey for Slack thread replies
  const replyThreadTs = threadKey ? unsanitizeThreadKey(threadKey) : undefined;

  // Build send options for thread-aware replies
  const sendOptions: SendMessageOptions | undefined = replyThreadTs
    ? { threadTs: replyThreadTs }
    : undefined;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[queueKey] || '';
  lastAgentTimestamp[queueKey] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  // Find the last user message to use as typing indicator target
  const triggerMessage = [...missedMessages]
    .reverse()
    .find((m) => !m.is_bot_message);

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      threadKey: threadKey || undefined,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info(
        { group: group.name, threadKey },
        'Host: idle timeout fired, closing container stdin',
      );
      queue.closeStdin(queueKey);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true, triggerMessage?.id);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    threadKey,
    replyThreadTs,
    senderTimezone,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.setTyping?.(chatJid, false);
          storeMessageDirect({
            id: `bot-${Date.now()}`,
            chat_jid: chatJid,
            sender: 'bot',
            sender_name: ASSISTANT_NAME,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
            sent_method: 'streaming_result',
            threadTs: sendOptions?.threadTs,
          });
          await channel.sendMessage(chatJid, text, sendOptions);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(queueKey);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  // Safety: ensure typing indicator is cleared when agent finishes
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // If killed by /stop, don't roll back — the user intentionally cancelled
    if (stoppedQueueKeys.has(queueKey)) {
      stoppedQueueKeys.delete(queueKey);
      logger.info(
        { group: group.name },
        'Agent killed by /stop, skipping cursor rollback',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[queueKey] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  threadKey?: string | null,
  replyThreadTs?: string,
  senderTimezone?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  // Sessions are keyed by "folder:threadKey" for threads, "folder" for non-threaded
  const sessionKey = threadKey ? `${group.folder}:${threadKey}` : group.folder;
  const sessionId = sessions[sessionKey];
  const queueKey = makeQueueKey(chatJid, threadKey);

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sessionKey] = output.newSessionId;
          setSession(group.folder, output.newSessionId, threadKey || undefined);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        replyThreadTs,
        threadKey: threadKey || undefined,
        senderTimezone,
        providerID: DEFAULT_PROVIDER,
        modelID: DEFAULT_MODEL,
      },
      (proc, containerName) =>
        queue.registerProcess(
          queueKey,
          proc,
          containerName,
          group.folder,
          threadKey,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(group.folder, output.newSessionId, threadKey || undefined);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  startHostTaskScheduler();
  // Health check HTTP server
  const HEALTH_PORT = 3847;
  Bun.serve({
    port: HEALTH_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health/slack-ping') {
        if (!slack) {
          return Response.json({ ok: false, error: 'Slack not initialized' });
        }
        const result = await slack.pingWebSocket();
        return Response.json({ ...result, timestamp: new Date().toISOString() });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  logger.info({ port: HEALTH_PORT }, 'Health check server started');

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  // Reprocess unanswered messages from before restart.
  // lastAgentTimestamp advances to the user message timestamp before the agent
  // responds, so we can't rely on it. Instead, check if the last message in
  // each channel is from a user — if so, roll back lastAgentTimestamp to before
  // that message so processGroupMessages finds it.
  const lastMessages = getLastMessagePerChannel(Object.keys(registeredGroups));
  for (const last of lastMessages) {
    if (!last.is_bot_message) {
      const queueKey = last.chat_jid;
      const rollbackTs = new Date(new Date(last.timestamp).getTime() - 1).toISOString();
      const group = registeredGroups[last.chat_jid];
      logger.info(
        { group: group?.folder, jid: last.chat_jid, timestamp: last.timestamp },
        'Found unanswered message, rolling back agent cursor to reprocess',
      );
      lastAgentTimestamp[queueKey] = rollbackTs;
      saveState();
      queue.enqueueMessageCheck(last.chat_jid);
    }
  }

  while (true) {
    // Check for session reset signals from compact-history script
    for (const group of Object.values(registeredGroups)) {
      const resetFile = path.join(
        DATA_DIR,
        'ipc',
        group.folder,
        '_session_reset',
      );
      if (fs.existsSync(resetFile)) {
        try {
          fs.unlinkSync(resetFile);
        } catch {
          /* ignore */
        }
        for (const key of Object.keys(sessions)) {
          if (key === group.folder || key.startsWith(`${group.folder}:`)) {
            delete sessions[key];
          }
        }
        logger.info(
          { group: group.name },
          'Session reset: cleared in-memory sessions',
        );
      }
    }

    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Group messages by queueKey (chatJid + threadKey)
        const messagesByQueue = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          // Compute threadKey from message's threadTs
          let threadKey: string | null = null;
          if (msg.threadTs) {
            threadKey = sanitizeThreadKey(msg.threadTs);
          }
          const queueKey = makeQueueKey(msg.chat_jid, threadKey);

          const existing = messagesByQueue.get(queueKey);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByQueue.set(queueKey, [msg]);
          }
        }

        for (const [queueKey, groupMessages] of messagesByQueue) {
          const { chatJid, threadKey } = parseQueueKey(queueKey);
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // Handle /stop command — kill active container immediately
          const hasStop = groupMessages.some(
            (m) => !m.is_bot_message && isStopCommand(m.content),
          );
          if (hasStop) {
            // Kill containers for all queue keys matching this chatJid
            let killed = false;
            for (const key of queue.getActiveQueueKeys()) {
              if (key === chatJid || key.startsWith(`${chatJid}:`)) {
                if (queue.killContainer(key)) {
                  killed = true;
                  stoppedQueueKeys.add(key);
                }
              }
            }
            if (killed) {
              logger.info({ chatJid }, '/stop: killed active container');
            }
            // Acknowledge with a checkmark reaction on the stop message
            const stopMsg = [...groupMessages]
              .reverse()
              .find((m) => !m.is_bot_message && isStopCommand(m.content));
            if (stopMsg) {
              channel.setTyping?.(chatJid, false)?.catch(() => {});
              channel
                .addReaction?.(chatJid, stopMsg.id, 'white_check_mark')
                ?.catch(() => {});
            }
            // Delete command messages from DB and advance cursor
            for (const m of groupMessages) {
              if (!m.is_bot_message && isStopCommand(m.content)) {
                deleteMessageById(m.id);
              }
            }
            lastAgentTimestamp[queueKey] =
              groupMessages[groupMessages.length - 1].timestamp;
            saveState();
            continue;
          }

          // Handle /compact-history command
          const compactMsg = groupMessages.find(
            (m) =>
              !m.is_bot_message &&
              parseCompactHistoryCommand(m.content) !== null,
          );
          if (compactMsg) {
            const limit = parseCompactHistoryCommand(compactMsg.content)!;
            logger.info(
              { group: group.folder, chatJid, limit },
              '/compact-history: received',
            );

            // Kill active containers (same as /stop)
            for (const key of queue.getActiveQueueKeys()) {
              if (key === chatJid || key.startsWith(`${chatJid}:`)) {
                if (queue.killContainer(key)) {
                  stoppedQueueKeys.add(key);
                  logger.info({ queueKey: key }, '/compact-history: killed active container');
                }
              }
            }

            channel.setTyping?.(chatJid, false)?.catch(() => {});
            channel
              .addReaction?.(chatJid, compactMsg.id, 'hourglass_flowing_sand')
              ?.catch(() => {});

            deleteMessageById(compactMsg.id);
            lastAgentTimestamp[queueKey] =
              groupMessages[groupMessages.length - 1].timestamp;
            saveState();

            const skillDir = path.join(
              process.cwd(),
              '.claude/skills/compact-history',
            );
            logger.info(
              { skillDir, folder: group.folder, limit },
              '/compact-history: spawning compact.py',
            );
            const child = spawn(
              'uv',
              [
                'run',
                '--project',
                skillDir,
                'compact.py',
                group.folder,
                '--days',
                String(limit),
              ],
              {
                cwd: skillDir,
                stdio: 'pipe',
                env: {
                  ...process.env,
                  PATH: [
                    process.env.PATH,
                    '/opt/homebrew/bin',
                    '/usr/local/bin',
                    `${process.env.HOME}/.local/bin`,
                  ].filter(Boolean).join(':'),
                  ...(process.env.GOOGLE_APPLICATION_CREDENTIALS
                    ? { GOOGLE_APPLICATION_CREDENTIALS: path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS) }
                    : {}),
                },
              },
            );

            let stderr = '';
            child.stderr?.on('data', (data: Buffer) => {
              stderr += data.toString();
            });

            child.on('error', (err) => {
              logger.error({ err, group: group.folder }, '/compact-history: spawn error');
              channel
                .addReaction?.(chatJid, compactMsg.id, 'x')
                ?.catch(() => {});
            });

            child.on('close', (code) => {
              channel
                .removeReaction?.(chatJid, compactMsg.id, 'hourglass_flowing_sand')
                ?.catch(() => {});
              const emoji = code === 0 ? 'white_check_mark' : 'x';
              channel
                .addReaction?.(chatJid, compactMsg.id, emoji)
                ?.catch(() => {});
              if (code === 0) {
                logger.info(
                  { group: group.folder, limit },
                  '/compact-history: completed',
                );
              } else {
                logger.error(
                  { group: group.folder, limit, code, stderr },
                  '/compact-history: failed',
                );
              }
            });

            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = threadKey
            ? getMessagesSinceForThread(
                chatJid,
                lastAgentTimestamp[queueKey] || '',
                ASSISTANT_NAME,
                unsanitizeThreadKey(threadKey),
              )
            : getMessagesSince(
                chatJid,
                lastAgentTimestamp[queueKey] || '',
                ASSISTANT_NAME,
              );
          const messagesToSend = (
            allPending.length > 0 ? allPending : groupMessages
          ).filter(
            (m) =>
              !isStopCommand(m.content) &&
              parseCompactHistoryCommand(m.content) === null,
          );
          if (messagesToSend.length === 0) continue;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(queueKey, formatted)) {
            logger.debug(
              { queueKey, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[queueKey] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator on the last user message
            const lastUserMsg = [...messagesToSend]
              .reverse()
              .find((m) => !m.is_bot_message);
            channel
              .setTyping?.(chatJid, true, lastUserMsg?.id)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(queueKey);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 * Recovers both channel-level and per-thread cursors.
 */
function recoverPendingMessages(): void {
  // Recover channel-level messages (non-threaded)
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      // Group pending messages by their thread to create per-thread queue keys
      const threadKeys = new Set<string | null>();
      for (const msg of pending) {
        if (msg.threadTs) {
          threadKeys.add(sanitizeThreadKey(msg.threadTs));
        } else {
          threadKeys.add(null);
        }
      }
      for (const threadKey of threadKeys) {
        const queueKey = makeQueueKey(chatJid, threadKey);
        logger.info(
          { group: group.name, queueKey, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        queue.enqueueMessageCheck(queueKey);
      }
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  // Check if Slack tokens are configured
  const slackEnv = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  const hasSlackTokens = !!(
    slackEnv.SLACK_BOT_TOKEN && slackEnv.SLACK_APP_TOKEN
  );

  if (!SLACK_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (hasSlackTokens) {
    // When the Slack WebSocket dies, wait for all active containers to finish
    // sending their responses, then exit. launchd/systemd restarts us cleanly
    // with a fresh connection.
    const onSlackDead = async (): Promise<void> => {
      logger.info('Slack connection dead, waiting for active containers to finish before restarting');
      const POLL_INTERVAL_MS = 2_000;
      while (queue.getActiveQueueKeys().length > 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      logger.info('All containers finished, restarting process');
      process.exit(1);
    };

    const createSlackChannel = (): SlackChannel =>
      new SlackChannel({
        ...channelOpts,
        onAutoRegister: (jid, channelName, _channelId) => {
          const folder = channelName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          registerGroup(jid, {
            name: channelName,
            folder,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: true,
            alwaysReplyInThread: true,
          });
        },
        onDead: () => {
          void onSlackDead();
        },
      });

    slack = createSlackChannel();
    channels.push(slack);
    await slack.connect();
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        const taskFlags = queue.getTaskFlags(jid);
        storeMessageDirect({
          id: `bot-${Date.now()}`,
          chat_jid: jid,
          sender: 'bot',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          is_scheduled_task: true,
          exclude_from_history: taskFlags.excludeFromHistory,
          sent_method: 'scheduler_result',
        });
        await channel.sendMessage(jid, text);
      }
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const taskFlags = queue.getTaskFlags(jid);
      storeMessageDirect({
        id: `bot-${Date.now()}`,
        chat_jid: jid,
        sender: 'bot',
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
        is_scheduled_task: taskFlags.isTask,
        exclude_from_history: taskFlags.excludeFromHistory,
        sent_method: 'ipc_send_message',
        threadTs: options?.threadTs,
      });
      return channel.sendMessage(jid, text, options);
    },
    sendImage: async (jid, filePath, caption, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const taskFlags = queue.getTaskFlags(jid);
      storeMessageDirect({
        id: `bot-img-${Date.now()}`,
        chat_jid: jid,
        sender: 'bot',
        sender_name: ASSISTANT_NAME,
        content: caption
          ? `[image: ${path.basename(filePath)}] ${caption}`
          : `[image: ${path.basename(filePath)}]`,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
        is_scheduled_task: taskFlags.isTask,
        exclude_from_history: taskFlags.excludeFromHistory,
        sent_method: 'ipc_send_file',
        threadTs: options?.threadTs,
      });
      if (channel.sendImage) {
        await channel.sendImage(jid, filePath, caption, options);
      } else {
        // Fallback: send caption as text if channel doesn't support images
        if (caption) await channel.sendMessage(jid, caption, options);
        logger.warn(
          { jid, channel: channel.name },
          'Channel does not support sendImage, caption sent as text',
        );
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async (force) => {
      // Sync metadata across all active channels
      if (whatsapp) await whatsapp.syncGroupMetadata(force);
      if (slack) await slack.syncChannelMetadata();
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
