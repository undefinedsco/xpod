"""Generator-independent CMake configure metadata via the official File API.

Replaces the Unix-Makefiles-only `CMAKE_MAKEFILE_DEPENDS` read in
`sdk-inner-materials.configure_inputs()` and the Makefiles-shaped metadata walk
in `sdk-generation-materials.metadata_paths()`.

Official contract (cmake-file-api(7), consulted directly):

* queries live at `<build>/.cmake/api/v1/query/client-<client>/<kind>-v<major>`
  and MUST exist BEFORE CMake generates the build system;
* `<build>/.cmake/api/v1/reply/index-*.json` is CMake-owned; clients MUST read
  the index first and reach other replies only through its `jsonFile`
  references. The current index is the lexicographically greatest name;
* `cmakeFiles` v1 `inputs[].path`: "If the file is inside the top-level source
  directory then the path is specified relative to that directory. Otherwise the
  path is absolute."

Resolution is therefore purely by the PATH FORM: every relative path is resolved
against the top-level SOURCE root, every absolute path is used as-is.
`isGenerated` / `isExternal` / `isCMake` are INFORMATIONAL ONLY (they describe
where a file lives for an out-of-source build) and MUST NOT redirect resolution —
in particular `isGenerated` does not make a relative path build-relative.
There is no "try source, then build" fallback; a relative path that is missing
under the source root is a hard refusal.

Nothing here is fabricated: every path returned came from CMake's own reply, and
the reply originals are returned so the caller can retain their exact bytes.
"""
import json
import os

CLIENT = 'xpod-sdk-producer'
API_VERSION = 'v1'
QUERIES = (('cmakeFiles', 1), ('codemodel', 2))

# Bounds mirroring the existing SDK metadata limits (sdk-generation-materials
# METADATA = 4 MiB per member; the count bound there is 10000).
MEMBER_LIMIT = 4 * 1024 ** 2
MEMBER_COUNT_LIMIT = 10000


class FileApiUnavailable(RuntimeError):
    """CMake did not emit the required reply, or it was unsafe. Never degrades."""


def query_dir(build):
    return os.path.join(build, '.cmake', 'api', API_VERSION, 'query', 'client-' + CLIENT)


def reply_dir(build):
    return os.path.join(build, '.cmake', 'api', API_VERSION, 'reply')


def write_queries(build):
    """Create the empty stateless query files. MUST run before configure.

    Separated from all reading so that reads can never create a query after the
    fact (which would make a missing reply look present on a later run).
    """
    directory = query_dir(build)
    os.makedirs(directory, exist_ok=True)
    written = []
    for kind, major in QUERIES:
        path = os.path.join(directory, '%s-v%d' % (kind, major))
        with open(path, 'wb') as handle:
            handle.write(b'')            # stateless query == empty file
        written.append(path)
    return written


def _identity(handle):
    """The same six-field identity the SDK's file_identity() compares."""
    value = os.fstat(handle.fileno())
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


def _bounded_read(path):
    """Read one CMake-owned original under the SDK metadata bound.

    The read is bounded BEFORE allocation (`read(MEMBER_LIMIT + 1)`), so a file
    that grows after the size check cannot drive an unbounded allocation, and
    the identity is compared before and after exactly as the SDK's existing
    `file_identity()` reader does. This does not weaken SOURCE evidence: it
    refuses rather than truncating.
    """
    if os.path.islink(path):
        raise FileApiUnavailable('File API original must not be a symlink: ' + path)
    if not os.path.isfile(path):
        raise FileApiUnavailable('File API original must be a regular file: ' + path)
    with open(path, 'rb') as handle:
        before = _identity(handle)
        if before[3] > MEMBER_LIMIT:
            raise FileApiUnavailable('File API original exceeds the metadata member bound: ' + path)
        raw = handle.read(MEMBER_LIMIT + 1)
        after = _identity(handle)
    if len(raw) > MEMBER_LIMIT:
        raise FileApiUnavailable('File API original grew past the metadata member bound: ' + path)
    if before != after:
        raise FileApiUnavailable('File API original changed while read: ' + path)
    if len(raw) != before[3]:
        raise FileApiUnavailable('File API original changed while read: ' + path)
    return raw


def _contained(root, candidate):
    """True only if `candidate` is inside `root` after canonicalization."""
    root = os.path.realpath(root)
    candidate = os.path.realpath(candidate)
    return candidate == root or candidate.startswith(root + os.sep)


