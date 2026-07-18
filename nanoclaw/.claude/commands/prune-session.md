---
description: Prune tool/reasoning noise from a group's OpenCode session DB (keeps real replies). Backfill/shrink an oversized session.
argument-hint: <group> [--keep N] [--session <id>]
allowed-tools: Bash(bun run prune-session:*)
---

Run the `prune-session` CLI to remove `tool` (call+result) and `reasoning`
(thinking) parts from OLD turns of a group's OpenCode session DB, keeping every
real reply and the most recent K user turns intact. See the `prune-session`
skill for the full rationale and cache-safety design.

Arguments: `$ARGUMENTS`

Steps:

1. If `$ARGUMENTS` is empty (no group named), STOP and ask which group to prune —
   do not run against any group the user hasn't named (this DELETEs data).
2. Run from the `nanoclaw/` project root:

   ```bash
   bun run prune-session $ARGUMENTS
   ```

   - `--keep N` — keep the last N user turns intact (default 5 from
     `SESSION_PRUNE_KEEP_TURNS`).
   - `--session <id>` — restrict to one session id (default: all sessions).
3. If the CLI reports `No session database found`, tell the user the group name
   is likely wrong or the group has never run — do not create anything.
4. Report the deleted-part count. Note that automatic per-turn pruning is already
   on (`SESSION_PRUNE_ENABLED`); this command is for manual backfill.

Safety: only prune the group named in `$ARGUMENTS`. It touches only the OpenCode
context DB, never NanoClaw's `store/messages.db`, so human-visible chat history
is preserved.
