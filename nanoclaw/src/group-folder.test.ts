import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  sanitizeThreadKey,
  unsanitizeThreadKey,
  resolveThreadIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});

describe('thread key helpers', () => {
  it('sanitizeThreadKey replaces dots with dashes', () => {
    expect(sanitizeThreadKey('1772771784.037519')).toBe('1772771784-037519');
  });

  it('sanitizeThreadKey handles multiple dots', () => {
    expect(sanitizeThreadKey('a.b.c')).toBe('a-b-c');
  });

  it('unsanitizeThreadKey restores the last dash to a dot', () => {
    expect(unsanitizeThreadKey('1772771784-037519')).toBe('1772771784.037519');
  });

  it('sanitize and unsanitize round-trip correctly', () => {
    const ts = '1772771784.037519';
    expect(unsanitizeThreadKey(sanitizeThreadKey(ts))).toBe(ts);
  });

  it('resolveThreadIpcPath without threadKey returns group-level path', () => {
    const result = resolveThreadIpcPath('main');
    expect(result).toEqual(resolveGroupIpcPath('main'));
  });

  it('resolveThreadIpcPath with threadKey appends thread subdirectory', () => {
    const result = resolveThreadIpcPath('main', '1772771784-037519');
    const groupPath = resolveGroupIpcPath('main');
    expect(result).toBe(path.resolve(groupPath, '1772771784-037519'));
  });
});
