"""One bounded reader for every SDK original that must be read under a byte bound.

The reader allocates exactly the length the already-verified `fstat` reports. The
earlier per-module forms read `bound + 1`, so a reply of a few KB allocated the whole
cap (4 MiB for metadata, 256 MiB for raw capture) and let CPython shrink it to the
real size; glibc satisfies that shrink on an mmap'd chunk with `mremap(MAYMOVE)`,
which this SDK's executable-memory policy refuses. Sizing from `fstat` removes that
allocation, and growth is still refused by an independent one-byte EOF probe rather
than by a larger read.

Callers pass their own bound, their own exception type and their own message
templates, so each module keeps its existing error wording while sharing one
implementation. Every template takes exactly one slot: the path. This module imports
nothing from its siblings, so tests and the SDK's relative-module loader can import
it on its own.
"""
import os


def identity(handle):
    """The six-field identity every SDK original comparison uses."""
    value = os.fstat(handle.fileno())
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


DEFAULT_MESSAGES = {
    'symlink': 'original must be a regular non-symlink file: %s',
    'regular': 'original must be a regular non-symlink file: %s',
    'over': 'original exceeds the member bound: %s',
    'grew': 'original grew past the member bound: %s',
    'short': 'original changed while read: %s',
    'changed': 'original changed while read: %s',
}


def read_bounded_original(path, bound, error, *, messages=None, require_regular=True):
    """Read one original under `bound`, allocating exactly its verified size.

    `error` is the caller's exception class; `messages` overrides any of the fixed
    templates so each module keeps its own wording. Every template receives only the
    path. `require_regular` guards the symlink/non-regular contract.
    """
    text = dict(DEFAULT_MESSAGES)
    if messages:
        text.update(messages)

    path = os.path.abspath(path)
    if require_regular:
        if os.path.islink(path):
            raise error(text['symlink'] % path)
        if not os.path.isfile(path):
            raise error(text['regular'] % path)
    with open(path, 'rb') as handle:
        before = identity(handle)
        if before[3] > bound:
            raise error(text['over'] % path)
        raw = handle.read(before[3])
        if len(raw) != before[3]:
            raise error(text['short'] % path)
        if handle.read(1):
            raise error(text['grew'] % path)
        after = identity(handle)
    if before != after:
        raise error(text['changed'] % path)
    return raw
