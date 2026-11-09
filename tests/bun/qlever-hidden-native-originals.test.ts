import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
function upload():any {
  const source=readFileSync(new URL('../../.github/workflows/build-qlever-macos-runtime.yml',import.meta.url),'utf8');
  const parsed=spawnSync('bun',['-e','console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())));'],{input:source,encoding:'utf8'});
  if(parsed.status!==0)throw Error(parsed.stderr);
  return JSON.parse(parsed.stdout).jobs.build.steps.find((step:any)=>step.name==='Upload the exact native runtime');
}
function requireOriginals(step:any) {
  if(step.with['include-hidden-files']!==true)throw Error('Hidden original recipes omitted');
  const paths=String(step.with.path).trim().split('\n').map((line:string)=>line.trim());
  if(paths.length!==3 || !paths.includes('${{ runner.temp }}/xpod-qlever-runtime/native-materials/'))throw Error('Native material scope changed');
  if(paths.some((path:string)=>!path.startsWith('${{ runner.temp }}/xpod-qlever-runtime/')))throw Error('Upload escaped controlled native output');
}
test('controlled native upload retains actual hidden .brew recipe originals',()=>{
  const actual=upload();requireOriginals(actual);
  for(const value of [undefined,false]) {
    const changed=JSON.parse(JSON.stringify(actual));changed.with['include-hidden-files']=value;
    expect(()=>requireOriginals(changed)).toThrow('Hidden original recipes omitted');
  }
  const changed=JSON.parse(JSON.stringify(actual));changed.with.path+='\n${{ github.workspace }}/';
  expect(()=>requireOriginals(changed)).toThrow('scope changed');
});
