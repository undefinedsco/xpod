import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const probes = path.resolve(import.meta.dir, '../../scripts/lib/api-consumer-probes.py');
const adapter = path.resolve(import.meta.dir, '../../scripts/api-module-consumer.py');
function python(body: string) {
  const result = spawnSync('python3', ['-c', `
import importlib.util,pathlib,tempfile,json,types,threading,http.server
spec=importlib.util.spec_from_file_location('probes',${JSON.stringify(probes)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${body}
`], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

test('health and static probes require exact installed bytes', () => {
  python(`
base=pathlib.Path('.test-data/api-probe-tests');base.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=base) as temp:
 root=pathlib.Path(temp);assets=root/'static';(assets/'dashboard').mkdir(parents=True);(assets/'settings').mkdir()
 (assets/'dashboard/dashboard.html').write_bytes(b'dashboard');(assets/'settings/settings.html').write_bytes(b'settings')
 class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_GET(self):
   body={'/health':b'{"status":"ok"}','/dashboard/':b'dashboard','/settings/':b'settings'}[self.path]
   self.send_response(200);self.end_headers();self.wfile.write(body)
 server=http.server.HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
 try:
  url='http://127.0.0.1:'+str(server.server_port)+'/'
  runner=types.SimpleNamespace(plan={'timeoutSeconds':1},output=root,observe_group=lambda _:None,gate=lambda:None)
  process=types.SimpleNamespace(poll=lambda:None)
  m.healthy(runner,process,url,root,'node')
  result=json.loads((root/'node-api-health.json').read_text());assert len(result['exactInstalledAssets'])==2 and result['chatValidated'] is False
  (assets/'settings/settings.html').write_bytes(b'tampered')
  try:m.healthy(runner,process,url,root,'bun')
  except ValueError:pass
  else:raise AssertionError('different static bytes admitted')
 finally:server.shutdown();thread.join();server.server_close()
base.rmdir()
`);
});

test('HTTP probe rejects redirects and over-budget responses', () => {
  python(`
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/redirect':self.send_response(302);self.send_header('Location','/body');self.end_headers()
  else:self.send_response(200);self.end_headers();self.wfile.write(b'four')
server=http.server.HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
try:
 url='http://127.0.0.1:'+str(server.server_port)+'/'
 for route,limit in [('redirect',10),('body',3)]:
  try:m.read_local(url,route,limit)
  except ValueError:pass
  else:raise AssertionError('invalid response admitted')
finally:server.shutdown();thread.join();server.server_close()
`);
});

test('dependency probes use installed pointer arguments and preserve observer coverage', () => {
  python(`
assert 'process.argv[2]' in m.PGLITE and 'process.argv[2]' in m.RDF
assert 'await db.close()' in m.PGLITE
assert '__xpodObservedActorsPatched' in m.RDF and 'await engine.invalidateHttpCache()' in m.RDF
assert 'process.kill' not in m.RDF
for script in [m.PGLITE,m.RDF]:
 assert '/Users/' not in script and 'preview.1' not in script
base=pathlib.Path('.test-data/api-probe-tests');base.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=base) as temp:
 path=m.write_probe(temp,'rdf');assert path.read_text()==m.RDF
 try:m.write_probe(temp,'rdf')
 except FileExistsError:pass
 else:raise AssertionError('probe replaced')
base.rmdir()
`);
});

test('API plan validates its real projection shape and rejects substituted originals', () => {
  python(`
import sys,copy,hashlib,base64
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('adapter',${JSON.stringify(adapter)})
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
base=pathlib.Path('.test-data/api-plan-tests');base.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=base) as temp:
 root=pathlib.Path(temp).resolve();source=root/'source';source.mkdir();(source/'package.json').write_text('{}')
 private=root/'private';private.mkdir(mode=0o700);projected=root/'projected';projected.mkdir();sha='a'*40
 def save(name,value):
  p=projected/name;p.write_text(json.dumps(value));return dict(path=str(p),sha256=a.lifecycle.digest(p))
 def relative(value):return dict(value,path=pathlib.Path(value['path']).name)
 archives={}
 for key in ['product','cli','client']:
  p=projected/(key+'.tgz');p.write_bytes(key.encode());archives[key]=dict(path=str(p),sha256=a.lifecycle.digest(p),integrity='sha512-'+a.lifecycle.digest(p,'sha512'),bytes=p.stat().st_size)
 custody=save('custody.json',{});archive=relative(archives['product'])
 flags={k:False for k in ['published','releaseQualified','consumerValidated','legalClearance','nativeAdmission']}
 materials={k:dict(archiveMember=v) for k,v in dict(sourceInventory='package/provenance/source-inventory.json',releaseStatus='package/provenance/release-status.json',publication='package/provenance/publication.json',termsIndex='package/provenance/terms/index.json',nativeIndex='package/provenance/native/inngest/index.json').items()}
 producer=save('producer.json',dict(schemaVersion=1,kind='api-module-product-production',status='controlled-preview-materials',context=dict(actualCheckoutSha=sha,workflowPath='.github/workflows/api-module-product.yml',runHeadSha=sha,runId=123,runAttempt=1,target='darwin-arm64',version='1.2.3'),sourceBefore=dict(sha=sha,status=''),sourceAfter=dict(sha=sha,status=''),archive=archive,materials=materials,**flags))
 collector=save('collector.json',dict(schemaVersion=1,expectedSourceSha=sha,archive=dict(path='product.tgz',sha256=archives['product']['sha256'])))
 api=save('api.json',dict(schemaVersion=1,kind='api-product-input-projection',status='projected-blocked',sourceSha=sha,custodyReceipt=custody,producerReceipt=relative(producer),collectorInput=relative(collector),runHeadSha=sha,runId=123,runAttempt=1,**{k:False for k in ['actualCheckoutVerified','exactAttemptAdmitted','collectorExecuted','published','releaseQualified']}))
 publication=save('publication.json',dict(schemaVersion=1,cli=archives['cli'],client=archives['client']))
 cli=save('cli.json',dict(schemaVersion=1,kind='cli-publication-input-projection',status='projected-blocked',sourceSha=sha,custodyReceipt=custody,publicationInput=relative(publication),products={k:dict(package='@undefineds.co/xpod-'+k,version='1.2.3',archive=relative(archives[k])) for k in ['cli','client']},**{k:False for k in ['actualCheckoutVerified','exactAttemptAdmitted','registryConsumerValidated','published','releaseQualified']}))
 plan=dict(schemaVersion=1,sourceSha=sha,checkout=str(source),sourceRoots=[str(source)],apiReceipt=api,cliReceipt=cli,apiArchive=archives['product'],cliArchive=archives['cli'],clientArchive=archives['client'],node=sys.executable,bun=sys.executable,output=str(private/'output'),temporaryParent=str(private),budget=dict(estimatedPeakBytes=1024,remainingFloorBytes=a.lifecycle.GIB,cushionBytes=128*a.lifecycle.MIB))
 with patch.object(a.lifecycle.subprocess,'check_output',lambda *args,**kwargs:sha+'\\n'):
  checked=a.validate(plan);assert checked['module']['package']['name']=='@undefineds.co/xpod-api-darwin-arm64'
  assert not pathlib.Path(plan['output']).exists()
  for bad in [dict(plan,sourceSha='b'*40),dict(plan,apiArchive=dict(plan['apiArchive'],integrity='sha512-wrong'))]:
   try:a.validate(bad)
   except ValueError:pass
   else:raise AssertionError('substituted input admitted')
 assert issubclass(a.Runner,a.lifecycle.ModuleConsumerRunner) and 'run' not in a.Runner.__dict__
 assert 'command' not in a.Runner.__dict__
base.rmdir()
`);
});

test('RDF execution rejects shared observer packages resolving outside the installed module', () => {
  python(`
import subprocess
base=pathlib.Path('.test-data/api-observer-boundary');base.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=base) as temp:
 parent=pathlib.Path(temp).resolve();root=parent/'installed';root.mkdir();outside=parent/'outside';outside.mkdir()
 (root/'package.json').write_text('{}')
 (root/'entry.mjs').write_text('globalThis.fetch=async()=>({ok:true});')
 def package(name,body):
  directory=root/'node_modules'/name;directory.mkdir(parents=True)
  (directory/'package.json').write_text(json.dumps(dict(main='index.cjs')))
  (directory/'index.cjs').write_text(body)
 package('@comunica/query-sparql-solid',"exports.QueryEngine=class {async queryBindings(){return {toArray:async()=>[new Map([['value',{value:'actual-installed-rdf'}]])]};}async invalidateHttpCache(){}};")
 package('n3','exports.Store=class {};exports.DataFactory={namedNode:x=>x,literal:x=>x,quad:(...x)=>x};')
 (outside/'package.json').write_text(json.dumps(dict(main='index.cjs')))
 (outside/'index.cjs').write_text('exports.ActionObserverHttp=class {};exports.ActionObserverHttp.prototype.__xpodObservedActorsPatched=true;')
 for name in ['actor-query-result-serialize-sparql-json','actor-query-result-serialize-stats']:
  (root/'node_modules/@comunica'/name).symlink_to(outside,target_is_directory=True)
 script=m.write_probe(parent,'rdf')
 result=subprocess.run(['node',str(script),str(root)],capture_output=True,text=True,timeout=10)
 assert result.returncode!=0 and 'observer outside installed module' in result.stderr
 assert '"rdf":true' not in result.stdout
base.rmdir()
`);
});
