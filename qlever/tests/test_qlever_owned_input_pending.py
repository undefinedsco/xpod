"""Stale owned-input triggers must fail closed, never bind or silently skip."""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    'owned_input_generation', HERE.parent / 'scripts' / 'sdk-owned-input-generation.py')
OWNED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNED)


class _Owner:
    def __init__(self):
        self.exclusive = None
        self.tasks = {123: dict(exited=False, entry=None)}
        self.maximum_file_bytes = 1 << 20


class StalePendingTest(unittest.TestCase):
    def test_open_trigger_without_live_entry_fails_closed(self):
        owner = _Owner()
        owner.tasks[123]['generationOpenPending'] = 41
        runtime = OWNED.Runtime(owner, None)
        with self.assertRaisesRegex(ValueError, 'lacks exact live syscall entry'):
            runtime.pending()
        self.assertNotIn('generationOpenPending', owner.tasks[123])

    def test_truncate_trigger_without_live_entry_fails_closed(self):
        owner = _Owner()
        owner.tasks[123]['generationTruncatePending'] = 42
        runtime = OWNED.Runtime(owner, None)
        with self.assertRaisesRegex(ValueError, 'lacks exact live syscall entry'):
            runtime.pending()
        self.assertNotIn('generationTruncatePending', owner.tasks[123])

    def test_trigger_for_a_different_entry_is_not_replayed(self):
        owner = _Owner()
        owner.tasks[123].update(generationOpenPending=41, entry={'sequence': 99})
        runtime = OWNED.Runtime(owner, None)
        with self.assertRaisesRegex(ValueError, 'lacks exact live syscall entry'):
            runtime.pending()
        self.assertNotIn('generationOpenPending', owner.tasks[123])


if __name__ == '__main__':
    unittest.main()
