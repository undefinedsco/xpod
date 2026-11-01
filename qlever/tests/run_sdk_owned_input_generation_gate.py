#!/usr/bin/env python3
"""Explicit native gate for sdk-owned-input-generation.py (not test_qlever*)."""
import importlib
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))

MODULE = 'qlever.tests.test_sdk_owned_input_generation'
EXPECTED = frozenset({
    'test_cross_phase', 'test_foreign_visible_write', 'test_foreign_held_lease',
    'test_peer_mapping', 'test_truncate', 'test_replay_mutations',
    'test_replay_truncate_mutations', 'test_ar', 'test_owned', 'test_idle_read_fd', 'test_mapped_then_unmapped_stays_immutable',
    'test_live_mapping', 'test_source', 'test_source_inode_protection_survives_phase_and_build_alias',
    'test_source_inode_through_build_hardlink_stays_immutable', 'test_replaced_fd', 'test_before',
})

def ids(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from ids(item)
        else:
            yield item.id().rsplit('.', 1)[-1]

def main():
    module = importlib.import_module(MODULE)
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    actual = list(ids(suite))
    print('SDK90 gate module=%s tests=%d cases=%s' % (MODULE, len(actual), ','.join(sorted(actual))), flush=True)
    if len(actual)!=len(EXPECTED) or len(set(actual))!=len(actual) or set(actual)!=EXPECTED:
        print('SDK90 gate case set differs: expected=%d actual=%d missing=%r extra=%r' % (len(EXPECTED),len(actual),sorted(EXPECTED-set(actual)),sorted(set(actual)-EXPECTED)), flush=True)
        return 1
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun != len(EXPECTED) or result.skipped or not result.wasSuccessful():
        print('SDK90 gate result differs: testsRun=%d expected=%d skipped=%r successful=%r' % (result.testsRun,len(EXPECTED),result.skipped,result.wasSuccessful()), flush=True)
        return 1
    print('SDK90 gate PASS tests=%d skipped=0' % result.testsRun, flush=True)
    return 0

if __name__ == '__main__':
    sys.exit(main())
