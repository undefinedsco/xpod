#!/usr/bin/env python3
"""END-TO-END: real Observer phase -> real raw stream -> real verifier replay.

This is the only test that exercises the load-bearing contract root flagged:

  * the child is a REAL Linux process doing a REAL `mremap` (compiled C helper,
    falling back to a small python ctypes child);
  * the observer is the REAL `Observer` from sdk-ptrace-execution.py, driving the
    REAL ptrace/maps/exclusive machinery, producing the REAL raw shard;
  * the verifier is the REAL `observe()` from sdk-generation-multiprocess-bindings.py
    replaying that exact raw file, including the new `executable-memory-remap-*`
    records and the `remapCapabilityModel` declaration.

Negative mutations are applied to a COPY of the actual raw bytes, and the real
verifier must reject each one. Linux-only: on any other platform this SKIPs.

Usage: python3 -B qlever/tests/test_sdk70_mremap_e2e.py
"""
import hashlib
import importlib.util
import json
import os
import shutil
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPTS = HERE.parent / 'scripts'

# This suite must run on real Linux. On another host it reports a hard error
# rather than a skip, so a Darwin run can never be mistaken for e2e success.
_LINUX = sys.platform.startswith('linux')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


obs = load('e2e_observer', 'sdk-ptrace-execution.py')
bindings = load('e2e_bindings', 'sdk-generation-multiprocess-bindings.py')
rawwire = load('e2e_raw_wire_reader', 'sdk-raw-wire-reader.py')
rawcodec = load('e2e_raw_codec', 'sdk-execution-originals-util.py')
rawwriter = load('e2e_raw_wire_codec', 'sdk-raw-wire-codec.py')

CHILD_THREADED_C = r"""
#define _GNU_SOURCE
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
static volatile int ready = 0;
static void *spinner(void *arg) {
  /* a real same-MM peer alive across the whole mremap */
  __sync_fetch_and_add((int *)arg, 1);
  while (!ready) usleep(1000);
  return NULL;
}
int main(void) {
  long page = sysconf(_SC_PAGESIZE);
  size_t old_size = 33 * page, new_size = 65 * page;
  int counter = 0;
  pthread_t thread;
  if (pthread_create(&thread, NULL, spinner, &counter) != 0) return 1;
  while (counter == 0) usleep(1000);
  char *p = mmap(NULL, old_size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED) return 2;
  memset(p, 'A', old_size);
  char *q = mremap(p, old_size, new_size, MREMAP_MAYMOVE);
  if (q == MAP_FAILED) return 3;
  if (q[0] != 'A' || q[old_size - 1] != 'A') return 4;
  ready = 1;
  pthread_join(thread, NULL);
  return 0;
}
"""


CHILD_C = r'''
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void){
  long page=sysconf(_SC_PAGESIZE);
  size_t old_size=33*page, new_size=65*page;
  char *p=mmap(NULL,old_size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(p==MAP_FAILED) return 1;
  memset(p,'A',old_size);
  char *q=mremap(p,old_size,new_size,MREMAP_MAYMOVE);
  if(q==MAP_FAILED) return 2;
  if(q[0]!='A'||q[old_size-1]!='A') return 3;
  return 0;
}
'''

CHILD_FORK_C = r"""
/* Independent ADDRESS SPACE: fork() gives the child its own MM (no CLONE_VM),
   the child is alive across the parent's mremap, and the parent waits it out. */
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  long page = sysconf(_SC_PAGESIZE);
  int pipefd[2];
  if (pipe(pipefd) != 0) return 1;
  pid_t child = fork();
  if (child < 0) return 2;
  if (child == 0) {
    close(pipefd[1]);
    char token;
    /* stay alive until the parent starts its remap */
    if (read(pipefd[0], &token, 1) != 1) _exit(3);
    _exit(0);
  }
  close(pipefd[0]);
  size_t old_size = 33 * page, new_size = 65 * page;
  char *p = mmap(NULL, old_size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED) return 4;
  memset(p, 'A', old_size);
  char token = 'x';
  if (write(pipefd[1], &token, 1) != 1) return 5;   /* child now runnable/live */
  char *q = mremap(p, old_size, new_size, MREMAP_MAYMOVE);
  if (q == MAP_FAILED) return 6;
  close(pipefd[1]);
  int status = 0;
  if (waitpid(child, &status, 0) != child) return 7;
  return (q[0] == 'A' && WIFEXITED(status)) ? 0 : 8;
}
"""


CHILD_MOVED_C = r'''
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void){
  long page=sysconf(_SC_PAGESIZE);
  size_t old_size=33*page, new_size=65*page;
  char *p=mmap(NULL,old_size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(p==MAP_FAILED) return 1;
  memset(p,'A',old_size);
  char *q=mremap(p,old_size,new_size,MREMAP_MAYMOVE);
  if(q==MAP_FAILED) return 2;
  return 0;
}
'''

CHILD_FIXED_C = r'''
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void){
  long page=sysconf(_SC_PAGESIZE);
  size_t old_size=33*page, new_size=65*page;
  char *p=mmap(NULL,old_size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(p==MAP_FAILED) return 1;
  memset(p,'A',old_size);
  void *dest=mmap(NULL,new_size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(dest==MAP_FAILED) return 2;
  munmap(dest,new_size);
  char *q=mremap(p,old_size,new_size,MREMAP_MAYMOVE|MREMAP_FIXED,dest);
  if(q==MAP_FAILED) return 3;
  return 0;
}
'''

