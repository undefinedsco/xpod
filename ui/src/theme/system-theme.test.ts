import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const uiRoot = join(process.cwd(), 'ui');

describe('system theme CSS contract', () => {
  test('imports the shared theme while retaining Xpod product tokens', () => {
    const source = readFileSync(join(uiRoot, 'src/styles/global.css'), 'utf8');

    expect(source.startsWith("@import '@undefineds.co/shared-ui/theme.css';")).toBe(true);
    expect(source).toContain('Flat taro');
    expect(source).not.toContain('html input:where(:not([type])');
  });
});
