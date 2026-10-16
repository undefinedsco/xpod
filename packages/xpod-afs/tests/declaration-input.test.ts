import { test, expect } from 'bun:test';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createDeclarationInput, emitDeclarations } from '../scripts/declaration-input';

function fixture(run: (context: { root: string; client: string; cli: string; config: string; write: (name: string, body: string | object) => void }) => void): void {
  const parent = path.resolve(import.meta.dir, '../../../.test-data/afs-declaration-input'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  const write = (name: string, body: string | object): void => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)); };
  try {
    write('normal-client/package.json', { name: '@undefineds.co/xpod-client', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } } });
    write('normal-client/dist/index.d.ts', "export { client } from './client.js';\n");
    write('normal-client/dist/client.d.ts', "export declare function client(): 'verified-client';\n");
    write('normal-cli/package.json', { name: '@undefineds.co/xpod-cli', exports: { './output': { types: './dist/output.d.ts', import: './dist/output.mjs' }, './producer-materials': './dist/index.json' } });
    write('normal-cli/dist/output.d.ts', "export declare function output(): 'verified-output';\n");
    write('workspace/src/consumer.ts', "import {client} from '@undefineds.co/xpod-client'; import {output} from '@undefineds.co/xpod-cli/output'; export const value: 'verified-client'=client(); export const result: 'verified-output'=output();\n");
    write('workspace/tsconfig.json', { compilerOptions: { target: 'ES2021', module: 'ESNext', moduleResolution: 'Bundler', strict: true, types: [], declaration: true, emitDeclarationOnly: true, outDir: 'dist/types', rootDir: 'src' }, include: ['src/**/*.ts'] });
    run({ root, client: path.join(root, 'normal-client'), cli: path.join(root, 'normal-cli'), config: path.join(root, 'workspace/tsconfig.json'), write });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('real TypeScript emits from explicit normal SDK declarations without workspace dist or leaking temporary paths', () => fixture(({ root, client, cli, config }) => {
  const workspace = path.join(root, 'workspace'); expect(existsSync(path.join(workspace, 'packages/xpod-client/dist'))).toBe(false);
  let assertions = 0; const input = createDeclarationInput([cli, client], () => { assertions++; });
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error('config'); } })!;
  const program = input.createProgram(parsed);
  expect(program.getSourceFiles().filter(file => file.fileName.includes('normal-client')).length).toBe(2);
  expect(program.getSourceFiles().some(file => /packages\/xpod-(?:client|cli)\/dist/.test(file.fileName))).toBe(false);
  emitDeclarations(config, input);
  const emitted = readFileSync(path.join(workspace, 'dist/types/consumer.d.ts'), 'utf8');
  expect(emitted).toContain('verified-client'); expect(emitted).toContain('verified-output'); expect(emitted).not.toContain(root);
  expect(assertions >= 4).toBe(true);
}));
test('missing declaration export and file cannot fall back to workspace resolution', () => {
  for (const kind of ['file', 'export']) fixture(({ client, cli, config, write }) => {
    if (kind === 'file') unlinkSync(path.join(cli, 'dist/output.d.ts'));
    else write('normal-cli/package.json', { name: '@undefineds.co/xpod-cli', exports: { './producer-materials': './dist/index.json' } });
    expect(() => emitDeclarations(config, createDeclarationInput([cli, client], () => {}))).toThrow();
  });
});
test('type export missing from an otherwise typed SDK cannot resolve through another package', () => fixture(({ client, cli, config, write }) => {
  write('normal-cli/package.json', { name: '@undefineds.co/xpod-cli', exports: { './other': { types: './dist/output.d.ts' } } });
  expect(() => emitDeclarations(config, createDeclarationInput([cli, client], () => {}))).toThrow('not declared');
}));
test('manifest, selected and transitive declaration changes are rejected during one live input scope', () => {
  for (const name of ['normal-client/package.json', 'normal-cli/dist/output.d.ts', 'normal-client/dist/client.d.ts']) fixture(({ root, client, cli, config }) => {
    const input = createDeclarationInput([cli, client], () => {}); emitDeclarations(config, input);
    const file = path.join(root, name); writeFileSync(file, readFileSync(file, 'utf8') + '\n');
    expect(() => input.assertCurrent()).toThrow('changed');
  });
});
test('unsafe, symlinked and untyped public targets fail before compilation', () => {
  for (const target of ['./../outside.d.ts', './dist/linked.d.ts', './dist/runtime.mjs']) fixture(({ root, client, cli, write }) => {
    write('outside.d.ts', 'export declare const value: string;');
    symlinkSync('output.d.ts', path.join(cli, 'dist/linked.d.ts'));
    write('normal-cli/package.json', { name: '@undefineds.co/xpod-cli', exports: { './output': { types: target } } });
    expect(() => createDeclarationInput([cli, client], () => {})).toThrow();
    expect(existsSync(path.join(root, 'workspace/dist'))).toBe(false);
  });
});
test('live producer expiration and real strict compiler errors cannot be washed into successful declarations', () => fixture(({ client, cli, config, write }) => {
  let expired = false; const input = createDeclarationInput([cli, client], () => { if (expired) throw new Error('producer expired'); });
  expired = true; expect(() => emitDeclarations(config, input)).toThrow('expired'); expired = false;
  write('workspace/src/consumer.ts', "import {client} from '@undefineds.co/xpod-client'; const wrong: number=client(); export {wrong};");
  expect(() => emitDeclarations(config, input)).toThrow('not assignable');
}));

