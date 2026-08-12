#!/usr/bin/env python3
import argparse
import filecmp
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_identity(path: Path) -> str:
    try:
        return path.read_text()
    except FileNotFoundError:
        return ""


def relative_files(root: Path) -> dict[str, Path]:
    files = {}
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if ".git" in relative.parts:
            continue
        if path.is_symlink():
            fail(f"symlinks are not supported: {relative.as_posix()}")
        if path.is_file():
            files[relative.as_posix()] = path
        elif path.is_dir():
            continue
        else:
            fail(f"unsupported source entry type: {relative.as_posix()}")
    return files


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest(files: dict[str, Path]) -> str:
    lines = []
    for relative_path, path in sorted(files.items()):
        stat = path.lstat()
        mode = stat.st_mode & 0o777
        digest = file_digest(path)
        kind = "f"
        lines.append(f"{digest}  {kind}  {mode:o}  {relative_path}")
    return "\n".join(lines) + ("\n" if lines else "")


def same_content(source: Path, target: Path) -> bool:
    if target.is_symlink():
        fail(f"symlinks are not supported: {target}")
    if not target.is_file():
        return False
    source_mode = source.stat().st_mode & 0o777
    target_mode = target.stat().st_mode & 0o777
    return source_mode == target_mode and filecmp.cmp(source, target, shallow=False)


def copy_changed(source: Path, target: Path) -> None:
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(target)
    elif target.exists() or target.is_symlink():
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(delete=False, dir=target.parent) as handle:
        temp_path = Path(handle.name)
    try:
        shutil.copy2(source, temp_path)
        os.replace(temp_path, target)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def remove_empty_dirs(root: Path) -> None:
    for path in sorted((p for p in root.rglob("*") if p.is_dir()), reverse=True):
        if ".git" in path.relative_to(root).parts:
            continue
        try:
            path.rmdir()
        except OSError:
            pass


def remove_path(path: Path) -> None:
    if path.is_symlink():
        fail(f"symlinks are not supported: {path}")
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Synchronize a verified patched QLever tree into a persisted SDK source tree."
    )
    parser.add_argument("--patched-source", required=True, type=Path)
    parser.add_argument("--target-source", required=True, type=Path)
    parser.add_argument("--manifest-out", required=True, type=Path)
    parser.add_argument("--prior-validation-marker", type=Path)
    args = parser.parse_args()

    patched_source = args.patched_source.resolve()
    target_source = args.target_source.resolve()
    if not patched_source.is_dir():
        fail(f"patched source does not exist: {patched_source}")

    patched_files = relative_files(patched_source)
    target_source.mkdir(parents=True, exist_ok=True)
    target_files = relative_files(target_source)
    target_manifest_before = manifest(target_files)
    if args.prior_validation_marker is not None:
        try:
            marker = json.loads(args.prior_validation_marker.read_text())
        except FileNotFoundError:
            fail("prior validation marker missing")
        except json.JSONDecodeError:
            fail("prior validation marker is invalid")
        if marker.get("sourceManifest") != target_manifest_before:
            fail("prior SDK source manifest mismatch")

    for relative_path in sorted(set(target_files) - set(patched_files)):
        remove_path(target_files[relative_path])

    for relative_path, source in sorted(patched_files.items()):
        target = target_source / relative_path
        for parent in target.parents:
            if parent == target_source:
                break
            if parent.exists() and not parent.is_dir():
                remove_path(parent)
        if target.exists() and same_content(source, target):
            continue
        copy_changed(source, target)

    remove_empty_dirs(target_source)
    args.manifest_out.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_out.write_text(manifest(patched_files))


if __name__ == "__main__":
    main()
