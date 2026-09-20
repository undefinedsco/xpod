/**
 * Canonical location of the runtime log file.
 *
 * Every writer (main entry, runtime bootstrap, API service) and every reader
 * (admin diagnostics) resolves the path through this module. When the reader
 * guessed its own file names instead, the Logs page reported "no log file"
 * while the runtime kept writing to one.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directory, relative to the runtime working directory. */
export const LOG_DIRECTORY = 'logs';

/** File name template; the rotating transport substitutes `%DATE%`. */
export const LOG_FILE_NAME_PATTERN = 'xpod-%DATE%.log';

/** Both segments, for callers that join them onto a working directory themselves. */
export const LOG_FILE_PATTERN = `${LOG_DIRECTORY}/${LOG_FILE_NAME_PATTERN}`;

/** Concrete files the template produces, including rotated siblings such as `xpod-2026-09-13.log.2`. */
const CONCRETE_LOG_FILE_NAME = /^xpod-.*\.log(\.\d+)?$/;

/** Absolute path template handed to the logging transport. */
export function resolveLogFilePattern(cwd: string = process.cwd()): string {
  return path.join(cwd, LOG_DIRECTORY, LOG_FILE_NAME_PATTERN);
}

/**
 * The log file currently being appended to, or `null` when the runtime has not
 * written one yet.
 *
 * Daily rotation produces one file per date and size rotation keeps older
 * segments as `.log.N` next to it, so the live file is identified by
 * modification time rather than by name.
 */
export function resolveCurrentLogFile(cwd: string = process.cwd()): string | null {
  const directory = path.join(cwd, LOG_DIRECTORY);

  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }

  let newest: { file: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!CONCRETE_LOG_FILE_NAME.test(name)) continue;

    const file = path.join(directory, name);
    let mtimeMs: number;
    try {
      const stats = fs.statSync(file);
      if (!stats.isFile()) continue;
      mtimeMs = stats.mtimeMs;
    } catch {
      continue;
    }

    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { file, mtimeMs };
    }
  }

  return newest?.file ?? null;
}
