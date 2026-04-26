import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

type ToolResult = string | { output: string; metadata?: Record<string, any> };

function tool<Args extends Record<string, any>>(input: {
  description: string;
  args: Args;
  execute(args: any, context?: any): Promise<ToolResult>;
}) {
  return input;
}

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export interface IpcContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  replyThreadTs?: string;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

export function createNanoclawTools(ctx: IpcContext, z: any) {
  const send_message = tool({
    description:
      "Send a message to the user or group immediately while you're still running. Use this ONLY for progress updates during long-running tasks (e.g., 'Starting research...', 'Found 3 results, analyzing...'). Do NOT use this to send your final answer — your final output is automatically delivered to the user when you finish. If you send your conclusion via send_message AND also return it as your final output, the user will see it twice.",
    args: {
      text: z.string().describe('The message text to send'),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
        ),
    },
    async execute(args) {
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid: ctx.chatJid,
        text: args.text,
        sender: args.sender || undefined,
        groupFolder: ctx.groupFolder,
        replyThreadTs: ctx.replyThreadTs,
        timestamp: new Date().toISOString(),
      });
      return 'Message sent.';
    },
  });

  const send_file = tool({
    description:
      'Send a file to the user or group. Works for any file type: images, PDFs, documents, spreadsheets, archives, etc. The file must exist under /workspace/group/.',
    args: {
      file_path: z
        .string()
        .describe('Absolute path to the file (must be under /workspace/group/)'),
      caption: z.string().optional().describe('Optional caption to send with the file'),
    },
    async execute(args) {
      const resolved = path.resolve(args.file_path);
      if (!resolved.startsWith('/workspace/group/')) {
        return 'Error: file_path must be under /workspace/group/';
      }
      if (!fs.existsSync(resolved)) {
        return `Error: file not found: ${resolved}`;
      }

      writeIpcFile(MESSAGES_DIR, {
        type: 'file',
        chatJid: ctx.chatJid,
        filePath: resolved,
        caption: args.caption || undefined,
        groupFolder: ctx.groupFolder,
        replyThreadTs: ctx.replyThreadTs,
        timestamp: new Date().toISOString(),
      });
      return 'File sent.';
    },
  });

  const schedule_task = tool({
    description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

IMPORTANT - SPEC FILE CONVENTION:
Always write the full task instructions to a spec file FIRST, then use the file path as the prompt:
1. Write instructions to /workspace/group/scheduled-task-specs/{task-name}.md
2. Set prompt to: "Read and follow the instructions in /workspace/group/scheduled-task-specs/{task-name}.md"
This makes tasks easy to edit later — just update the spec file, no need to reschedule.

CONTEXT MODE - Choose based on task type:
• "group": Task runs in the group's conversation context, with access to chat history.
• "isolated": Task runs in a fresh session with no conversation history. To provide one-time context from chat, write a file at /workspace/group/scheduled-task-specs/{task-name}.context.md — it will be loaded once and deleted.

EXCLUDE FROM HISTORY - Controls whether task output is visible to the main chat:
• true (default): Task output is NOT visible to the main chat agent.
• false: Task output IS visible — the main chat agent will see the task's responses as context when the user sends a message.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
    args: {
      prompt: z
        .string()
        .describe('What the agent should do when the task runs.'),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .describe('cron=recurring at specific times, interval=recurring every N ms, once=run once'),
      schedule_value: z
        .string()
        .describe('cron: "*/5 * * * *" | interval: "300000" | once: "2026-02-01T15:30:00"'),
      context_mode: z
        .enum(['group', 'isolated'])
        .default('group')
        .describe('group=runs with chat history, isolated=fresh session'),
      exclude_from_history: z
        .boolean()
        .default(true)
        .describe('true (default): task output is hidden from main chat. false: main chat agent can see task responses as context.'),
      target_group_jid: z
        .string()
        .optional()
        .describe('(Main group only) JID of the group to schedule the task for.'),
    },
    async execute(args) {
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return `Error: Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`;
        }
      } else if (args.schedule_type === 'interval') {
        const ms = parseInt(args.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return `Error: Invalid interval: "${args.schedule_value}". Must be positive milliseconds.`;
        }
      } else if (args.schedule_type === 'once') {
        if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
          return `Error: Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`;
        }
        const date = new Date(args.schedule_value);
        if (isNaN(date.getTime())) {
          return `Error: Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`;
        }
      }

      const targetJid = ctx.isMain && args.target_group_jid ? args.target_group_jid : ctx.chatJid;

      const filename = writeIpcFile(TASKS_DIR, {
        type: 'schedule_task',
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode || 'group',
        exclude_from_history: args.exclude_from_history ?? true,
        targetJid,
        createdBy: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`;
    },
  });

  const list_tasks = tool({
    description:
      "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    args: {},
    async execute() {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

      try {
        if (!fs.existsSync(tasksFile)) {
          return 'No scheduled tasks found.';
        }

        const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        const tasks = ctx.isMain
          ? allTasks
          : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === ctx.groupFolder);

        if (tasks.length === 0) {
          return 'No scheduled tasks found.';
        }

        const formatted = tasks
          .map(
            (t: {
              id: string;
              prompt: string;
              schedule_type: string;
              schedule_value: string;
              status: string;
              next_run: string;
            }) =>
              `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
          )
          .join('\n');

        return `Scheduled tasks:\n${formatted}`;
      } catch (err) {
        return `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  const pause_task = tool({
    description: 'Pause a scheduled task. It will not run until resumed.',
    args: {
      task_id: z.string().describe('The task ID to pause'),
    },
    async execute(args) {
      writeIpcFile(TASKS_DIR, {
        type: 'pause_task',
        taskId: args.task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${args.task_id} pause requested.`;
    },
  });

  const resume_task = tool({
    description: 'Resume a paused task.',
    args: {
      task_id: z.string().describe('The task ID to resume'),
    },
    async execute(args) {
      writeIpcFile(TASKS_DIR, {
        type: 'resume_task',
        taskId: args.task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${args.task_id} resume requested.`;
    },
  });

  const cancel_task = tool({
    description: 'Cancel and delete a scheduled task.',
    args: {
      task_id: z.string().describe('The task ID to cancel'),
    },
    async execute(args) {
      writeIpcFile(TASKS_DIR, {
        type: 'cancel_task',
        taskId: args.task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${args.task_id} cancellation requested.`;
    },
  });

  const update_task = tool({
    description: 'Update fields of an existing scheduled task.',
    args: {
      task_id: z.string().describe('The task ID to update'),
      prompt: z.string().optional().describe('New prompt/instructions'),
      schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
      schedule_value: z.string().optional().describe('New schedule value'),
      context_mode: z.enum(['group', 'isolated']).optional().describe('New context mode'),
      exclude_from_history: z.boolean().optional().describe('Whether to hide task output from main chat'),
    },
    async execute(args) {
      const { task_id, ...updates } = args;
      const hasUpdates = Object.values(updates).some((v) => v !== undefined);
      if (!hasUpdates) {
        return 'Error: No fields to update.';
      }
      writeIpcFile(TASKS_DIR, {
        type: 'update_task',
        taskId: task_id,
        ...updates,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${task_id} update requested.`;
    },
  });

  const register_group = tool({
    description: `Register a new WhatsApp group so the agent can respond to messages there. Main group only.
Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
    args: {
      jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
      name: z.string().describe('Display name for the group'),
      folder: z
        .string()
        .describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    },
    async execute(args) {
      if (!ctx.isMain) {
        return 'Error: Only the main group can register new groups.';
      }

      writeIpcFile(TASKS_DIR, {
        type: 'register_group',
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        timestamp: new Date().toISOString(),
      });

      return `Group "${args.name}" registered. It will start receiving messages immediately.`;
    },
  });

  return {
    mcp__nanoclaw__send_message: send_message,
    mcp__nanoclaw__send_file: send_file,
    mcp__nanoclaw__schedule_task: schedule_task,
    mcp__nanoclaw__list_tasks: list_tasks,
    mcp__nanoclaw__pause_task: pause_task,
    mcp__nanoclaw__resume_task: resume_task,
    mcp__nanoclaw__cancel_task: cancel_task,
    mcp__nanoclaw__update_task: update_task,
    mcp__nanoclaw__register_group: register_group,
  };
}
