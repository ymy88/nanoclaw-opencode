---
name: prune-session
description: Prune tool-call and reasoning "noise" from a group's OpenCode session DB, keeping every real reply. Use when a session has grown huge / hits the provider token limit ("发消息不回", "exceeded model token limit"), or to backfill/shrink an existing large session DB. Unlike compact-history, this is lossless of real replies (no summarization).
---

# Prune Session

Permanently deletes `tool` (call + result) and `reasoning` (thinking) parts from
**old** turns of a group's OpenCode session database, keeping every `text`/`file`
part (the real replies) and the most recent K user turns fully intact.

OpenCode re-sends the whole session history into the prompt each turn; tool
output and thinking dominate the byte/token weight and have no value for
subsequent conversation, so a session grows unbounded until it exceeds the
provider's token limit and the agent stops replying. This trims that noise
without touching real replies.

Pruning runs **automatically after every turn** (host-side hook in
`src/index.ts`, gated by `SESSION_PRUNE_ENABLED`, keep window
`SESSION_PRUNE_KEEP_TURNS`, default 5). This skill is the **manual** entry point:
backfill an existing oversized session, tune the keep window, or trim
old/abandoned sessions on demand.

## Usage

The user will name a group (e.g. "prune war-room", "shrink the war-room session
DB", "war-room 又太大了/发消息不回").

## Steps

1. Identify the group folder name from the user's request.
2. Run from the `nanoclaw/` project root:

   ```bash
   bun run prune-session <group-folder> [--keep N] [--session <id>]
   ```

   - `--keep N` — keep the last N user turns fully intact (default:
     `SESSION_PRUNE_KEEP_TURNS`, i.e. 5). Older turns are pruned to text-only.
   - `--session <id>` — restrict to one session id (default: every session in
     the DB, which is what you want for backfilling old abandoned sessions).

3. If a container is active for that group, wait until it exits and retry — the
   command opens the session DB directly and should not race a live container.
4. Report the deleted-part count.

Note: deleting parts frees space for reuse inside the DB file but does not
shrink the file on disk (SQLite keeps the freed pages). That is intentional —
the token-limit problem is solved by removing rows from the prompt, and
reclaiming a few MB of disk is not worth a heavier VACUUM step.

## Cache safety

Pruning is designed to preserve provider prefix-cache hits: it deletes rows
**once, permanently**, uses a **deterministic turn-based boundary** (the K-th
most recent user message, not a shifting token budget), and **never reorders**
surviving parts. So the assembled history stays byte-stable turn over turn.

## vs. compact-history

- **compact-history**: hard reset — summarizes the whole history into one
  context file and starts a fresh session. Lossy (real replies become a
  summary). Use to apply PERSONALITY/STYLE changes or rescue a session too big
  to even prune.
- **prune-session**: keeps every real reply verbatim, only drops thinking/tool
  noise. Use for routine size control. This is the everyday tool; reach for
  compact-history only when you need a clean slate.

## Data note

This DELETEs from the OpenCode session DB (the LLM context store). It does NOT
touch NanoClaw's own `store/messages.db`, so the human-visible chat history is
untouched. What is lost is only the old thinking/tool traces, which have no
downstream use. Do not run it against a group the user hasn't asked you to.
