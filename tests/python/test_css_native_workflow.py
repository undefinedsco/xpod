import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('css_workflow',ROOT/'scripts/css-module-producer.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ControlledNativeWorkflowTest(unittest.TestCase):
    def test_exact_target_job_paths_and_artifacts_for_all_targets(self):
        for target in ['darwin-arm64','darwin-x64','linux-arm64','linux-x64']:
            with self.subTest(target=target):
                identity=dict(runId=42,runAttempt=2,actualCheckoutSha='a'*40,runHeadSha='a'*40,target=target,workflowPath=module.TARGETS_WORKFLOW)
                env=dict(CSS_NATIVE_ARTIFACT_ID='7',CSS_NATIVE_ARTIFACT_DIGEST='c'*64,CSS_NATIVE_RUN_ID='42',CSS_NATIVE_RUN_ATTEMPT='2',CSS_NATIVE_SOURCE_SHA='a'*40)
                linux=target.startswith('linux-')
                name='qlever-local-runtime-'+target+'-'+'a'*40+('-42-2' if linux else '')
                job_name='targets ('+target+') / native / '+('linux / module_runtime_materials / archive' if linux else 'macos / build')
                artifact=dict(id=7,expired=False,name=name,workflow_run=dict(id=42,head_sha='a'*40),digest='sha256:'+'c'*64,size_in_bytes=10,
                              created_at='2026-10-15T01:01:00Z',updated_at='2026-10-15T01:01:01Z')
                job=dict(id=8,name=job_name,run_id=42,run_attempt=2,head_sha='a'*40,status='completed',conclusion='success',
                         started_at='2026-10-15T01:00:00Z',completed_at='2026-10-15T01:02:00Z')
                self.assertEqual(module.validate_native_metadata(identity,env,artifact,dict(total_count=1,jobs=[job])),('c'*64,8))
                for changes in [dict(name='native / build'),dict(run_attempt=1),dict(head_sha='b'*40),dict(conclusion='failure')]:
                    with self.assertRaises(ValueError):module.validate_native_metadata(identity,env,artifact,dict(total_count=1,jobs=[dict(job,**changes)]))
    def test_controlled_entry_requires_exact_manual_workflow_source(self):
        with tempfile.TemporaryDirectory() as directory:
            event=Path(directory)/'event.json';event.write_text('{}')
            env=dict(GITHUB_REPOSITORY=module.REPOSITORY,GITHUB_SHA='a'*40,GITHUB_EVENT_NAME='workflow_dispatch',GITHUB_EVENT_PATH=str(event),
                     GITHUB_RUN_ID='42',GITHUB_RUN_ATTEMPT='2',GITHUB_WORKFLOW_REF=module.REPOSITORY+'/'+module.TARGETS_WORKFLOW+'@refs/heads/staging',GITHUB_WORKFLOW_SHA='a'*40)
            self.assertEqual(module.context(env,dict(sha='a'*40,status=''))['workflowPath'],module.TARGETS_WORKFLOW)
            for changes in [dict(GITHUB_WORKFLOW_REF=module.REPOSITORY+'/.github/workflows/foreign.yml@refs/heads/staging'),dict(GITHUB_WORKFLOW_SHA='invalid')]:
                with self.assertRaises(ValueError):module.context(dict(env,**changes),dict(sha='a'*40,status=''))
if __name__=='__main__':unittest.main()
