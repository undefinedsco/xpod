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

  test('carries the paper and ink-violet tokens identically in :root and .light, with the dark counterparts', () => {
    const source = readFileSync(packageFile('src/theme.css'), 'utf8');
    const block = (selector: string) => {
      const start = source.indexOf(`  ${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      return source.slice(start, source.indexOf('\n  }\n', start));
    };
    const light: Record<string, string> = {
      background: '42 38.5% 94.9%', // #F7F4ED
      card: '45 33.3% 97.6%', // #FBFAF7
      foreground: '30 13.2% 14.9%', // #2B2621
      'muted-foreground': '33.3 9.8% 36.1%', // #655D53
      border: '36 13.5% 85.5%', // #DFDBD5
      input: '36 4% 51%', // #87837D
      primary: '260.6 36.1% 38%', // #563E84
      accent: '0 10.2% 90.4%', // #E9E4E4
    };
    const dark: Record<string, string> = {
      background: '36 9.8% 10%', // #1C1A17
      card: '34.3 10.8% 12.7%', // #24211D
      foreground: '40 31.6% 92.5%', // #F2EEE6
      'muted-foreground': '34.3 12.1% 66.1%', // #B3AA9E
      border: '36 9.4% 20.8%', // #3A3630
      input: '36 7.3% 40.2%', // #6E685F
      primary: '258.9 40.7% 66.3%', // #9C86CC
      accent: '266.7 9.7% 18.2%', // #2E2A33
    };
    for (const [token, value] of Object.entries(light)) {
      expect(block(':root')).toContain(`--${token}: ${value};`);
      expect(block('.light')).toContain(`--${token}: ${value};`);
    }
    for (const [token, value] of Object.entries(dark)) {
      expect(block('.dark')).toContain(`--${token}: ${value};`);
    }
  });

  test('scopes the sign-in typography and focus treatment to .pod-sign-in', () => {
    const source = readFileSync(packageFile('src/theme.css'), 'utf8');

    expect(source).toContain('.pod-sign-in {');
    expect(source).toContain('font-size: 14px;');
    expect(source).toContain('.pod-sign-in :focus-visible');
    expect(source).toContain('outline: 2px solid hsl(var(--primary));');
    expect(source).toContain('outline-offset: 3px;');
    expect(source).toContain('prefers-reduced-motion: reduce');
  });

  test('marks exported CSS as a retained package side effect', () => {
    const manifest = JSON.parse(readFileSync(packageFile('package.json'), 'utf8')) as {
      sideEffects?: unknown;
    };

    expect(manifest.sideEffects).toEqual(['*.css']);
  });
});
