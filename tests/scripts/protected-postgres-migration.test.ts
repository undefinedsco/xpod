import { describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { quoteIdentifier, quoteLiteral, roleStatements, runProtectedPostgresCommand } from '../../scripts/lib/protected-postgres-migration';
import { runProtectedMigrationFixture } from '../../scripts/test-protected-postgres-migration';
function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

describe('protected PostgreSQL migration', () => {
  it('quotes catalog names and values without converting them into SQL statements', () => {
    expect(quoteIdentifier('role"; DROP ROLE postgres; --')).toBe('"role""; DROP ROLE postgres; --"');
    expect(quoteLiteral("secret'; SELECT 1; --")).toBe("'secret''; SELECT 1; --'");
    const statements = roleStatements({ rolname: 'quoted"role', rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true, rolreplication: false, rolbypassrls: false, rolconnlimit: 3, rolpassword: "private'value", rolvaliduntil: null, comment: null, rolconfig: ['search_path=rdf_a, public'] }, true);
    expect(statements[0]).toContain('CREATE ROLE "quoted""role" WITH NOSUPERUSER NOINHERIT');
    expect(statements[0]).toContain("PASSWORD 'private''value'");
    expect(statements).toContain('ALTER ROLE "quoted""role" SET "search_path" TO \'rdf_a, public\'');
  });

  it.skipIf(process.env.XPOD_RUN_PROTECTED_PG_FIXTURE !== '1')('restores an independent owned PG16 fixture into empty PG17 and proves cleanup', async () => {
    const { report } = await runProtectedMigrationFixture();
    expect(report.cleanup).toEqual({ containersAbsent: true, volumesAbsent: true, networkAbsent: true });
    expect(report.receipts.every(receipt => receipt.actualWait && receipt.rawClosed && receipt.groupAbsent)).toBe(true);
    expect(report.ok).toBe(true);
  }, 240_000);

  it('closes a failed wx log and saves a failure receipt without leaving its process group', async () => {
    const root = path.resolve('.test-data/protected-pg-migration', `log-error-${randomUUID()}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path.join(root, 'log.stdout.private.log'), 'owned pre-existing log', { mode: 0o600 });
      await expect(runProtectedPostgresCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.env, root, 'log', { commandTimeoutMs: 2000 })).rejects.toThrow();
      const receipt = JSON.parse(await readFile(path.join(root, 'log.receipt.private.json'), 'utf8'));
      expect(receipt.groupAbsent).toBe(true);
      expect(receipt.logClosureFailed).toBe(true);
      expect(await readFile(path.join(root, 'log.stdout.private.log'), 'utf8')).toBe('owned pre-existing log');
      expect(processAbsent(-receipt.pid)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it('removes a real closed-stdio descendant that ignores TERM after the parent exits', async () => {
    const root = path.resolve('.test-data/protected-pg-migration', `descendant-${randomUUID()}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const pidFile = path.join(root, 'owned-child.pid');
    const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,parentPid:process.ppid,birthTime:Date.now(),termHandlerInstalled:true}),{mode:0o600});setInterval(()=>{},1000);`;
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});child.unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)}))process.exit(0)},10);`;
    try {
      await expect(runProtectedPostgresCommand(process.execPath, ['-e', code], process.env, root, 'descendant', { commandTimeoutMs: 3000 })).rejects.toThrow();
      const birth = JSON.parse(await readFile(pidFile, 'utf8'));
      expect(birth.pid).toBeGreaterThan(0);
      expect(birth.termHandlerInstalled).toBe(true);
      const receipt = JSON.parse(await readFile(path.join(root, 'descendant.receipt.private.json'), 'utf8'));
      expect(receipt.actualExit).toBe(0);
      expect(receipt.interrupted).toBe(true);
      expect(receipt.groupAbsent).toBe(true);
      expect(birth.parentPid).toBe(receipt.pid);
      expect(processAbsent(-receipt.pid)).toBe(true);
      expect(processAbsent(birth.pid)).toBe(true);
      for (const channel of ['stdout','stderr']) expect(createHash('sha256').update(await readFile(path.join(root,receipt[`${channel}Path`]))).digest('hex')).toBe(receipt[`${channel}SHA256`]);
    } finally {
      // A failed assertion must still clean only the descendant born by this fixture.
      const birth = await readFile(pidFile, 'utf8').then(value => JSON.parse(value)).catch(() => undefined);
      if (birth && !processAbsent(birth.pid)) {
        try { process.kill(-birth.parentPid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        for (let attempt = 0; attempt < 40 && !processAbsent(birth.pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
        if (!processAbsent(birth.pid)) throw new Error('owned descendant cleanup failed');
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
