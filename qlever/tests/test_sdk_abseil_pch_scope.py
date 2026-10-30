"""Semantic CMake regression for the scoped abseil PCH recipe (UNIT LEVEL).

This is a CONTROL-FLOW unit test, not real-abseil codegen proof. It mounts a tiny
fake abseil stand-in that reproduces the one property the recipe depends on
(AbseilHelpers naming: `synchronization` when ABSL_ENABLE_INSTALL is ON, plus the
always-present `absl::<name>` ALIAS), then executes the REAL recipe block taken
verbatim from qlever/patches/qlever-antlr-scoped-pch-and-server-pch-reuse.patch.

The block is extracted from the shipped patch at test time, so this cannot drift
from a string mirror. Real 25-TU codegen equality is covered separately by the
retained ON/OFF object manifests; that evidence is NOT produced here.

Requires cmake on PATH. If cmake is missing the cases are reported as skips with
an explicit count, never as silent passes.
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATCH = ROOT / 'qlever/patches/qlever-antlr-scoped-pch-and-server-pch-reuse.patch'
S2_PATCH = ROOT / 'qlever/patches/qlever-s2-scoped-precompiled-headers.patch'
FIXTURE = Path(__file__).resolve().parent / 'fixtures/sdk-abseil-pch-scope'
CMAKE = shutil.which('cmake')
NINJA = shutil.which('ninja')
# An image may expose only a versioned C++ driver (e.g. clang++-19 with no
# clang++ symlink), so resolve one explicitly instead of relying on CMake's PATH
# probe. CXX_OVERRIDE lets the ROOT runner pin the exact driver under test.
CXX = os.environ.get('CXX_OVERRIDE') or next(
    (c for c in ('clang++-19', 'g++-12', 'c++', 'g++') if shutil.which(c)), None)


def extract_predicate():
    """Return the shared compiler-predicate lines from the S2 patch (added only).

    The predicate is DEFINED in the S2 patch and only referenced by the abseil
    block, so a fixture that runs the abseil recipe alone must supply it the same
    way the real tree does: one unconditional derivation.
    """
    lines = S2_PATCH.read_text().splitlines()
    start = next(i for i, l in enumerate(lines)
                 if l.startswith('+') and 'Shared compiler predicate' in l)
    out = []
    depth = 0
    opened = False
    for line in lines[start:]:
        if not line.startswith('+'):
            break
        body = line[1:]
        out.append(body)
        stripped = body.strip()
        if stripped.startswith('if ('):
            depth += 1
            opened = True
        elif stripped == 'endif ()':
            depth -= 1
            if opened and depth == 0:
                break
    assert out, 'predicate block not found'
    return '\n'.join(out) + '\n'


def extract_block():
    """Return the real recipe block text (added lines only) from the shipped patch."""
    text = PATCH.read_text()
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines)
                 if l.startswith('+') and 'Scoped precompiled headers for two abseil targets' in l)
    out = []
    depth = 0
    opened = False
    for line in lines[start:]:
        if not line.startswith('+'):
            break
        body = line[1:]
        out.append(body)
        stripped = body.strip()
        if stripped.startswith('if ('):
            depth += 1
            opened = True
        elif stripped == 'endif ()':
            depth -= 1
            if opened and depth == 0:
                break
    assert out and out[-1].strip() == 'endif ()', 'recipe block not closed'
    return '\n'.join(out) + '\n'


def materialize(destination):
    """Lay out the fixture and write the extracted recipe block next to it."""
    dest = Path(destination)
    shutil.copytree(FIXTURE, dest / 'f')
    (dest / 'f' / 'recipe-block.cmake').write_text(extract_predicate() + extract_block())
    return dest / 'f'


def configure(build_dir, source_dir, extra=None):
    argv = [CMAKE, '-S', str(source_dir), '-B', str(build_dir),
            '-DCMAKE_BUILD_TYPE=Release']
    if CXX:
        argv.append('-DCMAKE_CXX_COMPILER=' + CXX)
    if NINJA:
        argv += ['-G', 'Ninja']
    argv += (extra or [])
    return subprocess.run(argv, capture_output=True, text=True)


def query(build_dir, expression):
    """Evaluate one CMake expression in the generated build directory."""
    script = build_dir / 'probe.cmake'
    script.write_text(expression)
    return subprocess.run([CMAKE, '-P', str(script)], capture_output=True, text=True)


@unittest.skipUnless(CMAKE, 'cmake not on PATH')
class AbseilPchScopeTests(unittest.TestCase):
    """Control-flow semantics of the shipped recipe block (unit level)."""

    def test_install_on_and_off_resolve_the_real_target_through_the_alias(self):
        for install_on, expected in (('ON', 'synchronization'), ('OFF', 'absl_synchronization')):
            with self.subTest(install=install_on), tempfile.TemporaryDirectory() as td:
                src = materialize(td)
                build = Path(td) / 'b'
                done = configure(build, src, ['-DABSL_ENABLE_INSTALL=' + install_on])
                self.assertEqual(done.returncode, 0, done.stderr[-2000:])
                # The recipe reports the resolved real target; assert it is the
                # install-dependent name, proving the alias path was taken.
                self.assertIn('absl::synchronization -> ' + expected, done.stdout)

    def test_supported_compiler_activates_pch_and_global_switch_disables_it(self):
        with tempfile.TemporaryDirectory() as td:
            src = materialize(td)
            on = configure(Path(td) / 'on', src)
            self.assertEqual(on.returncode, 0, on.stderr[-2000:])
            self.assertIn('Xpod abseil scoped PCH', on.stdout)
            off = configure(Path(td) / 'off', src, ['-DUSE_PRECOMPILED_HEADERS=OFF'])
            self.assertEqual(off.returncode, 0, off.stderr[-2000:])
            self.assertNotIn('Xpod abseil scoped PCH', off.stdout)

    def test_unsupported_compiler_predefined_on_stays_inactive(self):
        # The predicate is derived unconditionally, so a caller-provided
        # XPOD_SCOPED_PCH_COMPILER cannot admit an unsupported compiler. Simulate an
        # unsupported ID/version in a child fixture that overrides them before the
        # recipe is included.
        with tempfile.TemporaryDirectory() as td:
            src = materialize(td)
            probe = src / 'CMakeLists.txt'
            probe.write_text(probe.read_text().replace(
                'include("${CMAKE_CURRENT_SOURCE_DIR}/recipe-block.cmake")',
                'set(CMAKE_CXX_COMPILER_ID "Unsupported")\n'
                'set(CMAKE_CXX_COMPILER_VERSION "1.0")\n'
                'set(XPOD_SCOPED_PCH_COMPILER ON)\n'
                'include("${CMAKE_CURRENT_SOURCE_DIR}/recipe-block.cmake")\n'
                'message(STATUS "PREDICATE=${XPOD_SCOPED_PCH_COMPILER}")'))
            done = configure(Path(td) / 'b', src)
            self.assertEqual(done.returncode, 0, done.stderr[-2000:])
            self.assertIn('PREDICATE=OFF', done.stdout)
            self.assertNotIn('Xpod abseil scoped PCH', done.stdout)

    def test_source_counts_generation_actions_and_win32_exclusion(self):
        with tempfile.TemporaryDirectory() as td:
            src = materialize(td)
            build = Path(td) / 'b'
            done = configure(build, src, ['-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'])
            self.assertEqual(done.returncode, 0, done.stderr[-2000:])
            import json
            db = json.loads((build / 'compile_commands.json').read_text())
            for target, expected_sources, expected_skip in (
                    ('synchronization', 12, 'win32_waiter.cc'),
                    ('strings', 14, None)):
                entries = [e for e in db if 'CMakeFiles/%s.dir' % target in e['command']]
                generated = [e for e in entries if e['file'].endswith('cmake_pch.hxx.cxx')]
                sources = [e for e in entries if not e['file'].endswith('cmake_pch.hxx.cxx')]
                consuming = [e for e in sources if '-include' in e['command']]
                free = [e for e in sources if '-include' not in e['command']]
                self.assertEqual(len(generated), 1, target + ' generation action')
                self.assertEqual(len(sources), expected_sources, target + ' sources')
                if expected_skip:
                    self.assertEqual([Path(e['file']).name for e in free], [expected_skip])
                    self.assertEqual(len(consuming), expected_sources - 1)
                else:
                    self.assertEqual(free, [])


if __name__ == '__main__':
    unittest.main()
