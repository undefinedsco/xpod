import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

/** Directly owned real process probes only the SQLite exclusion primitive, not full Xpod qualification. */
export function authoritySqlitePeerAdmission(runtime: 'bun' | 'node', databasePath: string): boolean {
  const open = runtime === 'bun'
    ? "new (require('bun:sqlite').Database)(process.argv[1])"
    : "new (require('node:sqlite').DatabaseSync)(process.argv[1])";
  const script = `
    const db = ${open};
    let admitted = false;
    try {
      db.exec('PRAGMA busy_timeout = 0');
      try { db.exec('BEGIN IMMEDIATE'); admitted = true; db.exec('ROLLBACK'); }
      catch (error) {
        if (!/busy|locked/i.test(String(error.message))) throw error;
      }
    } finally { db.close(); }
    process.stdout.write(JSON.stringify({ admitted }));
  `;
  const result = spawnSync(runtime, [ '-e', script, databasePath ], { encoding: 'utf8', timeout: 5000 });
  expect(result.error, 'own peer must finish without a spawn or timeout error').toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { admitted: boolean }).admitted;
}
