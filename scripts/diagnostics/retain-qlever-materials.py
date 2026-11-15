"""Retain the ORIGINAL QLever artifact and its true source identity.

This is the SAME authoritative acquisition contract the diagnostic route uses:
the verified Actions artifact metadata is the identity authority, the downloaded
bytes must hash to the API digest, and the untouched original ZIP is preserved.
Only the members the CSS capability producer needs are extracted; nothing is
re-tarred, re-identified, or spoofed.
"""
import hashlib
import json
import os
import runpy
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXTRACT = os.path.join(REPO, 'scripts', 'diagnostics', 'extract-qlever-artifact.py')


def fail(message: str) -> 'NoReturn':  # type: ignore[name-defined]
    print(f'QLever materials rejected: {message}', file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    artifact_id = os.environ.get('QLEVER_ARTIFACT_ID', '').strip()
    digest = os.environ.get('QLEVER_ARTIFACT_DIGEST', '').strip()
    source = os.environ.get('QLEVER_SOURCE_SHA', '').strip()
    repository = os.environ.get('GITHUB_REPOSITORY', '').strip()
    runner_temp = os.environ.get('RUNNER_TEMP', '').strip()
    source_run = os.environ.get('QLEVER_ARTIFACT_SOURCE_RUN_ID', '').strip()
    if not source:
        fail('verified artifact source is required')
    if not repository or not runner_temp:
        fail('repository and runner temp are required')
    if len(source) != 40 or any(c not in '0123456789abcdef' for c in source):
        fail('source identity is not a full commit sha')

    materials = os.path.join(REPO, '.test-data', 'qlever-runtime')
    os.makedirs(materials, exist_ok=True)
    metadata_path = os.path.join(runner_temp, 'qlever-artifact.json')
    zip_path = os.path.join(runner_temp, 'qlever-artifact.zip')

    if not artifact_id:
        # Stable uses the already accepted candidate run, never a latest-run
        # search. Retain the original list used to select its unique artifact.
        if not source_run.isdigit() or int(source_run) < 1:
            fail('exact accepted artifact run is required')
        candidates_path = os.path.join(runner_temp, 'accepted-qlever-artifacts.json')
        with open(candidates_path, 'wb') as handle:
            subprocess.run(['gh', 'api', '--paginate', '--slurp',
                            f'repos/{repository}/actions/runs/{source_run}/artifacts?per_page=100'],
                           stdout=handle, check=True)
        with open(candidates_path) as handle:
            pages = json.load(handle)
        candidates = [artifact for page in pages for artifact in page.get('artifacts', [])
                      if artifact.get('name') == f'qlever-local-runtime-darwin-arm64-{source}'
                      and artifact.get('expired') is False]
        if len(candidates) != 1:
            fail('accepted run does not contain one exact native artifact')
        artifact_id = str(candidates[0].get('id'))
        digest = str(candidates[0].get('digest', ''))
    if not artifact_id.isdigit() or int(artifact_id) < 1 or not digest:
        fail('verified artifact id and digest are required')
    with open(metadata_path, 'wb') as handle:
        subprocess.run(['gh', 'api', f'repos/{repository}/actions/artifacts/{artifact_id}'],
                       stdout=handle, check=True)
    # Bind the transport metadata to the producer's exact artifact coordinates
    # before retaining any authority record. Diagnostic pinning remains separate.
    expected = digest.removeprefix('sha256:')
    with open(metadata_path) as handle:
        metadata = json.load(handle)
    validate = runpy.run_path(EXTRACT)['metadata_authority']
    validate(metadata, expected, artifact_id, source)
    if source_run and str((metadata.get('workflow_run') or {}).get('id')) != source_run:
        fail('artifact differs from accepted candidate run')
    with open(zip_path, 'wb') as handle:
        subprocess.run(['gh', 'api', f'repos/{repository}/actions/artifacts/{artifact_id}/zip'],
                       stdout=handle, check=True)
    downloaded = hashlib.sha256()
    with open(zip_path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            downloaded.update(chunk)
    if downloaded.hexdigest() != expected:
        fail('retained artifact digest differs from the verified API digest')

    # Same extractor as the diagnostic route: preserves the original ZIP and
    # yields the original tar, raw acceptance and runtime manifest.
    subprocess.run([sys.executable, EXTRACT, zip_path, materials, expected, metadata_path, artifact_id], check=True)
    for required in ('qlever-local-runtime-darwin-arm64.tar.gz', 'qlever-local-acceptance.json',
                     os.path.join('runtime', 'manifest.json'), 'qlever-native-artifact.zip'):
        if not os.path.isfile(os.path.join(materials, required)):
            fail(f'required original material is missing: {required}')
    print('QLever original materials retained')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
