#!/usr/bin/env python3
"""
Daily conversation compaction.

Runs nightly to summarize unsummarized days into message_summaries table.
Processes in batches of 3 days per Gemini API call.

Usage: uv run .claude/skills/compact-history/compact-daily.py
"""

import os
import re
import sqlite3
import sys
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.genai.types import HarmBlockThreshold, HarmCategory

ROOT = Path(__file__).resolve().parents[3]
DB_PATH = ROOT / "store" / "messages.db"

LOCAL_TZ = timezone(timedelta(hours=8))  # Asia/Shanghai
DAY_START_HOUR = 4  # day boundary at 4:00 AM local
BATCH_SIZE = 7  # days per Gemini API call


def get_all_groups(db_path: Path) -> list[tuple[str, str]]:
    conn = sqlite3.connect(str(db_path))
    rows = conn.execute("SELECT jid, folder FROM registered_groups").fetchall()
    conn.close()
    return rows


def get_latest_summary_date(db_path: Path, chat_jid: str) -> str | None:
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT MAX(date) FROM message_summaries WHERE chat_jid = ?", (chat_jid,)
    ).fetchone()
    conn.close()
    return row[0] if row and row[0] else None


def get_earliest_message_date(db_path: Path, chat_jid: str) -> str | None:
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT MIN(timestamp) FROM messages WHERE chat_jid = ? AND COALESCE(exclude_from_history, 0) = 0",
        (chat_jid,),
    ).fetchone()
    conn.close()
    if not row or not row[0]:
        return None
    dt = datetime.fromisoformat(row[0].replace("Z", "+00:00")).astimezone(LOCAL_TZ)
    return dt.strftime("%Y-%m-%d")


def local_to_utc_iso(dt: datetime) -> str:
    """Convert a local datetime to UTC ISO string with Z suffix (matching DB format)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def read_messages_for_day(db_path: Path, chat_jid: str, date: str) -> list[dict]:
    """Read messages for a logical day (4:00 AM local to 4:00 AM next day local)."""
    day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=LOCAL_TZ)
    start = day.replace(hour=DAY_START_HOUR, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT sender_name, content, is_bot_message, timestamp FROM messages "
        "WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ? "
        "AND COALESCE(exclude_from_history, 0) = 0 "
        "ORDER BY timestamp",
        (chat_jid, local_to_utc_iso(start), local_to_utc_iso(end)),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_unsummarized_dates(db_path: Path, chat_jid: str) -> list[str]:
    """Get all dates that need summarization (up to yesterday)."""
    latest = get_latest_summary_date(db_path, chat_jid)
    earliest = get_earliest_message_date(db_path, chat_jid)

    if not earliest:
        return []

    now = datetime.now(LOCAL_TZ)
    # Yesterday's date (the last complete day)
    yesterday = (now - timedelta(hours=DAY_START_HOUR)).strftime("%Y-%m-%d")
    if now.hour < DAY_START_HOUR:
        yesterday = (now - timedelta(days=1, hours=DAY_START_HOUR)).strftime("%Y-%m-%d")

    start_date = latest if latest else earliest
    if latest:
        # Start from the day after the latest summary
        start = datetime.strptime(start_date, "%Y-%m-%d") + timedelta(days=1)
        start_date = start.strftime("%Y-%m-%d")

    dates = []
    current = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(yesterday, "%Y-%m-%d")

    while current <= end:
        dates.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)

    return dates


def summarize_batch(dates: list[str], messages_by_date: dict[str, list[dict]], client) -> dict[str, str]:
    """Summarize a batch of days in one Gemini API call. Returns {date: summary}."""
    from google.genai import types

    sections = []
    for date in dates:
        msgs = messages_by_date.get(date, [])
        if not msgs:
            continue
        lines = [f"[{m['sender_name']}]: {m['content']}" for m in msgs]
        sections.append(f"## {date}\n\n" + "\n\n".join(lines))

    if not sections:
        return {}

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

    text = response.text or ""

    # Parse output into per-day summaries by splitting on ## YYYY-MM-DD headers
    result: dict[str, str] = {}
    parts = re.split(r"(?=^## \d{4}-\d{2}-\d{2})", text, flags=re.MULTILINE)
    for part in parts:
        part = part.strip()
        if not part:
            continue
        match = re.match(r"^## (\d{4}-\d{2}-\d{2})", part)
        if match:
            result[match.group(1)] = part

    return result


def save_summary(db_path: Path, chat_jid: str, date: str, summary: str, message_count: int) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT OR REPLACE INTO message_summaries (chat_jid, date, summary, message_count, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (chat_jid, date, summary, message_count, datetime.now(LOCAL_TZ).isoformat()),
    )
    conn.commit()
    conn.close()


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Daily conversation compaction")
    parser.add_argument("group_folder", nargs="?", help="Only compact this group (e.g., 'main'). Omit to compact all groups.")
    args = parser.parse_args()

    creds_path = str(ROOT / "vertex-service-account.json")
    os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", creds_path)

    from google import genai

    client = genai.Client(vertexai=True, location="global")

    all_groups = get_all_groups(DB_PATH)
    if not all_groups:
        print("No registered groups found.")
        return

    if args.group_folder:
        groups = [(jid, folder) for jid, folder in all_groups if folder == args.group_folder]
        if not groups:
            print(f'Error: Group "{args.group_folder}" not found', file=sys.stderr)
            sys.exit(1)
    else:
        groups = all_groups

    for jid, folder in groups:
        print(f"\n=== Group: {folder} (JID: {jid}) ===")

        dates = get_unsummarized_dates(DB_PATH, jid)
        if not dates:
            print("  All days already summarized.")
            continue

        print(f"  {len(dates)} day(s) to summarize: {dates[0]} to {dates[-1]}")

        # Process in batches
        for i in range(0, len(dates), BATCH_SIZE):
            batch_dates = dates[i : i + BATCH_SIZE]

            # Read messages for each day in the batch
            messages_by_date: dict[str, list[dict]] = {}
            total_msgs = 0
            for date in batch_dates:
                msgs = read_messages_for_day(DB_PATH, jid, date)
                messages_by_date[date] = msgs
                total_msgs += len(msgs)

            if total_msgs == 0:
                for date in batch_dates:
                    save_summary(DB_PATH, jid, date, f"## {date}\nNo messages this day.", 0)
                print(f"  Batch {batch_dates[0]}~{batch_dates[-1]}: no messages, skipped")
                continue

            print(f"  Batch {batch_dates[0]}~{batch_dates[-1]} ({total_msgs} messages)...", end="", flush=True)

            summaries = summarize_batch(batch_dates, messages_by_date, client)

            for date in batch_dates:
                summary = summaries.get(date, f"## {date}\nNo messages this day.")
                count = len(messages_by_date.get(date, []))
                save_summary(DB_PATH, jid, date, summary, count)

            total_chars = sum(len(s) for s in summaries.values())
            print(f" → {total_chars} chars")

    print("\nDone.")


if __name__ == "__main__":
    main()
