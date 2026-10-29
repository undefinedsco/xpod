import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock
HERE=Path(__file__).resolve().parents[1]/'scripts'
def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
route=load('sdk-readonly-normal-route');result=route.result_context
bindings=load('sdk-readonly-executor-bindings')
class RouteTest(unittest.TestCase):
    def test_kernel_diagnostic_never_runs_sdk_or_seals_sdk_success_and_always_cleans_builder(self):
        import json,os,types
        from unittest.mock import patch,Mock
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='service-trixie')
        root=HERE.parents[1]/'.test-data/sdk-readonly-normal-route';root.mkdir(parents=True,exist_ok=True)
        class Budget:
            def check(self,*args):pass
            def timeout(self,cap,*args):return cap
        class Daemon:
            def __init__(self,*args):pass
            def sample(self,*args):return {'testPeer':1}
            def seal_originals(self):return {'testPeerOriginal':1}
            def close(self):pass
        for mode in ['diagnostic','failed-diagnostic','default-sdk']:
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(dir=root) as directory:
                directory=Path(directory).resolve();source=directory/'source.json';source.write_text(json.dumps({'sourceSha':identity['sourceSha']}));out=directory/'qlever-sdk-outer';calls=[]
                failure=ValueError('actual diagnostic failure');probe=Mock(return_value={'kind':'test-diagnostic-only'})
                if mode=='failed-diagnostic':probe.side_effect=failure
                def capture(name,argv,*args,**kwargs):
                    calls.append(name)
                    if name=='prepare-source-image':(out/'prepared-buildkit.original.json').write_text(json.dumps({'containerimage.config.digest':'sha256:'+'b'*64}))
                    path=out/(name+'.raw');path.write_bytes(b'');return {'stdout':{'path':path.name}}
                with patch.dict(os.environ,{'RUNNER_TEMP':str(directory)}),patch.object(route.outer.platform,'system',return_value='Linux'),patch.object(route.os,'geteuid',return_value=0),patch.object(route.outer,'LocalDaemon',Daemon),patch.object(route.outer.budgets,'ExecutionBudget',return_value=Budget()),patch.object(route.outer.commands,'capture',side_effect=capture),patch.object(route,'load',return_value=types.SimpleNamespace(run=probe)) as load,patch.object(route,'remaining_ledger',return_value=12345),patch.object(route.time,'time',return_value=1000),patch.object(route.outer,'execute',side_effect=RuntimeError('default SDK route reached')) as execute:
                    if mode=='diagnostic':
                        result=route.run(identity,1100,out,source,True)
                        self.assertFalse(result['sdkQualified']);self.assertFalse(result['releaseAccepted']);self.assertEqual(result['sourcePreparedConfig'],'sha256:'+'b'*64)
                        probe.assert_called_once_with('sha256:'+'b'*64,identity,1100,out/'kernel-probe',12345);execute.assert_not_called()
                    elif mode=='failed-diagnostic':
                        with self.assertRaises(ValueError) as raised:route.run(identity,1100,out,source,True)
                        self.assertIs(raised.exception,failure);execute.assert_not_called()
                        self.assertFalse((out/'kernel-probe-route.original.json').exists())
                    else:
                        with self.assertRaisesRegex(RuntimeError,'default SDK route reached'):route.run(identity,1100,out,source)
                        execute.assert_called_once();load.assert_not_called();probe.assert_not_called()
                self.assertIn('remove-owned-builder',calls)
                self.assertFalse((out/'normal-route.original.json').exists())
    def test_prepared_argv_is_native_exact_and_cold(self):
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
        argv=route.prepared_argv('owned','linux/arm64',identity,100,'metadata.json')
        self.assertEqual(argv[:3],['docker','--host','unix:///var/run/docker.sock']);self.assertIn('source-prepared',argv);self.assertIn('--load',argv);self.assertNotIn('--push',argv)
        with self.assertRaises(ValueError):route.prepared_argv('owned','linux/amd64',identity,100,'metadata.json')
        with self.assertRaises(ValueError):route.prepared_argv('foreign/name','linux/arm64',identity,100,'metadata.json')
    def test_build_jobs_derive_from_the_declared_executor_cpu_count(self):
        # One internal authority: the lane's CPU allocation. Build parallelism must
        # equal it in BOTH the prepared build-arg and the runtime env, and the
        # resource bounds themselves must stay exactly 4 CPU / 4 GiB / PID 256.
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
        self.assertEqual(bindings.EXECUTOR_CPUS,4)
        self.assertEqual(bindings.EXECUTOR_BUILD_JOBS,bindings.EXECUTOR_CPUS)
        create,volumes=bindings.create_argv('sha256:'+'b'*64,identity,100,'none','c'*64)
        self.assertEqual(create[create.index('--cpus')+1],str(bindings.EXECUTOR_CPUS))
        self.assertEqual(create[create.index('--memory')+1],'4g')
        self.assertEqual(create[create.index('--pids-limit')+1],'256')
        env=[create[i+1] for i,value in enumerate(create) if value=='--env']
        jobs=[entry for entry in env if entry.startswith('XPOD_QLEVER_BUILD_JOBS=')]
        self.assertEqual(len(jobs),1)
        self.assertEqual(jobs[0],'XPOD_QLEVER_BUILD_JOBS='+str(bindings.EXECUTOR_CPUS))
        prepared=bindings.prepared_argv('owned','linux/arm64',identity,100,'metadata.json')
        args=[prepared[i+1] for i,value in enumerate(prepared) if value=='--build-arg']
        build_jobs=[entry for entry in args if entry.startswith('XPOD_QLEVER_BUILD_JOBS=')]
        self.assertEqual(len(build_jobs),1)
        self.assertEqual(build_jobs[0],jobs[0],'prepared and runtime job counts must agree')
    def test_job_count_is_pure_and_ignores_the_host_environment(self):
        # Verification replays create_argv() to rebuild the expected command, so the
        # result must not depend on whatever environment the later verifier runs in.
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
        baseline=bindings.create_argv('sha256:'+'b'*64,identity,100,'none','c'*64)
        baseline_prepared=bindings.prepared_argv('owned','linux/arm64',identity,100,'metadata.json')
        for value in ('1','2','8','0'):
            with mock.patch.dict(os.environ,{'XPOD_QLEVER_BUILD_JOBS':value}):
                again=bindings.create_argv('sha256:'+'b'*64,identity,100,'none','c'*64)
                again_prepared=bindings.prepared_argv('owned','linux/arm64',identity,100,'metadata.json')
            self.assertEqual(again,baseline,'host env must not change the replayed command')
            self.assertEqual(again_prepared,baseline_prepared,'host env must not change prepared argv')
    def test_two_way_parallelism_is_a_regression(self):
        # Guards the specific old override: prepared and runtime both hardcoded 2
        # while the container was allocated 4 CPUs.
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
        create,_volumes=bindings.create_argv('sha256:'+'b'*64,identity,100,'none','c'*64)
        prepared=bindings.prepared_argv('owned','linux/arm64',identity,100,'metadata.json')
        for argv in (create,prepared):
            for entry in argv:
                self.assertNotEqual(entry,'XPOD_QLEVER_BUILD_JOBS=2',
                                    'the two-job override must not come back')
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
        required={'sdk-readonly-normal-route','sdk-readonly-result-context','sdk-readonly-executor','sdk-readonly-executor-bindings','sdk-readonly-executor-entry','sdk-image-originals','sdk-command-materials','sdk-execution-budget','sdk-owned-runs','sdk-subreaper-guard','sdk-tar-budget','sdk-debian-binary-originals','sdk-debian-index-bindings','sdk-readonly-collection','qlever_compiler_profile','sdk-local-daemon-originals','sdk-service-profile-materials','sdk-kernel-probe-controller','sdk-kernel-policy-probe'}
        self.assertEqual({Path(p).stem for p in pins if p.startswith('qlever/scripts/')},required)
        for path,sha in pins.items():self.assertEqual(hashlib.sha256((HERE.parents[1]/path).read_bytes()).hexdigest(),sha)
        self.assertIn('  pull_request:',entry);self.assertIn('  workflow_call:',entry);self.assertIn('  workflow_call:',workflow)
        self.assertNotIn('packages: write',workflow);self.assertNotIn('secrets:',workflow);self.assertNotIn('environment:',workflow);self.assertNotIn('rc-',workflow)
        self.assertLess(workflow.index('name: Verify controller closure'),workflow.index('name: Capture immutable source context'))
        self.assertIn('ref: ${{ github.sha }}',workflow);self.assertIn('persist-credentials: false',workflow)
if __name__=='__main__':unittest.main()
