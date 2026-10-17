import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { verifyCliBuildExecution, portableSourceMaterialView, verifyCollectedCliBuildExecution, type CliExecutionInput, type BuildArchiveMember } from '../../scripts/lib/independent-admission/source-execution';
const require = createRequire(import.meta.url);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tracked = spawnSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
const { CLI_ENTRIES, CLIENT_ENTRIES } = require('../../scripts/cli-build-inputs.cjs');
const { TOOLS, PATCHES } = require('../../scripts/check-cli-publication.cjs');
const prefixes = [...CLI_ENTRIES.map((name: string) => 'packages/xpod-cli/' + name), ...CLIENT_ENTRIES.map((name: string) => 'packages/xpod-client/' + name), 'types/bun', 'LICENSE'];
const exact = [...TOOLS, ...PATCHES.map((name: string) => 'scripts/' + name), 'scripts/check-cli-publication.cjs', 'scripts/cli-build-inputs.cjs', '.github/workflows/cli-package.yml', 'bunfig.toml', 'package.json', 'packages/xpod-cli/publication.bun.lock',
  ...JSON.parse(readFileSync('packages/xpod-cli/scripts/canonical-host-sources.json', 'utf8')).map((name: string) => 'src/' + name)];
const names = tracked.filter(name => exact.includes(name) || prefixes.some(prefix => name === prefix || name.startsWith(prefix + '/')));
const sourceBytes = new Map(names.map(name => [name, readFileSync(name)]));
const readTracked = (name: string) => { const bytes = sourceBytes.get(name); if (!bytes) throw Error('untracked fixture input'); return bytes; };

