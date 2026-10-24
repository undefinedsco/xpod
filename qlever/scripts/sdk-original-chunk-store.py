#!/usr/bin/env python3
"""Verified chunk-original SDK manifest store.

Read-only manifest verification, content-addressed snapshot writing, and
byte accounting.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import secrets
import stat
from typing import Callable, Dict, List, Optional, Tuple

HEX = re.compile(r"[0-9a-f]{64}\Z")
MREF = re.compile(r"manifests/[0-9]+\.json\Z")
RKEYS = {"path", "bytes", "sha256"}
MKEYS = {"model", "sequence", "sourceIdentityBefore", "sourceIdentityAfter",
         "bytes", "sha256", "chunks"}
CKEYS = {"sha256", "bytes"}
MIB, MAX_IMAGE, CHUNK = 1024 * 1024, 512 * 1024 * 1024, 65536


class ManifestError(ValueError):
    """A reference, manifest, or chunk failed verification."""


def _exact(obj, keys):
    if type(obj) is not dict or set(obj) != keys:
        raise ManifestError("exact keys required")


def _int(v, low, high=None):
    if type(v) is not int or v < low or (high is not None and v > high):
        raise ManifestError("invalid integer")
    return v


def _sha(v):
    if type(v) is not str or not HEX.fullmatch(v):
        raise ManifestError("invalid sha256")
    return v


def _pair(pairs):
    if len({k for k, _ in pairs}) != len(pairs):
        raise ManifestError("duplicate key")
    return dict(pairs)


def _const(_v):
    raise ManifestError("invalid constant")


def _open(root, path):
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ManifestError("unsafe path")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for p in parts[:-1]:
            child = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return os.open(
            parts[-1],
            os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0),
            dir_fd=fd,
        )
    finally:
        os.close(fd)


def _sig(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size,
            s.st_mtime_ns, s.st_ctime_ns)


def _read(root, path, size, digest, limit):
    fd = None
    try:
        fd = _open(root, path)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_size != size or size > limit):
            raise ManifestError("unsafe file metadata")
        data = b""
        while len(data) <= size:
            part = os.read(fd, size + 1 - len(data))
            if not part:
                break
            data += part
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise ManifestError("file bytes or sha256 mismatch")
        if _sig(before) != _sig(os.fstat(fd)):
            raise ManifestError("file changed while reading")
        return data
    except OSError as exc:
        raise ManifestError("cannot securely read file") from exc
    finally:
        if fd is not None:
            os.close(fd)


def _manifest_shape(ref):
    _exact(ref, RKEYS)
    if type(ref["path"]) is not str or not MREF.fullmatch(ref["path"]):
        raise ManifestError("manifest path must match manifests/[0-9]+.json")


def validate_manifest_bytes(data, ref):
    """Validate raw manifest bytes against ref and the exact manifest schema."""
    _manifest_shape(ref)
    size = _int(ref["bytes"], 0, MIB)
    digest = _sha(ref["sha256"])
    if type(data) is not bytes:
        raise ManifestError("manifest bytes must be bytes")
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ManifestError("manifest bytes or sha256 mismatch")
    try:
        parsed = json.loads(
            data.decode("utf-8"), object_pairs_hook=_pair, parse_constant=_const
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError("malformed manifest JSON") from exc
    _exact(parsed, MKEYS)
    if parsed["model"] != "chunk-original-v1":
        raise ManifestError("unsupported manifest model")
    _int(parsed["sequence"], 0)
    ids = parsed["sourceIdentityBefore"], parsed["sourceIdentityAfter"]
    for ident in ids:
        if type(ident) is not list or len(ident) != 7 or any(type(i) is not int for i in ident):
            raise ManifestError("source identity must be seven integers")
    if ids[0] != ids[1]:
        raise ManifestError("source identities differ")
    chunks, total = parsed["chunks"], 0
    if type(chunks) is not list:
        raise ManifestError("chunks must be a list")
    for index, chunk in enumerate(chunks):
        _exact(chunk, CKEYS)
        _sha(chunk["sha256"])
        total += _int(chunk["bytes"], 1, CHUNK)
        if index + 1 < len(chunks) and chunk["bytes"] != CHUNK:
            raise ManifestError("non-final chunk has wrong size")
    if _int(parsed["bytes"], 0, MAX_IMAGE) != total:
        raise ManifestError("chunk sizes do not sum to image bytes")
    _sha(parsed["sha256"])
    return parsed


def _physical_bytes(reference, read_physical, limit, check=lambda: None):
    """Read one physical reference and independently verify its whole bytes/SHA."""
    _exact(reference, RKEYS)
    path = reference["path"]
    if type(path) is not str or not path:
        raise ManifestError("invalid physical path")
    size = _int(reference["bytes"], 0, limit)
    digest = _sha(reference["sha256"])
    pieces, total = [], 0
    for piece in read_physical(reference):
        check()
        if type(piece) is not bytes:
            raise ManifestError("physical chunk must be bytes")
        if len(piece) > CHUNK:
            raise ManifestError("physical chunk exceeds 65536 bytes")
        total += len(piece)
        if total > size:
            raise ManifestError("physical bytes exceed reference size")
        pieces.append(piece)
    data = b"".join(pieces)
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ManifestError("physical bytes or sha256 mismatch")
    return data


def read_manifest(root, ref, check=lambda: None):
    """Validate and return the parsed manifest named by ref."""
    _manifest_shape(ref)
    check()
    raw = _read(root, ref["path"], _int(ref["bytes"], 0, MIB), _sha(ref["sha256"]), MIB)
    return validate_manifest_bytes(raw, ref)


def blocks_from_reader(ref, read_physical, check=lambda: None):
    """Yield verified chunks from a caller-bound physical archive reader."""
    _manifest_shape(ref)
    check()
    data = validate_manifest_bytes(_physical_bytes(ref, read_physical, MIB, check), ref)
    whole, total = hashlib.sha256(), 0
    for chunk in data["chunks"]:
        check()
        chunk_ref = {
            "path": "chunks/" + chunk["sha256"],
            "bytes": chunk["bytes"],
            "sha256": chunk["sha256"],
        }
        part = _physical_bytes(chunk_ref, read_physical, CHUNK, check)
        check()
        whole.update(part)
        total += len(part)
        yield part
        check()
    if total != data["bytes"] or whole.hexdigest() != data["sha256"]:
        raise ManifestError("whole-image bytes or sha256 mismatch")


def _disk_physical(root):
    def read_physical(reference):
        path = reference["path"]
        limit = MIB if MREF.fullmatch(path) else CHUNK
        data = _read(root, path, reference["bytes"], reference["sha256"], limit)
        for offset in range(0, len(data), CHUNK):
            yield data[offset:offset + CHUNK]
    return read_physical


def blocks(root, ref, check=lambda: None):
    """Yield verified chunks in order and verify the whole image at the end."""
    yield from blocks_from_reader(ref, _disk_physical(root), check)


# ---------------------------------------------------------------------------
# Snapshot writer
# ---------------------------------------------------------------------------
CHUNK_SIZE = CHUNK
MAX_SOURCE_BYTES = MAX_IMAGE
MODEL = "chunk-original-v1"
MANIFEST_BASE_BOUND = 1024
MANIFEST_CHUNK_BOUND = 160

# Cumulative number of bytes physically written by this module (chunk payloads
# plus manifest payloads).  This is intentionally separate from ledger
# accounting: pre-existing chunks that are reused are not written and failed
# transactions still count bytes that were actually written.
WRITE_BYTES = 0
# Lower-case alias, kept in sync with WRITE_BYTES.
write_bytes = 0

_IDENTITY_FIELDS = (
    "st_dev",
    "st_ino",
    "st_mode",
    "st_size",
    "st_mtime_ns",
    "st_ctime_ns",
    "st_nlink",
)


class SnapshotError(RuntimeError):
    """Integrity or source-validation failure."""


def _identity(st: os.stat_result) -> List[int]:
    return [
        st.st_dev,
        st.st_ino,
        st.st_mode,
        st.st_size,
        st.st_mtime_ns,
        st.st_ctime_ns,
        st.st_nlink,
    ]


def _is_regular(st: os.stat_result) -> bool:
    return stat.S_ISREG(st.st_mode)


def _is_dir(st: os.stat_result) -> bool:
    return stat.S_ISDIR(st.st_mode)


def _pread_exact(fd: int, length: int, offset: int) -> bytes:
    """Read exactly *length* bytes at *offset*, or raise SnapshotError."""
    parts: List[bytes] = []
    remaining = length
    position = offset
    while remaining:
        block = os.pread(fd, remaining, position)
        if not block:
            raise SnapshotError("unexpected end of source file while reading")
        parts.append(block)
        remaining -= len(block)
        position += len(block)
    return b"".join(parts)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write")
        view = view[written:]


def _fsync_dir(fd: int) -> None:
    """Best-effort durability for a directory entry."""
    try:
        os.fsync(fd)
    except OSError as exc:
        # Some filesystems/platforms do not support fsync on directories.
        if exc.errno not in (
            errno.EINVAL,
            errno.ENOTSUP,
            errno.EBADF,
            errno.EROFS,
        ):
            raise


def _open_subdir(
    parent_fd: int, name: str, create: bool, created: Optional[List[str]] = None
) -> int:
    """Open a direct child directory without following a final symlink."""
    if create:
        try:
            os.mkdir(name, 0o755, dir_fd=parent_fd)
        except FileExistsError:
            pass
        else:
            if created is not None:
                created.append(name)
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, dir_fd=parent_fd)
    try:
        if not _is_dir(os.fstat(fd)):
            raise SnapshotError("%r is not a directory" % (name,))
    except BaseException:
        os.close(fd)
        raise
    return fd


def _require_absent(dir_fd: int, name: str) -> None:
    try:
        os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise FileExistsError("target already exists: %s" % (name,))


def _verify_existing_chunk(
    chunks_fd: int, name: str, expected_length: int, expected_sha: str
) -> None:
    """Verify a pre-existing chunk without following symlinks or modifying it."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, dir_fd=chunks_fd)
    try:
        before = os.fstat(fd)
        if not _is_regular(before):
            raise SnapshotError("existing chunk is not a regular file: %s" % name)
        if before.st_nlink != 1:
            raise SnapshotError("existing chunk link count is not 1: %s" % name)
        if before.st_size != expected_length:
            raise SnapshotError("existing chunk has wrong length: %s" % name)

        named = os.stat(name, dir_fd=chunks_fd, follow_symlinks=False)
        if (
            not _is_regular(named)
            or named.st_dev != before.st_dev
            or named.st_ino != before.st_ino
            or named.st_nlink != 1
        ):
            raise SnapshotError("existing chunk path is not stable: %s" % name)

        digest = hashlib.sha256()
        digest.update(_pread_exact(fd, expected_length, 0))
        if digest.hexdigest() != expected_sha:
            raise SnapshotError("existing chunk has wrong SHA-256: %s" % name)

        after = os.fstat(fd)
        named_after = os.stat(name, dir_fd=chunks_fd, follow_symlinks=False)
        if _identity(before) != _identity(after):
            raise SnapshotError("existing chunk changed while verifying: %s" % name)
        if (
            not _is_regular(named_after)
            or named_after.st_dev != before.st_dev
            or named_after.st_ino != before.st_ino
            or named_after.st_nlink != 1
        ):
            raise SnapshotError("existing chunk path changed while verifying: %s" % name)
    finally:
        os.close(fd)


