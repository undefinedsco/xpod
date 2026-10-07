/**
 * The double-focus-frame conflict is a cascade conflict between
 * `@tailwindcss/forms`, the shared theme baseline and the shared utility. A
 * hand-written selector simulator cannot prove a browser cascade (it ignores
 * ancestors, layers and `!important`), so this test instead compiles the real
 * pipeline and makes small, explicit assertions about the produced rules and
 * their relative order. The winning computed styles for the light/dark matrix
 * are verified separately in a real browser.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import postcssImport from 'postcss-import';
import tailwindcss from 'tailwindcss';
import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Checkbox } from '../../../packages/shared-ui/src/checkbox';
import { controlFocusClass } from '../../../packages/shared-ui/src/focus';
import tailwindConfig from '../../tailwind.config.js';

const globalCssPath = join(process.cwd(), 'ui/src/styles/global.css');
const sharedThemePath = join(process.cwd(), 'packages/shared-ui/src/theme.css');

const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();

interface CompiledRule {
  selector: string;
  declarations: Record<string, string>;
  order: number;
}

async function compile(): Promise<CompiledRule[]> {
  const raw = '<div class="light dark"></div><input /><input type="text" /><input type="checkbox" /><input type="radio" /><select></select><textarea></textarea>'
    + `<input type="text" class="h-11 rounded-lg border border-input bg-card ${controlFocusClass}" />`
    + renderToStaticMarkup(createElement(Checkbox, { defaultChecked: true }));
  const css = await postcss([
    postcssImport({
      resolve: (id: string) => (id === '@undefineds.co/shared-ui/theme.css' ? sharedThemePath : id),
    }),
    tailwindcss({ ...tailwindConfig, content: [{ raw, extension: 'html' }] }),
  ]).process(readFileSync(globalCssPath, 'utf8'), { from: globalCssPath });

  const rules: CompiledRule[] = [];
  css.root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && rule.parent.name === 'media') return;
    const declarations: Record<string, string> = {};
    rule.each((node) => {
      if (node.type === 'decl') declarations[node.prop.toLowerCase()] = node.value.trim();
    });
    rules.push({ selector: normalize(rule.selector), declarations, order: rules.length });
  });
  return rules;
}

function ruleFor(rules: CompiledRule[], selector: string): CompiledRule;
function ruleFor(rules: CompiledRule[], selectorContains: string, mode: 'contains'): CompiledRule;
function ruleFor(rules: CompiledRule[], selector: string, mode: 'contains' | 'exact' = 'exact'): CompiledRule {
  const found = mode === 'exact'
    ? rules.find((rule) => rule.selector === selector)
    : rules.find((rule) => rule.selector.includes(selector));
  expect(found, `missing compiled rule for ${selector}`).toBeTruthy();
  return found!;
}

describe('compiled native-control focus rules', () => {
  test('uses one marker for checked and mixed shared checkboxes when forms is installed', async () => {
    const rules = await compile();
    const pluginMarker = rules.find(rule => rule.selector.includes("input:where([type='checkbox']):checked") && rule.declarations['background-image']?.includes('data:image/svg+xml'));
    expect(pluginMarker, 'forms must supply the marker being replaced').toBeTruthy();
    for (const state of ['checked', 'indeterminate']) {
      const sharedMarker = ruleFor(rules, `.${state}\\:bg-none:${state}`);
      expect(sharedMarker.declarations['background-image']).toBe('none');
      expect(sharedMarker.order).toBeGreaterThan(pluginMarker!.order);
    }
  });

  test('clears the @tailwindcss/forms blue focus frame for every native control type', async () => {
    const rules = await compile();

    // The plugin's blue ring is really in the output, so the conflict is real.
    const pluginFocus = ruleFor(rules, 'input:where([type=\'text\']):focus', 'contains');
    expect(pluginFocus.declarations['--tw-ring-color']).toBe('#2563eb');
    const pluginCheckboxFocus = ruleFor(rules, 'input:where([type=\'checkbox\']):focus', 'contains');
    expect(pluginCheckboxFocus.declarations['--tw-ring-color']).toBe('#2563eb');

    // One theme rule neutralises it for *all* native controls: no type allow-list
    // (a `:where([type=...])` filter would leave checkbox/radio behind).
    const clear = ruleFor(rules, 'html input:focus, html textarea:focus, html select:focus');
    expect(clear.selector).not.toContain('[type=');
    expect(clear.declarations['box-shadow']).toBe('none');
    expect(clear.declarations['outline']).toBe('none');
    expect(clear.declarations['--tw-ring-shadow']).toBe('0 0 #0000');

    // Order matters at equal specificity: the clear rule must come after the plugin.
    expect(clear.order).toBeGreaterThan(pluginFocus.order);
    expect(clear.order).toBeGreaterThan(pluginCheckboxFocus.order);
  });

  test('keeps a contrasting single border on checked and indeterminate toggles', async () => {
    const rules = await compile();
    const filled = ruleFor(rules, "html input:where([type='checkbox'], [type='radio']):checked:focus-visible", 'contains');
    expect(filled.selector).toContain(":indeterminate:focus-visible");
    expect(filled.declarations['border-color']).toBe('hsl(var(--primary-foreground))');
    const plugin = ruleFor(rules, ":checked:focus", 'contains');
    expect(filled.order).toBeGreaterThan(plugin.order);
  });

  test('strengthens the existing keyboard border without adding an outer frame', async () => {
    const rules = await compile();

    const reset = ruleFor(rules, 'html [role=\'button\']:focus', 'contains');
    expect(reset.declarations['outline']).toBe('none');

    const fallback = ruleFor(rules, "html input:focus-visible, html textarea:focus-visible, html select:focus-visible");
    expect(fallback.declarations['border-color']).toBe('hsl(var(--ring))');
    expect(fallback.declarations['border-width']).toBe('2px');
    expect(fallback.declarations['outline']).toBe('none');
    expect(fallback.declarations['box-shadow']).toBe('none');
    expect(fallback.order).toBeGreaterThan(reset.order);
  });

  test('keeps the shared control utility as the winning boundary at equal specificity', async () => {
    const rules = await compile();

    const borderWidth = ruleFor(rules, 'focus-visible\\:border-2:focus-visible', 'contains');
    const borderColor = ruleFor(rules, 'focus-visible\\:border-ring:focus-visible', 'contains');
    expect(borderWidth.declarations['border-width']).toBe('2px');
    expect(borderColor.declarations['border-color']).toBe('hsl(var(--ring))');
    expect(rules.some((rule) => rule.selector.includes('outline-ring'))).toBe(false);
    for (const theme of [':root', '.light', '.dark']) {
      const palette = ruleFor(rules, theme);
      expect(palette.declarations['--ring']).toBeTruthy();
      expect(palette.declarations['--ring']).not.toBe(palette.declarations['--input']);
    }
  });
});
