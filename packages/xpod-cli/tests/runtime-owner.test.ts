import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withModuleOwnedLock } from '../src/module-owned-lock';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const runtime of ['bun', 'node']) test(`${runtime}: failed close retains a live lock owner after every HTTP handle closes`, async () => {
  const parent = path.resolve('.test-data/runtime-owner'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'case-'));
  const lock = path.join(root, 'css.lock'); const ready = path.join(root, 'ready'); const failed = path.join(root, 'failed');
  const entry = path.join(root, 'driver.ts'); const payload = path.join(root, 'driver.mjs');
  await writeFile(entry, `
import { createRequire } from 'node:module'; globalThis.require=createRequire(import.meta.url);
const {writeFile}=await import('node:fs/promises');
const {runForegroundModuleRuntime}=await import(${JSON.stringify(path.join(packageRoot, 'src/commands/module-runtime.ts'))});
const {withModuleOwnedLock}=await import(${JSON.stringify(path.join(packageRoot, 'src/module-owned-lock.ts'))});
const {NodeRuntimeHost}=await import(${JSON.stringify(path.resolve(packageRoot, '../../src/runtime/host/node/NodeRuntimeHost.ts'))});
class Host extends NodeRuntimeHost {
  calls=0;
  async listen(server, endpoint) { await super.listen(server,endpoint); await writeFile(${JSON.stringify(ready)},String(process.pid)); }
  async close(server, endpoint) { if (++this.calls===1) { await super.close(server,endpoint); await writeFile(${JSON.stringify(failed)},'all HTTP handles closed'); throw Error('Controlled confirmation failure'); } }
}
await withModuleOwnedLock(${JSON.stringify(lock)},()=>runForegroundModuleRuntime({modules:[],baseUrl:'http://localhost/',port:0,bindHost:'127.0.0.1',runtimeHost:new Host()}));
`);
  const built = spawnSync('bun', ['build', '--target=node', '--format=esm', '--outfile', payload, entry], { cwd: packageRoot, encoding: 'utf8' });
  expect(built.status).toBe(0);
  const child = spawn(runtime, [payload], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
  let closed = false;
  const completion = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  const waitFile = async (file: string) => {
    for (let i = 0; i < 200 && !closed; i++) {
      try { return await readFile(file, 'utf8'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Owner failed to reach receipt: ' + stderr);
  };
  try {
    expect(Number(await waitFile(ready))).toBe(child.pid!);
    child.kill('SIGTERM'); expect(await waitFile(failed)).toBe('all HTTP handles closed');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    expect(await withModuleOwnedLock(lock, async () => null).then(() => null, cause => cause.code)).toBe('module_busy');
    child.kill('SIGTERM'); expect(await completion).toEqual({ code: 1, signal: null });
    expect(stderr).toContain('module leases retained');
    expect(await withModuleOwnedLock(lock, async () => 'released')).toBe('released');
  } finally {
    if (!closed) child.kill('SIGKILL');
    await completion; await rm(root, { recursive: true, force: true });
  }
}, 10000);
