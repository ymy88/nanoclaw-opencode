---
name: rebuild-sdk
description: Rebuild Gemini CLI SDK and Core from local source, repack tarballs, rebuild container image, and restart the service. Use when gemini-cli source code has been modified and changes need to be deployed.
---

# Rebuild SDK

Rebuilds the Gemini CLI SDK and Core packages from local source, repacks them as tarballs, rebuilds the Docker container image, and restarts the service.

## When to Use

- After modifying any file in `gemini-cli/packages/core/` or `gemini-cli/packages/sdk/`
- After modifying `nanoclaw/container/agent-runner/` source code
- After modifying `nanoclaw/container/Dockerfile`

## Steps

1. Run the rebuild script from the project root (parent of `nanoclaw/`):
   ```bash
   cd <project-root> && ./rebuild-sdk.sh
   ```

2. After the script completes, restart the service:
   ```bash
   docker stop $(docker ps --filter name=nanoclaw-opencode --format '{{.Names}}') 2>/dev/null
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-opencode
   ```

3. If only the nanoclaw host code changed (not the container/SDK), skip the rebuild script and just:
   ```bash
   cd <project-root>/nanoclaw && npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-opencode
   ```

## Options

- `./rebuild-sdk.sh --no-container` — Build and pack tarballs only, skip Docker image rebuild.
