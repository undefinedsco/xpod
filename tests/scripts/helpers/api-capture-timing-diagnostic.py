#!/usr/bin/env python3
"""Permanent timing-diagnostic boundary test for the Inngest controlled build.

Ported from .test-data/api-capture-profile/test-timing-failure.py. All paths are
derived from this file's location, so the check runs in any checkout without
absolute paths. Temporary fixtures are created only under
.test-data/api-capture-timing-diagnostic/.

The production module only exposes capture_inputs; these checks patch the
diagnostic seams (time source, event construction, JSON serialization, stderr)
and verify that a failing diagnostic never replaces or re-wraps the original
exception object. A valid fixture additionally pins the fixed eight-event
contract.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import traceback
from pathlib import Path

sys.dont_write_bytecode = True

MODULE_RELATIVE = Path("scripts") / "lib" / "inngest-controlled-build.py"
DATA_RELATIVE = Path(".test-data") / "api-capture-timing-diagnostic"
TARGET = "darwin-x64"
EXPECTED_STAGES = [
    "before-domains",
    "capture-domain-source",
    "capture-domain-dependencies",
    "capture-domain-toolchain",
    "after-domains",
    "write-metadata",
    "total-check",
    "capture-inputs",
]


def _find_repo_root() -> Path:
    """Walk up from this helper until the production module is found."""
    start = Path(__file__).resolve().parent
    for candidate in (start, *start.parents):
        if (candidate / MODULE_RELATIVE).is_file():
            return candidate
    raise FileNotFoundError(
        f"could not locate {MODULE_RELATIVE.as_posix()} above {start}"
    )


REPO_ROOT = _find_repo_root()
MODULE_PATH = (REPO_ROOT / MODULE_RELATIVE).resolve()
DATA_ROOT = REPO_ROOT / DATA_RELATIVE


class OriginalFailure(RuntimeError):
    """Sentinel for the production failure under test."""


class RaisingTime:
    def __init__(self, hits: dict) -> None:
        self._hits = hits

    def monotonic(self):
        self._hits["count"] += 1
        raise RuntimeError("diagnostic monotonic failure")


class PoisonStarted:
    """Start marker whose arithmetic (event construction) always fails."""

    def __init__(self, hits: dict) -> None:
        self._hits = hits

    def _fail(self):
        self._hits["count"] += 1
        raise RuntimeError("diagnostic event construction failure")

    def __rsub__(self, other):
        self._fail()

    def __sub__(self, other):
        self._fail()

    def __float__(self):
        self._fail()


class RaisingStderr:
    def __init__(self, hits: dict) -> None:
        self._hits = hits

    def write(self, value):
        self._hits["count"] += 1
        raise RuntimeError("diagnostic stderr failure")

    def flush(self):
        self._hits["count"] += 1
        raise RuntimeError("diagnostic stderr failure")


class RaisingJSON:
    def __init__(self, hits: dict) -> None:
        self._hits = hits

    def dumps(self, *args, **kwargs):
        self._hits["count"] += 1
        raise RuntimeError("diagnostic serialization failure")


class SysShim:
    def __init__(self, stderr) -> None:
        self.stderr = stderr


def _load_module():
    if not MODULE_PATH.is_file():
        raise FileNotFoundError(f"module not found: {MODULE_PATH}")
    spec = importlib.util.spec_from_file_location(
        "inngest_controlled_build_timing_diagnostic", str(MODULE_PATH)
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"could not create module spec for {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _make_valid_work(root: Path) -> Path:
    work = root / "work"
    (work / "source" / "plain").mkdir(parents=True)
    (work / "source" / "node_modules" / "example").mkdir(parents=True)
    (work / "tools").mkdir(parents=True)
    (work / "source" / "plain" / "plain.txt").write_bytes(b"a" * 7)
    (work / "source" / "node_modules" / "example" / "module.txt").write_bytes(b"b" * 11)
    (work / "tools" / "dummy").write_bytes(b"")
    return work


@contextlib.contextmanager
def _patched(module, name, value):
    missing = object()
    original = getattr(module, name, missing)
    setattr(module, name, value)
    try:
        yield value
    finally:
        if original is missing:
            delattr(module, name)
        else:
            setattr(module, name, original)


def _expect_original(module, label: str, patch_factory) -> None:
    """Raise one sentinel production failure while a diagnostic seam is broken."""
    sentinel = OriginalFailure(f"original:{label}")
    hits = {"count": 0}

    def production_need(condition, message):
        raise sentinel

    with _patched(module, "need", production_need):
        with patch_factory(module, hits):
            try:
                module.capture_inputs(DATA_ROOT)
            except BaseException as error:  # noqa: BLE001 - the failure itself
                if error is not sentinel:
                    raise AssertionError(
                        f"{label}: diagnostic replaced the original exception object "
                        f"with {type(error).__name__}: {error}"
                    ) from error
                if str(error) != f"original:{label}":
                    raise AssertionError(
                        f"{label}: original sentinel message changed: {error!r}"
                    )
            else:
                raise AssertionError(f"{label}: original exception was swallowed")
    print(f"  {label}: broken diagnostic seam exercised {hits['count']} time(s)")


def _check_monotonic(module, hits):
    return _patched(module, "time", RaisingTime(hits))


def _check_event_construction(module, hits):
    return _patched(module, "_timing_start", lambda: PoisonStarted(hits))


def _check_serialization(module, hits):
    return _patched(module, "json", RaisingJSON(hits))


def _check_stderr(module, hits):
    return _patched(module, "sys", SysShim(RaisingStderr(hits)))


def _check_valid(module) -> None:
    with tempfile.TemporaryDirectory(prefix="timing-valid-", dir=str(DATA_ROOT)) as temp:
        work = _make_valid_work(Path(temp))
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            module.capture_inputs(work, target=TARGET)
        lines = [line for line in captured.getvalue().splitlines() if line]
        if len(lines) != 8:
            raise AssertionError(f"valid: expected 8 timing events, got {len(lines)}: {lines}")
        events = [json.loads(line) for line in lines]
        stages = [event.get("stage") for event in events]
        if stages != EXPECTED_STAGES:
            raise AssertionError(f"valid: unexpected stage order {stages}")
        for event in events:
            if event.get("event") != "capture-inputs-timing":
                raise AssertionError(f"valid: wrong event name {event!r}")
            elapsed = event.get("elapsedSeconds")
            if not isinstance(elapsed, (int, float)) or elapsed < 0:
                raise AssertionError(f"valid: invalid elapsedSeconds {event!r}")
            if event["stage"] != "capture-inputs" and not event.get("success"):
                raise AssertionError(f"valid: mid-stage event not successful {event!r}")
        if events[-1].get("success") is not True:
            raise AssertionError(f"valid: terminal event not successful {events[-1]!r}")
        before = events[0]
        if before.get("fileCount") != 3 or before.get("bytes") != 18:
            raise AssertionError(f"valid: unexpected before-domains counts {before!r}")
        for event in events[1:4]:
            for key in ("fileCount", "bytes"):
                if not isinstance(event.get(key), int) or event[key] < 0:
                    raise AssertionError(f"valid: missing/invalid {key} {event!r}")
        if not (work / "inputs.original.json").is_file():
            raise AssertionError("valid: inputs.original.json was not written")


def main() -> int:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    failures = []
    module = _load_module()
    checks = [
        ("monotonic", lambda m: _expect_original(m, "monotonic", _check_monotonic)),
        (
            "event-construction",
            lambda m: _expect_original(m, "event-construction", _check_event_construction),
        ),
        ("serialization", lambda m: _expect_original(m, "serialization", _check_serialization)),
        ("stderr", lambda m: _expect_original(m, "stderr", _check_stderr)),
        ("valid-eight-events", _check_valid),
    ]
    for name, check in checks:
        try:
            check(module)
        except BaseException as error:  # noqa: BLE001 - report every failed check
            failures.append((name, error))
            print(f"FAIL {name}: {type(error).__name__}: {error}")
            traceback.print_exc()
        else:
            print(f"PASS {name}")
    if failures:
        print(f"{len(failures)} timing diagnostic check(s) failed")
        return 1
    print("all timing diagnostic checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