CHILD_RX_C = r'''
/* RX-source mremap negative: map a caller-owned READONLY file with PROT_EXEC,
   which the policy allows (file-backed RX mmap), then mremap that mapping so the
   refusual comes from the REMAP guard rather than an earlier mprotect guard. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 2) return 1;
  long page = sysconf(_SC_PAGESIZE);
  int fd = open(argv[1], O_RDONLY);
  if (fd < 0) return 2;
  size_t map_size = 33 * page;
  char *p = mmap(NULL, map_size, PROT_READ | PROT_EXEC, MAP_PRIVATE, fd, 0);
  if (p == MAP_FAILED) return 3;
  /* the mapping is file-backed RX; neither mprotect nor anonymous X is used */
  char *q = mremap(p, map_size, 65 * page, MREMAP_MAYMOVE);
  return q == MAP_FAILED ? 4 : 0;
}
'''


def cc():
    """A real C compiler is REQUIRED. NATIVE_LEASE_CC/CC first, then known names.

    No silent fallback and no None: a missing compiler or a compile error is a
    real failure of this test, because the whole point is to exercise a real
    compiled child through the real observer.
    """
    for name in (os.environ.get('NATIVE_LEASE_CC'), os.environ.get('CC'),
                 'clang-19', 'clang', 'cc', 'gcc'):
        if not name:
            continue
        path = shutil.which(name)
        if path:
            return path
    raise AssertionError('no C compiler (set NATIVE_LEASE_CC or CC); '
                         'this test must not silently skip')


def build(source, directory, name):
    compiler = cc()
    src = Path(directory) / (name + '.c')
    binary = Path(directory) / name
    src.write_text(source)
    import subprocess
    done = subprocess.run([compiler, '-O0', '-o', str(binary), str(src)],
                          capture_output=True, text=True)
    if done.returncode != 0:
        raise AssertionError('compile failed for %s: %s' % (name, done.stderr[-2000:]))
    if not binary.exists():
        raise AssertionError('compiler produced no binary for %s' % name)
    return str(binary)


def make_observer(originals, trusted_root):
    """Real base Observer + the SDK's own native lease DI decision.

    `SdkExecutionObserver` is the single place that selects the native backend
    (`lifetime_leases_class = SdkLeaseSet`). We reuse exactly that class
    attribute rather than constructing SdkExecutionObserver (whose phase()
    pins a fixed build argv) or faking a backend.
    """
    # Canonical profile, loaded through the SAME factory production uses:
    # maximum_file_bytes is the profile's shardBytes, never a fixture-local copy.
    limits = obs.load_sdk_execution_limits()
    observer = obs.Observer(
        originals, ROOT, trusted_root,
        deadline_monotonic=time.monotonic() + 120,
        maximum_bytes=256 * 1024 * 1024,
        maximum_file_bytes=limits['shardBytes'],
        maximum_stdio_bytes=2 * 1024 * 1024,
        selected_names=None,
        shared_tasks=True,
        capture_toolchain=True,
        capture_content_entities=True,
        generated_vma_output=True,
        generated_vma_shared_mm=True,
        generated_vma_private_wake=True,
        generated_vma_private_wait_mismatch=True,
        generated_vma_coordinated_wait=True,
        generated_vma_parked_wait=True,
        stopped_writer_aliases=True,
        queued_identity_noop=True,
        verified_identity_noop=True,
        terminal_exit_evidence=True,
        serialize_terminal_syscalls=True,
        retained_generated_metadata=True,
        capture_maps_content_entities=True,
        indexed_raw_records=True,
        compressed_raw=True,
        generated_build_root=trusted_root,
        deny_optional_io_uring=True)
    observer.lifetime_leases_class = obs.SdkExecutionObserver.lifetime_leases_class
    return observer


def _become_subreaper():
    """Linux PR_SET_CHILD_SUBREAPER (36) so orphaned descendants re-parent here."""
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER unavailable')


__WALL = 0x40000000
# Unmangled alias: names with two leading underscores are name-mangled when
# referenced from inside a class body.
WALL_FLAG = __WALL
_PTRACE_EVENT_STOP = 128
_PTRACE_EVENT_EXIT = 6


def _owned_children():
    try:
        with open('/proc/self/task/%d/children' % os.getpid(), 'rb') as source:
            return [int(value) for value in source.read().split()]
    except OSError:
        return []


def _resume_owned_exit_stop(pid, status):
    """Release a real PTRACE_EVENT_EXIT stop on a task WE are tracing.

    The task cannot exit until its tracer continues it. Only called for a pid
    just returned by our own waitpid, never for a guessed PID list.
    """
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    # Deliver SIGKILL at the same time so a task that was about to run again
    # still terminates; PTRACE_CONT resumes past the exit-stop either way.
    if libc.ptrace(7, ctypes.c_int(pid), None, ctypes.c_void_p(signal.SIGKILL)) != 0:
        raise OSError(ctypes.get_errno(), 'PTRACE_CONT failed for %d' % pid)


