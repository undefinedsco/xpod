"""Small real capture/retention protocol fixture, never a GitHub/source issuer."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
capture=load('retention_capture','scripts/lib/module-source-materials.py');controlled=load('retention_controlled','scripts/lib/inngest-controlled-build.py');producer=load('retention_producer','scripts/api-module-producer.py')
def run(output,mode):
 output.mkdir();work=output/'controlled-inngest-work';source=work/'source';tools=work/'tools';(source/'node_modules/dependency').mkdir(parents=True);tools.mkdir()
 (source/'actual.go').write_bytes(b'package main\n'*10000);(source/'LICENSE.md').write_bytes(b'fixture terms');(source/'node_modules/dependency/index.js').write_bytes(b'export const value=1;\n'*10000);(tools/'actual-tool').write_bytes(b'fixed tool bytes\n'*10000)
 def put(name,value):
  file=work/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(value if isinstance(value,bytes)else json.dumps(value,separators=(',',':')).encode());return controlled.reference(file,work)
 names=['inngest-source.tar.gz','go1.26.4.linux-arm64.tar.gz','node-v20.19.6-linux-arm64.tar.xz','pnpm-10.18.2.tgz'];originals=[put('originals/'+name,name.encode())for name in names];http=[put(name+'.http.original.json',dict(status=200))for name in names]
 prep=put('preparation.original.json',dict(sourceKind=controlled.POLICY['sourceKind'],sourceCommit=controlled.POLICY['sourceCommit'],originals=originals,acquisitionOriginals=http))
 controlled.capture_inputs(work,'linux-arm64');inputs=json.loads((work/'inputs.original.json').read_text());collection=dict(schemaVersion=1,sourceKind=controlled.POLICY['sourceKind'],target='linux-arm64',sourceCommit=controlled.POLICY['sourceCommit'],preparation=prep,inputs=controlled.reference(work/'inputs.original.json',work),originals=inputs['originals'],generated=dict(changedCount=0,removedCount=0,removedOriginals=[],originals=dict(archives=[],inventories=[])),binary=put('products/inngest',b'actual binary fixture'),license=controlled.reference(source/'LICENSE.md',work),sourceArchive=originals[0])
 archive=collection['originals']['source']['archives'][0]
 if mode=='unknown':archive['encoding']='other'
 if mode=='missing-index':del archive['index']
 if mode=='wrong-hash':archive['index']['sha256']='0'*64
 original=put('controlled-build-materials.json',collection)
 before={str(p.relative_to(work)):hashlib.sha256(p.read_bytes()).hexdigest()for p in work.rglob('*')if p.is_file()};reservations=[]
 def reserve(n):
  reservations.append(n)
  if mode=='budget':raise ValueError('fixture reserve rejects before move')
 try:
  retained=producer.retain_controlled_originals(output,reserve);failure=None
 except Exception as error:retained=None;failure=str(error)
 destination=output/'source-materials/native-builds/inngest';after={str(p.relative_to(work)):hashlib.sha256(p.read_bytes()).hexdigest()for p in work.rglob('*')if p.is_file()}
 result=dict(scope='real local capture/retention/reader mechanics; not actual GHA/source capability',mode=mode,retained=retained,failure=failure,reservations=reservations,sourcePreserved=before==after,destinationExists=destination.exists())
 if retained:
  result.update(collection=collection,originalInventory=[producer.reference(p,output)for p in sorted(destination.rglob('*'))if p.is_file()],uniqueActualBytes=sum(p.stat().st_size for p in destination.rglob('*')if p.is_file()),collectionBytesUnchanged=hashlib.sha256((destination/'controlled-build-materials.json').read_bytes()).hexdigest()==original['sha256'])
 return result
if __name__=='__main__':print(json.dumps(run(Path(sys.argv[1]),sys.argv[2])))
