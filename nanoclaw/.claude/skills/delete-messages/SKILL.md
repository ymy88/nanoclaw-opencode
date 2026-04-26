---
name: delete-messages
description: Delete recent messages from a group's chat history. Removes from both NanoClaw SQLite database and OpenCode session database. Use when the user says "delete last X messages" or wants to remove specific messages from a group.
---

# Delete Messages

Deletes the last N messages from a group's SQLite database and cleans up the corresponding OpenCode session database.

## Usage

The user will say something like:
- "delete last 2 messages in main"
- "remove last 3 messages from war-room"

## Steps

1. Identify the group and number of messages to delete
2. Run: `uv run .claude/skills/delete-messages/delete.py <group-folder> <count>`
3. Add `--dry-run` to preview without deleting
4. If a container is active for that group, tell the user to stop it first

## Options

- `--dry-run` — Show which messages would be deleted without actually deleting
- `--count N` — Number of recent messages to delete (default: 2)
