const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { resolveNativeTarget } = require('./embedded-native-cli.cjs');

// These SDKs are loaded with native import() at request time, outside the
// Components.js closure. Preserve ESM and real native-asset package locations.
const RUNTIME_ESM_PACKAGES = [{
  name: '@mariozechner/pi-coding-agent',
  externals: ['@silvia-odwyer/photon-node'],
  // Xpod embeds the programmatic API, never the upstream interactive CLI.
  entries: {
    'core/auth-storage.js': ['AuthStorage'],
    'core/model-registry.js': ['ModelRegistry'],
    'core/session-manager.js': ['SessionManager'],
    'core/settings-manager.js': ['SettingsManager'],
    'core/resource-loader.js': ['DefaultResourceLoader'],
    'core/sdk.js': ['createAgentSession', 'createBashTool', 'createCodingTools', 'createEditTool',
      'createReadOnlyTools', 'createReadTool', 'createWriteTool'],
  },
}];
const RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.node', '.wasm', '.so', '.dylib', '.dll']);

function copyExternalPackages(names, optionalNames, nodeModulesRoot, stageRoot) {
  const queue = names.map(name => ({ name, optional: optionalNames.has(name) }));
  const visited = new Set();
  while (queue.length) {
    const { name, optional } = queue.shift();
    if (visited.has(name)) continue;
    const directory = path.join(nodeModulesRoot, name);
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest)) {
      if (optional) continue;
      throw new Error(`Runtime ESM external package is missing: ${name}`);
    }
    const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.cpSync(directory, path.join(stageRoot, 'node_modules', name), {
      recursive: true, dereference: true,
      filter(source) {
        const relative = path.relative(directory, source);
        if (relative.split(path.sep).some(part => ['node_modules', 'test', 'tests', 'docs', 'examples', '.git'].includes(part))) return false;
        return fs.statSync(source).isDirectory() || RUNTIME_EXTENSIONS.has(path.extname(source))
          || /^(?:licen[cs]e|copying|copyright|notice|readme)/iu.test(path.basename(source));
      },
    });
    visited.add(name);
    for (const dependency of Object.keys(metadata.dependencies ?? {})) queue.push({ name: dependency, optional: false });
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) queue.push({ name: dependency, optional: true });
  }
}

async function stageRuntimeEsmPackages({ nodeModulesRoot, stageRoot, compileTarget }) {
  // The native runtime supports macOS/Linux only. pi-tui loads Koffi solely
  // in its Windows console-input branch; keep that guarded require external
  // without shipping unused Windows terminal support on these targets.
  resolveNativeTarget(compileTarget);
  for (const declaration of RUNTIME_ESM_PACKAGES) {
    const directory = path.join(nodeModulesRoot, declaration.name);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const target = path.join(stageRoot, 'node_modules', declaration.name);
    const main = 'dist/index.js';
    fs.mkdirSync(path.join(target, 'dist'), { recursive: true });
    await esbuild.build({
      stdin: {
        contents: Object.entries(declaration.entries).map(([file, names]) =>
          `export { ${names.join(', ')} } from ${JSON.stringify(path.join(directory, 'dist', file))};`).join('\n'),
        resolveDir: directory, sourcefile: 'xpod-runtime-sdk.js',
      },
      outfile: path.join(target, main),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
      minify: true, keepNames: true,
      external: [...declaration.externals, 'koffi', '@mariozechner/clipboard'],
      banner: { js: "import { createRequire as __xpodCreateRequire } from 'node:module'; const require = __xpodCreateRequire(import.meta.url);" },
    });
    // Only the SDK entry is shipped. Do not advertise the upstream interactive CLI
    // or non-staged subpaths. piConfig is consumed by the SDK's package discovery.
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
      name: metadata.name, version: metadata.version, license: metadata.license,
      type: 'module', main, exports: { '.': `./${main}` }, piConfig: metadata.piConfig,
    }, null, 2));
    for (const name of fs.readdirSync(directory)) {
      if (/^(?:licen[cs]e|copying|copyright|notice)/iu.test(name) && fs.statSync(path.join(directory, name)).isFile()) {
        fs.copyFileSync(path.join(directory, name), path.join(target, name));
      }
    }
    copyExternalPackages(declaration.externals, new Set(Object.keys(metadata.optionalDependencies ?? {})), nodeModulesRoot, stageRoot);
  }
}

module.exports = { stageRuntimeEsmPackages };
