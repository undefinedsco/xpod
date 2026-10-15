const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { rootCompatLanes, rootCompatCommands, rootCompatConsumerPath, runRootCompatLane, verifyRootCompat } = require('../../scripts/release-gate-evidence.cjs');
const source = 'a'.repeat(40);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const phases = ['dependencies', 'platform-versions', 'build', 'pack', 'pack-verification', 'install', 'consumer'];
function fixture(operation) {
  const base = path.resolve('.test-data/legacy-root-compat-contract'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  const receipts = [];
  function add(lane, attempt = 1) {
    const directory = path.join(root, lane.id + '-attempt' + attempt); fs.mkdirSync(directory);
    const receipt = { schemaVersion: 1, kind: 'legacy-root-compat-lane', ...lane, sourceSha: source,
      actualCheckoutSha: source, sourceAfter: source, sourceBeforeStatus:'',sourceAfterStatus:'',nodeVersion:`v${lane.node}.0.0`,bunVersion:'1.4.2',runId: '42', runAttempt: attempt, consumerRoot: lane.os==='windows-latest'?'D:\\a\\_temp\\xpod-package-smoke':path.resolve(root, 'consumer'), steps: [] };
    const integrity='sha512-'+crypto.createHash('sha512').update('fixture').digest('base64');
    const pack=Buffer.from(JSON.stringify([{filename:'root.tgz',name:'@undefineds.co/xpod',version:'1.2.3',integrity}]));
    fs.writeFileSync(path.join(directory,'pack.original.json'),pack);
    receipt.pack={original:{path:'pack.original.json',bytes:pack.length,sha256:digest(pack)},archive:{filename:'root.tgz',name:'@undefineds.co/xpod',version:'1.2.3',integrity,bytes:7,sha256:digest(Buffer.from('fixture'))}};
    rootCompatCommands(lane.runtime, receipt.consumerRoot).forEach((command, index) => {
      const phase = phases[index], refs = {};
      for (const stream of ['stdout', 'stderr']) {
        const name = `${phase}.${stream}.raw.log`, bytes = Buffer.from(`synthetic ${lane.id}/${phase}/${stream}`);
        fs.writeFileSync(path.join(directory, name), bytes); refs[stream] = { path: name, bytes: bytes.length, sha256: digest(bytes) };
      }
      receipt.steps.push({ phase, command, actualExit: 0, signal: null, spawnError: null, actualWaitCompleted: true, rawLogsClosed: true, ...refs });
    });
    const file = path.join(directory, 'lane.receipt.json'); const save = () => fs.writeFileSync(file, JSON.stringify(receipt)); save();
    const item = { receipt, directory, file, save }; receipts.push(item); return item;
  }
  rootCompatLanes().forEach(lane => add(lane));
  const args = { sourceSha: source, runId: '42', archiveDir: root };
  try { operation({ root, receipts, args, add }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('one authority defines all18 lanes and the original complete-package commands', () => {
  assert.equal(rootCompatLanes().length, 18); assert.equal(new Set(rootCompatLanes().map(row => row.id)).size, 18);
  assert.deepEqual(rootCompatCommands('node', '/consumer'), [
    ['bun','install','--frozen-lockfile'], ['bun','run','check:platform-package-version'], ['bun','run','build'],
    ['node','scripts/run-npm-pack.cjs','.test-data/npm-pack','.test-data/npm-cache'],
    ['node','scripts/check-pack-json.cjs','.test-data/npm-pack/pack.json'],
    ['node','scripts/package-smoke-install.cjs','.test-data/npm-pack/pack.json','/consumer','.test-data/npm-cache'],
    ['node','scripts/package-consumer-smoke.cjs','/consumer','--package-only'],
  ]);
  assert.deepEqual(rootCompatCommands('bun', '/consumer')[5], ['node','scripts/package-smoke-install.cjs','.test-data/npm-pack/pack.json','/consumer','.test-data/bun-cache','bun']);
});
test('synthetic complete receipts bind all raw hashes and survive same accepted-directory readback', () => fixture(({root,args}) => {
  const evidence = path.join(root, 'compat.receipt.json'); const checks = path.join(root, 'checks.json');
  const result = verifyRootCompat({...args,out:evidence,checksOut:checks}); assert.equal(result.lanes.length,18);
  assert.deepEqual(JSON.parse(fs.readFileSync(checks,'utf8')),{'legacy-root-compat':'passed'});
  assert.deepEqual(verifyRootCompat({...args,evidence}),result);
}));
for (const kind of ['missing','wrong-source','wrong-run','exit','signal','wait-unknown','raw-open','skipped','wrong-command','tampered-raw','missing-raw']) {
  test(`blocks release eligibility on ${kind}`, () => fixture(({root,receipts,args}) => {
    const row=receipts[0],step=row.receipt.steps[0];
    if(kind==='missing') fs.rmSync(row.directory,{recursive:true});
    if(kind==='wrong-source')row.receipt.sourceSha='b'.repeat(40);
    if(kind==='wrong-run')row.receipt.runId='43';
    if(kind==='exit')step.actualExit=1;
    if(kind==='signal')step.signal='SIGTERM';
    if(kind==='wait-unknown')step.actualWaitCompleted=false;
    if(kind==='raw-open')step.rawLogsClosed=false;
    if(kind==='skipped')row.receipt.steps.pop();
    if(kind==='wrong-command')step.command=['node','-e','console.log("passed")'];
    if(kind==='tampered-raw')fs.appendFileSync(path.join(row.directory,step.stdout.path),'drift');
    if(kind==='missing-raw')fs.unlinkSync(path.join(row.directory,step.stdout.path));
    if(kind!=='missing')row.save();
    const checks=path.join(root,'checks.json');assert.throws(()=>verifyRootCompat({...args,checksOut:checks}));assert.equal(fs.existsSync(checks),false);
  }));
}
test('partial rerun preserves earlier successful attempts and uses only the latest execution per lane', () => fixture(({receipts,args,add}) => {
  const latest=add(rootCompatLanes()[0],2);const result=verifyRootCompat(args);
  assert.equal(result.lanes[0].runAttempt,2);assert.equal(result.lanes[1].runAttempt,1);
  latest.receipt.steps[0].actualExit=1;latest.save();assert.throws(()=>verifyRootCompat(args),/failed/);
  assert.equal(receipts[0].receipt.runAttempt,1);
}));
test('validates consumer paths by lane platform, not by verifier host', () => {
  for(const value of ['D:\\a\\_temp\\consumer','D:/a/_temp/consumer','\\\\server\\share\\consumer','//server/share/consumer'])assert.equal(rootCompatConsumerPath('windows-latest',value),true,value);
  for(const value of ['D:consumer','consumer','\\consumer','/consumer','\\\\server'])assert.equal(rootCompatConsumerPath('windows-latest',value),false,value);
  for(const os of ['ubuntu-latest','macos-latest']) {
    assert.equal(rootCompatConsumerPath(os,'/tmp/consumer'),true);
    for(const value of ['D:\\a\\consumer','D:/a/consumer','\\\\server\\share\\consumer','//server/share/consumer'])assert.equal(rootCompatConsumerPath(os,value),false,value);
  }
});
test('original Windows UNC path is preserved in commands and accepted by the POSIX verifier', () => fixture(({receipts,args}) => {
  for(const row of receipts.filter(row=>row.receipt.os==='windows-latest')) {
    row.receipt.consumerRoot='\\\\server\\share\\consumer';
    const commands=rootCompatCommands(row.receipt.runtime,row.receipt.consumerRoot);
    row.receipt.steps.forEach((step,index)=>{step.command=commands[index];});row.save();
  }
  assert.equal(verifyRootCompat(args).lanes.length,18);
}));
test('manifest-only passed cannot replace absent original lane evidence', () => fixture(({root,args}) => {
  const evidence=path.join(root,'compat.receipt.json');fs.writeFileSync(evidence,JSON.stringify({'legacy-root-compat':'passed'}));
  assert.throws(()=>verifyRootCompat({...args,evidence}),/differs/);
}));
test('actual lane entry refuses a mismatched Node before executing any packaging command', () => {
  const base=path.resolve('.test-data/legacy-root-compat-contract');fs.mkdirSync(base,{recursive:true});const out=path.join(base,'preflight-'+process.pid);
  const actual=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  try {
    assert.throws(()=>runRootCompatLane({sourceSha:actual,runId:'42',runAttempt:'1',runtime:'node',os:'ubuntu-latest',nodeMajor:String(Number(process.versions.node.split('.')[0])===22?24:22),consumerRoot:path.join(base,'consumer'),out}),/Node mismatch|checkout is dirty/);
    const receipt=JSON.parse(fs.readFileSync(path.join(out,'lane.receipt.json'),'utf8'));assert.equal(receipt.steps.length,0);assert.ok(receipt.failure);
  } finally {fs.rmSync(out,{recursive:true,force:true});}
});
test('actual YAML keeps standalone triggers, strict matrix, RC-before-production dependency and same accepted proof', () => {
  const names=['legacy-root-compat','ci','candidate','release'];
  const parsed=names.map(name=>{const result=spawnSync('bun',['-e','console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))',path.resolve('.github/workflows/'+name+'.yml')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);});
  const [compat,ci,candidate,release]=parsed;
  assert.deepEqual(compat.on.push.branches,['main','staging']);assert.deepEqual(compat.on.pull_request.branches,['main','staging']);assert.ok(compat.on.workflow_call);
  assert.equal(compat.jobs.lanes['timeout-minutes'],30);assert.equal(compat.jobs.lanes.strategy['fail-fast'],false);assert.equal(compat.jobs.lanes['continue-on-error'],undefined);
  assert.equal(compat.jobs.lanes.strategy.matrix,'${{ fromJSON(needs.plan.outputs.matrix) }}');assert.equal(ci.jobs['package-smoke'],undefined);assert.equal(ci.jobs['package-smoke-bun'],undefined);
  const depends=(job,target)=>{const needs=candidate.jobs[job].needs;return (Array.isArray(needs)?needs:[needs]).filter(Boolean).some(name=>name===target||depends(name,target));};
  for(const job of ['rc_prerequisites','publish_qlever_runtime_sdk','publish_qlever_local_runtime','build_qlever_macos_runtime','build_image','deploy_and_accept','finalize_acceptance'])assert.ok(depends(job,'legacy_root_compat'),job);
  const finalize=candidate.jobs.finalize_acceptance.steps;const upload=finalize.find(step=>step.with?.name==='release-acceptance-${{ github.sha }}');assert.equal(upload.with.path,'${{ runner.temp }}/accepted-release/');
  assert.ok(finalize.some(step=>step.run?.includes('verify-root-compat')));assert.ok(finalize.some(step=>step.run?.includes('accepted-release/compat')));
  const guard=release.jobs.promotion_guard.steps.find(step=>step.id==='acceptance').run;
  assert.ok(guard.includes('--required-check legacy-root-compat'));assert.ok(guard.includes('--archive-dir "$ACCEPTANCE_DIR/compat"'));assert.ok(guard.includes('--evidence "$ACCEPTANCE_DIR/compat/compat.receipt.json"'));
  assert.ok(guard.indexOf('verify-root-compat')<guard.indexOf('fs.appendFileSync(process.env.GITHUB_OUTPUT'));
  assert.ok(release.jobs.promote_npm_latest.needs.includes('verify_npm_consumer_node'));assert.ok(release.jobs.promote_npm_latest.needs.includes('verify_npm_consumer_bun'));
});

test('lane wrapper keeps platform default shell and passes native paths and PATH unchanged to Node', () => {
  const parsed=spawnSync('bun',['-e','console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))',path.resolve('.github/workflows/legacy-root-compat.yml')],{encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stderr);
  const workflow=JSON.parse(parsed.stdout);const step=workflow.jobs.lanes.steps.find(row=>row.name==='Run the unchanged complete-package commands and retain actual outcomes');
  assert.equal(step.shell,undefined);assert.equal(workflow.defaults?.run?.shell,undefined);assert.equal(workflow.jobs.lanes.defaults?.run?.shell,undefined);
  assert.doesNotMatch(step.run,/\$SOURCE_SHA|\$GITHUB_RUN_ID|\$CONSUMER_ROOT|\\\n/);
  const base=path.resolve('.test-data/legacy-root-compat-contract');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'wrapper-'));
  try {
    fs.mkdirSync(path.join(root,'scripts'));
    fs.writeFileSync(path.join(root,'scripts/release-gate-evidence.cjs'),"exports.runRootCompatLane=args=>process.stdout.write(JSON.stringify({args,path:process.env.PATH}));");
    const consumer='D:\\a\\_temp\\with space\\xpod-package-smoke-bun';
    const env={...process.env,SOURCE_SHA:'a'.repeat(40),GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'2',LANE_OS:'windows-latest',LANE_NODE:'22',LANE_RUNTIME:'bun',CONSUMER_ROOT:consumer};
    const result=spawnSync('bash',['-c',step.run],{cwd:root,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const actual=JSON.parse(result.stdout);assert.equal(actual.args.consumerRoot,consumer);assert.equal(actual.args.sourceSha,env.SOURCE_SHA);
    assert.equal(actual.args.runId,'42');assert.equal(actual.args.runAttempt,'2');assert.equal(actual.path,env.PATH);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

const { verifyCompatSourceObservation } = require('../../scripts/release-gate-evidence.cjs');
const uiTargets = require('../../ui/build-targets.json');
function uiObservation() {
  return { before: ['static/app/assets/old.js'], generated: Object.entries(uiTargets).map(([target, config]) => ({
    target, outDir: config.outDir, files: ['assets/new.js', target === 'app' ? 'index.html' : target + '.html'],
  })) };
}
test('producer declarations accept generated replacements while preserving the original status', () => {
  const status = ' D static/app/assets/old.js\n M static/settings/settings.html\n?? static/app/assets/new.js';
  assert.doesNotThrow(() => verifyCompatSourceObservation(status, uiObservation()));
  assert.equal(status.split('\n')[0], ' D static/app/assets/old.js');
  const config = fs.readFileSync('ui/vite.config.ts', 'utf8');
  assert.match(config, /import buildTargets from '\.\/build-targets.json'/);
  assert.match(config, /const configs = buildTargets/);
});
for (const status of [' M bun.lock', ' M package.json', ' M ui/vite.config.ts', ' M ui/src/input.ts',
  '?? static/app/assets/unknown.js', ' M static/app/assets/unknown.js', '?? static/unowned/output.js',
  ' D static/app/assets/unknown.js', 'M  static/app/assets/new.js', '?? static/app/../input.ts']) {
  test('rejects source drift or unobserved static output: ' + status, () => {
    assert.throws(() => verifyCompatSourceObservation(status, uiObservation()), /source input or unknown output/);
  });
}
test('producer evidence cannot redirect output roots, omit a target, or escape a member', () => {
  for (const mutate of [o => { o.generated[0].outDir = '../src'; }, o => { o.generated.pop(); },
    o => { o.generated[0].files.push('../escape'); }, o => { o.before.push('src/input.ts'); }]) {
    const observation = uiObservation(); mutate(observation);
    assert.throws(() => verifyCompatSourceObservation('?? static/app/assets/new.js', observation));
  }
  assert.throws(() => verifyCompatSourceObservation('?? static/app/assets/new.js'), /observation missing/);
});
test('downloaded lane evidence revalidates generated observations and rejects their tampering', () => fixture(({receipts,args}) => {
  const row = receipts[0], file = path.join(row.directory, 'source-observation.json');
  const bytes = Buffer.from(JSON.stringify(uiObservation())); fs.writeFileSync(file, bytes);
  row.receipt.sourceAfterStatus = ' D static/app/assets/old.js\n?? static/app/assets/new.js';
  row.receipt.sourceObservation = { path: 'source-observation.json', bytes: bytes.length, sha256: digest(bytes) }; row.save();
  assert.equal(verifyRootCompat(args).lanes.length, 18);
  row.receipt.sourceAfterStatus += '\n M bun.lock'; row.save(); assert.throws(() => verifyRootCompat(args), /source input/);
  row.receipt.sourceAfterStatus = '?? static/app/assets/new.js'; row.save();
  fs.appendFileSync(file, ' '); assert.throws(() => verifyRootCompat(args), /hash mismatch/);
}));
