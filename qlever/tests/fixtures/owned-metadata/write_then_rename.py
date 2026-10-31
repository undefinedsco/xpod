"""Real CMake-shaped owned-metadata actor for the observer regression.

Writes a generated temp file, closes it, reads it back (a genuine consumer read
that the traced observer turns into a lifetime read lease), then atomically
renames it over a destination that is ALSO held open, or unlinks it, depending on
argv. Nothing here stubs the kernel: every syscall is real.

usage: write_then_rename.py <dir> <mode> [<fail>]
  mode: rename | unlink
  fail: "fail" makes the transition syscall fail (foreign/absent target case)
"""
import errno
import os
import sys

directory, mode = sys.argv[1], sys.argv[2]
fail = len(sys.argv) > 3 and sys.argv[3] == 'fail'

temp = os.path.join(directory, '.cmake-cache-tmp')
target = os.path.join(directory, 'CMakeCache.txt')

# 1. create/write/close the generated temp (CMake writes the cache to a temp)
with open(temp, 'wb') as handle:
    handle.write(b'// generated cache\nowned:1\n' * 64)

# 2. a genuine consumer read+close of the temp: this is what earns the lease
with open(temp, 'rb') as reader:
    while reader.read(4096):
        pass

# 3. keep the destination held open when replacing it (displaced-but-held case)
holder = None
if mode == 'rename' and not fail:
    with open(target, 'wb') as handle:
        handle.write(b'// previous cache\nprior:1\n' * 64)
    holder = open(target, 'rb')
    holder.read(64)

if mode == 'rename':
    if fail:
        # Execute the real failing syscall, then exit deliberately. An expected
        # ENOENT must not invoke a distro-installed unhandled-exception reporter
        # whose unrelated syscalls would obscure the transition under test.
        try:
            os.rename(os.path.join(directory, 'does-not-exist'), target)
        except FileNotFoundError as error:
            if error.errno != errno.ENOENT:
                raise
            raise SystemExit(1)
    else:
        os.replace(temp, target)
else:
    os.unlink(temp)

if holder is not None:
    holder.close()

# NOTE: deliberately NO post-transition re-read of the renamed inode. A real
# CMake cache write ends at the atomic replace; re-opening the same inode would
# re-enter lifetime_ensure's reuse path with an already-moved ctime, which is a
# fixture artifact rather than the production lifecycle under test.
sys.stdout.write('ok\n')
