import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { materializeCssResources, planCssResources } from '../scripts/component-resources';

test('CSS stages its login resources without reading or requiring API-owned static products', () => {
  const base = path.resolve('.test-data/css-resource-boundary');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'input-'));
  const output = root + '.product';
  const put = (file: string, body: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  try {
    put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2021' }, include: ['src'] }));
    put('src/index.ts', 'export class LoginComponent {}\n');
    put('config/local.json', JSON.stringify({ handler: 'urn:fixture:LoginComponent' }));
    put('templates/main.html.ejs', 'controlled template');
    put('dist/components/context.jsonld', '{}');
    put('dist/components/components.jsonld', JSON.stringify({ requireName: '@undefineds.co/xpod' }));
    put('dist/login.jsonld', JSON.stringify({ components: [{ '@id': 'urn:fixture:LoginComponent', requireElement: 'LoginComponent' }] }));
    put('static/app/auth.html', 'controlled auth page');
    put('static/app/assets/login.js', 'controlled login asset');
    put('static/landing/index.html', 'controlled existing static resource');
    const beforeApiBuild = planCssResources(root);
    put('static/dashboard/index.html', 'API dashboard');
    put('static/settings/index.html', 'API settings');
    const afterApiBuild = planCssResources(root);
    assert.deepEqual(afterApiBuild, beforeApiBuild, 'CSS inputs must not depend on whether API static products have been built');
    materializeCssResources(root, output, '@undefineds.co/xpod-css-darwin-arm64', afterApiBuild);
    for (const file of ['static/app/auth.html', 'static/app/assets/login.js', 'static/landing/index.html', 'templates/main.html.ejs']) {
      assert.deepEqual(readFileSync(path.join(output, file)), readFileSync(path.join(root, file)));
      assert.deepEqual(readFileSync(path.join(output, 'source', file)), readFileSync(path.join(root, file)));
    }
    for (const target of ['dashboard', 'settings']) {
      assert.equal(existsSync(path.join(output, 'static', target)), false);
      assert.equal(existsSync(path.join(output, 'source/static', target)), false);
    }
    put('static/app/auth.html', 'changed login page');
    assert.notDeepEqual(planCssResources(root), afterApiBuild, 'CSS-owned asset changes must still affect its inventory');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
