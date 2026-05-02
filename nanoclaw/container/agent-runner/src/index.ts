/**
 * NanoClaw Agent Runner (OpenCode)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted.
 */

import fs from 'fs';
import path from 'path';
import { bootstrap, AppRuntime, Session, SessionPrompt } from 'opencode';
import type { IpcContext } from './nanoclaw-tools.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  replyThreadTs?: string;
  threadKey?: string;
  senderTimezone?: string;
  providerID?: string;
  modelID?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- Instruction loading ---

function loadFileWithFallback(filename: string): string {
  const groupPath = `/workspace/group/${filename}`;
  if (fs.existsSync(groupPath)) {
    return fs.readFileSync(groupPath, 'utf-8');
  }
  const globalPath = `/workspace/global/${filename}`;
  if (fs.existsSync(globalPath)) {
    return fs.readFileSync(globalPath, 'utf-8');
  }
  return '';
}

function loadInstructions(): string {
  const personality = loadFileWithFallback('PERSONALITY.md');
  const agent = loadFileWithFallback('INSTRUCTIONS.md');

  const parts: string[] = [];
  if (personality) parts.push(personality);
  if (agent) parts.push(agent);

  return parts.join('\n\n');
}

// --- IPC input handling ---

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          log(`Container←Host: received IPC message (file=${file}, ${data.text.length} chars)`);
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  log('Container: waiting for next IPC message...');
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        log('Container: _close sentinel found while waiting');
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        log(`Container: received ${messages.length} message(s) while waiting`);
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// --- Result cleaning ---

function cleanResult(text: string): string {
  let result = text;
  result = result.replace(/<internal>[\s\S]*?<\/internal>/g, '');
  const finalSeparatorIdx = result.lastIndexOf('|FINAL|');
  if (finalSeparatorIdx !== -1) {
    result = result.slice(finalSeparatorIdx + '|FINAL|'.length);
  }
  return result.trim();
}