def _resolve_reference(build, index_path, relative):
    """Resolve an index `jsonFile` reference, refusing any escape."""
    if not isinstance(relative, str) or not relative:
        raise FileApiUnavailable('File API reference must be a non-empty string')
    if os.path.isabs(relative):
        raise FileApiUnavailable('File API reference must be relative: ' + relative)
    if '\x00' in relative or '\\' in relative:
        raise FileApiUnavailable('File API reference contains an unsafe character')
    base = os.path.dirname(index_path)
    candidate = os.path.join(base, relative)
    if not _contained(base, candidate):
        raise FileApiUnavailable('File API reference escapes the reply directory: ' + relative)
    return candidate


def _index_path(build):
    directory = reply_dir(build)
    try:
        names = [name for name in os.listdir(directory)
                 if name.startswith('index-') and name.endswith('.json')]
    except FileNotFoundError:
        raise FileApiUnavailable('CMake File API reply directory absent: ' + directory)
    if not names:
        raise FileApiUnavailable('CMake File API wrote no index; configure did not run '
                                 'with the query files in place')
    return os.path.join(directory, sorted(names)[-1])


def _unique_object(index, kind, major):
    """Exactly ONE object of this kind/major. A duplicate is a refusal."""
    matches = [entry for entry in index.get('objects') or []
               if isinstance(entry, dict)
               and entry.get('kind') == kind
               and isinstance(entry.get('version'), dict)
               and entry['version'].get('major') == major]
    if not matches:
        raise FileApiUnavailable('CMake File API did not return %s-v%d '
                                 '(query missing before configure?)' % (kind, major))
    if len(matches) != 1:
        raise FileApiUnavailable('CMake File API returned %d %s-v%d objects; exactly '
                                 'one is required' % (len(matches), kind, major))
    return matches[0]


def read_index(build):
    path = _index_path(build)
    raw = _bounded_read(path)
    index = json.loads(raw.decode('utf-8'))
    if not isinstance(index, dict) or not isinstance(index.get('objects'), list):
        raise FileApiUnavailable('malformed CMake File API index')
    return path, raw, index


def read_object(build, index, index_path, kind, major):
    entry = _unique_object(index, kind, major)
    path = _resolve_reference(build, index_path, entry.get('jsonFile'))
    raw = _bounded_read(path)
    value = json.loads(raw.decode('utf-8'))
    if not isinstance(value, dict) or value.get('kind') != kind:
        raise FileApiUnavailable('CMake File API reply kind mismatch for ' + kind)
    if not isinstance(value.get('version'), dict) or value['version'].get('major') != major:
        raise FileApiUnavailable('CMake File API reply version mismatch for ' + kind)
    return path, raw, value


def _resolve_input(root_source, row):
    """Resolve ONE `cmakeFiles.inputs[]` entry by the OFFICIAL v1 rule.

    Installed cmake-file-api(7) (CMake 3.31.6), lines 1523-1527:

        If the file is inside the top-level source directory then the path is
        specified relative to that directory. Otherwise the path is absolute.

    `isGenerated` (lines 1529-1532) is INFORMATIONAL ONLY: it marks that the
    path is under the top-level build directory for an out-of-source build. It
    does NOT change how a relative path is interpreted, and it is unavailable on
    in-source builds.

    Therefore: relative => ALWAYS the top-level SOURCE root; otherwise the path
    is already absolute. There is no "try source, else build" fallback and no
    `isGenerated`-driven build-relative guess.
    """
    if not isinstance(row, dict) or not isinstance(row.get('path'), str):
        raise FileApiUnavailable('cmakeFiles input needs a string path')
    name = row['path']
    if not name or '\x00' in name:
        raise FileApiUnavailable('cmakeFiles input path is empty or unsafe')
    if os.path.isabs(name):
        candidate = os.path.abspath(name)
        # An absolute input is outside the source tree by contract; it must still
        # be a real regular file, and we do not pretend to know its root.
        if not os.path.isfile(candidate):
            raise FileApiUnavailable('cmakeFiles input original missing: ' + candidate)
        return candidate
    candidate = os.path.abspath(os.path.join(root_source, name))
    if not _contained(root_source, candidate):
        raise FileApiUnavailable('cmakeFiles relative input escapes the source root: ' + name)
    if not os.path.isfile(candidate):
        # Official rule leaves no second interpretation: a relative path is
        # source-relative. A missing file is a refusal, never a build-root retry.
        raise FileApiUnavailable(
            'cmakeFiles relative input missing under the source root (official '
            'rule is source-relative; no build-root fallback): ' + candidate)
    return candidate


