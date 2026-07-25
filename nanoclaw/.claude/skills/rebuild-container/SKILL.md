---
name: rebuild-container
description: Rebuild ONLY the NanoClaw agent container image after changing container/agent-runner source or the Dockerfile (no OpenCode source change). Runs the build in the background with a correctly-sized Monitor timeout so the monitor does NOT time out mid-build, verifies the new code is actually inside the image (the step that prevents "cache problem" misdiagnoses), and swaps the long-lived container. Triggers on "rebuild container", "rebuild the agent image", "./container/build.sh", or after editing container/agent-runner/src/*.
---

# Rebuild Agent Container

Rebuilds the `nanoclaw-opencode-agent:latest` image from `nanoclaw/container/`.

Use this when you changed **`container/agent-runner/src/*`** or **`container/Dockerfile`** and did **NOT** change OpenCode source. If OpenCode source changed, use `rebuild-sdk` (that repacks the opencode tarball) instead — this skill does not.

No service (launchd/Slack) restart is needed. The orchestrator keeps running; a fresh container spawns from the new image on the next message once the old long-lived container is stopped (last step).

## Do NOT prune by default

Measured, controlled test (2026-07-26): a plain `./container/build.sh` **with no prune** correctly picked up an `agent-runner/src` change, and produced a **byte-identical image id** to the same source built *with* `docker buildx prune -af`. buildkit invalidates the `COPY agent-runner/ ./` layer on content change (standard behavior); the earlier apt/chromium layers stay cached, so a source-only rebuild finishes in **seconds**, not 10–15 min.

So: **skip prune for source/Dockerfile changes.** Most past "rebuild didn't pick up my change / cache is stale" reports were a *process* artifact — checking the image too early (before the build finished), inspecting the still-running old container, or trusting a false completion signal — NOT a real Docker cache bug. The cure is Step 4 (verify inside the image), not pruning.

Prune (`docker buildx prune -af`) only when: you changed the **opencode tarball in `deps/`** (same-filename replacement — not yet independently tested, prune is the cautious choice), or Step 4 shows the change genuinely missing from a completed build.

## Steps

Run from `nanoclaw/`. **Use a fresh log file per run** (never reuse a fixed path — a Monitor can match a stale `Build complete!` from a previous build and fire an instant false done):

```bash
LOG=$(mktemp)          # BSD/macOS-safe: no template suffix. Gives a guaranteed-empty unique file.
```

### 1. Build in the background

```bash
nohup ./container/build.sh > "$LOG" 2>&1 &
echo "build pid=$! log=$LOG"
```

Run with the Bash tool's `run_in_background`. The `&`-wrapper returns exit 0 immediately — that is NOT the build finishing. If you launch the wrapper itself in background, read back the resolved `$LOG` from the task output before arming the Monitor.

### 2. Monitor with a right-sized timeout

- **Source/Dockerfile change, no prune (normal case):** the build is fast. Monitor `timeout_ms: 600000` (10 min) is ample; it often finishes before you even arm the Monitor — that's fine, just go to Step 3.
- **Cold/pruned build (deps tarball, or apt layer changed):** re-downloads apt/chromium — measured >600s and <~900s. Use `timeout_ms: 1800000` (30 min) so one arm covers it. Max the Monitor tool allows is 3,600,000 ms.

Monitor command (covers success AND failure so silence never means "done"):

```bash
until grep -qE "Build complete!|^ERROR|error:|^failed|exit code [1-9]|Cannot find|no such" "$LOG" 2>/dev/null; do sleep 5; done
grep -qE "Build complete!" "$LOG" && echo BUILD_DONE || echo "BUILD_FAIL: $(grep -iE 'error|failed|exit code|cannot' "$LOG" | tail -3)"
```

### 3. Confirm the build really finished (don't trust the signal alone)

```bash
ps aux | grep -E 'build.sh|docker build' | grep -v grep | wc -l   # expect 0
grep -c 'Build complete!' "$LOG"                                   # expect 1
```

### 4. Verify the change is INSIDE the image — the key anti-"cache" step

agent-runner source lives at **`/app/src`** in the image. Grep for a string unique to your edit, and confirm the image id changed:

```bash
docker images nanoclaw-opencode-agent:latest --format '{{.ID}} {{.CreatedSince}}'
docker run --rm --entrypoint sh nanoclaw-opencode-agent:latest -c "grep -c '<a-string-from-your-edit>' /app/src/index.ts"   # expect ≥1
```

If the string is present → done, the rebuild worked (no prune needed). If genuinely absent on a *completed* build → then and only then consider prune and rebuild.

### 5. Swap the long-lived container

The per-group container is long-lived (it waits on IPC) and keeps running the OLD image until stopped. Stopping it lets the next message spawn a fresh one from the new image (the orchestrator auto-removes it on exit).

```bash
for C in $(docker ps --format '{{.Names}}' | grep '^nanoclaw-opencode-'); do docker stop "$C" >/dev/null && echo "stopped $C"; done
```

### 6. Verify at runtime (after the next message)

```bash
C=$(docker ps --format '{{.Names}}' | grep '^nanoclaw-opencode-' | head -1)
docker inspect "$C" --format '{{.Image}}'   # should match the new image id from Step 4
docker logs "$C" 2>&1 | tail -20
```

## Notes

- **Verify (Step 4), don't prune.** Confirming the bytes are in the image is faster and more reliable than a blanket prune, and it catches the real failure modes (checked too early / wrong container / false signal).
- Fresh `$LOG` per run + confirming the build process actually exited (Step 3) together kill the false-`BUILD_DONE` race.
- This does not touch `.env`, sessions, or the OpenCode tarball.
