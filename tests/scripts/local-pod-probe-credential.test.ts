import {test,expect} from 'bun:test';
import path from 'node:path';

/** RC385: Cloud failed podReadWrite at 2 completed layers. The Pod probe had been
 * sending `Authorization: Bearer sk-<base64(clientId:secret)>` straight to Pod LDP.
 *
 * The Gateway accepts the `sk-` wrapper for API calls and exchanges its decoded
 * client credentials at the token endpoint. This direct Pod probe instead reuses
 * the client's exchanged access token and DPoP key through its session transport.
 *
 * These tests drive the REAL exported production probe (`probePodReadWrite`, the same
 * function `main` calls) against a REAL Xpod runtime, using the REAL production login.
 * No hand-written authorization server, no parallel copy of the exchange or the probe.
 *
 * Scope: the auth/transport layer and Pod I/O. This is NOT three-mode RC acceptance.
 * The `local` profile does not enforce Pod authorization, so it cannot demonstrate a
 * rejected credential; the intended deployment (Cloud) is still unverified end-to-end. */

const {XpodTestStack}=await import('../helpers/XpodTestStack');
const {setupAccount,loginWithClientCredentials}=await import('../integration/helpers/solidAccount');
const {probePodReadWrite,podProbeTransport}=await import('../../scripts/accept-live-gateway-login-chat');

test('the REAL production probe writes and reads a Pod through the exchanged DPoP session',async()=>{
  const stack=new XpodTestStack();
  await stack.start('local',{transport:'port',runtimeRoot:path.resolve('.test-data','rc385-probe-test')});
  try{
    const base=stack.baseUrl;
    const account=await setupAccount(base,'rc385probe');
    expect(account).not.toBeNull();
    // `loginWithClientCredentials(account, authenticatedTransport)` applies the
    // exchanged DPoP token and proof *above* this transport, so observing here sees
    // exactly what the real library puts on the wire - without capturing secrets.
    const seen:Array<{scheme:string;hasProof:boolean;method:string}>=[];
    const observedTransport:typeof fetch=async(input,init)=>{
      const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
      const auth=headers.get('authorization')??'';
      seen.push({scheme:auth.split(' ')[0]??'',hasProof:Boolean(headers.get('dpop')),method:(init?.method??'GET').toUpperCase()});
      return fetch(input,init);
    };
    const session=await loginWithClientCredentials(account!,observedTransport);
    expect(session.info.isLoggedIn).toBe(true);

    const acceptId=`rc385-${Date.now().toString(36)}`;
    // Use the REAL production transport selection, so changing it breaks this test.
    const result=await probePodReadWrite({
      fetch:podProbeTransport(session),
      probeUrl:new URL(`acceptance/${acceptId}.ttl`,account!.podUrl).toString(),
      probeBody:`@prefix xpod: <https://undefineds.co/ns#> .\n<> a xpod:AcceptanceProbe ;\n  xpod:id "${acceptId}" .\n`,
      acceptId,
    });

    expect(result).toEqual({ok:true,status:200,detail:'pod probe ok'});
    // The probe really issued a DPoP-bound PUT then GET through the exchanged session.
    const put=seen.find(s=>s.method==='PUT');
    const get=seen.find(s=>s.method==='GET');
    expect(put).toBeDefined();
    expect(get).toBeDefined();
    expect(put!.scheme).toBe('DPoP');
    expect(get!.scheme).toBe('DPoP');
    expect(put!.hasProof).toBe(true);
    expect(get!.hasProof).toBe(true);
    // No wrapper credential ever reached the Pod boundary.
    expect(seen.some(s=>s.scheme==='Bearer')).toBe(false);
  }finally{await stack.stop();}
},180_000);

