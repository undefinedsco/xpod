/** Producer -> consumer seam for ordinary local-runtime evidence.
 *
 * This test executes the REAL collector orchestration
 * (scripts/collect-normal-local-runtime-originals.py::collect) through the REAL
 * shared host helpers (qlever/scripts/sdk-service-native-runtime-host.py), the
 * REAL supervisor, the REAL bounded-copy helper and the REAL generic command
 * child. Docker is replaced by a controlled fixture on PATH; the runtime behind
 * `docker run` is a real async child that enforces the serial query protocol.
 * Its master and original bytes are then fed to the REAL TS inspector. Nothing
 * here mints a capability or hand-writes the master.
 */
import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import {
  NORMAL_RUNTIME_KIND,
  NORMAL_RUNTIME_MODEL,
  inspectNormalLocalRuntimeMaster,
} from '../../scripts/lib/independent-admission/candidate-service-native-runtime-originals';
import normalSmokeCases from '../../scripts/lib/normal-local-runtime-smoke-cases.json';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const repoRoot = path.resolve(__dirname, '../..');
const collector = path.join(repoRoot, 'scripts/collect-normal-local-runtime-originals.py');
const SDK_IMAGE = 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + 'd'.repeat(64);
const RUNTIME_IMAGE = 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + 'e'.repeat(64);
const CONFIG_DIGEST = 'sha256:' + 'f'.repeat(64);
const SMOKE_CASES_FILE = path.join(repoRoot, 'scripts/lib/normal-local-runtime-smoke-cases.json');

const DOCKER_FIXTURE = String.raw`#!/usr/bin/env python3
import io,json,os,select,sys,tarfile
MODE=os.environ.get('FAKE_RUNTIME_MODE','pass')
CONFIG=os.environ.get('FAKE_CONFIG_DIGEST','sha256:${'f'.repeat(64)}')
def out(text): sys.stdout.write(text)
def run_runtime(argv):
    mount=next((a for a in argv if a.startswith('type=bind,src=')),'')
    bind=mount.split('src=',1)[1].split(',',1)[0] if mount else '/nonexistent'
    fd=0; buf=b''
    def send(row):
        sys.stdout.write(json.dumps(row,separators=(',',':'))+'\n'); sys.stdout.flush()
    def line():
        nonlocal buf
        while b'\n' not in buf:
            ready,_,_=select.select([fd],[],[],10)
            if not ready: return None
            block=os.read(fd,65536)
            if not block: return None
            buf+=block
        raw,_,buf=buf.partition(b'\n')
        return raw
    cases={row['request']['id']:row for row in json.load(open(os.environ['FAKE_SMOKE_CASES']))}
    def payload(qid):
        # The ONE shared case file is the golden data; the body is a real SPARQL
        # results envelope, not a needle string that happens to contain text.
        bindings=cases[qid]['bindings']
        if MODE=='empty-bindings':
            bindings=[]
        elif MODE=='wrong-graph' and qid=='default-named-graph':
            bindings=[{'s':{'type':'uri','value':'urn:xpod:smoke:s:document'},
                       'o':{'type':'literal','value':'document'},
                       'g':{'type':'uri','value':'urn:xpod:smoke:g:allowed'}}]
        body=json.dumps({'head':{'vars':sorted({key for row in bindings for key in row})},
                         'results':{'bindings':bindings},
                         'profile':'alpha card urn:xpod:smoke:g:allowed'})
        return body
    send({'type':'ready','abiVersion':1,'adapterAbiVersion':1,'physicalBackendAbiVersion':1,'backend':'sqlite'})
    while True:
        raw=line()
        if raw is None: return 0
        message=json.loads(raw)
        if message.get('type')=='shutdown': return 0
        # The REAL runtime cancels pending work on shutdown/EOF. Detect the old
        # burst bug: another request already queued before this one replied.
        if select.select([fd],[],[],0)[0]:
            send({'type':'error','id':message.get('id',''),'code':'qlever_request_aborted','message':'runtime is shutting down'})
            return 3
        if MODE=='fail-vector' and message.get('id')=='vector':
            send({'type':'error','id':'vector','code':'qlever_request_aborted','message':'runtime is shutting down'})
            return 3
        if not os.path.isdir(bind) or not os.path.isfile(os.path.join(bind,'runtime-smoke.sqlite')):
            send({'type':'error','id':message.get('id',''),'code':'mount_missing','message':'owned database mount missing'})
            return 4
        send({'id':message.get('id'),'type':'result','result':{'status':'ok','body':payload(message.get('id'))}})
def main():
    argv=sys.argv[1:]
    if not argv: return 64
    cmd=argv[0]
    if cmd=='pull': out('pulled\n'); return 0
    if cmd=='image' and len(argv)>=2 and argv[1]=='inspect': out(CONFIG+'\n'); return 0
    if cmd=='create': out('c'*64+'\n'); return 0
    if cmd=='rm':
        log=os.environ.get('FAKE_DOCKER_LOG')
        if log:
            name=next((a for a in reversed(argv) if a and not a.startswith('-')), '')
            with open(log,'a') as handle: handle.write('rm '+name+'\n')
        out('removed\n'); return 0
    if cmd=='cp':
        relative=argv[1].split(':',1)[1]
        prefix=relative.rstrip('/').split('/')[-1]
        raw=io.BytesIO()
        with tarfile.open(fileobj=raw,mode='w') as tar:
            for name,body,mode in [('bin/xpod_qlever_local_runtime',b'ELF-runtime',0o755),('manifest.json',b'{"schemaVersion":1}',0o644)]:
                info=tarfile.TarInfo(prefix+'/'+name); info.size=len(body); info.mode=mode; tar.addfile(info,io.BytesIO(body))
        sys.stdout.buffer.write(raw.getvalue()); sys.stdout.buffer.flush(); return 0
    if cmd=='run':
        log=os.environ.get('FAKE_DOCKER_LOG')
        if log:
            at=argv.index('--name') if '--name' in argv else None
            with open(log,'a') as handle: handle.write('run '+(argv[at+1] if at is not None else '')+'\n')
        return run_runtime(argv)
    if cmd=='version': out('fixture\n'); return 0
    return 65
sys.exit(main())
`;

