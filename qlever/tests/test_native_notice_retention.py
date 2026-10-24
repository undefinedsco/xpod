"""Shared build-program notice copy: exact bytes, nofollow, receipt."""
import hashlib,json,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def program_body():
 return (ROOT/'qlever/scripts/run-focused-native-build.sh').read_text().split("<<'NOTICE_COPY_PY'\n",1)[1].split('\nNOTICE_COPY_PY',1)[0]
class NoticeRetention(unittest.TestCase):
 def run_program(self,workspace,sdk,artifact,out):
  return subprocess.run(['/usr/bin/python3','-c',program_body(),str(workspace),str(sdk),str(artifact),str(out)],capture_output=True,text=True)
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');base=Path(self.tmp.name)
  self.workspace=base/'ws';self.sdk=base/'sdk';self.artifact=base/'artifact';self.out=base/'out'
  for path in (self.workspace,self.sdk,self.artifact,self.out):path.mkdir()
  (self.workspace/'qlever').mkdir()
  # V13: the real checkout has NO qlever/LICENSE; the authoritative ancestor
  # licence is the REPOSITORY ROOT LICENSE, which the runtime Dockerfile COPYs.
  (self.workspace/'LICENSE').write_bytes(b'workspace license\n')
  (self.sdk/'LICENSE').write_bytes(b'upstream license\n')
 def tearDown(self):self.tmp.cleanup()
 def test_actual_program_copies_exact_bytes_and_modes(self):
  result=self.run_program(self.workspace,self.sdk,self.artifact,self.out);self.assertEqual(result.returncode,0,result.stderr)
  receipt=json.loads((self.out/'notices.receipt.json').read_bytes())
  for row in receipt['rows']:
   copied=self.artifact/row['relative']
   self.assertEqual(copied.stat().st_size,row['bytes'])
   self.assertEqual(hashlib.sha256(copied.read_bytes()).hexdigest(),row['sha256'])
   self.assertEqual(copied.stat().st_mode&0o777,0o644)
  self.assertEqual((self.artifact/'notices/upstream/LICENSE').read_bytes(),b'upstream license\n')
  self.assertEqual((self.artifact/'notices/workspace/LICENSE').read_bytes(),b'workspace license\n')
 def test_absent_sdk_and_symlink_are_pending_or_refused(self):
  absent=Path(self.tmp.name)/'absent-sdk'
  result=self.run_program(self.workspace,absent,self.artifact,self.out);self.assertEqual(result.returncode,0,result.stderr)
  self.assertIn('authenticated-upstream-source-root-absent',json.loads((self.out/'notices.receipt.json').read_bytes())['pending'])
  symlink_ws=Path(self.tmp.name)/'ws2';symlink_ws.mkdir();(symlink_ws/'qlever').mkdir();target=Path(self.tmp.name)/'target';target.write_bytes(b'x\n')
  (symlink_ws/'LICENSE').symlink_to(target)
  result=self.run_program(symlink_ws,self.sdk,self.artifact,self.out)
  if result.returncode==0:
   rows=json.loads((self.out/'notices.receipt.json').read_bytes())['rows']
   self.assertNotIn('notices/workspace/LICENSE',[row['relative'] for row in rows])
 def test_fifo_is_never_accepted(self):
  fifo_ws=Path(self.tmp.name)/'ws3';fifo_ws.mkdir();(fifo_ws/'qlever').mkdir();__import__('os').mkfifo(fifo_ws/'qlever/NOTICE')
  result=self.run_program(fifo_ws,self.sdk,self.artifact,self.out)
  if result.returncode==0:
   rows=json.loads((self.out/'notices.receipt.json').read_bytes())['rows']
   self.assertNotIn('notices/workspace/NOTICE',[row['relative'] for row in rows])
if __name__=='__main__':unittest.main()
