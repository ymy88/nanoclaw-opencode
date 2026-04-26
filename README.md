# NanoClaw (Fork)

Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). Agent runtime replaced with [OpenCode](https://github.com/anomalyco/opencode) for multi-provider LLM support.

## What's New in This Fork

- **Multi-provider LLM** — supports 25+ providers (Anthropic, OpenAI, Google Vertex, etc.) via OpenCode + Vercel AI SDK
- **Agent runner** rewritten to use OpenCode's `SessionPrompt.prompt()` via Effect.ts
- **Runtime** switched from Node.js to Bun (both host and container)
- **Image generation** - Generate images using Gemini image models via Vertex AI and send them directly to chat (`/generate-image` skill)
- **Image understanding** - Upload images in Slack and the agent can see and respond to them
- **Custom personality** - Define your agent's character via a gitignored `PERSONALITY.md` — each installation gets its own persona
- **Slack channel** - Full Slack integration with image sending support

---

<p align="center">
  <img src="nanoclaw/assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

Using Claude Code, NanoClaw can dynamically rewrite its code to customize its feature set for your needs.

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
git clone https://github.com/ymy88/nanoclaw-opencode.git
cd nanoclaw-opencode
```

### Setup OpenCode (agent runtime)

```bash
git clone https://github.com/anomalyco/opencode.git
./rebuild-sdk.sh --no-container
```

### Setup NanoClaw

```bash
cd nanoclaw
bun install
claude   # then run /setup
```

## Structure

```
nanoclaw-opencode/
├── nanoclaw/       # The main project
├── opencode/       # OpenCode source (gitignored, clone separately)
└── rebuild-sdk.sh  # Build OpenCode bundle + container image
```

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

## What It Supports

- **Messenger I/O** - Message NanoClaw from your phone. Supports WhatsApp, Telegram, Discord, Slack, Signal and headless operation.
- **Isolated group context** - Each group has its own `AGENT.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run agents and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Apple Container (macOS) or Docker (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Aria`):

```
@Aria send an overview of the sales pipeline every weekday morning at 9am
@Aria review the git history for the past week each Friday and update the README if there's drift
@Aria every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Aria list all scheduled tasks across groups
@Aria pause the Monday briefing task
@Aria join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

## Requirements

- macOS or Linux
- [Bun](https://bun.sh)
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Slack/WhatsApp --> SQLite --> Polling loop --> Container (OpenCode) --> Response
```

Single Bun process. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

Key files:
- `nanoclaw/src/index.ts` - Orchestrator: state, message loop, agent invocation
- `nanoclaw/src/channels/slack.ts` - Slack connection, auth, send/receive
- `nanoclaw/src/ipc.ts` - IPC watcher and task processing
- `nanoclaw/src/router.ts` - Message formatting and outbound routing
- `nanoclaw/src/group-queue.ts` - Per-group queue with global concurrency limit
- `nanoclaw/src/container-runner.ts` - Spawns streaming agent containers
- `nanoclaw/src/task-scheduler.ts` - Runs scheduled tasks
- `nanoclaw/src/db.ts` - SQLite operations (messages, groups, sessions, state)

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](nanoclaw/docs/SECURITY.md) for the full security model.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## License

MIT
