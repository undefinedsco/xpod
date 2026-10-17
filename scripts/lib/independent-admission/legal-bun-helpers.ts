import { observeLinuxBun142Executable } from './legal-bun-runtime';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import type { CollectedArtifactView } from './artifact-contract';
const REVISION = '1.4.2+744846f84';
const COMMIT = '744846f844374847c902b5e7fd59b4342a51ef99';
const EXECUTABLE = '35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5';
// Existing upstream materials are reused. These are source-policy digests,
// never a replacement copyright holder or another license-content catalog.
const MATERIALS = Object.freeze({
  'src/runtime.js': '02644972b775ee7bc4ed4b088808a3ea34ac6922ec52f897b7ea76b9f0ed92c4',
  'src/bundler/ParseTask.rs': '37b70e3bc5f3a5f10d5ccb6e3efb13dab7010225605fb505908b634f5f47c00d',
  'LICENSE.md': 'b9caf52728691b4057e371232c221a132883198be2f3d2ddf92c90404c984b1a',
});
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fail(message: string): never { throw Error('Bun helper originals: ' + message); }
interface VerifierBun {
  readonly version: string; readonly revision: string;
  readonly Transpiler: new (options: { loader: 'js'; target: 'node' }) => { transformSync(text: string): string };
  build(options: { entrypoints: string[]; target: 'node'; format: 'esm'; write: false }): Promise<{ success: boolean; outputs: readonly { size: number; arrayBuffer(): Promise<ArrayBuffer> }[] }>;
}
function verifierBun(): VerifierBun | undefined { return (globalThis as unknown as { Bun?: VerifierBun }).Bun; }
interface GeneratedBunMaterial { bunVersion?: string; files?: readonly { sourcePath: string; sha256: string; object: string }[] }
interface StatementBinding { sourceOffsetUnit: 'utf16-code-units'; name: string; sourcePath: string; sourceStart: number; sourceEnd: number; original: string; emitted: string }
interface BunHelperOriginalView {
  readonly commit: string; readonly revision: string; readonly executableSha256: string;
  readonly runtimeArchive?: Readonly<{ sha256: string; archivePath: string; archiveSha256: string }>;
  readonly bindings: readonly StatementBinding[];
  readOriginal(name: string): Buffer;
  readProbe(): Readonly<{ entry: string; commonjs: string; output: Buffer }>;
}
const issued = new WeakMap<object, BunHelperOriginalView>();
export function bunHelperOriginalView(value: unknown): BunHelperOriginalView | undefined {
  return value && typeof value === 'object' ? issued.get(value) : undefined;
}
function parse(text: string): ts.SourceFile {
  const file = ts.createSourceFile('runtime.js', text, ts.ScriptTarget.ES2021, true, ts.ScriptKind.JS);
  if ((file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) fail('unrecognized helper syntax');
  return file;
}
function statementName(statement: ts.Statement): string | undefined {
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const name = statement.declarationList.declarations[0]!.name;
    return ts.isIdentifier(name) ? name.text : undefined;
  }
  if (ts.isFunctionDeclaration(statement)) return statement.name?.text;
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'node:module') return 'node:module:createRequire';
  return undefined;
}
/** Pure structural mapping. Only the fixed observer's official original text
 * may become an operational binding; candidate prefix text is never compiled. */
