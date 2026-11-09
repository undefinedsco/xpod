import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {exportSessionSafeEvidence} from '../../scripts/accept-service-image-modes';

/** The matrix keeps the child's OWN already-safe browser failure evidence when the
 * browser command fails. These tests call the REAL exporter and its REAL bounded
 * reader: an existing safe file is exported verbatim, an absent one stays
 * honestly absent, unsafe members are refused, and the original command error is
 * never replaced by an export outcome. No fabrication and no raw child output. */

const safeRoot = () => {
  const parent = join(import.meta.dir, '../../.test-data/browser-failure-safe-retention');
  mkdirSync(parent, {recursive: true});
  return mkdtempSync(join(parent, 'case-'));
};
const collect = async (root: string, destination = 'session-cloud-renew') => {
  const exported = new Map<string, Buffer>();
  await exportSessionSafeEvidence(root, async (relative, bytes) => { exported.set(relative, bytes); }, destination);
  return exported;
};

test('an existing safe lifecycle record is exported verbatim under the session destination', async () => {
  const root = safeRoot();
  try {
    const lifecycle = {status: 'failed', exitCode: 1, hostCleanup: []};
    writeFileSync(join(root, 'lifecycle.safe.json'), JSON.stringify(lifecycle), {mode: 0o600});
    const exported = await collect(root);
    expect([...exported.keys()]).toEqual([join('session-cloud-renew', 'lifecycle.safe.json')]);
    expect(JSON.parse(exported.get(join('session-cloud-renew', 'lifecycle.safe.json'))!.toString())).toEqual(lifecycle);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('an absent safe report stays honestly absent instead of being fabricated', async () => {
  const root = safeRoot();
  try {
    writeFileSync(join(root, 'lifecycle.safe.json'), JSON.stringify({exitCode: 1}), {mode: 0o600});
    const exported = await collect(root);
    expect([...exported.keys()]).toEqual([join('session-cloud-renew', 'lifecycle.safe.json')]);
    expect(existsSync(join(root, 'session.safe.json'))).toBe(false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('a symlinked safe member is refused rather than followed', async () => {
  const root = safeRoot();
  const outside = join(root, '..', `outside-${process.pid}.json`);
  try {
    writeFileSync(outside, '{"status":"failed"}', {mode: 0o600});
    symlinkSync(outside, join(root, 'lifecycle.safe.json'));
    expect((await collect(root)).size).toBe(0);
  } finally { rmSync(outside, {force: true}); rmSync(root, {recursive: true, force: true}); }
});

test('secret-shaped safe content is never exported', async () => {
  const root = safeRoot();
  try {
    writeFileSync(join(root, 'session.safe.json'), JSON.stringify({refresh_token: 'not-exportable'}), {mode: 0o600});
    expect((await collect(root)).size).toBe(0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('retention never masks or replaces the original command failure', async () => {
  const root = safeRoot();
  try {
    writeFileSync(join(root, 'lifecycle.safe.json'), JSON.stringify({exitCode: 1}), {mode: 0o600});
    const run = async (): Promise<void> => {
      try { throw new Error('Owned command failed: browser-cloud-renew'); }
      finally { await collect(root); }
    };
    await expect(run()).rejects.toThrow('Owned command failed: browser-cloud-renew');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('a failing export writer is swallowed so the command outcome still wins', async () => {
  const root = safeRoot();
  try {
    writeFileSync(join(root, 'lifecycle.safe.json'), JSON.stringify({exitCode: 1}), {mode: 0o600});
    // The exporter is total: it resolves even when the writer rejects, so a
    // retention mistake can never replace the original command error.
    await expect(exportSessionSafeEvidence(root, async () => { throw new Error('export budget exceeded'); }, 'session-cloud-renew')).resolves.toBeUndefined();
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('evidence comes from the safe tree, never from raw private logs', async () => {
  const root = safeRoot();
  try {
    // The child keeps raw logs in the sibling private-session directory, never in
    // the safe output tree. The exporter must not reach for them.
    writeFileSync(join(root, 'lifecycle.safe.json'), JSON.stringify({exitCode: 1}), {mode: 0o600});
    mkdirSync(join(root, '..', `private-${process.pid}`), {mode: 0o700, recursive: true});
    const raw = join(root, '..', `private-${process.pid}`, 'stdout.private.log');
    writeFileSync(raw, 'Bearer secret-token', {mode: 0o600});
    const exported = await collect(root);
    expect([...exported.keys()]).toEqual([join('session-cloud-renew', 'lifecycle.safe.json')]);
    expect([...exported.values()].some(bytes => bytes.toString().includes('secret-token'))).toBe(false);
    rmSync(join(root, '..', `private-${process.pid}`), {recursive: true, force: true});
  } finally { rmSync(root, {recursive: true, force: true}); }
});
