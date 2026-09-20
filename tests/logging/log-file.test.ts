import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOG_FILE_NAME_PATTERN,
  LOG_FILE_PATTERN,
  resolveCurrentLogFile,
  resolveLogFilePattern,
} from '../../src/logging/log-file';

const ROOT = path.resolve(process.cwd(), '.test-data', 'log-file');

/** Sets a deterministic mtime so "newest" never depends on write order. */
function writeLogFile(directory: string, name: string, mtimeMs: number): string {
  const file = path.join(directory, 'logs', name);
  fs.writeFileSync(file, `entry from ${name}\n`);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

describe('runtime log file resolution', () => {
  beforeAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('resolves the same file name template the runtime writes', () => {
    expect(resolveLogFilePattern('/srv/xpod')).toBe(path.join('/srv/xpod', 'logs', LOG_FILE_NAME_PATTERN));
    expect(LOG_FILE_PATTERN).toBe(`logs/${LOG_FILE_NAME_PATTERN}`);
  });

  it('finds the rotating file that is currently being appended to', () => {
    const base = writeLogFile(ROOT, 'xpod-2026-09-13.log', Date.parse('2026-09-13T19:43:52Z'));
    writeLogFile(ROOT, 'xpod-2026-09-13.log.1', Date.parse('2026-09-13T11:33:07Z'));
    const live = writeLogFile(ROOT, 'xpod-2026-09-13.log.2', Date.parse('2026-09-13T20:28:21Z'));

    // Size rotation leaves the live segment as `.log.2`, not as the base name.
    expect(resolveCurrentLogFile(ROOT)).toBe(live);
    expect(resolveCurrentLogFile(ROOT)).not.toBe(base);
  });

  it('ignores files the runtime does not write', () => {
    // The names the previous implementation guessed at must not win over the
    // rotating file, and unrelated files must not be picked up at all.
    writeLogFile(ROOT, 'combined.log', Date.parse('2026-09-13T23:59:59Z'));
    fs.writeFileSync(path.join(ROOT, 'logs', 'README.md'), 'not a log\n');

    expect(resolveCurrentLogFile(ROOT)).toContain('xpod-2026-09-13.log.2');
  });

  it('reports no log file instead of guessing when the runtime has not written one', () => {
    const empty = path.join(ROOT, 'empty');
    fs.mkdirSync(path.join(empty, 'logs'), { recursive: true });

    expect(resolveCurrentLogFile(empty)).toBeNull();
    expect(resolveCurrentLogFile(path.join(ROOT, 'missing'))).toBeNull();
  });
});
