#!/usr/bin/env python3
"""Retain already-built desktop media from a trusted producer run.

Python 3.9 stdlib only. Trust is bound to immutable public facts:
producer workflow/branch/commit/attempt, the exact producer job and its ordered
steps (packaging -> payload verification -> media upload -> acceptance), and one
unique nonexpired artifact whose API id and digest are recorded.

The RAW archive is downloaded by artifact id to a file, its SHA-256 is verified
against the API digest, and only then is it safely inventoried and extracted
(exact member names, no traversal/backslash/symlink/duplicate). The producer run
may have failed LATER acceptance steps: upload happens before acceptance.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import zipfile

# Exactly TWO authoritative producer shapes are accepted, each with the event it
# can actually carry. Anything else stays fail-closed.
#   1. direct dispatch/call of release-desktop.yml -> unprefixed job name
#   2. release.yml calling it for a stable tag push -> caller-prefixed job name
PRODUCER_SHAPES = {
    ".github/workflows/release-desktop.yml": {
        "events": ("workflow_dispatch", "workflow_call"),
        "job": "Build macOS desktop release",
    },
    ".github/workflows/release.yml": {
        "events": ("push",),
        "job": "Release macOS desktop / Build macOS desktop release",
    },
}
PACKAGING_STEP = "Build DMG and ZIP"
PAYLOAD_STEP = "Verify packaged version and native runtime payload"
ACCEPTANCE_STEP = "Accept actual stable packaged desktop permissions and operations"
MAX_ARCHIVE = 2 * 1024 ** 3
MAX_MEMBER = 2 * 1024 ** 3
MAX_TOTAL = 4 * 1024 ** 3
CHUNK = 1024 * 1024


def fail(reason):
    # Fixed reason token only: never command output, URLs or credentials.
    print("retain-desktop-media: " + reason, file=sys.stderr)
    raise SystemExit(1)


def env(name, required=True):
    value = (os.environ.get(name) or "").strip()
    if required and not value:
        fail("missing_" + name.lower())
    return value


def gh_json(*args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except ValueError:
        return None


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


def download_archive(repository, artifact_id, target):
    """Stream the raw artifact archive to a file (never buffered in memory)."""
    with open(target, "wb") as sink:
        result = subprocess.run(
            ["gh", "api", "repos/%s/actions/artifacts/%s/zip" % (repository, artifact_id)],
            stdout=sink, stderr=subprocess.DEVNULL)
    if result.returncode != 0:
        fail("archive_download_failed")


def safe_members(archive, expected):
    """Inventory the archive BEFORE extraction; refuse anything unsafe."""
    infos = archive.infolist()
    if len(infos) > 32:
        fail("archive_member_count_too_large")
    names = [info.filename for info in infos]
    if len(names) != len(set(names)):
        fail("archive_duplicate_member")
    by_name = {}
    total = 0
    for info in infos:
        name = info.filename
        if not name or name.startswith("/") or "\\" in name:
            fail("archive_unsafe_member_path")
        parts = name.split("/")
        if any(part in ("", ".", "..") for part in parts):
            fail("archive_unsafe_member_path")
        mode = (info.external_attr >> 16) & 0o170000
        if mode not in (0, stat.S_IFREG):
            fail("archive_non_regular_member")
        if info.file_size > MAX_MEMBER:
            fail("archive_member_too_large")
        total += info.file_size
        if total > MAX_TOTAL:
            fail("archive_total_too_large")
        by_name[name] = info
    selected = {}
    for role, name in expected.items():
        info = by_name.get(name)
        if info is None:
            fail("archive_missing_" + role)
        selected[role] = info
    return selected


def extract_members(archive, selected, destination):
    os.makedirs(destination, mode=0o700, exist_ok=True)
    written = {}
    for role, info in selected.items():
        target = os.path.join(destination, os.path.basename(info.filename))
        digest = hashlib.sha256()
        count = 0
        with archive.open(info, "r") as source, open(target, "wb") as sink:
            while True:
                block = source.read(CHUNK)
                if not block:
                    break
                count += len(block)
                if count > info.file_size:
                    fail("archive_member_grew")
                digest.update(block)
                sink.write(block)
        if count != info.file_size:
            fail("archive_member_truncated")
        written[role] = {"name": os.path.basename(info.filename), "sizeBytes": count,
                         "sha256": digest.hexdigest()}
    return written


def parse_feed(text):
    """Parse electron-builder's latest-mac.yml into top-level fields + the files list.

    Real shape:
        version: 0.4.34
        files:
          - url: Xpod-0.4.34-arm64-mac.zip
            sha512: <base64>
            size: 812166962
          - url: Xpod-0.4.34-arm64.dmg
            sha512: <base64>
            size: 798309372
        path: Xpod-0.4.34-arm64-mac.zip
        sha512: <base64>
        releaseDate: '...'

    Indentation is significant: a flat reader would let the second DMG `size`
    overwrite the ZIP size. Entries are kept per-url instead.
    """
    top = {}
    files = []
    current = None
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indented = raw[0] in " \t"
        stripped = raw.strip()
        if indented and stripped.startswith("- "):
            current = {}
            files.append(current)
            stripped = stripped[2:].strip()
        if indented and current is not None:
            match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", stripped)
            if match:
                current[match.group(1)] = match.group(2).strip().strip('"').strip("'")
            continue
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", stripped)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip().strip('"').strip("'")
        if key == "files":
            current = None
            continue
        if value:
            top[key] = value
    return top, files


def stream_sha512_base64(path):
    """Hash a large file in a streaming fashion; never load it into memory."""
    digest = hashlib.sha512()
    size = 0
    with open(path, "rb") as stream:
        while True:
            block = stream.read(CHUNK)
            if not block:
                break
            size += len(block)
            digest.update(block)
    return size, base64.b64encode(digest.digest()).decode("ascii")


def main():
    repository = env("GITHUB_REPOSITORY")
    run_id = env("SOURCE_RUN_ID")
    tag = env("EXPECTED_TAG")
    sha = env("EXPECTED_SHA")
    version = env("EXPECTED_VERSION")
    destination = os.path.abspath(env("DESTINATION"))
    receipt_path = os.path.abspath(env("RECEIPT"))
    work = os.path.abspath(env("WORK_DIR"))

    if not run_id.isdigit():
        fail("source_run_id_not_numeric")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        fail("tag_not_stable")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        fail("sha_not_full_commit")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail("version_not_stable")

    run = gh_json("api", "repos/%s/actions/runs/%s" % (repository, run_id))
    if run is None:
        fail("producer_run_unreadable")
    shape = PRODUCER_SHAPES.get(str(run.get("path")))
    if shape is None:
        fail("producer_wrong_workflow")
    if run.get("head_branch") != tag:
        fail("producer_wrong_branch")
    if run.get("head_sha") != sha:
        fail("producer_wrong_sha")
    if run.get("status") != "completed":
        fail("producer_not_completed")
    # The event must be one this exact workflow shape can actually produce.
    if run.get("event") not in shape["events"]:
        fail("producer_wrong_origin")
    attempt = run.get("run_attempt")
    if not isinstance(attempt, int) or attempt < 1:
        fail("producer_attempt_unreadable")

    # Jobs for THIS exact attempt only; --slurp then flatten avoids multi-page
    # JSON being unparsable.
    jobs_raw = subprocess.run(
        ["gh", "api", "--paginate", "--slurp",
         "repos/%s/actions/runs/%s/attempts/%s/jobs?per_page=100"
         % (repository, run_id, attempt)], capture_output=True, text=True)
    if jobs_raw.returncode != 0:
        fail("producer_jobs_unreadable")
    try:
        pages = json.loads(jobs_raw.stdout)
    except ValueError:
        fail("producer_jobs_unparsable")
    if not isinstance(pages, list):
        fail("producer_jobs_unparsable")
    jobs = [job for page in pages for job in (page.get("jobs") or [])]
    producers = [job for job in jobs if job.get("name") == shape["job"]]
    if len(producers) != 1:
        fail("producer_job_not_unique")
    producer = producers[0]
    if not isinstance(producer.get("id"), int):
        fail("producer_job_id_missing")
    steps = producer.get("steps") or []
    indexed = {step.get("number"): step for step in steps if isinstance(step.get("number"), int)}
    by_name = {step.get("name"): step for step in steps}
    packaging = by_name.get(PACKAGING_STEP)
    payload = by_name.get(PAYLOAD_STEP)
    acceptance = by_name.get(ACCEPTANCE_STEP)
    if not packaging or packaging.get("conclusion") != "success":
        fail("producer_packaging_not_success")
    if not payload or payload.get("conclusion") != "success":
        fail("producer_payload_not_success")
    if not isinstance(packaging.get("number"), int) or not isinstance(payload.get("number"), int):
        fail("producer_step_number_missing")
    if packaging["number"] >= payload["number"]:
        fail("producer_step_order_invalid")
    if by_name.get(ACCEPTANCE_STEP) is None:
        fail("producer_acceptance_step_missing")

    # The media upload is the upload step DIRECTLY after the verified payload and
    # before acceptance - not any arbitrary "upload" (diagnostics uploads exist).
    upload = None
    for number in range(payload["number"] + 1, (acceptance or {}).get("number", 10 ** 6)):
        step = indexed.get(number)
        if step and "upload-artifact" in str(step.get("name", "")):
            upload = step
            break
    if upload is None:
        fail("producer_media_upload_not_found")
    if upload.get("conclusion") != "success":
        fail("producer_media_upload_not_success")

    artifacts = gh_json("api", "--paginate", "--slurp",
                        "repos/%s/actions/runs/%s/artifacts?per_page=100" % (repository, run_id))
    if artifacts is None:
        fail("producer_artifacts_unreadable")
    artifact_pages = artifacts if isinstance(artifacts, list) else [artifacts]
    rows = [row for page in artifact_pages for row in (page.get("artifacts") or [])]
    name = "xpod-desktop-macos-%s" % version
    matches = [row for row in rows if row.get("name") == name and not row.get("expired")]
    if len(matches) != 1:
        fail("artifact_not_unique_or_expired")
    artifact = matches[0]
    artifact_id = artifact.get("id")
    digest = str(artifact.get("digest") or "")
    if not isinstance(artifact_id, int) or artifact_id < 1:
        fail("artifact_id_invalid")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        fail("artifact_digest_invalid")
    size = artifact.get("size_in_bytes")
    if not isinstance(size, int) or size < 1 or size > MAX_ARCHIVE:
        fail("artifact_size_invalid")
    # Artifact creation must fall INSIDE the selected upload's own window: an
    # artifact created before that upload started cannot be its output, and one
    # created after it completed is a different lifecycle event.
    workflow_run = artifact.get("workflow_run")
    if isinstance(workflow_run, dict):
        if str(workflow_run.get("id")) != run_id:
            fail("artifact_workflow_run_mismatch")
        declared_sha = workflow_run.get("head_sha")
        if declared_sha and declared_sha != sha:
            fail("artifact_workflow_run_sha_mismatch")
    created = str(artifact.get("created_at") or "").strip()
    upload_started = str(upload.get("started_at") or "").strip()
    upload_completed = str(upload.get("completed_at") or "").strip()
    if not created or not upload_started or not upload_completed:
        fail("artifact_or_upload_timestamp_missing")
    if not (upload_started <= created <= upload_completed):
        fail("artifact_not_created_during_upload")

    expected_names = {
        "zip": "Xpod-%s-arm64-mac.zip" % version,
        "dmg": "Xpod-%s-arm64.dmg" % version,
        "feed": "latest-mac.yml",
        "zipBlockmap": "Xpod-%s-arm64-mac.zip.blockmap" % version,
        "dmgBlockmap": "Xpod-%s-arm64.dmg.blockmap" % version,
    }

    os.makedirs(work, mode=0o700, exist_ok=True)
    archive_path = os.path.join(work, "desktop-media-%s.zip" % artifact_id)
    download_archive(repository, artifact_id, archive_path)

    # P0-1: the RAW archive digest is verified against the API digest BEFORE any
    # extraction happens.
    archive_size, archive_sha = sha256_file(archive_path)
    if archive_size != size:
        fail("archive_size_mismatch")
    if "sha256:" + archive_sha != digest:
        fail("archive_digest_mismatch")

    try:
        archive = zipfile.ZipFile(archive_path, "r")
    except (OSError, zipfile.BadZipFile):
        fail("archive_unreadable")
    with archive:
        selected = safe_members(archive, expected_names)
        written = extract_members(archive, selected, destination)

    feed_path = os.path.join(destination, expected_names["feed"])
    with open(feed_path, "r", encoding="utf-8", errors="strict") as stream:
        top, entries = parse_feed(stream.read())
    if top.get("version") != version:
        fail("feed_version_mismatch")
    if top.get("path") != expected_names["zip"]:
        fail("feed_path_mismatch")
    by_url = {}
    for entry in entries:
        url = entry.get("url")
        if not url:
            fail("feed_entry_missing_url")
        if url in by_url:
            fail("feed_entry_duplicate_url")
        by_url[url] = entry
    # Every declared entry is validated against its OWN bytes: ZIP and DMG.
    for role, filename in (("zip", expected_names["zip"]), ("dmg", expected_names["dmg"])):
        entry = by_url.get(filename)
        if entry is None:
            fail("feed_missing_" + role + "_entry")
        declared_size = entry.get("size")
        declared_sha = entry.get("sha512")
        if not declared_size or not declared_sha:
            fail("feed_incomplete_" + role + "_entry")
        actual_size, actual_sha = stream_sha512_base64(os.path.join(destination, filename))
        if str(declared_size) != str(actual_size):
            fail("feed_" + role + "_size_mismatch")
        if declared_sha != actual_sha:
            fail("feed_" + role + "_sha512_mismatch")
        if actual_size != written[role]["sizeBytes"]:
            fail("feed_" + role + "_extracted_size_mismatch")
    if top.get("sha512") != by_url[expected_names["zip"]].get("sha512"):
        fail("feed_top_level_sha512_unbound")
    if set(by_url) != {expected_names["zip"], expected_names["dmg"]}:
        fail("feed_unexpected_entry")

    receipt = {
        "schema": "xpod-desktop-media-retention/1",
        "repository": repository,
        "sourceRunId": run_id,
        "sourceRunAttempt": attempt,
        "producerWorkflow": run.get("path"),
        "producerJob": producer.get("name"),
        "producerJobId": producer.get("id"),
        "producerEvent": run.get("event"),
        "producerSteps": {
            "packaging": {"number": packaging["number"], "name": packaging["name"], "conclusion": "success"},
            "payload": {"number": payload["number"], "name": payload["name"], "conclusion": "success"},
            "mediaUpload": {"number": upload["number"], "name": upload["name"], "conclusion": "success"},
        },
        "stableTag": tag,
        "sourceSha": sha,
        "version": version,
        "artifact": {"id": artifact_id, "name": artifact.get("name"), "sizeBytes": size, "apiDigest": digest},
        "archiveVerifiedBeforeExtraction": True,
        "archiveSha256": archive_sha,
        "media": {role: value for role, value in written.items()},
        "feed": {"version": top.get("version"), "path": top.get("path"),
                 "entries": sorted(by_url),
                 "zipSha512Verified": True, "dmgSha512Verified": True,
                 "topLevelSha512BindsZip": True},
        "retainedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "scope": "Media provenance only; acceptance runs separately on these exact bytes.",
    }
    # Guard against attempt drift: the run's attempt must still equal the one the
    # jobs and artifact were validated against.
    final_run = gh_json("api", "repos/%s/actions/runs/%s" % (repository, run_id))
    if final_run is None or final_run.get("run_attempt") != attempt:
        fail("producer_attempt_drifted")

    os.makedirs(os.path.dirname(receipt_path), mode=0o700, exist_ok=True)
    with open(receipt_path, "w", encoding="utf-8") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    os.chmod(receipt_path, 0o600)
    print("retain-desktop-media: retained verified media")


if __name__ == "__main__":
    main()
