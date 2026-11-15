const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks'),ts=require('typescript');
const ROOT=path.resolve(__dirname,'../..'),SHARED=path.join(ROOT,'scripts/lib/independent-admission/sdk-selected-original-command.ts'),UPSTREAM=path.join(ROOT,'scripts/lib/independent-admission/qlever-sdk-upstream-source.ts');
function sharedModule(){const js=ts.transpileModule(fs.readFileSync(SHARED,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText;const file=path.join(ROOT,'scripts/lib/independent-admission/.shared-selected-'+process.pid+'.cjs');fs.writeFileSync(file,js.replace(/const sourceRequire = \(0, node_module_1\.createRequire\)\(__filename\);/, 'const sourceRequire = require;'));try{return require(file)}finally{fs.unlinkSync(file)}}
const upstreamAst=ts.createSourceFile('upstream.ts',fs.readFileSync(UPSTREAM,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let planInitializer=null;
(function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(upstreamAst)==='observerPlan')planInitializer=node.initializer.getText(upstreamAst);ts.forEachChild(node,visit);})(upstreamAst);
assert.ok(planInitializer,'actual production observerPlan missing');
const planCode=ts.transpileModule(planInitializer,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None}}).outputText;
async function scenario(kind){
 const base=path.join(ROOT,'.test-data/sdk-selected-window');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'case-'));
 try{
  const child=path.join(dir,'child.py');
  const body=kind==='deadline'?'time.sleep(2);sys.stdout.write("{}")':kind==='bothstreams'?'sys.stdout.write("x"*8000);sys.stderr.write("y"*8000)':kind==='nonzero'?'sys.stderr.write("bad\\n");sys.exit(3)':'sys.stdout.write("{}")';
  fs.writeFileSync(child,'import sys,time\nsys.stdin.buffer.read()\n'+body+'\n');
  const window=kind==='deadline'?900:kind==='postexpire'?300:5000,start=performance.now();let remaining=kind==='bothstreams'?20000:kind==='exhausted'?1:100000,charged=0,spawns=0,options,received,spawnRemaining,error,result;const charges=[];let reserved=0;
  const budget={check(){if(performance.now()-start>=window)throw Error('parent deadline expired');},remainingMs(){return window-(performance.now()-start);},remainingReadBytes(){return remaining;},reserveBytes(n){reserved+=n;if(kind==='deadline'&&spawns===0){const until=performance.now()+100;while(performance.now()<until){}}},chargeReadBytes(n){assert.ok(Number.isSafeInteger(n)&&n>=0);charges.push(n);charged+=n;remaining-=n;if(remaining<0)throw Error('parent read budget exceeded');}};
  const runner=require(path.join(ROOT,'scripts/lib/owned-mode-command.cjs'));
  const originalRun=runner.runOwnedModeCommand;runner.runOwnedModeCommand=async(...args)=>{spawns++;options=args[2];spawnRemaining=budget.remainingMs();received=await originalRun(...args);return received;};
  const {runSdkSelectedOriginalCommand}=sharedModule();
  const planBase={padding:'p'.repeat(kind==='bothstreams'?10000:1)};
  const observerPlanFn=new Function('planBase','return '+planCode)(planBase);
  try{
   result=await runSdkSelectedOriginalCommand({
    archiveIdentity:{bytes:1,sha256:'a'.repeat(64)},
    async withArchiveFile(use){if(kind==='deadline')await new Promise(r=>setTimeout(r,350));const value=await use({path:'unused',identity:{bytes:1,sha256:'a'.repeat(64)}});if(kind==='postthrow')throw Error('outer custody revoked');if(kind==='postexpire'){await new Promise(r=>setTimeout(r,350));budget.check();}return value;},
    python:'/usr/bin/python3',helperPath:child,
    createPlan(remainingMs){return observerPlanFn(['main.c'],remainingMs)},
    remainingMs:()=>window, budget,
   });
  }catch(e){error=e;}finally{runner.runOwnedModeCommand=originalRun;}
  const measured={kind,charged,reserved,remaining,spawns,options,received,spawnRemaining,error,errorMessage:error?.message,charges};
  return measured;
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('actual child uses post-custody and post-plan remaining deadline',async()=>{const r=await scenario('deadline');assert.equal(r.spawns,1);assert.ok(r.options.timeoutMs<=r.spawnRemaining+1);assert.ok(r.options.timeoutMs<550);assert.ok(r.received.record.timedOut);assert.ok(r.received.record.groupAbsent);assert.ok(r.error);});
test('plan charge precedes both output caps and truncated received bytes remain charged',async()=>{const r=await scenario('bothstreams');assert.equal(r.spawns,1);assert.equal(r.options.outputBytes,Math.floor((20000-r.charges[0]-2)/4));assert.ok(r.received.record.outputTruncated);const bytes=r.received.record.receivedStdoutBytes+r.received.record.receivedStderrBytes;assert.ok(bytes>0);assert.ok(r.remaining>=0,'failed reads must remain inside same parent budget');assert.equal(r.charged,r.options.input.length+bytes);assert.ok(r.error);});
test('failed child stderr is charged before its rejection',async()=>{const r=await scenario('nonzero');assert.equal(r.received.record.code,3);assert.equal(r.received.record.receivedStderrBytes,4);assert.equal(r.charged,r.options.input.length+4);assert.ok(r.error);});
test('outer custody rejection cannot omit callback output charge',async()=>{const r=await scenario('postthrow');assert.match(r.errorMessage,/outer custody revoked/);assert.equal(r.charged,r.options.input.length+2);});
test('exhausted plan budget prevents any spawn',async()=>{const r=await scenario('exhausted');assert.equal(r.spawns,0);assert.ok(r.error);});

test('successful child charges each logical delivery once',async()=>{const r=await scenario('success');assert.equal(r.error,undefined);assert.equal(r.received.record.code,0);assert.ok(r.received.record.groupAbsent);assert.equal(r.charged,r.options.input.length+2);});
test('custody expiration after successful child still retains actual output charge',async()=>{const r=await scenario('postexpire');assert.equal(r.received.record.code,0);assert.ok(r.received.record.groupAbsent);assert.match(r.errorMessage,/parent deadline expired/);assert.equal(r.charged,r.options.input.length+2);});
