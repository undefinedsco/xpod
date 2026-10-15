import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Generator } from 'componentsjs-generator';
import { GeneratorFactory } from 'componentsjs-generator/lib/config/GeneratorFactory';
import { ResolutionContext } from 'componentsjs-generator/lib/resolution/ResolutionContext';
import { cssConfigStrings, cssResourceFiles, cssSourceExports, planCssResources, type CssResourcePlan } from './component-resources';

/** Build-time adapter only. The original package/source files remain untouched. */
export async function buildScopedCssComponents(root: string, output: string): Promise<{ plan: CssResourcePlan; metadataRoot: string }> {
  if (existsSync(output)) throw new Error('Fresh scoped Components output required');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const compiler = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  if (compiler.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(compiler.errors, diagnosticHost));
  const exports = new Map([...cssSourceExports(root)].filter(([, item]) => item.isComponent));
  const resolutionContext = new ResolutionContext();
  const ignoreFile = path.join(root, 'config/components-ignore.json');
  const generatorConfig = await new GeneratorFactory({ resolutionContext }).getConfig(root, existsSync(ignoreFile) ? { i: ignoreFile } : {});
  const logLevel = (() => {
    switch (generatorConfig.logLevel) {
      case 'error': case 'warn': case 'info': case 'verbose': case 'debug': case 'silly': return generatorConfig.logLevel;
      default: throw new Error('Invalid Components generator log level');
    }
  })();
  const ownPrefix = typeof generatorConfig.modulePrefix === 'string' ? generatorConfig.modulePrefix : generatorConfig.modulePrefix?.[manifest.name];
  const ownModule = manifest['lsd:module'] === true ? 'https://linkedsoftwaredependencies.org/bundles/npm/' + manifest.name : manifest['lsd:module'];
  const selected = new Set<string>();
  const select = (value: string): void => {
    const short = value.split(':')[0];
    if (exports.has(short) && !generatorConfig.ignoreComponents.includes(short)) selected.add(short);
    if ((ownPrefix && value.startsWith(ownPrefix + ':')) || (typeof ownModule === 'string' && value.startsWith(ownModule + '/'))) {
      const local = value.split('#')[1];
      const name = local && (exports.has(local) ? local : [...exports.keys()].filter(name => local.startsWith(name + '_')).sort((a, b) => b.length - a.length)[0]);
      if (name && !generatorConfig.ignoreComponents.includes(name)) selected.add(name);
    }
  };
  for (const file of cssResourceFiles(root).filter(file => file.startsWith('config/') && file.endsWith('.json'))) {
    cssConfigStrings(JSON.parse(readFileSync(path.join(root, file), 'utf8'))).forEach(select);
  }
  if (!selected.size) throw new Error('CSS configuration selects no canonical component exports');
  mkdirSync(output, { recursive: true });
  const iterations: Array<{ selected: string[]; sources: Array<{ path: string; sha256: string }>; declarations: string[] }> = [];
  // Selection grows monotonically and is bounded by the canonical public exports.
  for (let iteration = 0; iteration <= exports.size; iteration++) {
    // The original generator puts public classes from one source in one
    // document. Preserve those sibling definitions before regenerating it.
    const documents = new Set([...selected].map(name => exports.get(name)!.source));
    for (const [name, item] of exports) if (documents.has(item.source) && !generatorConfig.ignoreComponents.includes(name)) selected.add(name);
    const names = [...selected].sort();
    const sources = [...new Set(names.map(name => exports.get(name)!.source))];
    const program = ts.createProgram(sources.map(source => path.join(root, source)), {
      ...compiler.options, noEmit: false, declaration: true, emitDeclarationOnly: true, noEmitOnError: true,
      rootDir: path.join(root, 'src'), outDir: path.join(output, 'dist'), incremental: false, composite: false, tsBuildInfoFile: undefined,
      sourceMap: false, inlineSourceMap: false, inlineSources: false, declarationMap: false, listEmittedFiles: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) throw new Error('Scoped CSS declaration compilation failed:\n' + ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
    rmSync(path.join(output, 'dist'), { recursive: true, force: true });
    const declarations: string[] = [];
    // JSON still participates in the complete strict check above, but has no
    // declaration output. Its global emitSkipped flag must not hide whether
    // each actual TS/JS source emitted its required declaration successfully.
    for (const file of program.getSourceFiles().filter(file => !file.isDeclarationFile && !file.fileName.toLowerCase().endsWith('.json'))) {
      const relative = path.relative(path.join(root, 'src'), file.fileName);
      const declaration = relative.replace(/\.(m|c)?[tj]sx?$/u, (_, kind: string | undefined) => '.d.' + (kind ?? '') + 'ts');
      const expected = path.resolve(output, 'dist', declaration);
      const emitted = program.emit(file, undefined, undefined, true);
      if (declaration === relative || emitted.emitSkipped || emitted.diagnostics.length || !emitted.emittedFiles?.some(file => path.resolve(file) === expected) || !existsSync(expected)) {
        throw new Error('Scoped CSS declaration emission failed for ' + path.relative(root, file.fileName) + ':\n' + ts.formatDiagnosticsWithColorAndContext(emitted.diagnostics, diagnosticHost));
      }
      declarations.push(path.relative(output, expected).split(path.sep).join('/'));
    }
    mkdirSync(path.join(output, 'dist'), { recursive: true });
    // Match the canonical package's dist declaration layout. The generator
    // derives protocol/parameter IRIs from these paths, not just class names.
    writeFileSync(path.join(output, 'dist/.css-components-entry.d.ts'), names.map(name => {
      const item = exports.get(name)!;
      const target = './' + item.source.slice('src/'.length).replace(/\.[cm]?tsx?$/u, '');
      return `export { ${item.localName} as ${name} } from ${JSON.stringify(target)};`;
    }).join('\n') + '\n');
    writeFileSync(path.join(output, 'package.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, types: 'dist/.css-components-entry.d.ts',
      ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key.startsWith('lsd:'))),
    }, null, 2) + '\n');
    const inputs = program.getSourceFiles().filter(file => !file.isDeclarationFile).map(file => {
      const relative = path.relative(root, file.fileName).split(path.sep).join('/');
      if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Scoped CSS source outside canonical package: ' + relative);
      return { path: relative, sha256: createHash('sha256').update(readFileSync(file.fileName)).digest('hex') };
    }).sort((a, b) => a.path.localeCompare(b.path));
    iterations.push({ selected: names, sources: inputs, declarations: declarations.sort() });
    await new Generator({ resolutionContext: new ResolutionContext(), pathDestinations: [{
      packageRootDirectory: output, originalPath: path.join(output, 'src'), replacementPath: path.join(output, 'dist/components'),
    }], fileExtension: 'jsonld', ignoreClasses: Object.fromEntries(generatorConfig.ignoreComponents.map(name => [name, true])),
    logLevel, debugState: false, prefixes: generatorConfig.modulePrefix, hardErrorUnsupported: true }).generateComponents();
    const inspect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) inspect(file);
        else if (entry.name.endsWith('.jsonld')) cssConfigStrings(JSON.parse(readFileSync(file, 'utf8'))).forEach(select);
      }
    };
    inspect(path.join(output, 'dist'));
    if (selected.size !== names.length) continue;
    const plan = planCssResources(root, output);
    if (plan.componentExports.some(item => !selected.has(item.name))) {
      plan.componentExports.forEach(item => selected.add(item.name));
      continue;
    }
    writeFileSync(path.join(output, 'scoped-components.json'), JSON.stringify({ schemaVersion: 1, packageName: manifest.name,
      selectedExports: names, iterations, compilerOptions: { strict: compiler.options.strict, skipLibCheck: compiler.options.skipLibCheck },
      generatedEntry: 'dist/.css-components-entry.d.ts', originalSourceModified: false }, null, 2) + '\n');
    return { plan, metadataRoot: output };
  }
  throw new Error('Scoped CSS component closure did not stabilize');
}

const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: file => file,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => '\n',
};
