# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Style

When making code changes, always describe what the existing code does before proposing a fix. Don't jump to adding new code without first stating: "Line X does Y, so the fix is Z." If you can't point to the specific line, you haven't read enough yet.

## Repository Structure

| Directory | Project | Language | Purpose |
|-----------|---------|----------|---------|
| `nanoclaw/` | NanoClaw | TypeScript/Bun | Personal AI assistant running agents in isolated containers |
| `opencode/` | OpenCode | TypeScript/Bun | Multi-provider LLM agent runtime (gitignored, clone separately) |

Each project has its own dependencies and build system. Always `cd` into the correct subdirectory before running commands.

---

## NanoClaw (`nanoclaw/`)

Single Bun process that connects to Slack/WhatsApp, routes messages to OpenCode running in isolated containers. Each group gets its own container, filesystem, and instructions (`groups/{name}/INSTRUCTIONS.md` + `groups/{name}/PERSONALITY.md`).

### Commands

```bash
bun run dev          # Run with hot reload
bun run start        # Run from source
bun test             # Run Vitest suite
bun run typecheck    # tsc --noEmit
bun run format       # Prettier
./container/build.sh # Rebuild agent container image
bun run setup        # First-time setup CLI
```

### Architecture

```
Messages (Slack/WhatsApp) → src/index.ts (orchestrator)
  → src/router.ts (filtering, formatting) → src/group-queue.ts (per-group concurrency)
  → src/container-runner.ts (spawns container) → container/agent-runner/ (OpenCode)
  → src/ipc.ts (filesystem-based IPC from container) → response back to channel
```

Key: `src/db.ts` (SQLite via bun:sqlite), `src/config.ts` (trigger/paths/intervals), `src/task-scheduler.ts` (cron), `src/channels/slack.ts`, `src/channels/whatsapp.ts`.

Container skills in `container/skills/` provide instructions (web-search, generate-image, agent-browser, etc.) to agents. IPC tools (send_message, schedule_task, etc.) are OpenCode plugin tools defined in `container/agent-runner/src/nanoclaw-tools.ts`.

---

## OpenCode Dependencies

The NanoClaw agent container uses OpenCode as its LLM runtime. OpenCode is not published to npm — it is built from the local `opencode/` source and packed as a tarball in `nanoclaw/container/deps/`.

To rebuild the tarball (needed when updating OpenCode source):

```bash
./rebuild-sdk.sh           # Build OpenCode, pack tarball, rebuild container
./rebuild-sdk.sh --no-container  # Build + pack only, skip container rebuild
```

The build script (`opencode/packages/opencode/script/build-nanoclaw.ts`) bundles OpenCode into a single minified JS file with all migrations embedded.