const RUNNER = String.raw`import importlib.util,json,os,sys,time
from pathlib import Path
collector=Path(os.environ['SEAM_COLLECTOR'])
spec=importlib.util.spec_from_file_location('seam_collector',collector)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
real_load=m._load
CALLS=[]
def load(path,name,attribute):
    module=real_load(path,name,attribute)
    if Path(path)==m.HOST:
        module.EVIDENCE_ROOT=Path(os.environ['SEAM_EVIDENCE'])
        real=module.load_supervise()
        class Shim:
            # The fixture lowers ONLY the free-disk admission bound used by the
            # real supervisor; every argument (including the 4-argument
            # name/command/evidence/cwd stage call) still reaches the real
            # run_stage unchanged.
            def run_stage(self,*args,**kwargs):
                kwargs.setdefault('fresh_bytes',64*1024*1024)
                kwargs.setdefault('stop_bytes',32*1024*1024)
                kwargs.setdefault('poll_seconds',0.05)
                CALLS.append([args[0],len(args)])
                return real.run_stage(*args,**kwargs)
        module.load_supervise=lambda:Shim()
    return module
m._load=load
argv=['--source-sha',os.environ['SEAM_SHA'],'--sdk-image',os.environ['SEAM_SDK_IMAGE'],
      '--runtime-image',os.environ['SEAM_RUNTIME_IMAGE'],'--sdk-input-hash','a'*64,
      '--target',os.environ.get('SEAM_TARGET','linux-x64'),
      '--run-id','7','--run-attempt','2','--job','publish','--out',os.environ['SEAM_OUT'],
      '--deadline-monotonic',str(time.monotonic()+300),'--maximum-bytes','134217728']
value=m.parse_args(argv)
result=m.collect(value)
print(json.dumps({'result':result,'stageCalls':CALLS},sort_keys=True))
`;

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
  if (run.status !== 0) throw Error(`git failed: ${run.stdout}\n${run.stderr}`);
  return run.stdout;
}

