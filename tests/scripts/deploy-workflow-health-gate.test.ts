import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/deploy.yml');

type Workflow = Record<string, any>;

async function loadWorkflowText(): Promise<string> {
  return readFile(workflowPath, 'utf8');
}

async function loadWorkflow(): Promise<Workflow> {
  return parseDocument(await loadWorkflowText()).toJSON() as Workflow;
}

function stepRuns(job: any): string[] {
  return (job.steps ?? [])
    .map((step: any) => step.run)
    .filter((run: unknown): run is string => typeof run === 'string');
}

function jobRunText(workflow: Workflow, jobName: string): string {
  return stepRuns(workflow.jobs[jobName]).join('\n');
}

function allRunText(workflow: Workflow): string {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job: any) => stepRuns(job))
    .join('\n');
}

describe('production deployment workflow', () => {
  it('is reusable by digest and keeps manual recovery explicit without asynchronous release triggers', async () => {
    const workflow = await loadWorkflow();

    expect(workflow.on.workflow_run).toBeUndefined();
    expect(workflow.on.workflow_call.inputs).toMatchObject({
      version: {
        required: true,
        type: 'string',
      },
      'image-digest': {
        required: true,
        type: 'string',
      },
      environment: {
        required: true,
        type: 'string',
      },
    });
    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      version: expect.objectContaining({ required: true }),
      'image-digest': expect.objectContaining({ required: true }),
      environment: expect.objectContaining({
        required: true,
        type: 'choice',
        options: [ 'all', 'co', 'cn' ],
      }),
    });
    expect(JSON.stringify(workflow.on.workflow_dispatch.inputs)).not.toContain('image-tag');
    expect(workflow.permissions).toEqual({
      contents: 'read',
      packages: 'read',
    });
  });

  it('uses separate .co and .cn production environments with reusable-call-friendly selectors', async () => {
    const workflow = await loadWorkflow();

    expect(Object.keys(workflow.jobs).sort()).toEqual([ 'deploy-cn', 'deploy-co', 'preflight' ]);
    expect(workflow.jobs.preflight.if).toBeUndefined();
    expect(workflow.jobs.preflight['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs.preflight.environment).toBeUndefined();
    expect(workflow.jobs['deploy-co'].environment).toBe('co');
    expect(workflow.jobs['deploy-cn'].environment).toBe('cn');
    expect(workflow.jobs['deploy-co'].needs).toBe('preflight');
    expect(workflow.jobs['deploy-cn'].needs).toBe('preflight');
    expect(workflow.jobs['deploy-co'].concurrency).toEqual({
      group: 'deploy-co',
      'cancel-in-progress': false,
    });
    expect(workflow.jobs['deploy-cn'].concurrency).toEqual({
      group: 'deploy-cn',
      'cancel-in-progress': false,
    });
    expect(workflow.jobs['deploy-co'].if).toContain("inputs.environment == 'co'");
    expect(workflow.jobs['deploy-co'].if).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow.jobs['deploy-cn'].if).toContain("inputs.environment == 'cn'");
    expect(workflow.jobs['deploy-cn'].if).toContain("github.event_name == 'workflow_dispatch'");
  });

  it('validates all untrusted inputs and Kubernetes names through env-injected shell variables', async () => {
    const workflow = await loadWorkflow();
    const preflightRunText = jobRunText(workflow, 'preflight');
    const runText = allRunText(workflow);

    expect(preflightRunText).toContain("VERSION_REGEX='^[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(preflightRunText).not.toContain('-[0-9A-Za-z.-]+');
    expect(preflightRunText).not.toContain('\\+[0-9A-Za-z.-]+');
    expect(preflightRunText).toContain('DIGEST_REGEX=');
    expect(preflightRunText).toContain('^sha256:[0-9a-f]{64}$');
    expect(preflightRunText).toContain('ENVIRONMENT_REGEX=');
    expect(preflightRunText).toContain('^(co|cn)$');
    expect(preflightRunText).toContain('environment=all is only allowed for manual workflow_dispatch recovery');
    expect(runText).toContain('K8S_NAME_REGEX=');
    expect(runText).toContain('SEALOS_NAMESPACE must be a valid Kubernetes name');
    expect(runText).not.toContain('${{ inputs.version }}');
    expect(runText).not.toContain('${{ inputs.image-digest }}');
    expect(runText).not.toContain('${{ inputs.environment }}');
    expect(runText).not.toContain('${{ github.ref');
  });

  it('promotes only the immutable image without overwriting the installed deployment profile', async () => {
    const workflow = await loadWorkflow();
    const workflowText = await loadWorkflowText();
    const runText = allRunText(workflow);

    expect(runText).toContain('docker manifest inspect "$TARGET_IMAGE"');
    expect(workflowText).toContain('TARGET_IMAGE: ghcr.io/undefinedsco/xpod@${{ inputs.image-digest }}');
    expect(runText).toContain('jsonpath={.spec.template.spec.containers[?(@.name=="xpod")].image}');
    expect(runText).toContain('previous_image=');
    expect(runText).toContain('PREVIOUS_IMAGE');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" set image deployment/xpod-cloud xpod="$TARGET_IMAGE"');
    expect(runText).toContain('kubectl rollout status deployment/xpod-inngest');
    expect(runText).toContain('kubectl rollout status deployment/xpod-cloud');
    expect(runText).not.toMatch(/set image deployment\/xpod-cloud xpod=ghcr\.io\/undefinedsco\/xpod:[^\s"]+/);
    expect(runText).not.toContain('xpod:replace-me');
    expect(runText).not.toMatch(/kubectl\s+(?:-n\s+"\$SEALOS_NAMESPACE"\s+)?(?:apply|create|patch|delete)\b/);
    expect(runText).not.toContain('deploy/sealos/cloud/');
    expect(workflowText).not.toContain('APP_ENV_FILE');
    expect(workflowText).not.toContain('XPOD_RUNTIME_SECRET_NAME');
  });

  it('gates success on public, Kubernetes, digest, and direct pod health checks for both domains', async () => {
    const workflow = await loadWorkflow();
    const runText = allRunText(workflow);

    expect(Object.values(workflow.jobs).flatMap((job: any) => job.steps ?? [])
      .filter((step: any) => step.name === 'Verify production gates')).toHaveLength(2);
    expect(workflow.jobs['deploy-co'].env.PUBLIC_BASE_URL).toBe('https://id.undefineds.co');
    expect(workflow.jobs['deploy-cn'].env.PUBLIC_BASE_URL).toBe('https://id.undefineds.cn');
    expect(runText).toContain('service_url="$PUBLIC_BASE_URL/service/status"');
    expect(runText.match(/all\(\.status == "running"\)/g)).toHaveLength(2);
    expect(runText.match(/\(map\(\.name\) \| sort\) == \["api", "css"\]/g)).toHaveLength(1);
    expect(runText).toContain('oidc_url="$PUBLIC_BASE_URL/.well-known/openid-configuration"');
    expect(runText).toContain('dashboard_url="$PUBLIC_BASE_URL/dashboard/"');
    expect(runText).toContain('settings_url="$PUBLIC_BASE_URL/settings/"');
    expect(runText).toContain('protected_settings_url="$PUBLIC_BASE_URL/api/pod/settings/status"');
    expect(runText).toContain('dashboard.html');
    expect(runText).toContain('settings.html');
    expect(runText).toContain('<!doctype html\\|<html');
    expect(runText).toContain('settings did not return HTML');
    expect(runText).toContain('expected_status "$protected_settings_url" 401');
    expect(runText).not.toContain('expected_status "$settings_url" 401');
    expect(runText).not.toContain('/settings/api/providers');
    expect(runText).toContain('deployment_image="$(kubectl -n "$SEALOS_NAMESPACE" get deployment xpod-cloud');
    expect(runText).toContain('imageID');
    expect(runText).toContain('service/status');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" exec "$ready_pod"');
  });

  it('rolls back to the captured previous image only on failure and dumps non-secret diagnostics', async () => {
    const workflow = await loadWorkflow();
    const runText = allRunText(workflow);

    for (const job of [ workflow.jobs['deploy-co'], workflow.jobs['deploy-cn'] ]) {
      const rollback = job.steps.find((step: any) => step.name === 'Rollback on failure');
      const diagnostics = job.steps.find((step: any) => step.name === 'Dump diagnostics on failure');
      expect(rollback.if).toBe('failure()');
      expect(diagnostics.if).toBe('failure()');
      if (job.environment === 'cn') {
        expect(rollback.run).toContain('scripts/verify-gz-rc-prerequisites.cjs rollback-production-image');
        expect(rollback.run).toContain('deployment/"$TARGET_DEPLOYMENT"');
        expect(diagnostics.run).toContain('describe deployment "$TARGET_DEPLOYMENT"');
        expect(diagnostics.run).not.toContain('deployment xpod-cloud');
      } else {
        expect(rollback.run).toContain('PREVIOUS_IMAGE="$(cat "$RUNNER_TEMP/xpod-previous-image")"');
        expect(rollback.run).toContain('No previous image was captured; skipping rollback');
        expect(rollback.run).toContain('kubectl -n "$SEALOS_NAMESPACE" set image deployment/xpod-cloud xpod="$PREVIOUS_IMAGE"');
        expect(rollback.run).toContain('kubectl rollout status deployment/xpod-cloud');
        expect(diagnostics.run).toContain('get deployment xpod-cloud');
        expect(diagnostics.run).toContain('describe deployment xpod-cloud');
        expect(diagnostics.run).toContain('logs -l app=xpod-cloud');
      }
      expect(diagnostics.run).toContain('--previous');
      expect(diagnostics.run).not.toContain('get secret');
      expect(diagnostics.run).not.toContain('describe secret');
    }
    expect(runText).not.toMatch(/cat\s+["']?\$APP_ENV_FILE/);
  });
});

describe('GZ CN production route and workload authority', () => {
  const helper=()=>require('../../scripts/verify-gz-rc-prerequisites.cjs');
  function fixture():any {
    const object=(kind:string,name:string,extra:any={})=>({kind,metadata:{name,namespace:'ns-iknkxtc8',uid:`${name}-uid`,resourceVersion:'42'},...extra});
    const hosts=['id','pods','api'].map(role=>`${role}.undefineds.cn`);
    return {
      deployment:object('Deployment','xpod-cn',{spec:{selector:{matchLabels:{app:'xpod-cn'}},template:{metadata:{labels:{app:'xpod-cn'}},spec:{containers:[{name:'xpod',image:`ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`}]}}}}),
      service:object('Service','xpod-cn',{spec:{selector:{app:'xpod-cn'},ports:[{port:80,targetPort:'http'}]}}),
      gateway:object('ConfigMap','gateway',{data:{nginx:hosts.map((host,index)=>`server { listen ${[8082,8083,8081][index]}; server_name ${host}; location / { proxy_pass http://xpod-cn.ns-iknkxtc8.svc.cluster.local:80; } }`).join('\n')}}),
      ingresses:{items:hosts.map((host,index)=>object('Ingress',`cn-${index}`,{spec:{rules:[{host,http:{paths:[{path:'/',backend:{service:{name:'gateway',port:{number:[8082,8083,8081][index]}}}}]}}]}}))},
    };
  }
  it('uses the actual xpod-cn workload and .cn hosts without mutating shared routes',()=>{
    const input=fixture();const before=JSON.stringify(input);
    expect(helper().verifyProductionTarget(input.deployment,input.service,input.gateway,input.ingresses,'https://id.undefineds.cn')).toBe(0);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(['sealos-co-host','wrong-workload','wrong-selector','wrong-container','foreign-namespace','wrong-upstream','wrong-ingress'])('refuses %s before production image mutation',mode=>{
    const input=fixture();let url='https://id.undefineds.cn';
    if(mode==='sealos-co-host') url='https://undefineds-gz-id.sealosgzg.site';
    if(mode==='wrong-workload') input.deployment.metadata.name='xpod-cloud';
    if(mode==='wrong-selector') input.service.spec.selector.app='xpod-co';
    if(mode==='wrong-container') input.deployment.spec.template.spec.containers[0].name='other';
    if(mode==='foreign-namespace') input.deployment.metadata.namespace='other-ns';
    if(mode==='wrong-upstream') input.gateway.data.nginx=input.gateway.data.nginx.replaceAll('xpod-cn.ns-iknkxtc8','xpod-co.ns-iknkxtc8');
    if(mode==='wrong-ingress') input.ingresses.items[0].spec.rules[0].http.paths[0].backend.service.name='xpod-rc';
    expect(()=>helper().verifyProductionTarget(input.deployment,input.service,input.gateway,input.ingresses,url)).toThrow();
  });
  it('requires exact GZ admission, guarded image mutation/rollback and direct Pod health in the CN lane',async()=>{
    const workflow=await loadWorkflow();const job=workflow.jobs['deploy-cn'];const text=jobRunText(workflow,'deploy-cn');
    expect(job.env.KUBE_CONFIG_DATA).toBe('${{ secrets.KUBE_CONFIG_DATA }}');
    expect(text).toContain('scripts/verify-gz-rc-prerequisites.cjs boundary');
    for(const command of ['production-preflight','promote-production-image','rollback-production-image','production-health']) expect(text).toContain(`scripts/verify-gz-rc-prerequisites.cjs ${command}`);
    expect(text).not.toContain('set image');expect(text).not.toContain('xpod-cloud');expect(text).not.toContain('exec "$ready_pod"');
    expect(text).not.toContain('rollout status deployment/xpod-inngest');
    const source=await readFile(path.join(repoRoot,'scripts/verify-gz-rc-prerequisites.cjs'),'utf8');
    expect(source).toContain("op:'test',path:'/metadata/uid'");expect(source).toContain("op:'test',path:'/metadata/resourceVersion'");
    expect(source).toContain("op:'replace',path:`/spec/template/spec/containers/${index}/image`");
  });
  const fakeProductionKube = `#!/usr/bin/env python3
import sys,os,json,pathlib
args=sys.argv[1:];root=pathlib.Path(os.environ['FAKE_PROD_STATE']);mode=os.environ['FAKE_PROD_MODE'];file=root/'objects.json';objects=json.loads(file.read_text())
with (root/'calls.jsonl').open('a') as out:out.write(json.dumps(args)+'\\n')
if args[:2]==['config','view']:
 server='https://foreign.example' if mode=='wrong-cluster' else 'https://gzg.sealos.run:6443'
 print(json.dumps({'clusters':[{'cluster':{'server':server}}],'contexts':[{'context':{'namespace':'ns-iknkxtc8'}}]}));sys.exit()
if 'get' in args:
 kind=args[args.index('get')+1];key={'deployment':'deployment','service':'service','configmap':'gateway','ingress':'ingresses'}[kind]
 if (root/'gz-production-target.json').exists() and kind=='deployment':
  if mode=='replaced':objects[key]['metadata']['uid']='foreign-uid'
  if mode=='image-changed':objects[key]['spec']['template']['spec']['containers'][0]['image']='ghcr.io/undefinedsco/xpod@sha256:'+'c'*64
 print(json.dumps(objects[key]));sys.exit()
if 'patch' in args:
 operations=json.loads(args[args.index('-p')+1]);obj=objects['deployment']
 if mode=='patch-race':obj['metadata']['resourceVersion']='43'
 for op in operations:
  parts=op['path'].strip('/').split('/');value=obj
  for part in parts[:-1]:value=value[int(part)] if isinstance(value,list) else value[part]
  key=int(parts[-1]) if isinstance(value,list) else parts[-1]
  if op['op']=='test' and value[key]!=op['value']:print('PRIVATE_409',file=sys.stderr);sys.exit(39)
  if op['op']=='replace':value[key]=op['value']
 obj['metadata']['resourceVersion']=str(int(obj['metadata']['resourceVersion'])+1);file.write_text(json.dumps(objects))
 if mode=='ack-loss':print('PRIVATE_ACK',file=sys.stderr);sys.exit(17)
 print('deployment.apps/xpod-cn');sys.exit()
print('PRIVATE_UNSUPPORTED',file=sys.stderr);sys.exit(80)
`;
  it.each(['success','replaced','image-changed','patch-race','ack-loss','wrong-cluster'])('actual CN image CLI protects ownership in %s', mode => {
    const parent=path.join(repoRoot,'.test-data/gz-production-image');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-'));const bin=path.join(dir,'bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'kubectl'),fakeProductionKube,{mode:0o700});
    const input=fixture();writeFileSync(path.join(dir,'objects.json'),JSON.stringify(input));
    const env={...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,RUNNER_TEMP:dir,GITHUB_ENV:path.join(dir,'github-env'),
      SEALOS_NAMESPACE:'ns-iknkxtc8',PUBLIC_BASE_URL:'https://id.undefineds.cn',TARGET_IMAGE:`ghcr.io/undefinedsco/xpod@sha256:${'b'.repeat(64)}`,
      FAKE_PROD_STATE:dir,FAKE_PROD_MODE:mode};
    const execute=(command:string)=>spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs',command],{cwd:repoRoot,env,encoding:'utf8',timeout:10000});
    try {
      const admission=execute('production-preflight');expect(admission.signal).toBeNull();expect(admission.status).toBe(mode==='wrong-cluster'?1:0);
      if(mode!=='wrong-cluster') {
        const promotion=execute('promote-production-image');expect(promotion.signal).toBeNull();expect(promotion.status).toBe(mode==='success'?0:1);
        expect(promotion.stdout+promotion.stderr).not.toContain('PRIVATE');
        expect(existsSync(path.join(dir,'gz-production-promoted.json'))).toBe(mode==='success');
        const rollback=execute('rollback-production-image');expect(rollback.signal).toBeNull();expect(rollback.status).toBe(0);
      }
      const calls=readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);
      const patches=calls.filter(call=>call.includes('patch'));
      expect(patches).toHaveLength(mode==='success'?2:['patch-race','ack-loss'].includes(mode)?1:0);
      for(const call of patches) {
        expect(call).toContain('xpod-cn');expect(call).toContain('--type=json');
        const operations=JSON.parse(call[call.indexOf('-p')+1]);
        expect(operations.filter((entry:any)=>entry.op==='test').map((entry:any)=>entry.path)).toEqual([
          '/metadata/uid','/metadata/resourceVersion','/spec/template/spec/containers/0/name','/spec/template/spec/containers/0/image']);
        expect(operations.filter((entry:any)=>entry.op==='replace')).toHaveLength(1);
      }
      const after=JSON.parse(readFileSync(path.join(dir,'objects.json'),'utf8'));
      expect(after.deployment.spec.template.spec.containers[0].image).toBe(mode==='ack-loss'?env.TARGET_IMAGE:input.deployment.spec.template.spec.containers[0].image);
      expect(calls.some(call=>['apply','delete','exec'].some(value=>call.includes(value)))).toBe(false);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });

});
