import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimePreferences, readRuntimeDataEnvironment } from '../src/runtime-preferences';
const root = path.resolve(import.meta.dir, '../../.test-data/desktop-runtime-preferences');
const directories: string[] = [];
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { mkdirSync(root, { recursive: true }); const value = mkdtempSync(path.join(root, 'case-')); directories.push(value); return value; }
describe('desktop runtime configuration', () => {
  test('persists one canonical automatic restart preference across new instances', () => {
    const home = directory();
    const preferences = new RuntimePreferences(home);
    expect(preferences.read().autoRestart).toBe(true);
    preferences.setAutoRestart(false);
    expect(new RuntimePreferences(home).read().autoRestart).toBe(false);
    preferences.setAutoRestart(true);
    expect(new RuntimePreferences(home).read().autoRestart).toBe(true);
  });
  test('reads updated data directory on every launch without overriding unrelated environment', () => {
    const env = path.join(directory(), '.env');
    writeFileSync(env, 'CSS_ROOT_FILE_PATH=/old/path\nXPOD_PORT=9999\n');
    expect(readRuntimeDataEnvironment(env)).toEqual({ CSS_ROOT_FILE_PATH: '/old/path' });
    writeFileSync(env, 'CSS_ROOT_FILE_PATH="/new/data path"\nXPOD_PORT=9999\n');
    expect(readRuntimeDataEnvironment(env)).toEqual({ CSS_ROOT_FILE_PATH: '/new/data path' });
  });
});
