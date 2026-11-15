"""Scoped test-only temporary directories under the owning repository.

This helper deliberately has no import-time side effects and derives its root
from its own file so both ``python -m unittest`` and direct test-script runs
use the same repository-local ``.test-data`` location.
"""
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / '.test-data' / 'fixture-fixes'


def scoped_temp(prefix):
    """Create one suite/case TemporaryDirectory under ``ROOT/.test-data``."""
    BASE.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=prefix + '-', dir=BASE)
