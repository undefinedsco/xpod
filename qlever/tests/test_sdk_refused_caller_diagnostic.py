"""Bounded refused-caller diagnostic: real branch, bounded inputs, unchanged raw row.

The helper is exercised through a fake /proc (open + readlink + stat) so no ptrace,
lease or real process is required. The refusal branch itself is driven directly.
"""
import ast, json, pathlib, sys, textwrap, types, unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_helper():
    """Extract ONLY the two new functions, so the whole observer is not imported."""
    source = (SCRIPTS / 'sdk-ptrace-execution.py').read_text()
    tree = ast.parse(source)
    wanted = {'refused_caller_snapshot', '_overlapping_maps_line'}
    body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
    constants = [n for n in tree.body
                 if isinstance(n, ast.Assign)
                 and any(getattr(t, 'id', '') in {'REFUSED_CALLER_MAX_PATH',
                                                  'REFUSED_CALLER_MAPS_LIMIT'}
                         for t in n.targets)]
    module = ast.Module(body=constants + body, type_ignores=[])
    return source, compile(module, '<helper>', 'exec')


SOURCE, CODE = load_helper()


class FakeProc:
    """Minimal /proc stand-in: exe link, exe stat, and a bounded maps payload."""

    def __init__(self, exe='/usr/bin/clang-19', maps=b'', exe_error=None, maps_error=None):
        self.exe, self.maps = exe, maps
        self.exe_error, self.maps_error = exe_error, maps_error
        self.reads = []

    def build(self):
        fake = self
        class Dir:
            def __enter__(self): return self
            def __exit__(self, *e): return False
        def fake_open(path, *a, **k):
            if path.startswith('/proc/') and path.endswith('/maps'):
                if fake.maps_error: raise fake.maps_error
                return Dir()
            return Dir()
        def fake_read(fd, limit=-1):
            if fake.maps_error: raise fake.maps_error
            fake.reads.append(limit)
            return fake.maps if limit < 0 else fake.maps[:limit]
        def fake_readlink(name, dir_fd=None):
            if fake.exe_error: raise fake.exe_error
            return fake.exe
        def fake_stat(name, dir_fd=None, follow_symlinks=True):
            if fake.exe_error: raise fake.exe_error
            return types.SimpleNamespace(st_dev=1, st_ino=2, st_mode=0o100755,
                                         st_size=3, st_mtime_ns=4, st_ctime_ns=5)
        def fake_close(fd): return None
        return dict(open=fake_open, read=fake_read, readlink=fake_readlink,
                    stat=fake_stat, close=fake_close)


MAPS = b"""\
550000000000-550000001000 r--p 00000000 08:01 1 /usr/bin/clang-19
550000001000-550000002000 r-xp 00001000 08:01 1 /usr/bin/clang-19
7f0000000000-7f0000002000 rw-p 00000000 00:00 0 [heap]
"""


def run(record, maps=MAPS, exe='/usr/bin/clang-19', exe_error=None, maps_error=None):
    fake = FakeProc(exe=exe, maps=maps, exe_error=exe_error, maps_error=maps_error)
    consts = dict(O_RDONLY=0, O_CLOEXEC=0, O_DIRECTORY=0, O_NOFOLLOW=0)
    ns = {'os': types.SimpleNamespace(**consts, **fake.build()), 'check': None}
    exec(CODE, ns)
    return ns['refused_caller_snapshot'](482, record), fake


def rec(nr=25, args=(0x1000, 8192, 4096, 0, 0, 0), arch=0xC000003E):
    return dict(arch=arch, nr=nr, args=list(args), sequence=2004629)


