import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * W4-DESIGN-03 / §8.1：语义色只有公共层的一处映射。页面不得再用 Tailwind 调色板字面量
 * 表达成功、警告、危险或链接色，否则同一"警告"会在不同页面呈现不同颜色，深色主题也无法统一。
 */

const UI_SRC = join(process.cwd(), 'ui/src');
const PALETTE_SEMANTICS = /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:amber|yellow|red|rose|green|emerald|blue|indigo)-\d{2,3}/gu;

function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsx(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('semantic colour contract', () => {
  it('keeps product pages off the Tailwind palette for semantic roles', () => {
    const offenders = collectTsx(UI_SRC)
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        return [...source.matchAll(PALETTE_SEMANTICS)].map((match) => `${file.replace(process.cwd() + '/', '')}: ${match[0]}`);
      });
    expect(offenders).toEqual([]);
  });

  it('publishes the roles through the shared theme and one Tailwind mapping', () => {
    const theme = readFileSync(join(process.cwd(), 'packages/shared-ui/src/theme.css'), 'utf8');
    const tailwind = readFileSync(join(process.cwd(), 'ui/tailwind.config.js'), 'utf8');

    for (const role of ['success', 'warning', 'destructive']) {
      expect(theme, `theme.css must publish --${role}`).toContain(`--${role}:`);
      expect(tailwind, `tailwind must map ${role}`).toContain(`${role}: {`);
    }
  });
});
