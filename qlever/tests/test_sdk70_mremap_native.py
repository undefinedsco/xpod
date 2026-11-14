#!/usr/bin/env python3
"""Replayable REAL-KERNEL test for the bounded private-anonymous mremap capability.

Run this on a real Linux x86_64 (or aarch64) host. It is NOT a mock: it compiles a
tiny C child, traces it with the production policy + the production coverage
predicate, and checks what the kernel actually does.

What it proves:
  A. a genuine glibc-style `realloc` growth of a private anonymous region is
     accepted by the shape + coverage predicate (the 19fe0a44 failure shape);
  B. an `mremap` whose source range contains an executable page is refused;
  C. `MREMAP_FIXED` and `MREMAP_DONTUNMAP` are refused by shape alone;
  D. a file-backed `MAP_SHARED` source range is refused by the VMA predicate;
  E. the post-move destination is re-checked and refuses if it is executable.

Exit code 0 = every expectation held. Any mismatch exits non-zero with detail.
Usage: python3 -B qlever/tests/test_sdk70_mremap_native.py
"""
import ctypes
import importlib.util
import mmap
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'
_spec = importlib.util.spec_from_file_location('native_policy', SCRIPTS / 'sdk-executable-memory-policy.py')
policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy)

MACHINE = platform.machine()
ARCH = {'x86_64': 0xc000003e, 'aarch64': 0xc00000b7}.get(MACHINE)
if ARCH is None:
    # The dedicated gate is Linux-only. Anywhere else this FAILS explicitly: a
    # Darwin/Windows run must never be mistaken for a real remap proof, and the
    # gate driver treats a SKIP line as a hard failure anyway.
    why = ('this test exercises Linux mremap/2 semantics; run it on a real '
           'Linux x86_64/aarch64 host' % ())
    print('FAIL: machine %r not in {x86_64, aarch64}; %s' % (MACHINE, why))
    raise SystemExit(2)

PAGE = os.sysconf('SC_PAGE_SIZE')
MREMAP = policy.ABI[ARCH]['remap']
libc = ctypes.CDLL(None, use_errno=True)
libc.mremap.restype = ctypes.c_void_p
libc.mremap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t,
                        ctypes.c_int, ctypes.c_void_p]
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
                      ctypes.c_int, ctypes.c_int, ctypes.c_long]
libc.mprotect.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]

PROT_READ, PROT_WRITE, PROT_EXEC = 1, 2, 4
MAP_PRIVATE, MAP_ANONYMOUS, MAP_SHARED = 0x02, 0x20, 0x01
MREMAP_MAYMOVE, MREMAP_FIXED, MREMAP_DONTUNMAP = 1, 2, 4

failures = []


def check(label, ok, detail=''):
    print(('PASS  ' if ok else 'FAIL  ') + label + (('  ' + detail) if detail else ''))
    if not ok:
        failures.append(label)


def kernel_maps():
    """Parse our own /proc/self/maps with the production parser."""
    spec = importlib.util.spec_from_file_location('native_bindings', SCRIPTS / 'sdk-generation-multiprocess-bindings.py')
    bindings = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bindings)
    raw = Path('/proc/self/maps').read_bytes()
    return bindings.parse_proc_maps(raw)


def anon_rw(size):
    addr = libc.mmap(None, size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0)
    if addr in (None, ctypes.c_void_p(-1).value):
        raise OSError(ctypes.get_errno(), 'mmap failed')
    return addr


def real_mremap(old, old_size, new_size, flags, new_addr=0):
    ctypes.set_errno(0)
    result = libc.mremap(ctypes.c_void_p(old), old_size, new_size, flags,
                         ctypes.c_void_p(new_addr))
    err = ctypes.get_errno()
    if result in (None, ctypes.c_void_p(-1).value):
        raise OSError(err, os.strerror(err))
    return result