test('transitive SDK symlinks and relative/triple-slash escapes are rejected by the same path capability', () => {
  for (const kind of ['symlink', 'relative', 'reference']) fixture(({ root, client, cli, config, write }) => {
    write('outside.d.ts', "export declare function client(): 'verified-client';");
    if (kind === 'symlink') { unlinkSync(path.join(client, 'dist/client.d.ts')); symlinkSync('../../outside.d.ts', path.join(client, 'dist/client.d.ts')); }
    if (kind === 'relative') write('normal-client/dist/index.d.ts', "export {client} from '../../outside.js';");
    if (kind === 'reference') write('normal-client/dist/index.d.ts', `/// <reference path="../../outside.d.ts" />\nexport {client} from './client.js';`);
    expect(() => emitDeclarations(config, createDeclarationInput([cli, client], () => {}))).toThrow();
  });
});
test('same-content transitive symlink replacement after the compiler read cannot pass assertCurrent', () => fixture(({ client, cli, config, write }) => {
  const input = createDeclarationInput([cli, client], () => {}); emitDeclarations(config, input);
  write('outside.d.ts', readFileSync(path.join(client, 'dist/client.d.ts'), 'utf8'));
  unlinkSync(path.join(client, 'dist/client.d.ts')); symlinkSync('../../outside.d.ts', path.join(client, 'dist/client.d.ts'));
  expect(() => input.assertCurrent()).toThrow('symlink');
}));
test('normal external public type dependencies still use the original TypeScript resolver', () => fixture(({ client, cli, config, write }) => {
  write('node_modules/public-peer/package.json', { name: 'public-peer', version: '1.0.0', types: './index.d.ts' });
  write('node_modules/public-peer/index.d.ts', "export type Value = 'verified-client';");
  write('normal-client/dist/client.d.ts', "import type {Value} from 'public-peer'; export declare function client(): Value;");
  emitDeclarations(config, createDeclarationInput([cli, client], () => {}));
}));

test('known SDK triple-slash types use the bound SDK and cannot fall back to another installed identity', () => fixture(({ root, client, cli, config, write }) => {
  write('node_modules/@undefineds.co/xpod-client/package.json', { name: '@undefineds.co/xpod-client', types: './index.d.ts' });
  write('node_modules/@undefineds.co/xpod-client/index.d.ts', 'declare const unboundTypeReference: true;');
  write('normal-cli/dist/output.d.ts', `/// <reference types="@undefineds.co/xpod-client" />\nexport declare function output(): 'verified-output';`);
  const input = createDeclarationInput([cli, client], () => {});
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error('config'); } })!;
  const program = input.createProgram(parsed);
  expect(program.getSourceFiles().some(file => file.fileName.includes('/node_modules/@undefineds.co/xpod-client/'))).toBe(false);
  expect(program.getSourceFile(path.join(client, 'dist/index.d.ts')) !== undefined).toBe(true);
  emitDeclarations(config, input);
  write('normal-cli/dist/output.d.ts', `/// <reference types="@undefineds.co/xpod-client/private" />\nexport declare function output(): 'verified-output';`);
  expect(() => emitDeclarations(config, createDeclarationInput([cli, client], () => {}))).toThrow('not declared');
}));
test('compiler Buffer A followed by on-disk B is rejected instead of hashing B as compiler input', () => fixture(({ client, cli, config, write }) => {
  const file = path.join(client, 'dist/client.d.ts'), original = fs.readFileSync;
  const input = createDeclarationInput([cli, client], () => {}); let injected = false;
  fs.readFileSync = ((name: Parameters<typeof fs.readFileSync>[0], options?: unknown) => {
    const bytes = original(name, options as never);
    if (name === file && !injected) { injected = true; write('normal-client/dist/client.d.ts', "export declare function client(): 'uncompiled-new-bytes';"); }
    return bytes;
  }) as typeof fs.readFileSync;
  try { expect(() => emitDeclarations(config, input)).toThrow('changed'); expect(injected).toBe(true); }
  finally { fs.readFileSync = original; }
}));
test('actual compiler text retains TypeScript UTF8 BOM and UTF16LE/BE BOM decoding while binding original bytes', () => {
  for (const encoding of ['utf8', 'utf16le', 'utf16be']) fixture(({ client, cli, config }) => {
    const text = "export declare function client(): 'verified-client'; // π😀\n";
    const bytes = encoding === 'utf8' ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text)])
      : Buffer.concat([encoding === 'utf16le' ? Buffer.from([0xFF, 0xFE]) : Buffer.from([0xFE, 0xFF]),
        encoding === 'utf16le' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf16le').swap16()]);
    const file = path.join(client, 'dist/client.d.ts'); writeFileSync(file, bytes);
    const expectedText = ts.sys.readFile(file), input = createDeclarationInput([cli, client], () => {});
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error('config'); } })!;
    expect(input.createProgram(parsed).getSourceFile(file)!.text).toBe(expectedText);
    emitDeclarations(config, input); input.assertCurrent(); expect(readFileSync(file).equals(bytes)).toBe(true);
  });
});
test('external public triple-slash type dependencies keep the standard resolver', () => fixture(({ client, cli, config, write }) => {
  write('node_modules/public-types/package.json', { name: 'public-types', types: './index.d.ts' });
  write('node_modules/public-types/index.d.ts', 'declare const publicTypeReference: true;');
  write('normal-cli/dist/output.d.ts', `/// <reference types="public-types" />\nexport declare function output(): 'verified-output';`);
  emitDeclarations(config, createDeclarationInput([cli, client], () => {}));
}));

