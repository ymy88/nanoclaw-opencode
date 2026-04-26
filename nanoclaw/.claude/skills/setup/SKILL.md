---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (WhatsApp authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. scanning a QR code, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → note that WhatsApp auth exists, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (default, cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker (default)

### 3a-docker. Install Docker

- DOCKER=running → continue to 3b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed — Docker is the default. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 3d. Setup OpenCode Agent Runtime

Run `/setup-opencode` to clone the OpenCode repo, create the NanoClaw entry point and build script, build the bundle, and rebuild the container image.

This must complete before the service can start — the container image depends on the OpenCode bundle.

## 4. LLM Provider & Model Configuration

If HAS_ENV=true from step 2, read `.env` and check for existing provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLOUD_PROJECT`, etc.). If present, confirm with user: keep or reconfigure?

NanoClaw uses OpenCode which supports multiple LLM providers. The user picks a primary provider and model.

### 4a. Choose Provider

AskUserQuestion: Which LLM provider? Options:
- Google Vertex AI (Gemini + Claude on Vertex)
- Anthropic (Claude direct API)
- OpenAI (GPT models)
- OpenRouter (access to multiple providers via one API key)
- Other (OpenAI-compatible endpoint)

### 4b. Provider Setup

**Google Vertex AI:**
1. User needs a GCP project with Vertex AI API enabled
2. Create a service account with `Vertex AI User` role
3. Download the JSON key file
4. Ask for: key file path, GCP project ID, location (default: `global`)
5. Add to `.env`:
```
OPENCODE_PROVIDER=google-vertex
OPENCODE_MODEL=gemini-3.1-pro-preview
GOOGLE_CLOUD_PROJECT=<project-id>
GOOGLE_CLOUD_LOCATION=<location>
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```
6. Verify: `test -f <path> && echo OK || echo NOT FOUND`
7. Note: `GOOGLE_APPLICATION_CREDENTIALS` is mounted read-only into the container at `/tmp/gcloud-credentials.json`. Also used for image generation via Gemini.

AskUserQuestion: Which model? Options:
- gemini-3.1-pro-preview (recommended)
- gemini-2.5-flash
- claude-sonnet-4-20250514 (via Vertex Anthropic)

If user picks a Claude model on Vertex, set `OPENCODE_PROVIDER=google-vertex-anthropic`.

**Anthropic:**
1. Ask user for their API key
2. Add to `.env`:
```
OPENCODE_PROVIDER=anthropic
OPENCODE_MODEL=claude-sonnet-4-20250514
ANTHROPIC_API_KEY=<key>
```

AskUserQuestion: Which model? Options:
- claude-sonnet-4-20250514 (recommended)
- claude-opus-4-20250514
- claude-haiku-4-20250414

**OpenAI:**
1. Ask user for their API key
2. Add to `.env`:
```
OPENCODE_PROVIDER=openai
OPENCODE_MODEL=gpt-4o
OPENAI_API_KEY=<key>
```

AskUserQuestion: Which model? Options:
- gpt-4o (recommended)
- gpt-4o-mini
- o3

**OpenRouter:**
1. Ask user for their OpenRouter API key (from https://openrouter.ai/keys)
2. Add to `.env`:
```
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=anthropic/claude-sonnet-4
OPENROUTER_API_KEY=<key>
```

AskUserQuestion: Which model? (User can type any OpenRouter model ID)

**Other (OpenAI-compatible):**
1. Ask for: base URL, API key, model name
2. Add to `.env`:
```
OPENCODE_PROVIDER=openai-compatible
OPENCODE_MODEL=<model-name>
OPENAI_API_KEY=<key>
OPENAI_BASE_URL=<base-url>
```

### 4c. Image Generation via Vertex AI (Optional)

If `GOOGLE_APPLICATION_CREDENTIALS` was already set in 4b (Vertex AI provider), image generation is automatically available.

If the user chose a non-Google provider, ask:

AskUserQuestion: Enable image generation via Google Vertex AI? (Requires a GCP project)

**If yes:** Follow the Vertex AI setup from 4b (service account, JSON key file). Add `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_PROJECT` to `.env` (the provider settings stay as configured).

**If no:** Skip — image generation won't be available, but everything else works.

## 4c. Agent Personality (Optional)

The agent's personality is defined in `groups/global/PERSONALITY.md`. This file is gitignored so each installation can have its own character.

AskUserQuestion: Would you like to set up a custom personality for your agent? Options: Yes, customize / No, use default (helpful assistant named Andy)

**If yes:** Ask the user to describe their agent's personality — name, traits, speaking style, relationship to the user. Also ask:

AskUserQuestion: What timezone should the agent use? (e.g., Asia/Shanghai, America/New_York, Europe/London)

Write the same content to both `groups/global/PERSONALITY.md` and `groups/main/PERSONALITY.md` using the storyteller framing pattern, with the timezone at the top:

```markdown
# [Name]

**Timezone**: [timezone]

You are a creative storyteller writing dialogue as [Name], a [description]. Every response you write is from [Name]'s perspective — [traits]. Stay in character. Never break the fourth wall. Write only what [Name] would say.
```

**If no:** Create a default `groups/global/PERSONALITY.md` and `groups/main/PERSONALITY.md` with:

```markdown
# Andy

You are Andy, a helpful and friendly assistant. You are knowledgeable, concise, and eager to help with any task. You speak in a natural, conversational tone.
```

The CLAUDE.md files use `@PERSONALITY.md` to include the personality directly, so the file must exist. The user can edit it later at any time.

## 5. WhatsApp Authentication

AskUserQuestion: Options: Set up WhatsApp / Use Slack instead / Skip, do it later

**Use Slack instead:** Run `/add-slack` to configure Slack, then skip to step 6.

**Skip, do it later:** Skip to step 6. The user can set up a channel later.

**Set up WhatsApp:**

If HAS_AUTH=true, confirm: keep or re-authenticate?

**Choose auth method based on environment (from step 2):**

If IS_HEADLESS=true AND IS_WSL=false → AskUserQuestion: Pairing code (recommended) vs QR code in terminal?
Otherwise (macOS, desktop Linux, or WSL) → AskUserQuestion: QR code in browser (recommended) vs pairing code vs QR code in terminal?

- **QR browser:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser` (Bash timeout: 150000ms)
- **Pairing code:** Ask for phone number first. `npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone NUMBER` (Bash timeout: 150000ms). Display PAIRING_CODE.
- **QR terminal:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-terminal`. Tell user to run `npm run auth` in another terminal.

**If failed:** qr_timeout → re-run. logged_out → delete `store/auth/` and re-run. 515 → re-run. timeout → ask user, offer retry.

## 6. Configure Trigger and Channel Type

Get bot's WhatsApp number: `node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Shared number or dedicated? → AskUserQuestion: Trigger word? → AskUserQuestion: Main channel type?

**Shared number:** Self-chat (recommended) or Solo group
**Dedicated number:** DM with bot (recommended) or Solo group with bot

## 7. Sync and Select Group (If Group Channel)

**Personal chat:** JID = `NUMBER@s.whatsapp.net`
**DM with bot:** Ask for bot's number, JID = `NUMBER@s.whatsapp.net`

**Group:**
1. `npx tsx setup/index.ts --step groups` (Bash timeout: 60000ms)
2. BUILD=failed → fix TypeScript, re-run. GROUPS_IN_DB=0 → check logs.
3. `npx tsx setup/index.ts --step groups -- --list` for pipe-separated JID|name lines.
4. Present candidates as AskUserQuestion (names only, not JIDs).

## 8. Register Channel

Run `npx tsx setup/index.ts --step register -- --jid "JID" --name "main" --trigger "@TriggerWord" --folder "main"` plus `--no-trigger-required` if personal/DM/solo, `--assistant-name "Name"` if not Andy.

## 9. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 10. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw-opencode.plist`
- Linux: `systemctl --user stop nanoclaw-opencode` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 11. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-opencode` (macOS) or `systemctl --user restart nanoclaw-opencode` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 10
- CREDENTIALS=missing → re-run step 4
- WHATSAPP_AUTH=not_found → re-run step 5
- REGISTERED_GROUPS=0 → re-run steps 7-8
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 10), missing `.env` (step 4), missing auth (step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw-opencode.log`.

**WhatsApp disconnected:** `npm run auth` then rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw-opencode` (macOS) or `systemctl --user restart nanoclaw-opencode` (Linux).

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw-opencode.plist` | Linux: `systemctl --user stop nanoclaw-opencode`
