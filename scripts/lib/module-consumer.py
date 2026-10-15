"""Shared installed-module consumer process ownership and disk observations.

Adapters own protocol validation and service probes. Unknown process closure
keeps raw ineligible and prevents adapters from deleting retained state.
"""
import base64
import hashlib
import json
import os
import shutil
import signal
import stat
import subprocess
import time

GIB = 1024 ** 3
MIB = 1024 ** 2

def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(MIB), b''):
            h.update(chunk)
    return h.hexdigest() if algorithm == 'sha256' else base64.b64encode(h.digest()).decode()


def allocated_bytes(root):
    """Return coverage, never call a partial installer snapshot a full total."""
    disappeared = 0
    def walk_error(error):
        nonlocal disappeared
        if isinstance(error, FileNotFoundError):
            disappeared += 1
        else:
            raise error
    total = 0
    for directory, directories, files in os.walk(root, onerror=walk_error):
        for name in directories + files:
            try:
                info = os.lstat(os.path.join(directory, name))
            except FileNotFoundError:
                disappeared += 1
                continue
            if not stat.S_ISLNK(info.st_mode):
                total += info.st_blocks * 512
    return dict(observedBytes=total, complete=disappeared == 0, disappearedEntries=disappeared)


class ModuleConsumerRunner:
    def __init__(self, plan, checked):
        self.plan, self.checked = plan, checked
        self.output = checked['output']
        self.records = []
        self.child = None
        self.cancelled = None
        self.forced = False
        self.groups_unknown = False
        self.group_members = {}
        self.disk_coverage = dict(completeSamples=0, partialSamples=0, disappearedEntries=0,
                                  lastCompleteBytes=None, peakCompleteBytes=None, lastSampleComplete=None,
                                  capCheckedOnLastSample=False)

    def gate(self, initial=False):
        b = self.plan['budget']
        needed = b['remainingFloorBytes'] + b['cushionBytes'] + (b['estimatedPeakBytes'] if initial else 0)
        require(shutil.disk_usage(self.checked['parent']).free >= needed, 'insufficient disk for resource floor/cushion')
        owned = getattr(self, 'owned', None)
        if owned and owned.exists():
            observations = [allocated_bytes(owned), allocated_bytes(self.output)]
            complete = all(row['complete'] for row in observations)
            coverage = self.disk_coverage
            coverage['lastSampleComplete'] = complete
            coverage['capCheckedOnLastSample'] = complete
            coverage['disappearedEntries'] += sum(row['disappearedEntries'] for row in observations)
            if complete:
                usage = sum(row['observedBytes'] for row in observations)
                coverage['completeSamples'] += 1
                coverage['lastCompleteBytes'] = usage
                coverage['peakCompleteBytes'] = max(coverage['peakCompleteBytes'] or 0, usage)
                require(usage <= b['estimatedPeakBytes'], 'actual owned allocation exceeds estimated peak cap')
            else:
                coverage['partialSamples'] += 1

    def save(self):
        (self.output / 'result.json').write_text(json.dumps(self.result, indent=2) + '\n')

    def observe_group(self, process):
        try:
            return self._observe_group(process)
        except BaseException:
            self.groups_unknown = True
            if self.records:
                self.records[-1]['groupObservationFailure'] = self.last_group_observation
            raise

    def _observe_group(self, process):
        observation = dict(pollBefore=None, pollAfter=None, members={}, previous=self.group_members.get(process.pid, {}), absenceProbe='not-run')
        self.last_group_observation = observation
        observation['pollBefore'] = process.poll()
        output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,pgid=,lstart='], text=True)
        members = {}
        for line in output.splitlines():
            parts = line.split(None, 2)
            if len(parts) == 3 and parts[1] == str(process.pid):
                members[int(parts[0])] = parts[2]
        previous = self.group_members.get(process.pid, {})
        observation.update(pollAfter=process.poll(), members=members)
        # A ps snapshot may predate a fast leader's exit. Only ESRCH proves
        # that stale members are gone; a live or inaccessible group is not absence.
        if observation['pollAfter'] is not None:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                observation['absenceProbe'] = 'ESRCH'
                members = {}
            except BaseException as error:
                observation['absenceProbe'] = type(error).__name__
                raise
            else:
                observation['absenceProbe'] = 'present'
                require(any(pid in previous and previous[pid] == start for pid, start in members.items()), 'process group ownership unknown after leader exit')
        self.group_members[process.pid] = members
        return members

    def close_service(self, process, timeout=20):
        # The public CLI owns ordered shutdown of its runtime descendants.
        # Broadcasting here bypasses that order; group signals belong to failure cleanup.
        deadline = time.monotonic() + timeout
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        process.wait(timeout=max(0, deadline - time.monotonic()))
        require(process.returncode == 0, 'service did not close gracefully with exit 0')
        while True:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return
            self.observe_group(process)
            self.gate()
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(process.args, timeout)
            time.sleep(.1)

    def stop(self, process, timeout=20):
        try:
            return self._stop(process, timeout)
        except BaseException:
            self.groups_unknown = True
            raise

    def _stop(self, process, timeout=20):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        else:
            try:
                if self.observe_group(process):
                    os.killpg(process.pid, signal.SIGTERM)
            except BaseException:
                self.groups_unknown = True
                raise
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.forced = True
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return
            time.sleep(.1)
        # Recheck a previously observed PID/start identity before escalating.
        try:
            if self.observe_group(process):
                self.forced = True
                os.killpg(process.pid, signal.SIGKILL)
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(.1)
        except BaseException:
            self.groups_unknown = True
            raise
        self.groups_unknown = True
        raise RuntimeError('process group disappearance unknown')

    def command(self, label, argv, env, cwd, service=None):
        self.gate()
        row = dict(label=label, argv=argv, status='running', waitStatus='unknown', rawClosed=False)
        self.records.append(row)
        self.save()
        out, err = [self.output / (label + '.' + suffix + '.raw.log') for suffix in ['stdout', 'stderr']]
        process = None
        group_absent = False
        try:
            with open(out, 'xb') as stdout, open(err, 'xb') as stderr:
                process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                self.child = process
                row['pid'] = process.pid
                self.save()
                self.observe_group(process)
                if service:
                    service(process)
                    self.close_service(process)
                else:
                    try:
                        deadline = time.monotonic() + self.plan.get('timeoutSeconds', 180)
                        while process.poll() is None:
                            self.observe_group(process)
                            self.gate()
                            if time.monotonic() >= deadline:
                                raise subprocess.TimeoutExpired(argv, self.plan.get('timeoutSeconds', 180))
                            time.sleep(.2)
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        row['timeout'] = True
                        self.stop(process)
                        raise RuntimeError('command timeout: ' + label)
                    require(process.returncode == 0, 'command failed: ' + label)
                # Every command, including installer descendants, must leave no group.
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    group_absent = True
                else:
                    raise RuntimeError('surviving command process group')
                row['status'] = 'passed'
        finally:
            if process:
                try:
                    if process.poll() is None or row['status'] != 'passed':
                        self.stop(process)
                except BaseException as cleanup_error:
                    self.groups_unknown = True
                    row['cleanupError'] = str(cleanup_error)
                if not self.groups_unknown:
                    try:
                        os.killpg(process.pid, 0)
                    except ProcessLookupError:
                        group_absent = True
                    except BaseException as cleanup_error:
                        self.groups_unknown = True
                        group_absent = False
                        row['cleanupError'] = str(cleanup_error)
                    else:
                        self.groups_unknown = True
                        group_absent = False
                row['observedGroupMembers'] = self.group_members.get(process.pid, {})
                row['returncode'] = process.returncode
                row['waitStatus'] = 'known' if process.returncode is not None else 'unknown'
            self.child = None
            row['rawHandlesClosed'] = True
            eligible = (process is None or group_absent) and not self.groups_unknown
            row.update(rawClosed=eligible, rawClosedBeforeHash=eligible, rawEligible=eligible, ownedGroupAbsent=group_absent)
            row['raw'] = [{ 'path': p.name, 'sha256': digest(p) if eligible else None, 'bytes': p.stat().st_size, 'sizeIsFinal': eligible } for p in [out, err] if p.exists()]
            if row['status'] == 'running' or self.groups_unknown:
                row['status'] = 'failed'
            self.save()
        require(not self.groups_unknown, 'owned process group closure unknown')
