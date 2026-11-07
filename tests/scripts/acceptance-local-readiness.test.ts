import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const yaml=createRequire(import.meta.url)('yaml');

/** RC381: the matrix starts `local` with `docker compose up --wait`, but the local
 * service declared no healthcheck. A running container therefore satisfied the
 * local Compose wait without a readiness probe. RC381 failed in the runtime
 * phase; its retained evidence does not identify which endpoint failed.
 *
 * IMPORTANT SCOPE: the healthcheck is a real readiness GAP fix. These tests prove
 * the DECLARATION and the curl-vs-fetch redirect asymmetry. They are unit
 * fixtures — NOT Xpod acceptance, and NOT proof of which endpoint failed in RC381.
 */
const compose=()=>yaml.parse(readFileSync('docker-compose.acceptance.yml','utf8'));

test('local declares a readiness probe on the same discovery endpoint the canary needs',()=>{
  const local=compose().services.local;
  expect(local).toBeDefined();
  expect(local.healthcheck).toBeDefined();
  const probe=(local.healthcheck.test as string[]).join(' ');
  expect(probe).toContain('.well-known/openid-configuration');
  expect(probe).toContain('16310');
  expect(Number(local.healthcheck.retries)).toBeGreaterThan(0);
  expect(Number.parseInt(String(local.healthcheck.timeout),10)).toBeGreaterThan(0);
});

test('cloud and local are symmetric and local still waits for cloud readiness',()=>{
  const s=compose().services;
  for(const name of ['cloud','local']){
    expect(s[name].healthcheck).toBeDefined();
    expect((s[name].healthcheck.test as string[]).join(' ')).toContain('.well-known/openid-configuration');
  }
  expect(JSON.stringify(s.local.depends_on)).toContain('service_healthy');
});

test('redirect asymmetry: curl --fail accepts a 302 while fetch follows it',async()=>{
  // A healthcheck that does not follow redirects can succeed while the canary's
  // fetch() is sent to a canonical host that may not resolve locally. This proves
  // the probe is a GAP indicator, not a guarantee.
  const target=createServer((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"issuer":"https://managed.invalid/"}');});
  await new Promise<void>(r=>target.listen(0,'127.0.0.1',()=>r()));
  const tport=(target.address() as any).port;
  const front=createServer((q,r)=>{
    if(q.url==='/.well-known/openid-configuration'){r.writeHead(302,{location:`http://127.0.0.1:${tport}/.well-known/openid-configuration`});r.end();return;}
    r.writeHead(404);r.end();
  });
  await new Promise<void>(r=>front.listen(0,'127.0.0.1',()=>r()));
  try{
    const url=new URL('.well-known/openid-configuration',`http://127.0.0.1:${(front.address() as any).port}/`).href;
    const curlExit=await new Promise<number>(resolve=>{
      const c=spawn('curl',['--noproxy','*','--fail','--silent','--max-time','5',url],{stdio:'ignore'});
      c.on('exit',code=>resolve(code??1));c.on('error',()=>resolve(-1));
    });
    expect(curlExit).toBe(0); // curl treats 302 as success without -L
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),5000);
    try{
      const r=await fetch(url,{signal:ctrl.signal});
      expect(r.redirected).toBe(true);
      expect(new URL(r.url).port).toBe(String(tport));
    }finally{clearTimeout(timer);}
  }finally{front.close();target.close();}
},20_000);