function writeExecutable(file: string, body: string) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function cleanup(root: string) {
  if (process.env.SEAM_KEEP === '1') return;
  rmSync(root, {recursive: true, force: true});
}

function fileRef(files: Map<string, Buffer>, name: string) {
  const body = files.get(name);
  if (!body) throw Error('missing fixture member ' + name);
  return {path: name, bytes: body.length, sha256: sha(body)};
}

/** Build the TS-side context strictly from the producer's retained bytes plus
 * fixture source/SDK/issue handles (the same private shapes the real consumer
 * receives from its collectors). */
function context(outDir: string, tracked: string[], options: {sdkTarget?: string} = {}) {
  const files = new Map<string, Buffer>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const where = path.join(directory, entry);
      if (statSync(where).isDirectory()) walk(where);
      else files.set(path.relative(outDir, where).split(path.sep).join('/'), readFileSync(where));
    }
  };
  walk(outDir);
  const master = JSON.parse(files.get('materials.json')!.toString());
  const memberRefs = new Map([...files.keys()].map(name => [name, fileRef(files, name)]));
  const sdkMaster = {
    schemaVersion: 1, kind: 'qlever-linux-sdk-originals', buildExecutionModel: 'normal-build-v1',
    identity: {sourceSha: '9'.repeat(40), runId: 99, runAttempt: 1,
      sdkProfile: 'service-trixie', target: options.sdkTarget ?? master.identity.target},
    image: {referenceByDigest: master.identity.sdkImage},
    normalBuild: {inputHash: master.identity.sdkInputHash},
  };
  const sdkBytes = Buffer.from(JSON.stringify(sdkMaster));
  const jobBytes = Buffer.from(JSON.stringify({jobs: [{id: 4711,
    name: 'publish_qlever_local_runtime / publish', conclusion: 'success'}]}));
  const view = {
    read(value: any, maximum = 4 * 1024 ** 2) {
      const body = files.get(value?.path);
      if (!body || body.length !== value.bytes || sha(body) !== value.sha256) throw Error('fixture ref differs');
      if (body.length > maximum) throw Error('fixture ref too big');
      return body;
    },
    reference(value: any) {
      const body = files.get(value?.path);
      if (!body || body.length !== value.bytes || sha(body) !== value.sha256) throw Error('fixture ref differs');
      return {path: value.path, bytes: value.bytes, sha256: value.sha256};
    },
    members: memberRefs as Map<string, any>,
    native: {
      originFacts: {sourceSha: master.identity.sourceSha, runId: 7, runAttempt: 2,
        target: master.identity.target, producerJobId: 4711,
        originals: [{name: 'jobs.original.json', bytes: jobBytes.length, sha256: sha(jobBytes)}]},
      metadataOriginals: [{name: 'jobs.original.json', data: jobBytes}],
      readOriginal: () => files.get('materials.json')!,
    },
    source: {
      sourceSha: master.identity.sourceSha,
      trackedPaths: tracked,
      readTracked: (name: string) => readFileSync(path.join(repoRoot, name)),
    },
    sdk: {
      masterReference: {path: 'materials.json', bytes: sdkBytes.length, sha256: sha(sdkBytes)},
      originFacts: {sourceSha: '9'.repeat(40), runId: 99, runAttempt: 1, artifactId: 5},
      readOriginal: () => sdkBytes,
    },
    admission: {verified: true, facts: {sdkBuildExecutionModel: 'normal-build-v1',
      sdkNormalBuildAdmissionVerified: true}},
    current() {},
  };
  return {files, master, memberRefs, view, masterRef: fileRef(files, 'materials.json')};
}

/** Build the isolated fixture repo + fake docker/runtime and run the real
 * producer once. Returns the owned output directory and repo path. */
