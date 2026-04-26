#!/usr/bin/env python3
"""
Compact a group's conversation history.

Reads recent messages from SQLite, groups them by date, summarizes via
Gemini on Vertex AI day-by-day, writes a context file, deletes OpenCode
session databases and session records, and signals the running NanoClaw
process to clear its in-memory cache.

Usage: uv run .claude/skills/compact-history/compact.py <group-folder> [--limit N]
"""

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.genai.types import HarmBlockThreshold, HarmCategory

ROOT = Path(__file__).resolve().parents[3]
DB_PATH = ROOT / "store" / "messages.db"
GROUPS_DIR = ROOT / "groups"
DATA_DIR = ROOT / "data"

# Default timezone offset for grouping messages by local date
LOCAL_TZ = timezone(timedelta(hours=8))  # Asia/Shanghai


def check_active_containers(group_folder: str) -> None:
    try:
        result = subprocess.run(
            ["docker", "ps", "--filter", f"name=nanoclaw-opencode-{group_folder}", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        running = result.stdout.strip()
        if running:
            print(f'Error: Container is active for "{group_folder}": {running}', file=sys.stderr)
            print("Wait for it to finish or stop it first.", file=sys.stderr)
            sys.exit(1)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass  # docker not available or timeout — fine


def read_messages(db_path: Path, chat_jid: str, limit: int) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT sender_name, content, is_bot_message, timestamp FROM messages "
        "WHERE chat_jid = ? AND COALESCE(exclude_from_history, 0) = 0 "
        "ORDER BY timestamp DESC LIMIT ?",
        (chat_jid, limit),
    ).fetchall()
    conn.close()
    messages = [dict(r) for r in rows]
    messages.reverse()
    return messages


def group_by_date(messages: list[dict]) -> OrderedDict[str, list[dict]]:
    buckets: OrderedDict[str, list[dict]] = OrderedDict()
    for m in messages:
        ts = m.get("timestamp", "")
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ)
            date_key = dt.strftime("%Y-%m-%d")
        except (ValueError, AttributeError):
            date_key = "unknown"
        buckets.setdefault(date_key, []).append(m)
    return buckets


def summarize_with_gemini(day_buckets: OrderedDict[str, list[dict]], creds_path: str) -> str:
    from google import genai

    sections = []
    for date_key, msgs in day_buckets.items():
        lines = []
        for m in msgs:
            sender = m["sender_name"]
            lines.append(f"[{sender}]: {m['content']}")
        sections.append(f"## {date_key}\n\n" + "\n\n".join(lines))

    conversation_text = "\n\n---\n\n".join(sections)

    prompt = f"""You are a continuity assistant helping preserve conversation history across sessions.
Below is a transcript of dialogue organized by date. Rephrase the ENTIRE conversation in third-person narrative tone, organized DAY BY DAY.

Your job is NOT to summarize or condense — it is to REPHRASE every topic, every exchange, every detail into third-person prose. Do not skip or merge conversations. If they discussed 10 topics in a day, write about all 10. If someone shared a story, retell the full story.

Preserve ALL of the following:
- Every topic discussed, in the order it was discussed
- All specific names, dates, places, numbers, and facts
- All opinions, reactions, jokes, and emotional moments
- All plans, promises, commitments, and agreements
- All backstory, personal history, and anecdotes shared
- Specific food items, book titles, movie names, song names, financial figures
- Significant quotes or phrases

Format your output as:

## YYYY-MM-DD
[detailed third-person retelling of that day's conversation]

## YYYY-MM-DD
[detailed third-person retelling of that day's conversation]

Write in neutral, third-person factual prose. Do NOT use dialogue format.
Write in the SAME LANGUAGE as the conversation messages. If they spoke Chinese, write in Chinese. If English, write in English.

---
{conversation_text}"""

    client = genai.Client(vertexai=True, location="global")
    from google.genai import types

    response = client.models.generate_content(
        model="gemini-3.1-pro-preview",
        contents=prompt,
        config=types.GenerateContentConfig(
            safety_settings=[
                types.SafetySetting(category=HarmCategory.HARM_CATEGORY_HARASSMENT, threshold=HarmBlockThreshold.OFF),
                types.SafetySetting(
                    category=HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold=HarmBlockThreshold.OFF
                ),
                types.SafetySetting(
                    category=HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold=HarmBlockThreshold.OFF
                ),
                types.SafetySetting(category=HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold=HarmBlockThreshold.OFF),
            ],
        ),
    )
    return response.text or ""


