import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('sdk_reference',ROOT/'qlever/scripts/produce-linux-runtime-archive.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class SdkArtifactReferenceTest(unittest.TestCase):
    def test_reference_is_exact_and_not_an_admission_assertion(self):
        env=dict(SDK_ORIGINAL_ARTIFACT_ID='17',SDK_ORIGINAL_ARTIFACT_DIGEST='sha256:'+'a'*64,
                 SDK_ORIGINAL_MASTER_SHA256='b'*64,SDK_ORIGINAL_MASTER_BYTES='123',GITHUB_RUN_ID='42',GITHUB_RUN_ATTEMPT='2')
        result=module.sdk_artifact_tuple(env,'linux-arm64','c'*40,'ghcr.io/example/sdk@sha256:'+'d'*64)
        self.assertEqual(result['master'],dict(path='materials.json',bytes=123,sha256='b'*64))
        self.assertEqual(result['artifactId'],17);self.assertEqual(result['runId'],42)
        self.assertNotIn('verified',result)
        self.assertIsNone(module.sdk_artifact_tuple({},'linux-x64','c'*40,'image'))
        for updates in [dict(SDK_ORIGINAL_MASTER_BYTES=''),dict(SDK_ORIGINAL_ARTIFACT_ID='0'),dict(SDK_ORIGINAL_MASTER_SHA256='bad')]:
            with self.assertRaises(RuntimeError):module.sdk_artifact_tuple(dict(env,**updates),'linux-arm64','c'*40,'image')
if __name__=='__main__':unittest.main()
