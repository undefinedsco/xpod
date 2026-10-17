import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({cap: undefined as any, view: undefined as any}));
// Protocol fixture only, NEVER a central issuer or actual OpenPGP authority.
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-originals', () => ({qleverSdkOriginalsView: (value: unknown) => value === fixture.cap ? fixture.view : undefined}));
import { observeQleverSdkDebianIndexOriginals, qleverSdkDebianIndexObservation } from '../../scripts/lib/independent-admission/qlever-sdk-debian-index';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function scenario(change?: (rows: Map<string, Buffer>, collection: any, master: any) => void, remainingMilliseconds?: number, zipForm?: 'zip64' | 'oversized-directory', budgetFault?: 'pre-expired' | 'post-expired' | 'near-end') {
  mkdirSync('.test-data/sdk-debian-index-observer', {recursive: true});
  const root = mkdtempSync(path.resolve('.test-data/sdk-debian-index-observer/case-'));
  const rows = new Map<string, Buffer>();
  const put = (name: string, value: Buffer | object) => { rows.set(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))); return ref(name); };
  const ref = (name: string) => ({path: name, bytes: rows.get(name)!.length, sha256: hash(rows.get(name)!)});
  const indexes = 'inner/debian-source/indexes/';
  const packages = ['alpha', 'beta'].map((name, i) => ({name, version: '1:1.0-1', files: [],
    dsc: put(`inner/debian-source/package-000${i}/${name}_1.0-1.dsc`, Buffer.from(`Source: ${name}\nVersion: 1:1.0-1\n`))}));
  const sources = packages.map(item => Buffer.from(`Package: ${item.name}\nVersion: ${item.version}\nDirectory: pool/main/${item.name[0]}/${item.name}\nDescription: ${'large-index-field-'.repeat(5000)}\nChecksums-Sha256:\n ${item.dsc.sha256} ${item.dsc.bytes} ${path.posix.basename(item.dsc.path)}\n\n`));
  const release = put(indexes + 'deb.example_debian_dists_bookworm_InRelease', Buffer.from('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nOrigin: Debian\nSHA256:\n' + sources.map((bytes, i) => ` ${hash(bytes)} ${bytes.length} ${i === 0 ? 'main' : 'contrib'}/source/Sources\n`).join('') + '-----BEGIN PGP SIGNATURE-----\nnot-real-signature\n-----END PGP SIGNATURE-----\n'));
  const keyring = put(indexes + 'debian-archive-keyring.gpg', Buffer.from('fixture-keyring-not-official-authority'));
  const command = ['gpgv', '--keyring', '/opt/qlever-sdk/materials/' + keyring.path.slice(6), '/opt/qlever-sdk/materials/' + release.path.slice(6)];
  const stdout = put('inner/stages/debian-index-0/stdout.raw', Buffer.alloc(0)), stderr = put('inner/stages/debian-index-0/stderr.raw', Buffer.from('fixture raw; text never grants signature authority'));
  const receipt = put('inner/stages/debian-index-0/command.receipt.json', {schemaVersion: 1, command, actualWait: true, exit: 0, signal: null, pid: 42, pgid: 41,
    rawClosedBeforeHash: true, startedUnixNs: Date.parse('2026-10-17T00:00:10Z') * 1e6, completedUnixNs: Date.parse('2026-10-17T00:00:11Z') * 1e6,
    stdout: {...stdout, path: 'stdout.raw'}, stderr: {...stderr, path: 'stderr.raw'}});
  const supervisionRaw = put('inner/stages/debian-index-0.raw.log', Buffer.alloc(0));
  const supervisionReceipt = put('inner/stages/debian-index-0.receipt.json', {command: ['/usr/bin/python3', '-B', '/components/qlever/scripts/sdk-command-materials.py', '--exec-child', '/opt/qlever-sdk/materials/stages/debian-index-0', JSON.stringify(command)],
    pid: 41, pgid: 41, actualWait: true, exit: 0, signal: null, ownedGroupAbsentAfterWait: true, rawClosedBeforeHash: true, rawSHA256: supervisionRaw.sha256,
    resourceStop: null, supervisorError: null, elapsedSeconds: 3, cleanupErrors: [], ownedGroupMembers: [], startedUTC: '2026-10-17T00:00:09Z', closedUTC: '2026-10-17T00:00:12Z'});
  const stage = {name: 'debian-index-0', receipt, stdout, stderr, supervisionRaw, supervisionReceipt, inputs: [], outputs: []};
  const collection: any = {schemaVersion: 1, kind: 'qlever-sdk-exact-debian-source-originals', packages, indexOriginals: sources.map((bytes, i) => ({inRelease: release, keyring, verificationStage: stage,
    sources: put(indexes + ['main', 'contrib'][i] + '_source_Sources.gz', execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', 'import gzip,sys;sys.stdout.buffer.write(gzip.compress(sys.stdin.buffer.read(),mtime=0))'], {input: bytes}))}))};
  const master: any = {kind: 'qlever-linux-sdk-originals', identity: {sourceSha: '1'.repeat(40), target: 'linux-x64'}, stages: [stage]};
  let clock: {mockRestore(): void} | undefined, offset = 0;
  if (budgetFault) { const now = performance.now.bind(performance); clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + offset); }
  try {
    change?.(rows, collection, master);
    // Refresh references as an internally consistent supplied SDK protocol,
    // not a simulated private issuance or a JSON approval escape hatch.
    function refresh(value: any): any {
      if (Array.isArray(value)) return value.map(refresh);
      if (!value || typeof value !== 'object') return value;
      if ('path' in value && 'bytes' in value && 'sha256' in value) return ref(value.path);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, refresh(item)]));
    }
    master.stages = refresh(master.stages); const actualCollection = refresh(collection);
    master.debianSources = put('inner/debian-source/materials.json', actualCollection); const masterReference = put('materials.json', master);
    const jobs = Buffer.from(JSON.stringify({jobs: [{id: 100, started_at: '2026-10-17T00:00:00Z', completed_at: '2026-10-17T00:01:00Z'}]}));
    const zip = path.join(root, 'sdk.zip');
    execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', 'import sys,json,zipfile,base64\nx=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED) as z:\n for name,value in x.items():z.writestr(name,base64.b64decode(value))', zip], {input: JSON.stringify(Object.fromEntries([...rows].map(([name, bytes]) => [name, bytes.toString('base64')]))) });
    if (zipForm) execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', 'import pathlib,struct,sys\np=pathlib.Path(sys.argv[1]);b=p.read_bytes();at=b.rfind(b"PK\\x05\\x06");e=list(struct.unpack_from("<4s4H2LH",b,at))\nif sys.argv[2]=="zip64":\n z=struct.pack("<4sQ2H2L4Q",b"PK\\x06\\x06",44,45,45,0,0,e[4],e[4],e[5],e[6]);l=struct.pack("<4sLQL",b"PK\\x06\\x07",0,at,1);e[3]=e[4]=65535;e[5]=e[6]=0xffffffff;p.write_bytes(b[:at]+z+l+struct.pack("<4s4H2LH",*e))\nelse:\n e[5]=4194305;p.write_bytes(b[:at]+struct.pack("<4s4H2LH",*e))', zip, zipForm]);
    const archive = {bytes: readFileSync(zip).length, sha256: hash(readFileSync(zip))};
    fixture.cap = Object.freeze({fixture: true}); let zipCalls = 0, callbackCalls = 0; const observedRemaining: number[] = [];
    fixture.view = {masterReference, archive, originFacts: {sourceSha: '1'.repeat(40), target: 'linux-x64', producerJobId: 100,
      originals: [{name: 'jobs.original.json', bytes: jobs.length, sha256: hash(jobs)}]}, metadataOriginals: [{name: 'jobs.original.json', data: jobs}],
      members: [...rows].map(([name]) => ref(name)), readOriginal: (name: string, maximum: number) => {
        if (name.includes('_source_Sources')) throw Error('Whole Sources buffers forbidden');
        const bytes = rows.get(name)!; if (bytes.length > maximum) throw Error('bounded'); return Buffer.from(bytes);
      }, withArchiveFile: async (fn: any, budget: any) => {
        zipCalls++; expect(budget).toBeDefined(); const initial = budget.remainingMs(); observedRemaining.push(initial);
        if (budgetFault === 'pre-expired') offset += initial + 1;
        if (budgetFault === 'near-end') offset += initial - 0.1;
        budget.check(); if (Math.floor(budget.remainingMs()) < 1) throw Error('collector: remaining budget below one millisecond');
        callbackCalls++; const value = await fn({path: zip, identity: archive});
        if (budgetFault === 'post-expired') offset += initial + 1;
        budget.check(); observedRemaining.push(budget.remainingMs()); return value;
      }};
    const result = await observeQleverSdkDebianIndexOriginals(fixture.cap, remainingMilliseconds);
    const projection = qleverSdkDebianIndexObservation(fixture.cap);
    if (result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified) {
      expect(projection).toHaveLength(2); expect(Object.isFrozen(projection)).toBe(true);
      expect(Object.isFrozen(projection![0]!.observation.signedIndexMatches[0])).toBe(true);
      const first = projection![0]!.observation.signedIndexMatches[0]!.path;
      (result.facts.sdkDebianIndexChecksumBindings as any[])[0].observation.signedIndexMatches[0].path = 'changed-public-report';
      expect(projection![0]!.observation.signedIndexMatches[0]!.path).toBe(first);
      const read = fixture.view.readOriginal; fixture.view.readOriginal = () => {throw Error('compacted reader');};
      expect(() => qleverSdkDebianIndexObservation(fixture.cap)).toThrow('compacted reader'); fixture.view.readOriginal = read;
    } else expect(projection).toBeUndefined();
    expect(qleverSdkDebianIndexObservation({verified: true})).toBeUndefined();
    return {result, zipCalls, callbackCalls, observedRemaining};
  } finally {clock?.mockRestore(); fixture.cap = fixture.view = undefined; rmSync(root, {recursive: true, force: true});}
}
it('uses exact SDK ZIP streaming plus actual gpgv stage roles, aggregates multiple indexes and leaves signature authority pending', async () => {
  const {result, zipCalls} = await scenario();
  expect(zipCalls).toBe(2);
  expect((await scenario(undefined, undefined, 'zip64')).result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).toBe(true);
  expect((await scenario(undefined, undefined, 'oversized-directory')).result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
  expect(result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).toBe(true);
  expect(result.pending).toEqual(['qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified']);
  expect((result.facts.sdkDebianIndexChecksumBindings as any[]).map(row => row.observation.packages[0].name)).toEqual(['alpha', 'beta']);
  const expired = await scenario(undefined, 0);
  expect(expired.zipCalls).toBe(0);
  expect(expired.result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
  expect((await observeQleverSdkDebianIndexOriginals({fixture: true})).facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
});
it('refuses self-consistent wrong gpgv argv, failed/unclosed execution, altered dual raw, missing master stage and unbound index bytes', async () => {
  const mutate = (rows: Map<string, Buffer>, name: string, fn: (value: any) => void) => { const value = JSON.parse(rows.get(name)!.toString()); fn(value); rows.set(name, Buffer.from(JSON.stringify(value))); };
  for (const change of [
    (rows: Map<string, Buffer>) => mutate(rows, 'inner/stages/debian-index-0/command.receipt.json', value => {value.command[0] = 'true';}),
    (rows: Map<string, Buffer>) => mutate(rows, 'inner/stages/debian-index-0/command.receipt.json', value => {value.exit = 1;}),
    (rows: Map<string, Buffer>) => mutate(rows, 'inner/stages/debian-index-0.receipt.json', value => {value.ownedGroupAbsentAfterWait = false;}),
    (rows: Map<string, Buffer>) => rows.set('inner/stages/debian-index-0/stderr.raw', Buffer.from('altered')),
    (_rows: Map<string, Buffer>, _collection: any, master: any) => {master.stages = [];},
    (rows: Map<string, Buffer>, collection: any) => {rows.set(collection.indexOriginals[0].sources.path, Buffer.from('Package: wrong\nVersion: 9\n\n'));},
  ]) expect((await scenario(change)).result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
});

it('shares the caller deadline with both archive scans and rejects expired or sub-millisecond remaining windows', async () => {
  for (const phase of ['pre-expired', 'near-end', 'post-expired'] as const) {
    const value = await scenario(undefined, 5000, undefined, phase);
    expect(value.zipCalls).toBe(1);
    expect(value.callbackCalls).toBe(phase === 'post-expired' ? 1 : 0);
    expect(value.observedRemaining[0]).toBeGreaterThan(0);
    expect(value.observedRemaining[0]).toBeLessThanOrEqual(5000);
    expect(value.result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
  }
  const normal = await scenario(undefined, 5000);
  expect(normal.result.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).toBe(true);
  expect(normal.observedRemaining.every(value => value > 0 && value <= 5000)).toBe(true);
  expect(normal.observedRemaining[3]).toBeLessThan(normal.observedRemaining[0]!);
});
