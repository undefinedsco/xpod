import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The §8.2 overlay ladder has one owner: `theme.css` publishes the named layers, primitives consume
 * them, and no page or component carries its own number. The scrim colour lives there too, so
 * dialogs and the compact auth surface stop hard-coding black.
 */
const packageFile = (relativePath: string) => fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
const componentSources = readdirSync(fileURLToPath(new URL('../src', import.meta.url)))
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => ({ name, source: readFileSync(packageFile(`src/${name}`), 'utf8') }));

describe('shared overlay contract', () => {
  test('publishes every named layer once, in the shared theme', () => {
    const theme = readFileSync(packageFile('src/theme.css'), 'utf8');

    for (const token of ['base: 0', 'sticky: 10', 'popover: 20', 'backdrop: 30', 'modal: 40', 'toast: 50']) {
      expect(theme, `missing --layer-${token.split(':')[0]}`).toContain(`--layer-${token};`);
    }
    expect(theme).toContain('.xpod-overlay-scrim');
    expect(theme).toContain('hsl(var(--scrim) / 0.45)');
  });

  test('components consume the named layers instead of their own numbers', () => {
    const offenders = componentSources.flatMap(({ name, source }) => {
      const hits = source.match(/(?:^|[\s"'])z-(?:\[?\d|\[999|\[100|auto)/gu) ?? [];
      const scrim = source.match(/bg-black\/\d+/gu) ?? [];
      return [...hits, ...scrim].map((hit) => `${name}: ${hit.trim()}`);
    });

    expect(offenders).toEqual([]);
  });

  test('every layer that a component uses is published by the theme', () => {
    const theme = readFileSync(packageFile('src/theme.css'), 'utf8');
    const used = new Set(componentSources.flatMap(({ source }) =>
      [...source.matchAll(/var\((--layer-[a-z]+)\)/gu)].map((match) => match[1]!)));

    expect(used.size).toBeGreaterThan(0);
    for (const token of used) {
      expect(theme, `${token} is used but not published`).toContain(`${token}:`);
    }
  });
});
