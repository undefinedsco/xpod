"""Fixed controller-only ZIP reader. Never executes ZIP members or gpgv."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys
import time
import zipfile

spec = importlib.util.spec_from_file_location('index_mechanics', Path(__file__).with_name('sdk-debian-index-bindings.py'))
mechanics = importlib.util.module_from_spec(spec); spec.loader.exec_module(mechanics)
LIMITS = mechanics.LIMITS
spec_zip = importlib.util.spec_from_file_location('sdk_zip', Path(__file__).with_name('sdk-zip-originals.py'))
sdk_zip = importlib.util.module_from_spec(spec_zip); spec_zip.loader.exec_module(sdk_zip)



def observe(archive_path, plan):
    need = mechanics.need
    remaining = plan['remainingMilliseconds']
    need(isinstance(remaining, (int, float)) and 0 < remaining <= LIMITS['timeoutMs'], 'fixed remaining observation window required')
    deadline = time.monotonic() + remaining / 1000
    def check():
        need(time.monotonic() < deadline, 'SDK index observation deadline')
    with sdk_zip.registered_zip_originals(archive_path, 'inner/debian-source/indexes/', check) as member:
        release = plan['inRelease']
        need(release['bytes'] <= LIMITS['metadataBytes'], 'small InRelease original required')
        with member(release) as original:
            data = original.read(LIMITS['metadataBytes'] + 1)
            need(len(data) == release['bytes'] and hashlib.sha256(data).hexdigest() == release['sha256'], 'actual InRelease original bytes differ')
        source = plan['sources']; actual = hashlib.sha256(); count = 0
        with member(source) as original:
            def chunks():
                nonlocal count
                while True:
                    check(); block = original.read(LIMITS['rangeBytes'])
                    if not block: break
                    count += len(block); need(count <= source['bytes'], 'Sources original growth'); actual.update(block); yield block
            result = mechanics.verify_sources_checksum_link(data, chunks(), plan['packages'], check_budget=check, require_all_packages=False)
        need(count == source['bytes'] and actual.hexdigest() == source['sha256'], 'actual registered Sources original bytes differ')
    return result


if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit('Fixed SDK ZIP path required')
    raw = sys.stdin.buffer.read(LIMITS['metadataBytes'] + 1)
    mechanics.need(len(raw) <= LIMITS['metadataBytes'], 'bounded controller index plan required')
    print(json.dumps(observe(sys.argv[1], json.loads(raw)), separators=(',', ':')))
