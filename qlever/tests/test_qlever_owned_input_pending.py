"""Stale owned-input triggers must fail closed, never bind or silently skip."""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    'owned_input_generation', HERE.parent / 'scripts' / 'sdk-owned-input-generation.py')
OWNED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNED)
BACKEND_SPEC = importlib.util.spec_from_file_location(
    'owned_input_backend', HERE.parent / 'scripts' / 'sdk-ptrace-execution.py')
BACKEND = importlib.util.module_from_spec(BACKEND_SPEC)
BACKEND_SPEC.loader.exec_module(BACKEND)


class _Owner:
    _PENDING_FIELDS = BACKEND.Observer._PENDING_FIELDS
    _ensure_index = BACKEND.Observer._ensure_index
    _pending_add = BACKEND.Observer._pending_add
    _pending_discard = BACKEND.Observer._pending_discard

    def __init__(self):
        self.exclusive = None
        self.tasks = {123: dict(exited=False, entry=None)}
        self.maximum_file_bytes = 1 << 20
        self.task_order = {123: 0}
        self.live_tasks = {123}
        self._next_task_order = 1
        self.terminal_authorities = set()
        self.pending = {name: set() for name in (
            'authority', 'tool', 'identity', 'bti', 'clone3', 'append',
            'generationOpen', 'generationTruncate')}

    def set_open_pending(self, sequence):
        self.tasks[123]['generationOpenPending'] = sequence
        self._pending_add(123, 'generationOpen')

    def set_truncate_pending(self, sequence):
        self.tasks[123]['generationTruncatePending'] = sequence
        self._pending_add(123, 'generationTruncate')


class StalePendingTest(unittest.TestCase):
    def test_open_trigger_without_live_entry_fails_closed(self):
        owner = _Owner()
        owner.set_open_pending(41)
        runtime = OWNED.Runtime(owner, None)
        with self.assertRaisesRegex(ValueError, 'lacks exact live syscall entry'):
            runtime.pending()
        self.assertNotIn('generationOpenPending', owner.tasks[123])

    def test_truncate_trigger_without_live_entry_fails_closed(self):
        owner = _Owner()
        owner.set_truncate_pending(42)
        runtime = OWNED.Runtime(owner, None)
        with self.assertRaisesRegex(ValueError, 'lacks exact live syscall entry'):
            runtime.pending()
        self.assertNotIn('generationTruncatePending', owner.tasks[123])

    def test_trigger_for_a_different_entry_is_not_replayed(self):
        owner = _Owner()
        owner.set_open_pending(41)
        owner.tasks[123]['entry'] = {'sequence': 99}
        runtime = OWNED.Runtime(owner, None)
        with self.assertRaisesRegex(ValueError, 'lacks exact live syscall entry'):
            runtime.pending()
        self.assertNotIn('generationOpenPending', owner.tasks[123])


if __name__ == '__main__':
    unittest.main()
