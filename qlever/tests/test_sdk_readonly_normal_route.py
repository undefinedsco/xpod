import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
HERE=Path(__file__).resolve().parents[1]/'scripts'
def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
route=load('sdk-readonly-normal-route');result=route.result_context
class RouteTest(unittest.TestCase):
    def test_prepared_argv_is_native_exact_and_cold(self):
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
        argv=route.prepared_argv('owned','linux/arm64',identity,100,'metadata.json')
        self.assertEqual(argv[:3],['docker','--host','unix:///var/run/docker.sock']);self.assertIn('source-prepared',argv);self.assertIn('--load',argv);self.assertNotIn('--push',argv)
        with self.assertRaises(ValueError):route.prepared_argv('owned','linux/amd64',identity,100,'metadata.json')
        with self.assertRaises(ValueError):route.prepared_argv('foreign/name','linux/arm64',identity,100,'metadata.json')
    def test_composition_copies_actual_volumes_and_runs_linked_contract(self):
        value=route.linked_dockerfile('sha256:'+'a'*64)
        self.assertIn('COPY build/ /opt/qlever-sdk/build/',value);self.assertIn('COPY materials/ /opt/qlever-sdk/materials/',value)
        self.assertIn('sdk-owned-runs.py linked',value);self.assertNotIn('docker commit',value)
        with self.assertRaises(ValueError):route.linked_dockerfile('latest')
    def test_stream_copy_retains_bytes_without_host_extraction(self):
        raw=io.BytesIO()
        with tarfile.open(fileobj=raw,mode='w') as archive:
            info=tarfile.TarInfo('build/actual');info.size=3;archive.addfile(info,io.BytesIO(b'abc'))
        raw.seek(0);output=io.BytesIO();seen=set()
        with tarfile.open(fileobj=output,mode='w|') as archive:observed=result.copy_tar(raw,archive,'build',lambda:None,seen)
        self.assertGreater(observed['bytes'],3);output.seek(0)
        with tarfile.open(fileobj=output) as archive:self.assertEqual(archive.extractfile('build/actual').read(),b'abc')
    def test_unknown_domain_traversal_hardlinks_and_second_archive_reject(self):
        for name,kind in [('materials/f',tarfile.REGTYPE),('build/../escape',tarfile.REGTYPE),('build/link',tarfile.LNKTYPE)]:
            raw=io.BytesIO()
            with tarfile.open(fileobj=raw,mode='w') as archive:
                info=tarfile.TarInfo(name);info.type=kind;archive.addfile(info)
            raw.seek(0)
            with tarfile.open(fileobj=io.BytesIO(),mode='w|') as archive:
                with self.assertRaises(ValueError):result.copy_tar(raw,archive,'build',lambda:None,set())
    def test_writer_reserves_before_write_and_deadline_rejects(self):
        root=Path(__file__).resolve().parents[2]/'.test-data/sdk-readonly-normal-route';root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            writer=result.Shards(directory,3,lambda:None)
            with self.assertRaises(ValueError):writer.write(b'abcd')
            self.assertEqual(list(Path(directory).iterdir()),[])
            writer.write(b'abc');writer.close();self.assertEqual(writer.refs[0]['bytes'],3)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            def expired():raise TimeoutError('same parent')
            writer=result.Shards(directory,10,expired)
            with self.assertRaises(TimeoutError):writer.write(b'x')
            self.assertEqual(list(Path(directory).iterdir()),[])
    def test_bootstrap_failure_still_attempts_cleanup_with_45_seconds(self):
        import json,os
        from unittest.mock import patch
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
        root=HERE.parents[1]/'.test-data/sdk-readonly-normal-route';root.mkdir(parents=True,exist_ok=True)
        class Budget:
            remaining=120
            def __init__(self,*args):pass
            def check(self,reserve=0):
                if self.remaining<=reserve:raise TimeoutError('reserve')
            def timeout(self,cap,reserve=0):self.check(reserve);return min(cap,self.remaining-reserve)
        budget=Budget();calls=[]
        class Daemon:
            def __init__(self,*args):pass
            def close(self):pass
        with tempfile.TemporaryDirectory(dir=root) as directory:
            directory=Path(directory).resolve();source=directory/'source-context.json';source.write_text(json.dumps({'sourceSha':identity['sourceSha']}));out=directory/'qlever-sdk-outer'
            def capture(name,argv,materials,cwd,**kwargs):
                calls.append(name)
                if name=='create-owned-builder':budget.remaining=45;raise ValueError('actual bootstrap failure')
                if name=='remove-owned-builder':
                    plan=json.loads((out/'cleanup.plan.json').read_text());self.assertEqual(plan['builder'],route.binding.ownership(identity)+'-builder');self.assertEqual(kwargs['timeout'],30);return {}
                path=out/(name+'.raw');path.write_bytes(b'');return {'stdout':{'path':path.name}}
            with patch.dict(os.environ,{'RUNNER_TEMP':str(directory)}),patch.object(route.outer.platform,'system',return_value='Linux'),patch.object(route.os,'geteuid',return_value=0),patch.object(route.outer,'LocalDaemon',Daemon),patch.object(route.outer.budgets,'ExecutionBudget',return_value=budget),patch.object(route.outer.commands,'capture',side_effect=capture):
                with self.assertRaisesRegex(ValueError,'actual bootstrap failure'):route.run(identity,2000000000,out,source)
            self.assertIn('remove-owned-builder',calls)
    def test_cleanup_child_dispatch_uses_remaining_25s_without_work_reserve(self):
        from unittest.mock import patch
        class Budget:
            def check(self,reserve=0):
                if reserve>=25:raise TimeoutError('work reserve exceeds cleanup remaining')
        budget=Budget()
        with patch.object(result.outer.budgets,'ExecutionBudget',return_value=budget),patch.object(result,'cleanup_builder') as cleanup:
            plan={'deadlineUnix':1};result.dispatch('remove-builder',plan);cleanup.assert_called_once_with(plan,budget)
        with patch.object(result.outer.budgets,'ExecutionBudget',side_effect=ValueError('expired')),patch.object(result,'cleanup_builder') as cleanup:
            with self.assertRaisesRegex(ValueError,'expired'):result.dispatch('remove-builder',{'deadlineUnix':0})
            cleanup.assert_not_called()
    def test_regular_log_limit_is_scoped_to_docker_child(self):
        from unittest.mock import patch
        with patch.object(result.resource,'getrlimit',return_value=(99999999,-1)),patch.object(result.resource,'setrlimit') as setlimit:
            result.bound_docker_raw();setlimit.assert_called_once_with(result.resource.RLIMIT_FSIZE,(result.LIMITS['metadataBytes'],-1))
    def test_workflow_pins_complete_host_import_closure_and_has_real_pr_entry(self):
        import hashlib,json,re
        entry=(HERE.parents[1]/'.github/workflows/qlever-readonly-executor.yml').read_text()
        workflow=(HERE.parents[1]/'.github/workflows/qlever-readonly-normal-job.yml').read_text()
        pins=json.loads(re.search(r'          pins=(.*)',workflow).group(1))
        required={'sdk-readonly-normal-route','sdk-readonly-result-context','sdk-readonly-executor','sdk-readonly-executor-bindings','sdk-readonly-executor-entry','sdk-image-originals','sdk-command-materials','sdk-execution-budget','sdk-owned-runs','sdk-subreaper-guard','sdk-tar-budget','sdk-debian-binary-originals','sdk-debian-index-bindings','sdk-readonly-collection','qlever_compiler_profile','sdk-local-daemon-originals'}
        self.assertEqual({Path(p).stem for p in pins if p.startswith('qlever/scripts/')},required)
        for path,sha in pins.items():self.assertEqual(hashlib.sha256((HERE.parents[1]/path).read_bytes()).hexdigest(),sha)
        self.assertIn('  pull_request:',entry);self.assertIn('  workflow_call:',entry);self.assertIn('  workflow_call:',workflow)
        self.assertNotIn('packages: write',workflow);self.assertNotIn('secrets:',workflow);self.assertNotIn('environment:',workflow);self.assertNotIn('rc-',workflow)
        self.assertLess(workflow.index('name: Verify controller closure'),workflow.index('name: Capture immutable source context'))
        self.assertIn('ref: ${{ github.sha }}',workflow);self.assertIn('persist-credentials: false',workflow)
if __name__=='__main__':unittest.main()
