import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOptions,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAutoRegister?: (
    jid: string,
    channelName: string,
    channelId: string,
  ) => void;
  onDead?: () => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    threadTs?: string;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private userTzCache = new Map<string, string>();

  private opts: SlackChannelOpts;
  private appToken: string;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;
    this.appToken = appToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const rawThreadTs = (msg as { thread_ts?: string }).thread_ts;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups.
      // If the channel isn't registered yet but onAutoRegister is configured,
      // register it on first message (fallback for when member_joined_channel
      // event isn't subscribed or was missed).
      let groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        if (this.opts.onAutoRegister && isGroup) {
          try {
            const channelId = msg.channel;
            const info = await this.app.client.conversations.info({
              channel: channelId,
            });
            const channelName =
              (info.channel as { name?: string })?.name || channelId;
            this.opts.onAutoRegister(jid, channelName, channelId);
            groups = this.opts.registeredGroups();
            logger.info(
              { jid, channelName },
              'Auto-registered Slack channel on first message',
            );
          } catch (err) {
            logger.error(
              { channel: msg.channel, err },
              'Failed to auto-register channel on first message',
            );
            return;
          }
        } else {
          return;
        }
      }

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;

      // Download shared files and pass local paths to the agent
      const files = (
        msg as {
          files?: Array<{
            url_private_download?: string;
            url_private?: string;
            name?: string;
            mimetype?: string;
          }>;
        }
      ).files;
      if (files?.length) {
        const group = groups[jid];
        const fileLines = await Promise.all(
          files
            .filter((f) => f.url_private_download || f.url_private)
            .map(async (f) => {
              const localPath = await this.downloadFile(
                (f.url_private_download || f.url_private)!,
                f.name || 'file',
                group.folder,
                f.mimetype,
              );
              if (localPath) {
                return `[file: ${f.name || 'unknown'} (${f.mimetype || 'unknown'}): ${localPath}]`;
              }
              return null;
            }),
        );
        const validLines = fileLines.filter(Boolean);
        if (validLines.length) {
          content = (content || '') + '\n' + validLines.join('\n');
        }
      }

      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Determine threadTs for the message:
      // - Thread reply (thread_ts != ts): threadTs = thread_ts (reply to existing thread)
      // - Channel-level message with alwaysReplyInThread: threadTs = msg.ts (start new thread)
      // - Otherwise: no threadTs
      let threadTs: string | undefined;
      if (rawThreadTs && rawThreadTs !== msg.ts) {
        // This is a reply in an existing thread
        threadTs = rawThreadTs;
      } else if (!rawThreadTs || rawThreadTs === msg.ts) {
        // Channel-level message (or thread parent, same thing)
        const group = groups[jid];
        if (group && group.alwaysReplyInThread !== false) {
          // Start a new thread under this message
          threadTs = msg.ts;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        threadTs,
        senderTimezone: msg.user ? this.userTzCache.get(msg.user) : undefined,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();
    this.attachPingPongLogging();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();

    // Poll WebSocket health and auto-reconnect if dead.
    // Bolt's SocketModeClient has built-in auto-reconnect, but its 'disconnected'
    // event only fires when reconnect is disabled or disconnect() is called explicitly.
    // With auto-reconnect enabled (the default), the client retries internally and
    // never emits 'disconnected' — so we can't listen for it. Instead, we poll
    // websocket.isActive() to detect when the connection is truly dead (e.g., after
    // the client exhausts its own retries following a network outage).
    this.startHealthCheck();
  }

  private reconnecting = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  private getWebSocket(): { isActive(): boolean } | null {
    const receiver = this.app as unknown as {
      receiver?: {
        client?: { websocket?: { isActive(): boolean } };
      };
    };
    return receiver.receiver?.client?.websocket ?? null;
  }

  private getRawWebSocket(): any | null {
    const receiver = this.app as unknown as {
      receiver?: {
        client?: {
          websocket?: {
            websocket?: { ping: Function; on: Function; readyState: number };
          };
        };
      };
    };
    return receiver.receiver?.client?.websocket?.websocket ?? null;
  }

  private attachPingPongLogging(): void {
    // Ping/pong logging disabled — enable for debugging by uncommenting below
    // const ws = this.getRawWebSocket();
    // if (!ws) return;
    // ws.on('ping', () => { logger.info('WebSocket received ping from Slack'); });
    // ws.on('pong', () => { logger.info('WebSocket received pong from Slack'); });
  }

  /**
   * Send a WebSocket ping and return whether a pong was received.
   * Used by the health endpoint to verify the connection is truly alive.
   */
  async pingWebSocket(timeoutMs = 10_000): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const ws = this.getRawWebSocket();
    if (!ws) return { ok: false, error: 'raw WebSocket not available' };
    if (ws.readyState !== 1) return { ok: false, error: `readyState=${ws.readyState}` };

    const start = Date.now();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ ok: false, error: 'pong timeout' });
      }, timeoutMs);

      ws.once('pong', () => {
        clearTimeout(timeout);
        resolve({ ok: true, latencyMs: Date.now() - start });
      });

      try {
        ws.ping();
      } catch (err) {
        clearTimeout(timeout);
        resolve({ ok: false, error: `ping failed: ${err}` });
      }
    });
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    const HEALTH_CHECK_INTERVAL = 30_000; // 30 seconds
    const NETWORK_CHECK_INTERVAL = 60_000; // wait between retries when network is down

    let waitingForNetwork = false;

    this.healthCheckTimer = setInterval(async () => {
      const ws = this.getWebSocket();
      if (!ws || ws.isActive() || this.reconnecting || waitingForNetwork) return;

      // WebSocket is dead — check if it's a network issue or Slack issue
      try {
        await fetch('https://slack.com/api/api.test', { signal: AbortSignal.timeout(5000) });
        // Network is fine, Slack API reachable — the WebSocket session is stale
        logger.error('Slack WebSocket is not active but network is OK, requesting re-creation');
        clearInterval(this.healthCheckTimer!);
        this.healthCheckTimer = null;
        this.opts.onDead?.();
      } catch {
        // Network is down — wait for it to come back
        logger.warn('Slack WebSocket is not active and network is down, waiting');
        this.connected = false;
        waitingForNetwork = true;
        clearInterval(this.healthCheckTimer!);
        this.healthCheckTimer = null;
        const waitForNetwork = setInterval(async () => {
          try {
            await fetch('https://slack.com/api/api.test', { signal: AbortSignal.timeout(5000) });
            clearInterval(waitForNetwork);
            logger.info('Network restored, requesting re-creation');
            this.opts.onDead?.();
          } catch {
            logger.warn('Network still down, waiting');
          }
        }, NETWORK_CHECK_INTERVAL);
        waitForNetwork.unref();
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = options?.threadTs;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        }
      }
      logger.info({ jid, length: text.length, threadTs }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name: emoji,
      });
    } catch (err: unknown) {
      const code = (err as { data?: { error?: string } })?.data?.error;
      if (code !== 'already_reacted') {
        logger.warn({ jid, messageId, emoji, err }, 'Failed to add reaction');
      }
    }
  }

  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name: emoji,
      });
    } catch (err: unknown) {
      const code = (err as { data?: { error?: string } })?.data?.error;
      if (code !== 'no_reaction') {
        logger.warn(
          { jid, messageId, emoji, err },
          'Failed to remove reaction',
        );
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.reconnecting = true; // Prevent auto-reconnect during intentional disconnect
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.connected = false;
    await this.app.stop();
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const filename = filePath.split('/').pop() || 'image.png';

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uploadArgs: any = {
        channel_id: channelId,
        file: filePath,
        filename,
        initial_comment: caption || undefined,
      };
      if (options?.threadTs) {
        uploadArgs.thread_ts = options.threadTs;
      }
      await this.app.client.filesUploadV2(uploadArgs);
      logger.info({ jid, filePath }, 'Slack image sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Slack image');
      throw err;
    }
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  private typingMessageId: string | null = null;
  private typingChannelId: string | null = null;

  async setTyping(
    jid: string,
    isTyping: boolean,
    messageId?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (isTyping && messageId) {
      // Clear previous typing reaction if on a different message
      if (this.typingMessageId && this.typingMessageId !== messageId) {
        await this.removeReaction(jid, this.typingMessageId, 'pencil2');
      }
      this.typingMessageId = messageId;
      this.typingChannelId = channelId;
      await this.addReaction(jid, messageId, 'pencil2');
    } else if (!isTyping && this.typingMessageId) {
      await this.removeReaction(jid, this.typingMessageId, 'pencil2');
      this.typingMessageId = null;
      this.typingChannelId = null;
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  /**
   * Download a Slack file using the bot token and save it to the group's
   * downloads folder. Returns the container-local path (/workspace/group/downloads/...).
   * Images are compressed and resized (max 1024px) before saving.
   */
  private async downloadFile(
    url: string,
    filename: string,
    groupFolder: string,
    mimetype?: string,
  ): Promise<string | null> {
    try {
      const downloadDir = path.join(GROUPS_DIR, groupFolder, 'downloads');
      fs.mkdirSync(downloadDir, { recursive: true });

      // Prefix with timestamp to avoid collisions
      const safeFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const hostPath = path.join(downloadDir, safeFilename);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      if (!res.ok) {
        logger.error(
          { url, status: res.status },
          'Failed to download Slack file',
        );
        return null;
      }

      let buffer = Buffer.from(await res.arrayBuffer());
      const originalSize = buffer.length;

      // Compress images before saving
      const isImage =
        mimetype?.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif)$/i.test(filename);
      if (isImage) {
        try {
          const sharp = (await import('sharp')).default;
          const ext = path.extname(filename).toLowerCase();
          const isWebp = ext === '.webp' || mimetype === 'image/webp';
          const isPng = ext === '.png' || mimetype === 'image/png';

          let pipeline = sharp(buffer).resize(1024, 1024, {
            fit: 'inside',
            withoutEnlargement: true,
          });

          if (isWebp || isPng) {
            // WebP → convert to PNG; PNG → compress with 256-color palette
            pipeline = pipeline.png({
              palette: true,
              colours: 256,
              compressionLevel: 9,
            });
          } else {
            // JPEG and others → compress at 90% quality
            pipeline = pipeline.jpeg({ quality: 90 });
          }

          buffer = Buffer.from(await pipeline.toBuffer());
          logger.info(
            {
              filename,
              originalSize,
              compressedSize: buffer.length,
              ratio: `${Math.round((buffer.length / originalSize) * 100)}%`,
            },
            'Image compressed',
          );
        } catch (compressErr) {
          logger.warn(
            { filename, err: compressErr },
            'Image compression failed, using original',
          );
        }
      }

      fs.writeFileSync(hostPath, buffer);

      logger.info({ filename, hostPath, size: buffer.length }, 'Slack file downloaded');
      return `/workspace/group/downloads/${safeFilename}`;
    } catch (err) {
      logger.error({ url, filename, err }, 'Failed to download Slack file');
      return null;
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      const tz = (result.user as { tz?: string })?.tz;
      if (tz) this.userTzCache.set(userId, tz);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(item.threadTs ? { thread_ts: item.threadTs } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
