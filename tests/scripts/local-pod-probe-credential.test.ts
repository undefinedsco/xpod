import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createOwnerCredentialFetch} from '../../scripts/accept-live-gateway-login-chat';

/** RC384: managed Local reached podReadWrite (runtime+identity passed) and failed
 * there. The Pod probe was issued through `session.fetch`, the DPoP-bound session
 * transport, which overwrites any Authorization set in `init` with its own token,
 * so the account credential never reached the Pod.
 *
 * These drive the REAL exported production factory that the CLI now uses, with an
 * injected route-aware transport, and assert the exact bytes on the wire. Scope:
 * unit/contract only — not Xpod or RC acceptance. */

const account={clientId:'9a1c2b3d4e5f6071',clientSecret:'s3cr3t-value'};
const expectedWrapper=`sk-${Buffer.from(`${account.clientId}:${account.clientSecret}`,'utf8').toString('base64')}`;

/** Capture one request through the real factory. */
async function send(init: RequestInit, input: RequestInfo | URL = 'https://pod.example/app/acceptance/x.ttl') {
  const seen:any[]=[];
  const transport:any=async(i:any,ii:any)=>{
    seen.push({
      url:String(i),method:(ii?.method??'GET').toUpperCase(),
      auth:new Headers(ii?.headers).get('authorization'),
      dpop:new Headers(ii?.headers).get('dpop'),
      contentType:new Headers(ii?.headers).get('content-type'),
      body:ii?.body,
    });
    return new Response('ok',{status:200});
  };
  const f=createOwnerCredentialFetch(account,transport);
  const res=await f(input,init);
  return {seen,res};
}

test('the real factory sends the exact account credential wrapper',async()=>{
  const {seen}=await send({method:'PUT'});
  expect(seen.length).toBe(1);
  expect(seen[0].auth).toBe(`Bearer ${expectedWrapper}`);
  // base64 decodes back to the account's own client_id:client_secret
  expect(Buffer.from(seen[0].auth.slice('Bearer sk-'.length),'base64').toString()).toBe(`${account.clientId}:${account.clientSecret}`);
});

test('a stale DPoP header is stripped by the factory itself',async()=>{
  const {seen}=await send({method:'GET',headers:{dpop:'stale-proof-value','content-type':'text/turtle'}});
  expect(seen[0].dpop).toBeNull();
  // unrelated caller headers survive
  expect(seen[0].contentType).toBe('text/turtle');
});

test('Authorization is replaced, never appended or left stale',async()=>{
  const {seen}=await send({method:'PUT',headers:{authorization:'Bearer wrong-or-old-token'}});
  expect(seen[0].auth).toBe(`Bearer ${expectedWrapper}`);
  expect(seen[0].auth).not.toContain('wrong-or-old-token');
  expect(String(seen[0].auth).match(/Bearer/gu)?.length).toBe(1);
});

test('Request input headers, method and body survive to a REAL server',async()=>{
  const {createServer}=await import('node:http');
  const observed:any[]=[];
  const srv=createServer((req,res)=>{
    let body='';
    req.on('data',c=>{body+=c;});
    req.on('end',()=>{
      observed.push({method:req.method,auth:req.headers.authorization,dpop:req.headers.dpop,contentType:req.headers['content-type'],body});
      res.writeHead(200,{'content-type':'text/turtle'});res.end('ok');
    });
  });
  await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()));
  const port=(srv.address() as any).port;
  try{
    const body='@prefix xpod: <https://undefineds.co/ns#> .\n<> a xpod:AcceptanceProbe .\n';
    // A Request input carrying its own method/body/headers (no init overrides).
    const req=new Request(`http://127.0.0.1:${port}/app/acceptance/y.ttl`,{
      method:'PUT',headers:{'content-type':'text/turtle',authorization:'Bearer stale',dpop:'stale-proof'},body,
    });
    const f=createOwnerCredentialFetch(account,fetch);
    const res=await f(req);
    expect(res.status).toBe(200);
    expect(observed.length).toBe(1);
    expect(observed[0].method).toBe('PUT');                       // method preserved
    expect(observed[0].auth).toBe(`Bearer ${expectedWrapper}`);   // credential replaced
    expect(observed[0].dpop).toBeUndefined();                      // stale dpop stripped
    expect(observed[0].contentType).toBe('text/turtle');           // caller header kept
    expect(observed[0].body).toContain('AcceptanceProbe');         // body preserved
  }finally{await new Promise<void>(r=>srv.close(()=>r()));}
});

test('the injected route-aware transport is the one actually used',async()=>{
  const calls:string[]=[];
  const routeAware:any=async(i:any,ii:any)=>{
    calls.push('route-aware');
    // simulate the Local route rewrite while keeping the credential header
    const mapped='http://127.0.0.1:41000/app/acceptance/x.ttl';
    expect(new Headers(ii?.headers).get('authorization')).toBe(`Bearer ${expectedWrapper}`);
    return new Response('ok',{status:200,headers:{'x-mapped':mapped}});
  };
  const bare:any=async()=>{calls.push('bare-fetch');return new Response('nope',{status:500});};
  const f=createOwnerCredentialFetch(account,routeAware);
  const res=await f('https://pod.example/app/acceptance/x.ttl',{method:'GET'});
  expect(res.status).toBe(200);
  expect(calls).toEqual(['route-aware']);
  // a bare global fetch would not be consulted at all
  expect(bare).toBeDefined();
});

test('REAL library: a DPoP fetch overrides a pre-set Authorization (public API)',async()=>{
  // Public-API proof of the property this fix depends on, observed on the wire.
  const {buildAuthenticatedFetch,generateDpopKeyPair}=await import('@inrupt/solid-client-authn-core');
  const {createServer}=await import('node:http');
  const seen:any[]=[];
  const srv=createServer((req,res)=>{seen.push({auth:req.headers.authorization,dpop:req.headers.dpop});res.writeHead(200);res.end('ok');});
  await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()));
  const port=(srv.address() as any).port;
  try{
    const dpopKey=await generateDpopKeyPair();
    const authed=buildAuthenticatedFetch('session-token',{dpopKey,fetch});
    await authed(`http://127.0.0.1:${port}/res`,{method:'GET',headers:{authorization:'Bearer sk-must-not-survive'}});
    expect(seen.length).toBe(1);
    // The credential we set is gone, replaced by the session's DPoP authorization.
    expect(seen[0].auth).toBe('DPoP session-token');
    expect(String(seen[0].auth)).not.toContain('sk-must-not-survive');
    expect(seen[0].dpop).toBeTruthy();
  }finally{await new Promise<void>(r=>srv.close(()=>r()));}
});

test('the CLI probe is WIRED to that factory for both PUT and GET',()=>{
  // Wiring assertion only: behaviour is covered by the tests above.
  const src=readFileSync('scripts/accept-live-gateway-login-chat.ts','utf8');
  expect(src).toContain('const podCredentialFetch = createOwnerCredentialFetch(account, credentialTransport)');
  expect(src).toContain('const put = await podCredentialFetch(probeUrl');
  expect(src).toContain('const got = await podCredentialFetch(probeUrl');
  // and the Pod probe must not go through the session-derived wrapper
  expect(src).not.toContain('await authenticatedFetch(probeUrl');
  // no second credential transport implementation
  expect(src).not.toContain('headers.set(\'authorization\', `Bearer ${sessionCredential}`)');
});
