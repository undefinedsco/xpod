"""Execute the actual reviewed inline controller bootstrap; no Docker/sudo."""
import json,os,subprocess,sys,tempfile,textwrap,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class Bootstrap(unittest.TestCase):
 def test_actual_inline_module_service_and_unknown_profile(self):
  workflow=(ROOT/'.github/workflows/qlever-readonly-normal-job.yml').read_text();script=textwrap.dedent(workflow.split("<<'PYCODE'\n",1)[1].split('\n          PYCODE',1)[0]);base=ROOT/'.test-data/service-bootstrap';base.mkdir(parents=True,exist_ok=True)
  # The reviewed controller requires the exact diagnostic/publish modes; they are
  # part of the workflow's real environment contract, not optional inputs.
  for profile,success in [('module-bookworm-gcc12',True),('service-trixie',True),('unknown',False)]:
   with tempfile.TemporaryDirectory(dir=base) as temp:
    root=Path(temp).resolve();event=root/'event.json';event.write_text('{}');output=root/'output';env=dict(os.environ,SOURCE=str(ROOT),DEST=str(root/'controller'),TARGET='linux-x64',SOURCE_SHA='a'*40,REQUESTED_SHA='a'*40,EVENT=str(event),RUN_ID='1',ATTEMPT='1',OUTPUT=str(output),SDK_PROFILE=profile,KERNEL_PROBE_ONLY='false',PUBLISH='false')
    result=subprocess.run([sys.executable,'-I','-S','-B','-c',script],env=env,capture_output=True,timeout=10)
    self.assertEqual(result.returncode==0,success,result.stderr.decode())
    if success:
     rows=dict(line.split('=',1)for line in output.read_text().splitlines());self.assertEqual(json.loads(rows['identity'])['sdkProfile'],profile);self.assertTrue((root/'controller/qlever/scripts/sdk-local-daemon-originals.py').is_file())
    else:self.assertFalse(output.exists())
 def test_exact_diagnostic_and_publish_modes_are_required(self):
  """Kernel diagnostics are service-trixie only and can never publish."""
  workflow=(ROOT/'.github/workflows/qlever-readonly-normal-job.yml').read_text();script=textwrap.dedent(workflow.split("<<'PYCODE'\n",1)[1].split('\n          PYCODE',1)[0]);base=ROOT/'.test-data/service-bootstrap';base.mkdir(parents=True,exist_ok=True)
  for overrides,message in [
    ({'PUBLISH':'maybe'},'Exact diagnostic/publish modes required'),
    ({'KERNEL_PROBE_ONLY':'yes'},'Exact diagnostic/publish modes required'),
    ({'KERNEL_PROBE_ONLY':'true','PUBLISH':'true'},'Kernel diagnostics require service-trixie and cannot publish'),
    ({'KERNEL_PROBE_ONLY':'true','SDK_PROFILE':'module-bookworm-gcc12'},'Kernel diagnostics require service-trixie and cannot publish'),
  ]:
   with tempfile.TemporaryDirectory(dir=base) as temp:
    root=Path(temp).resolve();event=root/'event.json';event.write_text('{}')
    env=dict(os.environ,SOURCE=str(ROOT),DEST=str(root/'controller'),TARGET='linux-x64',SOURCE_SHA='a'*40,REQUESTED_SHA='a'*40,EVENT=str(event),RUN_ID='1',ATTEMPT='1',OUTPUT=str(root/'output'),SDK_PROFILE='service-trixie',KERNEL_PROBE_ONLY='false',PUBLISH='false');env.update(overrides)
    result=subprocess.run([sys.executable,'-I','-S','-B','-c',script],env=env,capture_output=True,timeout=10)
    self.assertNotEqual(result.returncode,0)
    self.assertIn(message,result.stderr.decode())
if __name__=='__main__':unittest.main()
