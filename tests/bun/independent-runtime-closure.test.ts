import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyRuntimeClosure, inspectRuntimeGraph } from '../../scripts/lib/independent-admission/runtime-closure';
import { MODULE_TARGETS } from '../../packages/xpod-cli/src/module-catalog';
import { externalRuntimeLauncher } from '../../packages/xpod-cli/src/launcher';
import type { AdmissionContext } from '../../scripts/lib/independent-admission';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(input: Record<string, string | Buffer>, options: { manifest?: Record<string, any>; target?: string } = {}) {
  const contents = new Map(Object.entries(input).map(([name, value]) => [options.target && name === 'index.js' ? 'index.mjs' : name, Buffer.from(value)]));
  const name = options.target ? '@undefineds.co/xpod-afs-' + options.target : '@undefineds.co/xpod-client';
  const manifest = { name, version: '1.0.0', type: 'module', main: options.target ? './index.mjs' : './index.js', ...options.manifest } as Record<string, any>;
  if (options.target) {
    const [platform, arch] = options.target.split('-');
    manifest.xpodModule = { schemaVersion: 1, cliApiVersion: 1, id: 'afs', platform, arch, entry: 'index.mjs',
      files: [...contents].map(([path, bytes]) => ({ path, sha256: hash(bytes), size: bytes.length, mode: 0o644 })) };
  }
  const pack = () => {
    const rows = new Map([['package.json', Buffer.from(JSON.stringify(manifest))], ...contents]); const blocks: Buffer[] = [];
    for (const [name, bytes] of rows) {
      const header = new Header({ path: 'package/' + name, type: 'File', mode: 0o644, size: bytes.length }); header.encode();
      blocks.push(header.block!, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  };
  const originals = new Map<string, Buffer>();
  const context: AdmissionContext = { sourceSha: 'a'.repeat(40), runHeadSha: 'b'.repeat(40), package: manifest.name,
    version: manifest.version, target: options.target, archive: pack(), readTracked: () => { throw new Error('not a source gate'); },
    readOriginal: ref => { const bytes = originals.get(ref.path); if (!bytes) throw new Error('missing original'); return bytes; } };
  const evidence = { schemaVersion: 1, kind: 'independent-runtime-closure-materials', runtime: 'node', product: {
    sourceSha: context.sourceSha, runHeadSha: context.runHeadSha, package: context.package, version: context.version,
    ...(options.target ? { target: options.target } : {}), archive: { sha256: hash(context.archive), bytes: context.archive.length,
      integrity: 'sha512-' + createHash('sha512').update(context.archive).digest('base64') } }, metafiles: [] as Array<{ path: string; sha256: string }> };
  const repack = () => { context.archive = pack(); evidence.product.archive = { sha256: hash(context.archive), bytes: context.archive.length, integrity: 'sha512-' + createHash('sha512').update(context.archive).digest('base64') }; };
  return { context, evidence, manifest, contents, originals, repack, verify: () => verifyRuntimeClosure(evidence, context) };
}

describe('real packed runtime dependency observation, never admission booleans', () => {
  it('audits the final graph after dependency insertion, including unreferenced native members', () => {
    const members = [{path: 'package/package.json', content: Buffer.from('{"name":"main","version":"1.0.0"}'), mode: 0o644}];
    expect(inspectRuntimeGraph(members).nativeMembers).toEqual([]);
    members.push({path: 'package/node_modules/dep/package.json', content: Buffer.from('{"name":"dep","version":"1.0.0"}'), mode: 0o644},
      {path: 'package/node_modules/dep/main.cjs', content: Buffer.from('module.exports=1'), mode: 0o644},
      {path: 'package/node_modules/dep/unused.wasm', content: Buffer.from('invalid wasm'), mode: 0o644});
    expect(() => inspectRuntimeGraph(members)).toThrow('format/target mismatch');
    members[members.length - 1].content = Buffer.from('0061736d01000000', 'hex');
    expect(inspectRuntimeGraph(members).nativeMembers).toEqual(['package/node_modules/dep/unused.wasm']);
    members.push({path: 'package/node_modules/dep/tool', content: Buffer.from('native helper'), mode: 0o755});
    expect(inspectRuntimeGraph(members).nativeMembers).toContain('package/node_modules/dep/tool');
  });
  it('rejects file/directory collisions in either graph insertion order', () => {
    const existing = {path: 'package/node_modules/dep/data/item', content: Buffer.from('existing data'), mode: 0o644};
    const mounted = {path: 'package/node_modules/dep/data', content: Buffer.from('new file'), mode: 0o644};
    for (const members of [[existing, mounted], [mounted, existing]]) expect(() => inspectRuntimeGraph(members)).toThrow('file/directory conflict');
  });
  it('recomputes package identity duplication on the final mounted graph', () => {
    const manifest = Buffer.from('{"name":"dep","version":"1.0.0"}');
    const members = [{path: 'package/node_modules/dep/package.json', content: manifest, mode: 0o644}];
    expect(inspectRuntimeGraph(members).duplicateIdentities).toEqual([]);
    members.push({path: 'package/node_modules/other/node_modules/dep/package.json', content: manifest, mode: 0o644});
    expect(inspectRuntimeGraph(members).duplicateIdentities).toEqual(['dep@1.0.0']);
  });
  it('distinguishes text parsing and custom exec methods from imported process execution', () => {
    const result = fixture({ 'index.js': "const pattern=/text/g; pattern.exec('text'); const custom={exec(x){return x;}}; custom.exec('value');" }).verify();
    expect(result.facts.runtimeImportsVerified).toBe(true);
    expect(result.diagnostics.length).toBe(0);
    for (const code of ["import cp from 'node:child_process'; cp.exec(process.env.COMMAND);", "import {exec as run} from 'node:child_process'; run(process.env.COMMAND);"]) {
      const child = fixture({ 'index.js': code }).verify();
      expect(child.pending).toContain('resource-or-child-lookup-ownership-unverified');
      expect(child.diagnostics.some(site => site.expression.includes('process.env.COMMAND'))).toBe(true);
    }
  });
  it('resolves a module-anchored createRequire literal while preserving computed or foreign loader gaps', () => {
    const result = fixture({ 'index.js': "import {createRequire as make} from 'node:module'; const load=make(import.meta.url); load('./dep.cjs');", 'dep.cjs': 'module.exports=42;' }).verify();
    expect(result.facts.runtimeImportsVerified).toBe(true);
    expect(result.edges.some(edge => edge.resolved === 'package/dep.cjs')).toBe(true);
    expect(() => fixture({ 'index.js': "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); require('./missing.cjs');" }).verify()).toThrow('missing packed runtime member');
    const computed = fixture({ 'index.js': "import {createRequire} from 'node:module'; const load=createRequire(import.meta.url); load(process.env.MODULE);" }).verify();
    expect(computed.pending).toContain('computed-module-resolution-unverified');
    const foreign = fixture({ 'index.js': "import {createRequire} from 'node:module'; const load=createRequire('/tmp/foreign.js'); load('./dep.cjs');", 'dep.cjs': 'module.exports=42;' }).verify();
    expect(foreign.pending).toContain('dynamic-code-or-require-scope-unverified');
    const escaped = fixture({ 'index.js': "import {createRequire} from 'node:module'; const load=createRequire(import.meta.url); globalThis.loader=load;" }).verify();
    expect(escaped.pending).toContain('escaped-anchored-loader-unverified');
  });
  it('records filesystem data inputs separately from package code and static URL resources', () => {
    const result = fixture({ 'index.js': "import {readFileSync as read} from 'node:fs'; export function body(filePath){return read(filePath);}" }).verify();
    expect(result.runtimeDataAccess.length).toBe(1);
    expect(result.runtimeDataAccess[0].expression).toBe('read(filePath)');
    expect(result.facts.runtimeImportsVerified).toBe(true);
    expect(result.pending.includes('resource-or-child-lookup-ownership-unverified')).toBe(false);
  });
  it('reports optional peer capability requirements with the exact AST site without admitting the session capability', () => {
    const result = fixture({ 'index.js': "export function session(){return require('optional-sdk');}" }, {
      manifest: { peerDependencies: { 'optional-sdk': '^1.0.0' }, peerDependenciesMeta: { 'optional-sdk': { optional: true } } },
    }).verify();
    expect(result.pending).toContain('optional-peer-capability-required:optional-sdk');
    expect(result.edges.some(edge => edge.request === 'optional-sdk' && edge.optionalPeer)).toBe(true);
    expect(result.diagnostics.some(site => site.line === 1 && site.expression === "'optional-sdk'")).toBe(true);
    expect(result.facts.runtimeClosureVerified).toBe(false);
  });
  it('traverses only the exact shared launcher template to its actual shipped JavaScript payload', () => {
    const result = fixture({ 'index.js': 'export {};', 'bin/tool': externalRuntimeLauncher({ payload: 'xpod.mjs' }), 'xpod.mjs': "import './payload.mjs';", 'payload.mjs': 'export {};' }, {
      manifest: { bin: { tool: './bin/tool' } },
    }).verify();
    expect(result.facts.inspectedScripts).toContain('package/xpod.mjs');
    expect(result.facts.inspectedScripts).toContain('package/payload.mjs');
    expect(result.pending.includes('non-JavaScript-entry-resolver-unverified')).toBe(false);
    const altered = fixture({ 'index.js': 'export {};', 'bin/tool': externalRuntimeLauncher({ payload: 'xpod.mjs' }) + 'echo modified\n', 'xpod.mjs': 'export {};' }, {
      manifest: { bin: { tool: './bin/tool' } },
    }).verify();
    expect(altered.pending).toContain('non-JavaScript-entry-resolver-unverified');
  });
  it('resolves packed relative imports and core builtins without invoking callbacks or code', () => {
    const f = fixture({ 'index.js': "import './dep.js'; import fs from 'node:fs'; throw Error('must not execute');", 'dep.js': 'export const value=42;' });
    const result = f.verify();
    expect(result.facts.literalResolutionVerified).toBe(true);
    expect(result.edges.some(edge => edge.from === 'package/index.js' && edge.request === './dep.js' && edge.resolved === 'package/dep.js')).toBe(true);
    expect(result.edges.some(edge => edge.builtin === 'node:fs')).toBe(true);
    expect(result.status).toBe('pending'); expect(result.facts.sourceQualified).toBe(false);
    expect(result.pending).toContain('controlled-archive-custody-capability-unavailable');
  });
  it('resolves CJS extension and directory indexes entirely inside the packed root', () => {
    const f = fixture({ 'index.js': "require('./dir');", 'dir/index.js': "module.exports=require('./data.json');", 'dir/data.json': '{"value":42}' }, { manifest: { type: 'commonjs' } });
    expect(f.verify().edges.map(edge => edge.resolved)).toEqual(['package/dir/index.js', 'package/dir/data.json']);
  });
  it('uses conditional exports for the requested interpreter and import/require mode', () => {
    const files = { 'index.js': "import 'vendor';", 'node_modules/vendor/package.json': JSON.stringify({ name: 'vendor', exports: { bun: './bun.js', node: { import: './node.mjs', require: './node.cjs' } } }),
      'node_modules/vendor/bun.js': 'export {};', 'node_modules/vendor/node.mjs': 'export {};', 'node_modules/vendor/node.cjs': 'module.exports={};' };
    const node = fixture(files); expect(node.verify().edges[0].resolved).toBe('package/node_modules/vendor/node.mjs');
    const bun = fixture(files); bun.evidence.runtime = 'bun'; expect(bun.verify().edges[0].resolved).toBe('package/node_modules/vendor/bun.js');
    const cjs = fixture({ ...files, 'index.js': "require('vendor');" }, { manifest: { type: 'commonjs' } });
    expect(cjs.verify().edges[0].resolved).toBe('package/node_modules/vendor/node.cjs');
  });
  it('resolves package imports, self exports and public wildcard entries', () => {
    const f = fixture({ 'index.js': "import '#utility'; import '@undefineds.co/xpod-client/other';", 'dist/utility.js': 'export {};', 'dist/other.js': 'export {};' },
      { manifest: { imports: { '#utility': './dist/utility.js' }, exports: { '.': './index.js', './*': './dist/*.js' } } });
    expect(f.verify().facts.entrypoints).toEqual(['package/dist/other.js', 'package/dist/utility.js', 'package/index.js']);
    expect(f.verify().edges.some(edge => edge.request === '#utility' && edge.resolved === 'package/dist/utility.js')).toBe(true);
  });
  it('agrees with real Node and Bun conditional resolution in the same tiny isolated package', () => {
    const f = fixture({
      'index.cjs': "const required=require('vendor').value; import('vendor').then(m=>process.stdout.write(JSON.stringify({required,imported:m.value})));",
      'node_modules/vendor/package.json': JSON.stringify({ name: 'vendor', exports: {
        bun: { import: './bun-import.mjs', require: './bun-require.cjs' },
        node: { import: './node-import.mjs', require: './node-require.cjs' },
      } }),
      'node_modules/vendor/node-import.mjs': "export const value='node-import';",
      'node_modules/vendor/node-require.cjs': "module.exports={value:'node-require'};",
      'node_modules/vendor/bun-import.mjs': "export const value='bun-import';",
      'node_modules/vendor/bun-require.cjs': "module.exports={value:'bun-require'};",
    }, { manifest: { main: './index.cjs', type: 'commonjs' } });
    const parent = path.resolve('.test-data/independent-runtime-closure'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'case-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify(f.manifest));
      for (const [name, bytes] of f.contents) { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); }
      for (const runtime of ['node', 'bun']) {
        f.evidence.runtime = runtime;
        const result = spawnSync(runtime, ['index.cjs'], { cwd: root, encoding: 'utf8', timeout: 2000 });
        expect(result.status).toBe(0); expect(result.signal).toBeNull();
        const actual = JSON.parse(result.stdout);
        expect(actual).toEqual({ required: runtime + '-require', imported: runtime + '-import' });
        const observed = f.verify();
        expect(observed.edges.some(edge => edge.kind === 'require' && edge.resolved === 'package/node_modules/vendor/' + actual.required + '.cjs')).toBe(true);
        expect(observed.edges.some(edge => edge.kind === 'import' && edge.resolved === 'package/node_modules/vendor/' + actual.imported + '.mjs')).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('does not resolve missing dependencies from the host/workspace/global environment', () => {
    expect(() => fixture({ 'index.js': "import 'typescript';" }).verify()).toThrow('dependency absent from packed root');
    expect(() => fixture({ 'index.js': "import './missing.js';" }).verify()).toThrow('missing packed runtime member');
  });
  it('keeps an exact declared external dependency pending until its actual related artifact is supplied', () => {
    const result = fixture({ 'index.js': "import '@undefineds.co/xpod-client';" }, {
      manifest: { dependencies: { '@undefineds.co/xpod-client': '1.2.3' } },
    }).verify();
    expect(result.status).toBe('pending');
    expect(result.pending).toContain('related-artifact-required:@undefineds.co/xpod-client@1.2.3');
    expect(result.facts.runtimeImportsVerified).toBe(false);
    expect(() => fixture({ 'index.js': "import 'typescript';" }, {
      manifest: { dependencies: { typescript: '^5.0.0' } },
    }).verify()).toThrow('dependency absent from packed root');
  });
  it('cannot turn serialized related package claims into collector capabilities', () => {
    const f = fixture({ 'index.js': "import '@undefineds.co/xpod-client';" }, {
      manifest: { dependencies: { '@undefineds.co/xpod-client': '1.2.3' } },
    });
    f.context.relatedArtifacts = [{ identity: { package: '@undefineds.co/xpod-client', version: '1.2.3' },
      members: [], readMember: () => { throw Error('untrusted reader must not run'); } }];
    const result = f.verify();
    expect(result.status).toBe('pending');
    expect(result.pending).toContain('related-artifact-capability-unavailable');
    expect(result.pending).toContain('related-artifact-required:@undefineds.co/xpod-client@1.2.3');
    f.context.relatedArtifacts = Array.from({ length: 65 }, () => ({}));
    expect(() => f.verify()).toThrow('related artifact count budget exceeded');
  });
  for (const request of ['../../escape.js', '/tmp/host.js', 'file:///tmp/host.js', 'https://example.invalid/code.js']) {
    it('rejects code resolution outside the archive: ' + request, () => {
      expect(() => fixture({ 'index.js': `import ${JSON.stringify(request)};` }).verify()).toThrow();
    });
  }
  it('rejects unsafe export targets and non-exported private package paths', () => {
    expect(() => fixture({ 'index.js': 'export {};' }, { manifest: { exports: '../escape.js' } }).verify()).toThrow('unsafe package export');
    expect(() => fixture({ 'index.js': "import 'vendor/private.js';", 'node_modules/vendor/package.json': '{"name":"vendor","exports":"./index.js"}', 'node_modules/vendor/index.js': 'export {};' }).verify()).toThrow('not exported');
  });
  it('keeps Node ESM exact filenames distinct from CJS/Bun extension resolution', () => {
    const f = fixture({ 'index.js': "import './dep';", 'dep.js': 'export {};' });
    expect(() => f.verify()).toThrow('missing packed runtime member');
    f.evidence.runtime = 'bun'; expect(f.verify().edges[0].resolved).toBe('package/dep.js');
  });
  it('derives every entry from the packed manifest, including a second broken bin', () => {
    expect(() => fixture({ 'index.js': 'export {};' }, { manifest: { bin: { first: './index.js', hidden: './missing.js' } } }).verify()).toThrow('missing packed runtime member');
  });
  for (const target of MODULE_TARGETS.map(row => row.platform + '-' + row.arch)) {
    it('verifies platform inventory/identity for catalog target ' + target, () => {
      const f = fixture({ 'index.js': 'export {};' }, { target });
      expect(f.verify().facts.manifestInventoryVerified).toBe(true);
      expect(f.verify().status).toBe('pending');
    });
  }
  it('rejects corrupted inventory bytes, extra files, and cross-target/source/archive bindings', () => {
    const f = fixture({ 'index.js': 'export {};' }, { target: 'linux-x64' });
    f.evidence.product.sourceSha = 'c'.repeat(40); expect(() => f.verify()).toThrow('binding mismatch');
    const wrongTarget = fixture({ 'index.js': 'export {};' }, { target: 'linux-x64' }); wrongTarget.context.target = 'darwin-x64';
    expect(() => wrongTarget.verify()).toThrow('binding mismatch');
    const bad = fixture({ 'index.js': 'export {};' }); bad.context.archive = Buffer.from('different');
    expect(() => bad.verify()).toThrow('binding mismatch');
    const raw = fixture({ 'index.js': 'export {};' }, { target: 'linux-x64' });
    // Repack after changing only the claimed inventory digest, not the bytes.
    raw.manifest.xpodModule.files[0].sha256 = 'f'.repeat(64);
    const altered = fixture({ 'index.js': 'export {};' }, { manifest: raw.manifest });
    altered.context.target = 'linux-x64'; (altered.evidence.product as any).target = 'linux-x64';
    expect(() => altered.verify()).toThrow('inventory bytes/mode mismatch');
  });
  it('marks computed code, lazy optional imports, resource ownership and nonlocal requires unresolved', () => {
    for (const code of ["import(process.env.CODE);", "require('./' + process.env.CODE);", "try { require('optional-vendor'); } catch {}", "function optional(){return require('optional-vendor')}",
      "fs.readFileSync(process.env.DATA);", "globalThis.require('outside');", "new Worker(process.env.WORKER);", "eval('arbitrary code');"]) {
      const result = fixture({ 'index.js': code }).verify();
      expect(result.facts.literalResolutionVerified).toBe(false);
      expect(result.status).toBe('pending');
    }
  });
  it('resolves URL-anchored packed assets and rejects a missing asset', () => {
    const f = fixture({ 'index.js': "const resource=new URL('./data.txt', import.meta.url);", 'data.txt': 'actual bytes' });
    expect(f.verify().edges[0]).toMatchObject({ kind: 'resource', resolved: 'package/data.txt' });
    expect(() => fixture({ 'index.js': "new URL('./missing.txt',import.meta.url);" }).verify()).toThrow('missing packed resource');
    expect(fixture({ 'index.js': "new URL('./',import.meta.url);" }).verify().pending).toContain('directory-resource-lookup-unverified');
  });
  it('rejects unconditional Bun-only builtins on Node, but keeps unknown lazy guards pending', () => {
    expect(() => fixture({ 'index.js': "import 'bun:sqlite';" }).verify()).toThrow('Bun-only builtin on Node');
    expect(fixture({ 'index.js': "function maybe(){return require('bun:sqlite')}" }).verify().pending).toContain('runtime-conditional-builtin-unverified');
    const bun = fixture({ 'index.js': "import 'bun:sqlite';" }); bun.evidence.runtime = 'bun';
    expect(bun.verify().edges[0].builtin).toBe('bun:sqlite');
    expect(() => fixture({ 'index.js': "import 'node:nonexistent';" }).verify()).toThrow('unknown Node builtin');
  });
  it('rehashes original metafiles without treating source-graph relative externals as shipped runtime imports', () => {
    const f = fixture({ 'index.js': 'export {};' });
    const bytes = Buffer.from(JSON.stringify({ inputs: { 'src/start.ts': { imports: [{ path: '../module-store', external: true }] } }, outputs: { 'dist/output.js': {} } }));
    f.originals.set('metafile.json', bytes); f.evidence.metafiles.push({ path: 'metafile.json', sha256: hash(bytes) });
    expect(f.verify().facts.originalMetafilesRehashed).toBe(1);
    expect(f.verify().facts.literalResolutionVerified).toBe(true);
    f.originals.set('metafile.json', Buffer.from('{}'));
    expect(() => f.verify()).toThrow('metafile original hash mismatch');
  });
  it('rejects original/archive mutation during a read callback', () => {
    const f = fixture({ 'index.js': 'export {};' }); const bytes = Buffer.from('{"inputs":{},"outputs":{}}');
    f.evidence.metafiles.push({ path: 'meta.json', sha256: hash(bytes) });
    f.context.readOriginal = () => { f.context.archive[0] ^= 1; return bytes; };
    expect(() => f.verify()).toThrow('archive changed');
  });
  it('uses the shared physical native format verifier without manufacturing native/source approval', () => {
    const elf = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elf);
    elf.writeUInt32LE(1, 20); elf.writeUInt16LE(3, 16); elf.writeUInt16LE(62, 18); elf.writeUInt16LE(64, 52);
    const f = fixture({ 'index.js': "require('./addon.node');", 'addon.node': elf }, { target: 'linux-x64' });
    expect(f.verify().facts.nativeTargetsChecked).toContain('package/addon.node');
    expect(f.verify().pending).toContain('native-source-ABI-origin-admission-unverified');
    elf.writeUInt16LE(183, 18);
    expect(() => fixture({ 'index.js': 'export {};', 'addon.node': elf }, { target: 'linux-x64' }).verify()).toThrow('format/target mismatch');
  });
  it('rejects unlisted physical files and permission drift without trusting an inventory claim', () => {
    const extra = fixture({ 'index.js': 'export {};' }, { target: 'linux-x64' });
    extra.contents.set('hidden.txt', Buffer.from('unbound')); extra.repack();
    expect(() => extra.verify()).toThrow('unbound packed file');
    const mode = fixture({ 'index.js': 'export {};' }, { target: 'linux-x64' });
    mode.manifest.xpodModule.files[0].mode = 0o755; mode.repack();
    expect(() => mode.verify()).toThrow('inventory bytes/mode mismatch');
    expect(() => fixture({ 'index.js': 'export {};', 'file': 'not a directory', 'file/child.js': 'export {};' }).verify()).toThrow('non-directory packed member ancestor');
  });
  it('keeps target arrays, local require replacement and aliased IO pending instead of pretending resolution', () => {
    const array = fixture({ 'index.js': "import 'vendor';", 'node_modules/vendor/package.json': '{"name":"vendor","exports":["./entry.js"]}', 'node_modules/vendor/entry.js': 'export {};' });
    expect(array.verify().pending).toContain('package-target-array-resolution-unverified');
    for (const code of ["const require=()=>42; require('not-real');", "const load=require; load('not-real');"]) {
      const result = fixture({ 'index.js': code }).verify();
      expect(result.status).toBe('pending'); expect(result.facts.literalResolutionVerified).toBe(false);
    }
  });
  it('bounds circular package main resolution and refuses unsafe artifact-member paths', () => {
    expect(() => fixture({ 'index.js': "require('vendor');", 'node_modules/vendor/package.json': '{"name":"vendor","main":"."}' }).verify()).toThrow('resolution cycle/budget');
    expect(() => fixture({ 'index.js': 'export {};', ['hidden' + String.fromCharCode(10) + '.txt']: 'data' }).verify()).toThrow('unsafe packed member');
  });
  it('reports unvisited packed scripts and missing declared originals explicitly', () => {
    const f = fixture({ 'index.js': 'export {};', 'unvisited.js': "require('unverified');" });
    expect(f.verify().facts.unvisitedScripts).toEqual(['package/unvisited.js']);
    expect(f.verify().pending).toContain('unvisited-runtime-script-members');
    f.evidence.metafiles.push({ path: 'absent.json', sha256: 'f'.repeat(64) });
    expect(() => f.verify()).toThrow('missing original');
  });
  it('cannot be cleared by unknown schemas, serialized metadata observations or caller approval flags', () => {
    const f = fixture({ 'index.js': 'export {};' });
    expect(verifyRuntimeClosure({ passed: true, nativeAccepted: true }, f.context).pending).toContain('runtime-material-schema-unverified');
    expect(() => verifyRuntimeClosure({ ...f.evidence, legalAccepted: true }, f.context)).toThrow('unexpected material fields');
    f.context.githubOrigin = { sourceQualified: true, originAdmissionVerified: true };
    expect(f.verify().facts.originAdmissionVerified).toBe(false);
    expect(f.verify().pending).toContain('source-admission-capability-unavailable');
  });
});


it('does not classify a relative literal filesystem resource as proven user data', () => {
  const result = fixture({ 'index.js': "import {readFileSync} from 'node:fs'; export const config=readFileSync('./runtime-config.json');" }).verify();
  expect(result.pending).toContain('relative-filesystem-resource-scope-unverified');
  expect(result.facts.dataAndNativeResolutionVerified).toBe(false);
});
