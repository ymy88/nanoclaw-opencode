# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations. **DB file lives at `store/messages.db`** (via `STORE_DIR` in `src/config.ts`) — NOT `data/`. It holds all tables: `sessions`, `messages`, `chats`, `message_summaries`, `host_tasks`, etc. The OpenCode session DBs are separate, per-group, at `data/sessions/{group}/.opencode/opencode/opencode-dev.db`. |
| `groups/{name}/INSTRUCTIONS.md` | Per-group agent instructions (isolated) |
| `groups/{name}/PERSONALITY.md` | Per-group personality definition |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw-opencode.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-opencode.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-opencode  # restart

# Linux (systemd)
systemctl --user start --no-block nanoclaw
systemctl --user stop --no-block nanoclaw
systemctl --user restart --no-block nanoclaw
sleep 2 && systemctl --user status nanoclaw   # check status after start/restart
```

## Subagents

Subagents only have write permission to the `tmp/` folder. When a subagent needs to produce output files, write them to `tmp/` first, then copy to the final destination from the main agent.

## Container Build Cache

For **agent-runner source / Dockerfile** changes, `./container/build.sh` needs **no prune** — buildkit invalidates the `COPY` layer on content change (verified: no-prune and pruned builds produce a byte-identical image id). Most past "rebuild didn't pick up my change / cache is stale" reports were a process artifact — checking the image before the build finished, or inspecting the still-running old container — not a Docker cache bug.

**The cure is verification, not pruning:** after a build, confirm the change is in the image with `docker run --rm --entrypoint sh nanoclaw-opencode-agent:latest -c "grep -c '<string from your edit>' /app/src/index.ts"` and check the image id actually changed. See the `rebuild-container` skill for the full workflow.

The OpenCode tarball in `deps/` carries a content hash in its filename (`opencode-<version>-<hash>.tgz`, written by `rebuild-sdk.sh`), so any content change yields a new filename and a guaranteed cache bust — no prune needed there either.
