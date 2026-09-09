#!/usr/bin/env python3
import argparse
import subprocess
from pathlib import Path


QLEVER_ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str], cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Apply the locked Xpod patch series to a clean pinned QLever source tree."
    )
    parser.add_argument("--source", required=True, type=Path)
    args = parser.parse_args()
    source = args.source.resolve()

    run(
        ["python3", str(QLEVER_ROOT / "scripts/verify-lock.py"), "--source", str(source)],
        QLEVER_ROOT.parent,
    )
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=source,
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    if status:
        raise SystemExit("QLever source tree must be clean before applying patches")

    patches = QLEVER_ROOT / "patches"
    names = [line.strip() for line in (patches / "series").read_text().splitlines() if line.strip()]
    for name in names:
        patch = patches / name
        run(["git", "apply", "--check", str(patch)], source)
        run(["git", "apply", str(patch)], source)
    print(f"Applied {len(names)} locked QLever patches to {source}")


if __name__ == "__main__":
    main()
