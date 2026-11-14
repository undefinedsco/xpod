#!/usr/bin/env python3
import argparse
import importlib.util
import os
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
    collector = None
    original_directory = os.environ.get('XPOD_QLEVER_UPSTREAM_MATERIALS_DIR')
    if original_directory:
        spec = importlib.util.spec_from_file_location('sdk_upstream', QLEVER_ROOT / 'scripts/sdk-upstream-source-materials.py')
        upstream = importlib.util.module_from_spec(spec); spec.loader.exec_module(upstream)
        collector = upstream.Collector(source, QLEVER_ROOT, original_directory,
            upstream.budgets.ExecutionBudget(os.environ['XPOD_QLEVER_SDK_DEADLINE_UNIX']))
        collector.before()
    for index, name in enumerate(names):
        patch = patches / name
        if collector:
            collector.patch(index, ['git', 'apply', '--check', str(patch)])
            collector.patch(index, ['git', 'apply', str(patch)])
        else:
            run(['git', 'apply', '--check', str(patch)], source)
            run(['git', 'apply', str(patch)], source)
    if collector:
        collector.after()
    print(f"Applied {len(names)} locked QLever patches to {source}")


if __name__ == "__main__":
    main()
