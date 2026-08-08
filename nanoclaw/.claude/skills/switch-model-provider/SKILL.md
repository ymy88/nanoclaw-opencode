---
name: switch-model-provider
description: Use when changing which LLM model or provider the NanoClaw agent runs on — swapping models (qwen3.8-max, kimi-k2.6, minimax-m3, glm, deepseek…), switching between a models.dev provider (opencode-go, alibaba-cn / 阿里百炼 / DashScope) and a custom OpenAI-compatible provider (火山方舟 / Volcano Ark / ark-coding-plan), or when a provider account runs out of credit and you must move. Also covers which API-key env var a provider needs. Keywords: OPENCODE_MODEL, OPENCODE_PROVIDER, OPENCODE_API_KEY, DASHSCOPE_API_KEY, provider, model, qwen, alibaba, ark, volcano, ModelNotFound, 401 unauthorized.
---

# Switch Model / Provider

## Overview

The agent's model/provider lives in `nanoclaw/.env` (`OPENCODE_PROVIDER` + `OPENCODE_MODEL`), read into `DEFAULT_PROVIDER`/`DEFAULT_MODEL` at **orchestrator startup** (`src/config.ts`) and passed to every container run (`src/index.ts`, `src/task-scheduler.ts`). The catalog resolves **live from models.dev** at runtime, so model ids missing from the committed `models-snapshot.js` still work.

Key fact: the container runs its **own** OpenCode config (built in `container/agent-runner/src/index.ts`, as `{ provider: { [id]: { enabled: true } } }`) and does **NOT** read your host `~/.config/opencode/opencode.json`.

**No container rebuild is needed for any model/provider switch.** Two provider kinds, different steps:

## Case A — built-in models.dev provider (e.g. `opencode-go`, `alibaba-cn`)

1. **Look up the provider's real id and its API-key env var name** — do NOT guess either:
   ```bash
   curl -s https://models.dev/api.json > /tmp/models.json
   jq -r 'keys[]' /tmp/models.json | grep -i <vendor>          # e.g. "alibaba china" → alibaba-cn, not alibaba-china
   jq '.["<id>"] | {api, npm, env}' /tmp/models.json           # env[] = the key var name
   jq -r '.["<id>"].models | keys[]' /tmp/models.json | grep <model>
   ```
2. **Pre-flight the key** against the provider directly, before touching anything:
   ```bash
   set -a; . ./.env; set +a
   curl -s -o /tmp/probe.json -w 'http=%{http_code}\n' <api>/chat/completions \
     -H "Authorization: Bearer ${!KEYVAR}" -H 'Content-Type: application/json' \
     -d '{"model":"<model>","messages":[{"role":"user","content":"say OK"}],"max_tokens":8}'
   ```
3. Edit `.env`: `OPENCODE_PROVIDER=<id>`, `OPENCODE_MODEL=<model>`, and `<THAT_ENV_VAR>=<key>`.
4. Restart once (see Restart safely).

models.dev supplies baseURL/npm; `enabled:true` + the key is enough.

> **`OPENCODE_API_KEY` is NOT a generic NanoClaw field.** There is no such symbol anywhere in
> the codebase (grep `config.ts`, `container-runner.ts`, `agent-runner/`). The real mechanism:
> `readAllEnvFile()` injects the **entire** `.env` into the container's `process.env`
> (`container/agent-runner/src/index.ts`, "Set secrets as env vars"), and OpenCode then reads
> whichever variable models.dev declares in that provider's `env` array. `opencode-go` declares
> `OPENCODE_API_KEY`, which is the only reason it looks generic. `alibaba-cn` declares
> `DASHSCOPE_API_KEY`. Put the key under the name step 1 gave you, or auth silently fails.

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
| the provider's API-key var (`OPENCODE_API_KEY`, `DASHSCOPE_API_KEY`, …) / other secrets | every container spawn | No |
| custom-provider disk config file | every container spawn | No (restart only picks up the `.env` provider change) |
| `groups/<g>/PERSONALITY.md` · `INSTRUCTIONS.md` | every container spawn | No (next message; `compact-history` for a clean start) |

## Common mistakes

- **`ModelNotFound` / provider missing** for a custom provider → the disk config isn't in that group's `data/sessions/<group>/.opencode/opencode/opencode.json`, or the id in `.env` doesn't match the provider key in the file.
- **`401` / `unauthorized` right after a Case A switch** → the key is in `.env` under the wrong variable name. It must match the provider's models.dev `env` entry, not `OPENCODE_API_KEY`. Check: `curl -s https://models.dev/api.json | jq '.["<id>"].env'`.
- **Guessed the provider id** → the human name and the id differ ("Alibaba (China)" is `alibaba-cn`, not `alibaba-china`). Always list ids from models.dev first.
- **Change didn't apply** → forgot to restart (provider/model read only at startup).
- **Edited host `~/.config/opencode/opencode.json`** expecting the container to use it → it doesn't; the container has its own config.
- **Never put API keys in this skill file** — keys belong in `.env` (Case A) or the per-group disk config under `data/` (Case B), both gitignored.
- **Don't rebuild the container** for a switch — it's never needed here.
