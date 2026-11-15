#!/usr/bin/env python3
"""Run the native lease contract gate. Exits non-zero on any failure.

This is the CI entry point. It deliberately does NOT rely on `unittest discover`
patterns, and it treats "no tests ran" as a FAILURE rather than a pass.

Usage:
    python3 qlever/tests/run_native_lease_gate.py [-v]
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

MODULES = ('test_native_lease_contract', 'test_native_lease_backend',
           'test_native_lease_eintr')


def main(argv):
    verbosity = 2 if '-v' in argv else 1
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    loaded = 0
    begun = 0
    for name in MODULES:
        try:
            module = __import__(name)
        except Exception as error:            # a broken bootstrap is a FAILURE
            sys.stderr.write('GATE FAILED to import %s: %s\n' % (name, error))
            return 2
        tests = loader.loadTestsFromModule(module)
        count = tests.countTestCases()
        if count == 0:
            sys.stderr.write('GATE FAILED: %s loaded 0 tests\n' % name)
            return 2
        loaded += count
        begun += module.setUpModule is not None
        suite.addTests(tests)
    if loaded == 0:
        sys.stderr.write('GATE FAILED: no tests loaded\n')
        return 2
    sys.stderr.write('native lease gate: %d tests across %d modules\n' % (loaded, len(MODULES)))
    result = unittest.TextTestRunner(verbosity=verbosity, stream=sys.stderr).run(suite)
    if not result.testsRun:
        sys.stderr.write('GATE FAILED: no tests actually ran\n')
        return 2
    if result.errors or result.failures:
        return 1
    if result.testsRun != loaded:
        sys.stderr.write('GATE FAILED: ran %d of %d loaded tests\n'
                         % (result.testsRun, loaded))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
