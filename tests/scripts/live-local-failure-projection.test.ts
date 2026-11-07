import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,symlinkSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {
  MANAGED_LOCAL_LIVE_STAGES,MANAGED_LOCAL_IDENTITY_SUBSTAGES,
  projectManagedLocalLiveFailure,readManagedLocalLiveFailure,
} from '../../scripts/accept-service-image-modes';

/** These tests execute the REAL exported projection/reader. They deliberately do
 * not mirror the implementation, so a broken projection fails here. */

const layers=(over:Record<string,unknown>={})=>Object.fromEntries(
  MANAGED_LOCAL_LIVE_STAGES.map(stage=>[stage,{ok:stage in over?over[stage]:true,detail:'x'}]));

test('an explicit failed stage is reported verbatim even when it is out of layer order',()=>{
  // aiConnections can fail while gatewayAuth (a LATER layer) is still not run.
  const report={mode:'local',layers:layers({gatewayAuth:false,aiConnections:false}),failedStage:'aiConnections'};
  const out=projectManagedLocalLiveFailure(report)!;
  expect(out.stage).toBe('aiConnections');
  expect(out.status).toBe('failed');
  expect(out.mode).toBe('local');
  // Completed count is a fact about ok:true across ALL layers, never a prefix of
  // the failure stage: here models/chat are still ok while aiConnections failed.
  expect(out.completedLayers).toBe(5);
});

test('all layers successful but a throw after them reports the after-layers sentinel',()=>{
  const report={mode:'cloud',layers:layers(),failedStage:'after-layers'};
  const out=projectManagedLocalLiveFailure(report)!;
  expect(out.stage).toBe('after-layers');
  expect(out.completedLayers).toBe(MANAGED_LOCAL_LIVE_STAGES.length);
});

test('a preflight failure before any layer is reported as preflight, not runtime',()=>{
  const report={mode:'standalone',layers:Object.fromEntries(MANAGED_LOCAL_LIVE_STAGES.map(s=>[s,{ok:false,detail:'not run'}])),failedStage:'preflight'};
  expect(projectManagedLocalLiveFailure(report)!.stage).toBe('preflight');
  expect(projectManagedLocalLiveFailure(report)!.completedLayers).toBe(0);
});

test('missing, malformed, or stage-less reports yield undefined instead of an inferred stage',()=>{
  expect(projectManagedLocalLiveFailure(undefined)).toBeUndefined();
  expect(projectManagedLocalLiveFailure(null)).toBeUndefined();
  expect(projectManagedLocalLiveFailure({})).toBeUndefined();
  expect(projectManagedLocalLiveFailure({mode:'local'})).toBeUndefined();
  // all ok with no explicit failure stage: nothing failed, so nothing is claimed
  expect(projectManagedLocalLiveFailure({mode:'local',layers:layers()})).toBeUndefined();
  // non-enum phase must not be accepted
  expect(projectManagedLocalLiveFailure({mode:'local',layers:layers(),failedStage:'some-private-message'})).toBeUndefined();
  expect(projectManagedLocalLiveFailure({mode:'bogus',layers:layers(),failedStage:'chat'})).toBeUndefined();
});

test('a Local identity substage is projected only when it is a known fixed value',()=>{
  const report={mode:'local',layers:layers({identity:false}),failedStage:'identity',substage:'managed-pod-claim'};
  expect(projectManagedLocalLiveFailure(report)!.substage).toBe('managed-pod-claim');
  const bogus={mode:'local',layers:layers({identity:false}),failedStage:'identity',substage:'secret detail here'};
  expect(projectManagedLocalLiveFailure(bogus)!.substage).toBeUndefined();
  expect(MANAGED_LOCAL_IDENTITY_SUBSTAGES).toContain('route-discovery');
});