function produce(root: string, mode = 'pass', target = 'linux-x64') {
  // The Git source is the REAL checkout: the producer hashes its tracked files
  // and the consumer re-hashes the same bytes. Only Docker is a fixture.
  const sourceSha = git(repoRoot, 'rev-parse', 'HEAD').trim();
  const trackedFiles = git(repoRoot, 'ls-files', '-z', '--', 'LICENSE', 'qlever/cmake',
    'qlever/include', 'qlever/qlever.lock.json', 'qlever/patches', 'qlever/qlever_adapter',
    'qlever/qlever_local_runtime', 'qlever/rdf_protocol', 'qlever/rdf_sqlite_backend',
    'qlever/scripts', 'docker/qlever-local-runtime/Dockerfile')
    .split('\0').filter(Boolean);

  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeExecutable(path.join(bin, 'docker'), DOCKER_FIXTURE);
  const runner = path.join(root, 'runner.py');
  writeFileSync(runner, RUNNER);
  const out = path.join(root, 'out-' + mode);
  const evidence = path.join(root, 'evidence-' + mode);
  mkdirSync(evidence);
  const run = spawnSync('python3', [runner], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SEAM_COLLECTOR: collector,
      SEAM_REPO: repoRoot,
      SEAM_SHA: sourceSha,
      SEAM_SDK_IMAGE: SDK_IMAGE,
      SEAM_RUNTIME_IMAGE: RUNTIME_IMAGE,
      SEAM_OUT: out,
      SEAM_EVIDENCE: evidence,
      SEAM_TARGET: target,
      FAKE_RUNTIME_MODE: mode,
      FAKE_CONFIG_DIGEST: CONFIG_DIGEST,
      FAKE_SMOKE_CASES: path.join(repoRoot, 'scripts/lib/normal-local-runtime-smoke-cases.json'),
      FAKE_DOCKER_LOG: path.join(root, 'docker.log'),
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  return {trackedFiles, out, sourceSha, run, bin};
}

test('real producer orchestration feeds the real inspector and binds the async runtime', () => {
  const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-seam-'));
  try {
    const produced = produce(root);
    if (produced.run.status !== 0) throw Error(produced.run.stderr);
    const emitted = JSON.parse(produced.run.stdout.trim().split('\n').at(-1)!);
    const result = emitted.result;
    expect(result.proofModel).toBe(NORMAL_RUNTIME_MODEL);
    // Every stage used the shared host signature (name, command, evidence, cwd).
    // A 3-argument host shim would have raised TypeError inside collect.
    expect(emitted.stageCalls.length).toBeGreaterThan(5);
    expect(emitted.stageCalls.every((row: any[]) => row[1] === 4)).toBe(true);
    expect(result.runtimeImage).toBe(RUNTIME_IMAGE);
    expect(result.runtimeConfigDigest).toBe(CONFIG_DIGEST);

    const ctx = context(produced.out, produced.trackedFiles);
    // The producer's own master bytes are the input; nothing is rebuilt here.
    expect(ctx.master.kind).toBe(NORMAL_RUNTIME_KIND);
    expect(ctx.master.proofModel).toBe(NORMAL_RUNTIME_MODEL);
    expect(ctx.master.runtimeImage).toBe(RUNTIME_IMAGE);
    expect(ctx.master.runtimeConfigDigest).toBe(CONFIG_DIGEST);

    const receipt = JSON.parse(ctx.files.get('smoke/child/command.receipt.json')!.toString());
    // The genuine driver argv, issued by the shared command child.
    expect(receipt.command).toHaveLength(5);
    expect(receipt.command.slice(0, 4)).toEqual(['python3', '-B', collector, '--smoke-session']);
    expect(JSON.parse(receipt.command[4])).toEqual(ctx.master.smoke && JSON.parse(
      ctx.files.get('functional-smoke.json')!.toString()).command);

    const inspected = inspectNormalLocalRuntimeMaster(ctx.masterRef, ctx.master, ctx.view as any);
    expect(inspected.observation.proofModel).toBe(NORMAL_RUNTIME_MODEL);
    expect(inspected.observation.pending).toEqual([]);
    const bindings = inspected.view.inputBindingsForMember('bin/xpod_qlever_local_runtime');
    expect(bindings.some(row => row.path === '/workspace/xpod/qlever/include/XpodNumericLiteralCompare.hpp')).toBe(true);
    // Real SQLite smoke database reached the mounted runtime path.
    expect(ctx.files.has('smoke/runtime-smoke.sqlite')).toBe(true);
  } finally {
    cleanup(root);
  }
}, 300000);

test('the controlled async runtime aborts a burst, but the driver never sends one', () => {
  const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-async-'));
  try {
    const produced = produce(root);
    if (produced.run.status !== 0) throw Error(produced.run.stderr);
    const runtime = path.join(produced.bin, 'docker');
    // Reproduce the historical race directly: three queries and shutdown in one
    // burst against the same async runtime must abort before any result.
    const burst = spawnSync('python3', [runtime, 'run', '--name',
      'xpod-normal-runtime-smoke-ffffffffffffffff', '--mount',
      `type=bind,src=${path.join(root, 'out-pass')}/smoke,dst=/data`, RUNTIME_IMAGE,
      '--sqlite-path', '/data/runtime-smoke.sqlite'], {
      env: {...process.env, FAKE_SMOKE_CASES: SMOKE_CASES_FILE,
        FAKE_RUNTIME_MODE: 'pass', PYTHONDONTWRITEBYTECODE: '1'},
      input: [
        '{"id":"fts","type":"query","sparql":"q1"}',
        '{"id":"vector","type":"query","sparql":"q2"}',
        '{"id":"default-named-graph","type":"query","sparql":"q3"}',
        '{"type":"shutdown"}',
      ].join('\n') + '\n',
      encoding: 'utf8', timeout: 60000,
    });
    expect(burst.status).toBe(3);
    expect(burst.stdout).toContain('qlever_request_aborted');
    // The producer used the same runtime serially: every query got its result
    // before shutdown, and the smoke exit is 0.
    const smoke = JSON.parse(readFileSync(path.join(produced.out,
      'functional-smoke.json'), 'utf8'));
    expect(smoke.exit).toBe(0);
    expect(smoke.actualWait).toBe(true);
    const stdout = readFileSync(path.join(produced.out, 'smoke/child/stdout.raw'), 'utf8');
    for (const id of ['fts', 'vector', 'default-named-graph']) expect(stdout).toContain(`"id":"${id}"`);
    expect(stdout).not.toContain('qlever_request_aborted');
  } finally {
    cleanup(root);
  }
}, 300000);

test('a runtime abort fails the producer, preserves raw error bytes and leaves no master', () => {
  const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-fail-'));
  try {
    const failed = produce(root, 'fail-vector');
    expect(failed.run.status).not.toBe(0);
    const rawStdout = readFileSync(path.join(failed.out, 'smoke/child/stdout.raw'), 'utf8');
    const rawStderr = readFileSync(path.join(failed.out, 'smoke/child/stderr.raw'), 'utf8');
    expect(rawStdout).toContain('qlever_request_aborted');
    expect(rawStderr).toContain('runtime query reply required before shutdown');
    expect(() => statSync(path.join(failed.out, 'materials.json'))).toThrow();
  } finally {
    cleanup(root);
  }
}, 300000);

test('the real master rejects a different runtime image, SDK image or rewritten raw stream', () => {
  const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-reject-'));
  try {
    const produced = produce(root);
    if (produced.run.status !== 0) throw Error(produced.run.stderr);
    const ctx = context(produced.out, produced.trackedFiles);
    inspectNormalLocalRuntimeMaster(ctx.masterRef, ctx.master, ctx.view as any);

    const wrongRuntime = context(produced.out, produced.trackedFiles);
    wrongRuntime.master.runtimeImage =
      'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + '0'.repeat(64);
    expect(() => inspectNormalLocalRuntimeMaster(wrongRuntime.masterRef, wrongRuntime.master,
      wrongRuntime.view as any)).toThrow();

    const wrongSdk = context(produced.out, produced.trackedFiles);
    const sdkBytes = Buffer.from(JSON.stringify({
      ...JSON.parse(wrongSdk.view.sdk.readOriginal().toString()),
      image: {referenceByDigest: 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + '0'.repeat(64)},
    }));
    (wrongSdk.view.sdk as any).readOriginal = () => sdkBytes;
    (wrongSdk.view.sdk as any).masterReference = {path: 'materials.json',
      bytes: sdkBytes.length, sha256: sha(sdkBytes)};
    expect(() => inspectNormalLocalRuntimeMaster(wrongSdk.masterRef, wrongSdk.master,
      wrongSdk.view as any)).toThrow();

    // Rewrite the raw stdout and re-seal every dependent reference so only the
    // semantic content differs; the inspector must reject the error row.
    const rewritten = context(produced.out, produced.trackedFiles);
    const files = rewritten.files;
    const stdoutName = 'smoke/child/stdout.raw';
    const receiptName = 'smoke/child/command.receipt.json';
    const evidenceName = 'functional-smoke.json';
    files.set(stdoutName, Buffer.from('{"type":"error","id":"fts","code":"qlever_request_aborted"}\n'));
    const receipt = JSON.parse(files.get(receiptName)!.toString());
    receipt.stdout = fileRef(files, stdoutName);
    files.set(receiptName, Buffer.from(JSON.stringify(receipt)));
    const evidence = JSON.parse(files.get(evidenceName)!.toString());
    evidence.stdout = fileRef(files, stdoutName);
    evidence.commandReceipt = fileRef(files, receiptName);
    files.set(evidenceName, Buffer.from(JSON.stringify(evidence)));
    rewritten.master.smoke.stdout = fileRef(files, stdoutName);
    rewritten.master.smoke.commandReceipt = fileRef(files, receiptName);
    rewritten.master.smoke.evidence = fileRef(files, evidenceName);
    for (const row of rewritten.master.originals) {
      if ([stdoutName, receiptName, evidenceName].includes(row.path)) Object.assign(row, fileRef(files, row.path));
    }
    rewritten.master.retainedOriginalBytes =
      rewritten.master.originals.reduce((total: number, row: any) => total + row.bytes, 0);
    const masterBytes = Buffer.from(JSON.stringify(rewritten.master));
    files.set('materials.json', masterBytes);
    const masterRef = {path: 'materials.json', bytes: masterBytes.length, sha256: sha(masterBytes)};
    expect(() => inspectNormalLocalRuntimeMaster(masterRef, rewritten.master,
      rewritten.view as any)).toThrow(/smoke|error|semantic/u);
  } finally {
    cleanup(root);
  }
}, 300000);

test('the real driver process waits for each result and never races shutdown', () => {
  const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-driver-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeExecutable(path.join(bin, 'docker'), DOCKER_FIXTURE);
    const smoke = path.join(root, 'smoke');
    mkdirSync(smoke);
    writeFileSync(path.join(smoke, 'runtime-smoke.sqlite'), 'fixture');
    const dockerArgv = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--name',
      'xpod-normal-runtime-smoke-0123456789abcdef', '--mount',
      'type=bind,src=' + smoke + ',dst=/data', RUNTIME_IMAGE,
      '--sqlite-path', '/data/runtime-smoke.sqlite'];
    const env = {...process.env, PATH: bin + ':' + (process.env.PATH ?? ''),
      FAKE_RUNTIME_MODE: 'pass', FAKE_CONFIG_DIGEST: CONFIG_DIGEST,
      FAKE_SMOKE_CASES: SMOKE_CASES_FILE, PYTHONDONTWRITEBYTECODE: '1'};
    const run = (mode: string) => spawnSync('python3', ['-B', collector, '--smoke-session',
      JSON.stringify(dockerArgv)], {encoding: 'utf8', timeout: 60000,
      env: {...env, FAKE_RUNTIME_MODE: mode}});
    const ok = run('pass');
    if (ok.status !== 0) throw Error(ok.stderr);
    const rows = ok.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(rows.map(row => row.type)).toEqual(['ready', 'result', 'result', 'result']);
    expect(rows.slice(1).map(row => row.id)).toEqual(
      normalSmokeCases.map(row => row.request.id));
    // A shutdown-triggered abort really does fail the driver; it does not
    // silently accept a short transcript.
    const aborted = run('fail-vector');
    expect(aborted.status).not.toBe(0);
    expect(aborted.stdout).toContain('"code":"qlever_request_aborted"');
    expect(aborted.stderr).toContain('runtime query reply required before shutdown: vector');
  } finally {
    cleanup(root);
  }
}, 120000);