class Snapshot(unittest.TestCase):
    def test_captures_all_six_args(self):
        got, _ = run(rec(args=(0x7f00, 0x2000, 0x1000, 1, 0xdead, 0xbeef)))
        self.assertEqual(got['syscallArgs'], [0x7f00, 0x2000, 0x1000, 1, 0xdead, 0xbeef])
        self.assertTrue(got['syscallArgsComplete'])

    def test_fixed_target_arg5_is_present(self):
        """A fixed-target remap needs arg5; four args would be insufficient."""
        got, _ = run(rec(args=(1, 2, 3, 4, 5, 6)))
        self.assertEqual(got['syscallArgs'][5], 6)

    def test_executable_identity_is_labelled_provenance(self):
        got, _ = run(rec())
        self.assertEqual(got['executable'], '/usr/bin/clang-19')
        self.assertEqual(len(got['executableIdentity']), 6)
        self.assertIn('not held-byte authority', got['executableSource'])

    def test_unreadable_exe_is_tagged_unavailable(self):
        got, _ = run(rec(), exe_error=OSError('gone'))
        self.assertEqual(got['executableSource'], 'unavailable')
        self.assertIsNone(got['executable'])

    def test_overlapping_line_is_not_a_permission_proof(self):
        got, _ = run(rec(args=(0x550000001000, 0x1000, 0, 0, 0, 0)))
        sample = got['mappingSample']
        self.assertEqual(sample['permissions'], 'r-xp')
        self.assertEqual(sample['overlap'], 'contains-address')
        self.assertFalse(got['mappingSampleIsPermissionProof'])
        self.assertFalse(got['mappingSampleIsAtomic'])
        self.assertIn('NOT a range permission proof', got['mappingSampleSource'])

    def test_whole_larger_range_is_not_claimed(self):
        """A range spanning many mappings must not claim the first line covers it."""
        got, _ = run(rec(args=(0x550000000000, 0x7f0000004000 - 0x550000000000, 0, 0, 0, 0)))
        self.assertEqual(got['mappingSample']['overlap'], 'contains-address')
        # the sample is explicitly one line, never the whole range
        self.assertEqual(set(got['mappingSample']),
                         {'range', 'permissions', 'path', 'overlap'})

    def test_absent_range_yields_no_sample(self):
        got, _ = run(rec(args=(0xdead0000, 0x1000, 0, 0, 0, 0)))
        self.assertIsNone(got['mappingSample'])

    def test_truncated_prefix_can_hide_the_mapping(self):
        """A capped prefix may omit the real line; that must read as no sample."""
        got, fake = run(rec(args=(0x7f0000000000, 0x1000, 0, 0, 0, 0)),
                        maps=b'x' * 70000)
        self.assertIsNone(got['mappingSample'])
        self.assertEqual(fake.reads, [65536], 'must read at most 64 KiB, once')

    def test_unreadable_maps_is_tagged_unavailable(self):
        got, _ = run(rec(), maps_error=OSError('gone'))
        self.assertEqual(got['mappingSampleSource'], 'unavailable')
        self.assertIsNone(got['mappingSample'])

    def test_unknown_caller_arguments_are_not_invented(self):
        got, _ = run(dict(arch=0xC000003E, nr=25, args=None))
        self.assertIsNone(got['syscallArgs'])
        self.assertFalse(got['syscallArgsComplete'])
        self.assertIsNone(got['mappingSample'])

    def test_long_paths_are_clipped(self):
        got, _ = run(rec(), exe='/usr/bin/' + 'a' * 4000)
        self.assertLessEqual(len(got['executable']), 512 + 3)


