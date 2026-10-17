const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { MODES, CASES, CHECK_NAME, projectLive, validateMatrix, assertSafeJson } = require('../../scripts/lib/service-image-modes.cjs');
const { PROFILES, validateInput, validateReceipt } = require('../../scripts/lib/service-image-session-contract.cjs');
const sha = 'a'.repeat(64); const sourceSha = 'b'.repeat(40); const image = `ghcr.io/undefinedsco/xpod@sha256:${sha}`; const id = `sha256:${'c'.repeat(64)}`;
const expected = { sourceSha, image, platform: 'linux/amd64', runId: '1', runAttempt: '1' };
function input(mode, kind) { return { schemaVersion: 1, sourceSha, mode, baseUrl: 'http://localhost:12341/', issuer: mode === 'local' ? 'http://localhost:12342/' : 'http://localhost:12341/', image: { reference: image, platform: expected.platform, id }, profile: { kind, ...PROFILES[kind], originalConfigSHA256: sha, derivedConfigSHA256: sha }, binding: { webId: mode === 'local' ? 'http://localhost:12342/profile/card#me' : 'http://localhost:12341/profile/card#me', podUrl: 'http://localhost:12341/pod/' }, ownershipRoot: '/owned', accountFile: '/owned/account', outputDirectory: '/owned/output' }; }
function session(mode, kind) { const v = input(mode, kind); return { schemaVersion: 1, status: 'passed', sourceSha, mode, image: v.image, profile: v.profile, binding: v.binding, browser: { authorizationCodes: 2, passwordPosts: 1, cookieRestored: true, identityMatches: true }, sdk: { authorizationCodes: kind === 'expire' ? 2 : 1, persistedHostRestored: true, identityMatches: true, privateReadWrite: true, anonymousDenied: true, refreshRejections: kind === 'expire' ? 1 : 0, refreshSuccesses: kind === 'expire' ? 0 : 1, accessExpiryObserved: kind !== 'expire', refreshExpiryObserved: kind === 'expire', recoveredByLogin: kind === 'expire' }, lifecycle: { exitCode: 0, waitKnown: true, closeObserved: true, groupAbsent: true }, cleanup: { hostAbsent: true, rpClosed: true, privateStateRemoved: true }, originals: [{ path: 'protocol.json', bytes: 12, sha256: sha }], sources: { 'tests/helper.ts': sha }, receiptSHA256: sha }; }
function fixture() { return { schemaVersion: 1, status: 'passed', cancelled: false, ...expected, imageId: id, baseConfigSHA256: sha, policyConfigs: Object.fromEntries(CASES.map(kind => [kind, { ...PROFILES[kind], originalConfigSHA256: sha, derivedConfigSHA256: sha }])), sources: { 'scripts/a.ts': sha, 'scripts/b.ts': sha, 'bun.lock': sha }, cleanup: { containersAbsent: true, volumesAbsent: true, networkAbsent: true, ownedCommandsClosed: true }, commands: [{ timeoutMs:1000,terminationGraceMs:1000,finalObservationMs:4000,code: 0, exitObserved: true, rawEligible: true, signal: null, spawnFailed: false, ownershipUnknown: false, waitKnown: true, closeObserved: true, groupAbsent: true, timedOut: false, cancelled: false, forcedCleanup: false, outputTruncated: false, stdoutSHA256: sha, stderrSHA256: sha }], modes: MODES.map(mode => ({ mode, baseUrl: input(mode, 'renew').baseUrl, issuer: input(mode, 'renew').issuer, image: { reference: image, id, platform: expected.platform, repoDigests: [image], noCodeMounts: true, mounts: [{ destination:'/app/data', type:'volume', readOnly:false }], runtimeExecutables: ['/bin/bun', '/bin/bun', '/bin/bun'] }, live: { mode, keyCleanup: true, selectedModels: 1, chatStatus: 200, layers: Object.fromEntries(['runtime','identity','podReadWrite','gatewayAuth','aiConnections','models','chat'].map(x => [x, true])) }, sessions: CASES.map(kind => session(mode, kind)), sessionBindings: Object.fromEntries(CASES.map(kind => [kind, input(mode, kind).binding])) })) }; }
test('complete three-mode image contract is accepted; this is schema evidence only', () => assert.deepEqual(validateMatrix(fixture(), expected), { [CHECK_NAME]: 'passed' }));
for (const [name, mutate] of [
  ['missing Standalone', r => r.modes.pop()],
  ['wrong mode digest', r => r.modes[2].image.reference += '0'],
  ['source mount despite claimed noCodeMounts', r => r.modes[0].image.mounts.push({ destination:'/app/dist',type:'bind',readOnly:true })],
  ['different config image', r => r.modes[1].image.id = `sha256:${'d'.repeat(64)}`],
  ['missing actual Chat layer', r => r.modes[0].live.layers.chat = false],
  ['missing credential revocation', r => r.modes[0].live.keyCleanup = false],
  ['client credentials substituted for refresh', r => r.modes[1].sessions[0].sdk.refreshSuccesses = 0],
  ['Cookie reuse substituted for SDK restoration', r => r.modes[1].sessions[1].sdk.persistedHostRestored = false],
  ['expired refresh without reauth', r => r.modes[2].sessions[2].sdk.recoveredByLogin = false],
  ['wrong policy provenance', r => r.policyConfigs.idle.originalConfigSHA256 = '0'.repeat(64)],
  ['unknown owned wait', r => r.commands[0].waitKnown = false],
  ['forced descendant cleanup after zero exit', r => r.commands[0].forcedCleanup = true],
  ['raw still open', r => r.commands[0].closeObserved = false],
  ['surviving group', r => r.commands[0].groupAbsent = false],
  ['output truncation', r => r.commands[0].outputTruncated = true],
  ['unclean volume', r => r.cleanup.volumesAbsent = false],
]) test(`rejects ${name}`, () => { const r = fixture(); mutate(r); assert.throws(() => validateMatrix(r, expected)); });
test('rejects event/source or run/attempt mismatch', () => { for (const key of ['sourceSha','runId','runAttempt','platform']) assert.throws(() => validateMatrix(fixture(), { ...expected, [key]: 'other' })); });
test('same-mode duplicate cannot replace missing mode/profile', () => { const r = fixture(); r.modes[2] = structuredClone(r.modes[1]); assert.throws(() => validateMatrix(r, expected)); const q = fixture(); q.modes[0].sessions[2] = q.modes[0].sessions[0]; assert.throws(() => validateMatrix(q, expected)); });
test('private external input rejects wrong topology, path escape, protected port and TTL drift', () => { for (const mutate of [v => v.accountFile = '/outside/password', v => v.baseUrl = 'http://localhost:60895/', v => v.profile.accessTokenTtl = 3600, v => v.mode = 'cloud']) { const v = input('local', 'renew'); mutate(v); assert.throws(() => validateInput(v)); } });
test('safe originals cannot escape or omit digest', () => { const v = input('cloud','renew'); for (const name of ['../private','/tmp/private']) { const r = session('cloud','renew'); r.originals[0].path = name; assert.throws(() => validateReceipt(r,v)); } });
test('rejects secret-shaped safe fields and values', () => { assert.throws(() => assertSafeJson({ nested: { refresh_token: 'private' } })); assert.throws(() => assertSafeJson({ message: 'Bearer private-value' })); assertSafeJson({ refreshSuccesses: 1, error: 'invalid_grant' }); });
test('HTTP200 and empty/blank models do not pass real live projection', () => { const r = { mode:'cloud', layers: Object.fromEntries(['runtime','identity','podReadWrite','gatewayAuth','aiConnections','models','chat'].map(k => [k,{ok:true}])), modelIds:[], chatStatus:200, chatModel:'', keyCleanup:{ok:true} }; assert.throws(() => projectLive(r,'cloud')); r.modelIds=['']; assert.throws(() => projectLive(r,'cloud')); });
test('candidate waits for exact matrix originals; promotion rejects old local-only check set', () => { const root = path.resolve(__dirname,'../..'); const workflow = yaml.parse(fs.readFileSync(path.join(root,'.github/workflows/candidate.yml'),'utf8')); assert(workflow.jobs.finalize_acceptance.needs.includes('runtime_mode_matrix')); const job=workflow.jobs.runtime_mode_matrix; assert.deepEqual(job.needs,['metadata','build_image']); const final=JSON.stringify(workflow.jobs.finalize_acceptance); assert(final.includes('needs.runtime_mode_matrix.outputs.artifact-id')); assert(final.includes('needs.runtime_mode_matrix.outputs.attempt')); assert(!final.includes('--run-attempt \"$GITHUB_RUN_ATTEMPT\"')); assert(final.includes('verify-service-image-modes.cjs')); assert(final.includes('checks.json')); const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8'); assert(release.includes(`--required-check ${CHECK_NAME}`)); });

const { runOwnedModeCommand } = require('../../scripts/lib/owned-mode-command.cjs');
test('actual owned child closes with known exit and raw hash; actual timeout is never a pass', async () => {
  const options = { cwd: process.cwd(), env: process.env, timeoutMs: 1000, outputBytes: 1024 };
  const normal = await runOwnedModeCommand(process.execPath, ['-e', 'process.stdout.write("owned")'], options);
  assert.equal(normal.record.code, 0); assert.equal(normal.stdout.toString(), 'owned'); assert(normal.record.waitKnown && normal.record.closeObserved && normal.record.groupAbsent); assert.equal(normal.record.timedOut, false);
  const hung = await runOwnedModeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 50 });
  assert(hung.record.timedOut && hung.record.closeObserved && hung.record.groupAbsent && hung.record.waitKnown); assert.equal(hung.record.signal, 'SIGTERM');
  const overflow = await runOwnedModeCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)'], options);
  assert(overflow.record.outputTruncated && overflow.record.groupAbsent && overflow.record.closeObserved); assert(overflow.stdout.length <= 1024);
});
test('generic promotion validator refuses an old local-only manifest when new guard requires matrix', () => {
  const { createManifest, validateManifest } = require('../../scripts/release-acceptance-manifest.cjs');
  const manifest = createManifest({ targetVersion:'0.4.31', candidateVersion:'0.4.31-rc.1', sourceSha, sourceBranch:'staging', imageDigest:`sha256:${sha}`, endpoint:'https://id-rc.undefineds.cn', acceptedAt:'2026-10-17T00:00:00.000Z', checks:{chat:'passed'} });
  const result = validateManifest(manifest,{tag:'v0.4.31',sourceSha,requiredChecks:['chat',CHECK_NAME]});
  assert.equal(result.valid,false); assert(result.errors.some(row=>row.path===`checks.${CHECK_NAME}`));
});