test('the python validator rejects empty or wrong bindings although the needle text is present', () => {
  for (const mode of ['empty-bindings', 'wrong-graph']) {
    const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-bindings-' + mode + '-'));
    try {
      const produced = produce(root, mode);
      expect(produced.run.status).not.toBe(0);
      // The shared case file is the only acceptance source: 'alpha card' and the
      // graph URI still appear in the stream, but the bindings do not match.
      expect(produced.run.stderr).toContain('exact semantic bindings required');
      const raw = readFileSync(path.join(produced.out, 'smoke/child/stdout.raw'), 'utf8');
      expect(raw).toContain('alpha card');
      if (mode === 'wrong-graph') expect(raw).toContain('urn:xpod:smoke:g:allowed');
      expect(() => statSync(path.join(produced.out, 'materials.json'))).toThrow();
    } finally {
      cleanup(root);
    }
  }
}, 300000);

test('the target is passed through and a mismatched SDK target is rejected', () => {
  const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-target-'));
  try {
    const produced = produce(root, 'pass', 'linux-arm64');
    if (produced.run.status !== 0) throw Error(produced.run.stderr);
    const ctx = context(produced.out, produced.trackedFiles);
    expect(ctx.master.identity.target).toBe('linux-arm64');
    // The fixture SDK target follows the master, so acceptance is not a
    // hardcoded x64 coincidence.
    expect(inspectNormalLocalRuntimeMaster(ctx.masterRef, ctx.master, ctx.view as any)
      .observation.proofModel).toBe(NORMAL_RUNTIME_MODEL);

    const x64Sdk = context(produced.out, produced.trackedFiles, {sdkTarget: 'linux-x64'});
    expect(() => inspectNormalLocalRuntimeMaster(x64Sdk.masterRef, x64Sdk.master,
      x64Sdk.view as any)).toThrow(/SDK provenance/u);

    const bad = context(produced.out, produced.trackedFiles);
    bad.master.identity.target = 'linux-riscv64';
    expect(() => inspectNormalLocalRuntimeMaster(bad.masterRef, bad.master,
      bad.view as any)).toThrow(/target/u);
  } finally {
    cleanup(root);
  }
}, 300000);

test('a failing smoke still removes its own named container', () => {
  const root = mkdtempSync(path.join(repoRoot, '.test-data/normal-runtime-rm-'));
  try {
    const failed = produce(root, 'fail-vector');
    expect(failed.run.status).not.toBe(0);
    const log = readFileSync(path.join(root, 'docker.log'), 'utf8');
    const lines = log.split('\n').filter(Boolean);
    const ran = lines.filter(line => line.startsWith('run ')).map(line => line.slice(4));
    const removed = lines.filter(line => line.startsWith('rm ')).map(line => line.slice(3));
    expect(ran).toHaveLength(1);
    expect(/^xpod-normal-runtime-smoke-[a-f0-9]{16}$/u.test(ran[0]!)).toBe(true);
    // Cleanup is keyed to the SAME generated name, never a wildcard or `docker ps`.
    expect(removed).toContain(ran[0]!);
    expect(() => statSync(path.join(failed.out, 'materials.json'))).toThrow();
  } finally {
    cleanup(root);
  }
}, 300000);
