import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
const program = String.raw`
import importlib.util,pathlib,tempfile,json,hashlib,os,shutil
spec=importlib.util.spec_from_file_location('lifecycle','scripts/lib/module-consumer.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
args=m.consumer_install_arguments(pathlib.Path('/isolated'),True)
assert '--ignore-scripts' not in args and '--omit=peer' not in args and '--offline' not in args
assert 'https://registry.npmjs.org/' in args
assert '--ignore-scripts' in m.consumer_install_arguments(pathlib.Path('/isolated'),False)
assert m.consumer_install_manifest({'tool':'1.2.3'},True)['trustedDependencies']==['tool']
assert m.consumer_transport({})=='immutable-local-fixture'
assert m.consumer_transport({'transport':'production-npm-registry'})=='production-npm-registry'
try:m.consumer_transport({'transport':True});raise AssertionError('accepted boolean')
except ValueError:pass
root=pathlib.Path(tempfile.mkdtemp(prefix='transport-',dir='.test-data'))
try:
 wrapper=m.runtime_wrapper(root/'runtime','node','/actual/node',None)
 assert wrapper.read_text()=='#!/bin/sh\nexec /actual/node "$@"\n'
 package=root/'node_modules/tool';package.mkdir(parents=True)
 (package/'package.json').write_text(json.dumps({'name':'tool','version':'1.2.3','bin':{'tool':'cli.cjs'}}))
 (package/'cli.cjs').write_text('console.log(1)');(package/'cli.cjs').chmod(0o755)
 (root/'node_modules/.bin').mkdir();(root/'node_modules/.bin/tool').symlink_to('../tool/cli.cjs')
 rows=[dict(package='tool',version='1.2.3',files=[dict(path=p.name,bytes=p.stat().st_size,mode=p.stat().st_mode&0o7777,sha256=m.digest(p)) for p in package.iterdir()])]
 assert m.verify_registry_tools(root,rows)==dict(files=2,binLinks=1,complete=True)
 (package/'cli.cjs').write_text('console.log(2)')
 try:m.verify_registry_tools(root,rows);raise AssertionError('changed tool accepted')
 except ValueError:pass
finally:shutil.rmtree(root)
print('passed')
`;
test('production module transport uses actual runtime and exact installed tools; fixture remains explicit', () => {
  const result = spawnSync('python3', ['-c', program], { encoding: 'utf8' });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('passed');
});
