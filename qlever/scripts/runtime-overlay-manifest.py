#!/usr/bin/env python3

import argparse
import hashlib
import re
from pathlib import Path


HEADER_PATTERN = re.compile(r'Xpod[A-Za-z0-9_]+\.hpp')
LOCAL_INCLUDE_PATTERN = re.compile(r'^\s*#include\s+"([^"]+)"', re.MULTILINE)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--qlever-root", required=True, type=Path)
    args = parser.parse_args()

    qlever_root = args.qlever_root.resolve()
    search_roots = [
        qlever_root / "include",
        qlever_root / "qlever_adapter" / "include",
        qlever_root / "qlever_adapter" / "src",
        qlever_root / "rdf_protocol" / "include",
    ]

    headers = {
        path.name: path
        for root in search_roots
        for path in root.rglob("*")
        if path.suffix in {".h", ".hpp"}
    }
    pending = set()
    for patch in (qlever_root / "patches").rglob("*.patch"):
        pending.update(HEADER_PATTERN.findall(patch.read_text()))

    selected = set()
    while pending:
        name = pending.pop()
        path = headers.get(name)
        if path is None:
            raise SystemExit(f"runtime overlay header not found: {name}")
        if path in selected:
            continue
        selected.add(path)
        for include in LOCAL_INCLUDE_PATTERN.findall(path.read_text()):
            included_path = headers.get(Path(include).name)
            if included_path is not None and included_path not in selected:
                pending.add(included_path.name)

    for path in sorted(selected):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"{digest}  {path.relative_to(qlever_root)}")


if __name__ == "__main__":
    main()
