// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('AboutPage', () => {
  test('uses semantic theme tokens instead of light-only colors', () => {
    const source = readFileSync(join(process.cwd(), 'ui/src/pages/AboutPage.tsx'), 'utf8');

    expect(source).toContain('bg-background');
    expect(source).toContain('bg-card');
    expect(source).toContain('text-foreground');
    expect(source).toContain('text-muted-foreground');
    expect(source).toContain('bg-primary');
    expect(source).not.toMatch(/bg-white|bg-zinc|text-zinc|border-zinc|#7C4DFF|#6B3FE8|shadow-zinc/);
  });
});