def _cmakefile_inputs(value):
    root_source = (value.get('paths') or {}).get('source')
    if not isinstance(root_source, str) or not os.path.isabs(root_source):
        raise FileApiUnavailable('cmakeFiles reply lacks an absolute source root')
    rows = value.get('inputs')
    if not isinstance(rows, list) or not rows:
        raise FileApiUnavailable('cmakeFiles reply listed no configure inputs')
    if len(rows) > MEMBER_COUNT_LIMIT:
        raise FileApiUnavailable('cmakeFiles input count exceeds the metadata bound')
    result = set()
    for row in rows:
        result.add(_resolve_input(root_source, row))
    return result


def configure_inputs(build, check=None):
    """READ-ONLY: return (paths, originals). Creates nothing.

    `check` is the caller's budget callback, invoked per member so the SDK's
    deadline covers a large reply set.
    """
    build = os.path.abspath(build)

    def tick():
        if check is not None:
            check()

    index_path, index_raw, index = read_index(build)
    tick()
    paths = {index_path}
    originals = [(index_path, index_raw)]
    cmakefiles_inputs = set()
    for kind, major in QUERIES:
        path, raw, value = read_object(build, index, index_path, kind, major)
        tick()
        paths.add(path)
        originals.append((path, raw))
        if kind == 'cmakeFiles':
            cmakefiles_inputs = _cmakefile_inputs(value)
    if not cmakefiles_inputs:
        raise FileApiUnavailable('cmakeFiles reply listed no configure inputs')
    # Every declared query must have produced its reply, in this very run.
    for kind, major in QUERIES:
        _unique_object(index, kind, major)
    paths.update(cmakefiles_inputs)
    return paths, originals


def query_paths(build):
    """READ-ONLY: the expected query paths. Creates nothing."""
    directory = query_dir(build)
    return [os.path.join(directory, '%s-v%d' % (kind, major)) for kind, major in QUERIES]


def verify_queries_present(build):
    """Confirm the query files that caused this reply are still in place.

    Read-only. A missing query means the reply cannot be attributed to a query
    this producer wrote, so adoption fails closed.
    """
    for path in query_paths(build):
        if not os.path.isfile(path) or os.path.islink(path):
            raise FileApiUnavailable('File API query original missing: ' + path)
        if os.path.getsize(path) != 0:
            raise FileApiUnavailable('File API query original must be the empty stateless form')
    return True


def codemodel_closure(build, check=None):
    """Every JSON the codemodel references, transitively.

    The codemodel root references per-DIRECTORY and per-TARGET jsonFile objects,
    and those can reference further files (target children / backtrace graphs).
    Retaining only the root query replies would narrow the used build-graph
    evidence, so this walks the whole reference closure following `jsonFile`.
    """
    build = os.path.abspath(build)

    def tick():
        if check is not None:
            check()

    index_path, index_raw, index = read_index(build)
    paths = {index_path}
    originals = [(index_path, index_raw)]
    # The QUERY originals are part of the retained evidence: they are the only
    # proof that these replies came from a query this producer wrote before
    # configure. `verify_queries_present` alone checks existence but does not
    # retain them.
    for query in query_paths(build):
        if not os.path.isfile(query):
            raise FileApiUnavailable('File API query original missing: ' + query)
        paths.add(query)
    root_path, root_raw, root = read_object(build, index, index_path, 'codemodel', 2)
    paths.add(root_path); originals.append((root_path, root_raw))

    seen = {root_path}
    queue = [root]
    count = 0
    while queue:
        node = queue.pop()
        count += 1
        if count > MEMBER_COUNT_LIMIT:
            raise FileApiUnavailable('codemodel reference closure exceeds the metadata bound')
        for reference in _iter_references(node):
            tick()
            child = _resolve_reference(build, root_path, reference)
            if child in seen:
                continue
            seen.add(child)
            raw = _bounded_read(child)
            value = json.loads(raw.decode('utf-8'))
            if not isinstance(value, dict):
                raise FileApiUnavailable('codemodel referenced JSON is not an object')
            paths.add(child); originals.append((child, raw))
            queue.append(value)
    return paths, originals


def _iter_references(node):
    """Yield every `jsonFile` string in this node (objects and arrays alike)."""
    if isinstance(node, dict):
        value = node.get('jsonFile')
        if isinstance(value, str):
            yield value
        for key, item in node.items():
            if key == 'jsonFile':
                continue
            yield from _iter_references(item)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_references(item)


def generator(build):
    """The generator CMake actually used, read from the File API index."""
    _, _, index = read_index(build)
    name = ((index.get('cmake') or {}).get('generator') or {}).get('name')
    if not isinstance(name, str) or not name:
        raise FileApiUnavailable('CMake File API did not report the generator name')
    return name
