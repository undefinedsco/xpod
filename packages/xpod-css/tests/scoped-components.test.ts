import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildScopedCssComponents } from '../scripts/scoped-components';
import { cssProducerConfig } from '../scripts/producer-config';
import { stagePhysicalService } from '../../../scripts/lib/physical-module-stage';

function fixture() {
  const base = path.resolve('.test-data/css-scoped-components-tests');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'owned-'));
  const put = (file: string, body: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  const moduleIri = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod';
  put('package.json', JSON.stringify({ name: '@undefineds.co/xpod', version: '0.0.0', 'lsd:module': moduleIri,
    'lsd:components': 'dist/components/components.jsonld',
    'lsd:contexts': { [moduleIri + '/^0.0.0/components/context.jsonld']: 'dist/components/context.jsonld' },
    'lsd:importPaths': { [moduleIri + '/^0.0.0/dist/']: 'dist/', [moduleIri + '/^0.0.0/components/']: 'dist/components/' },
  }));
  put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, types: [], target: 'ES2021', module: 'CommonJS' }, include: ['src'] }));
  put('.componentsjs-generator-config.json', JSON.stringify({ modulePrefix: { '@undefineds.co/xpod': 'undefineds' }, logLevel: 'error' }));
  put('src/index.ts', "export { LoginComponent, LoginSibling } from './http/LoginComponent';\nexport { UnrelatedApi } from './api/main';\n");
  put('src/http/LoginComponent.ts', 'export class LoginComponent { constructor(public readonly label: string) {} }\nexport class LoginSibling {}\n');
  put('src/api/main.ts', "export class UnrelatedApi { value: number = 'deliberate unrelated type error'; }\n");
  put('config/local.json', JSON.stringify({ '@context': { loginLabel: 'LoginComponent:label' }, handler: { '@type': 'LoginComponent' } }));
  put('templates/main.html.ejs', 'controlled login template');
  put('static/app/auth.html', 'controlled login document');
  put('dist/components/old.jsonld', 'old root metadata must not be read');
  renameSync(path.join(root, 'dist'), path.join(root, 'dist.removed'));
  return { root, put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('cold CSS generation compiles only selected roots and preserves sibling definitions and original IRIs', async () => {
  const f = fixture();
  try {
    const built = await buildScopedCssComponents(f.root, path.join(f.root, 'generated'));
    assert.equal(existsSync(path.join(f.root, 'dist')), false);
    assert.deepEqual(built.plan.componentExports.map(row => row.name), ['LoginComponent', 'LoginSibling']);
    const receipt = JSON.parse(readFileSync(path.join(built.metadataRoot, 'scoped-components.json'), 'utf8'));
    assert.equal(receipt.compilerOptions.strict, true);
    assert.equal(receipt.compilerOptions.skipLibCheck, false);
    assert.ok(receipt.iterations.every((row: { sources: Array<{ path: string }> }) => row.sources.every(source => source.path === 'src/http/LoginComponent.ts')));
    const definition = JSON.parse(readFileSync(path.join(built.metadataRoot, 'dist/http/LoginComponent.jsonld'), 'utf8'));
    const component = definition.components.find((row: { requireElement: string }) => row.requireElement === 'LoginComponent');
    assert.equal(component['@id'], 'undefineds:dist/http/LoginComponent.jsonld#LoginComponent');
    assert.equal(component.parameters[0]['@id'], 'undefineds:dist/http/LoginComponent.jsonld#LoginComponent_label');
    assert.equal(JSON.parse(readFileSync(path.join(built.metadataRoot, 'dist/components/components.jsonld'), 'utf8')).requireName, '@undefineds.co/xpod');
    const product = path.join(f.root, 'product');
    cssProducerConfig(f.root, 'darwin-arm64', built).materializeResources(product);
    assert.equal(readFileSync(path.join(product, 'static/app/auth.html'), 'utf8'), 'controlled login document');
    assert.ok(readFileSync(path.join(product, 'dist/css-components.cjs'), 'utf8').includes('LoginComponent'));
    assert.equal(existsSync(path.join(product, 'dist/api')), false);
  } finally { f.cleanup(); }
});

test('a selected CSS component type error is fatal before Components generation', async () => {
  const f = fixture();
  try {
    f.put('src/http/LoginComponent.ts', "export class LoginComponent { value: number = 'selected type error'; }\nexport class LoginSibling {}\n");
    const output = path.join(f.root, 'generated');
    await assert.rejects(() => buildScopedCssComponents(f.root, output), /Scoped CSS declaration compilation failed/u);
    assert.equal(existsSync(path.join(output, 'dist/components/components.jsonld')), false);
    assert.equal(existsSync(path.join(f.root, 'dist')), false);
  } finally { f.cleanup(); }
});

test('generated references grow the same canonical component closure to a fixed point', async () => {
  const f = fixture();
  try {
    f.put('src/base/BaseComponent.ts', 'export class BaseComponent { constructor(public readonly label: string) {} }\n');
    f.put('src/http/LoginComponent.ts', "import { BaseComponent } from '../base/BaseComponent';\nexport class LoginComponent extends BaseComponent {}\nexport interface LoginOptions { label: string; }\nexport class LoginSibling {}\n");
    f.put('src/index.ts', "export { LoginComponent, LoginSibling } from './http/LoginComponent';\nexport type { LoginOptions } from './http/LoginComponent';\nexport { BaseComponent } from './base/BaseComponent';\nexport { UnrelatedApi } from './api/main';\n");
    const built = await buildScopedCssComponents(f.root, path.join(f.root, 'generated'));
    const receipt = JSON.parse(readFileSync(path.join(built.metadataRoot, 'scoped-components.json'), 'utf8'));
    assert.ok(receipt.selectedExports.includes('BaseComponent'));
    assert.ok(receipt.selectedExports.includes('LoginOptions'), 'same-document interface metadata must be retained');
    assert.ok(receipt.iterations.length >= 2);
    assert.ok(receipt.iterations.every((row: { sources: Array<{ path: string }> }) => row.sources.every(source => !source.path.startsWith('src/api/'))));
    assert.deepEqual(built.plan.componentExports.map(row => row.name), ['BaseComponent', 'LoginComponent', 'LoginSibling']);
    assert.equal(existsSync(path.join(f.root, 'dist')), false);
  } finally { f.cleanup(); }
});

test('JSON imports remain strictly checked without requiring nonexistent JSON declarations', async () => {
  const f = fixture();
  try {
    f.put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, types: [], target: 'ES2021', module: 'CommonJS', resolveJsonModule: true, esModuleInterop: true }, include: ['src'] }));
    f.put('src/http/defaults.json', JSON.stringify({ label: 'login' }));
    f.put('src/http/LoginComponent.ts', "import defaults from './defaults.json';\nexport class LoginComponent { constructor(public readonly label: string = defaults.label) {} }\nexport class LoginSibling {}\n");
    const built = await buildScopedCssComponents(f.root, path.join(f.root, 'generated-json'));
    const receipt = JSON.parse(readFileSync(path.join(built.metadataRoot, 'scoped-components.json'), 'utf8'));
    assert.ok(receipt.iterations[0].sources.some((row: { path: string }) => row.path === 'src/http/defaults.json'));
    assert.equal(existsSync(path.join(built.metadataRoot, 'dist/http/LoginComponent.d.ts')), true);
    assert.equal(existsSync(path.join(built.metadataRoot, 'dist/http/defaults.d.ts')), false);
    assert.deepEqual(receipt.iterations[0].declarations, ['dist/http/LoginComponent.d.ts']);
    f.put('LICENSE', 'controlled license');
    const product = path.join(f.root, 'json-runtime');
    stagePhysicalService(f.root, product, ['src/http/LoginComponent.ts'], { entry: 'src/http/LoginComponent.ts', moduleId: 'css', validateInputs: () => {} });
    assert.deepEqual(readFileSync(path.join(product, 'src/http/defaults.json')), readFileSync(path.join(f.root, 'src/http/defaults.json')), 'runtime stage retains original JSON bytes');
    f.put('src/http/LoginComponent.ts', "import defaults from './defaults.json';\nexport class LoginComponent { value: number = defaults.label; }\nexport class LoginSibling {}\n");
    await assert.rejects(() => buildScopedCssComponents(f.root, path.join(f.root, 'invalid-json-type')), /Scoped CSS declaration compilation failed/u);
  } finally { f.cleanup(); }
});