export function mapBunHelperPrefix(prefix: Buffer, bindings: readonly StatementBinding[]): { mapped: { name: string; sourcePath: string; sourceStart: number; sourceEnd: number; sourceOffsetUnit: 'utf16-code-units'; emittedSha256: string }[]; pending: string[] } {
  if (prefix.length > 65536) fail('bounded helper prefix required');
  const text = prefix.toString('utf8'), file = parse(text), mapped: { name: string; sourcePath: string; sourceStart: number; sourceEnd: number; sourceOffsetUnit: 'utf16-code-units'; emittedSha256: string }[] = [], pending: string[] = [];
  const seen = new Set<string>(); let end = 0;
  for (const statement of file.statements) {
    const start = statement.getStart(file), name = statementName(statement), emitted = statement.getText(file).trim();
    if (!/^\s*$/u.test(text.slice(end, start))) pending.push('Unmapped helper prefix trivia');
    end = statement.end;
    const binding = bindings.find(row => row.name === name && (row.original === emitted || row.emitted === emitted));
    if (!name || seen.has(name) || !binding) { pending.push('Unmapped actual Bun helper statement: ' + (name ?? ts.SyntaxKind[statement.kind])); continue; }
    seen.add(name); mapped.push({ name, sourcePath: binding.sourcePath, sourceStart: binding.sourceStart, sourceEnd: binding.sourceEnd, sourceOffsetUnit: binding.sourceOffsetUnit, emittedSha256: hash(emitted) });
  }
  if (!/^\s*$/u.test(text.slice(end))) pending.push('Unmapped helper prefix tail');
  return { mapped, pending: [...new Set(pending)] };
}
/** Pure source/printer format derivation. It issues no original authority.
 * Only observeBun142HelperOriginals binds these spans to fixed official bytes. */