// Real policy and tracked first-party input bytes; synthetic command/output
// originals never grant origin authority or qualify a product for publication.
function fixture(mutate?: (state: any) => void) {
  const files = new Map<string, Buffer>();
  const put = (name: string, value: any) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); files.set(name, bytes); return { path: name, sha256: hash(bytes) }; };
  const manifest = { name: 'xpod-cli-publication-build', private: true, workspaces: ['packages/xpod-cli', 'packages/xpod-client'],
    devDependencies: { ...JSON.parse(readTracked('packages/xpod-cli/package.json').toString()).devDependencies, semver: JSON.parse(readTracked('package.json').toString()).devDependencies.semver } };
  const context = { checkoutSha: 'a'.repeat(40) };
  const source = { schemaVersion: 1, context, generatedBuildManifest: manifest, files: names.map(path => ({ path, bytes: readTracked(path).length, sha256: hash(readTracked(path)) })) };
  const inputRows = source.files.map(row => { const bytes = row.path === 'package.json' ? Buffer.from(JSON.stringify(manifest, null, 2)) : readTracked(row.path); return { path: row.path,
    buildPath: row.path === 'packages/xpod-cli/publication.bun.lock' ? 'bun.lock' : row.path, bytes: bytes.length, sha256: hash(bytes) }; }).sort((a, b) => a.path.localeCompare(b.path));
  const buildRoot = '/tmp/.test-data/xpod-cli-publication-builds/case-fixture', evidenceRoot = '/checkout/.test-data/cli-publication-preparation';
  const recipe = [
    { args: ['install', '--ignore-scripts', '--frozen-lockfile'], cwd: buildRoot }, ...PATCHES.map((name: string) => ({ args: ['scripts/' + name], cwd: buildRoot })),
    { args: ['run', 'build:tools'], cwd: buildRoot + '/packages/xpod-cli' }, { args: ['run', 'build'], cwd: buildRoot + '/packages/xpod-client' },
    { args: ['run', 'build'], cwd: buildRoot + '/packages/xpod-cli' },
    { args: ['pm', 'pack', '--ignore-scripts', '--filename', evidenceRoot + '/cli.tgz'], cwd: buildRoot + '/packages/xpod-cli' },
    { args: ['scripts/prepare-cli-publication.ts', evidenceRoot + '/input.json'], cwd: buildRoot },
  ];
  const preparation = { schemaVersion: 1, kind: 'cli-publication-preparation' };
  const receipts = recipe.map((row, index) => ({ command: 'bun', ...row, code: 0, signal: null, spawnError: null, failure: null,
    actualWait: true, actualClose: true, groupAbsent: true, pipeEOF: [true, true], rawClosed: true, rawClosedBeforeHash: true,
    rawBudgetPerStream: 262144, rawComplete: true, descendantClosureVerified: false,
    raw: [0, 1].map(stream => { const ref = put('phase-' + String(index).padStart(3, '0') + (stream ? '.stderr.raw.log' : '.stdout.raw.log'), index === 9 && !stream ? Buffer.from(JSON.stringify(preparation)) : Buffer.alloc(0)); return { ...ref, bytes: files.get(ref.path)!.length }; }) }));
  const archives = { cli: new Map<string, Buffer>(), client: new Map<string, Buffer>() };
  const addOutput = (product: 'cli' | 'client', name: string, bytes: Buffer) => archives[product].set('package/dist/' + name, bytes);
  const specs = [['build-tools-cjs-inputs.json', 'build-tools.cjs', 'src/build-tools.ts'], ['build-tools-esm-inputs.json', 'build-tools.mjs', 'src/build-tools.ts'],
    ['client-inputs.json', 'client.cjs', 'src/client.ts'], ['npm-entry-inputs.json', 'xpod.mjs', 'src/npm-entry.ts'], ['output-inputs.json', 'output.mjs', 'src/lib/output.ts']];
  for (const [, output] of specs) addOutput('cli', output, Buffer.from('tiny compiled ' + output));
  addOutput('client', 'library.cjs', Buffer.from('tiny compiled client'));
  const metadata = (product: 'cli' | 'client', output: string, entry: string) => ({ inputs: { [entry]: { bytes: readTracked('packages/xpod-' + product + '/' + entry).length } },
    outputs: { ['./' + output]: { bytes: archives[product].get('package/dist/' + output)!.length, entryPoint: entry, inputs: { [entry]: { bytesInOutput: 1 } } } } });
  addOutput('client', 'inputs.json', Buffer.from(JSON.stringify(metadata('client', 'library.cjs', 'src/index.ts'))));
  const outputRows = (product: 'cli' | 'client') => [...archives[product]].map(([path, bytes]) => ({ path: path.slice('package/dist/'.length), bytes: bytes.length, mode: 0o644, sha256: hash(bytes) }));
  const roles = ['cli-build-tools', 'client-build', 'cli-build'];
  const snapshots = roles.map((role, index) => ({ schemaVersion: 1, kind: 'cli-publication-build-phase', role,
    inputsBefore: inputRows, inputsAfter: inputRows, generatedBuildManifest: { bytes: Buffer.byteLength(JSON.stringify(manifest, null, 2)), sha256: hash(Buffer.from(JSON.stringify(manifest, null, 2))) },
    outputs: role === 'client-build' ? outputRows('client') : role === 'cli-build-tools' ? outputRows('cli').filter(row => row.path.startsWith('build-tools.')) : outputRows('cli'),
    metafiles: (role === 'client-build' ? [] : role === 'cli-build-tools' ? specs.slice(0, 2) : specs).map(([name, output, entry]) => {
      const original = put('phase-00' + (index + 5) + '.metafiles/' + name, metadata('cli', output, entry)); const bytes = files.get(original.path)!;
      return { path: name, bytes: bytes.length, sha256: hash(bytes), mode: 0o644, original };
    }), command: null as any }));
  const state = { receipts, snapshots, source, archives, files, put };
  mutate?.(state);
  const commands = receipts.map((row, index) => ({ phase: 'bun ' + row.args.join(' '), receipt: put('phase-' + String(index).padStart(3, '0') + '.receipt.json', row), ...row }));
  put('cleanup.json', { schemaVersion: 1, kind: 'cli-publication-owned-command-cleanup', source: buildRoot, sourceAbsent: true, success: true,
    rawLimitPerStream: 262144, timeoutMs: 180000, commandOutcomes: commands });
  const buildPhases = snapshots.map((snapshot, index) => { snapshot.command = commands[index + 5].receipt; return { role: snapshot.role, ...put('phase-00' + (index + 5) + '.build.json', snapshot) }; });
  const producer = { schemaVersion: 1, kind: 'cli-publication-preparation-producer', context, sourceInputs: put('source-inputs.json', source), preparation: put('preparation.json', preparation), buildPhases, inventory: {} };
  producer.inventory = put('inventory.json', { schemaVersion: 1, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) });
  const input: CliExecutionInput = { producer, readTracked, trackedPaths: tracked,
    readProducerOriginal(name, max) { const bytes = files.get(name); if (!bytes || bytes.length > max) throw Error('fixture original missing/oversize'); return bytes; },
    archiveMembers(product) { return [...archives[product]].map(([path, bytes]): BuildArchiveMember => ({ path, type: 'file', size: bytes.length, sha256: hash(bytes), mode: 0o644 })); },
    readArchiveMember(product, name, max) { const bytes = archives[product].get(name); if (!bytes || bytes.length > max) throw Error('fixture member missing/oversize'); return bytes; } };
  return { ...state, input, verify: () => verifyCliBuildExecution(input) };
}
describe('controlled CLI execution original verifier (synthetic origin-free fixtures)', () => {
  it('binds all ten commands, owned closure, three build snapshots and exact archive outputs', () => {
    const result = fixture().verify(); expect(result.actualOwnedCommandClosureVerified).toBe(true); expect(result.controlledBuildDerivationVerified).toBe(true); expect(result.pending).toEqual([]);
  });
  it('never issues private graph custody from structural callbacks or serialized facts', () => {
    const f = fixture(), facts = f.verify();
    expect(portableSourceMaterialView(facts)).toBeUndefined();
    expect(portableSourceMaterialView(JSON.parse(JSON.stringify(facts)))).toBeUndefined();
    expect(() => verifyCollectedCliBuildExecution({ artifact: {} as any, source: {} })).toThrow('private collected');
  });
  it('leaves historical missing originals pending', () => {
    const f = fixture(); delete (f.input.producer as any).buildPhases;
    expect(f.verify().actualOwnedCommandClosureVerified).toBe(false);
  });
  for (const change of [{ actualWait: false }, { actualClose: false }, { groupAbsent: false }, { rawClosedBeforeHash: false }, { code: 1 }, { signal: 'SIGTERM' }, { spawnError: 'ENOENT' }]) {
    it('rejects failed or unknown command observation ' + JSON.stringify(change), () => expect(fixture(state => Object.assign(state.receipts[5], change)).verify).toThrow('closure/success'));
  }
  it('rejects command sequence, cwd and raw original substitutions', () => {
    expect(fixture(state => { state.receipts[5].args = ['run', 'unapproved']; }).verify).toThrow('command');
    expect(fixture(state => { state.receipts[5].cwd = '/unowned'; }).verify).toThrow('unapproved command');
    const f = fixture(); f.files.set('phase-005.stdout.raw.log', Buffer.from('tampered')); expect(f.verify).toThrow('digest');
  });
  it('rejects changed build inputs and omitted final archive members', () => {
    expect(fixture(state => { state.snapshots[2].inputsAfter = []; }).verify).toThrow('snapshot');
    expect(fixture(state => { state.archives.cli.delete('package/dist/xpod.mjs'); }).verify).toThrow('final archive');
  });
  it('rejects a hash-rebound metafile that disagrees with the compiled output', () => {
    expect(fixture(state => {
      const row = state.snapshots[2].metafiles.find((row: any) => row.path === 'npm-entry-inputs.json');
      const metadata = JSON.parse(state.files.get(row.original.path).toString()); metadata.outputs['./xpod.mjs'].bytes++;
      const ref = state.put(row.original.path, metadata); row.original = ref; row.sha256 = ref.sha256; row.bytes = state.files.get(ref.path).length;
    }).verify).toThrow('metafile compiled output binding');
  });
  it('rejects missing preserved metafiles', () => {
    expect(fixture(state => { state.snapshots[2].metafiles.pop(); }).verify).toThrow('metafile exact set');
  });
  for (const [name, change, reason] of [
    ['missing contributor', (meta: any) => { meta.outputs['./xpod.mjs'].inputs['absent.ts'] = { bytesInOutput: 1 }; }, 'contributing input'],
    ['empty output graph', (meta: any) => { meta.outputs = {}; }, 'graph absent'],
    ['spoofed entry point', (meta: any) => { meta.outputs['./xpod.mjs'].entryPoint = 'src/unapproved.ts'; }, 'compiled output binding'],
  ] as const) {
    it('rejects a hash-rebound metafile with ' + name, () => {
      expect(fixture(state => {
        const row = state.snapshots[2].metafiles.find((row: any) => row.path === 'npm-entry-inputs.json');
        const meta = JSON.parse(state.files.get(row.original.path).toString()); change(meta);
        const ref = state.put(row.original.path, meta); row.original = ref; row.sha256 = ref.sha256; row.bytes = state.files.get(ref.path).length;
      }).verify).toThrow(reason);
    });
  }

});