test('actual external cancellation retains actual signal/close without a successful status', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 50);
  try { const result = await runOwnedModeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd:process.cwd(),env:process.env,timeoutMs:1000,outputBytes:1024,signal:controller.signal }); assert(result.record.cancelled); assert(result.record.closeObserved && result.record.groupAbsent); assert.equal(result.record.signal,'SIGTERM'); assert.notEqual(result.record.code,0); } finally { clearTimeout(timer); }
});

const { canonicalMember, createModeEvidenceReader } = require('../../scripts/lib/mode-evidence-reader.cjs');
const { validSources } = require('../../scripts/lib/service-image-session-contract.cjs');
const fsp = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
async function evidenceFixture(fn) {
  const parent = path.resolve('.test-data/mode-evidence-reader'); await fsp.mkdir(parent,{recursive:true});
  const root = await fsp.mkdtemp(path.join(parent,'case-'));
  try { await fn(root); } finally { await fsp.rm(root,{recursive:true,force:true}); }
}
test('canonical source/member paths reject aliases, backslashes and empty segments', () => {
  for (const member of ['scripts//x.ts','scripts/./x.ts','scripts/../x.ts','scripts/x.ts/','scripts/a\\x.ts','scripts/\x00x.ts']) {
    assert.equal(canonicalMember(member),false); assert.equal(Boolean(validSources({[member]:sha})),false);
  }
  assert(validSources({'scripts/x.ts':sha,'bun.lock':sha}));
});
test('whole-tree preflight rejects oversize/total limits before opening any body', () => evidenceFixture(async root => {
  await fsp.writeFile(path.join(root,'a.json'),'123456789012'); await fsp.writeFile(path.join(root,'b.json'),'123456789012');
  const open = fsp.open; let reads = 0; fsp.open = async (...args) => { reads++; return open(...args); };
  try {
    await assert.rejects(createModeEvidenceReader(root,{memberBytes:10,totalBytes:100}));
    await assert.rejects(createModeEvidenceReader(root,{memberBytes:16,totalBytes:20}));
    assert.equal(reads,0);
  } finally { fsp.open = open; }
}));
test('root/file/directory symlinks rejected before reading', () => evidenceFixture(async root => {
  const real = path.join(root,'real'); await fsp.mkdir(real); await fsp.writeFile(path.join(real,'a.json'),'{}');
  const link = path.join(root,'linked'); await fsp.symlink(real,link,'dir');
  await assert.rejects(createModeEvidenceReader(link)); await assert.rejects(createModeEvidenceReader(root));
  await fsp.unlink(link); await fsp.symlink(path.join(real,'a.json'),path.join(root,'file.json'));
  await assert.rejects(createModeEvidenceReader(root));
}));
test('admitted file or ancestor replacement cannot bypass open/read bounds', () => evidenceFixture(async root => {
  const dir=path.join(root,'nested'); await fsp.mkdir(dir); await fsp.writeFile(path.join(dir,'a.json'),'{}');
  const reader=await createModeEvidenceReader(root,{memberBytes:16,totalBytes:32});
  await fsp.rename(dir,path.join(root,'old')); await fsp.symlink(path.join(root,'old'),dir,'dir');
  await assert.rejects(reader.read('nested/a.json'));
  await fsp.unlink(dir); await fsp.rename(path.join(root,'old'),dir);
  const next=await createModeEvidenceReader(root,{memberBytes:16,totalBytes:32});
  await fsp.writeFile(path.join(root,'replacement.json'),'{}'); await fsp.rename(path.join(root,'replacement.json'),path.join(dir,'a.json'));
  await assert.rejects(next.read('nested/a.json'));
}));
test('stable admitted JSON is read exactly once with an immutable cached body', () => evidenceFixture(async root => {
  await fsp.writeFile(path.join(root,'a.json'),'{}'); const reader=await createModeEvidenceReader(root,{memberBytes:16,totalBytes:32});
  assert.equal(reader.totalBytes,2); assert.deepEqual(reader.files,['a.json']); const first=await reader.read('a.json'); assert.equal(first.toString(),'{}'); assert.equal(await reader.read('a.json'),first); await assert.rejects(reader.read('./a.json'));
}));
test('actual live helper import neither calls the network nor overwrites cwd evidence', () => evidenceFixture(async root => {
  const dir=path.join(root,'.test-data/acceptance'); await fsp.mkdir(dir,{recursive:true});
  for(const mode of MODES) await fsp.writeFile(path.join(dir,`live-gateway-login-chat-${mode}.json`),`sentinel-${mode}`);
  const before=Object.fromEntries(await Promise.all((await fsp.readdir(dir)).map(async name=>[name,(await fsp.readFile(path.join(dir,name))).toString()])));
  const bun=spawnSync('which',['bun'],{encoding:'utf8'}).stdout.trim(); assert(bun);
  const moduleUrl=require('node:url').pathToFileURL(path.resolve('scripts/accept-live-gateway-login-chat.ts')).href;
  const code=`globalThis.fetch=()=>{throw new Error('Import attempted network')}; const m=await import(${JSON.stringify(moduleUrl)}); if(typeof m.createCloudAccountPassword!=='function'||typeof m.prepareManagedLocalAcceptancePod!=='function') throw new Error('Missing helpers'); console.log('IMPORT_ONLY_OK')`;
  const result=spawnSync(bun,['--no-env-file','-e',code],{cwd:root,env:{...process.env,XPOD_LIVE_MODE:'local',XPOD_BASE_URL:'http://127.0.0.1:1/',XPOD_LIVE_PROVIDER_KEY_FILE:path.join(root,'absent-provider')},encoding:'utf8',timeout:10000,maxBuffer:65536});
  assert.equal(result.error,undefined); assert.equal(result.status,0,result.stderr); assert(result.stdout.includes('IMPORT_ONLY_OK'));
  const after=Object.fromEntries(await Promise.all((await fsp.readdir(dir)).map(async name=>[name,(await fsp.readFile(path.join(dir,name))).toString()]))); assert.deepEqual(after,before);
}));
test('escaped pipe holder returns bounded unknown-close failure and is precisely cleaned by fixture', async () => {
  let escaped;
  const script=`const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});c.unref();console.log(JSON.stringify({escapedPid:c.pid}));setInterval(()=>{},1000)`;
  const started=Date.now();
  try {
    const result=await runOwnedModeCommand(process.execPath,['-e',script],{cwd:process.cwd(),env:process.env,timeoutMs:300,finalObservationMs:2000,outputBytes:1024});
    escaped=JSON.parse(result.stdout.toString().trim()).escapedPid; assert(Number.isSafeInteger(escaped)&&escaped>1);
    assert(Date.now()-started<4000); assert(result.record.exitObserved&&result.record.waitKnown); assert.equal(result.record.closeObserved,false); assert.equal(result.record.ownershipUnknown,true); assert.equal(result.record.rawEligible,false); assert.equal(result.record.stdoutSHA256,null); assert(result.record.timedOut);
  } finally {
    if(escaped) {
      try{process.kill(-escaped,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
      let absent=false; for(let n=0;n<100;n++){try{process.kill(-escaped,0);}catch(error){if(error.code==='ESRCH'){absent=true;break;}throw error;} await new Promise(resolve=>setTimeout(resolve,10));}
      assert(absent,'Owned escaped fixture group must be absent after exact cleanup');
    }
  }
});

const { verifyModeEvidence } = require('../../scripts/verify-service-image-modes.cjs');
const digestBytes = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
async function artifactFixture(fn) { return evidenceFixture(async root => {
  const repo=path.join(root,'repo'); const artifact=path.join(root,'artifact'); await fsp.mkdir(repo); await fsp.mkdir(artifact);
  const sourceBytes=Buffer.from('owned fixture source');
  for(const name of ['scripts/a.ts','scripts/b.ts','tests/helper.ts','bun.lock']) { await fsp.mkdir(path.dirname(path.join(repo,name)),{recursive:true}); await fsp.writeFile(path.join(repo,name),sourceBytes); }
  const report=fixture(); report.sources=Object.fromEntries(['scripts/a.ts','scripts/b.ts','bun.lock'].map(name=>[name,digestBytes(sourceBytes)]));
  for(const mode of report.modes) {
    const live={mode:mode.mode,layers:Object.fromEntries(['runtime','identity','podReadWrite','gatewayAuth','aiConnections','models','chat'].map(k=>[k,{ok:true}])),modelIds:['m'],chatModel:'m',chatStatus:200,keyCleanup:{ok:true}};
    const liveBytes=Buffer.from(JSON.stringify(live)); mode.live=projectLive(live,mode.mode); mode.liveOriginalSHA256=digestBytes(liveBytes); await fsp.writeFile(path.join(artifact,`live-${mode.mode}.original.json`),liveBytes);
    for(const row of mode.sessions) {
      const directory=path.join(artifact,`session-${mode.mode}-${row.profile.kind}`); await fsp.mkdir(directory);
      const original=Buffer.from(JSON.stringify({grant:row.profile.kind==='expire'?'authorization_code':'refresh_token',status:200}));
      row.originals=[{path:'protocol.json',bytes:original.length,sha256:digestBytes(original)}];row.sources={'tests/helper.ts':digestBytes(sourceBytes)};
      const {receiptSHA256,...receipt}=row;const bytes=Buffer.from(JSON.stringify(receipt));row.receiptSHA256=digestBytes(bytes);
      await fsp.writeFile(path.join(directory,'session.safe.json'),bytes);await fsp.writeFile(path.join(directory,'protocol.json'),original);
    }
  }
  await fsp.writeFile(path.join(artifact,'matrix.safe.json'),JSON.stringify(report)); await fn({repo,artifact,report});
}); }
test('light verifier re-reads every declared safe original and exact source bytes without service dependencies', () => artifactFixture(async ({repo,artifact}) => {
  assert.deepEqual(await verifyModeEvidence(artifact,expected,repo),{[CHECK_NAME]:'passed'});
  for(const key of ['sourceSha','image','runId','runAttempt']) await assert.rejects(verifyModeEvidence(artifact,{...expected,[key]:'different'},repo));
  await fsp.unlink(path.join(artifact,'session-cloud-renew/protocol.json')); await assert.rejects(verifyModeEvidence(artifact,expected,repo));
}));
test('light verifier rejects undeclared artifacts or changed safe original', () => artifactFixture(async ({repo,artifact}) => {
  await fsp.writeFile(path.join(artifact,'extra.json'),'{}'); await assert.rejects(verifyModeEvidence(artifact,expected,repo));await fsp.unlink(path.join(artifact,'extra.json'));
  await fsp.writeFile(path.join(artifact,'session-local-idle/protocol.json'),'{}');await assert.rejects(verifyModeEvidence(artifact,expected,repo));
}));
test('stable guard uses the same light verifier on accepted source/digest/run/attempt originals', () => {
  const release=fs.readFileSync(path.resolve('.github/workflows/release.yml'),'utf8');
  for(const fragment of ['node scripts/verify-service-image-modes.cjs','--directory "$ACCEPTANCE_DIR/mode-matrix"','--source-sha "$TAG_SHA"','--image "$ACCEPTED_IMAGE"','--run-id "$CANDIDATE_RUN_ID"','--run-attempt "$MODE_MATRIX_ATTEMPT"']) assert(release.includes(fragment));
  const verifier=fs.readFileSync(path.resolve('scripts/verify-service-image-modes.cjs'),'utf8'); assert(!verifier.includes('accept-live-gateway-login-chat'));assert(!verifier.includes('drizzle'));assert(!verifier.includes('bun install'));
});

test('nested cancellation waits for B forwarded child close even when its display-style wrapper exits first', async () => {
  const helper=path.resolve('scripts/lib/owned-mode-command.cjs');
  const childScript=`process.on('SIGTERM',()=>{console.log('STOP_RECEIVED');setTimeout(()=>process.exit(0),150)});setInterval(()=>{},1000)`;
  const bScript=`const{runOwnedModeCommand}=require(${JSON.stringify(helper)});const c=new AbortController();process.on('SIGTERM',()=>c.abort());process.on('SIGINT',()=>c.abort());(async()=>{const r=await runOwnedModeCommand(process.execPath,['-e',${JSON.stringify(childScript)}],{cwd:process.cwd(),env:process.env,timeoutMs:5000,outputBytes:1024,signal:c.signal});console.log(JSON.stringify({bAfterChildClose:r.record,childBody:r.stdout.toString()}));process.exitCode=1})()`;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),500);
  try {
    const outer=await runOwnedModeCommand('/bin/sh',['-c','trap "exit 143" TERM; "$1" -e "$2" & wait','owned-display-wrapper',process.execPath,bScript],{cwd:process.cwd(),env:process.env,timeoutMs:5000,outputBytes:4096,terminationGraceMs:10000,signal:controller.signal});
    const lines=outer.stdout.toString().trim().split('\n');const inner=JSON.parse(lines.find(line=>line.startsWith('{')));
    assert(inner.bAfterChildClose.exitObserved&&inner.bAfterChildClose.closeObserved&&inner.bAfterChildClose.groupAbsent&&inner.bAfterChildClose.cancelled);assert(inner.childBody.includes('STOP_RECEIVED'));
    assert(outer.record.exitObserved&&outer.record.closeObserved&&outer.record.groupAbsent&&outer.record.cancelled);assert.notEqual(outer.record.code,0);
  } finally {clearTimeout(timer);}
});
test('A owns one Linux display/Electron preparation and allows B a ten-second cancellation grace',()=>{
  const workflow=yaml.parse(fs.readFileSync(path.resolve('.github/workflows/candidate.yml'),'utf8'));const job=workflow.jobs.runtime_mode_matrix;assert.equal(job['runs-on'],'ubuntu-24.04');const text=JSON.stringify(job);for(const fragment of ['xvfb','node node_modules/electron/install.js','ldd'])assert(text.includes(fragment));
  const runner=fs.readFileSync(path.resolve('scripts/accept-service-image-modes.ts'),'utf8');assert(runner.includes("'xvfb-run', ['--auto-servernum'"));assert(runner.includes('LIMITS.browserMs, false, 10_000'));assert(runner.includes('await mkdir(sessionOutput, { mode: 0o700 })'));
});

