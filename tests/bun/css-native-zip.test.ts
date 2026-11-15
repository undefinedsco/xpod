import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('complete original CSS native ZIP inventory and negative substitutions', () => {
  const result=spawnSync('/usr/bin/python3',['-B','-m','unittest','discover','-s','tests/python','-p','test_css_native_zip.py'],
    {cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:10000});
  expect(result.status).toBe(0);
  if(result.status!==0)throw Error(result.stderr);
});
