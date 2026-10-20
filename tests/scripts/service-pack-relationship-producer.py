"""Actual collector control flow with mocked transport; no Docker or issuer."""
import base64,importlib.util,json,os,tempfile,time,types
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('pack_flow_fixture',ROOT/'qlever/tests/test_service_pack_collector_full.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f);m=f.m
case=f.Tests();case.setUp()
try:
 case.fixture();root=case.out;source=root/'checkout';source.mkdir();raw=b'{"name":"@undefineds.co/xpod","version":"1.0.0"}';(source/'package.json').write_bytes(raw)
 before=root/'before.json';after=root/'after.json';before.write_bytes(raw);after.write_bytes(raw);metadata=root/'build.json';metadata.write_text(json.dumps({'containerimage.digest':case.image.split('@')[1],'containerimage.config.digest':case.config}));case.out=root/'service-image-originals'
 args=types.SimpleNamespace(source_sha=case.sha,sdk_artifact_id=1,sdk_master_bytes=1,sdk_artifact_digest='a'*64,sdk_master_sha256='b'*64,service_image=case.image,local_runtime_image='ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:'+'e'*64,sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'f'*64,source=str(source),out=str(case.out),deadline=time.time()+60,root_manifest_before=str(before),root_manifest_after=str(after),build_metadata=str(metadata),capture_service_pack_originals=True)
 def capture(label,argv,*a,**kw):
  if not label.startswith('service-source-'):return case.capture(label,argv,*a,**kw)
  data={'head':(case.sha+'\n').encode(),'manifest':raw,'status':b''}[label.removeprefix('service-source-')];directory=case.out/'stages'/label;directory.mkdir(parents=True);row=dict(name=label,inputs=[],outputs=[])
  for role in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:
   path=directory/(role+'.raw');body=data if role=='stdout'else b'{}';path.write_bytes(body);row[role]=f.ref(path.relative_to(case.out).as_posix(),body)
  return row
 def registry(image,target,out,**kw):
  out.mkdir();config=out/'config.json';manifest=out/'manifest.json';config.write_bytes(b'{}');manifest.write_bytes(b'{}');return dict(configDigest=case.config,configOriginal=f.ref(config.relative_to(case.out).as_posix(),b'{}'),manifestOriginal=f.ref(manifest.relative_to(case.out).as_posix(),b'{}'))
 with patch.dict(os.environ,{'GITHUB_SHA':case.sha,'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','RUNNER_TEMP':str(root),'GITHUB_OUTPUT':str(root/'github-output')}),patch.object(m.secrets,'token_hex',return_value=case.nonce),patch.object(m.outer.commands,'capture',side_effect=capture),patch.object(m.images,'registry_originals',side_effect=registry),patch.object(m,'inspect_relationship',return_value={'fixtureOnly':True}):master=m.capture(args)
 members=[dict(path=p.relative_to(case.out).as_posix(),bytes=p.stat().st_size,sha256=m.hashlib.sha256(p.read_bytes()).hexdigest()) for p in case.out.rglob('*')if p.is_file()]
 data={row['path']:base64.b64encode((case.out/row['path']).read_bytes()).decode()for row in members};print(json.dumps(dict(master=master,members=members,data=data)))
finally:case.doCleanups()
