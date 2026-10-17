import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
function yaml(name:string):any {
  const result=spawnSync('bun',['-e','console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())));'],
    {input:readFileSync(new URL(`../../.github/workflows/${name}`,import.meta.url),'utf8'),encoding:'utf8'});
  expect(result.status).toBe(0);return JSON.parse(result.stdout);
}
test('four target production is manually controlled and native artifacts stay in each invocation',()=>{
  const parent=yaml('css-native-products.yml'),child=yaml('css-native-product-target.yml');
  expect(Object.keys(parent.on)).toEqual(['workflow_dispatch']);
  expect(parent.jobs.targets.strategy['max-parallel']).toBe(1);
  expect(parent.jobs.targets.name).toBe('targets (${{ matrix.target }})');
  expect(parent.jobs.targets.uses).toBe('./.github/workflows/css-native-product-target.yml');
  expect(child.jobs.native.uses).toBe('./.github/workflows/css-native-source.yml');
  expect(child.jobs.products.needs).toEqual(['resolve','native']);
  const build=child.jobs.products.steps.find((step:any)=>step.name==='Produce the normal CSS preview');
  expect(build.env.CSS_NATIVE_ARTIFACT_ID).toBe('${{ needs.native.outputs.artifact_id }}');
  expect(build.run).toContain('--target "${{ inputs.target }}"');
  const result=spawnSync('/usr/bin/python3',['-B','-m','unittest','discover','-s','tests/python','-p','test_css_native_workflow.py'],
    {cwd:root,encoding:'utf8',timeout:10000});
  if(result.status!==0)throw Error(result.stderr);expect(result.status).toBe(0);
});


function requireSourceMaterialUpload(workflow:any) {
  const upload=workflow.jobs.products.steps.find((step:any)=>step.name==='Upload original preview and evidence');
  const paths=String(upload?.with?.path).trim().split('\n').map((line:string)=>line.trim());
  for(const name of ['product.tgz','source-materials/','producer.receipt.json','evidence/','originals/']) {
    if(!paths.includes('${{ env.CSS_PRODUCT_ROOT }}/'+name))throw Error('Required original product material omitted: '+name);
  }
  if(upload.if!=='success()' || upload.with['if-no-files-found']!=='error')throw Error('Required material upload must fail closed');
}
test('success product upload retains source materials and rejects missing or foreign-root replacements',()=>{
  const current=yaml('css-native-product-target.yml');
  requireSourceMaterialUpload(current);
  for(const substitute of ['', '${{ env.OTHER_PRODUCT_ROOT }}/source-materials/']) {
    const changed=JSON.parse(JSON.stringify(current));
    const upload=changed.jobs.products.steps.find((step:any)=>step.name==='Upload original preview and evidence');
    upload.with.path=upload.with.path.replace('${{ env.CSS_PRODUCT_ROOT }}/source-materials/',substitute);
    expect(()=>requireSourceMaterialUpload(changed)).toThrow('source-materials/');
  }
});
