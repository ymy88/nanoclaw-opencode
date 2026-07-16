---
name: compact-history
description: Reset a group's agent session to apply personality changes. Uses stored daily summaries for past days, only summarizes today's messages. Use when PERSONALITY.md was updated but the agent's behavior hasn't changed.
---

# Compact History

Resets a group's agent session so personality and style changes take effect. Uses pre-computed daily summaries from the database — only today's messages are summarized via AI. Past days are loaded from stored summaries (populated nightly by the auto-compact task).

## Usage

The user will specify which group to compact (e.g., "compact history for main", "reset the war-room session").

## Steps

1. Identify the group folder name from the user's request
2. Run (from the project root):

   ```bash
   uv run --project .claude/skills/compact-history .claude/skills/compact-history/compact.py <group-folder>
   ```

3. Optionally pass `--days <N>` to control how many days of stored summaries to include (default: 60)
4. If a container is active, tell the user to wait and try again
5. After success, inform the user that the next message to that group will start a fresh session

> **Why `--project` is required (do NOT drop it).** The repo root is a Bun
> project with no Python `pyproject.toml`. A bare `uv run <script>` walks up
> from the current directory, finds no Python project, and runs the script in
> an empty ephemeral environment → `ModuleNotFoundError: No module named
> 'google'`. `--project .claude/skills/compact-history` points uv at this
> skill's own `pyproject.toml` + `uv.lock` + `.venv` (which declare
> `google-genai` etc.). This matches exactly how the app invokes it in
> `src/index.ts` (`/compact-history`) and `src/db.ts` (nightly task).

## Backfill

If stored summaries are missing (first run or new group), run the daily compaction script manually to backfill:

```bash
uv run --project .claude/skills/compact-history .claude/skills/compact-history/compact-daily.py
```

This processes all unsummarized days for all groups in batches of 3 days per API call.
