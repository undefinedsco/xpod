import importlib.util
import json
import sys
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
        """Two distinct shipped refusals, both before any external tool runs.

        Historical name kept (ROOT maps this ID): the private-phase contract has
        since moved on from "only a service profile could be rejected". What is
        asserted now is the CURRENT contract:

        (a) an invalid phase token is refused with exactly 64 and the fixed message,
            before any external tool;
        (b) a VALID private phase whose prepared identity is missing or mismatched is
            refused by the real identity validation, with its own explicit message --
            not by an arbitrary infrastructure traceback;
        (c) in every refusal no build output is produced and stdout stays empty.

        The component root is a bounded PRIVATE stub containing only the real
        profile module and lock file, so the real shell guard and the real identity
        JSON validation execute. Nothing under /components or product code is
        touched.
        """
        script=ROOT/'qlever/scripts/build-qlever-runtime-sdk.sh'
        subprocess.run(['bash','-n',str(script)],check=True,timeout=5)
        # (a) usage/phase-token refusal: exactly 64, fixed message.
        for args in [['not-a-mode'],['all','extra']]:
            result=subprocess.run(['bash',str(script),*args],capture_output=True,timeout=5,env={'PATH':'/usr/bin:/bin'})
            self.assertEqual(result.returncode,64)
            self.assertEqual(result.stderr.decode().strip(),'unsupported private SDK phase')
        declared=subprocess.run([sys.executable,str(ROOT/'qlever/scripts/qlever_compiler_profile.py'),'profile'],
                                capture_output=True,text=True,check=True).stdout.strip()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'component';(root/'qlever/scripts').mkdir(parents=True)
            (root/'qlever/scripts/qlever_compiler_profile.py').write_bytes(
                (ROOT/'qlever/scripts/qlever_compiler_profile.py').read_bytes())
            (root/'qlever/qlever.lock.json').write_bytes((ROOT/'qlever/qlever.lock.json').read_bytes())
            # (b) missing prepared identity: the real JSON validation refuses explicitly.
            for mode in ['prepare-only','build-prepared']:
                with self.subTest(mode=mode):
                    build=Path(directory)/('build-'+mode)
                    env={'PATH':'/usr/bin:/bin','XPOD_RDF_COMPONENT_ROOT':str(root),
                         'XPOD_QLEVER_BUILD_DIR':str(build),'XPOD_QLEVER_SOURCE_DIR':str(Path(directory)/'source')}
                    result=subprocess.run(['bash',str(script),mode],capture_output=True,timeout=10,env=env)
                    self.assertNotEqual(result.returncode,0)
                    self.assertIn('XPOD_QLEVER_SDK_IDENTITY',result.stderr.decode())
                    self.assertEqual(result.stdout,b'')
                    self.assertFalse(build.exists())
            # (c) mismatched prepared identity: the explicit profile-differs refusal.
            mismatch='module-bookworm-gcc12' if declared!='module-bookworm-gcc12' else 'service-trixie'
            for mode in ['prepare-only','build-prepared']:
                with self.subTest(mode=mode,identity='mismatch'):
                    build=Path(directory)/('mm-'+mode)
                    env={'PATH':'/usr/bin:/bin','XPOD_RDF_COMPONENT_ROOT':str(root),
                         'XPOD_QLEVER_BUILD_DIR':str(build),'XPOD_QLEVER_SOURCE_DIR':str(Path(directory)/'source'),
                         'XPOD_QLEVER_SDK_IDENTITY':json.dumps({'sdkProfile':mismatch})}
                    result=subprocess.run(['bash',str(script),mode],capture_output=True,timeout=10,env=env)
                    self.assertNotEqual(result.returncode,0)
                    self.assertIn('Prepared identity/compiler profile differs',result.stderr.decode())
                    self.assertEqual(result.stdout,b'')
                    self.assertFalse(build.exists())
if __name__=='__main__':unittest.main()