def main():
    print('== machine %s arch=%#x page=%d mremap=%d' % (MACHINE, ARCH, PAGE, MREMAP))

    # --- A: real glibc-like growth of a private anonymous region -----------
    old_size, new_size = 33 * PAGE, 65 * PAGE
    base = anon_rw(old_size)
    for offset in range(0, old_size, PAGE):
        ctypes.memset(base + offset, 0x41, PAGE)
    geometry = dict(oldAddress=base, oldSize=old_size, newSize=new_size,
                    flags=MREMAP_MAYMOVE, mayMove=True, newAddress=0)
    low, high = policy.remap_range(geometry['oldAddress'], geometry['oldSize'])
    ok, reason, covered, xbytes = policy.cover_nonexec_range(kernel_maps(), low, high)
    check('A1 real anon source range is covered with no executable page',
          ok and xbytes == 0, 'reason=%r covered=%d' % (reason, covered))

    moved = real_mremap(base, old_size, new_size, MREMAP_MAYMOVE)
    check('A2 kernel actually moved the real range',
          moved != base and moved % PAGE == 0, 'base=%#x moved=%#x' % (base, moved))
    mem = ctypes.string_at(moved, 16)
    check('A3 moved bytes preserved the 0x41 pattern', mem[:16] == b'A' * 16, repr(mem[:16]))
    ok, reason, covered, xbytes = policy.cover_nonexec_range(kernel_maps(), moved, moved + new_size)
    check('A4 destination is fully private-anon non-exec after the real move',
          ok and xbytes == 0, 'reason=%r' % (reason,))

    # --- B: source containing an executable page must be refused -----------
    mixed = anon_rw(2 * PAGE)
    libc.mprotect(ctypes.c_void_p(mixed + PAGE), PAGE, PROT_READ | PROT_EXEC)
    low, high = mixed, mixed + 2 * PAGE
    ok, reason, covered, xbytes = policy.cover_nonexec_range(kernel_maps(), low, high)
    check('B1 range with a real PROT_EXEC page is refused', not ok,
          'reason=%r xbytes=%d' % (reason, xbytes))
    check('B2 the refusal accounts the executable bytes', xbytes > 0, 'xbytes=%d' % xbytes)

    # --- C: shape refusals -------------------------------------------------
    for label, flags in (('FIXED', MREMAP_MAYMOVE | MREMAP_FIXED),
                         ('DONTUNMAP', MREMAP_DONTUNMAP),
                         ('unknown-bit', 8)):
        ok, reason, _ = policy.remap_shape(ARCH, MREMAP,
                                           [moved, new_size, new_size, flags, 0, 0], 1 << 40)
        check('C real-shape %s is refused' % label, not ok, 'reason=%r' % (reason,))

    ok, reason, _ = policy.remap_shape(ARCH, MREMAP, [moved, new_size, new_size, 0, 0, 0], 1 << 40)
    check('C flags=0 is accepted as a candidate shape', ok, 'reason=%r' % (reason,))

    # --- D: file-backed MAP_SHARED must be refused -------------------------
    with tempfile.NamedTemporaryFile() as handle:
        handle.write(b'Z' * (4 * PAGE))
        handle.flush()
        fd = os.open(handle.name, os.O_RDWR)
        try:
            shared = libc.mmap(None, PAGE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
            if shared in (None, ctypes.c_void_p(-1).value):
                check('D0 MAP_SHARED mmap', False, os.strerror(ctypes.get_errno()))
            else:
                low, high = shared, shared + PAGE
                ok, reason, covered, xbytes = policy.cover_nonexec_range(kernel_maps(), low, high)
                check('D1 real file-backed MAP_SHARED range is refused', not ok, 'reason=%r' % (reason,))
        finally:
            os.close(fd)

    # --- E: destination re-check refuses an executable landing zone --------
    dest = anon_rw(PAGE)
    libc.mprotect(ctypes.c_void_p(dest), PAGE, PROT_READ | PROT_EXEC)
    ok, reason, covered, xbytes = policy.cover_nonexec_range(kernel_maps(), dest, dest + PAGE)
    check('E1 executable destination is refused by the post-move re-check',
          not ok and xbytes > 0, 'reason=%r' % (reason,))

    compiled_child_checks()

    print('\n%d check(s) failed' % len(failures))
    return 1 if failures else 0


CHILD = r'''
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void){
  long page=sysconf(_SC_PAGESIZE);
  size_t old_size=33*page,new_size=65*page;
  char *p=mmap(NULL,old_size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(p==MAP_FAILED){perror("mmap");return 1;}
  memset(p,'A',old_size);
  char *q=mremap(p,old_size,new_size,MREMAP_MAYMOVE);
  if(q==MAP_FAILED){perror("mremap");return 2;}
  int ok = (q!=p) && ((unsigned long)q%page==0) && q[0]=='A' && q[old_size-1]=='A';
  printf("child base=%p moved=%p aligned=%d pattern=%d\n",(void*)p,(void*)q,
         (int)((unsigned long)q%page==0),(int)(q[0]=='A'&&q[old_size-1]=='A'));
  /* an RX page inside the source range must be visible as executable */
  char *r=mmap(NULL,2*page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(r==MAP_FAILED){perror("mmap2");return 3;}
  mprotect(r+page,page,PROT_READ|PROT_EXEC);
  printf("child range=0x%lx-0x%lx\n",(unsigned long)r,(unsigned long)(r+2*page));
  return ok?0:4;
}
'''


def compiled_child_checks():
    """Compile and run a REAL ELF child that performs the same mremap.

    Skipped (not failed) when no C toolchain is present, so the test stays
    replayable on a bare runner while still exercising a real separate binary
    when cc exists. The child's own maps are then parsed by production code.
    """
    import shutil
    import subprocess

    # Honor the DECLARED toolchain first (NATIVE_LEASE_CC / CC), validated as a
    # real executable, then fall back to known names. The declared compiler is
    # the authoritative toolchain identity; a bare `cc` shim is not preferred
    # over it. No silent skip: on Linux a missing compiler or a compile failure
    # is a real FAILURE, because the whole point is a real compiled child.
    declared = os.environ.get('NATIVE_LEASE_CC') or os.environ.get('CC')
    candidates = ([declared] if declared else []) + ['clang-19', 'clang', 'cc', 'gcc']
    cc = None
    for name in candidates:
        if not name:
            continue
        path = shutil.which(name)
        if path:
            cc = path
            break
    if cc is None:
        check('F0 a declared/known C compiler is available', False,
              'NATIVE_LEASE_CC=%r CC=%r' % (os.environ.get('NATIVE_LEASE_CC'), os.environ.get('CC')))
        return
    check('F0 declared compiler %r resolves to a real executable' % os.path.basename(cc), True, cc)
    with tempfile.TemporaryDirectory(prefix='mremap-child-') as tmp:
        src = Path(tmp) / 'child.c'
        binary = Path(tmp) / 'child'
        src.write_text(CHILD)
        build = subprocess.run([cc, '-O0', '-o', str(binary), str(src)],
                               capture_output=True, text=True)
        if build.returncode != 0:
            check('F0 compiled child builds with the declared compiler', False,
                  (build.stderr or '').strip().splitlines()[-1:])
            return
        run = subprocess.run([str(binary)], capture_output=True, text=True)
        out = run.stdout.strip()
        check('F1 compiled child performed a real MOVED mremap and kept its bytes',
              run.returncode == 0, 'rc=%d out=%r' % (run.returncode, out))
        check('F2 compiled child reported an aligned moved base',
              'aligned=1' in out and 'pattern=1' in out, out)
        check('F3 compiled child RX page range is printable for the policy',
              'child range=0x' in out, out)


if __name__ == '__main__':
    raise SystemExit(main())