class EncodedSize(unittest.TestCase):
    MAX = 8192

    def test_unicode_and_escaped_paths_fit_encoded_limit(self):
        for character in ('é', '😀', '\udcff'):
            with self.subTest(character=repr(character)):
                record = rec(args=(0x1000, 0x1000, 2**64-1, 2**64-1, 2**64-1, 2**64-1))
                path = '/' + character * 1000
                maps = b'1000-2000 rw-p 0 00:00 0 ' + path.encode('utf-8', 'surrogatepass') + b'\n'
                got, _ = run(record, maps=maps, exe=path)
                payload = dict(arch=record['arch'], nr=record['nr'], pid=482,
                               entrySequence=record['sequence'],
                               reason='memory-remap-outside-fixed-executable-mapping-scope',
                               refusedCaller=got)
                line = 'SDK_EXECUTABLE_MEMORY_REFUSED ' + json.dumps(payload, sort_keys=True, separators=(',', ':'))
                self.assertLessEqual(len(line.encode()), self.MAX)

    def test_maximal_payload_fits_the_existing_bound(self):
        record = rec(args=(2**36, 2**36, 2**36, 2**36, 2**36, 2**36))
        got, _ = run(record, exe='/usr/bin/' + 'x' * 4000)
        payload = dict(arch=record['arch'], nr=record['nr'], pid=482,
                       entrySequence=record['sequence'],
                       reason='memory-remap-outside-fixed-executable-mapping-scope',
                       refusedCaller=got)
        line = 'SDK_EXECUTABLE_MEMORY_REFUSED ' + json.dumps(
            payload, sort_keys=True, separators=(',', ':'))
        self.assertLessEqual(len(line.encode()), self.MAX,
                             'maximal encoded stderr line must stay within 8192')


class ControlExceptions(unittest.TestCase):
    """A real deadline / interpreter exit must not be swallowed by the guards."""

    def test_close_timeout_is_not_swallowed(self):
        sentinel = TimeoutError('actual owned child observation deadline')
        built = FakeProc().build()
        def close(_fd):
            raise sentinel
        built['close'] = close
        ns = {'os': types.SimpleNamespace(O_RDONLY=0, O_CLOEXEC=0, O_DIRECTORY=0, **built)}
        exec(CODE, ns)
        with self.assertRaises(TimeoutError) as caught:
            ns['refused_caller_snapshot'](482, rec())
        self.assertIs(caught.exception, sentinel)

    def _boom(self, exc):
        def boom(*a, **k):
            raise exc
        consts = dict(O_RDONLY=0, O_CLOEXEC=0, O_DIRECTORY=0, O_NOFOLLOW=0)
        fake = FakeProc()
        built = fake.build()
        built['open'] = boom
        ns = {'os': types.SimpleNamespace(**consts, **built), 'check': None}
        exec(CODE, ns)
        return ns['refused_caller_snapshot']

    def test_real_timeout_error_propagates_same_object(self):
        sentinel = TimeoutError('actual owned child observation deadline')
        fn = self._boom(sentinel)
        with self.assertRaises(TimeoutError) as caught:
            fn(482, rec())
        self.assertIs(caught.exception, sentinel)

    def test_keyboard_interrupt_propagates(self):
        sentinel = KeyboardInterrupt()
        fn = self._boom(sentinel)
        with self.assertRaises(KeyboardInterrupt) as caught:
            fn(482, rec())
        self.assertIs(caught.exception, sentinel)

    def test_system_exit_propagates(self):
        sentinel = SystemExit(7)
        fn = self._boom(sentinel)
        with self.assertRaises(SystemExit) as caught:
            fn(482, rec())
        self.assertIs(caught.exception, sentinel)

    def test_programming_error_is_not_swallowed(self):
        """A non-OSError bug must surface, not be converted to 'unavailable'."""
        fn = self._boom(TypeError('actual bug'))
        with self.assertRaises(TypeError):
            fn(482, rec())