test('runtime diagnostics pass through only as fixed reason plus numeric status',()=>{
  const base={mode:'local',layers:layers({runtime:false}),failedStage:'runtime'};
  const ok=projectManagedLocalLiveFailure({...base,runtimeReason:'discovery-http',runtimeHttpStatus:503})!;
  expect(ok.runtimeReason).toBe('discovery-http');
  expect(ok.runtimeHttpStatus).toBe(503);
  // unknown reason and out-of-range status are dropped, not guessed
  const bad=projectManagedLocalLiveFailure({...base,runtimeReason:'totally-secret-host',runtimeHttpStatus:9999})!;
  expect(bad.runtimeReason).toBeUndefined();
  expect(bad.runtimeHttpStatus).toBeUndefined();
  // a non-integer status is dropped too
  expect(projectManagedLocalLiveFailure({...base,runtimeHttpStatus:5.5})!.runtimeHttpStatus).toBeUndefined();
  // diagnostics carry no URL/host/body — only the fixed code and the number
  const wire=JSON.stringify(ok);
  expect(wire).not.toContain('://');
  expect(wire).not.toContain('localhost');
  expect(Object.keys(ok).sort()).toEqual(['completedLayers','mode','runtimeHttpStatus','runtimeReason','stage','status']);
});

test('runtime diagnostics are emitted ONLY when the failed stage is runtime',()=>{
  const withReason={runtimeReason:'discovery-http',runtimeHttpStatus:503};
  // runtime: passes through
  const rt=projectManagedLocalLiveFailure({mode:'local',layers:layers({runtime:false}),failedStage:'runtime',...withReason})!;
  expect(rt.runtimeReason).toBe('discovery-http');
  expect(rt.runtimeHttpStatus).toBe(503);
  // a non-runtime stage must not carry stale runtime fields, even if present
  const id=projectManagedLocalLiveFailure({mode:'local',layers:layers({identity:false}),failedStage:'identity',...withReason})!;
  expect(id.runtimeReason).toBeUndefined();
  expect(id.runtimeHttpStatus).toBeUndefined();
  expect(Object.keys(id).sort()).toEqual(['completedLayers','mode','stage','status']);
});

test('service-status-invalid is a distinct emitted reason',()=>{
  const got=projectManagedLocalLiveFailure({mode:'local',layers:layers({runtime:false}),failedStage:'runtime',runtimeReason:'service-status-invalid',runtimeHttpStatus:200})!;
  expect(got.runtimeReason).toBe('service-status-invalid');
  expect(got.runtimeHttpStatus).toBe(200);
});

test('private payload carried by a report is never exported',()=>{
  const report={
    mode:'local',
    layers:layers({chat:false}),
    failedStage:'chat',
    baseUrl:'https://secret.example/token',
    webId:'https://secret.example/profile#me',
    provider:'deepseek',modelIds:['deepseek-v4-pro'],
    layerDetailText:'Bearer sk-live-abcdefghijklmnop',
    localRoute:{canonicalBaseUrl:'https://secret.example/'},
  };
  const out=projectManagedLocalLiveFailure(report)!;
  const serialized=JSON.stringify(out);
  for(const secret of ['secret.example','Bearer','sk-live','deepseek','layerDetailText','webId','baseUrl']){
    expect(serialized).not.toContain(secret);
  }
  expect(Object.keys(out).sort()).toEqual(['completedLayers','mode','stage','status']);
});

test('the real reader reads the child file and rejects symlinked or absent evidence',async()=>{
  const parent=join(process.cwd(),'.test-data','live-local-failure-projection');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'reader-'));
  try{
    const evidence=join(root,'.test-data','acceptance');
    mkdirSync(evidence,{recursive:true});
    writeFileSync(join(evidence,'live-gateway-login-chat-local.json'),
      JSON.stringify({mode:'local',layers:layers({models:false}),failedStage:'models'}));
    const ok=await readManagedLocalLiveFailure(root,'local');
    expect(ok?.stage).toBe('models');
    // absent file -> undefined, never an inferred stage
    expect(await readManagedLocalLiveFailure(root,'cloud')).toBeUndefined();
    // a symlinked report must be rejected by the existing reader, not followed
    const outside=join(root,'outside.json');
    writeFileSync(outside,JSON.stringify({mode:'local',layers:layers(),failedStage:'chat'}));
    rmSync(join(evidence,'live-gateway-login-chat-local.json'));
    symlinkSync(outside,join(evidence,'live-gateway-login-chat-local.json'));
    expect(await readManagedLocalLiveFailure(root,'local')).toBeUndefined();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a failing real canary child preserves its explicit stage through the reader',async()=>{
  const parent=join(process.cwd(),'.test-data','live-local-failure-projection');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'child-'));
  // Spawn through node:child_process (Bun.spawn is not in the test tsconfig types)
  // while running the real child script under Bun, exactly as the matrix does.
  const child=spawn(process.execPath,['--no-env-file',join(process.cwd(),'scripts','accept-live-gateway-login-chat.ts')],{
    cwd:root,
    env:{PATH:process.env.PATH,XPOD_LIVE_MODE:'local',XPOD_BASE_URL:'http://127.0.0.1:0/'},
    stdio:'ignore',
  });
  const exited=new Promise<number|null>(resolve=>child.once('exit',(code:number|null)=>resolve(code)));
  const timeout=setTimeout(()=>child.kill(),10_000);
  try{
    expect(await exited).toBe(1);
    const report=JSON.parse(readFileSync(join(root,'.test-data','acceptance','live-gateway-login-chat-local.json'),'utf8'));
    expect(report.failedStage).toBe('runtime');
    expect(report.layers.identity.detail).toBe('not run');
    // The real child now also names WHICH runtime check failed, so a future run
    // never needs to guess between discovery and service/status.
    expect(await readManagedLocalLiveFailure(root,'local')).toEqual({
      mode:'local',stage:'runtime',status:'failed',completedLayers:0,
      runtimeReason:'discovery-unreachable',
    });
  }finally{
    clearTimeout(timeout);
    if(child.exitCode===null)child.kill();
    await exited;
    rmSync(root,{recursive:true,force:true});
  }
},15_000);

