"""Use the one canonical AgentFS Linux ABI policy on registered ZIP originals.

The product binary is already whole-SHA-bound by the central private reader;
only its ELF header is passed here. No candidate/native program is executed.
"""
import importlib.util
import json
from pathlib import Path
import sys
import zipfile


def verify(archive_path, target, header, binary_sha):
    if target not in ('linux-arm64', 'linux-x64') or len(header) != 64 or len(binary_sha) != 64:
        raise ValueError('Bound AgentFS Linux target/header/hash required')
    script = Path(__file__).resolve().parents[2] / 'agentfs-native-ci/accept.py'
    sys.path.insert(0, str(script.parent))
    spec = importlib.util.spec_from_file_location('canonical_native_abi', script)
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    arch = target.split('-')[1]
    policy.assert_binary_arch(header, 'linux', arch)
    with zipfile.ZipFile(archive_path) as archive:
        entries = {entry.filename: entry for entry in archive.infolist()}
        total = 0
        def read(name):
            nonlocal total
            entry = entries.get(name)
            if entry is None or entry.is_dir() or entry.file_size > 1024**2:
                raise ValueError('Registered bounded runtime original missing')
            total += entry.file_size
            if total > 16 * 1024**2:
                raise ValueError('Canonical runtime original budget')
            return archive.read(entry)
        final = json.loads(read('final.json'))
        if final.get('target') != target or final.get('nativeReceipt', {}).get('helperSha256') != binary_sha:
            raise ValueError('Canonical runtime actual product binary mismatch')
        runtime = policy.verify_linux_runtime_materials(read, final, arch)
        if final.get('sdkBefore') != final.get('sdkAfter'):
            raise ValueError('Actual SDK before/after mismatch')
        helper = read('runtime-helper-version.raw.log').decode().strip()
        launcher = read('runtime-launcher-version.raw.log').decode().strip()
        if not helper.startswith('agentfs-pod ') or runtime.get('helperVersion') != helper or runtime.get('launcherVersion') != launcher:
            raise ValueError('Actual canonical version probes mismatch')
    return dict(schemaVersion=1, status='mechanical-agentfs-linux-runtime-verified', target=target,
                binarySha256=binary_sha, scope='registered canonical Linux runtime originals; no source/SDK/origin admission')


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise ValueError('Native ZIP, target, bound ELF64 header hex and actual binary SHA required')
    print(json.dumps(verify(sys.argv[1], sys.argv[2], bytes.fromhex(sys.argv[3]), sys.argv[4]), sort_keys=True))
