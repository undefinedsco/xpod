import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'qlever/scripts/qlever_compiler_profile.py'
spec = importlib.util.spec_from_file_location('compiler_profile', HELPER)
profile = importlib.util.module_from_spec(spec); spec.loader.exec_module(profile)


class ModuleBookwormSdkTests(unittest.TestCase):
    def test_default_service_compiler_contract_serialization_is_unchanged(self):
        versions = {'clang-19': 'clang version 19', 'clang++-19': 'clang version 19', 'cmake': 'cmake version 3'}
        with patch.dict(os.environ, {}, clear=True), patch.object(profile.subprocess, 'check_output', side_effect=lambda command, **_: versions[command[0]]):
            expected = dict(clang='clang version 19', clangxx='clang version 19', cmake='cmake version 3')
            self.assertEqual(json.dumps(profile.compiler_versions(), sort_keys=True), json.dumps(expected, sort_keys=True))
            self.assertEqual(profile.compiler_spec()['linker'], 'lld')

    def test_module_compiler_and_linker_identity_are_real_distinct_roles(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'compiler'; executable.write_bytes(b'unit compiler bytes')
            env = dict(XPOD_QLEVER_CMAKE_C_COMPILER='gcc-12', XPOD_QLEVER_CMAKE_CXX_COMPILER='g++-12')
            with patch.dict(os.environ, env, clear=True), patch.object(profile.subprocess, 'check_output', side_effect=lambda command, **_: command[0] + ' version'), \
                    patch.object(profile.shutil, 'which', return_value=str(executable)), patch.object(profile.Path, 'read_text', return_value=json.dumps({'profile': 'module-bookworm-gcc12'})):
                identity = profile.compiler_versions()
                self.assertEqual(identity['gcc'], 'gcc-12 version'); self.assertEqual(identity['gxx'], 'g++-12 version')
                self.assertEqual(identity['linkerVersion'], 'ld.bfd version'); self.assertEqual(identity['profile'], 'module-bookworm-gcc12')
                self.assertNotIn('clang', identity); self.assertNotIn('clangxx', identity)
                self.assertEqual(len(identity['compilerFiles']['c']), 64)

    def test_mixed_or_unknown_compiler_pair_never_falls_back(self):
        for pair in [('gcc-12', 'clang++-19'), ('gcc', 'g++')]:
            with patch.dict(os.environ, dict(XPOD_QLEVER_CMAKE_C_COMPILER=pair[0], XPOD_QLEVER_CMAKE_CXX_COMPILER=pair[1]), clear=True):
                with self.assertRaisesRegex(RuntimeError, 'no fallback'): profile.compiler_spec()

    def test_profiles_have_separate_recipe_identity_and_registry_namespace(self):
        service = profile.sdk_profile('service-trixie'); module = profile.sdk_profile('module-bookworm-gcc12')
        self.assertEqual(service['repository_suffix'], ''); self.assertEqual(module['repository_suffix'], '-module-bookworm')
        self.assertNotEqual(service['identity'], module['identity']); self.assertNotEqual(service['dockerfile'], module['dockerfile'])
        with self.assertRaises(RuntimeError): profile.sdk_profile('caller-approved-profile')

    def test_module_recipe_requires_authenticated_bookworm_full_feature_inputs(self):
        dockerfile = (ROOT / 'docker/qlever-runtime-sdk/Dockerfile.module-bookworm').read_text()
        wrapper = (ROOT / 'qlever/scripts/build-module-runtime-sdk.sh').read_text()
        self.assertIn('debian:bookworm-slim@sha256:', dockerfile)
        for package in ['gcc-12', 'g++-12', 'libboost-url1.81-dev', 'libicu-dev', 'libssl-dev']:
            self.assertIn(package, dockerfile)
        self.assertIn('Acquire::AllowInsecureRepositories=false', dockerfile); self.assertIn('APT::Get::AllowUnauthenticated=false', dockerfile)
        self.assertIn("['gpgv', '--keyring'", wrapper); self.assertIn('packageIndexHashes', wrapper); self.assertIn('recipeHashes', wrapper)
        self.assertNotIn('REDUCED_FEATURE_SET_FOR_CPP17', dockerfile + wrapper)
        self.assertNotIn('clang-19', dockerfile)
        subprocess.run(['bash', '-n', str(ROOT / 'qlever/scripts/build-module-runtime-sdk.sh')], check=True)

    def test_module_wrapper_refuses_default_clang_before_any_build(self):
        result = subprocess.run(['bash', str(ROOT / 'qlever/scripts/build-module-runtime-sdk.sh')], env={'PATH': os.environ['PATH']}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 64); self.assertIn('no fallback', result.stderr)


if __name__ == '__main__':
    unittest.main()
