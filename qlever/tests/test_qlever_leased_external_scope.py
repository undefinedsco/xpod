"""Real-Observer regression for the narrow external held-lease witness.

Capabilities come from the ONE base probe (`base._LEASE/_PTRACE/_AUTHORITY`,
read from the already-evaluated module constants at base line 203) -- this module
never forks a second probe.

Coverage:
  * AT_SYMLINK_FOLLOW positive driven by a REAL os.link(dir_fd, dir_fd,
    follow_symlinks=True), which forces the kernel LINKAT flag 0x400;
  * unleased external operand stays unwitnessed (specific target);
  * unlink of a symlink never advances its followed target;
  * strict official decoding, real semantic replay with meaningful markers, and
    an official-encoder forged-identity negative.
"""
import errno
import os
import sys
import json
import time
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'qlever' / 'tests'))
if __package__:
    from . import test_qlever_owned_metadata_observer as base
else:
    import test_qlever_owned_metadata_observer as base

# Reuse the SINGLE already-evaluated base probe result (base line 203).
_LEASE, _PTRACE, _AUTHORITY = base._LEASE, base._PTRACE, base._AUTHORITY

backend = base.load('scope_finish_backend', 'sdk-ptrace-execution.py')
probe = base.load('scope_finish_probe', 'sdk-execution-originals-util.py')


class _ScopeObserver(backend.Observer):
    # Match the SDK's canonical lease-backend DI while keeping test roots isolated.
    lifetime_leases_class = backend.SdkExecutionObserver.lifetime_leases_class


@unittest.skipUnless(sys.platform.startswith('linux'),
                     'real kernel read leases and ptrace require Linux')
