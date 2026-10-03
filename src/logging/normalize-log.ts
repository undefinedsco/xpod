import { stripVTControlCharacters } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** CSS/Winston and Components.js headers; message text must never determine its source. */
const LOGGER_HEADER = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+(?:\[[^\]\r\n]+\]\s+)+(debug|info|warn|error):(?:\s|$)/u;

export function normalizeLog(message: string, fallbackLevel: LogLevel): { message: string; level: LogLevel } {
  const plain = stripVTControlCharacters(message).trim();
  const level = LOGGER_HEADER.exec(plain)?.[1] as LogLevel | undefined;
  return { message: plain, level: level ?? fallbackLevel };
}
