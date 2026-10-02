#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { packWorkspacePackages } = require('./workspace-package-pack.cjs');

const PACKAGES = ['solid-sdk', 'shared-ui', 'pod-collections', 'extension-sdk', 'ai-connections', 'pod-settings', 'tasks'];
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
}
function exportEntries(manifest) {
  return Object.entries(manifest.exports).map(([key, value]) => {
    const target = typeof value === 'string' ? value : value.import;
    if (!target || !target.startsWith('./dist/') || target.includes('..', 2)) throw new Error(`Invalid export ${manifest.name}${key}`);
    const specifier = manifest.name + (key === '.' ? '' : key.slice(1));
    if (!target.endsWith('.css') && (!value.types || !value.types.endsWith('.d.ts'))) throw new Error(`Missing declaration for ${specifier}`);
    return { specifier, target, types: typeof value === 'object' ? value.types : undefined };
  });
}
// skipLibCheck is normal for third-party declaration internals, but must not
// conceal missing SDK APIs. Import every SDK type required by these tarballs
// directly from the installed registry SDK in the checked consumer source.
function collectSolidSdkTypes(directory, names) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { collectSolidSdkTypes(filename, names); continue; }
    if (!entry.name.endsWith('.d.ts')) continue;
    const text = fs.readFileSync(filename, 'utf8');
    const pattern = /(?:import|export)\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]@undefineds\.co\/solid-sdk['"]/g;
    for (const match of text.matchAll(pattern)) {
      for (const binding of match[1].split(',').filter((value) => value.trim())) {
        const name = binding.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('Unsupported SDK type binding');
        names.add(name);
      }
    }
  }
}
function verifyInstalled(directory, expected) {
  const entries = [];
  const solidSdkTypes = new Set();
  for (const manifest of expected) {
    const packageRoot = path.join(directory, 'node_modules', manifest.name);
    collectSolidSdkTypes(path.join(packageRoot, 'dist'), solidSdkTypes);
    const actual = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (actual.version !== manifest.version) throw new Error(`Wrong installed version: ${manifest.name}`);
    for (const entry of exportEntries(actual)) {
      for (const target of [entry.target, entry.types].filter(Boolean)) {
        if (!fs.statSync(path.join(packageRoot, target)).isFile()) throw new Error(`Missing export: ${entry.specifier}`);
      }
      if (entry.target.endsWith('.css') && !fs.readFileSync(path.join(packageRoot, entry.target), 'utf8').trim()) throw new Error(`Empty stylesheet: ${entry.specifier}`);
      entries.push(entry);
    }
  }
  const modules = entries.filter((entry) => !entry.target.endsWith('.css'));
  fs.writeFileSync(path.join(directory, 'imports.mjs'), modules.map(({ specifier }) => `await import(${JSON.stringify(specifier)});`).join('\n'));
  fs.writeFileSync(path.join(directory, 'consumer.ts'), [...modules.map(({ specifier }, index) => `import * as package${index} from ${JSON.stringify(specifier)}; export type Package${index} = typeof package${index};`), solidSdkTypes.size ? `import type { ${[...solidSdkTypes].sort().join(', ')} } from '@undefineds.co/solid-sdk';` : ''].join('\n'));
  return modules.length;
}
function consume(root = path.resolve(__dirname, '..'), { tarballs } = {}) {
  const manifests = PACKAGES.map((name) => JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-workspace-consumer-'));
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', overrides: tarballs || {}, dependencies: Object.fromEntries([...manifests.map((m) => [m.name, tarballs?.[m.name] || m.version]), ['react', '19.2.0'], ['react-dom', '19.2.0'], ['@types/react', '19.2.14'], ['typescript', '6.0.3']]) }));
    run('bun', ['install', '--ignore-scripts'], directory);
    const count = verifyInstalled(directory, manifests);
    run('bun', ['imports.mjs'], directory);
    run('bun', [path.join(root, 'scripts/workspace-package-typecheck.cjs'), directory, JSON.stringify(manifests.map((manifest) => manifest.name))], directory);
    console.log(`Verified ${manifests.length} ${tarballs ? 'packed' : 'published'} packages, ${count} module/type exports and CSS in a clean Bun consumer`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { PACKAGES, exportEntries, verifyInstalled, consume };
function consumeLocal(root = path.resolve(__dirname, '..')) {
  const parent = path.join(root, '.test-data', 'workspace-package-consumer');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'pack-'));
  try { consume(root, { tarballs: packWorkspacePackages(root, PACKAGES, directory) }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports.consumeLocal = consumeLocal;
if (require.main === module) process.argv.includes('--local') ? consumeLocal() : consume();
