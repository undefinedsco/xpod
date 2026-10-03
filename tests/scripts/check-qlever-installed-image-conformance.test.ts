import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { acquirePrivate17Admission, private17ProofTag, installRegistryConfig, validateImageInspection, validateInstalledReport, validatePullJob, verifyPrivate17Admission } from '../../scripts/check-qlever-installed-image-conformance';
import { buildSemanticReport, type SemanticFixtureModule } from '../../src/acceptance/RdfSemanticConformance';

const root = path.resolve(__dirname, '../..');
const fixturePath = path.join(root, 'qlever/tests/fixtures/qlever-semantic-conformance.cjs');
const fixture = createRequire(path.join(root, 'package.json'))(fixturePath) as SemanticFixtureModule;
const script = readFileSync(path.join(root, 'scripts/check-qlever-installed-image-conformance.ts'), 'utf8');

function validReport(backend: 'sqlite' | 'pg' = 'sqlite') {
  const engine = backend === 'sqlite' ? 'local-qlever-prepared-update-authority' : 'pg-qlever-prepared-update-authority';
  const semantic = buildSemanticReport({
    backend, engine, caseIds: fixture.REQUIRED_CASES, failed: [], sourceDeniedValidatedBy: 'physical provider',
    results: fixture.semanticConformanceCases.map(testCase => ({
      caseId: testCase.id, status: 'ok' as const, canonical: structuredClone(testCase.expectedCanonical),
      preparedUpdates: testCase.updates.length, appliedDelta: { deletedRows: 0, insertedRows: 0 },
      authority: backend === 'sqlite' ? 'sqlite:/isolated.sqlite' : 'postgres-schema:isolated',
    })),
  });
  const content = 'alpha late vector canonical card';
  const old = [{ retrieval: content, source: 'https://pod.example/alice/projects/native/old-card.md' }];
  const moved = [{ retrieval: content, source: 'https://pod.example/alice/projects/native/moved-card.md' }];
  return { schemaVersion: 1 as const, backend, status: 'ok' as const, semantic, search: {
    textOnlyBeforeVector: [{ retrieval: content }], fusedBeforeVector: [],
    fusedAfterVector: old, fusedAfterVectorExact: old,
    fusedDuringMove: moved, fusedDuringMoveExact: moved, fusedAfterMove: moved,
    oldSourceAfterMove: [], deniedSource: [],
  } };
}

describe('installed native image report admission', () => {
  it('pins the independent current public16 fixture', () => {
    expect(createHash('sha256').update(readFileSync(fixturePath)).digest('hex'))
      .toBe('c15f1bba83aff573b9e3bab685bf66bacb35cd82bac7a13e93e8163559ed5778');
    expect(fixture.REQUIRED_CASES).toHaveLength(16);
    expect(() => validateInstalledReport(validReport(), 'sqlite', fixture)).not.toThrow();
    expect(() => validateInstalledReport(validReport('pg'), 'pg', fixture)).not.toThrow();
  });

  it('rejects canonical forgery even with a recomputed valid digest', () => {
    const report = validReport();
    report.semantic.results[0].canonical = { forged: true };
    report.semantic.canonicalDigest = buildSemanticReport({
      backend: report.semantic.backend, engine: report.semantic.engine, caseIds: report.semantic.caseIds,
      failed: [], results: report.semantic.results, sourceDeniedValidatedBy: report.semantic.sourceScope.sourceDeniedValidatedBy,
    }).canonicalDigest;
    expect(() => validateInstalledReport(report, 'sqlite', fixture)).toThrow(/canonical/);
  });

  it('rejects format-valid forged digest, missing case and equally incomplete search', () => {
    const digest = validReport();
    digest.semantic.canonicalDigest = `sha256:${'a'.repeat(64)}`;
    expect(() => validateInstalledReport(digest, 'sqlite', fixture)).toThrow(/digest/);
    const missing = validReport();
    missing.semantic.results.pop();
    expect(() => validateInstalledReport(missing, 'sqlite', fixture)).toThrow(/incomplete/);
    const search = validReport();
    search.search.fusedAfterVector = [];
    expect(() => validateInstalledReport(search, 'sqlite', fixture)).toThrow(/search/);
  });

  it('binds exact RepoDigest and OCI source/revision instead of image presence', () => {
    const ref = `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`;
    const source = { sha: 'b'.repeat(40), url: 'https://github.com/undefinedsco/xpod' };
    const image = { RepoDigests: [ref], Config: { Labels: {
      'org.opencontainers.image.revision': source.sha, 'org.opencontainers.image.source': source.url,
    } } };
    expect(() => validateImageInspection(JSON.stringify([image]), ref, source)).not.toThrow();
    image.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40);
    expect(() => validateImageInspection(JSON.stringify([image]), ref, source)).toThrow(/source/);
    expect(() => validateImageInspection(JSON.stringify([{ RepoDigests: [] }]), ref)).toThrow(/digest/);
  });

  it('uses explicit Bun and records ownership immediately after successful create', () => {
    expect(script).toContain("args.installedImage, 'bun', RUNNER_PATH");
    expect(script).not.toContain("'node', 'dist/acceptance");
    expect(script).toContain('ownedResources.push({ kind, name, id })');
    expect(script).toContain("['start', '--attach', id]");
    expect(script).toContain("['rm', '-f', resource.id]");
    expect(script).toContain('native.abiVersion !== 1');
    expect(script).toContain('admissionScope: \'public16-only\'');
  });
});


