import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { verifyAdmission, type AdmissionContext } from '../../scripts/lib/independent-admission';
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function fixture() {
  const sourceSha = 'a'.repeat(40), archive = Buffer.from('tiny original archive');
  const files = new Map<string, Buffer>();
  const put = (path: string, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value)); files.set(path, data);
    return { path, sha256: hash(data) };
  };
  const context: AdmissionContext = { sourceSha, runHeadSha: sourceSha,
    package: '@undefineds.co/xpod-cli', version: '1.0.0', archive,
    readOriginal(ref) {
      const data = files.get(ref?.path);
      if (!data || hash(data) !== ref.sha256) throw new Error('original digest mismatch');
      return data;
    },
    readTracked(name) { if (name !== 'tracked.ts') throw new Error('untracked'); return Buffer.from('tracked source'); },
  };
  const producerContext = { checkoutSha: sourceSha, eventHeadSha: sourceSha, runId: '123', runAttempt: '1', environment: 'github-actions', workingTreeDirty: false };
  const sourceInputs = put('source-inputs.json', { schemaVersion: 1, context: producerContext,
    files: [{ path: 'tracked.ts', bytes: 14, sha256: hash(Buffer.from('tracked source')) }] });
  const producerIndex = put('producer-index.json', {}), preparation = put('preparation.json', {});
  put('cleanup.json', { descendantClosureVerified: false });
  files.set('cli.tgz', archive);
  const inventory = put('inventory.json', { schemaVersion: 1, files: [...files].map(([path, data]) => ({ path, sha256: hash(data), bytes: data.length, mode: 0o644 })) });
  const evidence = { schemaVersion: 1, kind: 'cli-publication-preparation-producer', context: producerContext,
    status: 'prepared-not-published', published: false, sourceInputs, producerIndex, preparation, inventory,
    products: { cli: { package: context.package, version: context.version, archive: { path: 'cli.tgz', sha256: hash(archive), bytes: archive.length,
      integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') } } } };
  return { evidence, context, files, put, verify: () => verifyAdmission('source', evidence, context) };
}
describe('source adapter material bindings (no synthetic fixture grants origin authority)', () => {
  it('processes actual producer schema and preserves explicit missing descendant evidence', () => {
    expect(fixture().verify().reason).toContain('producer-descendant-closure-unverified');
  });
  it('does not recognize a serialized origin observation as a capability', () => {
    const f = fixture(); f.context.githubOrigin = { sourceSha: f.context.sourceSha, runId: 123, runAttempt: 1, scope: 'github-api-run-workflow-artifact-observation-only' };
    expect(f.verify().facts?.githubRunArtifactObserved).toBe(false);
    expect(f.verify().facts?.originAdmissionVerified).toBe(false);
  });
  it('keeps unknown schemas and self approval pending', () => {
    const f = fixture();
    for (const evidence of [{ schemaVersion: 999, passed: true }, { sourceAuthority: { sourceCommit: f.context.sourceSha, dirty: false }, sourceAccepted: true }]) {
      expect(verifyAdmission('source', evidence, f.context).status).toBe('pending');
    }
  });
  it('rejects exact source, dirty checkout, package and archive substitutions', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.evidence.context.checkoutSha = 'b'.repeat(40); },
      (f: ReturnType<typeof fixture>) => { f.evidence.context.workingTreeDirty = true; },
      (f: ReturnType<typeof fixture>) => { f.evidence.context.eventHeadSha = 'c'.repeat(40); },
      (f: ReturnType<typeof fixture>) => { f.context.package = '@undefineds.co/xpod-api-linux-x64'; },
      (f: ReturnType<typeof fixture>) => { f.context.archive = Buffer.from('replacement'); },
      (f: ReturnType<typeof fixture>) => { f.evidence.products.cli.version = '2.0.0'; },
    ]) { const f = fixture(); mutate(f); expect(f.verify).toThrow(); }
  });
  it('rejects original tampering, missing originals and tracked source substitutions', () => {
    const tamper = fixture(); tamper.files.set('preparation.json', Buffer.from('tampered')); expect(tamper.verify).toThrow('digest');
    const missing = fixture(); missing.files.delete('source-inputs.json'); expect(missing.verify).toThrow('digest');
    const source = fixture(); source.context.readTracked = () => Buffer.from('changed source'); expect(source.verify).toThrow('exact Git');
  });
  it('does not promote replayed attempts or caller closure assertions to authority', () => {
    const f = fixture(); f.evidence.context.runAttempt = '2';
    // Rebind all caller materials consistently: still no independent observation.
    const inputs = JSON.parse(f.files.get('source-inputs.json')!.toString()); inputs.context.runAttempt = '2';
    f.evidence.sourceInputs = f.put('source-inputs.json', inputs);
    f.put('cleanup.json', { descendantClosureVerified: true, passed: true });
    f.evidence.inventory = f.put('inventory.json', { schemaVersion: 1, files: [...f.files].filter(([name]) => name !== 'inventory.json').map(([path, data]) => ({ path, sha256: hash(data), bytes: data.length })) });
    const result = f.verify(); expect(result.status).toBe('pending'); expect(result.reason).toContain('source-origin-unverified');
  });
  it('keeps prepublish gates pending independently of postpublish assertions', () => {
    const f = fixture();
    for (const gate of ['native', 'legal', 'consumer'] as const) expect(verifyAdmission(gate, { passed: true, legalAccepted: true }, f.context).status).toBe('pending');
  });
});

