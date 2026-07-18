import path from 'path';
import { existsSync } from 'fs';

import { Database } from 'bun:sqlite';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Storage-level "noise pruning" for OpenCode session databases.
 *
 * OpenCode re-sends the entire session history into the prompt every turn.
 * `tool` (call + result) and `reasoning` (thinking) parts have no value for
 * subsequent conversation but dominate the token/byte weight, so a session
 * grows unbounded until it exceeds the provider's token limit ("发消息不回").
 *
 * This module permanently deletes `tool`/`reasoning` parts from OLD turns,
 * keeping every `text`/`file` part (the real replies) and the most recent
 * `keepUserTurns` turns fully intact.
 *
 * CACHE SAFETY (hard requirement): the assembled prompt prefix must be
 * byte-stable turn over turn so provider prefix caching keeps hitting. This is
 * guaranteed by three invariants:
 *   1. One-time, permanent DELETE — rows are removed, never rewritten/reordered.
 *      Surviving `text` parts are immutable, so older history is byte-identical
 *      on every later turn.
 *   2. Deterministic, turn-based boundary — the keep window is anchored to the
 *      K-th most recent USER message (by time_created), NOT a recomputed token
 *      budget, so the boundary only advances monotonically by one turn.
 *   3. Delete-only, no reorder — only noise parts are removed; text parts stay
 *      in place and in order.
 */

const NOISE_PART_TYPES = ['tool', 'reasoning'] as const;

export interface PruneOptions {
  /** Number of most-recent user turns to keep fully intact (>= 1). */
  keepUserTurns: number;
  /**
   * Restrict pruning to a single session id. When omitted, every session in
   * the group's database is pruned (used by the backfill CLI).
   */
  sessionId?: string;
}

export interface PruneResult {
  /** Total noise parts deleted across all pruned sessions. */
  deletedParts: number;
  /** Number of sessions that had at least one part deleted. */
  prunedSessions: number;
  /** Set when nothing ran (e.g. the database does not exist yet). */
  skipped?: 'no-db';
}

/** Absolute path to a group's OpenCode session database on the host. */
export function opencodeSessionDbPath(groupFolder: string): string {
  return path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.opencode',
    'opencode',
    'opencode-dev.db',
  );
}

/**
 * Prune a single session inside an already-open database. Returns the number
 * of noise parts deleted. Deterministic and idempotent: re-running deletes the
 * same (already-empty) set and changes nothing.
 */
function pruneOneSession(
  db: Database,
  sessionId: string,
  keepUserTurns: number,
): number {
  // Boundary = time_created of the K-th most recent user message. Everything
  // strictly older than this is eligible for pruning; the last K user turns
  // (and the current in-flight turn) are kept fully intact.
  const boundary = db
    .query(
      `SELECT time_created AS t
         FROM message
        WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
        ORDER BY time_created DESC, id DESC
        LIMIT 1 OFFSET ?`,
    )
    .get(sessionId, keepUserTurns - 1) as { t: number } | null;

  // Fewer than K user turns exist — nothing old enough to prune.
  if (!boundary) return 0;

  const placeholders = NOISE_PART_TYPES.map(() => '?').join(', ');
  const result = db
    .query(
      `DELETE FROM part
        WHERE session_id = ?
          AND json_extract(data, '$.type') IN (${placeholders})
          AND message_id IN (
            SELECT id FROM message
             WHERE session_id = ? AND time_created < ?
          )`,
    )
    .run(sessionId, ...NOISE_PART_TYPES, sessionId, boundary.t);

  return Number(result.changes);
}

/**
 * Prune noise parts from a group's OpenCode session database.
 *
 * Best-effort: a missing database is reported via `skipped`, not thrown. Any
 * real SQLite error propagates so the caller can decide (the per-turn hook
 * swallows it so pruning never blocks a reply).
 */
export function pruneOpencodeSession(
  groupFolder: string,
  opts: PruneOptions,
): PruneResult {
  const keepUserTurns = Math.max(1, Math.floor(opts.keepUserTurns));
  const dbPath = opencodeSessionDbPath(groupFolder);

  if (!existsSync(dbPath)) {
    return { deletedParts: 0, prunedSessions: 0, skipped: 'no-db' };
  }

  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    const sessionIds: string[] = opts.sessionId
      ? [opts.sessionId]
      : (
          db
            .query(`SELECT DISTINCT session_id AS id FROM message`)
            .all() as { id: string }[]
        ).map((row) => row.id);

    let deletedParts = 0;
    let prunedSessions = 0;

    const runAll = db.transaction(() => {
      for (const sid of sessionIds) {
        const deleted = pruneOneSession(db, sid, keepUserTurns);
        if (deleted > 0) {
          deletedParts += deleted;
          prunedSessions += 1;
        }
      }
    });
    runAll();

    return { deletedParts, prunedSessions };
  } finally {
    db.close();
  }
}

/**
 * Convenience wrapper for the per-turn hook: prune the active chat session
 * best-effort, logging the outcome. Never throws — pruning must not block a
 * reply.
 */
export function pruneActiveSessionSafe(
  groupFolder: string,
  sessionId: string,
  keepUserTurns: number,
): void {
  try {
    const result = pruneOpencodeSession(groupFolder, {
      keepUserTurns,
      sessionId,
    });
    if (result.deletedParts > 0) {
      logger.info(
        {
          group: groupFolder,
          sessionId,
          deletedParts: result.deletedParts,
          keepUserTurns,
        },
        'Pruned OpenCode session noise (tool/reasoning parts)',
      );
    }
  } catch (err) {
    logger.info(
      {
        group: groupFolder,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Session prune failed (non-fatal)',
    );
  }
}
