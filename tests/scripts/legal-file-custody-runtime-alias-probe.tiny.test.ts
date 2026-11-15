/** Runtime hardlink-alias behaviour, exercised in an ISOLATED SUBPROCESS.
 *
 * No `mock.module` runs in this process, so nothing can leak into the rest of a
 * full test run. The child is a tiny inline script whose only purpose is to make
 * `realpathSync` name a hardlink sibling for one observation — the documented
 * multicall behaviour. It then prints what a realpath-based capture would retain
 * versus what the shipped capture retains, and the parent asserts the difference.
 *
 * The "old behaviour" control is three inline lines (`realpathSync`), not a copy
 * of the product module and not a shipped historical source fixture.
 */
import {test, expect} from 'bun:test';
import {mkdtemp, writeFile, link, rm, realpath} from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve('.test-data/legal-file-custody-alias-probe');
// Resolved from this file's own location without relying on Bun-specific
// `import.meta.dir`, so the test also typechecks under plain tsc.
const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/lib/independent-admission/legal-file-custody');

const child = (file: string, alias: string) => `
const fs = require('node:fs');
const real = fs.realpathSync;
fs.realpathSync = (target, ...rest) =>
  String(target) === ${JSON.stringify(file)} ? ${JSON.stringify(alias)} : real(target, ...rest);
// OLD behaviour: the retained path IS realpathSync(requested).
const oldRealPath = fs.realpathSync(${JSON.stringify(file)});
// NEW behaviour: the shipped capture, loaded after the runtime shim is installed.
const mod = require(${JSON.stringify(candidate)});
const id = mod.captureLegalFileIdentity(${JSON.stringify(file)});
process.stdout.write(JSON.stringify({
  oldRealPath,
  newRealPath: id.realPath,
  stable: (() => { try { mod.assertLegalFileIdentity(id); return true; } catch { return false; } })(),
  candidatePath: ${JSON.stringify(candidate)},
}));
`;

test('a hardlink-alias realpath is ignored by the shipped capture but breaks a realpath-based one', async () => {
  await (await import('node:fs/promises')).mkdir(root, {recursive: true});
  const d = await realpath(await mkdtemp(path.join(root, 'case-')));
  try {
    const file = path.join(d, 'python3.11'), alias = path.join(d, 'git');
    await writeFile(file, '#!/bin/sh\n'); await link(file, alias);
    const a = lstatSync(file, {bigint: true}), b = lstatSync(alias, {bigint: true});
    expect(b.ino).toBe(a.ino); expect(b.dev).toBe(a.dev);   // genuine hardlink pair

    const raw = execFileSync(process.execPath, ['-e', child(file, alias)], {encoding: 'utf8', timeout: 30000});
    const result = JSON.parse(raw);

    // The runtime really did answer the alias for this requested leaf.
    expect(result.oldRealPath).toBe(alias);
    // A realpath-based capture would therefore retain a different path than the
    // requested one — the defect this fix removes.
    expect(result.oldRealPath).not.toBe(file);
    // The shipped capture retains the requested leaf and stays self-consistent.
    expect(result.newRealPath).toBe(file);
    expect(result.stable).toBe(true);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('without the runtime alias the two agree, so the probe is measuring the alias', async () => {
  await (await import('node:fs/promises')).mkdir(root, {recursive: true});
  const d = await realpath(await mkdtemp(path.join(root, 'case-')));
  try {
    const file = path.join(d, 'plain.original');
    await writeFile(file, 'bytes');
    const raw = execFileSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const mod = require(${JSON.stringify(candidate)});
      const id = mod.captureLegalFileIdentity(${JSON.stringify(file)});
      process.stdout.write(JSON.stringify({real: fs.realpathSync(${JSON.stringify(file)}), retained: id.realPath}));
    `], {encoding: 'utf8', timeout: 30000});
    const result = JSON.parse(raw);
    expect(result.retained).toBe(file);
    expect(result.real).toBe(file);
  } finally { await rm(d, {recursive: true, force: true}); }
});