@unittest.skipUnless(_LEASE, 'kernel refuses F_SETLEASE on this host')
@unittest.skipUnless(_PTRACE, 'cannot ptrace/reap own child on this host')
@unittest.skipUnless(_AUTHORITY, 'cannot empty the child capability bounding set')
class LeasedExternalScope(unittest.TestCase):

    def setUp(self):
        self.root = Path(ROOT / '.test-data')
        self.root.mkdir(parents=True, exist_ok=True)
        self.case = Path(tempfile.mkdtemp(prefix='scopefinish-', dir=str(self.root)))
        self.out = self.case / 'out'
        self.build = self.case / 'build'
        self.source = self.case / 'source'
        for d in (self.out, self.build, self.source):
            d.mkdir(parents=True, exist_ok=True)
        self.ext = self.case / 'external'          # outside the build root
        self.ext.mkdir()
        self.observer = None
        self.owned = []

    def tearDown(self):
        obs, owned = self.observer, list(self.owned)
        self.observer = None
        try:
            if obs is not None:
                try:
                    obs.close()
                except BaseException:
                    pass
        finally:
            for pid in owned:
                try:
                    os.waitpid(pid, 0)      # blocking; ECHILD when already reaped
                except (ChildProcessError, OSError):
                    pass
            shutil.rmtree(self.case, ignore_errors=True)

    def _observer(self):
        kwargs = base.production_profile(backend)
        return _ScopeObserver(
            self.out, self.source, self.build,
            deadline_monotonic=time.monotonic() + 120, check_budget=lambda: None,
            maximum_bytes=base.LIMITS['sourceMaterialBytes'],
            maximum_stdio_bytes=base.LIMITS['shardBytes'],
            generated_build_root=str(self.build), **kwargs)

    def _rows_raw(self, phase):
        import gzip
        for shard in phase.get('rawTraceShards', []):
            path = Path(shard['path'])
            if not path.is_absolute():
                path = self.out / path
            opener = gzip.open if str(path).endswith('.gz') else open
            with opener(path, 'rb') as handle:
                for line in handle:
                    if line.endswith(b'\n'):
                        yield line

    def _decode(self, phase):
        # OFFICIAL strict decoder; a malformed record must fail, never truncate.
        return list(probe.decoded_raw_records(self._rows_raw(phase)))

    def _run(self, body, args):
        obs = self._observer()
        self.observer = obs
        (self.source / 'actor.py').write_text(body)
        try:
            phase = obs.phase('configure',
                              [sys.executable, '-B', str(self.source / 'actor.py')] + args,
                              cwd=str(self.source),
                              env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        finally:
            self.owned = [int(p) for p in getattr(obs, 'tasks', {})]
        return phase, obs

    def _replay(self, phase, wire=None):
        bindings = base.load('scope_root_bindings', 'sdk-generation-multiprocess-bindings.py')
        capture_dir = Path(self.observer.capture_dir)

        def read_original(name, maximum):
            with (capture_dir / name).open('rb') as handle:
                remaining = maximum
                while remaining:
                    block = handle.read(min(65536, remaining))
                    if not block:
                        return
                    remaining -= len(block)
                    yield block
                assert not handle.read(1), 'fixture original exceeds replay read bound'

        return bindings.observe(
            [('configure', self._rows_raw(phase) if wire is None else wire)],
            read_original, {}, lambda: None, limits=base.LIMITS,
            generated_build_root=str(self.build))

    def test_already_held_external_unlink_is_witnessed_advanced_and_replayed(self):
        target = self.ext / 'cleanup.s'
        target.write_bytes(b'.text\n.globl f\nf:\n  ret\n')
        actor = """import os,sys
p=sys.argv[1]
fd=os.open(p,os.O_RDONLY)
os.read(fd,4096); os.lseek(fd,0,0); os.read(fd,4096)
os.unlink(p)
os.close(fd)
"""
        phase, obs = self._run(actor, [str(target)])
        self.assertEqual(phase['commandReceipt']['exit'], 0)
        rows = self._decode(phase)
        windows = [r for r in rows if r.get('kind') == 'actual-link-window'
                   and r.get('path') == str(target)]
        self.assertEqual(len(windows), 1)
        window = windows[0]
        self.assertIn(window['form'], ('unlink', 'unlinkat'))
        before = list(window['beforeIdentity'])
        self.assertEqual(len(before), 6)
        acquired = [r for r in rows if r.get('kind') == 'toolchain-lease-acquired'
                    and list(r.get('identity') or []) == before]
        self.assertEqual(len(acquired), 1)
        transitions = [r for r in rows if r.get('kind') == 'actual-link-transition'
                       and r.get('windowSequence') == window['sequence']]
        self.assertEqual(len(transitions), 1)
        transition = transitions[0]
        self.assertEqual(transition['entrySequence'], window['entrySequence'])
        self.assertEqual(transition['afterLinks'], 0)
        self.assertEqual(transition['result'], 0)
        self.assertIs(transition['isError'], False)
        after = list(transition['afterIdentity'])
        self.assertEqual(after[:5], before[:5])
        self.assertNotEqual(after[5], before[5])
        self.assertIn(tuple(after), obs.lifetime_by_identity)
        closed = [r for r in rows if r.get('kind') == 'toolchain-lease-closed-token'
                  and r.get('leaseId') == acquired[0]['leaseId']]
        self.assertEqual(len(closed), 1)
        self.assertEqual(list(closed[0]['identity']), after)
        self.assertIn('observedEmptyReadEofWindows', self._replay(phase))

    # ---------------------------------------------------------------
    def test_linkat_symlink_follow_witnesses_followed_target(self):
        target = self.ext / 'real.s'
        target.write_bytes(b'.text\n.globl f\nf:\n  movl $1,%eax\n  ret\n')
        alias = self.ext / 'alias.s'
        os.symlink('real.s', alias)
        actor = """import os,sys
d,alias,hard=sys.argv[1],sys.argv[2],sys.argv[3]
fd=os.open(os.path.join(d,'real.s'),os.O_RDONLY)
os.read(fd,4096); os.lseek(fd,0,0); os.read(fd,4096)
dirfd=os.open(d,os.O_DIRECTORY)
# forces LINKAT with AT_SYMLINK_FOLLOW (0x400)
os.link(alias,hard,src_dir_fd=dirfd,dst_dir_fd=dirfd,follow_symlinks=True)
os.close(dirfd); os.close(fd)
"""
        phase, obs = self._run(actor, [str(self.ext), 'alias.s', 'hard.s'])
        self.assertEqual(phase['commandReceipt']['exit'], 0)
        rows = self._decode(phase)
        args = [r for r in rows if r.get('kind') == 'kernel-link-args-original']
        self.assertTrue(args, 'a real LINKAT must be witnessed')
        link_args = [r for r in args if r.get('form') == 'linkat']
        self.assertTrue(link_args, 'the kernel must report form linkat')
        self.assertEqual(link_args[0]['flags'] & 0x400, 0x400,
                         'AT_SYMLINK_FOLLOW must be set in the real args original')
        windows = [r for r in rows if r.get('kind') == 'actual-link-window']
        self.assertTrue(windows, 'the followed target must be witnessed')
        window = windows[-1]
        self.assertEqual(window['form'], 'linkat')
        # the window binds the leased FOLLOWED regular inode, not the symlink
        holder = [r for r in rows
                  if r.get('kind') in ('toolchain-lease-acquired', 'toolchain-lease-reused')
                  and list(r.get('identity') or []) == list(window['beforeIdentity'])]
        self.assertTrue(holder, 'the window identity must be an already-held lease')
        transitions = [r for r in rows if r.get('kind') == 'actual-link-transition']
        self.assertTrue(transitions, 'the successful link must emit a transition')
        transition = transitions[-1]
        self.assertEqual(transition['afterLinks'], window['beforeLinks'] + 1,
                         'a link increments nlink by exactly one')
        self.assertEqual(transition['afterIdentity'][:5], window['beforeIdentity'][:5])
        self.assertNotEqual(transition['afterIdentity'][5], window['beforeIdentity'][5],
                            'the target ctime must advance')
        # real production semantic replay accepts the captured records
        result = self._replay(phase)
        self.assertIsInstance(result, dict)
        self.assertIn('observedEmptyReadEofWindows', result,
                      'a meaningful replay marker must be present')

    def test_unleased_external_operand_has_no_witness(self):
        target = self.ext / 'unleased.s'
        target.write_bytes(b'x' * 16)
        actor = """import os,sys
p=sys.argv[1]
fd=os.open(os.path.join(os.path.dirname(p),'unleased.s'),os.O_RDONLY)
os.read(fd,4096)
q=p+'.other'
open(q,'wb').write(b'y'*8)
os.unlink(q)
os.close(fd)
"""
        phase, obs = self._run(actor, [str(target)])
        self.assertEqual(phase['commandReceipt']['exit'], 0)
        rows = self._decode(phase)
        leaked = [r for r in rows
                  if 'unleased.s.other' in str(r.get('path', ''))
                  and r.get('kind') in ('actual-link-window', 'actual-link-transition')]
        self.assertFalse(leaked, 'an unleased external operand must never be witnessed')

    def test_unlink_symlink_does_not_advance_followed_target(self):
        target = self.ext / 'real.s'
        target.write_bytes(b'x' * 16)
        alias = self.ext / 'alias.s'
        os.symlink('real.s', alias)
        actor = """import os,sys
d=sys.argv[1]
fd=os.open(os.path.join(d,'real.s'),os.O_RDONLY)
os.read(fd,4096)
os.unlink(os.path.join(d,'alias.s'))
os.close(fd)
"""
        phase, obs = self._run(actor, [str(self.ext)])
        self.assertTrue(target.exists(), 'the followed target must survive')
        rows = self._decode(phase)
        advanced = [r for r in rows if r.get('kind') == 'actual-link-transition']
        self.assertFalse(advanced, 'unlinking a symlink must not advance its target lease')

    def test_semantic_replay_refuses_forged_external_closing_identity(self):
        """Official-encoder forgery: an altered CLOSING identity for the external
        target must be refused by production observe(), not silently accepted.

        The stream stays structurally valid: only the closing token identity is
        mutated and the terminal digest recomputed, so a digest-only check cannot
        catch it. This pins that the extended case is admitted through the SAME
        six-field semantic path, not through a new arbitrary authority.
        """
        target = self.ext / 'real.s'
        target.write_bytes(b'x' * 16)
        actor = """import os,sys
d=sys.argv[1]
fd=os.open(os.path.join(d,'real.s'),os.O_RDONLY)
os.read(fd,4096); os.lseek(fd,0,0); os.read(fd,4096)
dirfd=os.open(d,os.O_DIRECTORY)
os.link('real.s','hard.s',src_dir_fd=dirfd,dst_dir_fd=dirfd,follow_symlinks=True)
os.close(dirfd); os.close(fd)
"""
        phase, obs = self._run(actor, [str(self.ext)])
        self.assertEqual(phase['commandReceipt']['exit'], 0)
        rows = self._decode(phase)
        closing = [r for r in rows if r.get('kind') == 'toolchain-lease-closed-token']
        self.assertTrue(closing, 'the phase must close its held tokens')
        windows = [r for r in rows if r.get('kind') == 'actual-link-window'
                   and r.get('path') == str(target)]
        self.assertEqual(len(windows), 1)
        transitions = [r for r in rows if r.get('kind') == 'actual-link-transition'
                       and r.get('windowSequence') == windows[0]['sequence']]
        self.assertEqual(len(transitions), 1)
        after = list(transitions[0]['afterIdentity'])
        victims = [r for r in closing if list(r['identity']) == after]
        self.assertEqual(len(victims), 1,
                         'forge the transitioned external input, not the first executable lease')
        victim = victims[0]
        self.assertIn('observedEmptyReadEofWindows', self._replay(phase),
                      'the unmodified stream must first pass actual replay')
        forged = list(victim['identity'])
        forged[5] += 1                      # perturb ctime only
        encoder = probe.IndexedRawEncoderV2()
        rewritten = []
        mutated = []
        for row in rows:
            copy = dict(row)
            if (copy.get('kind') == 'toolchain-lease-closed-token'
                    and copy.get('leaseId') == victim['leaseId']):
                copy['identity'] = list(forged)
                mutated.append(copy)
            rewritten.append(copy)
        self.assertTrue(mutated, 'the closing token must be present to forge')
        # recompute the terminal digest over the forged closing rows, exactly as
        # production does, so only the identity is wrong
        import hashlib
        digest = hashlib.sha256()
        for copy in rewritten:
            if copy.get('kind') != 'toolchain-lease-closed-token':
                continue
            projection = {k: copy.get(k)
                          for k in ('leaseId', 'identity', 'acquisitionSequence')}
            digest.update(json.dumps(projection, sort_keys=True,
                                     separators=(',', ':')).encode() + b'\n')
        for copy in rewritten:
            if copy.get('kind') == 'toolchain-leases-closed':
                copy['tokensSha256'] = digest.hexdigest()
        wire = []
        for row in rewritten:
            wire.extend(encoder.encode(row))
        with self.assertRaises(BaseException) as caught:
            self._replay(phase, wire)
        message = str(caught.exception)
        self.assertTrue(message, 'the refusal must carry an explicit reason')
        self.assertNotIn('lease terminal count/hash', message,
                         'all closing rows must contribute to the recomputed digest')
        self.assertNotIsInstance(caught.exception, KeyError,
                                 'refusal must be semantic, not a decode artifact')


if __name__ == '__main__':
    unittest.main()
