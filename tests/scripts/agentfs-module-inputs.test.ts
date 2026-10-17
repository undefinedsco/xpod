import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installedConsumerWatchdogMs, runOwnedInstalledConsumer } from '../../scripts/agentfs-native-ci/mounted/owned-installed-consumer';
import { collectModule, exportSafe, nativeFacts, projectReceipt, projectRecoveryDiagnostic, INSTALLED_CONSUMER_STAGES, verifyInstalledConsumerReceipts, recordInstalledConsumerFailure, assertInstalledConsumerProducer, persistInstalledConsumerReceipt } from '../../scripts/agentfs-native-ci/mounted/prepare-module-inputs';
import { verifyModuleClientMaterials, moduleClientPath, hashBytes, verifyCliRuntimeTree, writeBootstrapEvidence } from '../../scripts/agentfs-native-ci/mounted/module-admission';

function fixture(run: (root: string) => void): void {
  const parent = path.resolve('.test-data/module-input-preparation'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(parent, 'case-')); try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

async function asyncFixture(run: (root: string) => Promise<void>): Promise<void> {
  const parent = path.resolve('.test-data/module-input-preparation'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(parent, 'case-')); try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('module mounted input preparation', () => {
  it('restores only verified tar file modes under a restrictive process umask', () => fixture(root => {
    const cliFiles = {
      'package.json': JSON.stringify({ name: '@undefineds.co/xpod-cli', version: '0.1.0', bin: { xpod: './dist/bin/xpod' }, dependencies: { '@undefineds.co/xpod-client': '0.1.0' } }),
      'dist/xpod.mjs': 'export {};\n', 'dist/bin/xpod': '#!/bin/sh\nexit 0\n',
    };
    const clientFiles = { 'package.json': JSON.stringify({ name: '@undefineds.co/xpod-client', version: '0.1.0' }), 'dist/library.cjs': 'module.exports = {};\n' };
    const inventory = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, {
      bytes: Buffer.byteLength(bytes), sha256: hashBytes(bytes), mode: name === 'dist/bin/xpod' ? 0o755 : 0o644,
    }]));
    const pack = `import tarfile,io,json,sys\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n for n,b in json.loads(sys.argv[2]).items():\n  b=b.encode();m=tarfile.TarInfo('package/'+n);m.size=len(b);m.mode=0o755 if n=='dist/bin/xpod' else 0o644;t.addfile(m,io.BytesIO(b))\n`;
    const cli = path.join(root, 'cli.tgz'); const client = path.join(root, 'client.tgz');
    execFileSync('python3', ['-c', pack, cli, JSON.stringify(cliFiles)]);
    execFileSync('python3', ['-c', pack, client, JSON.stringify(clientFiles)]);
    const input = path.join(root, 'input.json');
    writeFileSync(input, JSON.stringify({ workspace: process.cwd(), core: { sha256: hashBytes(cliFiles['dist/xpod.mjs']) }, cli: {
      archive: { path: cli, sha256: hashBytes(readFileSync(cli)) }, clientArchive: { path: client, sha256: hashBytes(readFileSync(client)) },
      version: '0.1.0', clientVersion: '0.1.0', files: inventory(cliFiles), clientFiles: inventory(clientFiles),
    } }));
    const runner = path.join(root, 'umask.ts');
    const module = path.resolve('scripts/agentfs-native-ci/mounted/module-admission.ts');
    writeFileSync(runner, `import {materializeCliRuntime,verifyCliRuntimeTree} from ${JSON.stringify(module)};\nimport {readFileSync,rmSync} from 'node:fs';\nprocess.umask(0o077);const input=JSON.parse(readFileSync(process.argv[2],'utf8'));const result=materializeCliRuntime(input);try{verifyCliRuntimeTree(result.directory,input.cli);if(process.umask()!==0o077)throw Error('global umask changed');console.log('verified');}finally{rmSync(result.directory,{recursive:true,force:true});}\n`);
    const result = spawnSync('bun', [runner, input], { encoding: 'utf8', timeout: 15_000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('verified');
  }));
  it('keeps the primary bootstrap error when private evidence recording fails', () => fixture(root => {
    mkdirSync(path.join(root, 'cli-bootstrap.stdout.raw'));
    const primary = new Error('bootstrap primary failure');
    try { writeBootstrapEvidence(root, 'cli-bootstrap', Buffer.alloc(0), Buffer.alloc(0), {}, primary); throw new Error('expected rejection'); }
    catch (error) { expect(error instanceof AggregateError).toBe(true); expect((error as AggregateError).errors[0]).toBe(primary); }
  }));
  it('exports only closed bootstrap identities and rejects injected private fields', () => {
    const receipt = { runtime: 'node', directory: '/tmp/xpod-afs-cli-runtime-abc123', binSHA256: '1'.repeat(64), coreSHA256: '2'.repeat(64),
      cliArchiveSHA256: '3'.repeat(64), clientArchiveSHA256: '4'.repeat(64), clientCoreSHA256: '7'.repeat(64), bootstrapStdoutSHA256: '5'.repeat(64), bootstrapStderrSHA256: '6'.repeat(64),
      bootstrapActualExit: 0, bootstrapSignal: null, bootstrapActualWait: true,
      scope: 'Exact validated tar dependency layout; not package-manager installation or registry publication' };
    expect(projectReceipt('cli-runtime.safe.json', receipt)).toEqual(receipt);
    const negative = { runtime: 'node', actualExit: 1, actualSignal: null, actualWait: true, coreSHA256: '1'.repeat(64),
      stdoutSHA256: '2'.repeat(64), stderrSHA256: '3'.repeat(64), category: 'missing_public_runtime_client' };
    expect(projectReceipt('cli-bare-bootstrap.safe.json', negative)).toEqual(negative);
    expect(() => projectReceipt('cli-bare-bootstrap.safe.json', { ...negative, stderr: 'private-marker' })).toThrow();
    expect(projectReceipt('cli-runtime-final.safe.json', { ...receipt, inventoryReverified: true })).toEqual({ ...receipt, inventoryReverified: true });
    expect(() => projectReceipt('cli-runtime-final.safe.json', { ...receipt, inventoryReverified: false })).toThrow();
    for (const addition of [{ credentials: 'private-marker' }, { stderr: 'private-marker' }, { coreSHA256: 'private-marker' }, { bootstrapActualWait: false }]) {
      expect(() => projectReceipt('cli-runtime.safe.json', { ...receipt, ...addition })).toThrow('invalid CLI bootstrap receipt');
    }
  });
  it('verifies the full installed dependency tree and rejects tampering and extra files', () => fixture(root => {
    const client = path.join(root, 'node_modules/@undefineds.co/xpod-client'); mkdirSync(client, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), 'cli'); writeFileSync(path.join(client, 'package.json'), 'client');
    const fact = (file: string) => ({ bytes: statSync(file).size, mode: statSync(file).mode & 0o777, sha256: hashBytes(readFileSync(file)) });
    const authority = { files: { 'package.json': fact(path.join(root, 'package.json')) }, clientFiles: { 'package.json': fact(path.join(client, 'package.json')) } } as any;
    verifyCliRuntimeTree(root, authority);
    writeFileSync(path.join(client, 'extra'), 'unexpected'); expect(() => verifyCliRuntimeTree(root, authority)).toThrow('inventory mismatch'); rmSync(path.join(client, 'extra'));
    writeFileSync(path.join(client, 'package.json'), 'tamper'); expect(() => verifyCliRuntimeTree(root, authority)).toThrow('inventory mismatch');
  }));
  it('binds runtime source claims to actual producer metadata and nested source bytes', () => {
    const sources = { 'workspace/xpod-client/package.json': { bytes: 2, sha256: hashBytes('{}') }, 'workspace/xpod-client/src/index.ts': { bytes: 3, sha256: hashBytes('abc') } };
    const inventory = { schemaVersion: 1, files: Object.entries(sources).map(([path, file]) => ({ path, ...file })) };
    const index = { schemaVersion: 1, runtimeClients: [], workspaceSources: [], producer: { name: '@undefineds.co/xpod-cli', version: '0.1.0-preview.2', bunVersion: '1.4.2' }, sourceInventory: 'source-inventory.json', clientSource: 'client-source.tar.gz', files: [] as any[], sourceAuthority: { sourceCommit: null, dirty: null, scope: 'copied producer', snapshotSHA256: hashBytes(JSON.stringify(inventory.files)) } };
    const bytes: Record<string, string> = { 'provenance/cli-producer-materials.json': JSON.stringify(index), 'provenance/cli-client-source-inventory.json': JSON.stringify(inventory), 'sources/cli-client-source.tar.gz': 'actual archive bytes' };
    index.files = [['source-inventory.json', 'provenance/cli-client-source-inventory.json'], ['client-source.tar.gz', 'sources/cli-client-source.tar.gz']].map(([path, actual]) => ({ path, bytes: bytes[actual].length, sha256: hashBytes(bytes[actual]) }));
    bytes['provenance/cli-producer-materials.json'] = JSON.stringify(index);
    const kit = { publicClientMaterials: { ...index, files: index.files.length, indexSHA256: hashBytes(bytes['provenance/cli-producer-materials.json']), sourceInventorySHA256: hashBytes(bytes['provenance/cli-client-source-inventory.json']), clientSourceSHA256: hashBytes(bytes['sources/cli-client-source.tar.gz']) } };
    const member = (name: string) => ({ sha256: hashBytes(bytes[name]), size: bytes[name].length });
    const document = (name: string) => JSON.parse(bytes[name]);
    expect(() => verifyModuleClientMaterials(kit, member, document, sources)).not.toThrow();
    expect(() => verifyModuleClientMaterials(kit, member, document, { ...sources, 'workspace/xpod-client/src/index.ts': { bytes: 3, sha256: hashBytes('bad') } })).toThrow('source inventory mismatch');
    expect(() => verifyModuleClientMaterials({ publicClientMaterials: { ...kit.publicClientMaterials, workspaceSources: [{ directory: 'wrong' }] } }, member, document, sources)).toThrow('producer binding mismatch');
    expect(() => verifyModuleClientMaterials(kit, member, document, {})).toThrow('source inventory mismatch');
    index.files[0].bytes += 1; bytes['provenance/cli-producer-materials.json'] = JSON.stringify(index);
    expect(() => verifyModuleClientMaterials({ publicClientMaterials: { ...kit.publicClientMaterials, indexSHA256: hashBytes(bytes['provenance/cli-producer-materials.json']) } }, member, document, sources)).toThrow('producer inventory mismatch');
  });
  it('selects the declared runtime client and rejects changed bytes, unsafe paths and ambiguous mappings', () => {
    const files = ['package.json', 'LICENSE', 'README.md', 'dist/library.cjs'].map(path => ({ path, bytes: 3, sha256: 'a'.repeat(64) }));
    const client = { name: '@undefineds.co/xpod-client', version: '0.1.0-preview.1', sourceDirectory: 'workspace/xpod-client', files };
    const mapping = { name: client.name, version: client.version, directory: client.sourceDirectory, role: 'declared-runtime-dependency' };
    const kit = { publicClientMaterials: { runtimeClients: [client], workspaceSources: [mapping] } };
    const member = (name: string) => { expect(name.startsWith('node_modules/@undefineds.co/xpod-client/')).toBe(true); return { size: 3, sha256: 'a'.repeat(64) }; };
    expect(moduleClientPath(kit, member)).toBe('node_modules/@undefineds.co/xpod-client/dist/library.cjs');
    expect(() => moduleClientPath(kit, member, [...files.map(file => 'node_modules/@undefineds.co/xpod-client/' + file.path), 'node_modules/@undefineds.co/xpod-client/dist/unlisted.js'])).toThrow('inventory incomplete');
    expect(() => moduleClientPath(kit, () => ({ size: 3, sha256: 'b'.repeat(64) }))).toThrow('inventory mismatch');
    expect(() => moduleClientPath({ publicClientMaterials: { runtimeClients: [client, client], workspaceSources: [mapping] } }, member)).toThrow('authority mismatch');
    expect(() => moduleClientPath({ publicClientMaterials: { runtimeClients: [{ ...client, files: [...files, { ...files[0], path: 'dist/../secret' }] }], workspaceSources: [mapping] } }, member)).toThrow('inventory mismatch');
    expect(() => moduleClientPath({ publicClientMaterials: {} }, () => { throw new Error('must not probe filesystem'); })).toThrow('authority mismatch');
  });

  it('retains actual failed producer observations while the original gate still throws and safe export excludes raw secrets', () => asyncFixture(async root => {
    const evidence = path.join(root, 'evidence'); mkdirSync(evidence);
    const run = path.join(evidence, 'private-run'); mkdirSync(run);
    const program = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
      const child=cp.spawn(process.execPath,['-e','process.stdout.write("private-secret");process.exit(1)'],{detached:true,stdio:['ignore','pipe','pipe']});
      const out=[],err=[];child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
      child.on('close',(status,signal)=>{const result={pid:child.pid,status,signal,stdout:Buffer.concat(out),stderr:Buffer.concat(err)};
      let absent=false;try{process.kill(-result.pid,0)}catch(e){absent=e.code==='ESRCH'}
      const directory=path.join(${JSON.stringify(run)},'.test-data/afs-installed-receipts','actual-failed');fs.mkdirSync(directory,{recursive:true});
      const stage='node-cli-install';const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
      const row={stage,pid:result.pid,actualExit:result.status,actualSignal:result.signal,actualWait:true,rawClosed:true,groupAbsent:absent,
        stdoutSHA256:hash(result.stdout),stderrSHA256:hash(result.stderr),credentials:{token:'private-secret'},argv:['private-secret']};
      for(const stream of ['stdout','stderr'])fs.writeFileSync(path.join(directory,stage+'.'+stream),result[stream]);
      fs.writeFileSync(path.join(directory,stage+'.safe.json'),JSON.stringify(row));process.stdout.write(JSON.stringify(row)+'\\n');process.exit(1);});`;
    const child = await new Promise<{ pid: number; status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const producer = spawn(process.execPath, ['-e', program], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      producer.stdout.on('data', (bytes: Buffer) => stdout.push(bytes)); producer.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
      producer.once('error', reject);
      producer.once('close', (status, signal) => resolve({ pid: producer.pid!, status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    });
    expect(child.status).toBe(1); expect(child.signal).toBeNull();
    let groupAbsent = false; try { process.kill(-child.pid, 0); } catch (error) { groupAbsent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    expect(groupAbsent).toBe(true);
    const gate = { state: 'closed', code: child.status, signal: child.signal, groupAbsent, nodeVersion: 'v22.21.1', bunVersion: '1.4.2', passed: 0, failed: 1, skipped: 0, sourceUnchanged: true };
    expect(() => assertInstalledConsumerProducer(gate)).toThrow('producer incomplete');
    const raw = Buffer.concat([child.stdout, child.stderr]);
    writeFileSync(path.join(evidence, 'installed-consumer.raw.log'), raw);
    const parent = { accepted: false, status: 'failed', producerClosed: true, code: child.status, signal: child.signal, groupAbsent, rawClosedBeforeHash: true, credentials: { token: 'private-secret' } };
    persistInstalledConsumerReceipt(evidence, run, parent, raw);
    const diagnostic = JSON.parse(readFileSync(path.join(evidence, 'installed-consumer-failure.safe.json'), 'utf8'));
    expect(diagnostic.accepted).toBe(false); expect(diagnostic.diagnosticOnly).toBe(true);
    expect(diagnostic.category).toBe('observed-stage-nonexpected-exit'); expect(diagnostic.lastObservedStage).toBe('node-cli-install');
    expect(diagnostic.observedStages).toHaveLength(1); expect(diagnostic.observedStages[0].rawHashesBound).toBe(true);
    expect(() => verifyInstalledConsumerReceipts(path.join(run, '.test-data/afs-installed-receipts/actual-failed'))).toThrow('receipt inventory');
    const output = path.join(root, 'safe'); exportSafe(evidence, output);
    expect(readdirSync(output).sort()).toEqual(['export.safe.json', 'installed-consumer-failure.safe.json', 'installed-consumer.safe.json']);
    const exported = readFileSync(path.join(output, 'installed-consumer-failure.safe.json'), 'utf8');
    expect(exported).not.toContain('private-secret'); expect(exported).not.toContain('credentials'); expect(exported).not.toContain(run);
    const failedEvidence = path.join(root, 'diagnostic-write-failed'); mkdirSync(failedEvidence);
    writeFileSync(path.join(failedEvidence, 'installed-consumer-failure.safe.json'), 'existing-diagnostic');
    expect(() => persistInstalledConsumerReceipt(failedEvidence, run, parent, raw)).not.toThrow();
    expect(JSON.parse(readFileSync(path.join(failedEvidence, 'installed-consumer.safe.json'), 'utf8')).accepted).toBe(false);
    expect(readFileSync(path.join(failedEvidence, 'installed-consumer-failure.safe.json'), 'utf8')).toBe('existing-diagnostic');
    expect(() => assertInstalledConsumerProducer(gate)).toThrow('producer incomplete');
    const directory = path.join(run, '.test-data/afs-installed-receipts/actual-failed');
    const receiptPath = path.join(directory, 'node-cli-install.safe.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); receipt.groupAbsent = false;
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const unresolved = path.join(root, 'group-unresolved'); mkdirSync(unresolved);
    recordInstalledConsumerFailure(unresolved, run, parent, Buffer.from('Error: Owned consumer timeout\n'));
    const groupDiagnostic = JSON.parse(readFileSync(path.join(unresolved, 'installed-consumer-failure.safe.json'), 'utf8'));
    expect(groupDiagnostic.category).toBe('stage-group-not-absent'); expect(groupDiagnostic.observedStages[0].stdoutSHA256).toBeNull();
    receipt.groupAbsent = true; writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(path.join(directory, 'node-cli-install.stdout'), 'tampered-raw');
    const invalid = path.join(root, 'invalid-hash'); mkdirSync(invalid);
    recordInstalledConsumerFailure(invalid, run, parent, raw);
    const invalidDiagnostic = JSON.parse(readFileSync(path.join(invalid, 'installed-consumer-failure.safe.json'), 'utf8'));
    expect(invalidDiagnostic.category).toBe('invalid-stage-receipt'); expect(invalidDiagnostic.observedStages).toEqual([]);
  }));
  for (const state of ['unclosed', 'group-unknown', 'raw-open']) {
    it(`never hashes incomplete ${state} producer output`, () => fixture(root => {
      const evidence = path.join(root, 'evidence'); mkdirSync(evidence);
      recordInstalledConsumerFailure(evidence, root, { producerClosed: state !== 'unclosed', groupAbsent: state !== 'group-unknown', rawClosedBeforeHash: state !== 'raw-open', code: null, signal: null }, Buffer.from('Error: Owned consumer timeout\nprivate-secret'));
      const diagnostic = JSON.parse(readFileSync(path.join(evidence, 'installed-consumer-failure.safe.json'), 'utf8'));
      expect(diagnostic.parentRawSHA256).toBeNull(); expect(diagnostic.lastObservedStage).toBeNull(); expect(diagnostic.observedStages).toEqual([]);
      expect(diagnostic.category).not.toBe('consumer-timeout-observed'); expect(diagnostic.accepted).toBe(false);
    }));
  }
  it('rejects free-text diagnostic categories or stage names', () => {
    for (const row of [ { diagnosticOnly: true, accepted: false, category: 'private-secret' },
      { diagnosticOnly: true, accepted: false, category: 'test-failed-cause-unknown', receiptInventoryState: 'observed', lastObservedStage: 'private-secret', observedStages: [] } ]) {
      expect(() => projectReceipt('installed-consumer-failure.safe.json', row)).toThrow('invalid installed failure');
    }
  });
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
    expect(readdirSync(path.join(root, 'export')).sort()).toEqual(['export.safe.json', 'recovery-diagnostic.safe.json']);
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
  it('requires all 21 closed actual consumer stages and proxy cleanup, verifies raw hashes, and projects only fixed fields', () => fixture(root => {
    for (const stage of INSTALLED_CONSUMER_STAGES) {
      for (const stream of ['stdout', 'stderr']) writeFileSync(path.join(root, `${stage}.${stream}`), 'private-marker');
      writeFileSync(path.join(root, stage + '.safe.json'), JSON.stringify({ stage, pid: 123, actualExit: stage === 'node-startup-cancel' ? 143 : stage.endsWith('-cli-tampered-list') ? 1 : 0, actualSignal: null,
        actualWait: true, rawClosed: true, groupAbsent: true, observation: { timeoutMs: installedConsumerWatchdogMs(stage), elapsedMs: 1, timeoutObserved: false, closeObserved: true, groupClosed: true }, stdoutSHA256: hashBytes('private-marker'), stderrSHA256: hashBytes('private-marker'), unknown: { credentials: 'private-marker' } }));
    }
    const proxy = path.join(root, 'proxy-cancel.safe.json'); writeFileSync(proxy, JSON.stringify({ pid: 321, groupAbsent: true, tokenFixtureObserved: true, nativeMountStarted: false, clientSecret: 'private-marker' }));
    const install = 'node-cli-install'; const stderr = JSON.stringify({ kind: 'module-install-phase', phase: 'archive-extract', state: 'started', elapsedMs: 1 }) + '\n'
      + JSON.stringify({ kind: 'module-install-phase', phase: 'archive-extract', state: 'completed', elapsedMs: 2, durationMs: 1 }) + '\n';
    writeFileSync(path.join(root, install + '.stderr'), stderr);
    const installReceipt = path.join(root, install + '.safe.json'); writeFileSync(installReceipt, JSON.stringify({ ...JSON.parse(readFileSync(installReceipt, 'utf8')), stderrSHA256: hashBytes(stderr) }));
    const facts = verifyInstalledConsumerReceipts(root); expect(facts.stages).toHaveLength(21); expect(JSON.stringify(facts)).not.toContain('private-marker');
    expect((facts.stages.find((row: any) => row.stage === install) as any).installPhases).toEqual(stderr.trim().split('\n').map(line => JSON.parse(line)));
    for (const [stage, timeoutMs] of [['node-cli-before-list', 15_000], ['bun-cli-installed-list', 10_001], ['node-cli-install', 15_001], ['bun-cli-install', 15_001]] as const) {
      const file = path.join(root, stage + '.safe.json'); const original = readFileSync(file, 'utf8'); const changed = JSON.parse(original);
      changed.observation.timeoutMs = timeoutMs; writeFileSync(file, JSON.stringify(changed));
      expect(() => verifyInstalledConsumerReceipts(root)).toThrow('stage incomplete');
      expect(() => projectReceipt('installed-consumer.safe.json', { stages: [changed] })).toThrow('invalid installed phase diagnostic');
      writeFileSync(file, original);
    }
    const negative = path.join(root, 'node-cli-tampered-list.safe.json');
    const rejected = readFileSync(negative, 'utf8');
    writeFileSync(negative, JSON.stringify({ ...JSON.parse(rejected), actualExit: 0 }));
    expect(() => verifyInstalledConsumerReceipts(root)).toThrow('stage incomplete');
    writeFileSync(negative, rejected);
    const legacy = path.join(root, 'node-cli-module-list.safe.json'); writeFileSync(legacy, rejected);
    expect(() => verifyInstalledConsumerReceipts(root)).toThrow('receipt inventory'); rmSync(legacy);
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
    const closeStart = workflow.indexOf('      - name: Close owned image');
    const close = workflow.slice(closeStart, workflow.indexOf('      - uses: actions/upload-artifact', closeStart));
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

describe('owned installed consumer diagnostics', () => {
  function traceFailure(root: string, text: string, tamper = false) {
    const run = path.join(root, 'run'); const directory = path.join(run, '.test-data/afs-installed-receipts/case'); mkdirSync(directory, { recursive: true });
    const stage = 'node-cli-install'; writeFileSync(path.join(directory, stage + '.stdout'), ''); writeFileSync(path.join(directory, stage + '.stderr'), tamper ? 'changed' : text);
    const row = { stage, pid: 123, actualExit: null, actualSignal: 'SIGTERM', actualWait: true, rawClosed: true, groupAbsent: true,
      observation: { timeoutMs: 10000, elapsedMs: 10001, timeoutObserved: true, closeObserved: true, groupClosed: true },
      stdoutSHA256: hashBytes(''), stderrSHA256: hashBytes(text) };
    writeFileSync(path.join(directory, stage + '.safe.json'), JSON.stringify(row));
    const evidence = path.join(root, 'evidence'); mkdirSync(evidence);
    recordInstalledConsumerFailure(evidence, run, { producerClosed: true, groupAbsent: true, rawClosedBeforeHash: true, code: 1, signal: null }, Buffer.from(JSON.stringify(row)));
    return JSON.parse(readFileSync(path.join(evidence, 'installed-consumer-failure.safe.json'), 'utf8'));
  }
  it('retains only bounded chronological phase prefixes and rejects free fields, unknown phases and invalid timings', () => {
    const start = { kind: 'module-install-phase', phase: 'archive-extract', state: 'started', elapsedMs: 1 };
    for (const invalid of [{ ...start, token: 'private-secret' }, { ...start, phase: 'private-secret' },
      { ...start, elapsedMs: -1 }, { ...start, elapsedMs: 'private-secret' },
      { ...start, state: 'completed', durationMs: 2 }, { ...start, durationMs: 0 }]) fixture(root => {
      const diagnostic = traceFailure(root, JSON.stringify(invalid) + '\n');
      expect(diagnostic.observedStages[0].summary.stderr.installPhases).toEqual([]);
      expect(diagnostic.observedStages[0].summary.stderr.installPhasesTruncated).toBe(true);
      expect(JSON.stringify(diagnostic)).not.toContain('private-secret');
    });
    fixture(root => {
      const lines = Array.from({ length: 80 }, (_, index) => ({ ...start, state: index % 2 ? 'completed' : 'started', elapsedMs: index,
        ...(index % 2 ? { durationMs: 1 } : {}) }));
      const diagnostic = traceFailure(root, lines.map(row => JSON.stringify(row)).join('\n'));
      expect(diagnostic.observedStages[0].summary.stderr.installPhases).toEqual(lines.slice(0, 64));
      expect(diagnostic.observedStages[0].summary.stderr.installPhasesTruncated).toBe(true);
    });
    fixture(root => {
      const diagnostic = traceFailure(root, JSON.stringify(start) + '\n', true);
      expect(diagnostic.receiptInventoryState).toBe('invalid'); expect(diagnostic.observedStages).toEqual([]);
    });
    const stage = { stage: 'node-cli-install', actualWait: true, rawClosed: true, groupAbsent: true,
      stdoutSHA256: 'a'.repeat(64), stderrSHA256: 'b'.repeat(64), installPhases: [start], installPhasesTruncated: false };
    const parent = { producerClosed: true, groupAbsent: true, rawClosedBeforeHash: true, stages: [stage] };
    expect(() => projectReceipt('installed-consumer.safe.json', parent)).not.toThrow();
    for (const bad of [{ ...stage, installPhases: [{ ...start, phase: 'private-secret' }] }, { ...stage, rawClosed: false }, { ...stage, stage: 'node-cli-before-list' }]) {
      expect(() => projectReceipt('installed-consumer.safe.json', { ...parent, stages: [bad] })).toThrow('invalid installed phase diagnostic');
    }
  });
  for (const mode of ['failure', 'timeout']) {
    it(`preserves actual ${mode} lifecycle and exports only closed hash-bound summaries`, () => asyncFixture(async root => {
      const { runOwnedInstalledConsumer } = await import('../../scripts/agentfs-native-ci/mounted/owned-installed-consumer');
      const phases = [{ kind: 'module-install-phase', phase: 'archive-scan', state: 'started', elapsedMs: 0 },
        { kind: 'module-install-phase', phase: 'archive-scan', state: 'completed', elapsedMs: 1, durationMs: 1 },
        { kind: 'module-install-phase', phase: 'archive-extract', state: 'started', elapsedMs: 2 }];
      const script = mode === 'timeout' ? `process.stderr.write(${JSON.stringify(phases.map(row => JSON.stringify(row)).join('\n') + '\n')});setInterval(()=>{},1000)` : `process.stdout.write(JSON.stringify({ok:false,code:'module_install_failed',token:'private-secret'},null,2)+'\\n');process.stderr.write('(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\\nnpm error code ENOSPC\\nhttps://private-secret/key\\n'+'x'.repeat(70000));process.exitCode=7;`;
      const timeoutMs = mode === 'timeout' ? 50 : 1000;
      const result = await runOwnedInstalledConsumer(process.execPath, ['-e', script], process.env, root, timeoutMs);
      expect(result.observation.timeoutMs).toBe(timeoutMs);
      expect(result.observation.timeoutObserved).toBe(mode === 'timeout');
      expect(result.observation.closeObserved).toBe(true); expect(result.observation.groupClosed).toBe(true);
      expect(result.observation.elapsedMs).toBeGreaterThanOrEqual(mode === 'timeout' ? timeoutMs : 0);
      if (mode === 'timeout') { expect(result.error?.message).toBe('Owned consumer timeout'); expect(result.signal).toBe('SIGTERM'); }
      else { expect(result.status).toBe(7); expect(result.error).toBeUndefined(); }
      const evidence = path.join(root, 'evidence'); mkdirSync(evidence);
      const run = path.join(evidence, 'private-run'); mkdirSync(run);
      const directory = path.join(run, '.test-data/afs-installed-receipts/case'); mkdirSync(directory, { recursive: true });
      const stage = 'node-cli-install';
      const row = { stage, pid: result.pid, actualExit: result.status, actualSignal: result.signal, actualWait: true, rawClosed: true, groupAbsent: true,
        observation: result.observation, stdoutSHA256: hashBytes(result.stdout), stderrSHA256: hashBytes(result.stderr) };
      for (const stream of ['stdout', 'stderr'] as const) writeFileSync(path.join(directory, stage + '.' + stream), result[stream]);
      writeFileSync(path.join(directory, stage + '.safe.json'), JSON.stringify(row));
      const raw = Buffer.from(JSON.stringify(row) + '\n');
      const parent = { accepted: false, status: 'failed', producerClosed: true, code: 1, signal: null, groupAbsent: true, rawClosedBeforeHash: true,
        sourceHelperSHA256: hashBytes(readFileSync('scripts/agentfs-native-ci/mounted/owned-installed-consumer.ts')) };
      persistInstalledConsumerReceipt(evidence, run, parent, raw);
      const diagnostic = JSON.parse(readFileSync(path.join(evidence, 'installed-consumer-failure.safe.json'), 'utf8'));
      const observed = diagnostic.observedStages[0];
      expect(observed.observation).toEqual(result.observation);
      expect(observed.rawHashesBound).toBe(true); expect(observed.stderrSHA256).toBe(row.stderrSHA256);
      if (mode === 'failure') {
        expect(observed.summary.stdout.codes).toEqual(['cli-error', 'module_install_failed']);
        expect(observed.summary.stderr.codes).toEqual(['sqlite-experimental-warning', 'ENOSPC']);
        expect(observed.summary.stderr.truncated).toBe(true); expect(observed.summary.stderr.bytes).toBe(result.stderr.length);
      } else {
        expect(observed.summary.stderr.installPhases).toEqual(phases);
        expect(observed.summary.stderr.installPhasesTruncated).toBe(false);
        expect(observed.actualSignal).toBe('SIGTERM'); expect(observed.observation.timeoutObserved).toBe(true);
      }
      const out = path.join(root, 'export'); exportSafe(evidence, out);
      const exported = readFileSync(path.join(out, 'installed-consumer-failure.safe.json'), 'utf8');
      expect(exported).not.toContain('private-secret'); expect(exported).not.toContain('https://'); expect(exported).not.toContain(root);
      expect(JSON.parse(exported).observedStages[0]).toEqual(observed);
      expect(JSON.parse(readFileSync(path.join(out, 'installed-consumer.safe.json'), 'utf8')).sourceHelperSHA256).toBe(parent.sourceHelperSHA256);
      const unknown = path.join(root, 'unknown'); mkdirSync(unknown); row.observation.groupClosed = false;
      writeFileSync(path.join(directory, stage + '.safe.json'), JSON.stringify(row));
      recordInstalledConsumerFailure(unknown, run, parent, raw);
      const unresolved = JSON.parse(readFileSync(path.join(unknown, 'installed-consumer-failure.safe.json'), 'utf8')).observedStages[0];
      expect(unresolved.summary).toBeNull(); expect(unresolved.stdoutSHA256).toBeNull(); expect(unresolved.stderrSHA256).toBeNull();
      expect(() => assertInstalledConsumerProducer({ state: 'closed', code: 1, signal: null, groupAbsent: true, nodeVersion: 'v22.21.1', bunVersion: '1.4.2', passed: 0, failed: 1, skipped: 0, sourceUnchanged: true })).toThrow('producer incomplete');
    }));
  }
  it('keeps phase budgets and helper source in the producer identity', () => {
    const testSource = readFileSync('packages/xpod-afs/tests/installed-module.test.ts', 'utf8');
    expect(testSource).toContain('runOwnedInstalledConsumer(runtime, args, env, root, installedConsumerWatchdogMs(stage), stage)');
    expect(testSource).toContain('}, 60_000)');
    expect(testSource).toContain('`${label}-cli-${phaseLabel}`');
    expect(testSource.match(/artifactTest\.skipIf/g)).toHaveLength(1);
    expect(testSource.match(/import \{ runOwnedInstalledConsumer/g)).toHaveLength(1);
    const producer = readFileSync('scripts/agentfs-native-ci/mounted/prepare-module-inputs.ts', 'utf8');
    expect(producer).toContain('hashFile(sourceHelper) === sourceHelperSHA256');
    expect(producer).toContain('sourceTestSHA256, sourceHelperSHA256, lifecycle:');
    expect(producer).toContain('lifecycle.wait(180_000)');
  });
  it('admits only full archive install at 15s and rejects other over-budget commands before spawning', () => asyncFixture(async root => {
    for (const stage of INSTALLED_CONSUMER_STAGES) expect(installedConsumerWatchdogMs(stage)).toBe(
      stage === 'node-cli-install' || stage === 'bun-cli-install' ? 15_000 : 10_000);
    const marker = path.join(root, 'unexpected-child');
    const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`];
    for (const [stage, timeout] of [['node-cli-before-list', 10_001], ['bun-cli-install', 15_001], ['command', 15_000]] as const) {
      await expect(runOwnedInstalledConsumer(process.execPath, args, process.env, root, timeout, stage)).rejects.toThrow('Invalid owned consumer watchdog');
    }
    expect(existsSync(marker)).toBe(false);
    const normal = await runOwnedInstalledConsumer(process.execPath, ['-e', 'process.exit(0)'], process.env, root, 15_000, 'node-cli-install');
    expect(normal.status).toBe(0); expect(normal.error).toBeUndefined();
    expect(normal.observation).toMatchObject({ timeoutMs: 15_000, timeoutObserved: false, closeObserved: true, groupClosed: true });
    const stuck = await runOwnedInstalledConsumer(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.env, root, 50, 'bun-cli-install');
    expect(stuck.error?.message).toBe('Owned consumer timeout'); expect(stuck.signal).toBe('SIGTERM');
    expect(stuck.observation).toMatchObject({ timeoutMs: 50, timeoutObserved: true, closeObserved: true, groupClosed: true });
  }));
  it('does not classify EPERM group observation as closure', () => asyncFixture(async root => {
    const { runOwnedInstalledConsumer } = await import('../../scripts/agentfs-native-ci/mounted/owned-installed-consumer');
    const original = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) throw Object.assign(new Error('private-secret'), { code: 'EPERM' });
      return original(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    try {
      const result = await runOwnedInstalledConsumer(process.execPath, ['-e', 'process.exit(7)'], process.env, root, 1000);
      expect(result.status).toBe(7); expect(result.observation.closeObserved).toBe(true);
      expect(result.observation.groupClosed).toBe(false); expect(result.error?.message).toBe('Owned group absence unconfirmed');
    } finally { kill.mockRestore(); }
  }));

});
