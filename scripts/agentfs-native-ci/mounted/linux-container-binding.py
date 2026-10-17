"""Release the mounted consumer only after observing its SAME live container."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from supervise import run_checked_stage, run_stage

# Deliberately whitelist at Docker's output boundary: never read Config/Env.
INSPECT = ('{"cid":{{json .Id}},"imageID":{{json .Image}},"running":{{json .State.Running}},'
           '"status":{{json .State.Status}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},'
           '"privileged":{{json .HostConfig.Privileged}},"AppArmorProfile":{{json .AppArmorProfile}},'
           '"NetworkMode":{{json .HostConfig.NetworkMode}},"SecurityOpt":{{json .HostConfig.SecurityOpt}},'
           '"Devices":{{json .HostConfig.Devices}},"CapAdd":{{json .HostConfig.CapAdd}},'
           '"CapDrop":{{json .HostConfig.CapDrop}},"Mounts":['
           '{{range .Mounts}}{"destination":{{json .Destination}},"RW":{{json .RW}}},{{end}}null]}')
GATE = 'for i in $(seq 1 90); do [ -f /evidence/linux-binding.release ] && exec bash /mounted/bookworm-fuse-entry.sh; sleep 1; done; exit 70'


def configuration_failures(binding, cid, image_id, module_profile=False):
    expected = {'/product/archive.tar.gz': False, '/workspace': True, '/mounted': False, '/evidence': True}
    if module_profile:
        expected['/module-product'] = False
    mounts = [item for item in binding['Mounts'] if item is not None]
    checks = dict(cid=binding['cid'] == cid, imageID=binding['imageID'] == image_id,
                  privileged=binding['privileged'] is False, AppArmorProfile=binding['AppArmorProfile'] == 'unconfined',
                  NetworkMode=binding['NetworkMode'] == 'none', SecurityOpt=binding['SecurityOpt'] == ['apparmor=unconfined'],
                  Devices=binding['Devices'] == [{'PathOnHost': '/dev/fuse', 'PathInContainer': '/dev/fuse', 'CgroupPermissions': 'rwm'}],
                  CapAdd=binding['CapAdd'] in (['SYS_ADMIN'], ['CAP_SYS_ADMIN']), CapDrop=binding['CapDrop'] in (None, []),
                  Mounts=len(mounts) == len(expected) and {item['destination']: item['RW'] for item in mounts} == expected)
    return [field for field, passed in checks.items() if not passed]


def validation_failures(binding, cid, image_id, daemon, seccomp, module_profile=False):
    failures = configuration_failures(binding, cid, image_id, module_profile)
    if (binding['running'] is not True or binding.get('status') != 'running' or binding.get('paused') is not False
            or binding.get('restarting') is not False or binding.get('dead') is not False):
        failures.append('container-state')
    if 'name=seccomp,profile=builtin' not in daemon:
        failures.append('daemon-seccomp')
    if seccomp.split() != ['Seccomp:', '2']:
        failures.append('pid1-seccomp')
    return failures


def validate(binding, cid, image_id, daemon, seccomp, module_profile=False):
    failures = validation_failures(binding, cid, image_id, daemon, seccomp, module_profile)
    if failures:
        raise RuntimeError('same live container security binding failed: ' + ','.join(failures))


def wait_same_running_container(inspect, record, cid, image_id, producer, module_profile=False, timeout=10, poll=.1):
    deadline = time.monotonic() + timeout
    attempt = 0
    while True:
        live = inspect(attempt, max(.01, min(2, deadline - time.monotonic())))
        failures = configuration_failures(live, cid, image_id, module_profile)
        record(live, failures, 'readiness')
        if failures:
            raise RuntimeError('same live container security binding failed: ' + ','.join(failures))
        if (live.get('paused') is not False or live.get('restarting') is not False or live.get('dead') is not False
                or live.get('status') not in ['created', 'running']):
            record(live, ['container-state'], 'readiness')
            raise RuntimeError('same owned container entered non-starting state')
        if live['running'] is True and live['status'] == 'running':
            return live
        if live['running'] is not False or live['status'] != 'created':
            record(live, ['container-state'], 'readiness')
            raise RuntimeError('inconsistent owned container state')
        if producer.done() or time.monotonic() >= deadline:
            record(live, ['readiness-deadline'], 'readiness')
            raise RuntimeError('same owned container readiness deadline')
        attempt += 1
        time.sleep(min(poll, max(0, deadline - time.monotonic())))


def consumer_command(archive, evidence, cidfile, workspace, image, module_directory=None):
    command = ['docker', 'run', '--rm', '--init', '--cidfile', str(cidfile),
               '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined', '--network', 'none']
    for source, destination, readonly in [(archive, '/product/archive.tar.gz', True),
            (workspace, '/workspace', False), (workspace / 'scripts/agentfs-native-ci/mounted', '/mounted', True),
            (evidence, '/evidence', False)]:
        command += ['--mount', f'type=bind,src={source},dst={destination}' + (',readonly' if readonly else '')]
    if module_directory is not None:
        command += ['--mount', f'type=bind,src={module_directory},dst=/module-product,readonly']
    values = dict(XPOD_MOUNTED_OS='linux', XPOD_MOUNTED_BACKEND='fuse', XPOD_MOUNTED_ARCHIVE='/product/archive.tar.gz',
                  XPOD_MOUNTED_ARCHIVE_SHA=os.environ['LINUX_ARCHIVE_SHA'], XPOD_MOUNTED_HELPER_SHA=os.environ['LINUX_HELPER_SHA'],
                  XPOD_MOUNTED_EVIDENCE='/evidence', XPOD_MOUNTED_WORKSPACE='/workspace', XPOD_MOUNTED_PREP='/opt',
                  XPOD_MOUNTED_NODE='/opt/node22/bin/node', XPOD_MOUNTED_REQUIRE_NOBUN='1', XPOD_MOUNTED_MIN_PASSED='6')
    for key, value in values.items():
        command += ['--env', f'{key}={value}']
    gate = GATE
    if module_directory is not None:
        authority = os.environ.get('XPOD_MOUNTED_MODULE_INPUTS_SHA256', '')
        runtime = os.environ.get('XPOD_MOUNTED_MODULE_RUNTIME', '')
        if not re.fullmatch('[a-f0-9]{64}', authority) or runtime not in ('node', 'bun'):
            raise RuntimeError('module input authority/runtime is missing')
        # Host release still precedes execution; all product inputs are on the
        # observed read-only mount. Node runs the source-bound bundled harness;
        # the installed product launcher selects its separately bound runtime.
        entry = ('exec /opt/node22/bin/node /module-product/module-admission.mjs '
                 '--inputs /module-product/inputs.json --inputs-sha256 ' + authority + ' --runtime ' + runtime)
        gate = GATE.replace('exec bash /mounted/bookworm-fuse-entry.sh', entry)
    return command + [image, 'sh', '-c', gate]



def wait_owned_cid(cidfile, producer, timeout=60):
    # Docker creates its exclusive cidfile before the daemon returns the CID.
    # An empty file is pending publication, never an identity or release proof.
    deadline = time.monotonic() + timeout
    while True:
        if cidfile.exists():
            raw = cidfile.read_bytes()
            if raw != b'':
                if not re.fullmatch(b'[a-f0-9]{64}\n?', raw):
                    raise RuntimeError('owned container cidfile is invalid')
                return raw.removesuffix(b'\n').decode('ascii')
        if producer.done() or time.monotonic() >= deadline:
            raise RuntimeError('owned container cid was not observed before deadline')
        time.sleep(.1)


def run(archive, evidence, cidfile, workspace, image, image_id, module_directory=None):
    evidence, cidfile, workspace = Path(evidence), Path(cidfile), Path(workspace)
    release = evidence / 'linux-binding.release'
    if cidfile.exists() or release.exists():
        raise RuntimeError('owned cidfile/release gate already exists')
    binding = dict(schemaVersion=2, source='host-observer-before-consumer', state='failed', released=False)
    cid = None

    def checked(name, argv, timeout=30):
        return run_checked_stage(name, argv, evidence, workspace, timeout=timeout)[1]

    with ThreadPoolExecutor(max_workers=1) as pool:
        producer = pool.submit(run_stage, 'linux-consumer', consumer_command(archive, evidence, cidfile, workspace, image, module_directory),
                               evidence, workspace, timeout=4500)
        try:
            cid = wait_owned_cid(cidfile, producer)
            binding['cid'] = cid
            def record(live, failures, phase):
                binding.update(container=live, validationFailures=failures, observationPhase=phase)
                (evidence / 'linux-container-binding.json').write_text(json.dumps(binding, indent=2) + '\n')
            def inspect(attempt, timeout):
                label = 'linux-live-inspect' if attempt == 0 else 'linux-readiness-inspect-' + str(attempt)
                return json.loads(checked(label, ['docker', 'inspect', '--format', INSPECT, cid], timeout=timeout))
            wait_same_running_container(inspect, record, cid, image_id, producer, module_directory is not None)
            daemon = json.loads(checked('linux-daemon-seccomp', ['docker', 'info', '--format', '{{json .SecurityOptions}}']))
            binding['daemonSecurityOptions'] = daemon
            seccomp = checked('linux-pid1-seccomp', ['docker', 'exec', cid, 'sh', '-c', "grep '^Seccomp:' /proc/1/status"])
            seccomp_value = re.fullmatch(r'Seccomp:\s*([0-9]{1,2})\s*', seccomp)
            binding['pid1Seccomp'] = int(seccomp_value[1]) if seccomp_value else None
            live = json.loads(checked('linux-final-inspect', ['docker', 'inspect', '--format', INSPECT, cid]))
            record(live, validation_failures(live, cid, image_id, daemon, seccomp, module_directory is not None), 'final')
            validate(live, cid, image_id, daemon, seccomp, module_directory is not None)
            if cidfile.read_text().strip() != cid:
                raise RuntimeError('owned cidfile changed before consumer release')
            binding.update(state='verified', container=live, daemonSecurityOptions=daemon, pid1Seccomp=2)
            # Receipt must be written and closed BEFORE the consumer is released.
            (evidence / 'linux-container-binding.json').write_text(json.dumps(binding, indent=2) + '\n')
            with release.open('x') as gate:
                gate.write(cid + '\n')
            binding['released'] = True
        finally:
            try:
                if cid is not None:
                    # On success wait for the actual acceptance; on inspect failure
                    # never release it, and remove only the CID we actually own.
                    if binding['released']:
                        receipt, _ = producer.result()
                        binding['consumerReceipt'] = receipt
                    removal, _ = run_stage('linux-container-remove', ['docker', 'rm', '-f', cid], evidence, workspace, timeout=30)
                    binding['removalReceipt'] = removal
                    if (removal['actualWait'] is not True or removal['rawClosedBeforeHash'] is not True
                            or removal['ownedGroupAbsentAfterWait'] is not True or removal['resourceStop']
                            or removal['supervisorError'] or removal['cleanupErrors']):
                        raise RuntimeError('owned container removal producer did not close cleanly')
                    remaining = checked('linux-container-absence', ['docker', 'ps', '-aq', '--no-trunc', '--filter', f'id={cid}'])
                    binding['containerAbsent'] = not remaining.strip()
                    if not binding['containerAbsent']:
                        raise RuntimeError('owned container absence not proven')
            finally:
                receipt, _ = producer.result()
                binding['consumerReceipt'] = receipt
                (evidence / 'linux-container-binding.json').write_text(json.dumps(binding, indent=2) + '\n')
    if (not binding['released'] or receipt['exit'] != 0 or receipt['signal'] is not None or receipt['resourceStop']
            or receipt['actualWait'] is not True or receipt['rawClosedBeforeHash'] is not True
            or receipt['ownedGroupAbsentAfterWait'] is not True or receipt['supervisorError'] or receipt['cleanupErrors']):
        raise RuntimeError('actual mounted consumer did not pass its supervised gate')


if __name__ == '__main__':
    os.umask(0o077)
    run(sys.argv[1], sys.argv[2], sys.argv[3], Path.cwd(), os.environ['XPOD_MOUNT_IMAGE'], os.environ['XPOD_MOUNT_IMAGE_ID'],
        Path(sys.argv[4]).resolve() if len(sys.argv) == 5 else None)
