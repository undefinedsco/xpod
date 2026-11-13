#!/usr/bin/env python3
"""Verify and safely extract ONE retained desktop diagnostic artifact.

Python 3.9 compatible. Two modes:

  metadata <json> --id ... --name ... --sha256 ... --size ... --run ...
                  --run-source ... --repository-id ...
      Fail closed unless the live artifact metadata matches EVERY pinned value
      (id, name, digest, size, not expired, run id, run source SHA, repository id).

  extract <zip> <outdir> --sha256 ... --size ... --zip-member ... --zip-size ...
          --zip-sha256 ... --dmg-member ... --dmg-size ... --dmg-sha256 ...
      Stream-hash the outer archive, then copy ONLY the two EXACT registered
      member paths, verifying exact size and SHA-256 while writing. The real
      artifact keeps both App archives nested under
      `xpod/xpod/desktop/release/`; each selected member is FLATTENED into the
      owned output directory under its basename. Other members (the safe JSON and
      provenance text) are IGNORED and never written. Selection is by exact path
      only: no basename search and no prefix guessing. A selected member is
      refused when it is duplicated, not a regular file (symlink included), has an
      absolute/backslash/dot/empty path segment, or mismatches its pinned size or
      SHA-256. The caller's outer archive is never modified.
"""
import argparse
import hashlib
import json
import os
import stat
import sys
import zipfile

CHUNK = 1024 * 1024


def fail(message):
    print("retained-desktop-artifact: " + message, file=sys.stderr)
    raise SystemExit(1)


def sha256_file(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as stream:
        while True:
            block = stream.read(CHUNK)
            if not block:
                break
            size += len(block)
            digest.update(block)
    return size, digest.hexdigest()


def clean_hex(value, name):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        fail("%s must be 64 lowercase hex characters" % name)
    return value


def positive_int(value, name):
    try:
        number = int(value)
    except (TypeError, ValueError):
        fail("%s must be an integer" % name)
    if number <= 0:
        fail("%s must be positive" % name)
    return number


def metadata(args):
    try:
        with open(args.metadata, "r", encoding="utf-8") as stream:
            row = json.load(stream)
    except (OSError, ValueError) as error:
        fail("metadata is unreadable: %s" % error.__class__.__name__)
    if not isinstance(row, dict):
        fail("metadata must be an object")
    run = row.get("workflow_run")
    if not isinstance(run, dict):
        fail("metadata workflow_run is missing")
    expected = {
        "id": positive_int(args.id, "id"),
        "name": args.name,
        "size_in_bytes": positive_int(args.size, "size"),
        "digest": "sha256:" + clean_hex(args.sha256, "sha256"),
        "expired": False,
        "run_id": positive_int(args.run, "run"),
        "run_head_sha": args.run_source,
        "run_repository_id": positive_int(args.repository_id, "repository-id"),
    }
    actual = {
        "id": row.get("id"),
        "name": row.get("name"),
        "size_in_bytes": row.get("size_in_bytes"),
        "digest": row.get("digest"),
        "expired": row.get("expired"),
        "run_id": run.get("id"),
        "run_head_sha": run.get("head_sha"),
        "run_repository_id": run.get("repository_id"),
    }
    for key, value in expected.items():
        if actual.get(key) != value:
            # Fixed field name only: never echo an arbitrary actual value.
            fail("metadata %s mismatch" % key)
    print("retained-desktop-artifact: metadata verified for artifact %s" % expected["id"])


def canonical_member(name):
    """Validate ONE exact canonical POSIX relative member path.

    Rejects empty/absolute/backslash/dot/empty-segment paths; returns the path
    unchanged so selection is by exact string equality only.
    """
    if not isinstance(name, str) or not name:
        fail("expected member path is empty")
    if name.startswith("/") or "\\" in name:
        fail("expected member path must be relative POSIX")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        fail("expected member path has an unsafe segment")
    return name


def extract(args):
    outer_size = positive_int(args.size, "size")
    outer_sha = clean_hex(args.sha256, "sha256")
    zip_member = canonical_member(args.zip_member)
    dmg_member = canonical_member(args.dmg_member)
    if os.path.basename(zip_member) == os.path.basename(dmg_member):
        fail("selected members must have distinct output basenames")
    wanted = [
        (zip_member, positive_int(args.zip_size, "zip-size"), clean_hex(args.zip_sha256, "zip-sha256")),
        (dmg_member, positive_int(args.dmg_size, "dmg-size"), clean_hex(args.dmg_sha256, "dmg-sha256")),
    ]
    actual_size, actual_sha = sha256_file(args.zip)
    if actual_size != outer_size:
        fail("outer size mismatch")
    if actual_sha != outer_sha:
        fail("outer sha256 mismatch")
    os.makedirs(args.outdir, mode=0o700, exist_ok=True)
    try:
        archive = zipfile.ZipFile(args.zip, "r")
    except (OSError, zipfile.BadZipFile) as error:
        fail("outer archive is not a readable zip: %s" % error.__class__.__name__)
    with archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            fail("duplicate member names are refused")
        selected = {}
        for name, size, sha in wanted:
            # EXACT registered path only: never a basename search or prefix guess.
            matches = [info for info in infos if info.filename == name]
            if len(matches) != 1:
                fail("expected exactly one registered member %s (found %d)" % (name, len(matches)))
            info = matches[0]
            mode = (info.external_attr >> 16) & 0o170000
            if mode != stat.S_IFREG:
                fail("%s is not a regular member" % name)
            if info.file_size != size:
                fail("%s declared size mismatch" % name)
            selected[name] = (info, size, sha)
        written = 0
        for name, (info, size, sha) in selected.items():
            # FLATTEN: write outdir/<basename>, never a nested subdirectory.
            target = os.path.join(args.outdir, os.path.basename(name))
            digest = hashlib.sha256()
            count = 0
            with archive.open(info, "r") as source, open(target, "xb") as destination:
                while True:
                    block = source.read(CHUNK)
                    if not block:
                        break
                    count += len(block)
                    if count > size:
                        fail("%s grew past its declared size" % name)
                    digest.update(block)
                    destination.write(block)
            if count != size:
                fail("%s truncated" % name)
            if digest.hexdigest() != sha:
                fail("%s sha256 mismatch" % name)
            written += 1
    if written != len(wanted):
        fail("not every required member was written")
    print("retained-desktop-artifact: extracted %d verified members" % written)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    meta = sub.add_parser("metadata")
    meta.add_argument("metadata")
    for flag in ("--id", "--name", "--sha256", "--size", "--run", "--run-source", "--repository-id"):
        meta.add_argument(flag, required=True)
    ext = sub.add_parser("extract")
    ext.add_argument("zip")
    ext.add_argument("outdir")
    for flag in ("--sha256", "--size", "--zip-member", "--zip-size", "--zip-sha256",
                 "--dmg-member", "--dmg-size", "--dmg-sha256"):
        ext.add_argument(flag, required=True)
    args = parser.parse_args()
    if args.mode == "metadata":
        metadata(args)
    else:
        extract(args)


if __name__ == "__main__":
    main()
