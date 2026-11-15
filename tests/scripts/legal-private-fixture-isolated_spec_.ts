/** Genuine existing native/source private issuers with a test-local runtime
 * artifact map. This exercises the collector bridge honestly; it is not a
 * delivered API runtime member observation and claims no qualification. */
import { test, expect } from 'bun:test';
import { mockModule } from './bun-module-mock';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const origin = {}, facts: any = { runId: 1, runAttempt: 1, artifactId: 1, workflowPath: '.github/workflows/candidate.yml', target: 'linux-x64', producerJobId: 1, sourceSha: '' };
let runtimeEntries: any[] = [];
const runtimeBytes = new Map<string, Buffer>();
mockModule('../../scripts/lib/independent-admission/github-origin', () => {
  const text = fs.readFileSync(path.resolve('scripts/lib/independent-admission/github-origin.ts'), 'utf8');
  const names = [...text.matchAll(/export (?:async )?(?:function|const|let|var|class) ([A-Za-z0-9_]+)/gu)].map(row => row[1]!);
  // Preserve every named binding of the mocked module so unrelated transitive
  // imports keep their module shape; only candidate-service predicates answer.
  const upstream = Object.fromEntries(names.map(name => [name, text.includes('export function ' + name) || text.includes('export async function ' + name)
    ? () => false : text.includes('export class ' + name) ? class {} : []]));
  return { ...upstream, githubOriginFacts: (value: unknown) => value === origin ? facts : undefined, githubOriginOriginals: () => [{ name: 'run.original.json', endpoint: 'fixture', data: Buffer.from(JSON.stringify({ id: 1 })) }],
    isNativeGitHubOrigin: (value: unknown) => value === origin, isCandidateServiceImageGitHubOrigin: (value: unknown) => value === origin, isQleverSdkGitHubOrigin: () => false };
});
mockModule('../../scripts/lib/independent-admission/candidate-service-runtime-artifact', () => ({ candidateServiceRuntimeArtifactView: (value: unknown) => value === runtimeToken ? {
  identity: { sourceSha: facts.sourceSha, runId: 1, runAttempt: 1, imageDigest: 'sha256:' + '1'.repeat(64), imageConfigDigest: 'sha256:' + '2'.repeat(64), containerId: '3'.repeat(64) },
  members: runtimeEntries,
  readMemberRange: (name: string, offset: number, length: number) => runtimeBytes.get(name)!.subarray(offset, offset + length),
  assertCurrent() { if (runtimeRevoked.value) throw Error('runtime revoked'); },
} : undefined }));
const runtimeToken = {}, runtimeRevoked = { value: false } as { value: boolean };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('genuine native/source handles bridge an absolute runtime union and reject forged contexts', async () => {
  const parent = path.resolve('.test-data/candidate-service-legal-private'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'actual-')), checkout = path.join(root, 'source'), acquisition = path.join(root, 'acquisition');
  fs.mkdirSync(checkout); fs.mkdirSync(acquisition);
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = root;
  let capability: unknown;
  try {
    const tracked = ['scripts/lib/independent-admission/candidate-service-legal.ts', 'LICENSE'];
    for (const name of tracked) { const dest = path.join(checkout, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.resolve(name), dest); }
    const manifest = Buffer.from(JSON.stringify({ name: '@undefineds.co/xpod', version: '1.2.3', license: 'MIT' }));
    fs.writeFileSync(path.join(checkout, 'package.json'), manifest);
    const git = (args: string[]) => execFileSync('git', args, { cwd: checkout, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git(['init', '--quiet']); git(['add', '--', ...tracked, 'package.json']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'isolated service legal fixture']);
    const sourceSha = git(['rev-parse', 'HEAD']); facts.sourceSha = facts.runHeadSha = sourceSha;
    runtimeBytes.set('/app/package.json', manifest); runtimeBytes.set('/app/LICENSE', fs.readFileSync(path.resolve('LICENSE')));
    runtimeEntries = [
      { path: '/app', type: 'directory', mode: 0o755, bytes: 0 },
      { path: '/app/package.json', type: 'file', mode: 0o644, bytes: manifest.length, sha256: sha(manifest) },
      { path: '/app/LICENSE', type: 'file', mode: 0o644, bytes: runtimeBytes.get('/app/LICENSE')!.length, sha256: sha(runtimeBytes.get('/app/LICENSE')!) },
      { path: '/app/self', type: 'symlink', mode: 0o777, bytes: 0, target: '/app' },
    ];
    // Honest acquisition: actual ZIP inventory plus the same metadata verifier.
    const files = path.join(root, 'members'); fs.mkdirSync(files);
    const master = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'xpod-candidate-service-image-originals', releaseAccepted: false, sourceSha, runHeadSha: sourceSha, runId: 1, runAttempt: 1, target: 'linux-x64', sdkProfile: 'service-trixie', originals: [] }));
    fs.writeFileSync(path.join(files, 'service-image-materials.json'), master);
    const archive = path.join(acquisition, 'artifact.zip');
    execFileSync('/usr/bin/python3', ['-c', "import zipfile,sys,pathlib\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for p in sorted(r.rglob('*')):\n  if p.is_file():z.write(p,p.relative_to(r).as_posix())", files, archive]);
    facts.artifactSha256 = sha(fs.readFileSync(archive));
    const inventory = JSON.parse(execFileSync('/usr/bin/python3', [path.resolve('scripts/lib/inspect-product-artifact.py'), archive, facts.artifactSha256, String(4 * 1024 ** 3), String(4 * 1024 ** 3), '100000']).toString());
    const metadataValues: any = { run: { id: 1, run_attempt: 1, head_sha: sourceSha, head_branch: 'staging', event: 'push', run_number: 1 }, workflow: { path: facts.workflowPath }, artifact: { id: 1 } };
    fs.mkdirSync(path.join(acquisition, 'metadata')); const binding: any = { originals: {} };
    for (const name of ['run', 'workflow', 'artifact']) { const data = Buffer.from(JSON.stringify(metadataValues[name])), file = 'metadata/' + name + '.original.json'; fs.writeFileSync(path.join(acquisition, file), data); binding.originals[name] = { path: file, bytes: data.length, sha256: sha(data), endpoint: 'fixture' }; }
    const projection = Buffer.from(JSON.stringify(metadataValues)); fs.writeFileSync(path.join(acquisition, 'metadata.json'), projection);
    binding.projection = { path: 'metadata.json', bytes: projection.length, sha256: sha(projection) };
    fs.writeFileSync(path.join(acquisition, 'receipt.json'), JSON.stringify({ expectedSourceSha: sourceSha, runHeadSha: sourceSha, runId: 1, runAttempt: 1, artifactId: 1, workflowPath: facts.workflowPath, archive: { path: 'artifact.zip', sha256: facts.artifactSha256, bytes: fs.statSync(archive).size }, metadata: binding, inventory }));
    const { collectNativeAdmissionOriginals, nativeOriginalsView, compactCollectedNativeOriginals } = await import('../../scripts/lib/independent-admission/native-original-collector');
    const { deriveCandidateServiceSource, derivedSourceView } = await import('../../scripts/lib/independent-admission/source-context');
    const { collectCandidateServiceRuntimeArtifact, collectedCandidateServiceRuntime } = await import('../../scripts/lib/independent-admission/artifact-collector');
    capability = await collectNativeAdmissionOriginals({ githubOrigin: origin as any, acquisitionRoot: acquisition });
    const sourceCap = deriveCandidateServiceSource(capability, checkout);
    expect(nativeOriginalsView(capability)).toBeDefined(); expect(derivedSourceView(sourceCap)).toBeDefined();
    const bridged = collectCandidateServiceRuntimeArtifact({ runtime: runtimeToken, originals: capability, source: sourceCap });
    expect(bridged).toBeDefined();
    const runtimeBinding = collectedCandidateServiceRuntime(bridged)!;
    expect(runtimeBinding.entries.map(row => row.path)).toEqual(['/app', '/app/package.json', '/app/LICENSE', '/app/self']);
    expect(runtimeBinding.entries.find(row => row.type === 'symlink')).toMatchObject({ target: '/app' });
    expect(runtimeBinding.files.map(row => row.path)).toEqual(['app/package.json', 'app/LICENSE']);
    const { collectedArtifactView } = await import('../../scripts/lib/independent-admission/artifact-collector');
    expect(collectedArtifactView(bridged)!.members.map(row => row.path)).toEqual(['app/package.json', 'app/LICENSE']);
    runtimeEntries.push({ path: '/app/dangling', type: 'symlink', mode: 0o777, bytes: 0, target: '/app/missing' });
    expect(() => collectCandidateServiceRuntimeArtifact({ runtime: runtimeToken, originals: capability, source: sourceCap })).toThrow('outside declared membership');
    runtimeEntries.pop();
    runtimeRevoked.value = true;
    expect(() => collectedCandidateServiceRuntime(bridged)).toThrow('revoked');
    runtimeRevoked.value = false;
    expect(collectCandidateServiceRuntimeArtifact({ runtime: {}, originals: capability, source: sourceCap })).toBeUndefined();
    expect(() => collectCandidateServiceRuntimeArtifact({ runtime: runtimeToken, originals: {}, source: sourceCap })).toThrow('issued');
    expect(() => collectCandidateServiceRuntimeArtifact({ runtime: runtimeToken, originals: capability, source: {} })).toThrow('issued');
    compactCollectedNativeOriginals(capability);
    expect(() => collectedCandidateServiceRuntime(bridged)).toThrow();
  } finally {
    if (capability) { const { compactCollectedNativeOriginals } = await import('../../scripts/lib/independent-admission/native-original-collector'); compactCollectedNativeOriginals(capability); }
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

