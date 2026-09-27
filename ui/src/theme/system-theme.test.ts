import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const uiRoot = join(process.cwd(), 'ui');

describe('system theme CSS contract', () => {
  test('consumes the shared theme as the single semantic source', () => {
    const source = readFileSync(join(uiRoot, 'src/styles/global.css'), 'utf8');

    expect(source.startsWith("@import '@undefineds.co/shared-ui/theme.css';")).toBe(true);
    // Product CSS keeps only layout, utilities and component rules: it must not redefine the
    // semantic tokens the shared theme owns
    // (docs/superpowers/specs/2026-09-27-xpod-product-experience-spec.md §8.1, AC-01).
    expect(source).not.toMatch(/--(background|foreground|primary|border|input|ring|muted|accent|card|popover)\s*:/u);
    expect(source).not.toContain('html input:where(:not([type])');
  });
});