describe('authorized namespace pull admission', () => {
  it('filters only exact registry authority and never exposes malformed auth bytes', () => {
    const base = path.join(root, '.test-data/installed-native-registry-test');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'config-'));
    chmodSync(dir, 0o700);
    try {
      const output = path.join(dir, 'config.json');
      installRegistryConfig(JSON.stringify({ auths: {
        'ccr.ccs.tencentyun.com': { auth: 'AUTHORIZED_SENTINEL' },
        'ccr.ccs.tencentyun.com.attacker.example': { auth: 'FOREIGN_SENTINEL' },
      } }), JSON.stringify({ auths: { 'ghcr.io': { auth: 'GHCR_SENTINEL' }, other: { auth: 'FOREIGN_SENTINEL' } } }), output);
      expect(Object.keys(JSON.parse(readFileSync(output, 'utf8')).auths)).toEqual(['ccr.ccs.tencentyun.com', 'ghcr.io']);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      for (const raw of ['{"auths":"PRIVATE_SENTINEL', JSON.stringify({ auths: {
        'https://ccr.ccs.tencentyun.com.attacker.example': { auth: 'PRIVATE_SENTINEL' },
      } })]) {
        try { installRegistryConfig(raw, '{}', path.join(dir, 'rejected.json')); throw new Error('accepted'); }
        catch (error) { expect(String(error)).not.toContain('PRIVATE_SENTINEL'); expect(String(error)).toContain('authorized-config-rejected'); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects stale UID, foreign owner, cached pull, business volume and wrong imageID', () => {
    const image = `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:${'b'.repeat(64)}`;
    const expected = { name: 'fresh-job', namespace: 'assigned', uid: 'new-uid', image };
    const job = { metadata: { name: expected.name, namespace: expected.namespace, uid: expected.uid },
      spec: { template: { spec: { imagePullSecrets: [{ name: 'tcr-creds' }],
        containers: [{ name: 'postgres-preflight', image, imagePullPolicy: 'Always' }],
      } } }, status: { conditions: [{ type: 'Complete', status: 'True' }] } };
    const pod = { metadata: { uid: 'pod-uid', ownerReferences: [{ uid: expected.uid, kind: 'Job', controller: true }] },
      status: { phase: 'Succeeded', containerStatuses: [{ name: 'postgres-preflight', imageID: `docker-pullable://${image}`,
        state: { terminated: { exitCode: 0 } } }] } };
    expect(validatePullJob(job, [pod], expected)).toEqual({ jobUID: 'new-uid', podUID: 'pod-uid', imageID: `docker-pullable://${image}` });
    const stale = structuredClone(job); stale.metadata.uid = 'old-uid';
    expect(() => validatePullJob(stale, [pod], expected)).toThrow();
    const cached = structuredClone(job); cached.spec.template.spec.containers[0].imagePullPolicy = 'IfNotPresent';
    expect(() => validatePullJob(cached, [pod], expected)).toThrow();
    const volume = { ...job, spec: { template: { spec: { ...job.spec.template.spec, volumes: [{ persistentVolumeClaim: { claimName: 'business' } }] } } } };
    expect(() => validatePullJob(volume, [pod], expected)).toThrow();
    const foreign = structuredClone(pod); foreign.metadata.ownerReferences[0].uid = 'foreign';
    expect(() => validatePullJob(job, [foreign], expected)).toThrow();
    const wrongImage = structuredClone(pod); wrongImage.status.containerStatuses[0].imageID = `containerd://sha256:${'c'.repeat(64)}`;
    expect(() => validatePullJob(job, [wrongImage], expected)).toThrow();
  });
});

const fakeDocker = `#!/usr/bin/env python3
import sys,os,json,pathlib,hashlib
args=sys.argv[1:]; root=pathlib.Path(os.environ['FAKE_DOCKER_STATE']); scenario=os.environ['FAKE_DOCKER_SCENARIO']
with (root/'calls.jsonl').open('a') as out: out.write(json.dumps(args)+'\\n')
def identity(name,suffix=''): return hashlib.sha256((name+suffix).encode()).hexdigest()
def create(name,kind,created,foreign=False):
 id=identity(name,'foreign' if foreign else ''); nonce=next((a.split('=',1)[1] for i,a in enumerate(created) if i and created[i-1]=='--label'),'')
 data={'Id':id,'Name':name if kind=='network' else '/'+name,'kind':kind,'args':created,'Labels':{'xpod.undefineds.co/conformance-owner':'FOREIGN' if foreign else nonce},'Config':{'Labels':{'xpod.undefineds.co/conformance-owner':'FOREIGN' if foreign else nonce}}}
 (root/id).write_text(json.dumps(data)); (root/name).write_text(id); return id
if args[:2]==['image','inspect']:
 ref=args[2]; labels={'org.opencontainers.image.revision':'a'*40,'org.opencontainers.image.source':'https://github.com/undefinedsco/xpod'}
 if scenario=='wrong-source': labels['org.opencontainers.image.revision']='b'*40
 print(json.dumps([{'RepoDigests':[ref],'Config':{'Labels':labels}}]))
elif args[:2]==['network','create']:
 id=create(args[-1],'network',args); print(id)
 if scenario=='network-ack-loss': sys.exit(28)
elif args[0]=='create':
 name=args[args.index('--name')+1]
 if scenario=='foreign' and name.startswith('xpod-qlever-pg-'):
  create(name,'container',args,True); print('foreign-create-refused',file=sys.stderr); sys.exit(18)
 id=create(name,'container',args); print(id)
 if scenario=='create-ack-loss' and name.startswith('xpod-qlever-pg-'): sys.exit(27)
elif args[0]=='inspect' or args[:2]==['network','inspect']:
 ref=args[-1]; target=root/ref
 if not target.exists(): sys.exit(1)
 data=target.read_text()
 if not data.startswith('{'): data=(root/data).read_text()
 print('['+data+']')
elif args[0]=='start':
 id=args[-1]; data=json.loads((root/id).read_text()); created=data['args']; name=data['Name'].lstrip('/')
 if scenario=='start-failed' and name.startswith('xpod-qlever-pg-'): print('created-start-failed',file=sys.stderr); sys.exit(45)
 if 'dist/acceptance/run-installed-qlever-conformance.js' in created:
  if scenario=='primary-failed': print('producer-exit-42',file=sys.stderr); sys.exit(42)
  env=dict(a.split('=',1) for i,a in enumerate(created) if i and created[i-1]=='-e'); mounts=[a for i,a in enumerate(created) if i and created[i-1]=='--mount']
  artifact=next(a.split('src=',1)[1].split(',')[0] for a in mounts if 'dst=/artifacts' in a); backend=env['XPOD_QLEVER_CONFORMANCE_BACKEND']
  report=json.loads((pathlib.Path(os.environ['FAKE_REPORT_ROOT'])/(backend+'.json')).read_text())
  if scenario=='forged': report['semantic']['canonicalDigest']='sha256:'+'f'*64
  target=pathlib.Path(artifact)/pathlib.Path(env['XPOD_QLEVER_CONFORMANCE_ARTIFACT_PATH']).name; target.write_text(json.dumps(report)); target.chmod(0o600)
  if scenario=='same-name-replaced' and backend=='sqlite': (root/id).unlink(); create(name,'container',created,True)
  if scenario=='network-replaced' and backend=='pg':
   network_id=created[created.index('--network')+1]; network=json.loads((root/network_id).read_text()); (root/network_id).unlink(); create(network['Name'],'network',network['args'],True)
elif args[0]=='exec':
 if '-Atc' in args: print(json.dumps({'version':170003,'extensions':['vector','xpod_qlever','xpod_rdf'],'native':{'abiVersion':2 if scenario=='bad-abi' else 1,'ready':True}}))
elif args[0]=='rm' or args[:2]==['network','rm']:
 if os.environ['FAKE_CLEANUP_EXIT']!='0': print('cleanup-exit-23',file=sys.stderr); sys.exit(23)
 id=args[-1]; target=root/id
 if not target.exists(): sys.exit(1)
 data=json.loads(target.read_text()); target.unlink(); name=data['Name'].lstrip('/'); mapping=root/name
 if mapping.exists() and mapping.read_text()==id: mapping.unlink()
elif args[:2]==['container','ls'] or args[:2]==['network','ls']:
 value=args[-1]
 if value.startswith('id='):
  id=value[3:]
  if (root/id).exists(): print(id)
 else:
  name=value.split('name=^',1)[1].strip('/$'); mapping=root/name
  if mapping.exists(): print(mapping.read_text())
`;

describe('actual installed helper with fake Docker producers', () => {
  it.each([
    ['primary-failed', 23, 42], ['success', 23, 70], ['primary-failed', 0, 42], ['success', 0, 0],
    ['start-failed', 0, 45], ['foreign', 0, 18], ['bad-abi', 0, 1], ['forged', 0, 1], ['wrong-source', 0, 1],
    ['create-ack-loss', 0, 27], ['network-ack-loss', 0, 28], ['same-name-replaced', 0, 0], ['network-replaced', 0, 0],
  ] as const)('%s / cleanup %s returns %s and only cleans created resources', (scenario, cleanupExit, expectedExit) => {
    const base = path.join(root, '.test-data/installed-native-producer-test');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'producer-'));
    chmodSync(dir, 0o700);
    const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const artifacts = path.join(dir, 'artifacts');
    for (const child of [bin, state, artifacts]) mkdirSync(child, { mode: 0o700 });
    writeFileSync(path.join(bin, 'docker'), fakeDocker, { mode: 0o700 });
    writeFileSync(path.join(dir, 'sqlite.json'), JSON.stringify(validReport()), { mode: 0o600 });
    writeFileSync(path.join(dir, 'pg.json'), JSON.stringify(validReport('pg')), { mode: 0o600 });
    try {
      const commandArgs = [path.join(root, 'scripts/check-qlever-installed-image-conformance.ts'),
        '--installed-image', `ghcr.io/undefinedsco/xpod@sha256:${'b'.repeat(64)}`,
        '--pg-image', `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:${'c'.repeat(64)}`,
        '--fixture', fixturePath, '--artifact-dir', artifacts, '--source-sha', 'a'.repeat(40), '--runner-sha256', 'd'.repeat(64)];
      const start = Date.now();
      const result = spawnSync('bun', commandArgs, { cwd: root, encoding: 'utf8', timeout: 20_000, env: {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: state,
        FAKE_DOCKER_SCENARIO: scenario, FAKE_CLEANUP_EXIT: String(cleanupExit), FAKE_REPORT_ROOT: dir,
      } });
      const evidenceDir = process.env.XPOD_NATIVE_TEST_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        const raw = `${result.stdout}\n${result.stderr}`;
        writeFileSync(path.join(evidenceDir, `${scenario}-${cleanupExit}.log`), raw, { mode: 0o600 });
        writeFileSync(path.join(evidenceDir, `${scenario}-${cleanupExit}.receipt.json`), JSON.stringify({
          command: ['bun', ...commandArgs], pid: result.pid, actualExit: result.status, signal: result.signal,
          wallMs: Date.now() - start, closedLogSHA256: createHash('sha256').update(raw).digest('hex'),
          calls: readFileSync(path.join(state, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
        }, null, 2), { mode: 0o600 });
      }
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(expectedExit);
      const calls = readFileSync(path.join(state, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      if (cleanupExit !== 0) expect(result.stderr).toContain('owned-resource-cleanup-failed');
      if (scenario === 'foreign') {
        const foreign = calls.find(call => call[0] === 'create' && call.includes('--network-alias'))![2];
        const id = readFileSync(path.join(state, foreign), 'utf8');
        expect(JSON.parse(readFileSync(path.join(state, id), 'utf8')).Config.Labels['xpod.undefineds.co/conformance-owner']).toBe('FOREIGN');
        expect(calls.some(call => call[0] === 'rm' && (call.includes(foreign) || call.includes(id)))).toBe(false);
      }
      if (cleanupExit === 0) {
        const ownedCreated = calls.filter(call => call[0] === 'create')
          .filter(call => scenario !== 'foreign' || !call.includes('--network-alias')).map(call => call[2]);
        for (const owned of ownedCreated) {
          const id = createHash('sha256').update(owned).digest('hex');
          expect(() => readFileSync(path.join(state, id))).toThrow();
        }
        const network = calls.find(call => call[0] === 'network' && call[1] === 'create');
        if (network) expect(() => readFileSync(path.join(state, createHash('sha256').update(network[network.length - 1]).digest('hex')))).toThrow();
        for (const call of calls.filter(entry => entry[0] === 'rm' || (entry[0] === 'network' && entry[1] === 'rm'))) {
          expect(call[call.length - 1]).toMatch(/^[a-f0-9]{64}$/);
        }
      }
      if (scenario === 'start-failed' || scenario === 'create-ack-loss') {
        const pg = calls.find(call => call[0] === 'create' && call.includes('--network-alias'))!;
        expect(calls.some(call => call[0] === 'rm' && call[2] === createHash('sha256').update(pg[2]).digest('hex'))).toBe(true);
      }
      if (scenario === 'same-name-replaced' || scenario === 'network-replaced') {
        const create = scenario === 'same-name-replaced'
          ? calls.find(call => call[0] === 'create' && call.some(arg => arg === 'XPOD_QLEVER_CONFORMANCE_BACKEND=sqlite'))!
          : calls.find(call => call[0] === 'network' && call[1] === 'create')!;
        const name = scenario === 'same-name-replaced' ? create[2] : create[create.length - 1];
        const foreignID = createHash('sha256').update(`${name}foreign`).digest('hex');
        expect(JSON.parse(readFileSync(path.join(state, foreignID), 'utf8')).Labels['xpod.undefineds.co/conformance-owner']).toBe('FOREIGN');
        expect(calls.some(call => call[call.length - 1] === foreignID && (call[0] === 'rm' || call[1] === 'rm'))).toBe(false);
      }
      const reportPath = path.join(artifacts, 'installed-image-conformance.json');
      if (expectedExit === 0) expect(JSON.parse(readFileSync(reportPath, 'utf8')).ownedCleanup).toBe('verified-absent');
      else expect(() => readFileSync(reportPath)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('private17 sanitized single JSON boundary', () => {
  const expected = { admissionSha256: '', installedImage: `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`,
    pgImage: `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:${'b'.repeat(64)}`,
    sourceSha: 'c'.repeat(40), runnerSha256: 'd'.repeat(64), publicDatabase: 'xpod_public16_unique' };
  function proof(): Record<string, any> {
    return { schemaVersion: 1, kind: 'immutable-installed-component-admission', status: 'ok',
      sourceSha: expected.sourceSha, serviceImage: expected.installedImage, postgresImage: expected.pgImage,
      runnerSHA256: expected.runnerSha256, fixtureSHA256: '09e389146adc51a10a26785a34ef471c66d8bbf00f61b0b69d536d29874120b8',
      database: 'xpod_private17_owned', semantic: { completeCaseCount: 17,
        expectedCaseSetSHA256: '348777fe09a4e4baba4287e579cb7b665e5d83aeab144819beb16cb34e12d24e',
        validatorVersion: 'private17-canonical-digest-search-v1',
        validatorSourceSHA256: '3436b584435f2ea25f28d14cede7721444d333da4ca2305919b4e7cbdc726034',
        contractSourceSHA256: '6f1346e598f11959b1e696639fd151f498bd8901ef658c5613435a44d5c46ca1',
        canonicalDigest: `sha256:${'e'.repeat(64)}`, failed: 0, skipped: 0, deniedRowsObserved: 0 },
      search: 'verified', abi: '1|true', producer: { actualExit: 0, signal: null, childCount: 1,
        closedRawSHA256: ['f'.repeat(64)], producerSourceSHA256: '0fe0ca179fd4544188dc5a5d60ea7ee1ebe24f8ac4acb7f56471c3294271aa34', closedReceiptSHA256: '9'.repeat(64) },
      cleanup: { databaseAbsent: true, ownedResourcesAbsent: true } };
  }
  function check(bytes: string, authority?: string): Record<string, unknown> {
    const base = path.join(root, '.test-data/private17-admission-test'); mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'json-')); chmodSync(dir, 0o700);
    const file = path.join(dir, 'private17-admission.json');
    try {
      writeFileSync(file, bytes, { mode: 0o600 });
      return verifyPrivate17Admission(file, { ...expected,
        admissionSha256: authority ?? createHash('sha256').update(bytes).digest('hex') });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('accepts only a closed source-bound sanitized JSON without private fixture execution', () => {
    expect(check(JSON.stringify(proof()))).toMatchObject({ status: 'ok', sourceSha: expected.sourceSha,
      installedImage: expected.installedImage, pgImage: expected.pgImage, database: 'xpod_private17_owned',
      evidenceBoundary: 'immutable-installed-component' });
  });
  it('hashes exact bytes before parsing malformed JSON', () => {
    expect(() => check('{PRIVATE_SENTINEL', '0'.repeat(64))).toThrow(/authority mismatch/);
    expect(() => check('{PRIVATE_SENTINEL')).toThrow(/JSON/);
  });
  it('rejects private payload fields even under approved byte authority', () => {
    const value = proof(); value.fixture = 'PRIVATE_SENTINEL';
    expect(() => check(JSON.stringify(value))).toThrow(/fields/);
  });
  it.each(['sourceSha', 'serviceImage', 'postgresImage', 'runnerSHA256', 'fixtureSHA256', 'search', 'abi', 'status', 'kind'])
  ('rejects a mismatched %s', key => {
    const value = proof(); value[key] = 'PRIVATE_SENTINEL';
    expect(() => check(JSON.stringify(value))).toThrow();
  });
  it.each(['completeCaseCount', 'expectedCaseSetSHA256', 'validatorVersion', 'validatorSourceSHA256',
    'contractSourceSHA256', 'canonicalDigest', 'failed', 'skipped', 'deniedRowsObserved'])('rejects semantic %s', key => {
    const value = proof(); value.semantic[key] = key.endsWith('Count') || ['failed', 'skipped', 'deniedRowsObserved'].includes(key) ? 1 : 'PRIVATE_SENTINEL';
    expect(() => check(JSON.stringify(value))).toThrow();
  });
  it.each(['actualExit', 'signal', 'childCount', 'closedRawSHA256', 'producerSourceSHA256', 'closedReceiptSHA256'])
  ('rejects unclosed producer %s', key => {
    const value = proof(); value.producer[key] = key === 'closedRawSHA256' ? [] : 'PRIVATE_SENTINEL';
    expect(() => check(JSON.stringify(value))).toThrow();
  });
  it('rejects missing/nested unknown fields, business database and uncertain cleanup', () => {
    const missing = proof(); delete missing.abi;
    const nested = proof(); nested.producer.raw = 'PRIVATE_SENTINEL';
    const business = proof(); business.database = 'xpod_rc';
    const cleanup = proof(); cleanup.cleanup.databaseAbsent = false;
    const count = proof(); count.producer.childCount = 2;
    for (const value of [missing, nested, business, cleanup, count]) expect(() => check(JSON.stringify(value))).toThrow();
  });
  it('refuses a Public16 report from another build before admitting Private17', () => {
    const base = path.join(root, '.test-data/private17-admission-test'); mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'public-binding-'));
    const report = path.join(dir, 'public16.json'); const receipt = path.join(dir, 'receipt.json');
    writeFileSync(report, JSON.stringify({ database: expected.publicDatabase, sourceSha: 'PRIVATE_SENTINEL' }), { mode: 0o600 });
    try {
      const result = spawnSync('bun', [path.join(root, 'scripts/check-qlever-installed-image-conformance.ts'),
        '--verify-private17-admission', path.join(dir, 'private17-admission.json'), '--public16-report', report,
        '--private17-receipt', receipt, '--source-sha', expected.sourceSha, '--installed-image', expected.installedImage,
        '--pg-image', expected.pgImage, '--runner-sha256', expected.runnerSha256, '--admission-sha256', 'a'.repeat(64)],
      { cwd: root, encoding: 'utf8', timeout: 20_000 });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
      expect(result.stderr).toContain('public16-binding-mismatch'); expect(result.stderr).not.toContain('PRIVATE_SENTINEL');
      expect(() => readFileSync(receipt)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a symlink asset without changing its foreign target', () => {
    const base = path.join(root, '.test-data/private17-admission-test'); mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'symlink-')); const target = path.join(dir, 'foreign.json');
    const bytes = JSON.stringify(proof()); writeFileSync(target, bytes, { mode: 0o600 });
    const file = path.join(dir, 'private17-admission.json'); symlinkSync(target, file);
    try {
      expect(() => verifyPrivate17Admission(file, { ...expected,
        admissionSha256: createHash('sha256').update(bytes).digest('hex') })).toThrow();
      expect(readFileSync(target, 'utf8')).toBe(bytes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects oversized bytes without reading or exposing payload content', () => {
    expect(() => check('PRIVATE_SENTINEL'.repeat(8192))).toThrow(/size/);
  });
});


describe('fixed public Release proof acquisition', () => {
  it('derives a collision-resistant tag from original source and full image digest', () => {
    const source = 'a'.repeat(40); const digest = 'b'.repeat(64);
    expect(private17ProofTag(source, `ghcr.io/undefinedsco/xpod@sha256:${digest}`)).toBe(`private17-${source}-${digest}`);
    expect(() => private17ProofTag(source, `foreign/xpod@sha256:${digest}`)).toThrow();
    expect(() => private17ProofTag('PRIVATE_SENTINEL', `ghcr.io/undefinedsco/xpod@sha256:${digest}`)).toThrow();
  });
  it.each(['success', 'wrong-hash', 'producer-failed', 'oversize', 'foreign-file'])
  ('bounds %s without printing untrusted bytes or overwriting a file', mode => {
    const base = path.join(root, '.test-data/private17-download-test'); mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'owned-')); chmodSync(dir, 0o700);
    const bin = path.join(dir, 'bin'); mkdirSync(bin, { mode: 0o700 });
    const bytes = '{"transport":"only"}'; const originalPath = process.env.PATH;
    const calls = path.join(dir, 'calls.json');
    writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env python3
import sys,json,pathlib
pathlib.Path(${JSON.stringify(calls)}).write_text(json.dumps(sys.argv[1:]))
sys.stdout.write(${JSON.stringify(mode === 'oversize' ? 'X'.repeat(70_000) : bytes)})
sys.stderr.write('PRIVATE_SENTINEL')
sys.exit(${mode === 'producer-failed' ? 27 : 0})
`, { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const output = path.join(dir, 'private17-admission.json');
    try {
      if (mode === 'foreign-file') writeFileSync(output, 'foreign', { mode: 0o600 });
      const expected = { sourceSha: 'a'.repeat(40), installedImage: `ghcr.io/undefinedsco/xpod@sha256:${'b'.repeat(64)}`,
        admissionSha256: mode === 'wrong-hash' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') };
      if (mode === 'success') {
        acquirePrivate17Admission(output, expected);
        expect(readFileSync(output, 'utf8')).toBe(bytes); expect(statSync(output).mode & 0o777).toBe(0o600);
      } else {
        try { acquirePrivate17Admission(output, expected); throw new Error('accepted'); }
        catch (error) { expect(String(error)).not.toContain('PRIVATE_SENTINEL'); expect(String(error)).not.toBe('Error: accepted'); }
        if (mode === 'foreign-file') expect(readFileSync(output, 'utf8')).toBe('foreign');
        else expect(() => readFileSync(output)).toThrow();
      }
      expect(JSON.parse(readFileSync(calls, 'utf8'))).toEqual(['release', 'download', `private17-${expected.sourceSha}-${'b'.repeat(64)}`,
        '--repo', 'undefinedsco/xpod', '--pattern', 'private17-admission.json', '--output', '-']);
    } finally { process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); }
  });
});
