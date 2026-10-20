"""Service ABI and prepared/materials stage contract; no container execution."""
from pathlib import Path
import re
import unittest
ROOT = Path(__file__).resolve().parents[2]

class ServicePreparedContract(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT/'docker/qlever-runtime-sdk/Dockerfile').read_text()
    def test_original_service_abi_is_explicit(self):
        self.assertIn('debian:trixie-20260803-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258', self.text)
        for token in ['XPOD_QLEVER_CMAKE_C_COMPILER=clang-19', 'XPOD_QLEVER_CMAKE_CXX_COMPILER=clang++-19', '    clang-19 \\', '    lld-19 \\']:
            self.assertIn(token, self.text)
        for token in ['bookworm', 'gcc-12', 'g++-12', 'backports']:
            self.assertNotIn(token, self.text)
        for package in ['libboost-container-dev','libboost-iostreams-dev','libboost-program-options-dev','libboost-url-dev','libbz2-dev','libicu-dev','liblzma-dev','libssl-dev','libzstd-dev','zlib1g-dev']:
            self.assertRegex(self.text, r'(?m)^    '+re.escape(package)+r'(?: \\)?$')
    def test_each_phase_uses_the_existing_owned_run_entry(self):
        self.assertEqual(re.findall(r'^FROM .* AS (\S+)$', self.text, re.M), ['source-prepared','build','linked-verification','runtime'])
        for phase in ['sourcePrepare','build','linked']:
            self.assertEqual(self.text.count('exec python3 /components/qlever/scripts/sdk-owned-runs.py '+phase+'\n'),1)
        prepare=self.text.split('FROM source-prepared AS build')[0]
        self.assertIn('Types: deb deb-src',prepare)
        self.assertNotIn('rm -rf /var/lib/apt/lists',prepare)
        self.assertIn('AllowUnauthenticated=false',prepare)
        build=self.text.split('FROM source-prepared AS build')[1].split('FROM build AS linked-verification')[0]
        for path in ['/opt/qlever-sdk/source','/opt/qlever-sdk/dependencies','/components','/usr','/etc/alternatives','/etc/ld.so.cache','/etc/ld.so.conf','/etc/ld.so.conf.d','/var/lib/dpkg']:
            self.assertIn('source='+path+',target='+path+',ro',build)
    def test_originals_and_real_linked_evidence_are_retained(self):
        for source in ['.dockerignore','scripts/lib/module-artifact-limits.json','scripts/agentfs-native-ci/supervise.py','qlever/scripts','docker/qlever-runtime-sdk/Dockerfile','docker/qlever-local-runtime/Dockerfile']:
            self.assertRegex(self.text,r'(?m)^COPY '+re.escape(source)+r' ')
            self.assertTrue((ROOT/source).exists(),source)
        runtime=self.text.split('FROM build AS runtime')[1]
        for role in ['linked-inner.json','owner-linked.guard.json','test-adapter.raw.log','test-adapter.receipt.json','test-runtime.raw.log','test-runtime.receipt.json']:
            self.assertIn(role,runtime)
        self.assertNotIn('/tmp/xpod-qlever-linked-verification.ok',runtime)
        self.assertNotIn('apt-get',runtime)
        self.assertIn('! command -v node',runtime)
        self.assertIn('test ! -e /components/qlever/qlever_pg_extension',runtime)
        self.assertIn('test ! -e /components/pg-rdf-extension',runtime)

if __name__ == '__main__':
    unittest.main()
