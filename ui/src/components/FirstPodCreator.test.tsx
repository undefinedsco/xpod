// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('FirstPodCreator', () => {
  test('uses semantic theme tokens for the first-Pod form surface', () => {
    const source = readFileSync(join(process.cwd(), 'ui/src/components/FirstPodCreator.tsx'), 'utf8');

    expect(source).toContain('bg-muted');
    expect(source).toContain('bg-background');
    expect(source).toContain('border-input');
    expect(source).toContain('text-foreground');
    expect(source).toContain('bg-primary');
    expect(source).not.toMatch(/bg-white|bg-zinc|text-zinc|border-zinc|#7C4DFF|#6B3FE8|text-white/);
  });
});
