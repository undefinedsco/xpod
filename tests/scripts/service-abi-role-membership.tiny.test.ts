import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
test('actual held-file mechanics support separate executable roles and existing artifact references',()=>{
 const result=spawnSync('python3',['qlever/tests/test_service_abi_role_membership.py'],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 if(result.status!==0)throw Error(result.stderr||result.stdout||String(result.error));
 expect(result.status).toBe(0);
});

for(const filename of ['test_service_abi_read_budget.py','test_service_abi_elf.py','test_service_abi_role_commands.py','test_service_abi_bun_role_session.py','test_service_abi_role_pid.py','test_service_abi_role_collector.py'])test('bounded actual role helper '+filename,()=>{
 const result=spawnSync('python3',['qlever/tests/'+filename],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 if(result.status!==0)throw Error(result.stderr||result.stdout||String(result.error));
 expect(result.status).toBe(0);
});
