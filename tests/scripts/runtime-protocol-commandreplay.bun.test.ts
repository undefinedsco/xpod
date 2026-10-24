// Real commandReplay/ABI-replay executable selection under a genuine Bun parent.
// The production modules are imported for real; only the leaf realpath is made
// to return the sibling hardlink name, reproducing the observed Bun defect
// deterministically inside this child test process.
import {afterEach, expect, test} from 'bun:test';
import {chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {captureLegalFileIdentity, assertLegalFileIdentity, resolveExecutableIdentityPath, executableIdentityMatches}
  from '../../scripts/lib/independent-admission/legal-file-custody';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, {recursive: true, force: true}); });

test('a Bun sibling-hardlink substitution cannot change the commandReplay executable', () => {
  expect(typeof (globalThis as any).Bun).toBe('object'); // genuine Bun parent
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cr-seam-')));
  roots.push(dir);
  const stub = '#!/bin/sh\ncase "$(basename "$0")" in\n git) echo "GIT:$*"; exit 7;;\n *) echo "PY:$*"; exit 0;;\nesac\n';
  const real = path.join(dir, 'python3.11');
  writeFileSync(real, stub); chmodSync(real, 0o755);
  const sibling = path.join(dir, 'git'); linkSync(real, sibling);
  const requested = path.join(dir, 'python3'); symlinkSync('python3.11', requested);

  const original = realpathSync;
  (require('node:fs') as typeof import('node:fs')).realpathSync =
    ((target: string, ...rest: any[]) => (target === requested ? sibling : (original as any)(target, ...rest))) as any;
  try {
    const python = resolveExecutableIdentityPath(requested);
    expect(path.basename(python)).toBe('python3.11');
    expect(executableIdentityMatches(requested, sibling)).toBe(false);
    const identity = captureLegalFileIdentity(python);
    assertLegalFileIdentity(identity);
    expect(execFileSync(python, ['-I', '-S', '-B', '-c', 'x'], {encoding: 'utf8'}).trim())
      .toBe('PY:-I -S -B -c x');
    expect(captureLegalFileIdentity(sibling).ino).toBe(identity.ino);
  } finally {
    (require('node:fs') as typeof import('node:fs')).realpathSync = original;
  }
});
