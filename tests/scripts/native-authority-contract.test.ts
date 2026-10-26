import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Contract regression for the applied AFS native authority.
 *
 * The four platform rows must stay bound to the ACTUAL reviewed attempt-2
 * artifacts (run 38104482639, source 5f037c09…). This pins the shape and the
 * shared sourceKit identity so a later edit cannot silently point a platform at
 * a superseded artifact id, and so a "fixed" hash cannot be claimed without the
 * authority file actually carrying it.
 */
const ROOT = path.resolve(import.meta.dir, '../..');
const AUTHORITY = 'scripts/agentfs-native-ci/mounted/native-authority.json';

describe('AFS native authority contract', () => {
  const raw = readFileSync(path.join(ROOT, AUTHORITY));
  const authority = JSON.parse(raw.toString('utf8'));

  it('binds the reviewed attempt-2 run and source revision', () => {
    expect(authority.schemaVersion).toBe(1);
    expect(authority.source).toBe('5f037c09bd54980c68406d4a1aa534af14fcbd70');
    expect(authority.run).toBe('38104482639');
  });

  it('declares exactly the four platform artifacts with distinct ids', () => {
    expect(Object.keys(authority.artifacts).sort())
      .toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
    const ids = Object.values(authority.artifacts).map((row: any) => row.id);
    expect(new Set(ids).size).toBe(4);
    for (const row of Object.values(authority.artifacts) as any[]) {
      expect(row.id).toMatch(/^\d+$/u);
      for (const key of ['zip', 'archive', 'helper', 'sourceKit'] as const) {
        expect(row[key]).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
  });

  it('keeps one shared sourceKit identity across all four platforms', () => {
    const kits = new Set(Object.values(authority.artifacts).map((row: any) => row.sourceKit));
    expect(kits.size).toBe(1);
    expect([...kits][0]).toBe('ecb6f332cdec9b85c01ef8a4af4f91ae256e7864dbd1ee812847f4cbca76f132');
  });

  it('is the exact bytes the closed canonical records', () => {
    const canonical: { path: string; sha256: string }[] =
      JSON.parse(readFileSync(path.join(ROOT, 'scripts/lib/independent-admission/consumer-execution-current.json'), 'utf8'));
    const row = canonical.find(entry => entry.path === AUTHORITY);
    expect(row).toBeDefined();
    expect(row!.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});