def _stage_file(txn_fd: int, name: str, data: bytes) -> os.stat_result:
    """Create and fsync a private staging file, returning its stat."""
    st = _stage_bytes(txn_fd, name, data)
    _flush_stage(txn_fd, name, len(data), _identity(st))
    return st


def _stage_bytes(txn_fd: int, name: str, data: bytes) -> os.stat_result:
    """Write one private staging file without flushing it yet.

    Not durable until ``_flush_stage`` runs; callers must flush every staged
    name before linking any of them into a published directory.
    """
    global WRITE_BYTES, write_bytes

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, 0o600, dir_fd=txn_fd)
    try:
        _write_all(fd, data)
    finally:
        os.close(fd)

    st = os.stat(name, dir_fd=txn_fd, follow_symlinks=False)
    if not _is_regular(st) or st.st_size != len(data):
        raise SnapshotError("staging file is not a regular file of the expected size")
    if st.st_nlink != 1:
        raise SnapshotError("staging file must have link count 1")
    WRITE_BYTES += len(data)
    write_bytes = WRITE_BYTES
    return st


def _flush_stage(
    txn_fd: int, name: str, length: int, created: List[int]
) -> None:
    """Flush exactly the staging inode this transaction created.

    The full creation identity (dev, ino, mode, size, mtime, ctime, nlink) is
    re-checked before the flush and again after it, so a same-inode in-place
    rewrite, a name replacement or a size change is refused instead of flushed.
    One descriptor is held at a time; no per-chunk transaction check is issued.
    """
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, dir_fd=txn_fd)
    try:
        before = os.fstat(fd)
        if not _is_regular(before):
            raise SnapshotError("staged file is not a regular file: %s" % name)
        if _identity(before) != created or before.st_size != length:
            raise SnapshotError("staged file identity changed: %s" % name)
        os.fsync(fd)
        if _identity(os.fstat(fd)) != created:
            raise SnapshotError("staged file changed while flushing: %s" % name)
    finally:
        os.close(fd)


