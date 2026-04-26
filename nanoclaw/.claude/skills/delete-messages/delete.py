#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""
Delete recent messages from a group's chat history.

1. User specifies how many messages to delete
2. Delete those messages from NanoClaw DB
3. Find the last remaining message in NanoClaw DB
4. Find the correlated message in OpenCode session DB (by matching content
   in part text — NanoClaw content is a subset of the session part text)
5. Delete every message after the match in the session DB

Usage: uv run .claude/skills/delete-messages/delete.py <group-folder> <count> [--dry-run]
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DB_PATH = ROOT / "store" / "messages.db"
DATA_DIR = ROOT / "data"


def get_chat_jid(group_folder: str) -> str | None:
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        "SELECT jid FROM registered_groups WHERE folder = ?", (group_folder,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


def get_recent_messages(chat_jid: str, count: int) -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, chat_jid, sender_name, content, is_bot_message, timestamp "
        "FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?",
        (chat_jid, count),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_last_remaining_message(chat_jid: str, count: int) -> dict | None:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, content, is_bot_message, timestamp FROM messages "
        "WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1 OFFSET ?",
        (chat_jid, count),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_from_db(chat_jid: str, message_ids: list[str]) -> int:
    conn = sqlite3.connect(str(DB_PATH))
    placeholders = ",".join("?" for _ in message_ids)
    count = conn.execute(
        f"DELETE FROM messages WHERE chat_jid = ? AND id IN ({placeholders})",
        [chat_jid] + message_ids,
    ).rowcount
    conn.commit()
    conn.close()
    return count


def get_session_id(group_folder: str) -> str | None:
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute(
        "SELECT session_id FROM sessions WHERE group_folder = ?", (group_folder,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


def find_opencode_db(group_folder: str) -> Path | None:
    db_path = DATA_DIR / "sessions" / group_folder / ".opencode" / "opencode" / "opencode-dev.db"
    return db_path if db_path.exists() else None


def find_anchor_in_session(opencode_db: Path, session_id: str, anchor_content: str) -> str | None:
    """
    Find the OpenCode message that matches the anchor content.
    NanoClaw content is a subset of the session part text (session has extra
    markup like &lt;@U0AJKH2KDKJ&gt;), so we check if anchor appears within
    the part text. Search newest-first to find the most recent match.
    """
    if not anchor_content or len(anchor_content.strip()) < 5:
        return None

    conn = sqlite3.connect(str(opencode_db))
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT m.id as msg_id, m.time_created, p.data as part_data "
        "FROM message m JOIN part p ON p.message_id = m.id "
        "WHERE m.session_id = ? "
        "ORDER BY m.time_created DESC",
        (session_id,),
    ).fetchall()
    conn.close()

    # Use a meaningful snippet for matching (first 40 chars, stripped)
    snippet = anchor_content.strip()[:40]

    for row in rows:
        try:
            part = json.loads(row["part_data"])
            text = part.get("text", "")
            if snippet in text:
                return row["msg_id"]
        except (json.JSONDecodeError, TypeError):
            continue

    return None


def delete_after_anchor(opencode_db: Path, session_id: str, anchor_msg_id: str, dry_run: bool) -> int:
    conn = sqlite3.connect(str(opencode_db))

    row = conn.execute(
        "SELECT time_created FROM message WHERE id = ?", (anchor_msg_id,)
    ).fetchone()
    if not row:
        conn.close()
        return 0

    anchor_time = row[0]

    to_delete = conn.execute(
        "SELECT id FROM message WHERE session_id = ? AND time_created > ?",
        (session_id, anchor_time),
    ).fetchall()

    if not to_delete:
        conn.close()
        return 0

    msg_ids = [r[0] for r in to_delete]

    if dry_run:
        conn.close()
        return len(msg_ids)

    placeholders = ",".join("?" for _ in msg_ids)
    conn.execute(f"DELETE FROM part WHERE message_id IN ({placeholders})", msg_ids)
    deleted = conn.execute(f"DELETE FROM message WHERE id IN ({placeholders})", msg_ids).rowcount
    conn.commit()
    conn.close()
    return deleted


def main():
    parser = argparse.ArgumentParser(description="Delete recent messages from a group")
    parser.add_argument("group_folder", help="Group folder name (e.g., 'main')")
    parser.add_argument("count", type=int, nargs="?", default=2, help="Number of recent messages to delete (default: 2)")
    parser.add_argument("--dry-run", action="store_true", help="Preview without deleting")
    args = parser.parse_args()

    group_folder = args.group_folder
    count = args.count

    chat_jid = get_chat_jid(group_folder)
    if not chat_jid:
        print(f"Error: Group '{group_folder}' not found", file=sys.stderr)
        sys.exit(1)

    to_delete = get_recent_messages(chat_jid, count)
    if not to_delete:
        print("No messages to delete.")
        return

    anchor = get_last_remaining_message(chat_jid, count)

    print(f"Group: {group_folder}, JID: {chat_jid}")
    print(f"\nMessages to delete ({len(to_delete)}):")
    for m in reversed(to_delete):
        sender = "Bot" if m["is_bot_message"] else m["sender_name"] or "User"
        content_preview = (m["content"] or "")[:80].replace("\n", " ")
        print(f"  [{sender}] {m['timestamp']}: {content_preview}")

    if anchor:
        sender = "Bot" if anchor["is_bot_message"] else "User"
        print(f"\nAnchor (last remaining): [{sender}] {anchor['timestamp']}: {(anchor['content'] or '')[:80].replace(chr(10), ' ')}")
    else:
        print("\nNo anchor — all messages would be deleted")

    if args.dry_run:
        print("\n(dry run — no changes made)")
        return

    # 1. Delete from NanoClaw DB
    ids = [m["id"] for m in to_delete]
    deleted = delete_from_db(chat_jid, ids)
    print(f"\nDeleted {deleted} messages from NanoClaw database")

    # 2. Find anchor in OpenCode session and delete everything after it
    session_id = get_session_id(group_folder)
    if session_id and anchor:
        opencode_db = find_opencode_db(group_folder)
        if opencode_db:
            anchor_msg_id = find_anchor_in_session(opencode_db, session_id, anchor["content"] or "")
            if anchor_msg_id:
                oc_deleted = delete_after_anchor(opencode_db, session_id, anchor_msg_id, False)
                print(f"Deleted {oc_deleted} messages from OpenCode session (after anchor {anchor_msg_id})")
            else:
                print("Could not find anchor message in OpenCode session — skipping session cleanup")
        else:
            print("OpenCode database not found — skipping session cleanup")
    elif not anchor:
        print("No anchor message — consider using /compact-history to reset the session")
    else:
        print("No active session to clean")

    print(f"\nDone.")


if __name__ == "__main__":
    main()
