"""Discovered CI bridge for every reviewed regression module.

The standing CI gate discovers only `test_qlever*.py`. Reviewed regression
modules live outside that pattern, and two of them are already *partly* re-exported
by existing bridge modules. Loading them naively would either miss the unreached
part (if only a class is copied) or execute the reached part twice (if the whole
module is copied).

This bridge therefore works in three steps, entirely through the standard loader:

1. load **all** reviewed modules whole;
2. load the two existing bridge modules and collect the test IDs they already
   export — derived from the loader, never enumerated by hand;
3. flatten everything, drop any ID that is already covered by an existing bridge or
   already seen within this load, and keep every remaining test.

Consequences:
  * a class added later to *any* reviewed module, including the two partly-covered
    ones, is picked up automatically with no edit here;
  * nothing executes twice under `test_qlever*` discovery;
  * `discover` is never called, so the bridge cannot recurse into itself.

`ExitedHistoryIteration` is the single class-specific entry, because it is the
changed metadata class originally requested out of a module that is deliberately not
swept in wholesale.

`test_sdk_abseil_pch_scope` is intentionally absent: it runs the shipped CMake recipe
against whichever compiler CMake selects, so admitting it to broad discovery would
pin the image default compiler. It stays behind the dedicated dual-compiler CI step,
which asserts exactly 4 tests / 0 skips per driver.
"""
import unittest

REVIEWED_MODULES = (
    'qlever.tests.test_sdk_generated_mmap_custody_credit',
    'qlever.tests.test_sdk_generated_source_originals',
    'qlever.tests.test_sdk_generation_multiprocess_bindings',
    'qlever.tests.test_sdk_indexed_tool_coverage',
    'qlever.tests.test_sdk_toolchain_operation_coverage',
    'qlever.tests.test_sdk_toolchain_fd_originals',
    # SERVICE additions from the Q9 + transport assembly. The owned-writer
    # custody module is deliberately NOT listed: it is a MODULE-candidate file
    # and is not part of the service surface.
    'qlever.tests.test_sdk_generated_source_input_universe',
    'qlever.tests.test_sdk_generated_producer_transport',
    'qlever.tests.test_sdk_generated_source_emit_projection',
    # Exercise the actual read-family routing and retained source/consumer roles.
    'qlever.tests.test_sdk_ptrace_execution_library',
)

# Existing standing-CI bridges. Their exported IDs are derived by the loader; they
# are never parsed or listed here.
EXISTING_BRIDGES = (
    'qlever.tests.test_qlever_sdk86_contract',
    'qlever.tests.test_qlever_retained_metadata_contract',
)

# The one class-specific entry: the changed metadata class originally requested.
SINGLE_CLASS = 'qlever.tests.test_sdk86_metadata_operands.ExitedHistoryIteration'

from qlever.tests.test_sdk86_metadata_operands import ExitedHistoryIteration  # noqa: F401


def _iter_cases(suite):
    """Depth-first flatten of a suite tree into individual test cases."""
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _iter_cases(item)
        else:
            yield item


def _bridge_ids(loader, module):
    """Test IDs an existing standing-CI bridge already exports.

    Those bridges import helper modules as top-level names (`import
    test_sdk_bti_predicate`), which only resolves because `discover` puts
    `qlever/tests` on `sys.path`. We therefore import them the same way discovery
    does, and derive IDs purely from the loader. Any import or attribute failure is
    surfaced rather than silently treated as "nothing covered", which would make
    this bridge re-run tests that CI already executes.
    """
    error_count = len(loader.errors)
    suite = loader.loadTestsFromName(module)
    if len(loader.errors) != error_count:
        raise ImportError('Cannot load existing standing-CI bridge: ' + module)
    return {case.id() for case in _iter_cases(suite)}


def load_tests(loader, standard_tests, pattern):
    """Load all reviewed modules, then keep only tests standing CI misses."""
    covered = set()
    for module in EXISTING_BRIDGES:
        covered |= _bridge_ids(loader, module)

    selected = unittest.TestSuite()
    seen = set()

    def add_unseen(case):
        ident = case.id()
        if ident in covered or ident in seen:
            return
        seen.add(ident)
        selected.addTest(case)

    for module in REVIEWED_MODULES:
        for case in _iter_cases(loader.loadTestsFromName(module)):
            add_unseen(case)

    for case in _iter_cases(loader.loadTestsFromName(SINGLE_CLASS)):
        add_unseen(case)

    return selected
