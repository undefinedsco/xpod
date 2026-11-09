"""Replay native originals through the existing same-FD ZIP and kernel decoder.

This is byte/trace mechanics, not a source issuer. The private TS observer must
bind the sole collector, Git, SDK admission and official Debian source inputs.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import time

HERE = Path(__file__).resolve().parent
LIMITS = json.loads((HERE.parents[1] / 'scripts/lib/module-artifact-limits.json').read_text())
META = LIMITS['metadataBytes']
CHUNK = LIMITS['rangeBytes']
MAX_TOTAL = 128 * 1024 ** 2
GENERATED_ROOT = '/opt/xpod-qlever-local-runtime/build'
FIXED_PHASE = 'focused-native-build'
FIXED_COMMAND = ['bash', 'qlever/scripts/run-focused-native-build.sh']


def need(value, why):
    if not value:
        raise ValueError('Native runtime receiver: ' + why)


def load_module(root, name, attribute):
    path = Path(root) / name
    need(path.is_file() and not path.is_symlink(), 'same-repository helper required: ' + name)
    spec = importlib.util.spec_from_file_location('native_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(callable(getattr(module, attribute, None)), 'helper interface unavailable: ' + attribute)
    return module


def ref(row):
    need(isinstance(row, dict) and {'path', 'bytes', 'sha256'} <= set(row), 'original reference required')
    name = row['path']
    need(isinstance(name, str) and name and not name.startswith('/')
         and not any(c in name for c in '\\\0\r\n')
         and all(part not in ('', '.', '..') for part in name.split('/')),
         'canonical original path required')
    need(type(row['bytes']) is int and 0 <= row['bytes'] <= MAX_TOTAL
         and isinstance(row['sha256'], str) and re.fullmatch('[a-f0-9]{64}', row['sha256']),
         'bounded original identity required')
    return {key: row[key] for key in ('path', 'bytes', 'sha256')}


class MemberReader:
    def __init__(self, member, check):
        self.member, self.check = member, check

    def blocks(self, row, maximum):
        row = ref(row)
        need(row['bytes'] <= maximum, 'member typed bound')
        with self.member(row) as stream:
            count, digest = 0, hashlib.sha256()
            while True:
                self.check()
                block = stream.read(CHUNK)
                if not block:
                    break
                count += len(block)
                need(count <= row['bytes'], 'original grew')
                digest.update(block)
                yield block
            need(count == row['bytes'] and digest.hexdigest() == row['sha256'], 'original bytes/SHA differ')

    def json(self, row):
        return json.loads(b''.join(self.blocks(row, META)))


def validate_closed_set(master, names, reader, maximum, master_reference):
    need(isinstance(master, dict) and master.get('schemaVersion') == 1
         and master.get('kind') == 'candidate-service-native-runtime-originals', 'native master schema')
    identity = master.get('identity')
    need(isinstance(identity, dict) and identity.get('sdkProfile') == 'service-trixie'
         and identity.get('target') in ('linux-x64', 'linux-arm64'), 'native profile/target')
    need(re.fullmatch('[a-f0-9]{40}', str(identity.get('sourceSha')))
         and all(type(identity.get(key)) is int and identity[key] > 0 for key in ('runId', 'runAttempt')),
         'native source/run/attempt')
    need(master.get('sourceFactsVerified') is False and master.get('sourceAuthorityVerified') is False,
         'producer cannot grant source authority')
    rows = master.get('originals')
    need(isinstance(rows, list) and rows, 'actual original inventory')
    registered, total = {}, master_reference['bytes']
    for row in rows:
        item = ref(row)
        need('root' not in row and item['path'] != 'materials.json' and item['path'] not in registered,
             'unique finalized original reference')
        registered[item['path']] = item
        total += item['bytes']
        need(total <= maximum, 'same service original byte bound')
    need(len(names) == len(set(names)) and set(names) == set(registered) | {'materials.json'},
         'exact complete original member set')
    need(master.get('retainedOriginalBytes') == total - master_reference['bytes'], 'actual retained byte total')
    # Applicable notice copies are actual producer outputs; keep them bound to
    # their canonical source rows and observed runtime membership.
    notices = master.get('retainedNoticeOriginals', [])
    need(isinstance(notices, list) and len(notices) <= 1024, 'bounded retained notice rows required')
    seen_notices = set()
    for row in notices:
        need(isinstance(row, dict) and isinstance(row.get('relative'), str)
             and row['relative'].startswith('notices/') and row['relative'] not in seen_notices
             and isinstance(row.get('sourcePath'), str)
             and row['sourcePath'].startswith(('/opt/qlever-sdk/source/', '/opt/qlever-sdk/dependencies/', '/workspace/xpod/'))
             and isinstance(row.get('sourcePathKey'), str) and row['sourcePathKey']
             and isinstance(row.get('contributor'), dict) and row['contributor'].get('kind')
             and isinstance(row.get('sourceOriginal'), dict) and row['sourceOriginal'].get('kind')
             and isinstance(row.get('sha256'), str) and len(row['sha256']) == 64
             and isinstance(row.get('bytes'), int) and row['bytes'] >= 0
             and row.get('mode') in (0o644, 0o755), 'canonical retained notice membership required')
        seen_notices.add(row['relative'])
        original = registered.get(row['original']['path']) if isinstance(row.get('original'), dict) else None
        need(original and original['bytes'] == row['bytes'] and original['sha256'] == row['sha256'],
             'retained notice original bytes differ')
        # V13: a contributor inventory claim is only meaningful when its
        # retained original is a member of the CLOSED registered original set.
        # Carrying an object proves nothing: an orphan ref (nonexistent or
        # unregistered path) must be refused, and its bytes/size re-checked
        # against the registered entry through the same bound reader.
        declared = row['sourceOriginal']
        if declared.get('kind') == 'fetchcontent-source-inventory':
            inventory_original = declared.get('original')
            need(isinstance(inventory_original, dict), 'contributor inventory original required')
            inventory_ref = ref(inventory_original)
            need(inventory_ref['path'] in registered,
                 'contributor inventory original is not a registered closed-set member')
            need(inventory_ref['bytes'] == declared.get('bytes')
                 and inventory_ref['sha256'] == declared.get('sha256'),
                 'contributor inventory declaration differs from its retained original')
            held = registered[inventory_ref['path']]
            need(held['bytes'] == inventory_ref['bytes'] and held['sha256'] == inventory_ref['sha256'],
                 'contributor inventory original bytes differ from the closed set')
            # Re-open and hash through the existing bound reader/parent.
            digest = hashlib.sha256()
            count = 0
            for block in reader.blocks(held, maximum):
                count += len(block)
                digest.update(block)
            need(count == held['bytes'] and digest.hexdigest() == held['sha256'],
                 'contributor inventory original re-read differs')
    for row in registered.values():
        for _ in reader.blocks(row, maximum):
            pass
    return registered, total


def receive(*, archive_path, master_reference, ledger):
    check = ledger.check
    check()
    maximum = min(MAX_TOTAL, ledger.remaining())
    need(type(maximum) is int and maximum > 0, 'shared remaining original budget')
    master_reference = ref(master_reference)
    need(master_reference['path'] == 'materials.json', 'fixed master original')
    zip_module = load_module(HERE, 'sdk-zip-originals.py', 'registered_zip_originals')
    bindings = load_module(HERE, 'sdk-generation-multiprocess-bindings.py', 'observe')
    wire = load_module(HERE, 'sdk-raw-wire-reader.py', 'iter_shard_records')
    limits = LIMITS
    with zip_module.registered_zip_originals(archive_path, 'native-runtime/', check,
                                            master_reference=master_reference) as member:
        reader = MemberReader(member, check)
        master = reader.json(master_reference)
        registered, total = validate_closed_set(master, member.names, reader, maximum, master_reference)
        def held(value):
            row = ref(value)
            need(registered.get(row['path']) == row, 'phase reference outside complete originals')
            return row
        command = reader.json(held(master['commandReceiptOriginal']))
        tracking = reader.json(held(master['trackingReceiptOriginal']))
        need(command.get('command') == FIXED_COMMAND and command.get('actualWait') is True
             and command.get('rawClosedBeforeHash') is True and command.get('exit') == 0
             and command.get('signal') is None, 'actual closed focused command')
        need(tracking.get('phase') == FIXED_PHASE and tracking.get('command') == FIXED_COMMAND
             and tracking.get('actualTrackedWait') is True and tracking.get('trackedProcessesClosed') is True
             and tracking.get('actualRootReturnCode') == 0
             and tracking.get('actualRootPid') == command.get('pid'), 'same actual closed tracked process')
        phase = master.get('phase')
        need(isinstance(phase, dict) and phase.get('name') == FIXED_PHASE, 'fixed raw phase')
        captures = phase.get('captureFiles')
        shards = phase.get('rawTraceShards')
        need(isinstance(captures, list) and isinstance(shards, list) and shards, 'actual capture/shard inventory')
        capture_map = {}
        for row in captures:
            item = held(row)
            need(item['path'] not in capture_map, 'unique phase capture')
            capture_map[item['path']] = item
        logical_total = 0
        for shard in shards:
            held(shard)
            need(isinstance(shard.get('wire'), dict), 'actual compressed wire descriptor')
            logical = shard['wire'].get('logical', {}).get('bytes')
            need(type(logical) is int and logical >= 0, 'actual logical byte count')
            logical_total += logical
            need(logical_total <= limits['sourceBytes'], 'shared decoded raw byte bound')
        state = {'rows': 0, 'complete': False}
        def records():
            for shard in shards:
                for line in wire.iter_shard_records(reader.blocks(shard, maximum), shard,
                        check=check, maximum_encoded=maximum,
                        maximum_logical=limits['sourceBytes'], maximum_record=CHUNK):
                    state['rows'] += 1
                    yield line
            state['complete'] = True
        lines = records()
        def read_original(name, maximum_file):
            check()
            need(name in capture_map, 'raw capture absent from declared phase')
            yield from reader.blocks(capture_map[name], min(maximum, maximum_file))
        source_files, generated_files, input_events = {}, {}, []
        def captured(row, data):
            check()
            role = row['role']
            if role not in ('source-read', 'producer-close'):
                return
            item = dict(path=row['path'], bytes=data[0], sha256=data[1],
                        mode=row['identity'][2] & 0o7777)
            key = json.dumps(item, sort_keys=True)
            target = source_files if role == 'source-read' else generated_files
            target[key] = item
            input_events.append(dict(kind=role, **item))
            need(len(input_events) <= limits['sourceMembers'], 'bounded ordered snapshot events')
            need(len(source_files) + len(generated_files) <= limits['sourceMembers'],
                 'bounded logical input/output snapshot set')
        # This phase has no SDK-specific config.h/generated.h required set.
        # No empty-set result is promoted to source authority: actual snapshots
        # below must still be joined to private Git/SDK/APT originals by TS.
        facts = bindings.observe([(FIXED_PHASE, lines)], read_original, required_inputs={},
                                 check=check, limits=limits, capture_observer=captured,
                                 generated_build_root=GENERATED_ROOT)
        need(state['complete'] and state['rows'] > 0, 'complete raw generator consumption')
        actual = facts.get('phaseTracking')
        need(isinstance(actual, list) and len(actual) == 1 and actual[0].get('phase') == FIXED_PHASE
             and actual[0].get('actualRootPid') == command['pid']
             and actual[0].get('actualRootReturnCode') == 0
             and actual[0].get('waitReferences') == tracking.get('waitReferences'), 'replayed exact phase waits')
        need(facts.get('toolchainExecutionLifetimeImmutabilityVerified') is True, 'actual execution lifetime')
        actual_tools = facts.get('toolchainFileSnapshots')
        descriptors = phase.get('observedToolFiles')
        need(isinstance(actual_tools, list) and isinstance(descriptors, list), 'actual tool original rows')
        def tool_key(path, identity, original):
            return json.dumps([path, identity, held(original)], sort_keys=True)
        expected_tools = {tool_key(row['observedPath'], row['identity'], row['original']) for row in actual_tools}
        supplied_tools = []
        for row in descriptors:
            need(row.get('phase') == FIXED_PHASE and row.get('rawEventKind') == 'toolchain-original'
                 and row.get('sourceKind') == 'actual-tool-file-fd-snapshot'
                 and row.get('role') == 'observed-tool-file'
                 and isinstance(row.get('identity'), list) and len(row['identity']) == 6
                 and row.get('actualMode') == row['identity'][2], 'actual FD descriptor semantics')
            supplied_tools.append(tool_key(row['actualOriginalPath'], row['identity'], row['original']))
        need(len(supplied_tools) == len(set(supplied_tools))
             and set(supplied_tools) == expected_tools, 'complete raw-derived tool file inventory')
        pending = list(facts.get('toolchainPending', [])) + list(facts.get('pending', []))
        need(not any('unclassified' in str(item).lower() for item in pending), 'unclassified actual tool event')
        check()
        return dict(schemaVersion=1, kind='candidate-service-native-runtime-mechanics',
                    identity=master['identity'], originalBytes=total, phaseRows=state['rows'],
                    facts=facts, pending=pending, sourceReadFiles=list(source_files.values()),
                    generatedFiles=list(generated_files.values()), inputEvents=input_events, sourceAuthorityVerified=False)


def main():
    import sys
    need(len(sys.argv) == 3 and sys.argv[1] == '--observe-native', 'fixed native receiver invocation')
    raw = sys.stdin.buffer.read(META + 1)
    need(len(raw) <= META, 'bounded receiver plan')
    plan = json.loads(raw)
    need(set(plan) == {'master', 'remainingMilliseconds', 'remainingOriginalBytes'}, 'fixed receiver plan fields')
    duration, maximum = plan['remainingMilliseconds'], plan['remainingOriginalBytes']
    need(type(duration) is int and 0 < duration <= LIMITS['timeoutMs'], 'caller remaining time')
    need(type(maximum) is int and 0 < maximum <= MAX_TOTAL, 'caller remaining bytes')
    end = time.monotonic() + duration / 1000
    class Ledger:
        def check(self):
            need(time.monotonic() < end, 'shared receiver deadline exhausted')
        def remaining(self):
            self.check()
            return maximum
    result = receive(archive_path=sys.argv[2], master_reference=plan['master'], ledger=Ledger())
    output = json.dumps(result, sort_keys=True).encode()
    need(len(output) <= META, 'bounded receiver observation')
    sys.stdout.buffer.write(output + b'\n')

if __name__ == '__main__': main()
