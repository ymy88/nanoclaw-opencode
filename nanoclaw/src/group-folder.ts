import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

/**
 * Sanitize a Slack thread_ts for use as a filesystem-safe directory name.
 * Replaces '.' with '-' (e.g., "1772771784.037519" → "1772771784-037519").
 */
export function sanitizeThreadKey(ts: string): string {
  return ts.replace(/\./g, '-');
}

/**
 * Reverse sanitizeThreadKey: convert filesystem-safe key back to Slack ts.
 * Replaces the last '-' with '.' (Slack ts has exactly one '.').
 */
export function unsanitizeThreadKey(key: string): string {
  const lastDash = key.lastIndexOf('-');
  if (lastDash === -1) return key;
  return key.slice(0, lastDash) + '.' + key.slice(lastDash + 1);
}

/**
 * Resolve the IPC path for a specific thread within a group.
 * Without threadKey, returns the group-level IPC path.
 */
export function resolveThreadIpcPath(
  folder: string,
  threadKey?: string | null,
): string {
  const groupIpcPath = resolveGroupIpcPath(folder);
  if (!threadKey) return groupIpcPath;
  return path.resolve(groupIpcPath, threadKey);
}
