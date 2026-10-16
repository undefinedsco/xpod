import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveProducerMaterials } from './producer-materials';
import { resolveProducerInput, resolveRuntimeClientInput } from './producer-input';
import { withStagedProducerInput } from './staged-producer-input';
import { collectAfsJavascriptMaterials } from './javascript-materials';
import { createDeclarationInput, createDeclarationBuild } from './declaration-input';

// The build script uses only this Bun build API; avoid exposing Bun globals to
// the Node-compatible runtime and declaration graph.
declare const Bun: {
  build(options: {
    entrypoints: string[]; target: 'node'; format: 'esm'; metafile: true; external: string[];
    plugins: Array<{ name: string; setup(build: {
      onResolve(options: { filter: RegExp }, resolve: (args: { importer: string; path: string }) => { path: string; external: boolean } | undefined): void;
    }): void }>;
  }): Promise<{ success: boolean; outputs: Array<{ text(): Promise<string> }>; metafile: {
    inputs: Record<string, unknown>; outputs: Record<string, { inputs?: Record<string, unknown>; [key: string]: unknown }>;
  } }>;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Compile and collect against the caller's live, verified producer scope. */
export async function buildAfsClient(producerInput: ReturnType<typeof resolveProducerInput>, clientRoot: string): Promise<void> {
  await resolveProducerMaterials(producerInput.indexPath, clientRoot, producerInput.tools);
  const typeInput = createDeclarationInput([producerInput.root, clientRoot], producerInput.assertCurrent);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  const declarationBuild = createDeclarationBuild(path.join(root, 'tsconfig.build.json'), typeInput);
  const program = declarationBuild.program;
  const checker = program.getTypeChecker();
  const publicValueExports: Record<string, string[]> = {};
  function valueExports(source: string): string[] {
    const file = program.getSourceFile(path.join(root, 'src', source + '.ts')) ?? program.getSourceFile(path.join(root, 'src', source, 'index.ts'));
    const module = file && checker.getSymbolAtLocation(file);
    if (!module) { throw new Error('AFS public module missing'); }
    return checker.getExportsOfModule(module).filter(symbol => {
      const actual = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (!(actual.flags & ts.SymbolFlags.Value)) { return false; }
      for (const declaration of actual.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && !(declaration.parent.flags & ts.NodeFlags.Const)) {
          throw new Error('Mutable AFS public binding requires a live export implementation');
        }
      }
      if (!/^[$A-Z_a-z][$\w]*$/.test(symbol.name) && symbol.name !== 'default') { throw new Error('Unsupported AFS public export name'); }
      return true;
    }).map(symbol => symbol.name).sort();
  }
  const declarations: string[] = ["export * as runtime from '../src/runtime';"];
  const sharedSources = new Map<string, string>();
  for (const [subpath, target] of Object.entries(pkg.exports).filter(([, target]) => typeof target === 'object') as Array<[string, { default: string }]>) {
    const source = subpath === '.' ? 'index' : subpath.slice(2);
    // Commands are a public host API, but do not belong to the canonical
    // storage/authentication library. Their bridges are emitted below.
    if (subpath === './commands') { publicValueExports[subpath] = valueExports(source); continue; }
    const physicalSource = [path.join(root, 'src', source + '.ts'), path.join(root, 'src', source, 'index.ts')].find(existsSync);
    if (!physicalSource) { throw new Error('AFS shared source unavailable'); }
    sharedSources.set(physicalSource, target.default.replace(/^\.\/dist\//, './').replace(/\.cjs$/, '.mjs'));
    const key = source.replaceAll('/', '_').replaceAll('-', '_');
    declarations.push(`export * as ${key} from '../src/${source}';`);
    const names = valueExports(source); publicValueExports[subpath] = names;
    const outfile = path.join(root, target.default);
    mkdirSync(path.dirname(outfile), { recursive: true });
    const relative = path.relative(path.dirname(outfile), path.join(root, 'dist/library.cjs')).split(path.sep).join('/');
    const rootRelative = path.relative(path.dirname(outfile), root).split(path.sep).join('/');
    writeFileSync(outfile, `const library = require(${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)});\nlibrary.runtime.bindModuleRoot(require('node:path').resolve(__dirname, ${JSON.stringify(rootRelative)}));\nmodule.exports = library.${key};\n`);
    const esmPath = outfile.replace(/\.cjs$/, '.mjs');
    const esmRoot = rootRelative.endsWith('/') ? rootRelative : rootRelative + '/';
    writeFileSync(esmPath, `import library from ${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)};\nimport { fileURLToPath } from 'node:url';\nlibrary.runtime.bindModuleRoot(fileURLToPath(new URL(${JSON.stringify(esmRoot)}, import.meta.url)));\n` + names.map(name => name === 'default' ? `export default library.${key}.default;` : `export const ${name} = library.${key}.${name};`).join('\n') + '\n');

  }
  writeFileSync(path.join(root, 'dist/public-value-exports.json'), JSON.stringify(publicValueExports, null, 2) + '\n');
  writeFileSync(path.join(root, 'dist/library-source.ts'), declarations.join('\n') + '\n');
  const main = spawnSync('bun', ['build', '--target=node', '--format=cjs', '--external=@undefineds.co/xpod-client', '--external=drizzle-orm', '--external=bun:sqlite', '--metafile=' + path.join(root, 'dist/library-inputs.json'), '--outfile', path.join(root, 'dist/library.cjs'), path.join(root, 'dist/library-source.ts')], { cwd: root, stdio: 'inherit' });
  if (main.status !== 0) { throw new Error('AFS entry build failed'); }
  writeFileSync(path.join(root, 'dist/runtime.mjs'), "import library from './library.cjs';\nexport const { bindModuleRoot, moduleRoot, moduleLauncher } = library.runtime;\n");
  sharedSources.set(path.join(root, 'src/runtime.ts'), './runtime.mjs');
  const commandSource = path.join(root, 'dist/commands-source.ts');
  writeFileSync(commandSource, "import { registerSolidAuthnSdkLoader } from '@undefineds.co/xpod-client';\nexport function registerModuleSdk() { registerSolidAuthnSdkLoader(() => import('@inrupt/solid-client-authn-node')); }\nexport * from '../src/commands';\nexport { runAfs } from '../src/entry';\nexport { handleCliError } from '@undefineds.co/xpod-cli/output';\n");
  const entry = await Bun.build({
    entrypoints: [commandSource], target: 'node', format: 'esm', metafile: true,
    external: ['@undefineds.co/xpod-client', 'drizzle-orm', 'bun:sqlite'],
    plugins: [{ name: 'canonical-afs-runtime', setup(build) {
      build.onResolve({ filter: /^@undefineds\.co\/xpod-cli\/output$/ }, () => ({ path: producerInput.resolveImport('output'), external: false }));
      build.onResolve({ filter: /^\./ }, (args) => {
        const base = path.resolve(path.dirname(args.importer), args.path);
        const source = [base + '.ts', path.join(base, 'index.ts')].find((candidate) => sharedSources.has(candidate));
        return source ? { path: sharedSources.get(source)!, external: true } : undefined;
      });
    } }],
  });
  if (!entry.success || entry.outputs.length !== 1) { throw new Error('AFS command entry build failed'); }
  writeFileSync(path.join(root, 'dist/command-host.mjs'), await entry.outputs[0].text());
  // In-memory Bun.build paths are relative to the actual invoking cwd. Record
  // their absolute physical inputs so the library and command graphs can share
  // a repository-confined notice/source collector without guessing path roots.
  const absoluteInput = (filename: string) => path.resolve(process.cwd(), filename);
  const commandMetafile = {
    inputs: Object.fromEntries(Object.entries(entry.metafile.inputs).map(([filename, input]) => [absoluteInput(filename), input])),
    outputs: Object.fromEntries(Object.entries(entry.metafile.outputs).map(([filename, output]) => [filename, {
      ...output, inputs: Object.fromEntries(Object.entries(output.inputs ?? {}).map(([input, contribution]) => [absoluteInput(input), contribution])),
    }])),
  };
  writeFileSync(path.join(root, 'dist/commands-inputs.json'), JSON.stringify(commandMetafile, null, 2) + '\n');
  const commandNames = publicValueExports['./commands'];
  writeFileSync(path.join(root, 'dist/commands.mjs'), "import * as commands from './command-host.mjs';\n" + commandNames.map(name => `export const ${name} = commands.${name};`).join('\n') + '\n');
  writeFileSync(path.join(root, 'dist/commands.cjs'), "const commands = require('./command-host.mjs');\nmodule.exports = { " + commandNames.map(name => `${name}: commands.${name}`).join(', ') + ' };\n');
  writeFileSync(path.join(root, 'dist/entry.mjs'), "import { runAfs, handleCliError, registerModuleSdk } from './command-host.mjs';\nimport { bindModuleRoot } from './runtime.mjs';\nimport { fileURLToPath } from 'node:url';\nbindModuleRoot(fileURLToPath(new URL('../', import.meta.url)));\nregisterModuleSdk();\ntry { await runAfs(process.argv.slice(2)); } catch (error) { handleCliError(error, process.argv.includes('--json'), 'module_failed'); }\n");

  declarationBuild.emitDeclarations();
  // Emitted declarations follow the package's ESM contract. Resolve against
  // actual output, so Node16 and classic Node see the same canonical graph.
  function declarationFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? declarationFiles(file) : file.endsWith('.d.ts') ? [file] : [];
    });
  }
  for (const file of declarationFiles(path.join(root, 'dist/types'))) {
    const content = readFileSync(file, 'utf8');
    const syntax = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const edits: Array<{start: number; end: number; value: string}> = [];
    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node) && node.text.startsWith('.') &&
          ((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) ||
           (ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)))) {
        const original = node.text;
        const absolute = path.resolve(path.dirname(file), original);
        let specifier = original;
        let declaration: string;
        if (/\.(?:js|mjs|cjs)$/.test(original)) {
          declaration = absolute.replace(/\.(js|mjs|cjs)$/, (_, ext: string) => ext === 'js' ? '.d.ts' : ext === 'mjs' ? '.d.mts' : '.d.cts');
        } else if (existsSync(absolute + '.d.ts')) {
          declaration = absolute + '.d.ts'; specifier += '.js';
        } else if (existsSync(path.join(absolute, 'index.d.ts'))) {
          declaration = path.join(absolute, 'index.d.ts'); specifier += '/index.js';
        } else { throw new Error('Unresolved emitted AFS declaration import'); }
        if (!existsSync(declaration)) { throw new Error('Missing emitted AFS declaration target'); }
        edits.push({start: node.getStart(syntax) + 1, end: node.getEnd() - 1, value: specifier});
      }
      ts.forEachChild(node, visit);
    }
    visit(syntax);
    let output = content;
    for (const edit of edits.sort((a,b) => b.start-a.start)) { output = output.slice(0,edit.start) + edit.value + output.slice(edit.end); }
    writeFileSync(file, output);
  }


  typeInput.assertCurrent();
  const generator = path.join(path.dirname(createRequire(import.meta.url).resolve('componentsjs-generator/package.json')), 'bin/componentsjs-generator.js');
  const components = spawnSync('bun', [generator, '-s', 'src', '-c', 'dist/components', '-i', '../../config/components-ignore.json', '.'], { cwd: root, stdio: 'inherit' });
  if (components.status !== 0) { throw new Error('AFS contract metadata build failed'); }
  const producer = await resolveProducerMaterials(producerInput.indexPath, clientRoot, producerInput.tools);
  collectAfsJavascriptMaterials({ buildTools: producerInput.tools, packageRoot: root, repoRoot: path.resolve(root, '../..'),
    destination: path.join(root, 'dist/licenses'), target: `${process.platform}-${process.arch}`,
    library: path.join(root, 'dist/library.cjs'), libraryMetafile: path.join(root, 'dist/library-inputs.json'),
    commands: path.join(root, 'dist/command-host.mjs'), commandsMetafile: path.join(root, 'dist/commands-inputs.json'),
    producer, vendoredRoots: [clientRoot] });

  // Keep original output notices and their shared content-addressed references.
  typeInput.assertCurrent();
  cpSync(path.join(producerInput.root, 'dist/licenses'), path.join(root, 'dist/licenses/cli-producer-original'), { recursive: true });
  writeFileSync(path.join(root, 'dist/licenses/cli-producer-original-binding.json'), JSON.stringify({ status: 'build-input-only', producer: producer.binding.producer, indexSHA256: producer.binding.indexSHA256, outputPayloads: producer.binding.outputPayloads }, null, 2) + '\n');
  typeInput.assertCurrent();

}

// Importing the builder must not resolve CLI arguments or open a second scope.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const producer = resolveProducerInput(process.argv.slice(2));
  const client = resolveRuntimeClientInput(process.argv.slice(2));
  await withStagedProducerInput(producer, path.join(root, '.test-data'), staged => buildAfsClient(staged, client));
}