// --- Main ---

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
    log(`Input summary: isMain=${containerInput.isMain}, isScheduledTask=${containerInput.isScheduledTask ?? false}, sessionId=${containerInput.sessionId || 'new'}, threadKey=${containerInput.threadKey || 'none'}, assistantName=${containerInput.assistantName || 'default'}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Set secrets as env vars
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    process.env[key] = value;
  }

  // Configure OpenCode via environment
  const providerID = containerInput.providerID || process.env.OPENCODE_PROVIDER || 'anthropic';
  const modelID = containerInput.modelID || process.env.OPENCODE_MODEL || 'claude-sonnet-4-20250514';
  process.env.OPENCODE_PURE = '1'; // Disable external plugins
  process.env.OPENCODE_CLIENT = 'sdk';

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Load instructions for system prompt
  const instructions = loadInstructions();

  // Write IPC context so the tool module can read it at import time
  const ipcContext: IpcContext = {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isMain: containerInput.isMain,
    replyThreadTs: containerInput.replyThreadTs,
  };
  const ipcContextPath = '/workspace/ipc/context.json';
  fs.writeFileSync(ipcContextPath, JSON.stringify(ipcContext));

  // Write NanoClaw tools as an OpenCode tool file for auto-discovery
  const toolDir = '/workspace/group/.opencode/tool';
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolDir, 'nanoclaw.js'),
    `import { createNanoclawTools } from '/app/src/nanoclaw-tools.js';
import { z } from '/app/node_modules/opencode/nanoclaw.js';
import fs from 'fs';
const ctx = JSON.parse(fs.readFileSync('/workspace/ipc/context.json', 'utf-8'));
const tools = createNanoclawTools(ctx, z);
export const mcp__nanoclaw__send_message = tools.mcp__nanoclaw__send_message;
export const mcp__nanoclaw__send_file = tools.mcp__nanoclaw__send_file;
export const mcp__nanoclaw__schedule_task = tools.mcp__nanoclaw__schedule_task;
export const mcp__nanoclaw__list_tasks = tools.mcp__nanoclaw__list_tasks;
export const mcp__nanoclaw__pause_task = tools.mcp__nanoclaw__pause_task;
export const mcp__nanoclaw__resume_task = tools.mcp__nanoclaw__resume_task;
export const mcp__nanoclaw__cancel_task = tools.mcp__nanoclaw__cancel_task;
export const mcp__nanoclaw__update_task = tools.mcp__nanoclaw__update_task;
export const mcp__nanoclaw__register_group = tools.mcp__nanoclaw__register_group;
`,
  );

  // Configure OpenCode via environment
  const configContent = {
    provider: {
      [providerID]: { enabled: true },
    },
    agent: {
      build: {
        prompt: instructions || 'You are an AI assistant. Use the tools available to you to help the user.',
      },
    },
  };
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(configContent);

  // Time formatting
  const userTz = containerInput.senderTimezone || process.env.TZ || 'UTC';
  const prependTime = (text: string) => {
    const now = new Date();
    const formatted = now.toLocaleString('sv-SE', {
      timeZone: userTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const weekday = now.toLocaleString('en-US', { timeZone: userTz, weekday: 'long' });
    return `[Current time: ${weekday} ${formatted} (${userTz})]\n\n${text}`;
  };

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Load task-specific context file
  if (!containerInput.sessionId && containerInput.isScheduledTask) {
    const taskSpecMatch = containerInput.prompt.match(/scheduled-task-specs\/([^/.]+)/);
    if (taskSpecMatch) {
      const contextFile = `/workspace/group/scheduled-task-specs/${taskSpecMatch[1]}.context.md`;
      if (fs.existsSync(contextFile)) {
        const context = fs.readFileSync(contextFile, 'utf-8');
        log(`Loaded task context file: ${contextFile} (${context.length} chars)`);
        prompt = `<task-context>\n${context}\n</task-context>\n\n${prompt}`;
        fs.unlinkSync(contextFile);
        log('Deleted task context file after loading');
      }
    }
  }

  // Load conversation context from compacted session
  const contextFilePath = '/workspace/group/.conversation-context.md';
  if (!containerInput.sessionId && fs.existsSync(contextFilePath)) {
    const contextContent = fs.readFileSync(contextFilePath, 'utf-8');
    log(`Found conversation context file (${contextContent.length} chars)`);
    prompt = `<conversation-context>\n${contextContent}\n</conversation-context>\n\n${prompt}`;
    fs.unlinkSync(contextFilePath);
    log('Deleted conversation context file after loading');
  }

  prompt = prependTime(prompt);

  log(`Agent configured: provider=${providerID}, model=${modelID}, tools=9, instructions=${instructions.length} chars`);

  // Bootstrap OpenCode and run agent loop
  log('Calling bootstrap()...');
  await bootstrap('/workspace/group', async () => {
    log('Bootstrap callback entered');
    let sessionId = containerInput.sessionId;

    // Create or resume session
    if (!sessionId) {
      log('Creating new session...');
      const session = await AppRuntime.runPromise(
        Session.Service.use((svc) => svc.create()),
      );
      sessionId = session.id;
      log(`Created new session: ${sessionId}`);
    } else {
      log(`Resuming session: ${sessionId}`);
    }

    // Query loop
    let queryCount = 0;
    try {
      while (true) {
        queryCount++;
        log(`Starting query #${queryCount} (session: ${sessionId})...`);
        log(`Prompt (${prompt.length} chars): ${prompt.slice(0, 200)}...`);

        let closedDuringQuery = false;
        let ipcPolling = true;
        const pollIpc = () => {
          if (!ipcPolling) return;
          if (shouldClose()) {
            log('Close sentinel detected during query');
            closedDuringQuery = true;
            ipcPolling = false;
            return;
          }
          setTimeout(pollIpc, IPC_POLL_MS);
        };
        setTimeout(pollIpc, IPC_POLL_MS);

        // Send prompt via OpenCode
        log(`Calling SessionPrompt.prompt()...`);
        const promptStart = Date.now();
        const response = await AppRuntime.runPromise(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({
              sessionID: sessionId!,
              model: { providerID, modelID },
              parts: [{ type: 'text', text: prompt }],
            }),
          ),
        );
        log(`SessionPrompt.prompt() returned in ${Date.now() - promptStart}ms`);

        ipcPolling = false;

        // Extract text from response parts
        const resultText = response.parts
          .filter((p: { type: string }) => p.type === 'text')
          .map((p: { type: string; text?: string }) => p.text || '')
          .join('');

        const cleaned = cleanResult(resultText);
        log(`Query result: ${resultText.length} chars → cleaned: ${cleaned.length} chars`);

        writeOutput({
          status: 'success',
          result: cleaned || null,
          newSessionId: sessionId,
        });

        if (closedDuringQuery) {
          log('Close sentinel consumed during query, breaking loop');
          break;
        }

        writeOutput({ status: 'success', result: null, newSessionId: sessionId });

        log('Query ended, waiting for next IPC message...');

        const waitStart = Date.now();
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log(`Close sentinel received after ${Date.now() - waitStart}ms wait, breaking loop`);
          break;
        }

        log(`Got new message (${nextMessage.length} chars) after ${Date.now() - waitStart}ms wait`);
        prompt = prependTime(nextMessage);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Agent error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage,
      });
      process.exit(1);
    }

    log(`Loop exited after ${queryCount} queries, returning from bootstrap callback`);
  });

  log('bootstrap() returned, main() completing');
}

log('Calling main()...');
main().then(() => {
  log('main() resolved, exiting');
  process.exit(0);
}).catch((err) => {
  log(`main() rejected: ${err}`);
  process.exit(1);
});
