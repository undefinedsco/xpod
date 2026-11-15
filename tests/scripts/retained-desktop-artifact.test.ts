import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from 'bun:test';

const root = path.resolve(import.meta.dir, '../..');
const script = path.join(root, 'scripts/diagnostics/verify-retained-desktop-artifact.py');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function meta(over: Record<string, unknown> = {}) {
  return { id: 7, name: 'desktop-launch-diagnostic-abc', size_in_bytes: 10,
    digest: `sha256:${'a'.repeat(64)}`, expired: false,
    workflow_run: { id: 9, head_sha: 'b'.repeat(40), repository_id: 11 }, ...over };
}
function run(mode: 'metadata' | 'extract', args: string[]) {
  return spawnSync('/usr/bin/python3', [script, mode, ...args], { encoding: 'utf8' });
}
const goodMeta = (file: string, row = meta()) => { writeFileSync(file, JSON.stringify(row)); return file; };
const metaArgs = ['--id', '7', '--name', 'desktop-launch-diagnostic-abc', '--sha256', 'a'.repeat(64),
  '--size', '10', '--run', '9', '--run-source', 'b'.repeat(40), '--repository-id', '11'];

test('metadata mode accepts the exact pinned identity and rejects every drift', () => {
  const dir = mkdtempSync(path.join(root, '.test-data/retained-artifact-test-'));
  try {
    const ok = run('metadata', [goodMeta(path.join(dir, 'ok.json')), ...metaArgs]);
    expect(ok.status).toBe(0);
    for (const [label, row] of [
      ['expired', meta({ expired: true })],
      ['wrong id', meta({ id: 8 })],
      ['wrong digest', meta({ digest: `sha256:${'c'.repeat(64)}` })],
      ['wrong size', meta({ size_in_bytes: 11 })],
      ['wrong run source', meta({ workflow_run: { id: 9, head_sha: 'd'.repeat(40), repository_id: 11 } })],
      ['wrong repository', meta({ workflow_run: { id: 9, head_sha: 'b'.repeat(40), repository_id: 12 } })],
    ] as const) {
      const bad = run('metadata', [goodMeta(path.join(dir, `${label}.json`), row as any), ...metaArgs]);
      expect({ label, status: bad.status }).toEqual({ label, status: 1 });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extract mode verifies the outer stream hash before reading members', () => {
  const dir = mkdtempSync(path.join(root, '.test-data/retained-artifact-test-'));
  try {
    const outer = path.join(dir, 'outer.zip');
    writeFileSync(outer, 'not-a-zip');
    const out = path.join(dir, 'out');
    mkdirSync(out);
    const args = [outer, out, '--sha256', sha(Buffer.from('different')), '--size', '9',
      '--zip-member', 'xpod/xpod/desktop/release/a.zip', '--zip-size', '1', '--zip-sha256', 'e'.repeat(64),
      '--dmg-member', 'xpod/xpod/desktop/release/a.dmg', '--dmg-size', '1', '--dmg-sha256', 'f'.repeat(64)];
    const result = run('extract', args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outer sha256 mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Build a small zip with the original nested layout and selected negative cases. */
function makeZip(file: string, options: { zip?: Buffer; dmg?: Buffer;
  duplicate?: boolean; symlink?: boolean } = {}): { zip: Buffer; dmg: Buffer; outer: Buffer } {
  const zipBytes = options.zip ?? Buffer.from('inner-zip-bytes');
  const dmgBytes = options.dmg ?? Buffer.from('inner-dmg-bytes');
  const py = `
import sys, zipfile
mode, out, z, d = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
extra = sys.argv[5]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as a:
    def add(name, data, attr=None):
        i = zipfile.ZipInfo(name); i.external_attr = attr if attr is not None else (0o100644 << 16)
        a.writestr(i, data)
    if extra == 'symlink':
        add('xpod/xpod/desktop/release/Xpod-inner.zip', b'Xpod-inner.dmg', 0o120777 << 16)
    else:
        add('xpod/xpod/desktop/release/Xpod-inner.zip', open(z,'rb').read())
    add('xpod/xpod/desktop/release/Xpod-inner.dmg', open(d,'rb').read())
    if extra == 'duplicate':
        add('xpod/xpod/desktop/release/Xpod-inner.zip', open(z,'rb').read())
    elif extra != 'symlink':
        add('../ignored', b'escape')
        add('safe.json', b'{"ok":true}')
        add('diagnostic-not-qualification.txt', b'DIAGNOSTIC_NOT_QUALIFICATION')
`;
  const script = path.join(path.dirname(file), 'mk.py');
  writeFileSync(script, py);
  writeFileSync(file + '.z', zipBytes); writeFileSync(file + '.d', dmgBytes);
  const res = spawnSync('/usr/bin/python3', [script, 'zip', file, file + '.z', file + '.d',
    options.duplicate ? 'duplicate' : options.symlink ? 'symlink' : 'extra']);
  if (res.status !== 0) throw new Error(res.stderr.toString());
  return { zip: zipBytes, dmg: dmgBytes, outer: require('node:fs').readFileSync(file) };
}

test('extract accepts the two exact members and ignores extra outer members', () => {
  const dir = mkdtempSync(path.join(root, '.test-data/retained-artifact-test-'));
  try {
    const outer = path.join(dir, 'outer.zip');
    const built = makeZip(outer);
    const out = path.join(dir, 'out');
    mkdirSync(out);
    const res = run('extract', [outer, out,
      '--sha256', sha(built.outer), '--size', String(built.outer.length),
      '--zip-member', 'xpod/xpod/desktop/release/Xpod-inner.zip', '--zip-size', String(built.zip.length), '--zip-sha256', sha(built.zip),
      '--dmg-member', 'xpod/xpod/desktop/release/Xpod-inner.dmg', '--dmg-size', String(built.dmg.length), '--dmg-sha256', sha(built.dmg)]);
    expect(res.status).toBe(0);
    const fs = require('node:fs');
    expect(fs.readFileSync(path.join(out, 'Xpod-inner.zip'))).toEqual(built.zip);
    expect(fs.readFileSync(path.join(out, 'Xpod-inner.dmg'))).toEqual(built.dmg);
    // Nothing else was extracted: no traversal, no safe JSON side files.
    // Flattened basenames only; no nested dirs, no ignored side files.
    expect(fs.readdirSync(out).sort()).toEqual(['Xpod-inner.dmg', 'Xpod-inner.zip']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extract refuses a duplicate or symlink selected member and a wrong inner hash', () => {
  const dir = mkdtempSync(path.join(root, '.test-data/retained-artifact-test-'));
  try {
    for (const mode of ['duplicate', 'symlink'] as const) {
      const outer = path.join(dir, `${mode}.zip`);
      const built = makeZip(outer, mode === 'duplicate' ? { duplicate: true } : { symlink: true });
      const out = path.join(dir, `out-${mode}`); mkdirSync(out);
      const res = run('extract', [outer, out,
        '--sha256', sha(built.outer), '--size', String(built.outer.length),
        '--zip-member', 'xpod/xpod/desktop/release/Xpod-inner.zip', '--zip-size', String(built.zip.length), '--zip-sha256', sha(built.zip),
        '--dmg-member', 'xpod/xpod/desktop/release/Xpod-inner.dmg', '--dmg-size', String(built.dmg.length), '--dmg-sha256', sha(built.dmg)]);
      expect({ mode, status: res.status }).toEqual({ mode, status: 1 });
      expect(res.stderr).toContain(mode === 'duplicate' ? 'duplicate member names' : 'not a regular member');
    }
    const outer = path.join(dir, 'badhash.zip');
    const built = makeZip(outer, {});
    const out = path.join(dir, 'out-bad'); mkdirSync(out);
    const bad = run('extract', [outer, out,
      '--sha256', sha(built.outer), '--size', String(built.outer.length),
      '--zip-member', 'xpod/xpod/desktop/release/Xpod-inner.zip', '--zip-size', String(built.zip.length), '--zip-sha256', 'e'.repeat(64),
      '--dmg-member', 'xpod/xpod/desktop/release/Xpod-inner.dmg', '--dmg-size', String(built.dmg.length), '--dmg-sha256', sha(built.dmg)]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Xpod-inner.zip sha256 mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extract selects by exact nested path, never by basename or prefix guess', () => {
  const dir = mkdtempSync(path.join(root, '.test-data/retained-artifact-test-'));
  try {
    const outer = path.join(dir, 'outer.zip');
    const built = makeZip(outer, {});
    const out = path.join(dir, 'out'); mkdirSync(out);
    // Wrong prefix, SAME basename: must not be accepted by basename matching.
    const wrong = run('extract', [outer, out,
      '--sha256', sha(built.outer), '--size', String(built.outer.length),
      '--zip-member', 'elsewhere/Xpod-inner.zip', '--zip-size', String(built.zip.length), '--zip-sha256', sha(built.zip),
      '--dmg-member', 'xpod/xpod/desktop/release/Xpod-inner.dmg', '--dmg-size', String(built.dmg.length), '--dmg-sha256', sha(built.dmg)]);
    expect(wrong.status).toBe(1);
    // Absolute / traversal member paths are refused before extraction.
    for (const bad of ['/xpod/Xpod-inner.zip', 'xpod/../Xpod-inner.zip', 'xpod/xpod/Xpod-inner.zip']) {
      const res = run('extract', [outer, out,
        '--sha256', sha(built.outer), '--size', String(built.outer.length),
        '--zip-member', bad, '--zip-size', String(built.zip.length), '--zip-sha256', sha(built.zip),
        '--dmg-member', 'xpod/xpod/desktop/release/Xpod-inner.dmg', '--dmg-size', String(built.dmg.length), '--dmg-sha256', sha(built.dmg)]);
      expect({ member: bad, status: res.status }).toEqual({ member: bad, status: 1 });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
