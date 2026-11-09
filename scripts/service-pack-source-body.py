#!/usr/bin/env python3
"""Exec the sole system tar with a pre-reserved, inherited output-file bound.

No clock, ledger or source authority is created here. The pack parent's existing
supervisor owns timeout/wait/group cleanup and retains this exact argv.
"""
import os
import hashlib
import json
import pathlib
import resource
import stat
import sys


def selected_list(file):
    """Hold and validate the actual NUL tool-selection input; no tar parsing."""
    limits = json.loads((pathlib.Path(__file__).parent / 'lib/module-artifact-limits.json').read_text())
    maximum = limits['metadataBytes']
    if not os.path.isabs(file) or os.path.normpath(file) != file or len(file) > 4096:
        raise ValueError('bounded absolute selected list path required')
    before = os.lstat(file)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size <= 0 or before.st_size > maximum:
        raise ValueError('bounded single-link selected list before open required')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        def identity(value):
            return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
        if identity(before) != identity(os.fstat(fd)):
            raise ValueError('selected list opened identity differs')
        raw = bytearray()
        while len(raw) < before.st_size:
            block = os.read(fd, min(65536, before.st_size - len(raw)))
            if not block:
                raise ValueError('selected list shortened')
            raw.extend(block)
        if identity(before) != identity(os.fstat(fd)) or identity(before) != identity(os.lstat(file)):
            raise ValueError('selected list changed while reading')
        data = bytes(raw)
        if not data.endswith(b'\0') or data.count(b'\0') > limits['members']:
            raise ValueError('selected list requires terminal NUL')
        names = data[:-1].decode('utf8').split('\0')
        seen = set()
        for name in names:
            if not name.startswith('package/') or len(name.encode('utf8')) > 4096 or '\\' in name or any(ord(char) < 32 or ord(char) == 127 for char in name) or any(part in ('', '.', '..') for part in name.split('/')) or name in seen:
                raise ValueError('closed safe unique package selected names required')
            seen.add(name)
        if not names or 'package/package.json' not in seen:
            raise ValueError('selected package manifest required')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd, {'path': file, 'fd': fd, 'identity': [str(value) for value in identity(before)], 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'members': len(names)}
    except BaseException:
        try:
            os.close(fd)
        except BaseException:
            pass
        raise


def run(argv):
    if len(argv) not in (4, 5):
        raise ValueError('fixed source body arguments required')
    root, output, maximum_text = argv[1:4]
    if not maximum_text.isdecimal() or maximum_text.startswith('0'):
        raise ValueError('positive existing reservation required')
    maximum = int(maximum_text)
    if maximum > 128 * 1024 * 1024:
        raise ValueError('canonical pack retained allocation exceeded')
    for value in (root, output):
        if not os.path.isabs(value) or os.path.normpath(value) != value or len(value) > 4096:
            raise ValueError('bounded absolute source body path required')
    if not stat.S_ISDIR(os.lstat(root).st_mode):
        raise ValueError('owned archive root directory required')
    package = pathlib.Path(root) / 'package'
    if not package.is_dir():
        raise ValueError('actual package input required')
    if os.path.lexists(output):
        raise ValueError('source body output must be exclusive')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    primary = None
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))
        # tar writes its archive to the one already exclusively owned FD. There
        # is no second writer, temporary archive or post-hoc size-only limit.
        os.dup2(fd, 1)
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            os.close(fd)
        except BaseException:
            if primary is None:
                raise
    if len(argv) == 4:
        os.execvp('tar', ['tar', '-chzf', '-', '-C', root, 'package'])
    else:
        # The sole command launcher already fchdir'ed its inherited held FD.
        # Keep that kernel cwd instead of selecting the tar root by pathname.
        if os.getcwd() != os.path.realpath(root) or os.stat('.') != os.stat(root):
            raise ValueError('selected tar must use the actual held command cwd')
        selected_fd, selected_original = selected_list(argv[4])
        primary = None
        try:
            original = b'SERVICE_PACK_SELECTED_LIST ' + json.dumps(selected_original, separators=(',', ':')).encode('utf8') + b'\n'
            if len(original) > 65536:
                raise ValueError('bounded selected-list original required')
            at = 0
            while at < len(original):
                written = os.write(2, original[at:])
                if written <= 0:
                    raise ValueError('selected-list original write made no progress')
                at += written
            os.set_inheritable(selected_fd, True)
            os.execvp('tar', ['tar', '-chzf', '-', '-C', '.', '--no-recursion', '--null', '--files-from', '/dev/fd/' + str(selected_fd)])
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                os.close(selected_fd)
            except BaseException:
                if primary is None:
                    raise


if __name__ == '__main__':
    run(sys.argv)