def _unlink_if_owned(
    dir_fd: Optional[int], name: str, dev: Optional[int], ino: Optional[int]
) -> None:
    """Unlink *name* only when it is the inode this transaction created.

    A None dev/ino means publication succeeded but the follow-up stat did not;
    in that case the caller knows the name was absent before the link and this
    transaction owns it.
    """
    if dir_fd is None:
        return
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if dev is not None and (st.st_dev != dev or st.st_ino != ino):
        return
    try:
        os.unlink(name, dir_fd=dir_fd)
    except FileNotFoundError:
        pass


def _cleanup(
    *,
    root_fd: Optional[int],
    txn_fd: Optional[int],
    txn_name: Optional[str],
    chunks_fd: Optional[int],
    manifests_fd: Optional[int],
    staged_names: set,
    published_chunks: List[Tuple[str, Optional[int], Optional[int]]],
    manifest_name: Optional[str],
    manifest_published: Optional[Tuple[str, Optional[int], Optional[int]]],
    created_dirs: List[str],
) -> None:
    """Roll back everything this transaction created.

    Every owned artifact is attempted even when an earlier unlink fails.  The
    first cleanup error is raised after all attempts so callers can keep their
    accounting conservative instead of hiding leftovers.
    """
    errors: List[BaseException] = []

    def attempt(action) -> None:
        try:
            action()
        except FileNotFoundError:
            pass
        except BaseException as exc:
            errors.append(exc)

    if manifest_published is not None and manifests_fd is not None:
        attempt(
            lambda: _unlink_if_owned(
                manifests_fd,
                manifest_published[0],
                manifest_published[1],
                manifest_published[2],
            )
        )
    elif manifest_name is not None and manifests_fd is not None:
        # The hard link may have succeeded even if the post-link stat failed.
        attempt(lambda: _unlink_if_owned(manifests_fd, manifest_name, None, None))

    for name, dev, ino in published_chunks:
        attempt(lambda name=name, dev=dev, ino=ino: _unlink_if_owned(
            chunks_fd, name, dev, ino
        ))

    if txn_fd is not None:
        for name in list(staged_names):
            attempt(lambda name=name: os.unlink(name, dir_fd=txn_fd))

    if txn_name is not None and root_fd is not None:
        attempt(lambda: os.rmdir(txn_name, dir_fd=root_fd))

    # Remove only directories this call created, and only when empty.
    if root_fd is not None:
        for name in created_dirs:
            attempt(lambda name=name: os.rmdir(name, dir_fd=root_fd))

    if errors:
        raise errors[0]


