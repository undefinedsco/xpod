"""Independent verifier contract for pre-execution live-lease capacity.

The runtime receipt is parsed by the verifier itself: the actual inventory
original is read, duplicate paths are rejected, the prepared-input count is
checked, and the FD/memory/member formula is recomputed.  The receipt's own
counts and maximum are never trusted.

These tests are Linux-only because they exercise the real production inventory
reader and /proc FD ledger.  They do not start the SDK workload.
"""
import hashlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BINDINGS = ROOT / 'qlever/scripts/sdk-generation-multiprocess-bindings.py'
EXECUTION = ROOT / 'qlever/scripts/sdk-ptrace-execution.py'
LIMITS = json.loads((ROOT / 'scripts/lib/module-artifact-limits.json').read_text())
MODEL = 'prepared-live-lease-capacity-v1'
SCOPE = 'actual full pre-compile inventory original plus sealed prepared build inputs; reserved before child fork'
LEGACY_FIXTURE = ROOT / 'qlever/tests/test_sdk_generated_source_input_universe.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc and real inventory reader required')
class LiveLeaseVerifierContract(unittest.TestCase):
    def setUp(self):
        self.bindings = load('lease_capacity_verifier', BINDINGS)
        self.execution = load('lease_capacity_runtime', EXECUTION)
        base = ROOT / '.test-data' / 'sdk-live-lease-verifier'
        base.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='case-', dir=base)
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def _runtime_receipt(self, count=4097):
        materials = self.root / 'materials'
        execution = materials / 'toolchain-execution'
        captures = execution / 'captures'
        captures.mkdir(parents=True)
        inventory = {str(self.root / ('input-%d' % index)):
                     dict(bytes=1, sha256=hashlib.sha256(('x%d' % index).encode()).hexdigest(), mode=0o644)
                     for index in range(count)}
        path = materials / 'inputs-before.json'
        path.write_text(json.dumps(inventory, sort_keys=True))
        observer = object.__new__(self.execution.SdkExecutionObserver)
        observer.out = execution
        observer.capture_toolchain = True
        observer.prepared_inputs = {}
        observer.lease_inventory_path = path
        observer.capture_dir = captures
        observer.capture_bytes = 0
        observer.claim = lambda *args, **kwargs: None
        observer.next_capture_name = lambda: 'capture-0001.original'
        rows = []
        observer.captures = []
        observer.capture_buckets = {}
        def emit(row):
            rows.append(row)
            return row
        observer.emit = emit
        evidence = observer.prepared_lease_capacity('compile')
        self._last_capacity_observer = observer
        return evidence, rows[0], (captures / 'capture-0001.original').read_bytes()

    def test_actual_runtime_receipt_above_4096_is_independently_admitted(self):
        evidence, row, inventory_bytes = self._runtime_receipt(4097)
        checked = self.bindings.validate_lease_capacity(row, inventory_bytes, 0, LIMITS)
        self.assertEqual(checked['maximum'], 4097)
        self.assertEqual(checked['inventoryFiles'], 4097)
        self.assertEqual(row['model'], MODEL)
        self.assertEqual(row['scope'], SCOPE)
        self.assertGreater(checked['maximum'], 4096)

    def test_receipt_fields_and_formula_are_not_self_authority(self):
        evidence, row, inventory_bytes = self._runtime_receipt(10)
        cases = []
        for key, value in (('inventoryFiles', 9), ('preparedInputFiles', 1),
                           ('admissionMembers', 9), ('maximum', 11),
                           ('fdHeadroom', row['fdHeadroom'] + 1),
                           ('memoryRows', row['memoryRows'] + 1),
                           ('model', 'forged-model'), ('scope', 'forged-scope')):
            changed = dict(row)
            changed[key] = value
            cases.append((key, changed))
        for key, changed in cases:
            with self.subTest(field=key):
                with self.assertRaises(ValueError):
                    self.bindings.validate_lease_capacity(changed, inventory_bytes, 0, LIMITS)

    def test_missing_field_and_changed_inventory_digest_are_refused(self):
        _, row, inventory_bytes = self._runtime_receipt(2)
        missing = dict(row)
        del missing['inventoryOriginal']
        with self.assertRaises(ValueError):
            self.bindings.validate_lease_capacity(missing, inventory_bytes, 0, LIMITS)
        changed = dict(row)
        changed['inventory'] = dict(row['inventory'], sha256='0' * 64)
        changed['inventoryOriginal'] = dict(row['inventoryOriginal'], sha256='0' * 64)
        with self.assertRaises(ValueError):
            self.bindings.validate_lease_capacity(changed, inventory_bytes, 0, LIMITS)

    def test_duplicate_inventory_paths_are_refused(self):
        _, row, _ = self._runtime_receipt(2)
        data = b'{"' + str(self.root / 'dup').encode() + b'":{"bytes":0,"sha256":"' + b'a' * 64 + b'","mode":420},"' + str(self.root / 'dup').encode() + b'":{"bytes":0,"sha256":"' + b'a' * 64 + b'","mode":420}}'
        changed = dict(row)
        changed['inventory'] = dict(row['inventory'], bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        changed['inventoryOriginal'] = dict(row['inventoryOriginal'], bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        with self.assertRaises(ValueError):
            self.bindings.validate_lease_capacity(changed, data, 0, LIMITS)

    def test_duplicate_capacity_receipt_is_refused(self):
        _, row, inventory_bytes = self._runtime_receipt(2)
        seal = dict(kind='prepared-build-input-seal', phase='compile', sequence=1,
                    buildRoot='/opt/qlever-sdk/build', files=0,
                    inventorySha256=hashlib.sha256(b'').hexdigest())
        first = dict(row, phase='compile', sequence=2)
        second = dict(row, phase='compile', sequence=3)
        data = {row['inventoryOriginal']['path']: inventory_bytes}
        lines = [(json.dumps(item) + '\n').encode() for item in (seal, first, second)]
        with self.assertRaisesRegex(ValueError, 'pre-execution compile receipt'):
            self.bindings.observe([('compile', lines)], lambda name, maximum: data[name], limits=LIMITS)

    def test_capacity_after_root_is_refused_even_with_valid_receipt(self):
        _, row, _ = self._runtime_receipt(10)
        seal = dict(kind='prepared-build-input-seal', phase='compile', sequence=1,
                    buildRoot='/opt/qlever-sdk/build', files=0,
                    inventorySha256=hashlib.sha256(b'').hexdigest())
        root = dict(kind='owned-root-binding', phase='compile', sequence=2, pid=10,
                    backend='ptrace-all-stop-process-v1', toolchainLifetimeModel='kernel-held-read-lease-v1',
                    executableMemoryPolicy=None, btiHardeningModel=None, clone3ArgsModel=None)
        capacity = dict(row, phase='compile', sequence=3)
        lines = [(json.dumps(item) + '\n').encode() for item in (seal, root, capacity)]
        with self.assertRaisesRegex(ValueError, 'pre-execution compile receipt'):
            self.bindings.observe([('compile', lines)], lambda name, maximum: b'', limits=LIMITS)

    def test_missing_or_unbound_new_model_is_refused(self):
        _, row, _ = self._runtime_receipt(10)
        seal = dict(kind='prepared-build-input-seal', phase='compile', sequence=1,
                    buildRoot='/opt/qlever-sdk/build', files=0,
                    inventorySha256=hashlib.sha256(b'').hexdigest())
        root = dict(kind='owned-root-binding', phase='compile', sequence=2, pid=10,
                    backend='ptrace-all-stop-process-v1', toolchainLifetimeModel='kernel-held-read-lease-v1',
                    leaseAdmissionModel=MODEL, executableMemoryPolicy=None, btiHardeningModel=None, clone3ArgsModel=None)
        lines = [(json.dumps(item) + '\n').encode() for item in (seal, root)]
        with self.assertRaisesRegex(ValueError, 'lease admission model/capacity receipt mismatch'):
            self.bindings.observe([('compile', lines)], lambda name, maximum: b'', limits=LIMITS)


    def test_new_model_accepts_independently_validated_capacity_before_root(self):
        legacy = load('new_model_lease_fixture', LEGACY_FIXTURE)
        rows, originals, _ = legacy.build()
        inventory = {
            '/opt/qlever-sdk/source/a.h': dict(bytes=1, sha256='a' * 64, mode=0o644),
            '/opt/qlever-sdk/source/b.h': dict(bytes=2, sha256='b' * 64, mode=0o644),
        }
        data = json.dumps(inventory, sort_keys=True).encode()
        name = 'capture-9001.original'
        originals[name] = data
        original = dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        capacity = dict(
            kind='prepared-lease-capacity', model=MODEL,
            inventory=dict(path='inner/inputs-before.json', bytes=len(data), sha256=original['sha256']),
            inventoryOriginal=original, inventoryFiles=2, preparedInputFiles=0,
            admissionMembers=2, sourceMembers=LIMITS['sourceMembers'],
            fdSoft=1000, fdUsed=0, fdReserve=64, fdHeadroom=936,
            memoryBytes=1024 ** 2, memoryRowBytes=4096, memoryRows=256,
            maximum=2, scope=SCOPE)
        seal = dict(kind='prepared-build-input-seal', buildRoot='/opt/qlever-sdk/build',
                    files=0, inventorySha256=hashlib.sha256(b'').hexdigest())
        root = rows[0]
        root['leaseAdmissionModel'] = MODEL
        seal['sequence'] = 1
        seal['phase'] = 'compile'
        capacity['sequence'] = 2
        capacity['phase'] = 'compile'
        ordered = [seal, capacity] + rows
        mapping = {row['sequence']: index + 3 for index, row in enumerate(rows)}
        refs = ('entrySequence', 'barrierSequence', 'captureSequence', 'producerCaptureSequence',
                'windowSequence', 'inputObservationSequence', 'originalSequence', 'gateSequence',
                'readLeaseSequence', 'leaseSequence', 'lifetimeLeaseSequence', 'acquisitionSequence',
                'exitSequence', 'parentCaptureSequence', 'providerSequence')
        for index, row in enumerate(rows):
            row['sequence'] = index + 3
            for key in refs:
                if key in row and type(row[key]) is int and row[key] in mapping:
                    row[key] = mapping[row[key]]
        token_rows = [row for row in rows if row.get('kind') == 'toolchain-lease-closed-token']
        if token_rows:
            digest = hashlib.sha256()
            for row in token_rows:
                projection = dict(leaseId=row['leaseId'], identity=row['identity'],
                                  acquisitionSequence=row['acquisitionSequence'])
                digest.update((json.dumps(projection, sort_keys=True, separators=(',', ':')) + '\n').encode())
            for row in rows:
                if row.get('kind') == 'toolchain-leases-closed':
                    row['tokensSha256'] = digest.hexdigest()
        ordered = [seal, capacity] + rows
        result = self.bindings.observe(
            [('compile', [(json.dumps(row) + '\n').encode() for row in ordered])],
            lambda name, maximum: originals[name], limits=LIMITS)
        self.assertTrue(result['verifiedGeneratedProducerWitness'])

    def _multiphase_trace(self, late_capacity=False):
        """Real closed configure, then current compile with actual receipt."""
        legacy = load('multiphase_fixture', LEGACY_FIXTURE)
        configure, configure_originals, _ = legacy.build()
        compile_rows, compile_originals, _ = legacy.build()
        def rename(rows, originals, old, new):
            def walk(value):
                if isinstance(value, dict):
                    for key, item in list(value.items()):
                        if key == 'path' and item == old:
                            value[key] = new
                        else:
                            walk(item)
                elif isinstance(value, list):
                    for item in value: walk(item)
            for row in rows: walk(row)
            if old in originals: originals[new] = originals.pop(old)
        rename(configure, configure_originals, 'capture-9000.original', 'capture-8000.original')
        for row in configure: row['phase'] = 'configure'
        for row in compile_rows: row['phase'] = 'compile'

        def shift(rows, offset):
            old = {row['sequence']: index + offset for index, row in enumerate(rows)}
            for index, row in enumerate(rows):
                row['sequence'] = index + offset
                for key in ('entrySequence', 'barrierSequence', 'captureSequence',
                            'producerCaptureSequence', 'windowSequence',
                            'inputObservationSequence', 'originalSequence', 'gateSequence',
                            'readLeaseSequence', 'leaseSequence', 'lifetimeLeaseSequence',
                            'acquisitionSequence'):
                    if key in row and type(row[key]) is int and row[key] in old:
                        row[key] = old[row[key]]

        seal = dict(kind='prepared-build-input-seal', phase='configure', sequence=1,
                    buildRoot='/opt/qlever-sdk/build', files=0,
                    inventorySha256=hashlib.sha256(b'').hexdigest())
        shift(configure, 2)
        configure = [seal] + configure
        capacity_sequence = len(configure) + 1
        shift(compile_rows, capacity_sequence + 1)
        _, capacity, capacity_bytes = self._runtime_receipt(2)
        capacity['phase'] = 'compile'
        # The legacy fixture already owns capture-0001; give the capacity
        # receipt its own canonical capture name before coalescing the phases.
        capacity_original = 'capture-7000.original'
        capacity['inventoryOriginal'] = dict(capacity['inventoryOriginal'], path=capacity_original)
        compile_originals[capacity_original] = capacity_bytes
        root = next(row for row in compile_rows if row['kind'] == 'owned-root-binding')
        root['leaseAdmissionModel'] = MODEL
        def refresh_token_digests(rows):
            token_rows = [row for row in rows if row.get('kind') == 'toolchain-lease-closed-token']
            if not token_rows: return
            digest = hashlib.sha256()
            for row in token_rows:
                projection = dict(leaseId=row['leaseId'], identity=row['identity'],
                                  acquisitionSequence=row['acquisitionSequence'])
                digest.update((json.dumps(projection, sort_keys=True, separators=(',', ':')) + '\n').encode())
            for row in rows:
                if row.get('kind') == 'toolchain-leases-closed':
                    row['tokensSha256'] = digest.hexdigest()
        refresh_token_digests(configure)
        refresh_token_digests(compile_rows)
        if late_capacity:
            # Keep the receipt sequence strictly after the current compile root;
            # the phase-local guard must still reject it because roots is non-empty.
            capacity['sequence'] = capacity_sequence + len(compile_rows)
            ordered = configure + compile_rows + [capacity]
        else:
            capacity['sequence'] = capacity_sequence
            ordered = configure + [capacity] + compile_rows
        return ordered, {**configure_originals, **compile_originals}, capacity

    def test_multiphase_configure_then_compile_capacity_is_admitted(self):
        rows, originals, _ = self._multiphase_trace()
        result = self.bindings.observe(
            [('configure', [(json.dumps(row) + '\n').encode() for row in rows if row['phase'] == 'configure']),
             ('compile', [(json.dumps(row) + '\n').encode() for row in rows if row['phase'] == 'compile'])],
            lambda name, maximum: originals[name], limits=LIMITS)
        self.assertTrue(result['phaseTracking'])
        self.assertEqual(result['phaseTracking'][0]['phase'], 'configure')

    def test_multiphase_late_capacity_after_current_compile_root_is_refused(self):
        rows, originals, _ = self._multiphase_trace(late_capacity=True)
        with self.assertRaises(ValueError):
            self.bindings.observe(
                [('configure', [(json.dumps(row) + '\n').encode() for row in rows if row['phase'] == 'configure']),
                 ('compile', [(json.dumps(row) + '\n').encode() for row in rows if row['phase'] == 'compile'])],
                lambda name, maximum: originals[name], limits=LIMITS)

    def test_capacity_capture_is_registered_into_real_consumer_zip_index(self):
        mmap_fixture = load('capacity_consumer_fixture', ROOT / 'qlever/tests/test_sdk_generated_mmap_custody_credit.py')
        rows, originals, _ = mmap_fixture.scenario()
        _, capacity, capacity_bytes = self._runtime_receipt(2)
        capacity_name = 'capture-7001.original'
        old_capacity_name = capacity['inventoryOriginal']['path']
        old_path = self._last_capacity_observer.capture_dir / old_capacity_name
        new_path = self._last_capacity_observer.capture_dir / capacity_name
        old_path.rename(new_path)
        self._last_capacity_observer.captures[0]['original']['path'] = capacity_name
        capacity['inventoryOriginal'] = dict(capacity['inventoryOriginal'], path=capacity_name)
        originals[capacity_name] = capacity_bytes
        registration = dict(kind='write-original', phase='compile', original=dict(path=capacity_name,
                            bytes=len(capacity_bytes), sha256=hashlib.sha256(capacity_bytes).hexdigest()))
        seal = dict(kind='prepared-build-input-seal', phase='compile', buildRoot='/opt/qlever-sdk/build',
                    files=0, inventorySha256=hashlib.sha256(b'').hexdigest())
        capacity['phase'] = 'compile'
        root = next(row for row in rows if row['kind'] == 'owned-root-binding')
        root['leaseAdmissionModel'] = MODEL
        ordered = [seal, capacity, registration] + rows
        mapping = {row['sequence']: index + 4 for index, row in enumerate(rows)}
        refs = ('entrySequence', 'barrierSequence', 'captureSequence', 'producerCaptureSequence',
                'windowSequence', 'inputObservationSequence', 'originalSequence', 'gateSequence',
                'readLeaseSequence', 'leaseSequence', 'lifetimeLeaseSequence', 'acquisitionSequence',
                'exitSequence', 'parentCaptureSequence', 'providerSequence')
        for index, row in enumerate(rows):
            row['sequence'] = index + 4
            for key in refs:
                if key in row and type(row[key]) is int and row[key] in mapping:
                    row[key] = mapping[row[key]]
        token_rows = [row for row in rows if row.get('kind') == 'toolchain-lease-closed-token']
        if token_rows:
            digest = hashlib.sha256()
            for row in token_rows:
                digest.update((json.dumps(dict(leaseId=row['leaseId'], identity=row['identity'],
                                               acquisitionSequence=row['acquisitionSequence']),
                                          sort_keys=True, separators=(',', ':')) + '\n').encode())
            for row in rows:
                if row.get('kind') == 'toolchain-leases-closed':
                    row['tokensSha256'] = digest.hexdigest()
        seal['sequence'] = 1
        capacity['sequence'] = 2
        registration['sequence'] = 3
        prefix = 'inner/toolchain-execution/'
        phase_captures = self._last_capacity_observer.phase_capture_files(0)
        self.assertEqual(len(phase_captures), 1)
        self.assertEqual(Path(phase_captures[0]['path']).name, capacity_name)
        caps = [dict(path=prefix + 'captures/' + Path(phase_captures[0]['path']).name,
                     bytes=phase_captures[0]['bytes'], sha256=phase_captures[0]['sha256'])]
        caps += [dict(path=prefix + 'captures/' + name, bytes=len(data),
                      sha256=hashlib.sha256(data).hexdigest()) for name, data in sorted(originals.items())
                 if name != capacity_name]
        members = {prefix + 'captures/' + name: data for name, data in originals.items()}
        rawpath = prefix + 'compile.trace-0000.jsonl'
        members[rawpath] = b''.join((json.dumps(row) + '\n').encode() for row in ordered)
        idx = prefix + 'capture-index-0000.json'
        members[idx] = json.dumps(dict(schemaVersion=1, files=caps)).encode()
        provider = prefix + 'source-provider.mountinfo.raw'
        members[provider] = b'1 0 0:1 / / ro - overlay overlay ro\n'
        def ref(path):
            return dict(path=path, bytes=len(members[path]), sha256=hashlib.sha256(members[path]).hexdigest())
        plan = dict(sourceRoot='/opt/qlever-sdk/source',
                    sourceProviderOriginals=dict(mountinfo=ref(provider)),
                    remainingMilliseconds=5000,
                    phases=[dict(name='compile', actualCommand=list(root['command']),
                                 rawTraceShards=[ref(rawpath)],
                                 captures=dict(indexes=[ref(idx)], files=len(caps),
                                               bytes=sum(item['bytes'] for item in caps)))],
                    sourceFiles={}, requiredInputs={})
        consumer = load('capacity_real_consumer', ROOT / 'qlever/scripts/sdk-generated-source-originals.py')

        def run_consumer(members, caps, base_plan):
            local=dict(members)
            local[idx]=json.dumps(dict(schemaVersion=1, files=caps)).encode()
            local_plan=json.loads(json.dumps(base_plan))
            phase=local_plan['phases'][0]
            phase['captures']['files']=len(caps)
            phase['captures']['bytes']=sum(item['bytes'] for item in caps)
            phase['captures']['indexes']=[dict(path=idx, bytes=len(local[idx]),
                                               sha256=hashlib.sha256(local[idx]).hexdigest())]
            with tempfile.TemporaryDirectory(prefix='capacity-capture-', dir='/tmp') as directory:
                archive = Path(directory) / 'sdk.zip'
                with zipfile.ZipFile(archive, 'w') as out:
                    for path, data in local.items():
                        out.writestr(path, data)
                return consumer.observe(archive, local_plan)

        result = run_consumer(members, caps, plan)
        self.assertIn('phaseTracking', result)
        self.assertEqual(result['phaseTracking'][0]['phase'], 'compile')
        extra=dict(members);extra[prefix+'captures/capture-9999.original']=b'unregistered-extra'
        with self.assertRaisesRegex(ValueError, 'capture original ZIP closed set differs'):
            run_consumer(extra, caps, plan)
        duplicate_caps=caps+[dict(caps[0])]
        with self.assertRaises(ValueError):
            run_consumer(members, duplicate_caps, plan)
        drift=dict(members);drift[prefix+'captures/'+capacity_name]=b'X'+capacity_bytes[1:]
        with self.assertRaises(ValueError):
            run_consumer(drift, caps, plan)

    def test_legacy_trace_without_capacity_remains_explicitly_supported(self):
        legacy = load('legacy_lease_fixture', LEGACY_FIXTURE)
        rows, originals, _ = legacy.build()
        self.assertFalse(any(row.get('kind') == 'prepared-lease-capacity' for row in rows))
        result = self.bindings.observe(
            [('compile', [(json.dumps(row) + '\n').encode() for row in rows])],
            lambda name, maximum: originals[name])
        self.assertTrue(result['verifiedGeneratedProducerWitness'])


if __name__ == '__main__':
    unittest.main()