def _reap_all(deadline_seconds=30):
    """Real owned wait/ECHILD cleanup that also releases traced exit-stops.

    A ptrace-owned tracee signals PTRACE_EVENT_EXIT as a STOPPED status (e.g.
    0x6057f). That is not a reap: the task stays stopped until its tracer
    continues it. We therefore resume such stops with SIGKILL and keep waiting
    for a real WIFEXITED/WIFSIGNALED status, up to one bounded deadline.
    """
    seen = []
    resumed = []
    end = time.monotonic() + deadline_seconds
    while True:
        if time.monotonic() > end:
            raise AssertionError('owned descendant cleanup deadline: seen=%r resumed=%r'
                                 % (seen, resumed))
        try:
            pid, status = os.waitpid(-1, os.WNOHANG | __WALL)
        except ChildProcessError:
            return dict(reaped=seen, resumed=resumed)
        if pid == 0:
            if _owned_children():
                time.sleep(0.005)
                continue
            return dict(reaped=seen, resumed=resumed)
        if os.WIFSTOPPED(status):
            # a stop is evidence, not closure; release it and keep waiting
            resumed.append({'pid': pid, 'stopStatus': status,
                            'event': status >> 16, 'signal': os.WSTOPSIG(status)})
            _resume_owned_exit_stop(pid, status)
            continue
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            seen.append({'pid': pid, 'waitStatus': status})
            continue
        raise AssertionError('unexpected owned wait status %r for pid %d' % (status, pid))


