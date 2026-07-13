---
name: switch-model-provider
description: Use when changing which LLM model or provider the NanoClaw agent runs on — swapping models (kimi-k2.6, minimax-m3, qwen3.7-plus, glm, deepseek…), switching between a models.dev provider (opencode-go) and a custom OpenAI-compatible provider (火山方舟 / Volcano Ark / ark-coding-plan), or when a provider account runs out of credit and you must move. Keywords: OPENCODE_MODEL, OPENCODE_PROVIDER, provider, model, ark, volcano, ModelNotFound.
---

# Switch Model / Provider

## Overview

The agent's model/provider lives in `nanoclaw/.env` (`OPENCODE_PROVIDER` + `OPENCODE_MODEL`), read into `DEFAULT_PROVIDER`/`DEFAULT_MODEL` at **orchestrator startup** (`src/config.ts`) and passed to every container run (`src/index.ts`, `src/task-scheduler.ts`). The catalog resolves **live from models.dev** at runtime, so model ids missing from the committed `models-snapshot.js` still work.

Key fact: the container runs its **own** OpenCode config (built in `container/agent-runner/src/index.ts`, as `{ provider: { [id]: { enabled: true } } }`) and does **NOT** read your host `~/.config/opencode/opencode.json`.

**No container rebuild is needed for any model/provider switch.** Two provider kinds, different steps:

## Case A — built-in models.dev provider (e.g. `opencode-go`)

1. Edit `.env`: `OPENCODE_PROVIDER=<id>`, `OPENCODE_MODEL=<model>`, `OPENCODE_API_KEY=<key>`.
2. Restart once (see Restart safely).

That's it — models.dev supplies baseURL/npm; `enabled:true` + the key is enough.

## Case B — custom OpenAI-compatible provider (e.g. `ark-coding-plan` / 火山方舟 / Volcano Ark)

The container only enables the provider by id, so a custom provider's `npm`/`baseURL`/`apiKey`/`models` must be supplied via a disk config that OpenCode **deep-merges** with `OPENCODE_CONFIG_CONTENT` (`config.ts` loads `$XDG_CONFIG_HOME/opencode/opencode.json` unconditionally, then merges). In the container `XDG_CONFIG_HOME=/home/bun/.opencode`, mounted per-group from `data/sessions/<group>/.opencode/`.

1. Grab the provider block from your host config `~/.config/opencode/opencode.json` (`.provider["<id>"]`).
2. Write it to **each active group's** config file (`data/sessions/<group>/.opencode/opencode/opencode.json`):
   ```bash
   cd nanoclaw
   for g in main war-room; do
     jq --argjson p "$(jq '.provider' ~/.config/opencode/opencode.json)" -n \
       '{"$schema":"https://opencode.ai/config.json","provider":{"ark-coding-plan":$p["ark-coding-plan"]}}' \
       > "data/sessions/$g/.opencode/opencode/opencode.json"
   done
   ```
3. Edit `.env`: `OPENCODE_PROVIDER=<id>`, `OPENCODE_MODEL=<model>`. (The apiKey lives in the disk config, NOT in `OPENCODE_API_KEY`.)
4. Restart once.

**Caveats:** the disk file is **per-group** and not in git; a brand-new group needs its own copy. It survives `compact-history` (which deletes only `*.db`). The robust alternative — inject an `OPENCODE_PROVIDER_CONFIG` env var merged in `agent-runner` (centralized, all groups, in `.env`) — needs a one-time container rebuild.

## Restart safely (avoid the Slack storm)

Provider/model are read only at startup, so a restart is required:
`launchctl kickstart -k gui/$(id -u)/com.nanoclaw-opencode`

- ONE clean restart of a healthy process is fine. **Do NOT bounce it repeatedly.**
- Rapid / crash-loop restarts trip Slack Socket Mode's per-app connection limit → `Slack app.start() timed out` → self-sustaining crash loop. Tokens/network are fine (verify: `curl -sX POST -H "Authorization: Bearer $SLACK_APP_TOKEN" https://slack.com/api/apps.connections.open` → `ok:true`).
- Recovery: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw-opencode.plist`, wait **~3 min** for Slack to reap zombie connections, then `launchctl load …` **once**. Confirm `Connected to Slack` in `logs/nanoclaw-opencode.log`.

## Clean session for a group (optional, for voice/personality tests)

The new model applies on the next message, but the existing session's replies anchor its style. For a clean test, reset the group's session:
`cd .claude/skills/compact-history && uv run compact.py <group> --days 60` — kill the group's docker container first. This resets only the session DB; it does **NOT** restart Slack.

## Verify

Send a message, then confirm from the live container:
```bash
C=$(docker ps --format '{{.Names}}' | grep nanoclaw-opencode-<group> | head -1)
docker logs "$C" 2>&1 | grep "Agent configured"   # → provider=<id>, model=<model>
```
Watch `logs/nanoclaw-opencode.log` for `Agent output` + `Slack message sent` (success) or `ModelNotFound` / `401` / `unauthorized` / `InstanceRef` / `timed out` (failures).

## What takes effect when

| Change | When read | Restart needed? |
|---|---|---|
| `OPENCODE_PROVIDER` / `OPENCODE_MODEL` | orchestrator startup | **Yes** |
| `OPENCODE_API_KEY` / other secrets | every container spawn | No |
| custom-provider disk config file | every container spawn | No (restart only picks up the `.env` provider change) |
| `groups/<g>/PERSONALITY.md` · `INSTRUCTIONS.md` | every container spawn | No (next message; `compact-history` for a clean start) |

## Common mistakes

- **`ModelNotFound` / provider missing** for a custom provider → the disk config isn't in that group's `data/sessions/<group>/.opencode/opencode/opencode.json`, or the id in `.env` doesn't match the provider key in the file.
- **Change didn't apply** → forgot to restart (provider/model read only at startup).
- **Edited host `~/.config/opencode/opencode.json`** expecting the container to use it → it doesn't; the container has its own config.
- **Never put API keys in this skill file** — keys belong in `.env` (Case A) or the per-group disk config under `data/` (Case B), both gitignored.
- **Don't rebuild the container** for a switch — it's never needed here.
