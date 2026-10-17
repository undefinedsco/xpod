import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {observeArchiveInstalledProductConsumer,preflightArchiveInstalledProductConsumer} from './consumer-context';
test('archive preconsumer requires genuine product capability before filesystem work',async()=>{
 expect(()=>preflightArchiveInstalledProductConsumer({artifact:{}})).toThrow('real collected artifact capability required');
 await expect(observeArchiveInstalledProductConsumer({artifact:{},stage:'prepublish',evidenceDirectory:'/must-not-create'})).rejects.toThrow('real collected artifact capability required');
});
test('controlled archive installation preserves normal dependency scripts and registry semantics',()=>{
 const module=path.resolve(import.meta.dir,'../module-consumer.py');
 const result=spawnSync('python3',['-c',`import importlib.util,pathlib
s=importlib.util.spec_from_file_location('consumer',${JSON.stringify(module)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.consumer_transport(dict(transport='collected-product-archives'))=='collected-product-archives'
a=m.consumer_install_arguments(pathlib.Path('/tmp/owned'),True)
assert '--ignore-scripts' not in a and '--omit=peer' not in a and '--offline' not in a
assert a[a.index('--registry')+1]=='https://registry.npmjs.org/'
d={'@undefineds.co/xpod-cli':'file:/controlled/cli.tgz','peer':'1.2.3'}
p=m.consumer_install_manifest(d,True)
assert p['dependencies']==d and p['overrides']==d and p['trustedDependencies']==sorted(d)
assert '--ignore-scripts' in m.consumer_install_arguments(pathlib.Path('/tmp/owned'),False)
`],{encoding:'utf8'});
 expect(result.stderr).toBe('');expect(result.status).toBe(0);
});
