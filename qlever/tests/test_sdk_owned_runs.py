"""Recipe/owner-reference contracts only. Actual Linux PID1 probes are separate."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
owned=load('owned_contract','sdk-owned-runs.py');image=load('owner_image_contract','sdk-image-originals.py')

class OwnedRunsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):(ROOT/'.test-data/sdk-owned-runs').mkdir(parents=True,exist_ok=True)
    def fixture(self,out):
        (out/'inner').mkdir();values={}
        for role,recipe in owned.RUNS.items():
            row=dict(schemaVersion=1,kind='linux-kernel-owned-subreaper-guard-original',guardPid=1,
                topCommandPid=2,pidNamespace='pid:[123]',topCommandPidNamespace='pid:[123]',command=list(recipe.command),
                globalDeadlineUnix=12345,topCommandActualWait=True,topCommandReturnCode=0,
                reason=None,error=None,observedSignals=[],cleanup=dict(actualEchild=True,signalledPidfds=[],reaped=[]))
            (out/'inner'/recipe.receipt).write_text(json.dumps(row));values[role]=row
        return values
    def test_whole_docker_run_exec_and_fixed_postchecks(self):
        recipe=(ROOT/'docker/qlever-runtime-sdk/Dockerfile.module-bookworm').read_text()
        for role in owned.RUNS:
            self.assertIn('exec python3 /components/qlever/scripts/sdk-owned-runs.py '+role,recipe)
            subprocess.run(['bash','-n','-c',owned.RUNS[role].command[-1]],check=True)
        self.assertNotIn('&& XPOD_QLEVER_SDK_DEADLINE_UNIX',recipe)
        self.assertIn('test -f /opt/qlever-sdk/profile/inputs.json',owned.RUNS['build'].command[-1])
        self.assertIn('rm -rf /var/lib/apt/lists/*',owned.RUNS['build'].command[-1])
        self.assertIn('install -y --no-install-recommends nodejs',owned.RUNS['linked'].command[-1])
        self.assertIn('owner-linked.guard.json',recipe)
    def test_same_deadline_and_single_guard_initialization(self):
        with patch.dict(owned.os.environ,{'XPOD_QLEVER_SDK_DEADLINE_UNIX':'12345'}),patch.object(owned.guard,'run',return_value=0) as run:
            self.assertEqual(owned.main('build'),0)
            run.assert_called_once_with(list(owned.RUNS['build'].command),owned.MATERIALS/owned.RUNS['build'].receipt,12345.0,emit_receipt=True)
    def test_owner_refs_schema_and_failed_execution_rejected(self):
        for mutation in [None,'pid','namespace','command','deadline','signal','cleanup','return-boolean']:
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-owned-runs') as directory:
                out=Path(directory);values=self.fixture(out);row=values['build']
                if mutation=='pid':row['guardPid']=2
                if mutation=='namespace':row['topCommandPidNamespace']='pid:[456]'
                if mutation=='command':row['command']=list(owned.RUNS['linked'].command)
                if mutation=='deadline':row['globalDeadlineUnix']=12346
                if mutation=='signal':row['observedSignals']=[15]
                if mutation=='cleanup':row['cleanup']['actualEchild']=False
                if mutation=='return-boolean':row['topCommandReturnCode']=False
                (out/'inner'/owned.RUNS['build'].receipt).write_text(json.dumps(row))
                if mutation:
                    with self.assertRaises(ValueError):image.collect_execution_owners(out,12345)
                else:
                    refs=image.collect_execution_owners(out,12345)
                    self.assertEqual(set(refs),set(owned.RUNS))
                    for role,ref in refs.items():self.assertEqual(ref['path'],'inner/'+owned.RUNS[role].receipt)

if __name__=='__main__':unittest.main()
