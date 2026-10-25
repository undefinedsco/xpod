"""EINTR contract regression -- repo-relative, CI-runnable.

Contract source of truth (verified, not assumed):
  CPython 3.13.5 Modules/fcntlmodule.c fcntl_fcntl_impl integer branch:
      do { ret = fcntl(fd, code, (int)arg); }
      while (ret == -1 && errno == EINTR && !(async_err = PyErr_CheckSignals()));
  CPython 3.13.5 Modules/posixmodule.c os_fstat_impl:
      do { res = FSTAT(fd, &st); }
      while (res != 0 && errno == EINTR && !(async_err = PyErr_CheckSignals()));

So a non-raising handler means RETRY; the error only surfaces when a handler
raised. The native helper must match that, or it rejects healthy leases.

Mechanism: a real libc interposer on fcntl64/fstat64 (the symbols the extension
actually imports), armed only AFTER the lease is acquired. A Python-level
monkeypatch would bypass CPython's own retry loop and prove nothing, so it is
deliberately NOT used.
"""
import ctypes
import fcntl
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import native_lease_gate as gate  # noqa: E402

SHIM_SOURCE = os.path.join(os.path.dirname(HERE), 'tests', 'eintr_shim.c')
_GATE = None


def setUpModule():
    global _GATE
    _GATE = gate.LeaseGate().build()


def tearDownModule():
    if _GATE is not None:
        _GATE.close()


def g():
    return _GATE


SHIM_C = r'''
#define _GNU_SOURCE 1
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
extern char **environ;

static int done = 0;

static int armed_for(const char *name)
{
    size_t n = strlen(name);
    for (char **e = environ; e && *e; e++)
        if (strncmp(*e, name, n) == 0 && (*e)[n] == '=' &&
            strcmp(*e + n + 1, "1") == 0) return 1;
    return 0;
}

static void log_once(const char *who)
{
    const char *p = getenv("EINTR_SHIM_LOG");
    if (!p) return;
    FILE *f = fopen(p, "a");
    if (f) { fprintf(f, "%s pid=%d\n", who, (int)getpid()); fclose(f); }
}

typedef int (*fcntl_fn)(int, int, ...);

int fcntl64(int fd, int cmd, ...)
{
    static fcntl_fn real = NULL;
    if (!real) real = (fcntl_fn)dlsym(RTLD_NEXT, "fcntl64");
    va_list ap; va_start(ap, cmd); void *arg = va_arg(ap, void *); va_end(ap);
    if (cmd == F_GETLEASE && !done && armed_for("EINTR_SHIM_FCNTL")) {
        done = 1;
        /* Deliver a REAL non-raising signal at the injection point, so the
         * interpreter sees a genuine signal event with the EINTR. */
        raise(SIGUSR1);
        errno = EINTR; log_once("inject-fcntl"); return -1;
    }
    return real(fd, cmd, arg);
}

int fstat64(int fd, struct stat64 *buf)
{
    static int (*real)(int, struct stat64 *) = NULL;
    if (!real) real = (int (*)(int, struct stat64 *))dlsym(RTLD_NEXT, "fstat64");
    if (!done && armed_for("EINTR_SHIM_FSTAT")) {
        done = 1; errno = EINTR; log_once("inject-fstat"); return -1;
    }
    return real(fd, buf);
}
'''

PROBE = r'''
import ctypes, fcntl, importlib.util, os, sys, tempfile
ext_path, which = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("lease_sweep_ext", ext_path)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
d = tempfile.mkdtemp(dir=os.path.dirname(os.path.abspath(__file__)))
f = os.path.join(d, "f")
with open(f, "wb") as handle:
    handle.write(b"x" * 64)
fd = os.open(f, os.O_RDONLY)
fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
st = os.fstat(fd)
want = (st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
seen = {"n": 0}
signal_ = __import__("signal")
signal_.signal(signal_.SIGUSR1, lambda s, fr: seen.__setitem__("n", seen["n"] + 1))
# Deliver a REAL non-raising signal, then arm the shim only for the sweep.
ctypes.CDLL(None).setenv(("EINTR_SHIM_" + which).encode(), b"1", 1)
v = m.sweep([(fd, want)])
print("verdict=%s handlerRan=%d" % (tuple(v), seen["n"]))
'''


class EintrContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp(prefix='eintr-', dir=g().root)
        cls.shim_source = os.path.join(cls.work, 'eintr_shim.c')
        with open(cls.shim_source, 'w') as handle:
            handle.write(SHIM_C)
        cls.shim = os.path.join(cls.work, 'eintr_shim.so')
        compiler = os.environ.get('NATIVE_LEASE_CC') or 'cc'
        build = subprocess.run([compiler, '-O2', '-fPIC', '-shared', '-o', cls.shim,
                                cls.shim_source, '-ldl'],
                               capture_output=True, text=True)
        if build.returncode != 0:
            raise gate.GateUnavailable('shim build failed: ' + build.stderr[-500:])
        cls.probe = os.path.join(cls.work, 'probe.py')
        with open(cls.probe, 'w') as handle:
            handle.write(PROBE)

    def run_probe(self, which):
        log = os.path.join(self.work, 'shim-%s.log' % which)
        if os.path.isfile(log):
            os.unlink(log)
        env = dict(os.environ)
        env['LD_PRELOAD'] = self.shim
        env['EINTR_SHIM_LOG'] = log
        completed = subprocess.run([sys.executable, self.probe, g().extension, which],
                                   capture_output=True, text=True, env=env)
        self.assertEqual(completed.returncode, 0,
                         'probe failed: %s' % completed.stderr[-800:])
        injected = False
        if os.path.isfile(log):
            with open(log) as handle:
                injected = 'inject-' in handle.read()
        return completed.stdout.strip(), injected

    def test_fcntl_eintr_is_retried_by_the_native_helper(self):
        # This case proves the NATIVE helper retries an injected EINTR. It does
        # NOT claim CPython itself was observed retrying: LD_PRELOAD cannot
        # interpose CPython's own fcntl here (Debian links python3 with
        # -Bsymbolic-functions), so the CPython side of the contract is the
        # OFFICIAL SOURCE (fcntlmodule.c / posixmodule.c), not a measured run.
        out, injected = self.run_probe('FCNTL')
        self.assertTrue(injected, 'the shim must actually have injected an EINTR')
        self.assertIn('verdict=(0, -1, 0)', out,
                      'after an EINTR with a non-raising handler the native sweep '
                      'must retry and succeed (contract parity with CPython '
                      'source): %s' % out)
        self.assertIn('handlerRan=1', out, 'the real signal must have been delivered')

    def test_fstat_eintr_is_retried_by_the_native_helper(self):
        out, injected = self.run_probe('FSTAT')
        self.assertTrue(injected, 'the shim must actually have injected an EINTR')
        self.assertIn('verdict=(0, -1, 0)', out,
                      'fstat EINTR must also retry: %s' % out)

    def test_non_eintr_errno_still_sticky(self):
        # EBADF on a closed fd must still be a verdict, never an infinite retry.
        rows = []
        d = tempfile.mkdtemp(prefix='sticky-', dir=self.work)
        p = os.path.join(d, 'f')
        with open(p, 'wb') as h: h.write(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        ext = g().load_extension()
        st = os.fstat(fd)
        want = (st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        os.close(fd)
        verdict = ext.sweep([(fd, want)])
        self.assertEqual(verdict, (ext.ERRNO, 0, 9), 'EBADF must stay a verdict')


if __name__ == '__main__':
    unittest.main(verbosity=2)