test('real child: restored 5s bound abandons a stalled discovery and says unreachable',async()=>{
  const {createServer}=await import('node:http');
  const {spawn}=await import('node:child_process');
  const srv=createServer(()=>{/* never answer */});
  await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()));
  const port=(srv.address() as any).port;
  const parent=join(process.cwd(),'.test-data','live-local-failure-projection');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'bound-'));
  const t0=Date.now();
  try{
    const child=spawn(process.execPath,['--no-env-file',join(process.cwd(),'scripts','accept-live-gateway-login-chat.ts')],{
      cwd:root,env:{PATH:process.env.PATH,XPOD_LIVE_MODE:'local',XPOD_BASE_URL:`http://127.0.0.1:${port}/`},stdio:'ignore'});
    const code=await new Promise<number|null>(r=>child.once('exit',r));
    const elapsed=Date.now()-t0;
    expect(code).toBe(1);
    // The bound must hold: fail fast instead of holding the job open.
    expect(elapsed < 15_000).toBe(true);
    const rep=JSON.parse(readFileSync(join(root,'.test-data','acceptance','live-gateway-login-chat-local.json'),'utf8'));
    expect(rep.failedStage).toBe('runtime');
    expect(rep.runtimeReason).toBe('discovery-unreachable');
    expect(rep.runtimeHttpStatus).toBeUndefined();
  }finally{srv.close();rmSync(root,{recursive:true,force:true});}
},30_000);

test('real child: an OK but non-array service/status is service-status-invalid',async()=>{
  const {createServer}=await import('node:http');
  const {spawn}=await import('node:child_process');
  const srv=createServer((req,res)=>{
    if(req.url==='/.well-known/openid-configuration'){res.writeHead(200,{'content-type':'application/json'});res.end('{"issuer":"http://127.0.0.1/"}');return;}
    if(req.url==='/service/status'){res.writeHead(200,{'content-type':'application/json'});res.end('{"not":"an array"}');return;}
    res.writeHead(404);res.end();
  });
  await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()));
  const port=(srv.address() as any).port;
  const parent=join(process.cwd(),'.test-data','live-local-failure-projection');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'invalid-'));
  try{
    const child=spawn(process.execPath,['--no-env-file',join(process.cwd(),'scripts','accept-live-gateway-login-chat.ts')],{
      cwd:root,env:{PATH:process.env.PATH,XPOD_LIVE_MODE:'local',XPOD_BASE_URL:`http://127.0.0.1:${port}/`},stdio:'ignore'});
    const code=await new Promise<number|null>(r=>child.once('exit',r));
    expect(code).toBe(1);
    const rep=JSON.parse(readFileSync(join(root,'.test-data','acceptance','live-gateway-login-chat-local.json'),'utf8'));
    expect(rep.failedStage).toBe('runtime');
    expect(rep.runtimeReason).toBe('service-status-invalid');
    expect(rep.runtimeHttpStatus).toBe(200);
  }finally{srv.close();rmSync(root,{recursive:true,force:true});}
},30_000);
