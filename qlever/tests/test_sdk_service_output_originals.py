import hashlib,importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('service_output',HERE/'sdk-service-image-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
IMAGE='ghcr.io/undefinedsco/xpod@sha256:'+'a'*64
CONFIG='sha256:'+'b'*64
CID='c'*64
NONCE='d'*32
NAME='xpod-service-output-'+NONCE
class Budget:
 def check(self,*args):pass
 def timeout(self,cap,*args):return cap

def inspect(cid=CID,name=NAME,running=False):
 return json.dumps(dict(Id=cid,Image=CONFIG,Name='/'+name,Config=dict(Image=IMAGE,Labels={m.OUTPUT_LABEL:NONCE}),State=dict(Running=running,Status='running' if running else 'created',Pid=1 if running else 0,StartedAt='now' if running else '0001-01-01T00:00:00Z'))).encode()
def archive(items):
 raw=io.BytesIO()
 with tarfile.open(fileobj=raw,mode='w',format=tarfile.USTAR_FORMAT) as stream:
  for name,data,kind in items:
   info=tarfile.TarInfo(name);info.type=kind;info.size=len(data) if kind==tarfile.REGTYPE else 0;info.linkname='elsewhere' if kind==tarfile.SYMTYPE else '';stream.addfile(info,io.BytesIO(data))
 return raw.getvalue()
class OutputOriginals(unittest.TestCase):
 def test_fixed_local_commands_never_start_or_pull_implicitly(self):
  rows={role:m.output_image_command(role,IMAGE,NAME,NONCE,CID) for role in m.OUTPUT_ROLES}
  self.assertIn('--pull=never',rows['create']);self.assertIn('unix:///var/run/docker.sock',rows['pull']);self.assertEqual(rows['copy'][-2:],[CID+':/app/package.json','-'])
  self.assertEqual(rows['inspect'][-2:],[m.OUTPUT_INSPECT_TEMPLATE,CID]);self.assertFalse(any('start' in row for row in rows.values()))
  for args in [('copy',IMAGE,NAME,NONCE,'short'),('create',IMAGE,NAME+'x',NONCE,None),('start',IMAGE,NAME,NONCE,CID)]:
   with self.assertRaises(ValueError):m.output_image_command(*args)
 def test_inspect_ownership_and_never_started_are_separate(self):
  m.inspect_output_container(inspect(),IMAGE,CONFIG,CID,NAME,NONCE)
  with self.assertRaises(ValueError):m.inspect_output_container(inspect(running=True),IMAGE,CONFIG,CID,NAME,NONCE)
  m.inspect_output_container(inspect(running=True),IMAGE,CONFIG,CID,NAME,NONCE,require_never_started=False)
  with self.assertRaises(ValueError):m.inspect_output_container(inspect(name='foreign'),IMAGE,CONFIG,CID,NAME,NONCE,require_never_started=False)
 def test_tar_single_original_and_adversarial_members(self):
  root=HERE.parents[1]/'.test-data/service-output-tests';root.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=root) as directory:
   file=Path(directory)/'original.tar';file.write_bytes(archive([('package.json',b'{"name":"actual"}',tarfile.REGTYPE)]));self.assertEqual(m.service_manifest_tar(file,lambda:None),b'{"name":"actual"}')
   for rows in [[('../package.json',b'{}',tarfile.REGTYPE)],[('package.json',b'',tarfile.SYMTYPE)],[('package.json',b'{}',tarfile.REGTYPE),('extra',b'x',tarfile.REGTYPE)],[('package.json',b'x'*(m.OUTPUT_MANIFEST_LIMIT+1),tarfile.REGTYPE)]]:
    file.write_bytes(archive(rows))
    with self.assertRaises(ValueError):m.service_manifest_tar(file,lambda:None)
 def run_observation(self,failure=None):
  root=HERE.parents[1]/'.test-data/service-output-tests';root.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=root) as directory:
   out=Path(directory);retained=m.Retained(out,Budget());calls=[]
   def capture(label,argv,*args,**kwargs):
    role=argv[argv.index('--image-worker')+1];calls.append((role,argv[argv.index('--container-id')+1] if '--container-id' in argv else None))
    data={'pull':b'pulled','create':(CID+'\n').encode(),'inspect':inspect(),'copy':archive([('package.json',b'{"name":"image"}',tarfile.REGTYPE)]),'remove':(CID+'\n').encode(),'confirm-absent':b'','cleanup-list':(CID+'\n').encode(),'cleanup-inspect':inspect(),'cleanup-remove':(CID+'\n').encode(),'cleanup-confirm-absent':b''}[role]
    if failure=='foreign-cid' and role=='create':data=('e'*64+'\n').encode()
    if failure=='foreign-cid' and role=='inspect':data=inspect(cid='e'*64,name='foreign')
    if failure=='copy' and role=='copy':raise ValueError('copy failed')
    row={'name':label,'inputs':[],'outputs':[]}
    for key in ('receipt','stdout','stderr','supervisionReceipt','supervisionRaw'):
     path=out/(label+'.'+key);body=data if key=='stdout' else b'{}';path.write_bytes(body);row[key]=dict(path=path.name,bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
    return row
   with patch.object(m.secrets,'token_hex',return_value=NONCE),patch.object(m.outer.commands,'capture',side_effect=capture):
    if failure:
     with self.assertRaises(ValueError):m.observe_output_image(IMAGE,CONFIG,retained,out,'f'*40)
     self.assertTrue((out/'output/failure.original.json').exists())
    else:
     ref,record=m.observe_output_image(IMAGE,CONFIG,retained,out,'f'*40);self.assertEqual((out/ref['path']).read_bytes(),b'{"name":"image"}');self.assertEqual(record['containerId'],CID);self.assertEqual([row['name'] for row in record['stages']],['service-output-'+role for role in m.OUTPUT_ROLES])
    return calls
 def test_full_capture_contract(self):self.run_observation()
 def test_copy_failure_removes_only_verified_owned_id(self):
  calls=self.run_observation('copy');self.assertEqual(calls[-2:],[('cleanup-remove',CID),('cleanup-confirm-absent',CID)])
 def test_unverified_create_stdout_cannot_authorize_foreign_removal(self):
  calls=self.run_observation('foreign-cid');self.assertIn(('cleanup-list',None),calls);self.assertIn(('cleanup-inspect',CID),calls);self.assertNotIn(('cleanup-remove','e'*64),calls);self.assertEqual(calls[-2:],[('cleanup-remove',CID),('cleanup-confirm-absent',CID)])
if __name__=='__main__':unittest.main()
