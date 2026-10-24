import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native stage retains an actual closed child and supervised raw receipts', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const script = String.raw`
import importlib.util,json,pathlib,tempfile,time
root=pathlib.Path.cwd()
spec=importlib.util.spec_from_file_location('native_stage',root/'qlever/scripts/sdk-service-native-runtime-stage.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
base=root/'.test-data/native-stage-test';base.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=base) as directory:
 out=pathlib.Path(directory)
 stage,rows=module.stage_factory(out,maximum=1048576,deadline=time.monotonic()+40,check=lambda:None)
 row=stage('actual-printf',['/usr/bin/printf','native actual child'],root)
 assert (out/row['stdout']['path']).read_bytes()==b'native actual child'
 for field in ('receipt','stdout','stderr','supervisionReceipt','supervisionRaw'):
  assert module.materials.ref(out/row[field]['path'],out)==row[field]
 command=json.loads((out/row['receipt']['path']).read_bytes())
 supervisor=json.loads((out/row['supervisionReceipt']['path']).read_bytes())
 assert command['actualWait'] and command['exit']==0
 assert supervisor['actualWait'] and supervisor['ownedGroupAbsentAfterWait']
 assert command['pgid']==supervisor['pgid'] and rows==[row]
`;
  const result = spawnSync('python3', ['-B', '-c', script], {cwd: root, encoding: 'utf8', timeout: 45000});
  expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ''});
});
