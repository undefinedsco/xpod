import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectModule, exportSafe, nativeFacts, projectReceipt, projectRecoveryDiagnostic, INSTALLED_CONSUMER_STAGES, verifyInstalledConsumerReceipts } from '../../scripts/agentfs-native-ci/mounted/prepare-module-inputs';
import { hashBytes } from '../../scripts/agentfs-native-ci/mounted/module-admission';

function fixture(run: (root: string) => void): void {
  const parent = path.resolve('.test-data/module-input-preparation'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(parent, 'case-')); try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
describe('module mounted input preparation', () => {
  it('projects observed recovery failures without private errors, arguments or paths', () => fixture(root => {
    const row = { label: 'recovery-final', backend: 'fuse', primaryError: 'Error: owned unmount after-sigkill failed: private-secret',
      cleanupError: 'private-secret', kernelState: 'absent', sceneRetained: false, writerOutcome: 'write-failed:private-secret',
      recoveryStages: { seedObserved: { executed: true, success: true }, killedClosed: { executed: true, success: null },
        orphanRemoved: { executed: false, success: true } },
      unmountResults: [{ instance: 'first', phase: 'after-sigkill', preKernel: { state: 'mounted', reason: 'classify-unknown:unknown-ancestor-type', classifyReason: 'unknown-ancestor-type', errorCode: 'ENOTCONN' }, postKernel: { state: 'absent' },
        result: { state: 'closed', actualExit: 1, signal: null, stderr: 'crashed runtime kernel binding changed or unknown: private-secret' } }], argv: ['private-secret'] };
    const projected = projectRecoveryDiagnostic(row);
    expect((projected.stages as any).seedObserved).toEqual({ executed: true, success: true });
    expect((projected.stages as any).killedClosed).toEqual({ executed: true, success: null });
    expect((projected.stages as any).orphanRemoved).toEqual({ executed: false, success: null });
    expect((projected.stages as any).remountObserved).toEqual({ executed: null, success: null });
    expect(projected.primaryFailure).toBe('first-unmount-failed'); expect(projected.cleanupFailure).toBe('unclassified');
    expect(JSON.stringify(projected)).not.toContain('private-secret'); expect(projected.diagnosticOnly).toBe(true);
    const evidence = path.join(root, 'evidence'); mkdirSync(evidence);
    writeFileSync(path.join(evidence, 'daemon-recovery-final-123-456.json'), JSON.stringify(row));
    writeFileSync(path.join(evidence, 'daemon-recovery-final-123-456.raw.log'), 'private-secret');
    exportSafe(evidence, path.join(root, 'export'));
    const exported = readFileSync(path.join(root, 'export/recovery-diagnostic.safe.json'), 'utf8');
    expect(exported).not.toContain('private-secret'); expect(JSON.parse(exported).unmounts[0].result.actualExit).toBe(1);
    expect(JSON.parse(exported).unmounts[0].result.failure).toBe('crashed-kernel-binding-mismatch');
    expect(JSON.parse(exported).unmounts[0].preKernel).toEqual({ state: 'mounted', reason: 'classify-unknown', classifyReason: 'unknown-ancestor-type', errorCode: 'ENOTCONN' });
    expect(readdirSync(path.join(root, 'export'))).toEqual(['export.safe.json', 'recovery-diagnostic.safe.json']);
    expect(() => projectRecoveryDiagnostic({ ...row, label: 'private-secret' })).toThrow('invalid recovery diagnostic');
  }));
  it('rejects failure diagnostics with free text instead of approved values', () => {
    const valid = { backend: 'fuse', stage: 'native-identity', errorCode: 'ENOENT', errorSHA256: 'a'.repeat(64), primaryFailureObserved: true };
    expect(projectReceipt('module-chain-failure.safe.json', { ...valid, token: 'private-secret' })).toEqual(valid);
    expect(() => projectReceipt('module-chain-failure.safe.json', { ...valid, backend: { toString: () => 'fuse' } })).toThrow('invalid module chain failure receipt');
    for (const key of ['backend', 'stage', 'errorCode', 'errorSHA256', 'primaryFailureObserved']) {
      expect(() => projectReceipt('module-chain-failure.safe.json', { ...valid, [key]: 'private-secret' })).toThrow('invalid module chain failure receipt');
    }
  });
  it('requires all nine closed actual consumer stages and proxy cleanup, verifies raw hashes, and projects only fixed fields', () => fixture(root => {
    for (const stage of INSTALLED_CONSUMER_STAGES) {
      for (const stream of ['stdout', 'stderr']) writeFileSync(path.join(root, `${stage}.${stream}`), 'private-marker');
      writeFileSync(path.join(root, stage + '.safe.json'), JSON.stringify({ stage, pid: 123, actualExit: stage === 'node-startup-cancel' ? 143 : 0, actualSignal: null,
        actualWait: true, rawClosed: true, groupAbsent: true, stdoutSHA256: hashBytes('private-marker'), stderrSHA256: hashBytes('private-marker'), unknown: { credentials: 'private-marker' } }));
    }
    const proxy = path.join(root, 'proxy-cancel.safe.json'); writeFileSync(proxy, JSON.stringify({ pid: 321, groupAbsent: true, tokenFixtureObserved: true, nativeMountStarted: false, clientSecret: 'private-marker' }));
    const facts = verifyInstalledConsumerReceipts(root); expect(facts.stages).toHaveLength(9); expect(JSON.stringify(facts)).not.toContain('private-marker');
    const first = path.join(root, INSTALLED_CONSUMER_STAGES[0] + '.stdout'); writeFileSync(first, 'tampered'); expect(() => verifyInstalledConsumerReceipts(root)).toThrow('identity mismatch'); writeFileSync(first, 'private-marker');
    writeFileSync(proxy, JSON.stringify({ pid: 321, groupAbsent: false, tokenFixtureObserved: true, nativeMountStarted: false })); expect(() => verifyInstalledConsumerReceipts(root)).toThrow('proxy cleanup incomplete');
    rmSync(path.join(root, INSTALLED_CONSUMER_STAGES[0] + '.safe.json')); expect(() => verifyInstalledConsumerReceipts(root)).toThrow('receipt inventory');
  }));
  it('actual workflow Bun command compiles the real driver and produces physical input metadata', () => fixture(root => {
    const workflow = readFileSync(path.resolve('.github/workflows/agentfs-module-mounted-acceptance.yml'), 'utf8');
    const commands = workflow.split('\n').filter(line => line.trimStart().startsWith('bun build scripts/agentfs-native-ci/mounted/module-admission.ts '));
    expect(commands).toHaveLength(1);
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${commands[0].trim()}`], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, MODULE_RUN_ROOT: root }, encoding: 'utf8',
    });
    expect(result.status).toBe(0); expect(result.signal).toBeNull();
    const driver = path.join(root, 'module-admission.mjs'); const metadata = path.join(root, 'driver-inputs.json');
    expect(statSync(driver).isFile()).toBe(true);
    const inputs = Object.keys(JSON.parse(readFileSync(metadata, 'utf8')).inputs);
    expect(inputs.map(input => path.resolve(input))).toContain(path.resolve('scripts/agentfs-native-ci/mounted/module-admission.ts'));
    expect(inputs.length).toBeGreaterThan(1);
    for (const input of inputs) expect(statSync(path.resolve(input)).isFile()).toBe(true);
    // This test compiles the real entry, but deliberately never executes it.
  }));
  it('actual workflow directory setup creates a private cold parent and fresh leaf, writes GitHub env, and refuses leaf reuse', () => fixture(root => {
    const workflow = readFileSync(path.resolve('.github/workflows/agentfs-module-mounted-acceptance.yml'), 'utf8');
    const start = workflow.indexOf('          root="$GITHUB_WORKSPACE/.test-data/module-mounted-');
    const end = workflow.indexOf('\n          bun scripts/agentfs-native-ci/mounted/prepare-module-inputs.ts native-info', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const directorySetup = workflow.slice(start, end).split('\n').map(line => line.slice(10)).join('\n');
    const envFile = path.join(root, 'github-env'); writeFileSync(envFile, '');
    const env = { PATH: process.env.PATH, GITHUB_WORKSPACE: root, GITHUB_RUN_ID: 'cold-run', GITHUB_RUN_ATTEMPT: '1', GITHUB_ENV: envFile };
    expect(existsSync(path.join(root, '.test-data'))).toBe(false);
    const first = spawnSync('bash', ['-c', `set -euo pipefail\numask 077\n${directorySetup}`], { env, encoding: 'utf8' });
    expect(first.status).toBe(0); expect(first.signal).toBeNull();
    const leaf = path.join(root, '.test-data/module-mounted-cold-run-1');
    expect(statSync(path.join(root, '.test-data')).mode & 0o777).toBe(0o700); expect(statSync(leaf).mode & 0o777).toBe(0o700);
    const initialEnv = readFileSync(envFile, 'utf8'); expect(initialEnv).toBe(`MODULE_RUN_ROOT=${leaf}\n`);
    const second = spawnSync('bash', ['-c', `set -euo pipefail\numask 077\n${directorySetup}`], { env, encoding: 'utf8' });
    expect(second.status).not.toBe(0); expect(second.signal).toBeNull(); expect(readFileSync(envFile, 'utf8')).toBe(initialEnv);
    const close = workflow.slice(workflow.indexOf('      - name: Close owned image'), workflow.indexOf('      - uses: actions/upload-artifact'));
    expect(close).toContain("if: always() && env.MODULE_RUN_ROOT != ''");
  }));
  it('fixed nested schemas discard unknown credentials, token, clientSecret and argv at every allowed container', () => {
    const secret = { credentials: { token: 'private-marker', clientSecret: 'private-marker' }, argv: ['private-marker'], arbitrary: { value: 'private-marker' } };
    const input = { ...secret, schemaVersion: 1, producerClosed: true, moduleBinding: { ...secret, moduleSourceSHA: '1'.repeat(40), runtime: 'node' },
      producerLifecycle: { ...secret, pid: 123, closeObserved: true },
      ownedProcessObservations: [{ ...secret, phase: 'after-owned-reap', known: true, members: [{ ...secret, pid: 123, ppid: 1, pgid: 123, state: 'S' }] }],
      vitestReport: { ...secret, requiredCases: ['actual required assertion'], requiredSatisfied: true, notPassed: [{ ...secret, title: 'known assertion', status: 'failed' }] } };
    const projected = projectReceipt('mounted-linux.receipt.json', input) as any;
    expect(JSON.stringify(projected)).not.toContain('private-marker'); expect(projected.moduleBinding.runtime).toBe('node');
    expect(projected.producerLifecycle.pid).toBe(123); expect(projected.ownedProcessObservations[0].members[0].pgid).toBe(123);
    expect(projected.vitestReport.requiredCases).toEqual(['actual required assertion']);
    const cleanup = projectReceipt('module-chain-cleanup.safe.json', { ...secret, cleanupVerified: false, ownedPids: [123],
      children: [{ ...secret, code: 1, lifecycle: { ...secret, pid: 123, closeObserved: true }, args: ['private-marker'] }] }) as any;
    expect(JSON.stringify(cleanup)).not.toContain('private-marker'); expect(cleanup.children[0].code).toBe(1); expect(cleanup.ownedPids).toEqual([123]);
    const control = projectReceipt('linux-container-binding.json', { ...secret, released: true, container: { ...secret, CapAdd: ['SYS_ADMIN'], Devices: [{ ...secret, PathOnHost: '/dev/fuse' }], Mounts: [{ ...secret, destination: '/evidence', RW: true }] },
      consumerReceipt: { ...secret, actualWait: true, exit: 0 } }) as any;
    expect(JSON.stringify(control)).not.toContain('private-marker'); expect(control.container.CapAdd).toEqual(['SYS_ADMIN']); expect(control.consumerReceipt.actualWait).toBe(true);
    expect(projectReceipt('rss-512.json', { ...secret, phaseRead: [1234], readPeakKib: 1234 })).toEqual({ phaseRead: [1234], readPeakKib: 1234 });
    expect(projectReceipt('module-install.safe.json', { runtime: secret, ownedPids: secret })).toEqual({});
  });
  it('binds all four exact reviewed native artifacts and rejects unsupported targets', () => {
    for (const target of ['linux-arm64', 'darwin-arm64', 'linux-x64', 'darwin-x64']) {
      const facts = nativeFacts(target); expect(facts.run).toBe('38104482639'); expect(facts.source).toBe('5f037c09bd54980c68406d4a1aa534af14fcbd70');
      expect(facts.zipSHA256).toMatch(/^[a-f0-9]{64}$/); expect(facts.pins.PRODUCT_SHA).toBe(facts.source);
    }
    expect(() => nativeFacts('linux-riscv64')).toThrow('unsupported');
  });
  it.each(['changed-manifest', 'duplicate', 'symlink', 'unlisted'])('rejects actual serialized archive %s before installer or mount', (variant) => fixture(root => {
    const archive = path.join(root, 'module.tgz');
    execFileSync('python3', ['-c', `import tarfile,io,json,sys
variant=sys.argv[2]
with tarfile.open(sys.argv[1],'w:gz') as t:
 def add(name,data):
  m=tarfile.TarInfo(name);m.size=len(data);m.mode=420;t.addfile(m,io.BytesIO(data))
 manifest={'name':'@undefineds.co/xpod-afs-linux-arm64','version':'0.1.0','xpodModule':{'schemaVersion':1,'id':'afs','platform':'linux','arch':'arm64','entry':'dist/entry.mjs','files':[]}}
 if variant=='changed-manifest':manifest['name']='unbound-preview'
 add('package/package.json',json.dumps(manifest).encode())
 if variant=='duplicate':add('package/package.json',b'{}')
 if variant=='symlink':
  m=tarfile.TarInfo('package/secret');m.type=tarfile.SYMTYPE;m.linkname='/private/secret';t.addfile(m)
 if variant=='unlisted':add('package/dist/entry.mjs',b'unlisted')`, archive, variant]);
    expect(() => collectModule(archive, 'linux-arm64', '1'.repeat(40), '2'.repeat(64), '3'.repeat(64))).toThrow();
  }));
  it('exports a fixed receipt whitelist, excluding credentials, HOME and raw reports', () => fixture(root => {
    const evidence = path.join(root, 'evidence'); mkdirSync(evidence);
    for (const name of ['module-admission.safe.json', 'module-chain-cleanup.safe.json']) writeFileSync(path.join(evidence, name), '{"accepted":false,"vitestReport":{"failureText":"private-marker"},"children":[{"args":["private-marker"],"exit":1}]}');
    for (const name of ['credentials.json', 'session.safe.json', 'native-reuse.raw.log', 'vitest.json']) writeFileSync(path.join(evidence, name), 'private-marker');
    mkdirSync(path.join(evidence, 'HOME')); writeFileSync(path.join(evidence, 'HOME', 'secret'), 'private-marker');
    const out = path.join(root, 'export'); exportSafe(evidence, out);
    expect(readdirSync(out).sort()).toEqual(['export.safe.json', 'module-admission.safe.json', 'module-chain-cleanup.safe.json']);
    expect(readFileSync(path.join(out, 'export.safe.json'), 'utf8')).not.toContain('private-marker');
    expect(readFileSync(path.join(out, 'module-admission.safe.json'), 'utf8')).not.toContain('private-marker');
    expect(() => exportSafe(evidence, out)).toThrow();
  }));
  it.each(['source-bytes', 'source-extra'])('rejects actual nested source archive %s mismatch', variant => fixture(root => {
    const archive = path.join(root, 'module.tgz');
    execFileSync('python3', ['-c', `import tarfile,io,json,hashlib,sys
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w:gz') as t:
 def add(t,n,b):
  m=tarfile.TarInfo(n);m.size=len(b);m.mode=420;t.addfile(m,io.BytesIO(b))
 add(t,'./src/input.ts',b'actual-source')
 if sys.argv[2]=='source-extra':add(t,'./src/extra.ts',b'extra')
kit={'files':[{'path':'src/input.ts','bytes':13,'sha256':hashlib.sha256(b'wrong-source' if sys.argv[2]=='source-bytes' else b'actual-source').hexdigest()}]}
members={'sources/module-source.tar.gz':buf.getvalue(),'provenance/module-source-kit.json':json.dumps(kit).encode()}
files=[{'path':n,'sha256':hashlib.sha256(b).hexdigest(),'size':len(b),'mode':420} for n,b in members.items()]
pkg={'name':'@undefineds.co/xpod-afs-linux-arm64','version':'0.1.0','xpodModule':{'schemaVersion':1,'id':'afs','platform':'linux','arch':'arm64','entry':'dist/entry.mjs','files':files}}
with tarfile.open(sys.argv[1],'w:gz') as t:
 add(t,'package/package.json',json.dumps(pkg).encode())
 for n,b in members.items():add(t,'package/'+n,b)`, archive, variant]);
    expect(() => collectModule(archive, 'linux-arm64', '1'.repeat(40), '2'.repeat(64), '3'.repeat(64))).toThrow('source archive inventory mismatch');
  }));
  it('projects actual container closure and hashes its raw receipt without copying private fields', () => fixture(root => {
    const evidence = path.join(root, 'evidence'); mkdirSync(evidence);
    writeFileSync(path.join(evidence, 'linux-container-binding.json'), JSON.stringify({ state: 'verified', cid: 'c'.repeat(64), released: true,
      containerAbsent: true, privateFixtureToken: 'private-marker', consumerReceipt: { exit: 0, signal: null, actualWait: true, rawClosedBeforeHash: true, ownedGroupAbsentAfterWait: true, args: ['private-marker'] } }));
    const out = path.join(root, 'out'); exportSafe(evidence, out);
    const bytes = readFileSync(path.join(out, 'linux-container-binding.safe.json'), 'utf8'); expect(bytes).not.toContain('private-marker');
    const report = JSON.parse(bytes); expect(report.containerAbsent).toBe(true); expect(report.sourceReceiptSHA256).toMatch(/^[a-f0-9]{64}$/); expect(report.consumerReceipt.actualWait).toBe(true);
  }));
  it('rejects a whitelisted symlink instead of uploading its target', () => fixture(root => {
    const evidence = path.join(root, 'evidence'); mkdirSync(evidence); const secret = path.join(root, 'secret'); writeFileSync(secret, '{}');
    symlinkSync(secret, path.join(evidence, 'module-admission.safe.json'));
    expect(() => exportSafe(evidence, path.join(root, 'out'))).toThrow('identity mismatch');
  }));
  it('actual preparer CLI rejects a contradictory immutable source without leaking input', () => fixture(root => {
    const result = spawnSync('bun', ['scripts/agentfs-native-ci/mounted/prepare-module-inputs.ts', 'prepare', '--target', 'linux-arm64', '--workspace', process.cwd(), '--source-sha', '0'.repeat(40)], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.signal).toBeNull(); expect(result.stderr).toContain('module preparation rejected'); expect(result.stdout).toBe('');
  }));
});
