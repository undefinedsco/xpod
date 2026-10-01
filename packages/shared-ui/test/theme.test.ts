import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const packageFile = (relativePath: string) => fileURLToPath(new URL(`../${relativePath}`, import.meta.url));

const themeSource = () => readFileSync(packageFile('src/theme.css'), 'utf8');
const block = (selector: string) => {
  const source = themeSource();
  const start = source.indexOf(`\n  ${selector} {`);
  expect(start, `missing ${selector} block`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n  }\n', start));
};

/**
 * R2 (2026-09-27 product experience spec) §8.1: shared-ui maps the colour roles
 * exactly once. The hex comment next to each assertion is the authoritative
 * brand value; the HSL triple is the token form.
 */
const lightRoles: Record<string, string> = {
  background: '42 38.5% 94.9%', // canvas #F7F4ED
  sunken: '41.3 38.1% 91.8%', // sunken #F2EDE2
  card: '45 33.3% 97.6%', // raised #FBFAF7
  popover: '45 33.3% 97.6%', // raised #FBFAF7
  foreground: '30 13.2% 14.9%', // text #2B2621
  'muted-foreground': '33.3 9.8% 36.1%', // muted #655D53
  border: '36 13.5% 85.5%', // line #DFDBD5
  input: '36 4% 51%', // control #87837D
  'control-strong': '33.3 9.8% 36.1%', // control-strong #655D53
  primary: '260.6 36.1% 38%', // action #563E84
  'primary-foreground': '42 38.5% 94.9%', // on-action #F7F4ED
  'primary-hover': '261 35.7% 32.9%', // action hover #4B3672
  'primary-pressed': '261.2 35.7% 28%', // action pressed #402E61
  accent: '0 10.2% 90.4%', // tint canvas #E9E4E4
};

const darkRoles: Record<string, string> = {
  background: '30 13.8% 11.4%', // canvas #211D19
  sunken: '30 13.6% 8.6%', // sunken #191613
  card: '30 13.2% 14.9%', // raised #2B2621
  popover: '30 13.2% 14.9%', // raised #2B2621
  foreground: '42 38.5% 94.9%', // text #F7F4ED
  'muted-foreground': '34.3 15.8% 73.9%', // muted #C7BEB2
  border: '30 12.3% 25.5%', // line #494139
  input: '32.7 9.2% 53.3%', // control #93897D
  'control-strong': '33.9 13.6% 66.9%', // control-strong #B6AC9F
  primary: '270 16.7% 71.8%', // action #B7ABC3
  'primary-foreground': '30 13.8% 11.4%', // on-action #211D19
  'primary-hover': '271.6 16.8% 77.8%', // action hover #C7BDD0
  'primary-pressed': '264.4 18.8% 66.7%', // action pressed #A79ABA
  accent: '276.9 11.7% 21.8%', // tint #39313E
};

describe('shared theme contract', () => {
  test('owns the semantic native-control baseline for every consumer', () => {
    const source = themeSource();

    expect(source).toContain('color-scheme: light;');
    expect(source).toContain('color-scheme: dark;');
    // The baseline uses a zero-specificity allow-list so a plain focus utility
    // can still own the visible boundary.
    expect(source).toContain("html input:where(:not([type]), [type='text']");
    expect(source).toContain('background-color: hsl(var(--background));');
    expect(source).toContain('color: hsl(var(--foreground));');
    expect(source).toContain("html input:where([type='checkbox'], [type='radio'])");
    expect(source).toContain('html button:focus,');
    expect(source).toContain('html input:-webkit-autofill');
    expect(source).not.toContain('[data-login-slot=');
  });

  test('keeps a keyboard focus fallback for native controls without the shared utility', () => {
    const source = themeSource();

    // The blanket `:focus { outline: none }` reset must be followed by a
    // same-specificity `:focus-visible` fallback, otherwise legacy native
    // controls (settings pages, document panels, plain selects) lose every
    // keyboard affordance when they never adopted `controlFocusClass`.
    const blanket = source.indexOf('html select:focus {');
    const fallback = source.indexOf('html input:focus-visible,');
    expect(blanket).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(blanket);

    const fallbackBlock = source.slice(fallback, source.indexOf('\n  }\n', fallback));
    expect(fallbackBlock).toContain('outline: 2px solid hsl(var(--ring));');
    expect(fallbackBlock).toContain('outline-offset: 3px;');
    // Specificity stays (0,1,2): no class/utility selector leaks in, so the
    // shared `focus-visible:outline-*` utility (0,2,0) remains the single owner
    // of the visible boundary on shared controls.
    expect(fallbackBlock.split('{')[0]).not.toMatch(/\.[-\w]+/);
  });

  test('maps every colour role from R2 §8.1, once, in :root and .light', () => {
    for (const [token, value] of Object.entries(lightRoles)) {
      expect(block(':root'), `:root --${token}`).toContain(`--${token}: ${value};`);
      expect(block('.light'), `.light --${token}`).toContain(`--${token}: ${value};`);
    }
  });

  test('maps the dark counterparts without reusing the fixed ink violet', () => {
    for (const [token, value] of Object.entries(darkRoles)) {
      expect(block('.dark'), `.dark --${token}`).toContain(`--${token}: ${value};`);
    }
    // R2 §8.4: the fixed brand violet on dark canvas is only 1.93:1; dark action is the lightened mapping.
    expect(block('.dark')).not.toContain('--primary: 260.6 36.1% 38%;');
    expect(block('.dark')).not.toContain('--ring: 260.6 36.1% 38%;');
  });

  test('exports the new role tokens to Tailwind consumers', () => {
    const source = themeSource();
    expect(source).toContain('--color-sunken: hsl(var(--sunken));');
    expect(source).toContain('--color-control-strong: hsl(var(--control-strong));');
  });

  test('scopes the sign-in typography and focus treatment to .pod-sign-in', () => {
    const source = themeSource();

    expect(source).toContain('.pod-sign-in {');
    expect(source).toContain('font-size: 14px;');
    expect(source).toContain('.pod-sign-in :focus-visible:not(input):not(textarea):not(select)');
    expect(source).toContain('outline: 2px solid hsl(var(--ring));');
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
