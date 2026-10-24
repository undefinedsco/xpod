"""Shared read budget for QLever SDK service ABI role sessions.

The class only accounts bytes read through :meth:`SharedReadBudget.read`.
It does not grant a capability and it does not own timers or resets: the
caller MUST create exactly one instance and share it across every role
session; there is deliberately no independent per-role default budget.
"""

from __future__ import annotations

import os
import json
from pathlib import Path
import threading

# Existing sourceMaterialBytes ceiling from the service ABI.
MAXIMUM_BYTES_LIMIT = json.loads((Path(__file__).resolve().parents[2] / 'scripts/lib/module-artifact-limits.json').read_text())['sourceMaterialBytes']
# Largest single requested read.
MAXIMUM_READ_COUNT = 65536


class BudgetExceededError(RuntimeError):
    """Raised before ``os.read`` when a request would exceed the budget."""


class SharedReadBudget:
    """A single lock-protected byte ledger shared by all role sessions."""

    def __init__(self, maximum_bytes: int, check) -> None:
        if (
            isinstance(maximum_bytes, bool)
            or not isinstance(maximum_bytes, int)
            or not 0 < maximum_bytes <= MAXIMUM_BYTES_LIMIT
        ):
            raise ValueError(
                "maximum_bytes must be a positive integer <= "
                f"{MAXIMUM_BYTES_LIMIT}"
            )
        if not callable(check):
            raise TypeError("check must be callable")
        self._maximum_bytes = maximum_bytes
        self._check = check
        self._consumed = 0
        self._lock = threading.Lock()

    @property
    def consumed(self) -> int:
        with self._lock:
            return self._consumed

    @property
    def remaining(self) -> int:
        with self._lock:
            return self._maximum_bytes - self._consumed

    def read(self, fd: int, count: int) -> bytes:
        if (
            isinstance(count, bool)
            or not isinstance(count, int)
            or not 1 <= count <= MAXIMUM_READ_COUNT
        ):
            raise ValueError(
                f"count must be an integer in 1..{MAXIMUM_READ_COUNT}"
            )
        with self._lock:
            # The parent check runs both before and after while the ledger
            # lock is held, so no other role session can charge in between.
            self._check()
            if count > self._maximum_bytes - self._consumed:
                raise BudgetExceededError(
                    "requested read exceeds remaining budget"
                )
            # No try/except: a failing os.read propagates unchanged and
            # never refunds bytes already charged by other reads.
            data = os.read(fd, count)
            # Charge the actual short-read length, then re-check the parent
            # state so the read is accounted even if cancellation now wins.
            self._consumed += len(data)
            self._check()
            return data
