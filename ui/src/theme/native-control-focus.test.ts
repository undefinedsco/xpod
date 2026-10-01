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
  const raw = '<input /><input type="text" /><input type="checkbox" /><input type="radio" /><select></select><textarea></textarea>'
    + '<input type="text" class="h-11 rounded-lg border border-input bg-card focus:outline-none focus:ring-0 '
    + 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ring" />';
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

  test('restores one keyboard outline after the blanket reset', async () => {
    const rules = await compile();

    const reset = ruleFor(rules, 'html [role=\'button\']:focus', 'contains');
    expect(reset.declarations['outline']).toBe('none');

    const fallback = ruleFor(rules, "html input:focus-visible, html textarea:focus-visible, html select:focus-visible");
    expect(fallback.declarations['outline']).toBe('2px solid hsl(var(--ring))');
    expect(fallback.declarations['outline-offset']).toBe('3px');
    expect(fallback.order).toBeGreaterThan(reset.order);
  });

  test('keeps the shared control utility as the winning boundary at equal specificity', async () => {
    const rules = await compile();

    const focusOnly = ruleFor(rules, 'focus\\:outline-none:focus', 'contains');
    const outlineWidth = ruleFor(rules, 'focus-visible\\:outline-2:focus-visible', 'contains');
    const outlineColor = ruleFor(rules, 'focus-visible\\:outline-ring:focus-visible', 'contains');

    expect(outlineWidth.declarations['outline-width']).toBe('2px');
    expect(outlineColor.declarations['outline-color']).toBe('hsl(var(--ring))');
    // Same specificity: source order decides, so the keyboard utility must come
    // after `focus:outline-none` to own the one visible boundary.
    expect(outlineWidth.order).toBeGreaterThan(focusOnly.order);
    expect(outlineColor.order).toBeGreaterThan(focusOnly.order);
  });
});
