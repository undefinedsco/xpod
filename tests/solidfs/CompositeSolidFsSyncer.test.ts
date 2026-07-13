import { describe, expect, it, vi } from 'vitest';

import { CompositeSolidFsSyncer } from '../../src/solidfs';
import type { SolidFsChange, SolidFsManifest, SolidFsSyncer } from '../../src/solidfs';

describe('CompositeSolidFsSyncer', () => {
  it('tracks paths accepted by any child and syncs in declaration order', async () => {
    const calls: string[] = [];
    const first: SolidFsSyncer = {
      shouldTrackPath: (relativePath) => relativePath.endsWith('.ttl'),
      sync: vi.fn(async () => {
        calls.push('first');
      }),
    };
    const second: SolidFsSyncer = {
      shouldTrackPath: (relativePath) => relativePath.endsWith('.md'),
      sync: vi.fn(async () => {
        calls.push('second');
      }),
    };
    const syncer = new CompositeSolidFsSyncer({ syncers: [first, second] });

    expect(syncer.shouldTrackPath('notes.md')).toBe(true);
    expect(syncer.shouldTrackPath('data.ttl')).toBe(true);
    expect(syncer.shouldTrackPath('image.png')).toBe(false);

    await syncer.sync(change('notes.md'), manifestFor('https://pod.example/alice/'), { auth: { type: 'solid' } });

    expect(first.sync).toHaveBeenCalledTimes(1);
    expect(second.sync).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['first', 'second']);
  });
});

function change(pathValue: string): SolidFsChange {
  return {
    path: pathValue,
    source: 'pod-http',
    sourcePath: `/tmp/${pathValue}`,
    projection: 'direct',
    type: 'updated',
  };
}

function manifestFor(workspace: string): SolidFsManifest {
  return {
    workspace,
    cwd: '/tmp/workspace',
    projection: 'direct',
    entries: [],
  };
}
