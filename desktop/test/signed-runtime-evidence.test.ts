import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifySignedRuntime } from '../scripts/verify-signed-runtime';

test('external post-sign evidence keeps official and final hashes distinct without changing the app', () => {
  const base = path.resolve(import.meta.dir, '../../.test-data/signed-runtime-evidence');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  try {
    const app = path.join(root, 'Fixture.app'), runtime = path.join(app, 'Contents/Resources/runtime');
    const bun = path.join(runtime, 'bin/bun'), cli = path.join(runtime, 'node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs');
    const receipt = path.join(runtime, 'licenses/bun/receipt.json'), home = path.join(root, 'home');
    for (const file of [bun, cli, receipt]) mkdirSync(path.dirname(file), { recursive: true });
    mkdirSync(home); chmodSync(home, 0o700);
    const pin = JSON.parse(readFileSync(path.resolve(import.meta.dir, '../../packages/xpod-cli/licenses/javascript/generated/1.4.2/index.json'), 'utf8'));
    const officialHash = pin.provenance.compiler.executableSha256;
    writeFileSync(bun, 'post-sign fixture bytes; not executable'); writeFileSync(cli, 'normal-cli fixture');
    const authority = JSON.stringify({ executableSha256: officialHash, revision: pin.provenance.revision, runtimePhase: 'pre-sign',
      target: pin.provenance.compiler.platform, version: pin.bunVersion, sourceCommit: pin.provenance.bunCommit, archiveSha256: pin.provenance.compiler.officialArchiveSha256 });
    writeFileSync(receipt, authority);
    const evidence = path.join(root, 'evidence.json');
    const calls: string[] = [];
    const run = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(env.PATH).toBe(''); expect(env.HOME).toBe(home); calls.push(command);
      if (command === '/usr/bin/codesign') return '';
      expect(command).toBe(bun);
      if (args[0] === '--revision') return pin.provenance.revision;
      if (args[0] === '-e') return 'sqlite-ok';
      if (args.includes('list')) return JSON.stringify({ ok: true, code: 'ok', data: [], warnings: [] });
      expect(args).toEqual([cli, '--help']); return 'help';
    };
    verifySignedRuntime(app, evidence, home, run);
    const result = JSON.parse(readFileSync(evidence, 'utf8'));
    expect(statSync(evidence).mode & 0o777).toBe(0o600);
    expect(result.officialArchiveExecutableSha256).toBe(officialHash);
    expect(result.finalSignedExecutableSha256).not.toBe(officialHash);
    expect(result.runtimeManagerProcessLaunchVerified).toBe(false);
    expect(readFileSync(receipt, 'utf8')).toBe(authority);
    expect(readFileSync(bun, 'utf8')).toBe('post-sign fixture bytes; not executable');
    expect(calls.filter(command => command === '/usr/bin/codesign')).toHaveLength(2);
    expect(() => verifySignedRuntime(app, path.join(runtime, 'bad-evidence.json'), home, run)).toThrow('outside');
    const validAuthority = JSON.parse(authority);
    for (const mutation of [{ executableSha256: undefined }, { executableSha256: 'bad' }, { target: 'linux-x64' }, { version: '0' }, { revision: 'wrong' }]) {
      writeFileSync(receipt, JSON.stringify({ ...validAuthority, ...mutation }));
      expect(() => verifySignedRuntime(app, path.join(root, 'invalid-authority.json'), home, run)).toThrow('authority identity');
      expect(() => readFileSync(path.join(root, 'invalid-authority.json'))).toThrow();
    }
    writeFileSync(receipt, authority);
    const outputDir = path.join(root, 'private-output');
    mkdirSync(outputDir, { mode: 0o700 }); chmodSync(outputDir, 0o700);
    const moved = path.join(root, 'held-output');
    let replaced = false;
    const replacingProbe = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
      if (!replaced) {
        replaced = true;
        renameSync(outputDir, moved);
        symlinkSync(runtime, outputDir);
      }
      return run(command, args, env);
    };
    expect(() => verifySignedRuntime(app, path.join(outputDir, 'race.json'), home, replacingProbe)).toThrow('Evidence authority changed');
    expect(readFileSync(path.join(moved, 'race.json'), 'utf8')).toBe('');
    expect(() => readFileSync(path.join(runtime, 'race.json'))).toThrow();
    expect(readFileSync(receipt, 'utf8')).toBe(authority);
    expect(readFileSync(bun, 'utf8')).toBe('post-sign fixture bytes; not executable');

  } finally { rmSync(root, { recursive: true, force: true }); }
});
