"""Strict case-count guard for the scoped-PCH recipe suite.

`python -m unittest` exits 0 when every test was skipped, so a CLI exit code is
not sufficient evidence that the recipe was actually exercised. This guard runs
the real suite through the unittest API and fails unless the arm produced exactly
the reviewed number of cases with zero skips and no failure/error.

Invoked once per compiler so the module-level `CXX` constant is captured fresh
from `CXX_OVERRIDE` in its own interpreter.
"""
import sys
import unittest

EXPECTED_CASES = 4
SUITE = 'qlever.tests.test_sdk_abseil_pch_scope'


def main(argv):
    if len(argv) != 2:
        print('usage: pch_scope_case_guard.py <compiler-label>')
        return 2
    label = argv[1]
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromName(SUITE))
    print('%s: testsRun=%d skipped=%d failures=%d errors=%d'
          % (label, result.testsRun, len(result.skipped),
             len(result.failures), len(result.errors)))
    problems = []
    if result.testsRun != EXPECTED_CASES:
        problems.append('testsRun=%d expected %d' % (result.testsRun, EXPECTED_CASES))
    if result.skipped:
        problems.append('skipped=%d expected 0' % len(result.skipped))
    if not result.wasSuccessful():
        problems.append('wasSuccessful() is False')
    for problem in problems:
        print('::error::scoped-PCH %s: %s' % (label, problem))
    return 0 if not problems else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