const { MATRIX_JOB_NAME, artifactName, validateModeSelection, validateModeArtifactAuthority } = require('../../scripts/lib/mode-artifact-authority.cjs');
function authorityFixture(attempt='1') {
  const e={...expected,runAttempt:attempt};const selection={schemaVersion:1,...e,artifactId:123,artifactDigest:`sha256:${sha}`,artifactName:artifactName(sourceSha,e.runId,attempt)};
  const artifact={id:123,name:selection.artifactName,digest:selection.artifactDigest,expired:false,size_in_bytes:1024,workflow_run:{id:Number(e.runId),head_sha:sourceSha}};
  const job={id:456,name:MATRIX_JOB_NAME,run_id:Number(e.runId),run_attempt:Number(attempt),head_sha:sourceSha,status:'completed',conclusion:'success'};
  return {e,selection,artifact,job};
}
test('retained successful matrix attempt1 survives finalize/global attempt2 without rewriting mode original',()=>{
  const {e,selection,artifact,job}=authorityFixture();const before=JSON.stringify(selection);
  const pages=[{jobs:[job,{id:999,name:'Finalize RC acceptance',run_id:1,run_attempt:2,head_sha:sourceSha,status:'completed',conclusion:'success'}]}];
  assert.equal(validateModeArtifactAuthority(selection,artifact,pages,e).actualMatrixAttempt,'1');assert.equal(JSON.stringify(selection),before);
  assert.equal(validateModeSelection(selection,{sourceSha,image,platform:expected.platform,runId:'1'}).runAttempt,'1');
});
test('latest actual failed matrix2 cannot borrow successful matrix1, and failed matrix1 cannot qualify',()=>{
  const {e,selection,artifact,job}=authorityFixture();assert.throws(()=>validateModeArtifactAuthority(selection,artifact,[{jobs:[{...job,conclusion:'failure'}]}],e));
  assert.throws(()=>validateModeArtifactAuthority(selection,artifact,[{jobs:[job,{...job,id:457,run_attempt:2,conclusion:'failure'}]}],e));
  const second=authorityFixture('2');assert.equal(validateModeArtifactAuthority(second.selection,second.artifact,[{jobs:[{...job,conclusion:'failure'},second.job]}],second.e).actualMatrixAttempt,'2');
});
test('mode authority rejects cross source/digest/run/actualattempt/artifact and absent observations',()=>{
  const {e,selection,artifact,job}=authorityFixture();
  for(const key of ['sourceSha','image','platform','runId','runAttempt'])assert.throws(()=>validateModeArtifactAuthority(selection,artifact,[{jobs:[job]}],{...e,[key]:'wrong'}));
  for(const changed of [{...artifact,id:999},{...artifact,digest:`sha256:${'f'.repeat(64)}`},{...artifact,expired:true},{...artifact,workflow_run:{id:99,head_sha:sourceSha}}])assert.throws(()=>validateModeArtifactAuthority(selection,changed,[{jobs:[job]}],e));
  assert.throws(()=>validateModeArtifactAuthority(selection,artifact,[{jobs:[]}],e));assert.throws(()=>validateModeArtifactAuthority(selection,artifact,[{jobs:[job,{...job,id:457}]}],e));
});
test('workflow retains actual matrix outputs, exact artifact ID and latest job authority across partial reruns',()=>{
  const workflow=yaml.parse(fs.readFileSync(path.resolve('.github/workflows/candidate.yml'),'utf8'));const matrix=workflow.jobs.runtime_mode_matrix;assert.equal(matrix.name,MATRIX_JOB_NAME);
  for(const key of ['attempt','artifact-name','artifact-id','artifact-digest'])assert(matrix.outputs[key]);
  const download=workflow.jobs.finalize_acceptance.steps.find(s=>s.name==='Download exact same-image mode acceptance');assert.equal(download.with['artifact-ids'],'${{ needs.runtime_mode_matrix.outputs.artifact-id }}');assert.equal(download.with['merge-multiple'],true);
  const verify=workflow.jobs.finalize_acceptance.steps.find(s=>s.name==='Revalidate same-image mode originals');assert(verify.run.includes('--run-attempt "$MATRIX_ATTEMPT"'));assert(!verify.run.includes('$GITHUB_RUN_ATTEMPT'));assert(verify.run.includes('--selection-file'));assert(verify.run.includes('--jobs-file'));assert(verify.run.includes('--artifact-file'));
  const stable=fs.readFileSync(path.resolve('.github/workflows/release.yml'),'utf8');assert(stable.includes('filter=all&per_page=100'));assert(stable.includes('--run-attempt "$MODE_MATRIX_ATTEMPT"'));assert(!stable.includes('process.stdout.write(String(run.run_attempt))'));
});

