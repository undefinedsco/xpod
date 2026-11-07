import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {preflightIdentityOrigin,probeIdentityDiscovery} from '../../scripts/accept-live-gateway-login-chat';

/** RC383: the canary's unconditional pre-flight probed the Local origin's own
 * `.well-known/openid-configuration`. Managed Local is NOT its own IdP (it is the
 * storage/provision target; its configured issuer is the Cloud), so that endpoint
 * answers 404 by contract and the run died in stage `runtime` with
 * runtimeReason=discovery-http / runtimeHttpStatus=404.
 *
 * Scope: these drive the REAL exported preflight functions against tiny local
 * HTTP servers and record actual requests. They are unit fixtures, not Xpod or RC
 * acceptance; only a new RC can qualify the whole mode matrix. */

const server=(handler:(path:string)=>[number,string])=>
  new Promise<{url:string;hits:string[];close:()=>Promise<void>}>((resolve)=>{
    const hits:string[]=[];
    const srv=createServer((req,res)=>{
      hits.push(String(req.url));
      const [code,body]=handler(String(req.url));
      res.writeHead(code,{'content-type':'application/json'});
      res.end(body);
    });
    srv.listen(0,'127.0.0.1',()=>{
      const port=(srv.address() as any).port;
      resolve({url:`http://127.0.0.1:${port}/`,hits,close:()=>new Promise(r=>srv.close(()=>r()))});
    });
  });

test('managed Local verifies the Cloud issuer origin, never the Local root',()=>{
  // The authoritative origin for managed Local is the configured Cloud IdP.
  expect(preflightIdentityOrigin('local','http://127.0.0.1:41001/','http://cloud.localhost:16300/'))
    .toBe('http://cloud.localhost:16300/');
  // Cloud and Standalone remain their own issuer.
  expect(preflightIdentityOrigin('cloud','http://localhost:41002/','http://cloud.localhost:16300/'))
    .toBe('http://localhost:41002/');
  expect(preflightIdentityOrigin('standalone','http://localhost:41003/','http://cloud.localhost:16300/'))
    .toBe('http://localhost:41003/');
});

test('Local root 404 is never probed as an IdP; the Cloud issuer IS probed',async()=>{
  // Local root behaves exactly like the product contract: 404 on discovery.
  const localRoot=await server(()=>[404,'{"error":"not found"}']);
  const cloudIdp=await server(()=>[200,'{"issuer":"http://cloud.localhost:16300/"}']);
  try{
    const origin=preflightIdentityOrigin('local',localRoot.url,cloudIdp.url);
    expect(origin).toBe(cloudIdp.url);

    const result=await probeIdentityDiscovery(origin);
    expect(result).toEqual({status:200,ok:true});

    // The Cloud issuer was actually contacted...
    expect(cloudIdp.hits).toEqual(['/.well-known/openid-configuration']);
    // ...and the Local root was never touched for IdP discovery.
    expect(localRoot.hits).toEqual([]);
  }finally{await localRoot.close();await cloudIdp.close();}
});

test('Cloud and Standalone still verify their own origin (unchanged contract)',async()=>{
  const own=await server(()=>[200,'{"issuer":"self"}']);
  try{
    for(const mode of ['cloud','standalone']){
      own.hits.length=0;
      const origin=preflightIdentityOrigin(mode,own.url,'http://cloud.localhost:16300/');
      expect(origin).toBe(own.url);
      expect(await probeIdentityDiscovery(origin)).toEqual({status:200,ok:true});
      expect(own.hits).toEqual(['/.well-known/openid-configuration']);
    }
  }finally{await own.close();}
});

test('a real issuer 404 still fails, it is not accepted',async()=>{
  const broken=await server(()=>[404,'nope']);
  try{
    expect(await probeIdentityDiscovery(broken.url)).toEqual({status:404,ok:false});
  }finally{await broken.close();}
});

test('an unreachable issuer and a cancelled/bounded probe still fail closed',async()=>{
  // Nothing listens on this port.
  const dead=await probeIdentityDiscovery('http://127.0.0.1:1/');
  expect(dead.ok).toBe(false);
  expect(dead.status).toBeUndefined();

  // A hanging server must not be honoured: the 5s bound applies.
  const hang=await new Promise<{url:string;close:()=>Promise<void>}>((resolve)=>{
    const srv=createServer(()=>{/* never respond */});
    srv.listen(0,'127.0.0.1',()=>resolve({
      url:`http://127.0.0.1:${(srv.address() as any).port}/`,
      close:()=>new Promise(r=>{srv.closeAllConnections?.();srv.close(()=>r());}),
    }));
  });
  try{
    const started=Date.now();
    const result=await probeIdentityDiscovery(hang.url);
    expect(result.ok).toBe(false);
    // bounded: must not hang the job
    expect(Date.now()-started < 15_000).toBe(true);
  }finally{await hang.close();}
},30_000);
