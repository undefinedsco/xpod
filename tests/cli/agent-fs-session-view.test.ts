import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observeSession } from '../../src/cli/agent-fs/session-view';

const dir = path.resolve('.test-data/agent-fs-session-view');
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('native session observation for status and rg', () => {
  it('distinguishes no session from a corrupt session instead of hiding pending work', () => {
    expect(observeSession(dir).pending).toBe(0);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'session.json'), '{');
    expect(() => observeSession(dir)).toThrow();
    writeFileSync(path.join(dir, 'session.json'), '{}');
    expect(() => observeSession(dir)).toThrow('Invalid native session');
  });

  it('observes a native revision change without creating a second state store', () => {
    mkdirSync(dir, { recursive: true });
    const state = { pod_root: 'https://pod.test/alice/', entries: {}, next_revision: 0 };
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify(state));
    const clean = observeSession(dir);
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ ...state, entries: { 'dirty.txt': { revision: 1 } }, next_revision: 1 }));
    const dirty = observeSession(dir);
    expect(dirty.pending).toBe(1);
    expect(dirty.version).not.toBe(clean.version);
  });
});
