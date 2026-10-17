"""Produce a fresh physical CSS runtime from an actual native Linux build.

Bundles non-glibc dependencies, then runs the canonical smoke/manifest producer.
This does not manufacture official artifact identity or compiler/source admission.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import struct
import subprocess
from pathlib import Path


SYSTEM_LIBRARIES = {
    "libc.so.6", "libm.so.6", "libpthread.so.0", "librt.so.1", "libdl.so.2",
    "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1",
}


class PreparationReceiptError(RuntimeError):
    def __init__(self, primary, receipt):
        super().__init__("Native preparation and receipt write failed")
        self.errors = (primary, receipt)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def verify_elf(path, target):
    with path.open("rb") as source:
        header = source.read(64)
    machine = {"linux-x64": 62, "linux-arm64": 183}.get(target)
    if (machine is None or len(header) < 64 or header[:6] != b"\x7fELF\x02\x01"
            or struct.unpack_from("<H", header, 18)[0] != machine):
        raise ValueError("ELF target mismatch")


def parse_ldd(text):
    libraries = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or re.fullmatch(r"linux-vdso\.so\.1 \(0x[0-9a-f]+\)", line):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.+-]+) => (/[^\s]+) \(0x[0-9a-f]+\)", line)
        if match:
            name, file = match.groups()
        else:
            match = re.fullmatch(r"(/[^\s]+) \(0x[0-9a-f]+\)", line)
            if not match:
                raise ValueError("unresolved or unsupported ldd dependency")
            file = match.group(1)
            name = Path(file).name
        if name in libraries and libraries[name] != file:
            raise ValueError("ambiguous dependency name")
        if name in (".", "..") or ".." in Path(file).parts:
            raise ValueError("unsafe dependency path")
        libraries[name] = file
    if not libraries:
        raise ValueError("empty ldd dependency inventory")
    return libraries


def verify_original(source, manifest_sha, lock):
    manifest_path = source / "manifest.json"
    if (not re.fullmatch(r"[a-f0-9]{64}", manifest_sha) or manifest_path.is_symlink()
            or digest(manifest_path) != manifest_sha):
        raise ValueError("original manifest binding mismatch")
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("schemaVersion") != 1 or manifest.get("adapterAbiVersion") != 7
            or manifest.get("physicalBackendAbiVersion") != 7 or manifest.get("qlever") != lock):
        raise ValueError("original native source or ABI mismatch")
    names = set()
    for row in manifest.get("artifacts", []):
        name = row.get("path", "")
        if not re.fullmatch(r"(?:bin|lib)/[A-Za-z0-9_.+-]+", name) or name in names or name.split("/")[-1] in (".", ".."):
            raise ValueError("unsafe original runtime member")
        file = source / name
        if (file.is_symlink() or not file.is_file() or source not in file.resolve().parents
                or file.stat().st_size != row.get("size") or digest(file) != row.get("sha256")):
            raise ValueError("original runtime byte binding mismatch")
        names.add(name)
    if "bin/xpod_qlever_local_runtime" not in names:
        raise ValueError("original runtime member missing")
    return sorted(names)


def prepare(source, output, evidence, workspace, target, manifest_sha):
    actual_arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    if platform.system() != "Linux" or target != "linux-" + str(actual_arch):
        raise ValueError("native Linux target required")
    source, output, evidence, workspace = [p.resolve() for p in (source, output, evidence, workspace)]
    if output == evidence or output in evidence.parents or evidence in output.parents:
        raise ValueError("runtime and external evidence must be disjoint")
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("fresh output must be disjoint from original runtime")
    if source == evidence or source in evidence.parents or evidence in source.parents:
        raise ValueError("external evidence must be disjoint from original runtime")
    # Fail before touching original inputs or running native tools.
    if output.exists() or evidence.exists():
        raise ValueError("fresh output and evidence directories required")
    original = source / "bin/xpod_qlever_local_runtime"
    if original.is_symlink() or not original.is_file():
        raise ValueError("regular original runtime required")
    verify_elf(original, target)
    original_members = verify_original(source, manifest_sha, json.loads((workspace / "qlever/qlever.lock.json").read_text()))
    for name in original_members:
        verify_elf(source / name, target)
    tools = {}
    for tool in ("ldd", "patchelf", "python3"):
        if not shutil.which(tool):
            raise ValueError("required native tool missing: " + tool)
        executable = Path(shutil.which(tool)).resolve()
        tools[tool] = {"path": str(executable), "sha256": digest(executable)}
    output.mkdir(parents=True, mode=0o700)
    evidence.mkdir(parents=True, mode=0o700)
    records, bindings = [], []
    failure = None
    primary_error = None

    def run(args):
        environment = {key: value for key, value in os.environ.items() if key not in ("LD_PRELOAD", "LD_LIBRARY_PATH")}
        environment["LC_ALL"] = "C"
        args = [tools[args[0]]["path"], *args[1:]]
        result = subprocess.run(args, capture_output=True, env=environment)
        number = len(records)
        stdout, stderr = evidence / f"{number}.stdout.raw", evidence / f"{number}.stderr.raw"
        stdout.write_bytes(result.stdout)
        stderr.write_bytes(result.stderr)
        records.append({"command": args, "actualExit": result.returncode, "actualWait": True,
                        "rawClosed": True, "stdoutSHA256": digest(stdout), "stderrSHA256": digest(stderr)})
        if result.returncode:
            raise RuntimeError("native preparation command failed")
        return result.stdout.decode("utf-8")

    def copy(original_file, relative):
        file = original_file.resolve(strict=True)
        if not file.is_file():
            raise ValueError("dependency must resolve to a regular file")
        destination = output / relative
        original_sha = digest(file)
        if destination.exists():
            if digest(destination) != original_sha:
                raise ValueError("dependency content collision")
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, destination)
        if digest(destination) != original_sha:
            raise ValueError("dependency changed while copying")
        bindings.append({"original": str(file), "path": relative, "originalSHA256": original_sha,
                         "originalBytes": file.stat().st_size})

    try:
        pending = []
        for name in original_members:
            copy(source / name, name)
            pending.append(source / name)
        visited, baseline = set(), {}
        # Manifest members include dlopen libraries absent from the main bin's ldd.
        while pending:
            member = pending.pop().resolve(strict=True)
            if member in visited:
                continue
            visited.add(member)
            dependencies = parse_ldd(run(["ldd", str(member)]))
            for name, file in sorted(dependencies.items()):
                dependency = Path(file).resolve(strict=True)
                verify_elf(dependency, target)
                if name in SYSTEM_LIBRARIES:
                    record = {"name": name, "original": str(dependency), "sha256": digest(dependency)}
                    if name in baseline and baseline[name]["sha256"] != record["sha256"]:
                        raise ValueError("ambiguous system ABI dependency")
                    baseline[name] = record
                else:
                    copy(dependency, "lib/" + name)
                    pending.append(dependency)
        for binary in sorted((output / "bin").glob("*")):
            run(["patchelf", "--set-rpath", "$ORIGIN/../lib", str(binary)])
        for library in sorted((output / "lib").glob("*")):
            run(["patchelf", "--set-rpath", "$ORIGIN", str(library)])
        for member in [*sorted((output / "bin").glob("*")), *sorted((output / "lib").glob("*"))]:
            resolved = parse_ldd(run(["ldd", str(member)]))
            for name, file in resolved.items():
                if name not in SYSTEM_LIBRARIES and Path(file).resolve().parent != output / "lib":
                    raise ValueError("unbundled non-system runtime dependency")
        glibc = run(["ldd", "--version"]).splitlines()[0]
        run(["python3", str(workspace / "qlever/scripts/verify-local-runtime-artifacts.py"),
             "--prefix", str(output), "--lock", str(workspace / "qlever/qlever.lock.json"),
             "--build-source", target, "--smoke-database", str(evidence / "runtime-smoke.sqlite")])
        (evidence / "system-abi.safe.json").write_text(json.dumps({
            "target": target, "glibc": glibc, "systemLibraries": [baseline[name] for name in sorted(baseline)],
            "support": "Same target and compatible glibc ABI as this recorded native worker; no broader Linux compatibility claim",
        }, indent=2) + "\n")
        for binding in bindings:
            if digest(Path(binding["original"])) != binding["originalSHA256"]:
                raise ValueError("original dependency changed during preparation")
        for tool in tools.values():
            if digest(Path(tool["path"])) != tool["sha256"]:
                raise ValueError("native tool changed during preparation")
    except Exception as error:
        failure = type(error).__name__
        primary_error = error
        raise
    finally:
        try:
            (evidence / "physical-runtime.receipt.safe.json").write_text(json.dumps({
                "schemaVersion": 1, "target": target, "ok": failure is None, "failure": failure,
                "originalManifestSHA256": manifest_sha, "toolInputs": tools,
                "originalBindings": bindings, "commands": records,
                "files": [{"path": str(p.relative_to(output)), "sha256": digest(p), "bytes": p.stat().st_size}
                          for p in sorted(output.rglob("*")) if p.is_file()],
                "releaseAccepted": False, "scope": "Fresh physical layout and actual native smoke; official identity and build materials require separate admission",
            }, indent=2) + "\n")
        except Exception as receipt_error:
            if primary_error is not None:
                raise PreparationReceiptError(primary_error, receipt_error) from primary_error
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--target", choices=["linux-x64", "linux-arm64"], required=True)
    parser.add_argument("--original-manifest-sha256", required=True)
    args = parser.parse_args()
    prepare(args.source, args.out, args.evidence, args.workspace, args.target, args.original_manifest_sha256)