def delete_session_data(group_folder: str) -> None:
    opencode_dir = DATA_DIR / "sessions" / group_folder / ".opencode"
    if opencode_dir.exists():
        count = 0
        for entry in opencode_dir.rglob("*.db*"):
            entry.unlink()
            count += 1
            print(f"Deleted: {entry}")
        if count:
            print(f"Deleted {count} database file(s) from {opencode_dir}")


def delete_sessions(db_path: Path, group_folder: str) -> int:
    conn = sqlite3.connect(str(db_path))
    count = conn.execute("SELECT count(*) FROM sessions WHERE group_folder = ?", (group_folder,)).fetchone()[0]
    conn.execute("DELETE FROM sessions WHERE group_folder = ?", (group_folder,))
    conn.commit()
    conn.close()
    return count


def write_sentinel(group_folder: str) -> None:
    ipc_dir = DATA_DIR / "ipc" / group_folder
    ipc_dir.mkdir(parents=True, exist_ok=True)
    (ipc_dir / "_session_reset").write_text("")


def main():
    parser = argparse.ArgumentParser(description="Compact a group's conversation history")
    parser.add_argument("group_folder", help="Group folder name (e.g., 'main')")
    parser.add_argument("--limit", type=int, default=1500, help="Number of recent messages to include (default: 1500)")
    parser.add_argument(
        "--dry-run", action="store_true", help="Only generate the summary file, skip session reset and container check"
    )
    args = parser.parse_args()

    group_folder = args.group_folder

    # 1. Check for active containers (skip in dry-run mode)
    if not args.dry_run:
        check_active_containers(group_folder)

    # 2. Look up chat_jid
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT jid FROM registered_groups WHERE folder = ?", (group_folder,)).fetchone()
    conn.close()
    if not row:
        print(f'Error: Group "{group_folder}" not found in registered_groups', file=sys.stderr)
        sys.exit(1)
    chat_jid = row[0]
    print(f"Group: {group_folder}, JID: {chat_jid}")

    # 3. Read recent messages
    messages = read_messages(DB_PATH, chat_jid, args.limit)
    if not messages:
        print("No messages found — nothing to compact.")
        return
    print(f"Found {len(messages)} messages to summarize")

    # 4. Group by date
    day_buckets = group_by_date(messages)
    dates = list(day_buckets.keys())
    print(f"Messages span {len(dates)} day(s): {dates[0]} to {dates[-1]}")

    # 5. Summarize via Gemini
    creds_path = str(ROOT / "vertex-service-account.json")
    os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", creds_path)

    print("Summarizing conversation via Gemini...")
    summary = summarize_with_gemini(day_buckets, creds_path)
    print(f"Summary generated ({len(summary)} chars)")

    # 6. Format recent messages for conversation continuity
    recent = messages[-10:]
    recent_lines = []
    for m in recent:
        recent_lines.append(f"[{m['sender_name']}]: {m['content']}")
    recent_transcript = "\n\n".join(recent_lines)

    # 7. Write context file
    group_dir = GROUPS_DIR / group_folder
    context_file = group_dir / ".conversation-context.md"
    context_content = f"""# Conversation Context

This is a summary of previous conversations, organized by date. Use it as
background knowledge about what has been discussed. Follow your PERSONALITY.md
for communication style — do NOT imitate any style patterns from this summary.

---

{summary}

---

## Recent Messages

The conversation left off here. Continue naturally from this point:

{recent_transcript}
"""
    context_file.write_text(context_content)
    print(f"Context file written: {context_file}")

    if args.dry_run:
        print(f'\nDry run complete for "{group_folder}". Summary written but session not reset.')
        return

    # 8. Delete OpenCode session data
    delete_session_data(group_folder)

    # 9. Delete sessions from DB
    count = delete_sessions(DB_PATH, group_folder)
    print(f"Deleted {count} session(s) from DB")

    # 10. Write sentinel file
    write_sentinel(group_folder)
    print("Session reset signal written")

    print(f'\nCompaction complete for "{group_folder}".')
    print("Next message to this group will start a fresh session with conversation context.")


if __name__ == "__main__":
    main()