// The real publication producer copies a small tool set; admission must not be
// eagerly imported by its shared manifest helpers.
it('keeps copied publication preparation import independent of admission files', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const parent = path.resolve('.test-data/source-admission-import'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    for (const name of ['scripts/prepare-cli-publication.ts', 'scripts/independent-release-plan.ts', 'scripts/workspace-package-payload.cjs',
      'packages/xpod-cli/src/module-catalog.ts', 'packages/xpod-cli/scripts/canonical-host-sources.json']) {
      const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(name, target);
    }
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
    const result = spawnSync(process.execPath, ['-e', "import {preparePublication} from './scripts/prepare-cli-publication.ts'; if(typeof preparePublication!=='function') throw Error('missing')"], { cwd: root, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0); expect(result.error).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'scripts/lib/independent-admission'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

describe('reviewed normal CLI input-set policy', () => {
  const { verifyCliInputSet } = require('../../scripts/lib/independent-admission/source-rules') as typeof import('../../scripts/lib/independent-admission/source-rules');
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  // Include newly staged verifier inputs in this structural pre-commit fixture.
  // Operational source capabilities still require an exact clean Git commit.
  const tracked = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  const read = (name: string) => readFileSync(name);
  const prefixes = ['packages/xpod-cli/src', 'packages/xpod-cli/scripts', 'packages/xpod-cli/tests', 'packages/xpod-cli/licenses',
    'packages/xpod-client/src', 'packages/xpod-client/scripts', 'packages/xpod-client/tests', 'packages/xpod-client/licenses', 'types/bun'];
  const { TOOLS, PATCHES } = require('../../scripts/check-cli-publication.cjs') as { TOOLS: readonly string[]; PATCHES: readonly string[] };
  const exact = ['LICENSE', 'package.json', 'bunfig.toml', '.github/workflows/cli-package.yml', 'scripts/check-cli-publication.cjs',
    'scripts/cli-build-inputs.cjs', ...TOOLS, ...PATCHES.map(name => 'scripts/' + name),
    ...['tsconfig.json', 'tsconfig.core.json', 'tsconfig.client.json', 'tsconfig.build-tools.json', 'package.json', 'README.md', 'LICENSE', 'publication.bun.lock'].map(name => 'packages/xpod-cli/' + name),
    ...['tsconfig.json', 'package.json', 'README.md', 'LICENSE'].map(name => 'packages/xpod-client/' + name),
    ...JSON.parse(read('packages/xpod-cli/scripts/canonical-host-sources.json').toString()).map((name: string) => 'src/' + name)];
  const files = tracked.filter(name => exact.includes(name) || prefixes.some(prefix => name.startsWith(prefix + '/'))).map(path => ({ path }));
  const manifest = { name: 'xpod-cli-publication-build', private: true, workspaces: ['packages/xpod-cli', 'packages/xpod-client'],
    devDependencies: { ...JSON.parse(read('packages/xpod-cli/package.json').toString()).devDependencies,
      semver: JSON.parse(read('package.json').toString()).devDependencies.semver } };
  it('matches the complete reviewed tracked input set and generated manifest', () => {
    expect(files.map(row => row.path)).toContain('scripts/lib/module-source-materials.py');
    expect(files.map(row => row.path)).toContain('scripts/lib/module-artifact-limits.json');
    expect(verifyCliInputSet(files, manifest, read, tracked)).toEqual({ sourceInputSetVerified: true, generatedBuildManifestVerified: true, pending: null });
  });
  it('rejects omissions, additions and generated-manifest changes', () => {
    expect(() => verifyCliInputSet(files.slice(1), manifest, read, tracked)).toThrow('complete build input set');
    expect(() => verifyCliInputSet([...files, { path: 'injected.ts' }], manifest, read, tracked)).toThrow('complete build input set');
    expect(() => verifyCliInputSet(files, { ...manifest, scripts: { install: 'untrusted' } }, read, tracked)).toThrow('generated build manifest');
  });
  it('does not silently qualify the old producer under the new owned-command policy', () => {
    // Fixed pre-supervisor source; HEAD changes after committing this verifier.
    const old = read('tests/fixtures/independent-admission/legacy-cli-publication.cjs.txt');
    expect(verifyCliInputSet(files, manifest, name => name === 'scripts/check-cli-publication.cjs' ? old : read(name), tracked).sourceInputSetVerified).toBe(false);
  });
  it('does not trust an unreviewed command collector to assert closure', () => {
    expect(verifyCliInputSet(files, manifest, name => name === 'scripts/lib/afs-publication-command.cjs' ? Buffer.from('fake closure collector') : read(name), tracked).sourceInputSetVerified).toBe(false);
  });
  it('does not use an unreviewed producer as policy authority', () => {
    expect(verifyCliInputSet(files, manifest, name => name === 'scripts/check-cli-publication.cjs' ? Buffer.from('changed producer') : read(name), tracked).sourceInputSetVerified).toBe(false);
  });
});