export function deriveBunHelperStatementBindings(runtimeSource: Buffer, parseTaskSource: Buffer): readonly StatementBinding[] {
  if (runtimeSource.length > 65536 || parseTaskSource.length > 256 * 1024) fail('source statement budget exceeded');
  const bun = verifierBun(); if (!bun || bun.version !== '1.4.2' || bun.revision !== COMMIT) fail('reviewed Bun printer required');
  const transpiler = new bun.Transpiler({ loader: 'js', target: 'node' }), bindings: StatementBinding[] = [];
  const add = (text: string, name: string, base = 0, originalEnd?: number) => {
    const file = parse(text);
    for (const statement of file.statements) {
      const identifier = statementName(statement); if (!identifier) continue;
      const original = statement.getText(file).replace(/^export /u, '').trim();
      bindings.push(Object.freeze({ sourceOffsetUnit: 'utf16-code-units' as const, name: identifier, sourcePath: name, sourceStart: originalEnd === undefined ? base + statement.getStart(file) : base, sourceEnd: originalEnd ?? base + statement.end,
        original, emitted: transpiler.transformSync(original).trim() }));
    }
  };
  add(runtimeSource.toString(), 'src/runtime.js');
  const rust = parseTaskSource.toString();
  const tail = /const RUNTIME_REQUIRE_NODE: &str = "\\\n([\s\S]*?)\n";/u.exec(rust);
  if (!tail || /\\(?!")/u.test(tail[1]!)) fail('unreviewed Node runtime assembly');
  // Rust's sole quote escape is decoded; no interpolation or code evaluation.
  add(tail[1]!.replace(/\\"/gu, '"'), 'src/bundler/ParseTask.rs', tail.index, tail.index + tail[0].length);
  return Object.freeze(bindings);
}
let observed: Promise<object> | undefined;
/** Fixed upstream GET-only observer plus verifier-owned tiny compiler probe.
 * No source/transport/compiler callback or candidate executable is accepted. */
export function observeBun142HelperOriginals(): Promise<object> {
  observed ??= observe();
  return observed;
}
async function observe(): Promise<object> {
  const bun = verifierBun();
  if (!bun || bun.version !== '1.4.2' || bun.revision !== COMMIT) fail('reviewed verifier Bun runtime required');
  const runtimeArchive = process.platform === 'linux' ? await observeLinuxBun142Executable() : undefined;
  if (!runtimeArchive && (process.platform !== 'darwin' || process.arch !== 'arm64')) fail('reviewed verifier Bun platform required');
  const executable = createHash('sha256');
  for await (const chunk of createReadStream(process.execPath, { highWaterMark: 65536 })) executable.update(chunk);
  const executableSha256 = executable.digest('hex');
  if (executableSha256 !== (runtimeArchive?.sha256 ?? EXECUTABLE)) fail('verifier compiler executable differs');
  const signal = AbortSignal.timeout(30000), originals = new Map<string, Buffer>(); let total = 0;
  for (const [name, digest] of Object.entries(MATERIALS)) {
    const url = 'https://raw.githubusercontent.com/oven-sh/bun/' + COMMIT + '/' + name;
    const response = await fetch(url, { redirect: 'error', signal });
    if (!response.ok || !response.body) fail('official source HTTP status ' + response.status);
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; total += next.value.length;
      if (size > 256 * 1024 || total > 512 * 1024) fail('official source byte budget exceeded'); chunks.push(Buffer.from(next.value)); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks, size); if (hash(bytes) !== digest) fail('fixed official source bytes differ: ' + name); originals.set(name, bytes);
  }
  const bindings = deriveBunHelperStatementBindings(originals.get('src/runtime.js')!, originals.get('src/bundler/ParseTask.rs')!);
  const probeRoot = fileURLToPath(new URL('../../../.test-data/legal-bun-probes/', import.meta.url));
  await mkdir(probeRoot, { recursive: true }); const directory = await mkdtemp(path.join(probeRoot, 'fixed-'));
  const entry = 'import value from "./value.cjs"; export const result = value.answer;\n', commonjs = 'module.exports = { answer: 42 };\n';
  let output: Buffer;
  try {
    await writeFile(path.join(directory, 'entry.ts'), entry); await writeFile(path.join(directory, 'value.cjs'), commonjs);
    const built = await bun.build({ entrypoints: [path.join(directory, 'entry.ts')], target: 'node', format: 'esm', write: false });
    if (!built.success || built.outputs.length !== 1 || built.outputs[0].size > 65536) fail('fixed compiler probe failed');
    output = Buffer.from(await built.outputs[0].arrayBuffer());
    const marker = output.indexOf('\n// '); if (marker < 0) fail('fixed probe source delimiter absent');
    if (mapBunHelperPrefix(output.subarray(0, marker), bindings).pending.length) fail('fixed compiler probe helper mapping differs');
  } finally { await rm(directory, { recursive: true, force: true }); }
  const capability = Object.freeze({});
  issued.set(capability, Object.freeze({ commit: COMMIT, revision: REVISION, executableSha256, ...(runtimeArchive ? { runtimeArchive } : {}), bindings: Object.freeze(bindings),
    readOriginal(name: string) { const bytes = originals.get(name); if (!bytes) return fail('original absent'); return Buffer.from(bytes); },
    readProbe() { return { entry, commonjs, output: Buffer.from(output!) }; } }));
  return capability;
}

export function inspectBunHelperPrefix(artifact: CollectedArtifactView, indexPath: string, generated: GeneratedBunMaterial, prefix: Buffer, originals: readonly unknown[]): { mappedStatements: number; pending: string[] } {
  if (!prefix.length) return { mappedStatements: 0, pending: [] };
  const original = originals.map(bunHelperOriginalView).find(Boolean);
  if (!original) return { mappedStatements: 0, pending: ['Fixed official Bun source and verifier probe capability required: ' + indexPath] };
  const mapped = mapBunHelperPrefix(prefix, original.bindings), pending = mapped.pending;
  if (generated.bunVersion !== '1.4.2') pending.push('Actual generated Bun version is not the reviewed 1.4.2 profile');
  for (const name of Object.keys(MATERIALS)) {
    const expected = hash(original.readOriginal(name));
    const row = generated.files?.find((file) => file.sourcePath === name && file.sha256 === expected);
    if (!row) { pending.push('Applicable original Bun source/notice is not indexed: ' + name); continue; }
    const member = artifact.members.find(member => member.path === path.posix.normalize(path.posix.join(path.posix.dirname(indexPath), row.object)));
    if (!member || member.sha256 !== expected) fail('retained official Bun source/notice differs: ' + name);
  }
  // Official fixed root LICENSE contains an MIT declaration and original port
  // credits, not the complete MIT grant+holder required by this admission gate.
  // A conservative esbuild notice must never be used to invent that missing
  // Bun grant or claim a proven exact historical runtime-port baseline.
  pending.push('Fixed Bun root license lacks complete normative MIT grant and original holder; explicit declaration requires policy decision');
  return { mappedStatements: mapped.mapped.length, pending: [...new Set(pending)] };
}