test('the REAL production probe reports a fixed reason and integer status when the Pod refuses',async()=>{
  // A Pod that rejects the write: the helper must classify it, not throw, and must
  // return only fixed facts (no body or header text).
  const {createServer}=await import('node:http');
  const srv=createServer((req,res)=>{
    res.writeHead(req.method==='PUT'?403:200,{'content-type':'text/turtle','www-authenticate':'DPoP error="invalid_token"'});
    res.end('secret-body-should-not-surface');
  });
  await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()));
  const origin=`http://127.0.0.1:${(srv.address() as any).port}/`;
  try{
    const result=await probePodReadWrite({
      fetch,probeUrl:`${origin}pod/x.ttl`,probeBody:'<> <a> <b> .',acceptId:'abc',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('put-http');
    expect(result.status).toBe(403);
    // Only a fixed classification and status may leave the probe.
    expect(result.detail).not.toContain('secret-body-should-not-surface');
  }finally{await new Promise<void>(r=>srv.close(()=>r()));}
});

test('a hostile WWW-Authenticate header never reaches the result JSON',async()=>{
  // A realm marker that no generic secret regex would catch, plus a URL and a field
  // name, to prove the whole result is free of header/URL/body text.
  const marker='realm="private-catalog-zone"';
  const {createServer}=await import('node:http');
  const srv=createServer((_req,res)=>{
    res.writeHead(401,{
      'content-type':'text/turtle',
      'www-authenticate':`DPoP ${marker} error="invalid_token"`,
    });
    res.end('<https://secret.internal/pod/x.ttl> private-body-marker');
  });
  await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()));
  const origin=`http://127.0.0.1:${(srv.address() as any).port}/`;
  try{
    const result=await probePodReadWrite({fetch,probeUrl:`${origin}pod/x.ttl`,probeBody:'x',acceptId:'abc'});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('put-http');
    expect(result.status).toBe(401);
    // Fixed detail only.
    expect(result.detail).toBe('Pod PUT HTTP 401');
    const wire=JSON.stringify(result);
    for(const leak of [marker,'private-catalog-zone','www-authenticate','DPoP','secret.internal','private-body-marker','http://','https://']){
      expect(wire).not.toContain(leak);
    }
  }finally{await new Promise<void>(r=>srv.close(()=>r()));}
});

test('a failing GET response body stream is classified, not thrown',async()=>{
  // Deterministic fault injection: a real Response whose body stream errors mid-read.
  const stream=new ReadableStream<Uint8Array>({
    start(controller){
      controller.enqueue(new TextEncoder().encode('partial'));
      controller.error(new Error('private-stream-failure-marker'));
    },
  });
  const faultingFetch:typeof fetch=async(input,init)=>{
    const method=(init?.method??'GET').toUpperCase();
    if(method==='PUT')return new Response(null,{status:201});
    return new Response(stream,{status:200,headers:{'content-type':'text/turtle'}});
  };
  const result=await probePodReadWrite({
    fetch:faultingFetch,probeUrl:'http://127.0.0.1:1/pod/x.ttl',probeBody:'x',acceptId:'abc',
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('get-http');
  expect(result.status).toBe(200);
  const wire=JSON.stringify(result);
  expect(wire).not.toContain('private-stream-failure-marker');
  expect(wire).not.toContain('partial');
  expect(wire).not.toContain('http://');
});

test('a GET whose content does not carry the id is a content-mismatch',async()=>{
  const {createServer}=await import('node:http');
  const srv=createServer((req,res)=>{
    if(req.method==='PUT'){res.writeHead(201);res.end();return;}
    res.writeHead(200,{'content-type':'text/turtle'});res.end('<> <a> <b> .');
  });
  await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()));
  const origin=`http://127.0.0.1:${(srv.address() as any).port}/`;
  try{
    const result=await probePodReadWrite({fetch,probeUrl:`${origin}pod/x.ttl`,probeBody:'x',acceptId:'missing-id'});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('content-mismatch');
    expect(result.status).toBe(200);
  }finally{await new Promise<void>(r=>srv.close(()=>r()));}
});
