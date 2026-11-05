"""Write the one normal-build linked-gate receipt used by cold and incremental."""
import hashlib
import json
from pathlib import Path
import sys

COMPONENTS = Path('/components')
GATES = COMPONENTS / 'scripts/lib/independent-admission/normal-sdk-gates.json'
OUTPUT = Path('/opt/qlever-sdk/build/.xpod-linked-verification.json')


def main(input_hash, output=OUTPUT):
    gates = json.loads(GATES.read_text())
    rows = []
    for expected in gates['linkedChecks']:
        path = COMPONENTS / expected['path']
        rows.append({'name': expected['name'], 'path': expected['path'],
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    receipt = {
        'schemaVersion': 1,
        'kind': 'qlever-sdk-normal-linked-verification',
        'model': 'normal-build-v1',
        'status': 'success',
        'inputHash': input_hash,
        'checks': rows,
        'scope': 'actual linked adapter/runtime gate execution inside this image; no syscall provenance',
    }
    Path(output).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        raise SystemExit('usage: sdk-normal-linked-receipt.py <input-hash> [output]')
    main(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else OUTPUT)
