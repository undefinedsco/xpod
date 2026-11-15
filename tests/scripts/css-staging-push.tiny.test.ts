import {test,expect} from 'bun:test';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dir,'../..');
function yaml(name:string):any {
 const parsed=spawnSync(process.execPath,['-e',"console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))",path.join(root,name)],{encoding:'utf8'});
 if(parsed.status!==0)throw Error(parsed.stderr);return JSON.parse(parsed.stdout);
}
test('CSS staging push internally selects all, with serial same-run native to normal product',()=>{
 const workflow=yaml('.github/workflows/css-native-products.yml');
 expect(workflow.on.push).toEqual({branches:['staging']});
 expect(workflow.on.workflow_dispatch.inputs.target.default).toBe('all');
 expect(workflow.jobs.contract.steps.find((step:any)=>step.id==='targets').env.TARGET).toBe("${{ github.event_name == 'push' && 'all' || inputs.target }}");
 expect(workflow.jobs.targets.strategy['max-parallel']).toBe(1);
 expect(workflow.concurrency['cancel-in-progress']).toBe(false);
 expect(workflow.jobs.targets.uses).toBe('./.github/workflows/css-native-product-target.yml');
 const child=yaml('.github/workflows/css-native-product-target.yml');
 expect(child.jobs.products.needs).toEqual(['resolve','native']);
});
test('producer push is limited to exact staging controlled parent, never ordinary CSS or another branch',()=>{
 const result=spawnSync('python3',['-c',`import importlib.util,json,tempfile,pathlib,sys
root=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('css',root/'scripts/css-module-producer.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'event.json';p.write_text('{}');sha='a'*40
 env=dict(GITHUB_REPOSITORY=m.REPOSITORY,GITHUB_SHA=sha,GITHUB_EVENT_NAME='push',GITHUB_EVENT_PATH=str(p),GITHUB_RUN_ID='5',GITHUB_RUN_ATTEMPT='1',GITHUB_REF='refs/heads/staging',GITHUB_WORKFLOW_REF=m.REPOSITORY+'/'+m.TARGETS_WORKFLOW+'@refs/heads/staging',GITHUB_WORKFLOW_SHA=sha)
 assert m.context(env,dict(sha=sha,status=''))['runHeadSha']==sha
 for delta in [dict(GITHUB_REF='refs/heads/main'),dict(GITHUB_REF='refs/tags/test'),dict(GITHUB_WORKFLOW_REF=m.REPOSITORY+'/'+m.WORKFLOW+'@refs/heads/staging')]:
  try:m.context(dict(env,**delta),dict(sha=sha,status=''))
  except ValueError:pass
  else:raise AssertionError('forbidden push accepted')
`,root],{encoding:'utf8'});
 expect(result.stderr).toBe('');expect(result.status).toBe(0);
});
