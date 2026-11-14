import { expect, test } from 'bun:test';
import { createModuleInstallDiagnostics, MODULE_INSTALL_PHASES, type ModuleInstallDiagnostic } from '../src/module-install-diagnostics';

test('diagnostics: emits a synchronous start before action and preserves exact thrown object', async () => {
  const events: ModuleInstallDiagnostic[] = [];
  const diagnostics = createModuleInstallDiagnostics(event => events.push(event));
  const sentinel = new Error('private URL or credential never emitted'); let caught: unknown;
  try { await diagnostics.run('metadata', () => { expect(events.map(event => event.state)).toEqual(['started']); throw sentinel; }); }
  catch (error) { caught = error; }
  expect(caught).toBe(sentinel); expect(events.map(event => event.state)).toEqual(['started', 'failed']);
  expect(JSON.stringify(events).includes(sentinel.message)).toBe(false);
});
test('diagnostics: caps output at 64 fixed-shape lines and duplicate finish is ignored', async () => {
  const events: ModuleInstallDiagnostic[] = []; const diagnostics = createModuleInstallDiagnostics(event => events.push(event));
  for (let i = 0; i < 50; i++) { const finish = diagnostics.start('verify-manifest'); finish('completed'); finish('failed'); }
  expect(events.length).toBe(64);
  expect(events.every(event => MODULE_INSTALL_PHASES.includes(event.phase) && event.elapsedMs >= 0)).toBe(true);
  expect(events.some(event => event.state === 'failed')).toBe(false);
  await expect(createModuleInstallDiagnostics().run('cleanup', () => 7)).resolves.toBe(7);
  const invalid: ModuleInstallDiagnostic[] = [];
  await expect(createModuleInstallDiagnostics(event => invalid.push(event)).run('private-path' as any, () => 9)).resolves.toBe(9);
  expect(invalid).toEqual([]);
});

test('diagnostics: public CLI flag changes stderr only and default emits no diagnostics', async () => {
  const { spawnSync } = await import('node:child_process');
  const core = new URL('../src/core.ts', import.meta.url).pathname;
  const execute = (enabled: boolean) => spawnSync('bun', ['-e', `
    import { runCli } from ${JSON.stringify(core)};
    const event = {kind:'module-install-phase',phase:'metadata',state:'started',elapsedMs:0};
    const store = {install:async(id,version,observer)=>{observer?.(event);return {id,version};}};
    await runCli(['module','install','afs','--version','0.1.0',...${JSON.stringify(enabled ? ['--diagnostics'] : [])}],store);
  `], { encoding: 'utf8', timeout: 10_000 });
  const quiet = execute(false), diagnostic = execute(true);
  expect(quiet.status).toBe(0); expect(diagnostic.status).toBe(0);
  expect(quiet.stderr).toBe('');
  expect(diagnostic.stdout).toBe(quiet.stdout);
  expect(JSON.parse(quiet.stdout).data).toEqual({ id: 'afs', version: '0.1.0' });
  expect(JSON.parse(diagnostic.stderr)).toEqual({ kind: 'module-install-phase', phase: 'metadata', state: 'started', elapsedMs: 0 });
});