def snapshot(
    root: str,
    fd: int,
    sequence: int,
    ledger,
    check: Callable[[], None] = lambda: None,
):
    """Publish one snapshot of an already-open regular source file.

    Parameters
    ----------
    root:
        Data root containing (or allowed to be given) ``chunks/`` and
        ``manifests/``.  Neither directory nor the source target may be a
        symlink.
    fd:
        Open descriptor for the source regular file.  It is not closed by this
        function.  ``os.pread`` is used, so its file offset is untouched.
    sequence:
        Strictly non-negative integer; the target is
        ``manifests/<sequence>.json`` and must not already exist.
    ledger:
        Object with ``reserve(n)``, ``commit(n)``, ``release()``,
        ``retained_bytes`` and ``reserved_bytes``.  ``commit`` consumes the
        reservation and adds to retained bytes; ``release`` drops any unused
        reservation.
    check:
        Optional callback invoked at transaction checkpoints.  Raising from it
        forces a clean rollback.

    Returns
    -------
    dict
        ``{"path": "manifests/<sequence>.json", "bytes": <manifest length>,
        "sha256": <manifest digest>}``.
    """
    global WRITE_BYTES

    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        raise ValueError("sequence must be a strictly non-negative integer")

    root_fd: Optional[int] = None
    chunks_fd: Optional[int] = None
    manifests_fd: Optional[int] = None
    txn_fd: Optional[int] = None
    txn_name: Optional[str] = None
    staged_names: set = set()
    published_chunks: List[Tuple[str, Optional[int], Optional[int]]] = []
    manifest_created = False
    manifest_published: Optional[Tuple[str, Optional[int], Optional[int]]] = None
    created_dirs: List[str] = []
    reserved = False
    committed = False

    target_name = "%d.json" % sequence

    try:
        root_fd = os.open(
            root,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
        )
        if not _is_dir(os.fstat(root_fd)):
            raise SnapshotError("root is not a directory")

        # Reject symlinked/file-shaped chunks/ and manifests/ up front.  Do not
        # create missing directories until the reservation has succeeded.
        try:
            chunks_fd = _open_subdir(root_fd, "chunks", create=False)
        except FileNotFoundError:
            chunks_fd = None
        try:
            manifests_fd = _open_subdir(root_fd, "manifests", create=False)
        except FileNotFoundError:
            manifests_fd = None

        if manifests_fd is not None:
            _require_absent(manifests_fd, target_name)

        before = os.fstat(fd)
        if not _is_regular(before):
            raise SnapshotError("source descriptor is not a regular file")
        if before.st_size > MAX_SOURCE_BYTES:
            raise SnapshotError("source exceeds 512 MiB limit")
        size = before.st_size
        identity_before = _identity(before)

        number_of_chunks = (size + CHUNK_SIZE - 1) // CHUNK_SIZE
        manifest_bound = MANIFEST_BASE_BOUND + number_of_chunks * MANIFEST_CHUNK_BOUND
        reserve_amount = size + manifest_bound

        # A failed reserve must not touch any reservation this transaction does
        # not own.  Ownership starts only after reserve succeeds.
        ledger.reserve(reserve_amount)
        reserved = True

        if chunks_fd is None:
            chunks_fd = _open_subdir(root_fd, "chunks", create=True, created=created_dirs)
        if manifests_fd is None:
            manifests_fd = _open_subdir(root_fd, "manifests", create=True, created=created_dirs)
        _require_absent(manifests_fd, target_name)

        for _ in range(128):
            candidate = ".txn-%d-%s" % (os.getpid(), secrets.token_hex(8))
            try:
                os.mkdir(candidate, 0o700, dir_fd=root_fd)
            except FileExistsError:
                continue
            txn_name = candidate
            break
        if txn_name is None:
            raise SnapshotError("could not create private staging directory")

        txn_fd = os.open(
            txn_name,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            dir_fd=root_fd,
        )

        check()

        whole = hashlib.sha256()
        chunks: List[Dict[str, object]] = []
        new_order: List[Tuple[str, int, str, List[int]]] = []
        new_chunk_bytes = 0
        verified_existing: Dict[str, int] = {}
        staged_chunks: Dict[str, Tuple[str, int, int, int]] = {}

        offset = 0
        for index in range(number_of_chunks):
            length = min(CHUNK_SIZE, size - offset)
            data = _pread_exact(fd, length, offset)
            whole.update(data)
            chunk_sha = hashlib.sha256(data).hexdigest()
            chunks.append({"sha256": chunk_sha, "bytes": length})

            known_length = verified_existing.get(chunk_sha)
            if known_length is not None:
                if known_length != length:
                    raise SnapshotError("chunk hash seen with inconsistent lengths")
            else:
                staged = staged_chunks.get(chunk_sha)
                if staged is not None:
                    if staged[1] != length:
                        raise SnapshotError("chunk hash seen with inconsistent lengths")
                else:
                    try:
                        _verify_existing_chunk(chunks_fd, chunk_sha, length, chunk_sha)
                    except FileNotFoundError:
                        stage_name = "chunk-" + chunk_sha
                        staged_names.add(stage_name)
                        st = _stage_bytes(txn_fd, stage_name, data)
                        staged_chunks[chunk_sha] = (
                            stage_name,
                            length,
                            st.st_dev,
                            st.st_ino,
                        )
                        new_order.append(
                            (chunk_sha, length, stage_name, _identity(st))
                        )
                        new_chunk_bytes += length
                    else:
                        verified_existing[chunk_sha] = length

            offset += length

        # Flush every staged chunk before any of them is linked, so the existing
        # rule "a published chunk is already durable" still holds.  This sits
        # between the same two transaction checks as before (no per-chunk scan).
        for chunk_sha, length, stage_name, stage_identity in new_order:
            _flush_stage(txn_fd, stage_name, length, stage_identity)

        check()

        after = os.fstat(fd)
        if _identity(after) != identity_before:
            raise SnapshotError("source file identity changed during snapshot")
        identity_after = _identity(after)

        manifest = {
            "model": MODEL,
            "sequence": sequence,
            "sourceIdentityBefore": identity_before,
            "sourceIdentityAfter": identity_after,
            "bytes": size,
            "sha256": whole.hexdigest(),
            "chunks": chunks,
        }
        manifest_bytes = json.dumps(
            manifest, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if len(manifest_bytes) > manifest_bound:
            raise SnapshotError("serialized manifest exceeds reserved bound")

        check()

        # Publish chunks first, using no-clobber hard links from the private
        # staging directory.  A pre-existing final name is never replaced.
        for chunk_sha, length, stage_name, stage_identity in new_order:
            stage_dev, stage_ino = stage_identity[0], stage_identity[1]
            staged = os.stat(stage_name, dir_fd=txn_fd, follow_symlinks=False)
            if _identity(staged) != stage_identity:
                raise SnapshotError("staged chunk changed before publish: %s" % stage_name)
            try:
                os.link(
                    stage_name,
                    chunk_sha,
                    src_dir_fd=txn_fd,
                    dst_dir_fd=chunks_fd,
                    follow_symlinks=False,
                )
            except FileExistsError:
                # Extremely defensive: a chunk appeared after the earlier
                # absence check.  Reuse it only if it verifies exactly.
                _verify_existing_chunk(chunks_fd, chunk_sha, length, chunk_sha)
                new_chunk_bytes -= length
                try:
                    os.unlink(stage_name, dir_fd=txn_fd)
                except FileNotFoundError:
                    pass
                staged_names.discard(stage_name)
                continue

            published_chunks.append((chunk_sha, None, None))
            final = os.stat(chunk_sha, dir_fd=chunks_fd, follow_symlinks=False)
            if not _is_regular(final):
                raise SnapshotError("published chunk is not regular")
            if final.st_dev != stage_dev or final.st_ino != stage_ino:
                raise SnapshotError("published chunk inode mismatch")
            published_chunks[-1] = (chunk_sha, final.st_dev, final.st_ino)

            try:
                os.unlink(stage_name, dir_fd=txn_fd)
            except FileNotFoundError:
                pass
            staged_names.discard(stage_name)

            stable = os.stat(chunk_sha, dir_fd=chunks_fd, follow_symlinks=False)
            if (
                not _is_regular(stable)
                or stable.st_nlink != 1
                or stable.st_dev != stage_dev
                or stable.st_ino != stage_ino
                or stable.st_size != length
            ):
                raise SnapshotError("published chunk is not stable with nlink 1")

        _fsync_dir(chunks_fd)

        check()

        # Manifest is published last, also with an exclusive no-clobber link.
        manifest_stage = "manifest.json"
        staged_names.add(manifest_stage)
        manifest_st = _stage_file(txn_fd, manifest_stage, manifest_bytes)
        os.link(
            manifest_stage,
            target_name,
            src_dir_fd=txn_fd,
            dst_dir_fd=manifests_fd,
            follow_symlinks=False,
        )
        manifest_created = True
        manifest_published = (target_name, None, None)
        final_manifest = os.stat(
            target_name, dir_fd=manifests_fd, follow_symlinks=False
        )
        if (
            not _is_regular(final_manifest)
            or final_manifest.st_dev != manifest_st.st_dev
            or final_manifest.st_ino != manifest_st.st_ino
        ):
            raise SnapshotError("published manifest inode mismatch")
        manifest_published = (
            target_name,
            final_manifest.st_dev,
            final_manifest.st_ino,
        )

        try:
            os.unlink(manifest_stage, dir_fd=txn_fd)
        except FileNotFoundError:
            pass
        staged_names.discard(manifest_stage)

        stable_manifest = os.stat(
            target_name, dir_fd=manifests_fd, follow_symlinks=False
        )
        if (
            not _is_regular(stable_manifest)
            or stable_manifest.st_nlink != 1
            or stable_manifest.st_dev != manifest_st.st_dev
            or stable_manifest.st_ino != manifest_st.st_ino
            or stable_manifest.st_size != len(manifest_bytes)
        ):
            raise SnapshotError("published manifest is not stable with nlink 1")
        _fsync_dir(manifests_fd)

        check()

        # No staging entries should remain, but clearing any tracked names makes
        # the private directory removable on every successful path.
        for name in list(staged_names):
            try:
                os.unlink(name, dir_fd=txn_fd)
            except FileNotFoundError:
                pass
        staged_names.clear()
        os.rmdir(txn_name, dir_fd=root_fd)
        txn_name = None

        actual_retained = new_chunk_bytes + len(manifest_bytes)
        if actual_retained > reserve_amount:
            raise SnapshotError("retained bytes exceed reservation")

        result = {
            "path": "manifests/%s" % target_name,
            "bytes": len(manifest_bytes),
            "sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        }

        ledger.commit(actual_retained)
        committed = True
        # The data is now legitimately retained.  Do not let any later
        # housekeeping failure trigger rollback of committed data.
        manifest_created = False
        manifest_published = None
        published_chunks.clear()

        ledger.release()
        reserved = False
        return result

    except BaseException as exc:
        cleanup_error: Optional[BaseException] = None
        if not committed:
            try:
                _cleanup(
                    root_fd=root_fd,
                    txn_fd=txn_fd,
                    txn_name=txn_name,
                    chunks_fd=chunks_fd,
                    manifests_fd=manifests_fd,
                    staged_names=staged_names,
                    published_chunks=published_chunks,
                    manifest_name=target_name if manifest_created else None,
                    manifest_published=manifest_published,
                    created_dirs=created_dirs,
                )
            except BaseException as cleanup_exc:
                cleanup_error = cleanup_exc
        # Release only when rollback fully succeeded.  A failed rollback may
        # have left chunks/manifests behind, so keep the reservation as a
        # conservative bound on that residual and surface the cleanup error.
        if reserved and cleanup_error is None:
            try:
                ledger.release()
            except BaseException:
                pass
            reserved = False
        if cleanup_error is not None:
            raise cleanup_error from exc
        raise

    finally:
        for maybe_fd in (txn_fd, chunks_fd, manifests_fd, root_fd):
            if maybe_fd is not None:
                try:
                    os.close(maybe_fd)
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# Byte accounting
# ---------------------------------------------------------------------------


class LedgerValidationError(ValueError, TypeError):
    """Raised when a Ledger argument is not an exact, non-negative int."""


def _amount(value, name):
    if type(value) is not int:
        raise LedgerValidationError(f"{name} must be an exact int")
    if value < 0:
        raise LedgerValidationError(f"{name} must be non-negative")
    return value


class Ledger:
    def __init__(self, maximum_bytes, retained_bytes=0):
        maximum_bytes = _amount(maximum_bytes, "maximum_bytes")
        retained_bytes = _amount(retained_bytes, "retained_bytes")
        if retained_bytes > maximum_bytes:
            raise LedgerValidationError(
                "retained_bytes must not exceed maximum_bytes"
            )

        self.maximum_bytes = maximum_bytes
        self.retained_bytes = retained_bytes
        self.reserved_bytes = 0
        self.write_bytes = 0
        self._active = False

    def reserve(self, n):
        n = _amount(n, "n")
        if self._active:
            raise RuntimeError("a reservation is already active")
        if self.retained_bytes + n > self.maximum_bytes:
            raise LedgerValidationError(
                "reservation would exceed maximum_bytes"
            )

        self.reserved_bytes = n
        self._active = True

    def commit(self, n):
        n = _amount(n, "n")
        if not self._active:
            raise RuntimeError("no active reservation")
        if n > self.reserved_bytes:
            raise LedgerValidationError(
                "commit exceeds the active reservation"
            )

        self.retained_bytes += n
        self.reserved_bytes -= n

    def release(self):
        self.reserved_bytes = 0
        self._active = False

    def note_write(self, n):
        n = _amount(n, "n")
        self.write_bytes += n

