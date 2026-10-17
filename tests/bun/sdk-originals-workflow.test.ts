import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
function yaml(name:string):any {
  const result=spawnSync('bun',['-e','console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())));'],{encoding:'utf8',input:readFileSync(new URL('../../.github/workflows/'+name,import.meta.url),'utf8')});
  expect(result.status).toBe(0);return JSON.parse(result.stdout);
}
test('SDK first-cold code owns build/raw/source context and passes an immutable SDK artifact tuple',()=>{
  const sdk=yaml('publish-qlever-runtime-sdk.yml');
  const steps=sdk.jobs.publish.steps;
  const context=steps.findIndex((step:any)=>step.name==='Capture exact module Docker context originals');
  const build=steps.findIndex((step:any)=>step.id==='module_build');
  const push=steps.findIndex((step:any)=>step.id==='module_push');
  const originals=steps.findIndex((step:any)=>step.id==='sdk_originals');
  expect(context<build && build<push && push<originals).toBe(true);
  expect(steps[build].run).toContain('sdk-image-originals.py build');
  expect(steps[push].run).toContain('sdk-image-originals.py push');
  expect(steps.find((step:any)=>step.id==='sdk_upload').with['include-hidden-files']).toBe(true);
  expect(sdk.jobs.module_runtime_materials.with.sdk_artifact_id).toBe('${{ needs.publish.outputs.sdk_artifact_id }}');
  expect(sdk.jobs.module_runtime_materials.with.sdk_master_bytes).toBe('${{ needs.publish.outputs.sdk_master_bytes }}');
  const native=yaml('build-qlever-linux-runtime.yml');
  const produce=native.jobs.archive.steps.find((step:any)=>step.name==='Produce native source and ABI original materials');
  expect(produce.env.SDK_ORIGINAL_ARTIFACT_ID).toBe('${{ inputs.sdk_artifact_id }}');
  expect(native.jobs.archive.steps.find((step:any)=>step.id==='upload').with['include-hidden-files']).toBe(true);
});
