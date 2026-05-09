#!/usr/bin/env python3
"""
Compact a group's conversation history.

Uses stored daily summaries from message_summaries table for old days,
only summarizes today's messages via Gemini. Writes context file, deletes
OpenCode session and NanoClaw session records.

Usage: uv run .claude/skills/compact-history/compact.py <group-folder> [--days N]
"""

import argparse
import os
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

LOCAL_TZ = timezone(timedelta(hours=8))  # Asia/Shanghai
DAY_START_HOUR = 4


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
        pass


def get_stored_summaries(db_path: Path, chat_jid: str, since_date: str | None = None) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    if since_date:
        rows = conn.execute(
            "SELECT date, summary, message_count FROM message_summaries "
            "WHERE chat_jid = ? AND date >= ? ORDER BY date",
            (chat_jid, since_date),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT date, summary, message_count FROM message_summaries "
            "WHERE chat_jid = ? ORDER BY date",
            (chat_jid,),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def local_to_utc_iso(dt: datetime) -> str:
    """Convert a local datetime to UTC ISO string with Z suffix (matching DB format)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def read_today_messages(db_path: Path, chat_jid: str) -> list[dict]:
    """Read messages from today (since 4:00 AM local)."""
    now = datetime.now(LOCAL_TZ)
    today_start = now.replace(hour=DAY_START_HOUR, minute=0, second=0, microsecond=0)
    if now.hour < DAY_START_HOUR:
        today_start -= timedelta(days=1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT sender_name, content, is_bot_message, timestamp FROM messages "
        "WHERE chat_jid = ? AND timestamp >= ? AND COALESCE(exclude_from_history, 0) = 0 "
        "ORDER BY timestamp",
        (chat_jid, local_to_utc_iso(today_start)),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def read_recent_messages(db_path: Path, chat_jid: str, count: int = 10) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT sender_name, content, is_bot_message, timestamp FROM messages "
        "WHERE chat_jid = ? AND COALESCE(exclude_from_history, 0) = 0 "
        "ORDER BY timestamp DESC LIMIT ?",
        (chat_jid, count),
    ).fetchall()
    conn.close()
    messages = [dict(r) for r in rows]
    messages.reverse()
    return messages


def summarize_today(messages: list[dict], creds_path: str) -> str:
    if not messages:
        return ""

    from google import genai
    from google.genai import types

    lines = [f"[{m['sender_name']}]: {m['content']}" for m in messages]
    conversation_text = "\n\n".join(lines)

    now = datetime.now(LOCAL_TZ)
    date_key = now.strftime("%Y-%m-%d")

    prompt = f"""You are a continuity assistant helping preserve conversation history across sessions.
Below is today's ({date_key}) conversation transcript. Rephrase the ENTIRE conversation in third-person narrative tone.

Your job is NOT to summarize or condense — it is to REPHRASE every topic, every exchange, every detail into third-person prose.

Preserve ALL of the following:
- Every topic discussed, in the order it was discussed
- All specific names, dates, places, numbers, and facts
- All opinions, reactions, jokes, and emotional moments
- All plans, promises, commitments, and agreements
- Specific food items, book titles, movie names, song names, financial figures

Format your output as:

## {date_key}
[detailed third-person retelling]

Write in neutral, third-person factual prose. Do NOT use dialogue format.
Write in the SAME LANGUAGE as the conversation messages.

---
{conversation_text}"""

    client = genai.Client(vertexai=True, location="global")
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
    parser.add_argument("--days", type=int, default=60, help="Number of days of stored summaries to include (default: 60)")
    parser.add_argument(
        "--dry-run", action="store_true", help="Only generate the summary file, skip session reset and container check"
    )
    args = parser.parse_args()

    group_folder = args.group_folder

    if not args.dry_run:
        check_active_containers(group_folder)

    # Look up chat_jid
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT jid FROM registered_groups WHERE folder = ?", (group_folder,)).fetchone()
    conn.close()
    if not row:
        print(f'Error: Group "{group_folder}" not found in registered_groups', file=sys.stderr)
        sys.exit(1)
    chat_jid = row[0]
    print(f"Group: {group_folder}, JID: {chat_jid}")

    # 1. Load stored summaries
    since_date = (datetime.now(LOCAL_TZ) - timedelta(days=args.days)).strftime("%Y-%m-%d")
    stored = get_stored_summaries(DB_PATH, chat_jid, since_date)
    print(f"Loaded {len(stored)} stored daily summaries")

    # 2. Summarize today's messages
    today_msgs = read_today_messages(DB_PATH, chat_jid)
    today_summary = ""
    if today_msgs:
        creds_path = str(ROOT / "vertex-service-account.json")
        os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", creds_path)
        print(f"Summarizing today's {len(today_msgs)} messages...")
        today_summary = summarize_today(today_msgs, creds_path)
        print(f"Today's summary: {len(today_summary)} chars")
    else:
        print("No messages today")

    # 3. Build context file
    parts = []
    for s in stored:
        parts.append(s["summary"])
    if today_summary:
        parts.append(today_summary)

    full_summary = "\n\n".join(parts)
    print(f"Total summary: {len(full_summary)} chars ({len(stored)} stored days + today)")

    # 4. Recent messages for continuity
    recent = read_recent_messages(DB_PATH, chat_jid, 10)
    def format_local_time(ts: str) -> str:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ)
        return dt.strftime("%Y-%m-%d %H:%M")

    recent_lines = [f"[{format_local_time(m['timestamp'])} {m['sender_name']}]: {m['content']}" for m in recent]
    recent_transcript = "\n\n".join(recent_lines)

    # 5. Write context file
    group_dir = GROUPS_DIR / group_folder
    context_file = group_dir / ".conversation-context.md"
    context_content = f"""# Conversation Context

This is a summary of previous conversations, organized by date. Use it as
background knowledge about what has been discussed. Follow your PERSONALITY.md
for communication style — do NOT imitate any style patterns from this summary.

---

{full_summary}

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

    # 6. Delete OpenCode session data
    delete_session_data(group_folder)

    # 7. Delete sessions from DB
    count = delete_sessions(DB_PATH, group_folder)
    print(f"Deleted {count} session(s) from DB")

    # 8. Write sentinel file
    write_sentinel(group_folder)
    print("Session reset signal written")

    print(f'\nCompaction complete for "{group_folder}".')
    print("Next message to this group will start a fresh session with conversation context.")


if __name__ == "__main__":
    main()
