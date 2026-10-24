"""Normal build-program notice lifecycle (real collection/receipt schema)."""
import hashlib,json,os,re,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def program_body():
 return (ROOT/'qlever/scripts/run-focused-native-build.sh').read_text().split("<<'NOTICE_COPY_PY'\n",1)[1].split('\nNOTICE_COPY_PY',1)[0]
class BuildProgramNoticeLifecycle(unittest.TestCase):
 def program(self,workspace,sdk,artifact,output,collections=None,deps=None,materials=None):
  script=program_body()
  if collections is not None:
   script=script.replace("SDK_COLLECTION = '/opt/qlever-sdk/materials/fetchcontent/materials.json'","SDK_COLLECTION = "+json.dumps(str(collections)))
  if deps is not None:
   script=script.replace("SDK_DEPENDENCIES = '/opt/qlever-sdk/dependencies'","SDK_DEPENDENCIES = "+json.dumps(str(deps)))
  if materials is not None:
   # v12 opens the declared inventory under the materials root; bind it to the
   # same directory the collection refs are relative to.
   script=script.replace("MATERIALS_ROOT = '/opt/qlever-sdk/materials'","MATERIALS_ROOT = "+json.dumps(str(materials)))
  return subprocess.run(['/usr/bin/python3','-c',script,str(workspace),str(sdk),str(artifact),str(output)],capture_output=True,text=True)
 def inventory(self,materials,name,files):
  """A REAL sharded physical inventory, shaped exactly like
  sdk-fetchcontent-materials.py physical_inventory()."""
  import stat as _stat
  rows=[]
  for path in files:
   data=path.read_bytes()
   rows.append(dict(path=path.name if path.parent.name==name else str(path).split(name+'/',1)[1],
    kind='file',mode=_stat.S_IMODE(path.stat().st_mode),bytes=len(data),
    sha256=hashlib.sha256(data).hexdigest()))
  directory=materials/'fetchcontent'/name;directory.mkdir(parents=True,exist_ok=True)
  shard=directory/'inventory-0000.json'
  shard.write_bytes(json.dumps(dict(schemaVersion=1,files=rows),sort_keys=True).encode())
  raw=shard.read_bytes()
  index=directory/'source-inventory.json'
  index.write_bytes(json.dumps(dict(schemaVersion=1,files=len(rows),
   bytes=sum(row['bytes'] for row in rows),
   shards=[dict(path=str(shard.relative_to(materials)),bytes=len(raw),
                sha256=hashlib.sha256(raw).hexdigest())],emptyDirectories=[]),
   sort_keys=True).encode())
  index_raw=index.read_bytes()
  return dict(path=str(index.relative_to(materials)),bytes=len(index_raw),
              sha256=hashlib.sha256(index_raw).hexdigest())
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');base=Path(self.tmp.name)
  self.ws=base/'ws';self.sdk=base/'sdk';self.art=base/'artifact';self.out=base/'out'
  for p in (self.ws,self.sdk,self.art,self.out):p.mkdir()
  (self.ws/'qlever').mkdir();(self.ws/'qlever/scripts').mkdir();(self.ws/'qlever/include').mkdir()
  # V13: real ancestor licence at the workspace ROOT (no qlever/LICENSE exists).
  (self.ws/'LICENSE').write_bytes(b'workspace license\n')
  (self.ws/'qlever/include/NOTICE').write_bytes(b'include notice\n')
  (self.ws/'node_modules').mkdir();(self.ws/'node_modules/LICENSE').write_bytes(b'node modules\n')
  (self.sdk/'LICENSE').write_bytes(b'upstream license\n')
 def tearDown(self):self.tmp.cleanup()
 def test_real_roots_only_and_receipt_contract(self):
  r=self.program(self.ws,self.sdk,self.art,self.out);self.assertEqual(r.returncode,0,r.stderr)
  receipt=json.loads((self.out/'notices.receipt.json').read_bytes())
  self.assertEqual(receipt['kind'],'fixed-native-build-notice-copy')
  self.assertEqual(receipt['outputRoot'],str(self.out));self.assertEqual(receipt['artifactRoot'],str(self.art))
  relatives=sorted(row['relative'] for row in receipt['rows'])
  self.assertIn('notices/upstream/LICENSE',relatives)
  self.assertIn('notices/workspace/LICENSE',relatives)
  self.assertIn('notices/workspace/include/NOTICE',relatives)
  self.assertNotIn('notices/node_modules/LICENSE',','.join(relatives))
  for row in receipt['rows']:
   self.assertTrue(row['contributor']['kind']);self.assertTrue(row['sourceOriginal']['kind'])
   self.assertEqual(hashlib.sha256((self.art/row['relative']).read_bytes()).hexdigest(),row['sha256'])
  self.assertIn('pinned-SDK-FetchContent-prepared-collection-absent',receipt['pending'])
 def test_real_fetchcontent_collection_shape_and_unused_roots(self):
  deps=Path(self.tmp.name)/'deps';deps.mkdir();(deps/'demo').mkdir();(deps/'demo/LICENSE').write_bytes(b'demo license\n')
  (deps/'unused').mkdir();(deps/'unused/LICENSE').write_bytes(b'unused\n')
  materials=Path(self.tmp.name)/'materials'
  inv=self.inventory(materials,'demo',[deps/'demo/LICENSE'])
  coll=Path(self.tmp.name)/'materials.json'
  coll.write_text(json.dumps(dict(schemaVersion=1,kind='qlever-sdk-fetchcontent-prepared-originals',
    sourceRoot='/opt/qlever-sdk/source',dependenciesRoot=str(deps),
    dependencies=[dict(name='demo',sourceRoot=str(deps/'demo'),sourceInventory=inv)])))
  r=self.program(self.ws,self.sdk,self.art,self.out,collections=coll,deps=deps,materials=materials)
  self.assertEqual(r.returncode,0,r.stderr)
  receipt=json.loads((self.out/'notices.receipt.json').read_bytes())
  relatives=[row['relative'] for row in receipt['rows']]
  self.assertIn('notices/dependency/demo/LICENSE',relatives)
  self.assertNotIn('notices/dependency/unused/LICENSE',relatives)
  self.assertIn('declared-dependency-unused-roots:unused',receipt['pending'])
  row=next(row for row in receipt['rows'] if row['relative'].endswith('demo/LICENSE'))
  self.assertEqual(row['contributor']['kind'],'fetchcontent-declared')
 def test_wrong_schema_collection_is_rejected(self):
  coll=Path(self.tmp.name)/'bad.json';coll.write_text(json.dumps(dict(schemaVersion=1,kind='wrong',dependencies=[])))
  r=self.program(self.ws,self.sdk,self.art,self.out,collections=coll)
  self.assertNotEqual(r.returncode,0)
 def test_producer_and_receiver_require_absolute_sourcepath_contributor(self):
  receiver=(ROOT/'qlever/scripts/sdk-service-native-runtime-receiver.py').read_text()
  self.assertIn("'/opt/qlever-sdk/dependencies/'",receiver)
  self.assertIn("row.get('contributor')",receiver)
  producer=(ROOT/'qlever/scripts/sdk-service-native-runtime-originals.py').read_text()
  # v12 C0/C1/C2: the receipt/retention plane comes from the declared P1
  # constants (not a literal path), and the physical sourcePath is CARRIED from
  # the program instead of being reconstructed from the semantic key.
  self.assertIn("receipt_path = Path(PROGRAM_OUTPUT_ROOT) / RECEIPT_NAME",producer)
  self.assertIn("produced = program_artifact_root / item['relative']",producer)
  self.assertIn("container_source = item.get('sourcePath')",producer)
  # The defect was RECONSTRUCTING the physical path from the semantic key; the
  # key parse itself stays because the universe label is still needed.
  self.assertNotIn("'/workspace/xpod/qlever/' + relative_key.split('/', 2)[-1]",producer)
  self.assertNotIn("'/opt/qlever-sdk/dependencies/' + relative_key.split('/', 2)[-1]",producer)
 def test_normal_workflow_nine_flags_no_new_cli(self):
  workflow=(ROOT/'.github/workflows/publish-qlever-local-runtime.yml').read_text()
  block=workflow.split('python3 qlever/scripts/sdk-service-native-runtime-host.py',1)[1].split('\n          python3 -',1)[0]
  parsed=set(re.findall(r'--[a-z-]+',block))
  self.assertEqual(parsed,{'--source-sha','--sdk-image','--runtime-image','--run-id','--run-attempt','--job','--out','--maximum-bytes','--deadline-monotonic'})
if __name__=='__main__':unittest.main()
