import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = createRequire(import.meta.url)('../../scripts/lib/owned-mode-command.cjs');

test('nested cancellation drains the owned browser group before B exits and parent closes', async () => {
  const parent = path.resolve('.test-data/session-nested-cancel');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'owned-'));
  const ready = path.join(root, 'ready');
  const record = path.join(root, 'b.safe.json');
  const wrapper = fileURLToPath(new URL('./runOwnedSessionCommand.ts', import.meta.url));
  const childFile = path.join(root, 'b.ts');
  const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  writeFileSync(childFile, `import {runOwnedSessionCommand} from ${JSON.stringify(wrapper)};
    import {writeFileSync} from 'node:fs';
    const r=await runOwnedSessionCommand(process.execPath,['-e',${JSON.stringify(grandchild)}],{cwd:process.cwd(),env:process.env,timeoutMs:5000,outputBytes:4096});
    writeFileSync(${JSON.stringify(record)},JSON.stringify(r.record),{mode:0o600});
    process.exitCode=r.record.cancelled?1:2;`, { mode: 0o600 });
  const cancellation = new AbortController();
  let command: Promise<any> | undefined;
  let cancelledAfterReady = false;
  try {
    command = helper.runOwnedModeCommand(process.execPath, [childFile], {
      cwd: process.cwd(), env: process.env, timeoutMs: 7000, outputBytes: 4096,
      signal: cancellation.signal, terminationGraceMs: 10000,
    });
    const deadline = Date.now() + 3000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(ready), true, 'nested child must be observed before cancellation');
    cancelledAfterReady = true;
    cancellation.abort();
    const result = await command;
    assert.equal(existsSync(record), true, 'B must finish its child wait/close before parent escalation');
    const nested = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(nested.cancelled, true);
    assert.equal(nested.waitKnown, true);
    assert.equal(nested.closeObserved, true);
    assert.equal(nested.groupAbsent, true);
    assert.equal(nested.code, null);
    assert.equal(nested.signal, 'SIGKILL');
    assert.equal(result.record.code, 1);
    assert.equal(result.record.signal, null);
    assert.equal(result.record.cancelled, true);
    assert.equal(result.record.waitKnown, true);
    assert.equal(result.record.closeObserved, true);
    assert.equal(result.record.groupAbsent, true);
    assert.equal(result.record.ownershipUnknown, false);
    assert.equal(result.record.forcedCleanup, false);
    console.log(JSON.stringify({ kind: 'nested-session-cancel-safe-evidence', nested, parent: result.record }));
  } finally {
    cancellation.abort();
    if (command) await command;
    // Clean only this test's recorded grandchild in a failed old-helper run.
    if (existsSync(ready)) {
      const pid = Number(readFileSync(ready, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    if (existsSync(record) && cancelledAfterReady) rmSync(root, { recursive: true, force: true });
    // Failure without B's final record preserves this owned private diagnostic root.
  }
});