class RealBranch(unittest.TestCase):
    """Drive the REAL refusal branch text with a minimal observer stand-in."""

    def setUp(self):
        source = (SCRIPTS / 'sdk-ptrace-execution.py').read_text()
        tree = ast.parse(source)
        wanted = {'refused_caller_snapshot', '_overlapping_maps_line'}
        body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
        constants = [n for n in tree.body if isinstance(n, ast.Assign)
                     and any(getattr(t, 'id', '').startswith('REFUSED_CALLER_') for t in n.targets)]
        self.ns = {'json': json, 'sys': __import__('sys')}
        exec(compile(ast.Module(body=constants + body, type_ignores=[]), '<h>', 'exec'), self.ns)

    def _run_branch(self, reason='memory-remap-outside-fixed-executable-mapping-scope'):
        import io
        emitted = []
        stderr = io.StringIO()
        # the helper resolves 'os' from ITS OWN globals, which is self.ns
        self.ns['os'] = self._fake_os()['os']
        ns = dict(self.ns)
        class Obs:
            def emit(self, row):
                emitted.append(dict(row))
                return dict(row, sequence=1)
            def check(self):
                return None
        # reproduce the branch body exactly as written in the source
        import re
        source = (SCRIPTS / 'sdk-ptrace-execution.py').read_text()
        marker = "        if reason:\n"
        branch = source[source.index(marker)+len(marker):]
        branch = branch[:branch.index("raise ValueError('executable memory policy refused before resume: '+reason)")]
        body = textwrap.dedent(branch)
        real_stderr = self.ns['sys'].stderr
        self.ns['sys'].stderr = stderr
        try:
            exec(body, ns, dict(self=Obs(), pid=482, reason=reason,
                                record=rec(), memory_policy=self._policy()))
        finally:
            self.ns['sys'].stderr = real_stderr
        return emitted, stderr.getvalue()

    @staticmethod
    def _policy():
        return types.SimpleNamespace(MODEL='file-exec-no-transition-v1')

    @staticmethod
    def _fake_os():
        consts = dict(O_RDONLY=0, O_CLOEXEC=0, O_DIRECTORY=0, O_NOFOLLOW=0)
        fake = FakeProc(maps=MAPS)
        return {'os': types.SimpleNamespace(**consts, **fake.build())}

    def test_branch_keeps_raw_row_shape_and_adds_only_stderr_field(self):
        emitted, line = self._run_branch()
        self.assertEqual(len(emitted), 1)
        row = emitted[0]
        self.assertEqual(sorted(row), ['entrySequence', 'kind', 'model', 'pid', 'reason'])
        self.assertEqual(row['kind'], 'executable-memory-refused')
        self.assertTrue(line.startswith('SDK_EXECUTABLE_MEMORY_REFUSED '))
        payload = json.loads(line.split(' ', 1)[1])
        self.assertEqual(sorted(payload),
                         ['arch', 'entrySequence', 'nr', 'pid', 'reason', 'refusedCaller'])

    def test_branch_payload_records_caller_lineage(self):
        _, line = self._run_branch()
        caller = json.loads(line.split(' ', 1)[1])['refusedCaller']
        self.assertEqual(caller['executable'], '/usr/bin/clang-19')
        self.assertEqual(len(caller['syscallArgs']), 6)
        self.assertFalse(caller['mappingSampleIsPermissionProof'])
        self.assertFalse(caller['mappingSampleIsAtomic'])


class RawRowUnchanged(unittest.TestCase):
    def test_refusal_raw_row_has_no_new_keys(self):
        source = (SCRIPTS / 'sdk-ptrace-execution.py').read_text()
        row = ("self.emit(dict(kind='executable-memory-refused',model=memory_policy.MODEL,"
               "pid=pid,entrySequence=record['sequence'],reason=reason))")
        self.assertEqual(source.count(row), 1,
                         'the raw refused row must keep exactly its original shape')
        self.assertNotIn('refusedCaller=refusedCaller))', row)

    def test_only_the_stderr_print_gained_the_field(self):
        source = (SCRIPTS / 'sdk-ptrace-execution.py').read_text()
        self.assertEqual(source.count('refusedCaller=refusedCaller'), 1)
        self.assertEqual(source.count('refusedCaller=refused_caller_snapshot(pid,record'), 1,
                         'exactly one call site, on the fatal refusal branch')


if __name__ == '__main__':
    unittest.main(verbosity=2)
