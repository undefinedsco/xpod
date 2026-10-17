import importlib.util
from pathlib import Path
import tempfile
import unittest
import subprocess

ROOT=Path(__file__).resolve().parents[2]
SCRIPT=ROOT/'qlever/scripts/sdk-prepared-inputs.py'
spec=importlib.util.spec_from_file_location('sdk_boundary',SCRIPT)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SdkPreparedInputsTest(unittest.TestCase):
    def prepare(self,root):
        source=root/'component';build=root/'build';source.mkdir();build.mkdir()
        (source/'qlever.lock.json').write_text('{"commit":"actual test fixture"}')
        for name in ['CMakeCache.txt','compile_commands.json','CMakeFiles/qlever-server.dir/link.txt','.xpod-source-manifest.pending']:
            path=build/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('actual prepared '+name)
        return source,build
    def test_real_before_bytes_and_changed_compiler_configuration_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            source,build=self.prepare(Path(directory))
            original=module.boundary('record',source,build,'engine:patch','toolchain')
            self.assertEqual(module.boundary('verify',source,build,'engine:patch','toolchain'),original)
            (build/'CMakeCache.txt').write_text('changed compiler')
            with self.assertRaisesRegex(ValueError,'boundary changed'):module.boundary('verify',source,build,'engine:patch','toolchain')
    def test_identity_swap_missing_marker_and_links_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            source,build=self.prepare(Path(directory))
            with self.assertRaises(FileNotFoundError):module.boundary('verify',source,build,'engine','toolchain')
            module.boundary('record',source,build,'engine','toolchain')
            with self.assertRaises(ValueError):module.boundary('verify',source,build,'another-engine','toolchain')
            (build/'CMakeCache.txt').unlink();(build/'CMakeCache.txt').symlink_to(source/'qlever.lock.json')
            with self.assertRaisesRegex(ValueError,'regular'):module.boundary('verify',source,build,'engine','toolchain')
    def test_shell_is_valid_and_private_phases_reject_service_before_external_calls(self):
        script=ROOT/'qlever/scripts/build-qlever-runtime-sdk.sh'
        subprocess.run(['bash','-n',str(script)],check=True,timeout=5)
        for args in [['not-a-mode'],['prepare-only'],['build-prepared']]:
            result=subprocess.run(['bash',str(script),*args],capture_output=True,timeout=5,env={'PATH':'/usr/bin:/bin'})
            self.assertEqual(result.returncode,64)
if __name__=='__main__':unittest.main()
