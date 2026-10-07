import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
const execFile=promisify(execFileCallback);
const repoRoot=path.resolve(__dirname,'../..');
const scriptPath=path.join(repoRoot,'scripts/update-gateway-rc-configmap.cjs');
const tempRoots:string[]=[];
function fixture():any {
  const object=(kind:string,name:string,extra:any={})=>({kind,metadata:{name,namespace:'ns-iknkxtc8',uid:`${name}-uid`,resourceVersion:'42'},...extra});
  const hosts=['id','pods','api'].map(role=>`undefineds-gz-rc-${role}.sealosgzg.site`);
  return {gateway:object('ConfigMap','gateway',{data:{unrelated:'PRIVATE_UNTOUCHED',nginx:hosts.map((host,index)=>`server { listen ${[8082,8083,8081][index]}; server_name ${host}; location / { proxy_pass http://xpod-rc:80; proxy_set_header Host $host; proxy_set_header X-Forwarded-Host $host; proxy_set_header X-Forwarded-Proto https; } }`).join('\n')}}),
    ingresses:{items:hosts.map((host,index)=>object('Ingress',`rc-${index}`,{spec:{tls:[{hosts:[host],secretName:`tls-${index}`}],rules:[{host,http:{paths:[{path:'/',pathType:'Prefix',backend:{service:{name:'gateway',port:{number:[8082,8083,8081][index]}}}}]}}]}}))},
    inngest:object('Deployment','xpod-inngest',{spec:{template:{spec:{containers:[{name:'inngest',args:['--sdk-url','http://xpod-rc/api/inngest'],env:[{name:'XPOD_RC_INNGEST_EVENT_KEY',valueFrom:{secretKeyRef:{name:'old-key',key:'XPOD_INNGEST_EVENT_KEY'}}}]}]}}}})};
}
async function run(input:any,namespace='ns-iknkxtc8') {
  const parent=path.join(repoRoot,'.test-data/gateway-verify');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'case-'));tempRoots.push(root);
  const file=path.join(root,'input.json');const original=JSON.stringify(input);await writeFile(file,original);
  const result=await execFile('bun',[scriptPath,'--input',file,'--namespace',namespace],{cwd:repoRoot});
  expect(await readFile(file,'utf8')).toBe(original);return result;
}
describe('shared GZ Gateway verification-only command',()=>{
  afterEach(async()=>{await Promise.all(tempRoots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
  it('preserves all input bytes and emits identities rather than a ConfigMap apply manifest',async()=>{
    const result=await run(fixture());const output=JSON.parse(result.stdout);
    expect(output.status).toBe('ok');expect(output.identities).toHaveLength(4);
    expect(result.stdout).not.toContain('PRIVATE_UNTOUCHED');expect(output.kind).toBeUndefined();
    expect(output.identities[0]).toMatchObject({uid:'gateway-uid',resourceVersion:'42'});
  });
  it('refuses changed RC routes without emitting replacement shared configuration',async()=>{
    const input=fixture();input.gateway.data.nginx=input.gateway.data.nginx.replaceAll('xpod-rc:80','xpod-cn:80');
    await expect(run(input)).rejects.toMatchObject({stderr:expect.stringContaining('shared mutation refused'),stdout:''});
  });
  it('rejects foreign namespace and Secret input without printing private values',async()=>{
    await expect(run(fixture(),'other-ns')).rejects.toMatchObject({stderr:expect.stringContaining('shared mutation refused')});
    await expect(run({kind:'Secret',stringData:{password:'PRIVATE_PASSWORD'}})).rejects.toMatchObject({stderr:expect.not.stringContaining('PRIVATE_PASSWORD'),stdout:''});
  });
});
