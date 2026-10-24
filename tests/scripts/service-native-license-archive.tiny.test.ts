import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
test('actual source license archive formats enforce full originals and shared bounds',()=>{
 const result=spawnSync('python3',['qlever/tests/test_service_native_license_archive.py'],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 if(result.status!==0)throw Error(result.stderr||result.stdout||String(result.error));
 expect(result.status).toBe(0);
});
