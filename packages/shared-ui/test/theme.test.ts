import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const packageFile = (relativePath: string) => fileURLToPath(new URL(`../${relativePath}`, import.meta.url));

describe('shared theme contract', () => {
  test('owns the semantic native-control baseline for every consumer', () => {
    const source = readFileSync(packageFile('src/theme.css'), 'utf8');

    expect(source).toContain('color-scheme: light;');
    expect(source).toContain('color-scheme: dark;');
    expect(source).toContain('html input:where(:not([type])');
    expect(source).toContain('background-color: hsl(var(--background));');
    expect(source).toContain('color: hsl(var(--foreground));');
    expect(source).toContain("html input:where([type='checkbox'], [type='radio'])");
    expect(source).toContain('html button:focus');
    expect(source).toContain('outline: none;');
    expect(source).toContain('html input:-webkit-autofill');
    expect(source).not.toContain('[data-login-slot=');
  });

  test('marks exported CSS as a retained package side effect', () => {
    const manifest = JSON.parse(readFileSync(packageFile('package.json'), 'utf8')) as {
      sideEffects?: unknown;
    };

    expect(manifest.sideEffects).toEqual(['*.css']);
  });
});
