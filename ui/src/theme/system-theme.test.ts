import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const uiRoot = join(process.cwd(), 'ui');

describe('system theme CSS contract', () => {
  test('consumes the shared theme and keeps no second colour palette', () => {
    const source = readFileSync(join(uiRoot, 'src/styles/global.css'), 'utf8');

    expect(source.startsWith("@import '@undefineds.co/shared-ui/theme.css';")).toBe(true);
    // A duplicated :root/.dark colour block here wins the cascade and repaints
    // the product with the retired violet-on-white palette (R2 §8.1 forbids it).
    expect(source).not.toMatch(/--primary:/);
    expect(source).not.toMatch(/--background:/);
    expect(source).not.toMatch(/--border:/);
    expect(source).not.toMatch(/--ring:/);
    // The product radius and chart scales stay local: shared-ui owns colour, not these.
    expect(source).toContain('--radius-xl: 20px;');
    expect(source).toContain('--chart-1:');
    expect(source).not.toContain('html input:where(:not([type])');
  });
});
