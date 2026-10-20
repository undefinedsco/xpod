"""One compiler declaration/identity for SDK creation, reuse and focused builds."""
import hashlib
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

PROFILES = (
    dict(name='service-trixie', distribution='trixie', compiler_major=19, compiler_program='clang', linker_program='ld.lld-19', c='clang-19', cxx='clang++-19', c_key='clang', cxx_key='clangxx', linker='lld',
         dockerfile='docker/qlever-runtime-sdk/Dockerfile', runtime_dockerfile='docker/qlever-local-runtime/Dockerfile', repository_suffix=''),
    dict(name='module-bookworm-gcc12', distribution='bookworm', compiler_major=12, compiler_program='cc1plus', linker_program='ld.bfd', c='gcc-12', cxx='g++-12', c_key='gcc', cxx_key='gxx', linker='bfd',
         dockerfile='docker/qlever-runtime-sdk/Dockerfile.module-bookworm', runtime_dockerfile='docker/qlever-local-runtime/Dockerfile.module-bookworm', repository_suffix='-module-bookworm'),
)


def declared_profile(name):
    """Only the existing canonical compiler/profile table selects a recipe."""
    for row in PROFILES:
        if row['name']==name:return dict(row)
    raise RuntimeError('Unsupported SDK profile')


def sdk_profile(name):
    for row in PROFILES:
        if row['name'] == name:
            result = dict(row)
            root = Path(__file__).resolve().parents[2]
            result['identity'] = hashlib.sha256((root / row['dockerfile']).read_bytes() + (root / row['runtime_dockerfile']).read_bytes() + Path(__file__).read_bytes()).hexdigest()
            return result
    raise RuntimeError('Unsupported SDK profile')


def compiler_spec():
    c = os.environ.get('XPOD_QLEVER_CMAKE_C_COMPILER', 'clang-19')
    cxx = os.environ.get('XPOD_QLEVER_CMAKE_CXX_COMPILER', 'clang++-19')
    for row in PROFILES:
        if row['c'] == c and row['cxx'] == cxx:
            return dict(c=c, cxx=cxx, profile=row['name'], c_key=row['c_key'], cxx_key=row['cxx_key'], linker=row['linker'], linker_program=row['linker_program'])
    raise RuntimeError('Unsupported declared QLever compiler pair; no fallback')


def compiler_versions():
    spec = compiler_spec()
    def version(command):
        return subprocess.check_output([command, '--version'], text=True).splitlines()[0]
    result = {spec['c_key']: version(spec['c']), spec['cxx_key']: version(spec['cxx']), 'cmake': version('cmake')}
    # Preserve the existing service SDK contract byte-for-byte. Module SDKs
    # cannot compare equal to it or bootstrap an unprofiled Trixie SDK.
    if spec['profile'] != 'service-trixie':
        metadata = Path('/opt/qlever-sdk/profile/inputs.json')
        result.update(profile=spec['profile'], machine=platform.machine(), profileInputs=json.loads(metadata.read_text()),
                      linkerVersion=version('ld.' + spec['linker']),
                      linkerSha256=hashlib.sha256(Path(shutil.which('ld.' + spec['linker'])).read_bytes()).hexdigest(),
                      compilerFiles={key: hashlib.sha256(Path(shutil.which(spec[key])).read_bytes()).hexdigest() for key in ['c', 'cxx']})
    return result


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == 'sdk-profile':
        print(json.dumps(sdk_profile(sys.argv[2]), sort_keys=True))
    elif sys.argv[1:] in [['c'], ['cxx'], ['linker'], ['profile'], ['linker_program']]:
        print(compiler_spec()[sys.argv[1]])
    else:
        raise RuntimeError('Expected compiler role or declared SDK profile')
