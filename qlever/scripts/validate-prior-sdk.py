#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def run(command: list[str], cwd: Optional[Path] = None) -> str:
    try:
        result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    except FileNotFoundError:
        fail(f"command missing: {command[0]}")
    if result.returncode != 0:
        fail(result.stderr.strip() or result.stdout.strip() or f"command failed: {' '.join(command)}")
    return result.stdout


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
        elif not path.is_dir():
            fail(f"unsupported source entry type: {relative.as_posix()}")
    return files


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_manifest(root: Path) -> str:
    lines = []
    for relative_path, path in sorted(relative_files(root).items()):
        mode = path.stat().st_mode & 0o777
        lines.append(f"{file_digest(path)}  f  {mode:o}  {relative_path}")
    return "\n".join(lines) + ("\n" if lines else "")


def patch_series_digest(patches: Path) -> str:
    series_path = patches / "series"
    names = [line.strip() for line in series_path.read_text().splitlines() if line.strip()]
    digest = hashlib.sha256()
    digest.update(series_path.read_bytes())
    for name in names:
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update((patches / name).read_bytes())
    return digest.hexdigest()


def parse_cache(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        fail("prior SDK CMake cache incompatible: missing CMakeCache.txt")
    cache = {}
    for line in lines:
        if not line or line.startswith(("#", "//")) or "=" not in line:
            continue
        key_type, value = line.split("=", 1)
        key = key_type.split(":", 1)[0]
        cache[key] = value
    return cache


def validate_cache(build_dir: Path, source: Path) -> dict[str, str]:
    cache = parse_cache(build_dir / "CMakeCache.txt")
    required = {
        "CMAKE_BUILD_TYPE": "Release",
        "CMAKE_POSITION_INDEPENDENT_CODE": "ON",
        "CHEAPER_COMPILATION": "ON",
        "RANGES_NATIVE": "OFF",
        "USE_PRECOMPILED_HEADERS": "OFF",
        "USE_IO_URING": "OFF",
    }
    for key, expected in required.items():
        if cache.get(key) != expected:
            fail(f"prior SDK CMake cache incompatible: {key}")
    home = cache.get("CMAKE_HOME_DIRECTORY")
    if home is not None and Path(home).resolve() != source.resolve():
        fail("prior SDK CMake cache incompatible: source path")
    compiler = cache.get("CMAKE_CXX_COMPILER", "")
    if "clang++-19" not in compiler:
        fail("prior SDK CMake cache incompatible: compiler")
    return {key: cache.get(key, "") for key in sorted(required)}


def validate_compile_commands(build_dir: Path, source: Path) -> None:
    try:
        commands = json.loads((build_dir / "compile_commands.json").read_text())
    except FileNotFoundError:
        fail("prior SDK compile_commands incompatible: missing compile_commands.json")
    except json.JSONDecodeError:
        fail("prior SDK compile_commands incompatible: invalid JSON")
    if not isinstance(commands, list) or not commands:
        fail("prior SDK compile_commands incompatible: empty")
    allowed_roots = (source.resolve(), build_dir.resolve())
    for entry in commands:
        arguments = entry.get("arguments")
        if isinstance(arguments, list):
            command_tokens = [str(token) for token in arguments]
        else:
            try:
                command_tokens = shlex.split(entry.get("command", ""))
            except (TypeError, ValueError):
                fail("prior SDK compile_commands incompatible: compiler")
        if not command_tokens or Path(command_tokens[0]).name not in {"clang-19", "clang++-19"}:
            fail("prior SDK compile_commands incompatible: compiler")
        raw_file = entry.get("file")
        if not isinstance(raw_file, str) or not raw_file:
            fail("prior SDK compile_commands incompatible: source path")
        file_path = Path(raw_file)
        if not file_path.is_absolute():
            raw_directory = entry.get("directory", "")
            if not isinstance(raw_directory, str):
                fail("prior SDK compile_commands incompatible: source path")
            directory = Path(raw_directory) if raw_directory else build_dir
            if not directory.is_absolute():
                directory = build_dir / directory
            file_path = directory / file_path
        resolved_file = file_path.resolve()
        if not any(resolved_file == root or root in resolved_file.parents for root in allowed_roots):
            fail("prior SDK compile_commands incompatible: source path")


def tool_version(command: list[str]) -> str:
    return run(command).splitlines()[0]


def os_pretty_name() -> str:
    path = Path(os.environ.get("XPOD_QLEVER_OS_RELEASE_FILE", "/etc/os-release"))
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        fail("prior SDK base identity unavailable: missing os-release")
    for line in lines:
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    fail("prior SDK base identity unavailable: PRETTY_NAME")


def contract_identity(contract: dict) -> str:
    text = json.dumps(contract, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


def load_or_bootstrap_contract(
    build_dir: Path,
    source: Path,
    cache_metadata: dict[str, str],
    bootstrap: bool,
) -> tuple[dict, str]:
    contract_file = build_dir / ".xpod-build-contract.json"
    if contract_file.exists():
        try:
            contract = json.loads(contract_file.read_text())
        except json.JSONDecodeError:
            fail("prior SDK build contract invalid")
    elif bootstrap:
        contract = {
            "schemaVersion": 1,
            "component": "qlever-runtime-sdk",
            "base": {
                "osReleasePrettyName": os_pretty_name(),
            },
            "toolchain": {
                "clang": tool_version(["clang-19", "--version"]),
                "clangxx": tool_version(["clang++-19", "--version"]),
                "cmake": tool_version(["cmake", "--version"]),
            },
            "cmake": {
                "source": str(source),
                "build": str(build_dir),
                "buildType": "Release",
                "positionIndependentCode": "ON",
                "flags": cache_metadata,
            },
        }
    else:
        fail("prior SDK build contract missing")

    if contract.get("schemaVersion") != 1:
        fail("prior SDK build contract incompatible: schemaVersion")
    if contract.get("component") != "qlever-runtime-sdk":
        fail("prior SDK build contract incompatible: component")
    base = contract.get("base", {})
    if base.get("osReleasePrettyName") != os_pretty_name():
        fail("prior SDK build contract incompatible: base")
    toolchain = contract.get("toolchain", {})
    expected_tools = {
        "clang": tool_version(["clang-19", "--version"]),
        "clangxx": tool_version(["clang++-19", "--version"]),
        "cmake": tool_version(["cmake", "--version"]),
    }
    if toolchain != expected_tools:
        fail("prior SDK build contract incompatible: toolchain")
    cmake_contract = contract.get("cmake", {})
    if cmake_contract.get("buildType") != "Release":
        fail("prior SDK build contract incompatible: buildType")
    if cmake_contract.get("positionIndependentCode") != "ON":
        fail("prior SDK build contract incompatible: PIC")
    if Path(cmake_contract.get("source", "")).resolve() != source.resolve():
        fail("prior SDK build contract incompatible: source path")
    if Path(cmake_contract.get("build", "")).resolve() != build_dir.resolve():
        fail("prior SDK build contract incompatible: build path")
    flags = cmake_contract.get("flags", {})
    for key in (
        "CHEAPER_COMPILATION",
        "RANGES_NATIVE",
        "USE_PRECOMPILED_HEADERS",
        "USE_IO_URING",
    ):
        value = cache_metadata[key]
        if flags.get(key) != value:
            fail(f"prior SDK build contract incompatible: {key}")
    return contract, contract_identity(contract)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate a prior immutable QLever runtime SDK before incremental sync."
    )
    parser.add_argument("--qlever-root", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--build-dir", required=True, type=Path)
    parser.add_argument("--marker-out", required=True, type=Path)
    parser.add_argument("--bootstrap-missing-contract", action="store_true")
    args = parser.parse_args()

    qlever_root = args.qlever_root.resolve()
    source = args.source.resolve()
    build_dir = args.build_dir.resolve()
    if not source.is_dir() or not (source / ".git").is_dir():
        fail("prior SDK source is missing or not a git checkout")
    if not build_dir.is_dir():
        fail("prior SDK build directory missing")

    lock = json.loads((qlever_root / "qlever.lock.json").read_text())
    actual_commit = run(["git", "rev-parse", "HEAD"], source).strip()
    if actual_commit != lock["commit"]:
        fail("prior SDK source commit mismatch")
    actual_patch_digest = patch_series_digest(qlever_root / "patches")
    if actual_patch_digest != lock["patchSeriesSha256"]:
        fail("prior SDK lock patch digest mismatch")
    identity = f"{lock['commit']}:{lock['patchSeriesSha256']}"
    identity_file = build_dir / ".xpod-build-identity"
    if identity_file.read_text() != identity:
        fail("prior SDK build identity mismatch")

    validate_compile_commands(build_dir, source)
    cache_metadata = validate_cache(build_dir, source)
    build_contract, build_contract_identity = load_or_bootstrap_contract(
        build_dir,
        source,
        cache_metadata,
        args.bootstrap_missing_contract,
    )
    toolchain_identity_file = build_dir / ".xpod-toolchain-identity"
    if (build_dir / ".xpod-build-contract.json").exists():
        try:
            persisted_toolchain_identity = toolchain_identity_file.read_text()
        except FileNotFoundError:
            fail("prior SDK toolchain identity missing")
        if persisted_toolchain_identity != build_contract_identity:
            fail("prior SDK toolchain identity mismatch")
    elif not args.bootstrap_missing_contract:
        fail("prior SDK toolchain identity missing")

    with tempfile.TemporaryDirectory() as tmp:
        replay = Path(tmp) / "replay"
        run(["git", "worktree", "add", "--detach", str(replay), lock["commit"]], source)
        try:
            run(["python3", str(qlever_root / "scripts/apply-patches.py"), "--source", str(replay)])
            replay_manifest = source_manifest(replay)
        finally:
            subprocess.run(["git", "worktree", "remove", "--force", str(replay)], cwd=source, text=True, capture_output=True)

    persisted_manifest = source_manifest(source)
    if replay_manifest != persisted_manifest:
        fail("prior SDK source manifest mismatch")

    payload = {
        "schemaVersion": 1,
        "priorIdentity": identity,
        "buildContract": build_contract,
        "buildContractIdentity": build_contract_identity,
        "sourceDigest": hashlib.sha256(persisted_manifest.encode()).hexdigest(),
        "sourceManifest": persisted_manifest,
        "toolchain": {
            "cmake": tool_version(["cmake", "--version"]),
            "clang": tool_version(["clang-19", "--version"]),
            "clangxx": tool_version(["clang++-19", "--version"]),
            "cache": cache_metadata,
        },
        "paths": {
            "source": str(source),
            "build": str(build_dir),
        },
    }
    args.marker_out.parent.mkdir(parents=True, exist_ok=True)
    tmp_marker = args.marker_out.with_suffix(args.marker_out.suffix + ".tmp")
    tmp_marker.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n")
    os.replace(tmp_marker, args.marker_out)


if __name__ == "__main__":
    main()
