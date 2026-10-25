"""The ONE validated producer/consumer record for the derived link command.

Why a separate module: the producer (`link_command_adapter`) and the consumer
(`sdk-inner-materials`) MUST agree on the record schema. Previously the producer
wrote `origin/rawLine/linkLine/argv/...` while the consumer read
`linkTxt.sha256` and `stdout.path/sha256` — keys the producer never wrote, so a
real Ninja build could never pass. One module, one schema, one validator.

Authority model
---------------
The record is NOT authority by itself. It is accepted only when:
  * the actual generator (read from the CMake File API reply) is `Ninja`;
  * the referenced raw stdout/stderr originals exist inside the build scope,
    are regular non-symlink files, and their digest AND six-field identity match
    what the record claims;
  * the `link.txt` digest matches the file on disk;
  * the record's `linkLine` is exactly the file's single line.

Every path is resolved and re-verified here, so a forged record cannot point
outside the build scope or claim digests it does not have.
"""
import hashlib
import importlib.util
import json
import os

SCHEMA_VERSION = 1
ORIGIN_NAME = 'origin.json'


class OriginInvalid(RuntimeError):
    """The derived link-command record is missing, malformed or does not match."""


def _identity(handle):
    value = os.fstat(handle.fileno())
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


def _load_sibling(name, filename):
    """Load a sibling SDK module by path, so no caller sys.path is assumed."""
    here = os.path.dirname(os.path.abspath(__file__))
    for directory in (here, os.path.join(here, 'siblings')):
        candidate = os.path.join(directory, filename)
        if os.path.isfile(candidate):
            break
    else:
        raise ImportError('SDK sibling module missing: ' + filename)
    spec = importlib.util.spec_from_file_location(name, candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reader = _load_sibling('link_origin_bounded_reader', 'bounded-original-reader.py')


def bounded_original_bytes(path, limit, error):
    """Read one regular original under `limit` via the shared bounded reader.

    Kept as a thin module-local name so callers keep their signature; the algorithm
    itself lives once in `bounded-original-reader.py`.
    """
    return reader.read_bounded_original(
        path, limit, error,
        messages={'symlink': 'original must be a regular non-symlink file: %s',
                  'regular': 'original must be a regular non-symlink file: %s',
                  'over': 'original exceeds the member bound: %s',
                  'grew': 'original grew past the member bound: %s',
                  'short': 'original changed while read: %s',
                  'changed': 'original changed while read: %s'})


def bounded_file_identity(path, limit):
    """Six-field identity + digest of one regular original under `limit` bytes."""
    path = os.path.abspath(path)
    if os.path.islink(path) or not os.path.isfile(path):
        raise OriginInvalid('original must be a regular non-symlink file: ' + path)
    with open(path, 'rb') as handle:
        before = _identity(handle)
        if before[3] > limit:
            raise OriginInvalid('original exceeds the member bound: ' + path)
        digest = hashlib.sha256()
        observed = 0
        while True:
            block = handle.read(min(65536, limit + 1 - observed))
            if not block:
                break
            observed += len(block)
            if observed > limit:
                raise OriginInvalid('original grew past the member bound: ' + path)
            digest.update(block)
        after = _identity(handle)
    if before != after or observed != before[3]:
        raise OriginInvalid('original changed while read: ' + path)
    return dict(path=path, bytes=observed, sha256=digest.hexdigest(),
                mode=after[2] & 0o7777)


def _contained(root, candidate):
    root = os.path.realpath(root)
    candidate = os.path.realpath(candidate)
    return candidate == root or candidate.startswith(root + os.sep)


def record_path(link_txt):
    return os.path.join(os.path.dirname(os.path.abspath(link_txt)), ORIGIN_NAME)


def write_record(link_txt, *, generator, argv, raw, link_line, member_limit, build_root):
    """Producer side: write and immediately self-validate the record."""
    if generator != 'Ninja':
        raise OriginInvalid('only a Ninja derivation writes this record')
    if not isinstance(argv, list) or not argv:
        raise OriginInvalid('the introspection argv must be recorded')
    link_identity = bounded_file_identity(link_txt, member_limit)
    record = dict(
        schemaVersion=SCHEMA_VERSION,
        origin='ninja-tool-introspection',
        generator=generator,
        argv=list(argv),
        rawStdout=bounded_file_identity(raw['stdout'], member_limit),
        rawStderr=bounded_file_identity(raw['stderr'], member_limit),
        linkTxt=link_identity,
        linkLine=link_line,
        scope=('PLANNED command derived from the generator tool output; this is '
               'NOT evidence of the executed link argv and must be compared with '
               'the real SDK build trace before qualification'),
    )
    path = record_path(link_txt)
    # Re-derivation replaces OUR OWN record; the caller has already proven it is
    # ours via read_record() before reaching this point.
    with open(path, 'w') as handle:
        json.dump(record, handle, sort_keys=True, indent=2)
        handle.write('\n')
    # producer must satisfy its own consumer contract
    materials_root = os.path.dirname(os.path.abspath(record['rawStdout']['path']))
    return read_record(link_txt, member_limit=member_limit,
                       build_root=build_root, materials_root=materials_root)


def read_record(link_txt, *, member_limit, build_root, generator=None, materials_root=None):
    """Consumer side: validate and return the record, or raise."""
    if generator is not None and generator != 'Ninja':
        raise OriginInvalid('a %r build must not carry a derived origin' % generator)
    path = record_path(link_txt)
    if os.path.islink(path) or not os.path.isfile(path):
        raise OriginInvalid('derived link-command origin is required but missing: ' + path)
    # Originals may legitimately live in the SDK materials tree as well as the
    # build tree; both are declared scopes, and both are checked by realpath.
    allowed = [build_root] + ([materials_root] if materials_root else [])
    if not _contained(build_root, path):
        raise OriginInvalid('derived origin escapes the build root')
    raw = bounded_original_bytes(path, MEMBER_LIMIT_FOR_RECORD, OriginInvalid)
    record = json.loads(raw.decode('utf-8'))
    if not isinstance(record, dict) or record.get('schemaVersion') != SCHEMA_VERSION:
        raise OriginInvalid('derived origin schema unsupported')
    if record.get('origin') != 'ninja-tool-introspection':
        raise OriginInvalid('derived origin marker unsupported')
    if record.get('generator') != 'Ninja':
        raise OriginInvalid('derived origin generator differs')
    if not isinstance(record.get('argv'), list) or not record['argv']:
        raise OriginInvalid('derived origin argv missing')
    # Re-observe every referenced original; never trust the recorded digests.
    for key in ('rawStdout', 'rawStderr', 'linkTxt'):
        claimed = record.get(key)
        if not isinstance(claimed, dict) or not isinstance(claimed.get('path'), str):
            raise OriginInvalid('derived origin is missing %s' % key)
        actual_path = claimed['path']
        if not any(_contained(root, actual_path) for root in allowed):
            raise OriginInvalid('%s escapes the declared scopes' % key)
        observed = bounded_file_identity(actual_path, member_limit)
        if observed['sha256'] != claimed.get('sha256') or observed['bytes'] != claimed.get('bytes'):
            raise OriginInvalid('%s no longer matches the derived origin' % key)
    link_line = open(link_txt, 'r').read().strip()
    if record.get('linkLine') != link_line:
        raise OriginInvalid('derived origin line does not match link.txt')
    return record


MEMBER_LIMIT_FOR_RECORD = 4 * 1024 ** 2      # existing SDK metadata member bound
