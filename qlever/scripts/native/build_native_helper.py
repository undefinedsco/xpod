"""Build the observer's own native lease sweep with a REAL compiler child.

ROOT-fix 3: this records RETAINED HEADER ORIGINALS, not a bare path list. Every
header actually opened by the compiler (from -H) is copied into
<out>/header-originals/ and recorded with its own sha256 and byte length, so the
consumer can verify each original rather than trusting a name.

The trust anchor is the immutable prepared SDK image plus this component's
read-only source context: the compiler is the image's own clang-19/gcc-12, and
the source is the file copied from the component tree. The receipt merely
RECORDS what that real child did; nothing is asserted from a caller dictionary.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import sysconfig
import time


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def run(argv, cwd, stdout_path, stderr_path):
    started = time.time()
    with open(stdout_path, 'wb') as out, open(stderr_path, 'wb') as err:
        process = subprocess.run(argv, cwd=cwd, stdout=out, stderr=err,
                                 stdin=subprocess.DEVNULL)
    return {'argv': argv, 'exit': process.returncode,
            'elapsedSeconds': time.time() - started}


def parse_dash_h(path):
    """clang/gcc -H: one line per opened header, dots + SPACE + absolute path."""
    headers = []
    seen = set()
    with open(path, 'r', errors='replace') as handle:
        for line in handle:
            dots, separator, remainder = line.rstrip('\n').partition(' ')
            if separator and dots and set(dots) == {'.'} and remainder.startswith('/'):
                if remainder not in seen:
                    seen.add(remainder)
                    headers.append(remainder)
    return headers


def retain_headers(headers, out_dir):
    """Copy each real header into the output tree and hash the RETAINED copy.

    The retained bytes are what the consumer verifies, so we hash the copy, not
    the original path. That makes a later change at the original path unable to
    silently alter the retained evidence.
    """
    root = os.path.join(out_dir, 'header-originals')
    os.makedirs(root, exist_ok=True)
    rows = []
    for index, path in enumerate(headers):
        base = os.path.basename(path)
        target = os.path.join(root, '%03d-%s' % (index, base))
        shutil.copyfile(path, target)
        # Record a RELATIVE path inside the helper tree: the absolute build
        # directory is not stable across a copied fixture or an image layer, and
        # an absolute path would make provenance verification location-bound.
        rows.append({'relativePath': os.path.relpath(target, out_dir),
                     'originPath': path,
                     'sha256': sha256_file(target), 'bytes': os.path.getsize(target)})
    return rows


def main():
    if len(sys.argv) < 3:
        raise SystemExit('usage: build_native_helper.py <source.c> <output-dir> [--cc CC]')
    source = os.path.abspath(sys.argv[1])
    out_dir = os.path.abspath(sys.argv[2])
    cc = sys.argv[sys.argv.index('--cc') + 1] if '--cc' in sys.argv else 'clang-19'
    os.makedirs(out_dir, exist_ok=True)

    include = sysconfig.get_paths()['include']
    suffix = sysconfig.get_config_var('EXT_SUFFIX')
    if not suffix or not os.path.isfile(os.path.join(include, 'Python.h')):
        raise SystemExit('matching Python headers unavailable in this tool layer')

    target = os.path.join(out_dir, 'lease_sweep_ext' + suffix)
    compiler = run([cc, '--version'], out_dir,
                   os.path.join(out_dir, 'compiler.stdout'),
                   os.path.join(out_dir, 'compiler.stderr'))
    if compiler['exit'] != 0:
        raise SystemExit('compiler identity probe failed: %d' % compiler['exit'])

    argv = [cc, '-O2', '-fPIC', '-shared', '-Wall', '-Wextra', '-Werror', '-std=c11',
            '-H', '-I' + include, '-o', target, source]
    build = run(argv, out_dir, os.path.join(out_dir, 'build.stdout'),
                os.path.join(out_dir, 'build.stderr'))
    if build['exit'] != 0:
        with open(os.path.join(out_dir, 'build.stderr'), 'rb') as handle:
            sys.stderr.write(handle.read().decode('utf-8', 'replace'))
        raise SystemExit('native helper compile failed with exit %d' % build['exit'])
    if not os.path.isfile(target):
        raise SystemExit('compile reported success but produced no artifact')

    headers = parse_dash_h(os.path.join(out_dir, 'build.stderr'))
    originals = retain_headers(headers, out_dir)

    with open(os.path.join(out_dir, 'compiler.stdout'), 'r', errors='replace') as handle:
        compiler_version = handle.readline().strip()

    receipt = {
        'schemaVersion': 1,
        'kind': 'sdk-native-lease-helper-build-originals',
        'source': {'path': source, 'sha256': sha256_file(source),
                   'bytes': os.path.getsize(source)},
        'output': {'path': target, 'sha256': sha256_file(target),
                   'bytes': os.path.getsize(target)},
        'compiler': {'command': compiler['argv'], 'exit': compiler['exit'],
                     'version': compiler_version,
                     'elapsedSeconds': compiler['elapsedSeconds']},
        'build': {'command': build['argv'], 'exit': build['exit'],
                  'elapsedSeconds': build['elapsedSeconds']},
        'interpreter': {'version': sys.version, 'include': include, 'extSuffix': suffix},
        'headerOriginals': originals,
        'headerOriginalCount': len(originals),
        'verification': ('real compiler child exit status; retained header '
                         'originals hashed from their copied bytes; produced ELF re-hashed'),
    }
    with open(os.path.join(out_dir, 'build.receipt.json'), 'w') as handle:
        json.dump(receipt, handle, indent=1)
    print(json.dumps({'output': receipt['output'], 'build': receipt['build'],
                      'interpreter': receipt['interpreter'],
                      'headerOriginalCount': receipt['headerOriginalCount']}, indent=1))


if __name__ == '__main__':
    main()
