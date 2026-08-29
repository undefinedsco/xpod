#!/usr/bin/env python3
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


QLEVER_ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def patch_series_digest(patches: Path) -> str:
    series_path = patches / "series"
    names = [line.strip() for line in series_path.read_text().splitlines() if line.strip()]
    if len(names) != len(set(names)):
        fail("QLever patch series contains duplicate entries")

    available = {path.name for path in patches.glob("*.patch")}
    listed = set(names)
    if listed != available:
        missing = sorted(available - listed)
        unknown = sorted(listed - available)
        fail(f"QLever patch series mismatch: unlisted={missing}, missing={unknown}")

    digest = hashlib.sha256()
    digest.update(series_path.read_bytes())
    for name in names:
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update((patches / name).read_bytes())
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()

    lock = json.loads((QLEVER_ROOT / "qlever.lock.json").read_text())
    actual_digest = patch_series_digest(QLEVER_ROOT / "patches")
    if actual_digest != lock["patchSeriesSha256"]:
        fail(
            "QLever patch series digest mismatch: "
            f"expected {lock['patchSeriesSha256']}, got {actual_digest}"
        )

    if args.source is not None:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=args.source,
            text=True,
            capture_output=True,
        )
        actual_commit = result.stdout.strip() if result.returncode == 0 else ""
        if actual_commit != lock["commit"]:
            fail(
                "QLever source commit mismatch: "
                f"expected {lock['commit']}, got {actual_commit or 'unknown'}"
            )

    print(
        "QLever lock verified: "
        f"commit={lock['commit']} "
        f"patches={len((QLEVER_ROOT / 'patches' / 'series').read_text().splitlines())}"
    )


if __name__ == "__main__":
    main()
