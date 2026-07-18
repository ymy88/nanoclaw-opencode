/**
 * CLI: manually prune tool/reasoning noise from a group's OpenCode session DB.
 *
 * Usage:
 *   bun run prune-session <group> [--keep N] [--session <id>]
 *
 *   <group>        group folder name (e.g. "war-room")
 *   --keep N       keep the last N user turns intact (default: SESSION_PRUNE_KEEP_TURNS)
 *   --session <id> only prune this session id (default: every session in the DB)
 *
 * Use this to backfill existing large sessions (the per-turn hook prunes
 * automatically, but this lets you trim old/abandoned sessions on demand).
 */
import { SESSION_PRUNE_KEEP_TURNS } from './config.js';
import {
  opencodeSessionDbPath,
  pruneOpencodeSession,
} from './session-prune.js';

function parseArgs(argv: string[]): {
  group?: string;
  keep: number;
  sessionId?: string;
} {
  let group: string | undefined;
  let keep = SESSION_PRUNE_KEEP_TURNS;
  let sessionId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') {
      keep = Math.max(1, parseInt(argv[++i] ?? '', 10) || SESSION_PRUNE_KEEP_TURNS);
    } else if (arg === '--session') {
      sessionId = argv[++i];
    } else if (!arg.startsWith('-') && !group) {
      group = arg;
    }
  }
  return { group, keep, sessionId };
}

function main(): void {
  const { group, keep, sessionId } = parseArgs(process.argv.slice(2));

  if (!group) {
    console.error(
      'Usage: bun run prune-session <group> [--keep N] [--session <id>]',
    );
    process.exit(1);
  }

  console.log(
    `Pruning "${group}" (keep last ${keep} user turns${
      sessionId ? `, session ${sessionId}` : ', all sessions'
    })`,
  );
  console.log(`DB: ${opencodeSessionDbPath(group)}`);

  const result = pruneOpencodeSession(group, {
    keepUserTurns: keep,
    sessionId,
  });

  if (result.skipped === 'no-db') {
    console.error(`No session database found for group "${group}".`);
    process.exit(1);
  }

  console.log(
    `Done: deleted ${result.deletedParts} noise part(s) across ${result.prunedSessions} session(s).`,
  );
}

main();