test('owned Cloud alone receives per-run strict32B test root keys accepted by the real loader', () => evidenceFixture(async root => {
  const bun=spawnSync('which',['bun'],{encoding:'utf8'}).stdout.trim();assert(bun);
  const url=require('node:url').pathToFileURL;const runner=url(path.resolve('scripts/accept-service-image-modes.ts')).href;const loader=url(path.resolve('src/api/container/index.ts')).href;
  const code=`globalThis.fetch=()=>{throw new Error('No network in fixture key contract')};const{ownedModeSecretCellEnvironment}=await import(${JSON.stringify(runner)});const{loadDeploymentRootKeyProvider}=await import(${JSON.stringify(loader)});const original={fixture:'owned'};for(const mode of ['local','standalone']){const env=ownedModeSecretCellEnvironment(mode,original);if(env!==original||'XPOD_SECRET_CELL_KEY'in env||'XPOD_SECRET_CELL_KEY_ID'in env)throw new Error('Local auto-persistence path changed')}const a=ownedModeSecretCellEnvironment('cloud',original);const b=ownedModeSecretCellEnvironment('cloud',original);if(a.XPOD_SECRET_CELL_KEY===b.XPOD_SECRET_CELL_KEY)throw new Error('Root key reused across deployments');if('XPOD_SECRET_CELL_KEY'in original)throw new Error('Input environment mutated');const provider=loadDeploymentRootKeyProvider(a);if(!provider||provider.getActiveKey().key.byteLength!==32||provider.getActiveKeyId()!=='matrix-owned-v1')throw new Error('Real loader rejected owned Cloud key');console.log('OWNED_CLOUD_KEY_CONTRACT_OK')`;
  const result=spawnSync(bun,['--no-env-file','-e',code],{cwd:root,env:{...process.env,XPOD_LIVE_MODE:'local',XPOD_BASE_URL:'http://127.0.0.1:1/'},encoding:'utf8',timeout:10000,maxBuffer:65536});
  assert.equal(result.error,undefined);assert.equal(result.status,0,'Owned Cloud key contract failed; raw import output withheld');assert(result.stdout.includes('OWNED_CLOUD_KEY_CONTRACT_OK'));
  const source=fs.readFileSync(path.resolve('scripts/accept-service-image-modes.ts'),'utf8');assert(source.includes('ownedModeSecretCellEnvironment(mode, service.environment)'));assert(source.includes("writeFile(composeFile, JSON.stringify(configuration), { mode: 0o600 })"));
}));
