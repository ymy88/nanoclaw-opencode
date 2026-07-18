import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';

import { Database } from 'bun:sqlite';

const DATA_DIR = path.join(os.tmpdir(), 'nanoclaw-prune-test-data');

vi.mock('./config.js', () => ({ DATA_DIR }));
vi.mock('./logger.js', () => ({ logger: { info: () => {} } }));

import {
  opencodeSessionDbPath,
  pruneOpencodeSession,
  pruneActiveSessionSafe,
} from './session-prune.js';

// --- fixture helpers -------------------------------------------------------

let clock = 1000;
function nextTime(): number {
  return ++clock;
}

function createDb(groupFolder: string): Database {
  const dbPath = opencodeSessionDbPath(groupFolder);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  return db;
}

let msgSeq = 0;
let partSeq = 0;

function addMessage(db: Database, sid: string, role: 'user' | 'assistant'): string {
  const id = `msg_${role}_${++msgSeq}`;
  const t = nextTime();
  db.query(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sid, t, t, JSON.stringify({ role }));
  return id;
}

function addPart(db: Database, sid: string, messageId: string, type: string, extra: object = {}): void {
  const id = `prt_${type}_${++partSeq}`;
  const t = nextTime();
  db.query(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, messageId, sid, t, t, JSON.stringify({ type, ...extra }));
}

/** A user turn: one user message with a text part. */
function addUserTurn(db: Database, sid: string, text: string): void {
  const m = addMessage(db, sid, 'user');
  addPart(db, sid, m, 'text', { text });
}

/** A tool step: assistant message with step-start, reasoning, tool, step-finish. */
function addToolStep(db: Database, sid: string): void {
  const m = addMessage(db, sid, 'assistant');
  addPart(db, sid, m, 'step-start');
  addPart(db, sid, m, 'reasoning', { text: 'thinking...' });
  addPart(db, sid, m, 'tool', { tool: 'webfetch', state: { status: 'completed', output: 'x'.repeat(500) } });
  addPart(db, sid, m, 'step-finish');
}

/** The final answer step: assistant message with step-start, reasoning, text. */
function addAnswerStep(db: Database, sid: string, text: string): void {
  const m = addMessage(db, sid, 'assistant');
  addPart(db, sid, m, 'step-start');
  addPart(db, sid, m, 'reasoning', { text: 'thinking...' });
  addPart(db, sid, m, 'text', { text });
  addPart(db, sid, m, 'step-finish');
}

/** A full turn = user msg + `toolSteps` tool steps + one answer step. */
function addTurn(db: Database, sid: string, userText: string, answerText: string, toolSteps = 0): void {
  addUserTurn(db, sid, userText);
  for (let i = 0; i < toolSteps; i++) addToolStep(db, sid);
  addAnswerStep(db, sid, answerText);
}