class EndToEnd(unittest.TestCase):
    _all_receipts = []
    """One real phase per case; the verifier replays the produced raw shard."""

    def setUp(self):
        if not _LINUX:
            raise AssertionError('test_sdk70_mremap_e2e requires real Linux; '
                                 'host=%s is not supported and must not be reported as pass'
                                 % sys.platform)
        self.tmp = tempfile.TemporaryDirectory(prefix='mremap-e2e-',
                                               dir=ROOT / '.test-data')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'bin').mkdir(exist_ok=True)
        self.trusted_roots = {}
        self.wire_refs = {}
        if not getattr(EndToEnd, '_subreaper', False):
            _become_subreaper()
            EndToEnd._subreaper = True
        self.receipts = []
        self.readonly_inputs = []
        EndToEnd._all_receipts.append(self.receipts)

    def _run_phase(self, binary, label, *, keep=True, args=()):
        """One REAL observer phase. All SDK-normal options; explicit trusted root.

        The caller-owned build root is passed EXPLICITLY to the constructor; the
        same trusted caller value is later passed to bindings.observe(). The
        verifier never infers its trusted root from the untrusted raw declaration.
        """
        out = self.root / label
        out.mkdir(exist_ok=False)
        originals = out / 'originals'
        originals.mkdir()
        build_dir = out / 'build'
        build_dir.mkdir()
        trusted_root = str(build_dir.resolve())     # explicit canonical absolute
        self.trusted_roots[label] = trusted_root
        observer = make_observer(originals, trusted_root)
        phase = None
        error = None
        try:
            phase = observer.phase('configure', [binary, *args],
                                   time.monotonic() + 120,
                                   cwd=str(ROOT),
                                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        except BaseException as exc:
            error = exc
            raise
        finally:
            try:
                # The base Observer delegates wait/ECHILD to its PID1 owner, which
                # a test process is not. Perform the real owned cleanup here and
                # fail if anything survives, instead of leaving stale stops that
                # pollute the next case.
                observer.close()
            finally:
                cleanup = _reap_all(); leftovers = cleanup
                self.receipts.append(dict(label=label, phase='cleanup',
                                          reaped=leftovers['reaped'], resumed=leftovers['resumed'], error=type(error).__name__
                                          if error else None))
                if keep:
                    self._keep_witness(out, label)
        shards = [Path(ref['path']) for ref in phase['rawTraceShards']]
        self.wire_refs[label] = {str(Path(ref['path'])): ref
                                 for ref in phase['rawTraceShards']}
        if keep:
            self._keep_witness(out, label)
        return originals, shards, phase

    def _keep_witness(self, out, label):
        target = os.environ.get('SDK70_KEEP_DIR')
        if not target:
            return
        try:
            witness = Path(target) / label
            witness.mkdir(parents=True, exist_ok=True)
            for path in out.rglob('*'):
                if not path.is_file():
                    continue
                relative = path.relative_to(out)          # keep the tree, never flatten
                destination = witness / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
        except OSError as exc:
            # Witness copying is diagnostics-only and must never change the test
            # verdict, but a failure is recorded rather than silently dropped.
            self.receipts.append(dict(label=label, phase='witness',
                                      error=type(exc).__name__, detail=str(exc)))

    def _shard_blocks(self, path):
        """Yield one shard as bounded 64 KiB physical blocks (production bound)."""
        with open(path, 'rb') as stream:
            while True:
                block = stream.read(65536)
                if not block:
                    break
                yield block

    def _wire_reference(self, path, label):
        ref = self.wire_refs[label][str(path)]
        if 'wire' in ref:
            return ref
        raise AssertionError('shard lacks its production wire reference: %r' % str(path))

    def _replay(self, shards, originals, limits=None, label=None):
        """Replay through PRODUCTION raw wire: gzip -> verified logical records."""
        trust = self.trusted_roots.get(label or '')
        # Replay must read the SAME canonical profile the producer used. A local
        # 2 MiB default here silently rejected captures the producer legitimately
        # took under shardBytes (the x64 padded-ELF regression).
        canonical = obs.load_sdk_execution_limits()
        # Harness-only: the replay byte budget must match the declared source
        # profile, not a stale 256 MiB fixture copy. No product value changes.
        limits = limits or dict(sourceMaterialBytes=canonical['sourceMaterialBytes'],
                                shardBytes=canonical['shardBytes'])

        def read_original(name, maximum):
            # Preserve production capture layout (chunk subdirs) and stream in
            # bounded 64 KiB pieces so a chunked reader is not forced to one
            # whole-file read.
            relative = str(name)
            base = Path(originals).resolve()
            candidate = (base / relative).resolve()
            if candidate != base and not str(candidate).startswith(str(base) + os.sep):
                raise AssertionError('capture reference escaped the owned capture dir: %r' % relative)
            remaining = maximum
            with open(candidate, 'rb') as stream:
                while True:
                    block = stream.read(65536)
                    if not block:
                        break
                    remaining -= len(block)
                    if remaining < 0:
                        raise AssertionError('capture original exceeds its bound')
                    yield block

        def logical_records():
            # ONE decoder per phase: the index dictionary spans shards, so a
            # per-file decoder would lose schema state.
            for path in shards:
                for record in rawwire.iter_shard_records(
                        self._shard_blocks(path), self._wire_reference(path, label),
                        check=lambda: None,
                        maximum_encoded=limits['shardBytes'],
                        maximum_logical=limits['shardBytes']):
                    yield record

        kwargs = {}
        if trust is not None:
            kwargs['generated_build_root'] = trust
        return bindings.observe([('configure', logical_records())], read_original,
                                {}, limits=limits, **kwargs)

    # ---- production wire decode/encode for semantic mutations ------------
    def _decode_rows(self, shards, label):
        """Decode ALL shards of one phase with a SINGLE production decoder."""
        if isinstance(shards, (str, Path)):
            shards = [shards]
        decoder = rawcodec.RawRecordDecoder()
        rows = []
        for path in shards:
            for record in rawwire.iter_shard_records(
                    self._shard_blocks(path), self._wire_reference(path, label),
                    check=lambda: None,
                    maximum_encoded=obs.load_sdk_execution_limits()['shardBytes'],
                    maximum_logical=obs.load_sdk_execution_limits()['shardBytes']):
                row = decoder.feed(record)
                if row is not None:
                    rows.append((path, row))
        return decoder, rows

    def _reencode_semantic(self, shards, label, kind, transform, tag):
        """Decode with the production codec, mutate semantic rows, re-encode.

        Rows are re-emitted through the real IndexedRawEncoderV2 and written by
        the real gzip RawWriter, so each new shard carries a genuine raw-frame
        wire reference. Returns (new_shards, changed_targets, new_label).
        """
        out = self.root / (tag + '-mut')
        out.mkdir(exist_ok=True)
        decoder, rows = self._decode_rows(shards, label)
        if decoder.model not in (rawcodec.RAW_RECORD_MODEL, rawcodec.RAW_RECORD_MODEL_V2):
            raise AssertionError('production shard is not an indexed wire stream')
        by_shard = {}
        changed = 0
        for path, row in rows:
            row = dict(row)
            if row.get('kind') == kind:
                before = json.dumps(row, sort_keys=True)
                row = transform(dict(row))
                if json.dumps(row, sort_keys=True) != before:
                    changed += 1
            by_shard.setdefault(path, []).append(row)
        new_label = tag + '-mut'
        self.wire_refs[new_label] = {}
        self.trusted_roots.setdefault(new_label, self.trusted_roots[label])
        produced = []
        # ONE encoder for the PHASE: the indexed schema dictionary spans shards
        # exactly as the producer's did; resetting per file would silently change
        # the declared transport model.
        encoder = rawcodec.IndexedRawEncoderV2()
        wire_bound = obs.load_sdk_execution_limits()['shardBytes']
        for path in shards:
            target = out / path.name
            writer = rawwriter.RawWriter(target, claim=lambda n: None,
                                         check=lambda: None,
                                         maximum_logical=wire_bound,
                                         maximum_encoded=wire_bound)
            for row in by_shard.get(path, []):
                for part in encoder.encode(row):
                    writer.write_record(part)
            wire = writer.finish()
            produced.append(target)
            size = target.stat().st_size
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            self.wire_refs[new_label][str(target)] = {
                'path': str(target), 'bytes': size, 'sha256': digest, 'wire': wire}
        return produced, changed, new_label

    # ---- positives -------------------------------------------------------
    def _kinds(self, shards, label):
        _decoder, rows = self._decode_rows(shards, label)
        return [row.get('kind') for _path, row in rows]

    def test_real_moved_mremap_is_accepted_by_the_real_verifier(self):
        binary = build(CHILD_MOVED_C, self.root / 'bin', 'moved')
        originals, shards, _ = self._run_phase(binary, 'moved')
        kinds = self._kinds(shards, 'moved')
        self.assertIn('executable-memory-remap-allowed', kinds,
                      'observer did not exercise the capability at all')
        self.assertIn('exclusive-remap-resume', kinds)
        self.assertIn('executable-memory-remap-verified', kinds)
        report = self._replay(shards, originals, label='moved')
        self.assertTrue(report is not None)

    def test_real_glibc_style_realloc_child_is_accepted(self):
        binary = build(CHILD_C, self.root / 'bin', 'plain')
        originals, shards, _ = self._run_phase(binary, 'plain')
        report = self._replay(shards, originals, label='plain')
        self.assertTrue(report is not None)

    def test_independent_process_peer_does_not_block_the_capability(self):
        """REAL independence: fork() gives the child its own MM.

        Asserts the independent child is actually tracked as a separate process
        with a DISTINCT memory domain, and that the owner's mremap cohort still
        excludes it. A label alone is not evidence.
        """
        binary = build(CHILD_FORK_C, self.root / 'bin', 'forked')
        originals, shards, _ = self._run_phase(binary, 'indep')
        report = self._replay(shards, originals, label='indep')
        self.assertTrue(report is not None)
        _decoder, rows = self._decode_rows(shards, 'indep')
        kinds = [row.get('kind') for _path, row in rows]
        self.assertIn('owned-root-binding', kinds)
        bindings_rows = [row for _path, row in rows if row.get('kind') == 'actual-child-binding']
        self.assertTrue(bindings_rows, 'fork child was never bound as an actual child')
        # actual-child-binding carries parentPid/childPid, not a scalar 'pid'.
        tracked = {row['parentPid'] for row in bindings_rows}
        tracked.update(row['childPid'] for row in bindings_rows)
        tracked.update(row['pid'] for _path, row in rows if row.get('kind') == 'owned-root-binding')
        self.assertGreaterEqual(len(tracked), 2, 'only one process was tracked')
        allow = next((row for _path, row in rows
                      if row.get('kind') == 'executable-memory-remap-allowed'), None)
        self.assertIsNotNone(allow, 'owner never reached the capability')
        child_pids = {row['childPid'] for row in bindings_rows}
        self.assertTrue(child_pids, 'fork produced no bound child pid')
        self.assertFalse(child_pids & set(allow['memoryDomainMembers']),
                         'independent fork child must not join the owner MM cohort')
        # the owner's domain must differ from the child's
        domains = {}
        for _path, row in rows:
            if row.get('kind') == 'generated-vma-operation-window':
                domains[row['pid']] = row.get('memoryDomain')
        if len(domains) >= 2:
            self.assertGreaterEqual(len(set(domains.values())), 2,
                                    'fork child shares the owner memory domain')

    def test_real_oversize_tool_fd_is_captured_under_canonical_bound(self):
        """REGRESSION: a >2MiB native tool FD must be captured, not refused.

        The x64 CI failures were `bounded regular tool FD required`: the fixture
        carried a hardcoded 2 MiB tool-FD bound while the canonical profile sets
        `shardBytes` (512 MiB). This compiles a REAL native ELF, appends >=3 MiB
        of harmless trailing padding BEFORE the observer opens it, and runs the
        actual existing `_run_phase`/`make_observer` path.

        It must FAIL against a fixture that keeps the 2 MiB literal, and pass
        with the canonical bound, on native Linux (ARM64 locally, x64 in CI).
        """
        limits = obs.load_sdk_execution_limits()
        binary = build(CHILD_C, self.root / 'bin', 'oversize-tool')
        # Padding BEFORE the observer ever opens the file, so the FD size is
        # genuinely over the legacy 2 MiB bound when tool_original runs.
        with open(binary, 'ab') as stream:
            stream.write(b'\0' * (3 * 1024 * 1024))
        size = os.path.getsize(binary)
        self.assertGreater(size, 2 * 1024 * 1024,
                           'padding did not exceed the legacy 2 MiB fixture bound')
        self.assertLessEqual(size, limits['shardBytes'],
                             'padding must stay inside the canonical profile bound')

        originals, shards, phase = self._run_phase(binary, 'oversize-tool')
        # the real command must have completed successfully
        receipt = phase['commandReceipt']
        self.assertEqual(receipt['exit'], 0,
                         'padded native tool command did not exit 0')
        # and the production raw replay must accept the real stream
        report = self._replay(shards, originals, label='oversize-tool')
        self.assertIsNotNone(report)
        # bind the ACTUAL captured tool original bytes above the legacy bound
        _decoder, rows = self._decode_rows(shards, 'oversize-tool')
        captured = [row['original'] for _path, row in rows
                    if row.get('kind') == 'toolchain-original'
                    and row.get('captureKind') == 'file']
        self.assertTrue(captured, 'no toolchain file original was captured')
        biggest = max(item['bytes'] for item in captured)
        self.assertGreater(biggest, 2 * 1024 * 1024,
                           'captured tool original never exceeded the legacy 2 MiB bound')
        self.assertLessEqual(biggest, limits['shardBytes'])

    def test_every_syscall_follows_its_pids_authority_sample(self):
        """INVARIANT (positive): authority samples precede syscall rows.

        The consumer interval (sdk-tool-provider-originals.py:633) requires
        `pid in samples` before it replays a `kernel-syscall` row. This asserts
        that invariant over a REAL multi-process phase.

        HONESTY: this is an invariant POSITIVE, not a guaranteed negative control.
        A single-process child cannot reproduce the original race at all, so this
        case uses the existing forking fixture and requires at least two sampled
        pids to actually exercise parent/child authority capture. Whether the old
        scheduling would fail here depends on timing; the deterministic scheduling
        evidence lives in
        `test_sdk70_mremap_observer.AuthorityDrainOrder`, which the actual baseline
        producer fails by construction. Root's three real Ninja raw replays supply
        the real-scope evidence.
        """
        binary = build(CHILD_FORK_C, self.root / 'bin', 'authority-order')
        _originals, shards, phase = self._run_phase(binary, 'authority-order')
        _decoder, rows = self._decode_rows(shards, 'authority-order')

        sampled = {}
        violations = []
        syscalls = 0
        for _path, row in rows:
            kind = row.get('kind')
            pid = row.get('pid')
            if kind == 'toolchain-process-authority':
                sampled.setdefault(pid, row['sequence'])
            elif kind == 'kernel-syscall':
                syscalls += 1
                first = sampled.get(pid)
                if first is None or first > row['sequence']:
                    violations.append((row['sequence'], pid, first))
        self.assertGreaterEqual(len(sampled), 2,
                                'the fixture must exercise parent AND child authority '
                                'capture; sampled pids: %r' % (sorted(sampled),))
        self.assertGreater(syscalls, 0, 'the phase produced no syscall rows')
        self.assertEqual(violations, [],
                         'syscall rows preceded their pid authority sample: %r'
                         % (violations[:5],))
        self.assertEqual(phase['commandReceipt']['exit'], 0)

    def test_real_shared_mm_peer_is_in_the_derived_cohort(self):
        """A real pthread peer (same CLONE_VM domain) must appear in the cohort."""
        binary = build(CHILD_THREADED_C, self.root / 'bin', 'threaded')
        originals, shards, _ = self._run_phase(binary, 'threaded')
        _decoder, rows = self._decode_rows(shards, 'threaded')
        allow = next((r for _path, r in rows
                      if r.get('kind') == 'executable-memory-remap-allowed'), None)
        self.assertIsNotNone(allow, 'real threaded child did not reach the capability')
        self.assertGreaterEqual(len(allow['memoryDomainMembers']), 2,
                                'a real pthread peer must join the same-MM cohort')
        self.assertTrue(allow['cohortMaps'], 'peer maps must be captured for a real peer')
        report = self._replay(shards, originals, label='threaded')
        self.assertTrue(report is not None)

    # ---- G1/G2 raw mutation negatives (semantic, production codec) ------
    def _positive(self):
        """Cache ONE real positive producer stream per case family."""
        if getattr(self, '_cached', None) is None:
            binary = build(CHILD_THREADED_C, self.root / 'bin', 'cached-positive')
            self._cached = self._run_phase(binary, 'cached-positive')
        return self._cached

    def _expect_reject(self, shards, originals, label, expected_reason=None):
        """The real verifier signals refusal from need(), which raises ValueError.

        Only ValueError is accepted: AttributeError/TypeError/KeyError indicate a
        fixture or internal error and must NOT be mistaken for a semantic
        rejection. When expected_reason is given it must appear in the message.
        """
        with self.assertRaises(ValueError) as caught:
            self._replay(shards, originals, label=label)
        if expected_reason is not None:
            self.assertIn(expected_reason, str(caught.exception))

    def test_positive_stream_replays_and_declares_capability(self):
        originals, shards, phase = self._positive()
        report = self._replay(shards, originals, label='cached-positive')
        self.assertTrue(report is not None)

    def test_rejects_omitted_same_mm_peer_from_both_lists(self):
        originals, shards, _ = self._positive()
        def strip(row):
            row['memoryDomainMembers'] = row['memoryDomainMembers'][:1]
            row['cohortMaps'] = []
            return row
        forged, changed, new_label = self._reencode_semantic(
            shards, 'cached-positive', 'executable-memory-remap-allowed', strip, 'omit-peer')
        self.assertGreater(changed, 0, 'mutation was a no-op; it would prove nothing')
        self._expect_reject(forged, originals, new_label)

    def test_rejects_foreign_memory_domain(self):
        originals, shards, _ = self._positive()
        def forge(row):
            row['memoryDomain'] = row['memoryDomain'] + 1
            return row
        forged, changed, new_label = self._reencode_semantic(
            shards, 'cached-positive', 'executable-memory-remap-allowed', forge, 'foreign-domain')
        self.assertGreater(changed, 0)
        self._expect_reject(forged, originals, new_label)

    def test_rejects_reused_entry_maps_at_exit(self):
        originals, shards, _ = self._positive()
        _, rows0 = self._decode_rows(shards, 'cached-positive')
        allow = next((r for _path, r in rows0
                      if r.get('kind') == 'executable-memory-remap-allowed'), None)
        self.assertIsNotNone(allow, 'no allowance row in the cached stream')
        def steal(row):
            row['ownerMaps'] = dict(allow['ownerMaps'])
            row['cohortMaps'] = [dict(item) for item in allow['cohortMaps']]
            return row
        forged, changed, new_label = self._reencode_semantic(
            shards, 'cached-positive', 'executable-memory-remap-verified', steal, 'stale-maps')
        self.assertGreater(changed, 0)
        self._expect_reject(forged, originals, new_label)

    def test_rejects_missing_maps_capture_record(self):
        originals, shards, _ = self._positive()
        def drop(row):
            row['ownerMaps'] = dict(row['ownerMaps'])
            row['ownerMaps']['sha256'] = '0' * 64
            return row
        forged, changed, new_label = self._reencode_semantic(
            shards, 'cached-positive', 'executable-memory-remap-allowed', drop, 'no-capture')
        self.assertGreater(changed, 0)
        self._expect_reject(forged, originals, new_label)

    def _rows_of(self, shards, label, kind):
        _decoder, rows = self._decode_rows(shards, label)
        return [(path, row) for path, row in rows if row.get('kind') == kind]

    def test_unmodified_roundtrip_is_accepted(self):
        """Generator self-check: a no-op re-encode must still be accepted.

        If this fails, every semantic negative below could be a false transport
        failure rather than a real domain rejection.
        """
        originals, shards, _ = self._positive()
        def identity(row):
            return dict(row)
        roundtrip, changed, label = self._reencode_semantic(
            shards, 'cached-positive', 'kernel-syscall', identity, 'roundtrip')
        self.assertEqual(changed, 0, 'no-op transform must not alter any row')
        report = self._replay(roundtrip, originals, label=label)
        self.assertTrue(report is not None, 'unmodified re-encode was rejected')

    def test_rejects_missing_allowance(self):
        originals, shards, _ = self._positive()
        target = self.root / 'no-allow-mut'
        target.mkdir(exist_ok=True)
        decoder, rows = self._decode_rows(shards, 'cached-positive')
        out, encoder = [], rawcodec.IndexedRawEncoderV2()
        self.wire_refs['no-allow-mut'] = {}
        removed = 0
        by_shard = {}
        for path, row in rows:
            if row.get('kind') == 'executable-memory-remap-allowed':
                removed += 1
                continue
            by_shard.setdefault(path, []).append(row)
        for path in shards:
            dest = target / path.name
            writer = rawwriter.RawWriter(dest, claim=lambda n: None, check=lambda: None,
                                         maximum_logical=2*1024*1024, maximum_encoded=2*1024*1024)
            for row in by_shard.get(path, []):
                for part in encoder.encode(row):
                    writer.write_record(part)
            wire = writer.finish(); out.append(dest)
            self.wire_refs['no-allow-mut'][str(dest)] = dict(
                path=str(dest), bytes=dest.stat().st_size,
                sha256=hashlib.sha256(dest.read_bytes()).hexdigest(), wire=wire)
        self.assertGreater(removed, 0, 'no allowance row to remove')
        self._expect_reject(out, originals, 'no-allow-mut')

    def test_rejects_missing_exclusive_resume(self):
        originals, shards, _ = self._positive()
        target = self.root / 'no-resume-mut'
        target.mkdir(exist_ok=True)
        decoder, rows = self._decode_rows(shards, 'cached-positive')
        out, encoder = [], rawcodec.IndexedRawEncoderV2()
        self.wire_refs['no-resume-mut'] = {}
        removed = 0
        by_shard = {}
        for path, row in rows:
            if row.get('kind') == 'exclusive-remap-resume':
                removed += 1
                continue
            by_shard.setdefault(path, []).append(row)
        for path in shards:
            dest = target / path.name
            writer = rawwriter.RawWriter(dest, claim=lambda n: None, check=lambda: None,
                                         maximum_logical=2*1024*1024, maximum_encoded=2*1024*1024)
            for row in by_shard.get(path, []):
                for part in encoder.encode(row):
                    writer.write_record(part)
            wire = writer.finish(); out.append(dest)
            self.wire_refs['no-resume-mut'][str(dest)] = dict(
                path=str(dest), bytes=dest.stat().st_size,
                sha256=hashlib.sha256(dest.read_bytes()).hexdigest(), wire=wire)
        self.assertGreater(removed, 0, 'no exclusive resume row to remove')
        self._expect_reject(out, originals, 'no-resume-mut')

    def test_rejects_forged_source_range(self):
        originals, shards, _ = self._positive()
        def forge(row):
            row['range'] = [row['range'][0], row['range'][1] + 4096]
            return row
        forged, changed, label = self._reencode_semantic(
            shards, 'cached-positive', 'executable-memory-remap-allowed', forge, 'forged-range')
        self.assertGreater(changed, 0)
        self._expect_reject(forged, originals, label, 'mremap range differs')

    def test_rejects_forged_new_base(self):
        originals, shards, _ = self._positive()
        def forge(row):
            row['newBase'] = row['newBase'] + 4096
            row['newRange'] = [row['newBase'], row['newRange'][1] + 4096]
            return row
        forged, changed, label = self._reencode_semantic(
            shards, 'cached-positive', 'executable-memory-remap-verified', forge, 'forged-base')
        self.assertGreater(changed, 0)
        self._expect_reject(forged, originals, label, 'mremap verification result differs')

    def test_rejects_maps_before_the_allowance_barrier(self):
        """Substitute a REAL earlier owner-maps capture from before the barrier."""
        originals, shards, _ = self._positive()
        decoder, rows = self._decode_rows(shards, 'cached-positive')
        allow = next((r for _p, r in rows
                      if r.get('kind') == 'executable-memory-remap-allowed'), None)
        self.assertIsNotNone(allow, 'no allowance row')
        barrier_seq = allow['barrierSequence']
        candidates = [
            r for _p, r in rows
            if r.get('kind') == 'toolchain-original' and r.get('captureKind') == 'maps'
            and r.get('observedPid') == allow['pid']
            and r.get('sequence', 0) < barrier_seq
            and r['original'] != allow['ownerMaps']]
        self.assertTrue(candidates,
                        'no genuine earlier owner-maps capture available for the window test')
        earlier = candidates[-1]['original']
        def substitute(row):
            row['ownerMaps'] = dict(earlier)
            return row
        forged, changed, label = self._reencode_semantic(
            shards, 'cached-positive', 'executable-memory-remap-allowed', substitute, 'pre-barrier-maps')
        self.assertGreater(changed, 0)
        self._expect_reject(forged, originals, label)

    def test_rejects_removed_verified_close(self):
        """Integrity-level negative: the verified row disappears entirely."""
        originals, shards, _ = self._positive()
        decoder, rows = self._decode_rows(shards, 'cached-positive')
        out = self.root / 'no-verified-mut'
        out.mkdir(exist_ok=True)
        self.wire_refs['no-verified-mut'] = {}
        removed = 0
        by_shard = {}
        for path, row in rows:
            if row.get('kind') == 'executable-memory-remap-verified':
                removed += 1
                continue
            by_shard.setdefault(path, []).append(row)
        produced = []
        encoder = rawcodec.IndexedRawEncoderV2()   # one per phase, spans shards
        wire_bound = obs.load_sdk_execution_limits()['shardBytes']
        for path in shards:
            target = out / path.name
            writer = rawwriter.RawWriter(target, claim=lambda n: None, check=lambda: None,
                                         maximum_logical=wire_bound,
                                         maximum_encoded=wire_bound)
            for row in by_shard.get(path, []):
                for part in encoder.encode(row):
                    writer.write_record(part)
            wire = writer.finish()
            produced.append(target)
            self.wire_refs['no-verified-mut'][str(target)] = {
                'path': str(target), 'bytes': target.stat().st_size,
                'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'wire': wire}
        self.assertGreater(removed, 0, 'no verified row existed to remove')
        self._expect_reject(produced, originals, 'no-verified-mut')

    # ---- policy negatives that must still refuse at entry ---------------
    def test_real_fixed_remap_is_refused(self):
        binary = build(CHILD_FIXED_C, self.root / 'bin', 'fixed')
        with self.assertRaises(ValueError) as caught:
            self._run_phase(binary, 'fixed')
        # The observer refuses with the ORIGINAL decision() reason; the
        # shape-specific 'fixed-destination-refused' reason belongs to the pure
        # predicate tests, not the observer path.
        self.assertIn('memory-remap-outside-fixed-executable-mapping-scope',
                      str(caught.exception))
        self.assertNotIn('mremapPending', getattr(self, 'receipts', []))

    def test_real_executable_source_range_is_refused(self):
        """RX guard: a leased file-backed RX mmap is later mremapped.

        The file is created as a declared test input BEFORE the observed phase so
        its byte provenance and the normal lease enforcement apply. The refusal
        must come from the remap guard, not from mprotect or anonymous exec.
        """
        binary = build(CHILD_RX_C, self.root / 'bin', 'rx')
        declared = self.root / 'declared-rx-input.bin'
        declared.write_bytes(b'R' * (33 * 4096))
        self.readonly_inputs.append(dict(path=str(declared),
                                         bytes=declared.stat().st_size,
                                         sha256=hashlib.sha256(declared.read_bytes()).hexdigest()))
        with self.assertRaises(ValueError) as caught:
            self._run_phase(binary, 'rx', args=[str(declared)])
        message = str(caught.exception)
        self.assertIn('memory-remap', message,
                      'refusal must come from the remap guard, got: %s' % message)
        self.assertNotIn('explicit-protection-to-executable-transition', message)
        # After an expected refusal no owned descendant may survive: prove it with
        # a real ECHILD observation, not a flag.
        try:
            os.waitpid(-1, os.WNOHANG | WALL_FLAG)
        except ChildProcessError:
            self.receipts.append(dict(label='rx', phase='post-refusal', echild=True))
        else:
            self.fail('owned child survived the expected refusal (waitpid did not raise ECHILD)')

if __name__ == '__main__':
    # Every case must run; the suite exit status aggregates the real results.
    # Per-case receipts (incl. reaped descendants) are kept on the instance and
    # written next to any SDK70_KEEP_DIR witness for root diagnosis.
    runner = unittest.TextTestRunner(verbosity=2)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(EndToEnd)
    result = runner.run(suite)
    keep = os.environ.get('SDK70_KEEP_DIR')
    if keep:
        summary = dict(testsRun=result.testsRun,
                       failures=len(result.failures),
                       errors=len(result.errors),
                       skipped=len(result.skipped),
                       cases=[dict(name=str(case),
                                   cleanup=getattr(case, 'receipts', []),
                                   readonlyInputs=getattr(case, 'readonly_inputs', []))
                              for case in (t for t in suite._tests)],
                       accumulated=[r for group in EndToEnd._all_receipts for r in group])
        target = Path(keep) / 'suite-receipt.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(summary, indent=1))
    raise SystemExit(0 if result.wasSuccessful() else 1)
