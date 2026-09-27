import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The dual-theme state sample is the review surface for §6.1/§8.1: every state, in both themes.
 * This test keeps the sample honest - if a state disappears from the sample, or a theme stops being
 * covered, it fails here instead of being noticed during a visual review.
 */
const sample = readFileSync(fileURLToPath(new URL('../samples/theme-states.html', import.meta.url)), 'utf8');

const REQUIRED_STATES = [
  'button-default', 'button-secondary', 'button-destructive', 'button-outline', 'button-ghost',
  'button-disabled', 'button-focus',
  'input-default', 'input-invalid', 'input-disabled',
  'badge',
  'state-waiting', 'state-normal', 'state-degraded', 'state-failed', 'state-stopped', 'state-unknown',
  'skeleton', 'overlay-scrim',
];

describe('shared dual-theme state sample', () => {
  test('covers both themes side by side', () => {
    expect(sample).toContain('data-theme="light"');
    expect(sample).toContain('data-theme="dark"');
    expect(sample).toContain('.pane.light');
    expect(sample).toContain('.pane.dark');
  });

  test('declares every required state', () => {
    const declared = [...sample.matchAll(/\['([a-z-]+)',/gu)].map((match) => match[1]!);
    for (const state of REQUIRED_STATES) {
      expect(declared, `sample is missing ${state}`).toContain(state);
    }
  });

  test('uses the shared theme and no private colour values', () => {
    expect(sample).toContain('href="../src/theme.css"');
    expect(sample).toContain('hsl(var(--');
    // scrim comes from the theme, not from a literal black overlay
    expect(sample).not.toMatch(/#[0-9a-fA-F]{6}/u);
  });

  test('conveys every lifecycle state with more than colour', () => {
    for (const [state, marker] of [
      ['state-waiting', '◌'], ['state-normal', '✓'], ['state-degraded', '△'],
      ['state-failed', '✕'], ['state-stopped', '■'], ['state-unknown', '?'],
    ]) {
      const row = sample.split('\n').find((line) => line.includes(`['${state}',`));
      expect(row, `${state} row missing`).toBeDefined();
      expect(row, `${state} must carry a glyph as well as colour`).toContain(marker);
    }
  });
});
