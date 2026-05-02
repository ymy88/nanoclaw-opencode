---
name: compact-history
description: Reset a group's agent session to apply personality changes. Preserves conversation context (topics discussed) while discarding old style patterns from the session transcript. Use when PERSONALITY.md was updated but the agent's behavior hasn't changed.
---

# Compact History

Resets a group's agent session so personality and style changes take effect. The old session transcript is deleted and conversation history is summarized week-by-week into a context file that gets loaded into the new session.

## Usage

The user will specify which group to compact (e.g., "compact history for main", "reset the war-room session").

## Steps

1. Identify the group folder name from the user's request
2. Run: `uv run .claude/skills/compact-history/compact.py <group-folder>`
3. Optionally pass `--days <N>` to control how many days of history to include (default: 60)
4. If a container is active, tell the user to wait and try again
5. After success, inform the user that the next message to that group will start a fresh session
