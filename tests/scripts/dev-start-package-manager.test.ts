import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

describe('dev-start package manager contract', () => {
  it('uses bun directly instead of yarn/corepack', async () => {
    const script = await readFile(path.join(root, 'scripts/dev-start.sh'), 'utf8');

    expect(script).toContain('bun run dev:cloud');
    expect(script).toContain('bun run dev:seed');
    expect(script).toContain('bun run dev:test');
    expect(script).not.toMatch(/\byarn\b/);
  });
});
