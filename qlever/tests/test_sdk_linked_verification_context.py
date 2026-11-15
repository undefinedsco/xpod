"""Actual bounded context bytes and exporter protocol; no Docker/SDK authority."""
import hashlib,importlib.util,io,json,os,tarfile,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('verification_context',ROOT/'qlever/scripts/sdk-readonly-result-context.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class VerificationContext(unittest.TestCase):
 def context(self,root,defect=None):
  rows=[]
  with tarfile.open(root/'context.original.tar','w') as archive:
   for index,name in enumerate(module.VERIFICATION_SCRIPTS):
    data=('original-'+name).encode();source='qlever/scripts/'+name;row=dict(file=dict(path=source,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()),mode=0o755);rows.append(row)
    if defect=='missing' and index==2:continue
    info=tarfile.TarInfo(source);info.size=len(data);info.mode=0o755
    if defect=='mode' and index==1:info.mode=0o644
    if defect=='bytes' and index==0:data=b'X'+data[1:]
    archive.addfile(info,io.BytesIO(data))
    if defect=='duplicate' and index==0:archive.addfile(info,io.BytesIO(data))
   info=tarfile.TarInfo('qlever/extra-private-source');info.size=7;archive.addfile(info,io.BytesIO(b'unused!'))
  raw=(root/'context.original.tar').read_bytes();record=dict(schemaVersion=1,sourceSha='a'*40,files=rows,archive=dict(path='context.original.tar',bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
  if defect=='archive':record['archive']['sha256']='f'*64
  if defect=='metadata':record['files'].append(rows[0])
  (root/'context-originals.json').write_text(json.dumps(record));return root/'context-originals.json'
 def test_actual_same_tar_three_fixed_members_and_all_reference_negatives(self):
  for defect in [None,'missing','mode','bytes','duplicate','archive','metadata']:
   with self.subTest(defect=defect),tempfile.TemporaryDirectory() as directory:
    root=Path(directory);context=self.context(root,defect);checks=[]
    if defect is None:
     result=module.verification_originals(context,'a'*40,lambda:checks.append(1));self.assertEqual([row[0]for row in result],list(module.VERIFICATION_SCRIPTS));self.assertTrue(all(row[1]==('original-'+row[0]).encode()for row in result));self.assertGreater(len(checks),5)
     with self.assertRaises(ValueError):module.verification_originals(context,'b'*40,lambda:None)
     alias=root/'alias';alias.symlink_to(root/'context.original.tar');(root/'context.original.tar').rename(root/'real.tar');(root/'context.original.tar').symlink_to(root/'real.tar')
     with self.assertRaises(OSError):module.verification_originals(context,'a'*40,lambda:None)
    else:
     with self.assertRaises(ValueError):module.verification_originals(context,'a'*40,lambda:None)
 def test_expired_before_read_and_new_generated_linked_recipe_uses_only_late_members(self):
  def expired():raise TimeoutError('same parent deadline')
  with self.assertRaises(TimeoutError):module.verification_originals('/absent','a'*40,expired)
  path=ROOT/'qlever/scripts/sdk-readonly-normal-route.py';spec=importlib.util.spec_from_file_location('verification_route',path);route=importlib.util.module_from_spec(spec);spec.loader.exec_module(route);text=route.linked_dockerfile('sha256:'+'a'*64)
  self.assertNotIn('verification/',text.split('FROM build AS linked-verification')[0]);self.assertNotIn('verification/',text.split('FROM build AS runtime')[1]);self.assertIn('RUN node --version',text)
  for name in module.VERIFICATION_SCRIPTS:self.assertIn('COPY verification/'+name+' /components/qlever/scripts/'+name,text)

 def test_exporter_uses_the_same_charged_context_stream_and_preserves_old_default(self):
  class Child:
   def __init__(self,domain):
    data=io.BytesIO()
    with tarfile.open(fileobj=data,mode='w') as archive:
     info=tarfile.TarInfo(domain+'/actual.bin');info.size=3;archive.addfile(info,io.BytesIO(b'raw'))
    self.stdout=io.BytesIO(data.getvalue())
   def wait(self,timeout=None):return 0
   def poll(self):return 0
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);context=self.context(root)
   def child(command,**kwargs):return Child('build' if command[-2].endswith('/build') else 'materials')
   with patch.object(module.subprocess,'Popen',side_effect=child):
    for mode in ['old','new']:
     out=root/mode;result=module.export('a'*64,out,time.time()+300,1024**2,b'fixed reviewed Dockerfile',context if mode=='new' else None,'a'*40 if mode=='new' else None)
     encoded=b''.join((out/ref['path']).read_bytes()for ref in result['context']);self.assertEqual(len(encoded),result['encodedBytes'])
     with tarfile.open(fileobj=io.BytesIO(encoded)) as archive:
      names=set(archive.getnames());expected={'verification/'+name for name in module.VERIFICATION_SCRIPTS};self.assertEqual(names&expected,expected if mode=='new' else set())
      if mode=='new':
       for name in module.VERIFICATION_SCRIPTS:self.assertEqual(archive.extractfile('verification/'+name).read(),('original-'+name).encode())
    with self.assertRaises(ValueError):module.export('a'*64,root/'too-small',time.time()+300,10,b'fixed',context,'a'*40)