function partTypeCounts(db: Database, sid: string): Record<string, number> {
  const rows = db
    .query(`SELECT json_extract(data,'$.type') AS type, COUNT(*) AS n FROM part WHERE session_id = ? GROUP BY type`)
    .all(sid) as { type: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

function allTextParts(db: Database, sid: string): string[] {
  const rows = db
    .query(
      `SELECT json_extract(data,'$.text') AS text FROM part
        WHERE session_id = ? AND json_extract(data,'$.type') = 'text'
        ORDER BY time_created, id`,
    )
    .all(sid) as { text: string }[];
  return rows.map((r) => r.text);
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  clock = 1000;
  msgSeq = 0;
  partSeq = 0;
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- tests -----------------------------------------------------------------

describe('pruneOpencodeSession', () => {
  it('deletes tool/reasoning from old turns, keeps last K turns and all real replies', () => {
    const group = 'g1';
    const sid = 'ses_1';
    const db = createDb(group);
    // 5 turns; turns 4 and 5 use tools.
    addTurn(db, sid, 'u1', 'a1');
    addTurn(db, sid, 'u2', 'a2');
    addTurn(db, sid, 'u3', 'a3');
    addTurn(db, sid, 'u4', 'a4', 2);
    addTurn(db, sid, 'u5', 'a5', 1);
    db.close();

    // Keep last 2 user turns intact -> prune turns 1..3 (which had reasoning but no tools).
    const res = pruneOpencodeSession(group, { keepUserTurns: 2 });

    const check = new Database(opencodeSessionDbPath(group));
    const counts = partTypeCounts(check, sid);

    // Turns 1-3 (no tools, 1 reasoning each in the answer step) are pruned:
    // 3 reasoning deleted. Turns 4 & 5 kept fully intact.
    // Turn 4: 2 tool steps (2 reasoning + 2 tool) + answer (1 reasoning) = 3 reasoning, 2 tool.
    // Turn 5: 1 tool step (1 reasoning + 1 tool) + answer (1 reasoning) = 2 reasoning, 1 tool.
    expect(counts['tool']).toBe(3); // 2 from turn4 + 1 from turn5
    expect(counts['reasoning']).toBe(5); // turn4: 3 + turn5: 2
    expect(res.deletedParts).toBe(3); // 3 answer-step reasonings from turns 1-3
    // All real replies (user + assistant text) survive regardless of pruning.
    expect(allTextParts(check, sid)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    check.close();
  });

  it('is idempotent — a second run deletes nothing more', () => {
    const group = 'g2';
    const sid = 'ses_1';
    const db = createDb(group);
    for (let i = 1; i <= 6; i++) addTurn(db, sid, `u${i}`, `a${i}`, 1);
    db.close();

    const first = pruneOpencodeSession(group, { keepUserTurns: 2 });
    expect(first.deletedParts).toBeGreaterThan(0);

    const second = pruneOpencodeSession(group, { keepUserTurns: 2 });
    expect(second.deletedParts).toBe(0);
  });

  it('does nothing when there are fewer user turns than the keep window', () => {
    const group = 'g3';
    const sid = 'ses_1';
    const db = createDb(group);
    addTurn(db, sid, 'u1', 'a1', 1);
    addTurn(db, sid, 'u2', 'a2', 1);
    db.close();

    const res = pruneOpencodeSession(group, { keepUserTurns: 5 });
    expect(res.deletedParts).toBe(0);

    const check = new Database(opencodeSessionDbPath(group));
    const counts = partTypeCounts(check, sid);
    expect(counts['tool']).toBe(2);
    expect(counts['reasoning']).toBe(4);
    check.close();
  });

  it('prunes only the targeted session when sessionId is given', () => {
    const group = 'g4';
    const db = createDb(group);
    for (let i = 1; i <= 5; i++) addTurn(db, 'ses_A', `a-u${i}`, `a-a${i}`, 1);
    for (let i = 1; i <= 5; i++) addTurn(db, 'ses_B', `b-u${i}`, `b-a${i}`, 1);
    db.close();

    pruneOpencodeSession(group, { keepUserTurns: 2, sessionId: 'ses_A' });

    const check = new Database(opencodeSessionDbPath(group));
    // ses_A pruned (older tools gone), ses_B fully intact (5 tools).
    expect(partTypeCounts(check, 'ses_A')['tool']).toBe(2);
    expect(partTypeCounts(check, 'ses_B')['tool']).toBe(5);
    check.close();
  });

  it('prunes every session when no sessionId is given', () => {
    const group = 'g5';
    const db = createDb(group);
    for (let i = 1; i <= 5; i++) addTurn(db, 'ses_A', `a-u${i}`, `a-a${i}`, 1);
    for (let i = 1; i <= 5; i++) addTurn(db, 'ses_B', `b-u${i}`, `b-a${i}`, 1);
    db.close();

    const res = pruneOpencodeSession(group, { keepUserTurns: 2 });
    expect(res.prunedSessions).toBe(2);

    const check = new Database(opencodeSessionDbPath(group));
    expect(partTypeCounts(check, 'ses_A')['tool']).toBe(2);
    expect(partTypeCounts(check, 'ses_B')['tool']).toBe(2);
    check.close();
  });

  it('reports skipped when the database does not exist', () => {
    const res = pruneOpencodeSession('nonexistent-group', { keepUserTurns: 5 });
    expect(res.skipped).toBe('no-db');
    expect(res.deletedParts).toBe(0);
  });
});

describe('pruneActiveSessionSafe', () => {
  it('never throws, even when the database is missing', () => {
    expect(() => pruneActiveSessionSafe('nope', 'ses_x', 5)).not.toThrow();
  });
});
