#!/usr/bin/env python3
"""REAL native CMake/Ninja archive-lifecycle regression.

WHY
    GNU `ar qc` + a separate `ranlib` rewrites the finished archive and breaks a
    read lease held on it; an indexed `ar qcs` create builds the index in the
    SAME write. CMake's FINISH default is `<CMAKE_RANLIB> <TARGET>`, so declaring
    only CREATE/APPEND still leaves a `ranlib` pass; the canonical declaration
    therefore sets FINISH explicitly empty.

WHAT THIS PROVES (real build only -- no declaration-mirroring cases)
    1. A real CMake+Ninja build produces C and C++ static archives from a
       >=256 KiB COMPILED C payload, and a real consumer links and prints 43.
    2. Each archive's index resolves ITS OWN members (C symbols in the C archive,
       C++ symbols in the C++ archive).
    3. The GENERATED Ninja build file is inspected so the actual archive
       lifecycle is reported as evidence rather than assumed.
    4. INCREMENTAL REBUILD: one function's return value changes, the project is
       rebuilt for real, and the consumer must print the NEW value while the
       member count stays stable. A stale index or dropped member fails here.
    5. APPEND on a real archive: the declared APPEND template is applied with a
       newly compiled object, the member count grows by one, and a consumer that
       CALLS the appended function must link and print 50. `nm` merely listing a
       symbol is not accepted as index proof.

KNOWN LIMIT (recorded, not tested as safe)
    Applying APPEND to an archive that is still held under a read lease fails
    (root: sdk79-final-native-gates/append-actual-observer.log). This test runs
    the append step OUTSIDE any observed phase on purpose: it verifies archive
    and index mechanics only and does NOT claim in-place append is lease-safe.

HOST
    Requires cmake, ninja and the declared compilers. On Linux a missing tool
    FAILS; only a non-Linux developer host skips, with an explicit reason.
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROFILE = ROOT / 'qlever/scripts/qlever_compiler_profile.py'
PAYLOAD_BYTES = 256 * 1024
LINUX = sys.platform.startswith('linux')


def load_profile():
    spec = importlib.util.spec_from_file_location('archive_profile', PROFILE)
    module = importlib.util.module_from_spec(spec)
    sys.modules['archive_profile'] = module
    spec.loader.exec_module(module)
    return module


CMAKE_LISTS = '''
cmake_minimum_required(VERSION 3.16)
project(archive_lifecycle C CXX)

add_library(clevel STATIC c_payload.c c_api.c)
add_library(clevelcxx STATIC cxx_api.cpp)

add_executable(consumer consumer.c)
target_link_libraries(consumer PRIVATE clevel clevelcxx)
'''

C_PAYLOAD = '''
const unsigned char payload[%d] = {1};
unsigned long payload_size(void) { return sizeof(payload); }
''' % PAYLOAD_BYTES

# c_two() is the function the incremental rebuild changes.
C_API = '''
extern const unsigned char payload[];
unsigned long payload_size(void);
int c_one(void) { return payload[0] == 1 ? 20 : -1; }
int c_two(void) { return %s; }
'''

CXX_API = '''
extern "C" int cxx_one(void) { return 1; }
extern "C" int cxx_two(void) { return 0; }
'''

CONSUMER = '''
#include <stdio.h>
int c_one(void);
int c_two(void);
int cxx_one(void);
int cxx_two(void);
int main(void) {
    int total = c_one() + c_two() + cxx_one() + cxx_two();
    printf("%d\\n", total);
    return 0;
}
'''

APPEND_SRC = '''
int appended_marker(void) { return 7; }
'''

# Calls the appended function: a stale index or missing member cannot resolve it.
APPEND_CONSUMER = '''
#include <stdio.h>
int c_one(void);
int c_two(void);
int cxx_one(void);
int cxx_two(void);
int appended_marker(void);
int main(void) {
    int total = c_one() + c_two() + cxx_one() + cxx_two() + appended_marker();
    printf("%d\\n", total);
    return 0;
}
'''


def _tool(name):
    return shutil.which(name)


@unittest.skipUnless(LINUX or (_tool('cmake') and _tool('ninja')),
                     'native CMake/Ninja build requires Linux or the tools')
class ArchiveLifecycle(unittest.TestCase):
    def setUp(self):
        for name in ('cmake', 'ninja'):
            if _tool(name) is None:
                message = '%s is required for the native archive gate' % name
                if LINUX:
                    self.fail(message)
                self.skipTest(message + ' (non-Linux host)')
        profile = load_profile()
        self.declared = profile.archive_command()
        # These generic ar rules run in the portable CI before SDK toolchain
        # installation. Exercise the host C/C++ pair explicitly; the actual
        # SDK image independently verifies its declared compiler identity.
        cc = os.environ.get('CC', 'cc')
        cxx = os.environ.get('CXX', 'c++')
        self.cc = _tool(cc)
        self.cxx = _tool(cxx)
        if self.cc is None or self.cxx is None:
            message = 'probe compilers unavailable: %s/%s' % (cc, cxx)
            if LINUX:
                self.fail(message)
            self.skipTest(message + ' (non-Linux host)')
        scratch = ROOT / '.test-data'
        scratch.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='archive-lifecycle-', dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.src = Path(self.tmp.name) / 'src'
        self.src.mkdir()
        self.build = Path(self.tmp.name) / 'build'
        self.build.mkdir()
        self._write_project()

    def _write_project(self, c_two_value='22'):
        (self.src / 'CMakeLists.txt').write_text(CMAKE_LISTS)
        (self.src / 'c_payload.c').write_text(C_PAYLOAD)
        (self.src / 'c_api.c').write_text(C_API % c_two_value)
        (self.src / 'cxx_api.cpp').write_text(CXX_API)
        (self.src / 'consumer.c').write_text(CONSUMER)

    def _run(self, cmd, timeout=600, expect=0):
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        self.assertEqual(done.returncode, expect,
                         'command %r exit %d (wanted %d)\n%s'
                         % (cmd, done.returncode, expect, done.stderr[-3000:]))
        return done

    def _configure(self):
        cmd = [
            'cmake', '-G', 'Ninja', '-S', str(self.src), '-B', str(self.build),
            '-DCMAKE_BUILD_TYPE=Release',
            '-DCMAKE_C_COMPILER=' + self.cc,
            '-DCMAKE_CXX_COMPILER=' + self.cxx,
        ]
        for lang in ('C', 'CXX'):
            for step, key in (('CREATE', 'create'), ('APPEND', 'append'),
                              ('FINISH', 'finish')):
                cmd.append('-DCMAKE_%s_ARCHIVE_%s=%s'
                           % (lang, step, self.declared[key]))
        self._run(cmd, timeout=300)

    def _build(self):
        return self._run(['cmake', '--build', str(self.build)])

    def _members(self, archive):
        done = self._run(['ar', 't', str(archive)], timeout=60)
        return [line for line in done.stdout.splitlines() if line.endswith('.o')]

    def _symbols(self, archive):
        nm = _tool('nm')
        if nm is None:
            return None
        return self._run([nm, str(archive)], timeout=60).stdout

    def test_archives_are_indexed_and_consumer_runs(self):
        self._configure()
        self._build()
        expectations = {
            'libclevel.a': (['c_one', 'c_two', 'payload_size'], 2),
            'libclevelcxx.a': (['cxx_one', 'cxx_two'], 1),
        }
        for name, (symbols_expected, member_count) in expectations.items():
            archive = self.build / name
            self.assertTrue(archive.is_file(), name + ' was not produced')
            if name == 'libclevel.a':
                self.assertGreater(archive.stat().st_size, PAYLOAD_BYTES,
                                   'C archive is smaller than the compiled payload')
            members = self._members(archive)
            self.assertEqual(len(members), member_count,
                             '%s member set differs: %r' % (name, members))
            symbols = self._symbols(archive)
            if symbols is None:
                continue
            for symbol in symbols_expected:
                self.assertTrue(('T ' + symbol) in symbols or ('T _' + symbol) in symbols,
                                '%s missing %s in:\n%s' % (name, symbol, symbols))
        done = self._run([str(self.build / 'consumer')], timeout=60)
        self.assertEqual(done.stdout.strip(), '43')

    def test_generated_ninja_shows_the_actual_archive_lifecycle(self):
        """Evidence, not assumption: read the real generated build file."""
        self._configure()
        build_ninja = self.build / 'build.ninja'
        self.assertTrue(build_ninja.is_file(), 'Ninja did not generate build.ninja')
        # CMake writes the actual commands in CMakeFiles/rules.ninja; the
        # top-level file only references those rules.
        text = '\n'.join(path.read_text() for path in sorted(self.build.rglob('*.ninja')))
        self.assertIn('qcs', text,
                      'no indexed archive command appears in the generated Ninja file')
        self.assertNotIn('ranlib', text,
                         'generated Ninja build still contains a ranlib step')

    def test_incremental_rebuild_updates_value_keeping_member_count(self):
        self._configure()
        self._build()
        archive = self.build / 'libclevel.a'
        before_members = self._members(archive)
        done = self._run([str(self.build / 'consumer')], timeout=60)
        self.assertEqual(done.stdout.strip(), '43')

        # Change ONE function's return value and rebuild for real.
        self._write_project(c_two_value='32')
        self._build()
        after_members = self._members(archive)
        self.assertEqual(len(after_members), len(before_members),
                         'member count changed across an incremental rebuild: %r -> %r'
                         % (before_members, after_members))
        done = self._run([str(self.build / 'consumer')], timeout=60)
        self.assertEqual(done.stdout.strip(), '53',
                         'incremental rebuild did not refresh the archived member')

    def test_declared_append_extends_a_real_archive_and_links(self):
        """Mechanics only: run OUTSIDE any observed phase, not a lease-safety claim."""
        self._configure()
        self._build()
        archive = self.build / 'libclevel.a'
        before = self._members(archive)
        new_src = self.src / 'append_extra.c'
        new_src.write_text(APPEND_SRC)
        new_obj = self.build / 'append_extra.o'
        self._run([self.cc, '-O2', '-c', str(new_src), '-o', str(new_obj)], timeout=120)
        cmd = (self.declared['append']
               .replace('<CMAKE_AR>', 'ar')
               .replace('<TARGET>', str(archive))
               .replace('<LINK_FLAGS>', '')
               .replace('<OBJECTS>', str(new_obj)))
        self._run(cmd.split(), timeout=120)
        after = self._members(archive)
        self.assertEqual(len(after), len(before) + 1,
                         'append did not add exactly one member: %r -> %r' % (before, after))
        # The consumer CALLS appended_marker and must total 50: a stale index
        # cannot resolve it and a wrong value fails the assertion.
        append_consumer = self.src / 'append_consumer.c'
        append_consumer.write_text(APPEND_CONSUMER)
        binary = self.build / 'append_consumer'
        self._run([self.cc, '-O2', str(append_consumer), str(archive),
                   str(self.build / 'libclevelcxx.a'), '-o', str(binary)], timeout=120)
        done = self._run([str(binary)], timeout=60)
        self.assertEqual(done.stdout.strip(), '50',
                         'consumer calling the appended member produced %r'
                         % done.stdout.strip())


if __name__ == '__main__':
    unittest.main(verbosity=2)