for (const dependencyKind of ['type-reference', 'module-import']) test(`public conditional ${dependencyKind} import/require and inferred NodeNext modes match original TypeScript`, () => {
  const cases = [
    { module: 'ESNext', moduleResolution: 'Bundler', directive: 'require', expected: 'require.d.cts' },
    { module: 'ESNext', moduleResolution: 'Bundler', directive: 'import', expected: 'import.d.mts' },
    { module: 'NodeNext', moduleResolution: 'NodeNext', directive: 'require', expected: 'require.d.cts' },
    { module: 'NodeNext', moduleResolution: 'NodeNext', directive: 'import', expected: 'import.d.mts' },
    { module: 'NodeNext', moduleResolution: 'NodeNext', directive: undefined, packageType: 'commonjs', expected: 'require.d.cts' },
    { module: 'NodeNext', moduleResolution: 'NodeNext', directive: undefined, packageType: 'module', expected: 'import.d.mts' },
  ];
  for (const mode of cases) fixture(({ root, client, cli, config, write }) => {
    write('workspace/package.json', { type: 'module' });
    if (mode.packageType) {
      const manifest = JSON.parse(readFileSync(path.join(client, 'package.json'), 'utf8')); manifest.type = mode.packageType;
      write('normal-client/package.json', manifest);
    }
    write('node_modules/fixture-mode/package.json', { name: 'fixture-mode', version: '1.0.0', exports: { '.': { import: { types: './import.d.mts' }, require: { types: './require.d.cts' } } } });
    write('node_modules/fixture-mode/import.d.mts', dependencyKind === 'type-reference'
      ? `declare global { type FixtureModeResult = '${mode.expected === 'import.d.mts' ? 'verified-client' : 'wrong-mode'}'; } export {};`
      : `export type FixtureModeResult = '${mode.expected === 'import.d.mts' ? 'verified-client' : 'wrong-mode'}';`);
    write('node_modules/fixture-mode/require.d.cts', dependencyKind === 'type-reference'
      ? `declare global { type FixtureModeResult = '${mode.expected === 'require.d.cts' ? 'verified-client' : 'wrong-mode'}'; } export {};`
      : `export type FixtureModeResult = '${mode.expected === 'require.d.cts' ? 'verified-client' : 'wrong-mode'}';`);
    write('normal-client/dist/client.d.ts', (dependencyKind === 'type-reference'
      ? `/// <reference types="fixture-mode"${mode.directive ? ` resolution-mode="${mode.directive}"` : ''} />\n`
      : `import type {FixtureModeResult} from 'fixture-mode'${mode.directive ? ` with {"resolution-mode":"${mode.directive}"}` : ''};\n`) + 'export declare function client(): FixtureModeResult;');
    const options = JSON.parse(readFileSync(config, 'utf8')); options.compilerOptions.module = mode.module; options.compilerOptions.moduleResolution = mode.moduleResolution; write('workspace/tsconfig.json', options);
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error('config'); } })!;
    // Control-only paths let the unwrapped compiler see the same explicit SDKs.
    parsed.options.baseUrl = root; parsed.options.paths = { '@undefineds.co/xpod-client': [path.join(client, 'dist/index.d.ts')], '@undefineds.co/xpod-cli/output': [path.join(cli, 'dist/output.d.ts')] };
    const original = ts.createProgram(parsed.fileNames, parsed.options), input = createDeclarationInput([cli, client], () => {}), bound = input.createProgram(parsed);
    expect(ts.getPreEmitDiagnostics(original).length).toBe(0); expect(ts.getPreEmitDiagnostics(bound).length).toBe(0);
    const selected = (program: ts.Program): string[] => program.getSourceFiles().filter(file => file.fileName.includes('/fixture-mode/')).map(file => path.basename(file.fileName));
    expect(selected(original)).toEqual([mode.expected]); expect(selected(bound)).toEqual(selected(original));
    emitDeclarations(config, input);
  });
});
