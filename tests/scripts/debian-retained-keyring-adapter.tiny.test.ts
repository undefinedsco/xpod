/**
 * Retained-keyring adapter MECHANICS.
 *
 * Portable by construction: every fixture is a deterministic in-memory byte
 * string created by this test. There is no /tmp path, no environment fallback,
 * no hidden skip, and no claim that these bytes are a real Debian keyring.
 * OpenPGP acceptance itself (VALIDSIG primary+signing + validity window) stays
 * in the unchanged reviewed policy and is exercised by the genuine raw Linux
 * full-core probe owned elsewhere, not here.
 *
 * What this file does prove about the real exported adapter:
 *   - exact identity is required and returned;
 *   - EVERY index row must carry a typed keyring ref;
 *   - all bound refs must describe one identical original;
 *   - a differing member byte/SHA is refused;
 *   - the declared bound is enforced before any read;
 *   - the adapter makes no fingerprint/validity decision of its own.
 */
import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {
  inspectRetainedControllerKeyring,
  type DebianSignatureReader,
} from '../../scripts/lib/independent-admission/qlever-sdk-debian-signature';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type Ref = Readonly<{path: string; bytes: number; sha256: string}>;
/** Derive the real exported parameter types instead of re-declaring a local
 * shape: an upstream signature change must fail this test at compile time. */
type ReaderArg = Parameters<typeof inspectRetainedControllerKeyring>[0];
type CollectionArg = Parameters<typeof inspectRetainedControllerKeyring>[1];
type MembersArg = Parameters<typeof inspectRetainedControllerKeyring>[2];

const KEYRING_PATH = 'inner/debian-source/indexes/debian-archive-keyring.gpg';

/** Deterministic, clearly non-authoritative fixture bytes. Named so no reader
 * can mistake them for a captured Debian keyring. */
function fixtureBytes(tag: string): Buffer {
  return Buffer.from(`MECHANICS-ONLY-NOT-A-DEBIAN-KEYRING ${tag}\n`.repeat(4));
}

function ref(bytes: Buffer, file = KEYRING_PATH): Ref {
  return Object.freeze({path: file, bytes: bytes.length, sha256: sha(bytes)});
}

function readerFor(rows: ReadonlyMap<string, Buffer>): DebianSignatureReader {
  const members = [...rows].map(([file, bytes]) => ({
    path: file, bytes: bytes.length, sha256: sha(bytes),
  }));
  return {
    members,
    readOriginal: (file: string, maximum: number) => {
      const bytes = rows.get(file);
      if (!bytes) throw Error('unexpected read: ' + file);
      if (bytes.length > maximum) throw Error('read exceeds caller maximum: ' + file);
      return Buffer.from(bytes);
    },
    masterReference: members[0]!,
    originFacts: {sourceSha: 'a'.repeat(40), target: 'linux-x64', producerJobId: 1, originals: []},
    metadataOriginals: [],
    kind: 'qlever-linux-sdk-originals',
    sdkProfile: 'service-trixie',
  };
}

/** One index row plus the retained-keyring ref the exported `Collection` type
 * does not yet name. The widened row type stays structurally assignable to the
 * real parameter type, so no cast is used to silence the compiler. */
type IndexRowWithKeyring = CollectionArg['indexOriginals'][number] & {keyring?: Ref};

function collectionFor(keyrings: readonly (Ref | undefined)[]): CollectionArg {
  const indexOriginals: IndexRowWithKeyring[] = keyrings.map((keyring, index) => ({
    inRelease: {path: `inner/debian-source/indexes/${index}_InRelease`, bytes: 1, sha256: 'a'.repeat(64)},
    sources: {path: `inner/debian-source/indexes/${index}_Sources`, bytes: 1, sha256: 'b'.repeat(64)},
    verificationStage: {
      name: `debian-index-${index}`,
      receipt: {path: 'r', bytes: 1, sha256: 'c'.repeat(64)},
      supervisionReceipt: {path: 's', bytes: 1, sha256: 'd'.repeat(64)},
    },
    ...(keyring === undefined ? {} : {keyring}),
  }));
  const collection: CollectionArg = {
    schemaVersion: 1,
    kind: 'qlever-sdk-exact-debian-source-originals',
    indexOriginals,
  };
  return collection;
}

function membersFor(rows: ReadonlyMap<string, Buffer>): MembersArg {
  return new Map([...rows].map(([file, bytes]) => [file, {
    path: file, bytes: bytes.length, sha256: sha(bytes),
  }]));
}

test('positive: the exact retained identity is returned with its verified bytes', () => {
  const bytes = fixtureBytes('positive');
  const reference = ref(bytes);
  const rows = new Map([[reference.path, bytes]]);
  const retained = inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([reference]), membersFor(rows));

  expect(retained).toBeDefined();
  expect(retained!.ref).toEqual(reference);
  expect(retained!.bytes.equals(bytes)).toBe(true);
  expect(retained!.identities).toEqual([reference]);
});

test('missing keyring on the ONLY row is refused, never silently absent', () => {
  const rows = new Map<string, Buffer>();
  expect(() => inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([undefined]), membersFor(rows)))
    .toThrow('every index row must carry its retained keyring original');
});

test('missing keyring on a LATER row is refused, not skipped', () => {
  const bytes = fixtureBytes('later');
  const reference = ref(bytes);
  const rows = new Map([[reference.path, bytes]]);
  expect(() => inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([reference, undefined]), membersFor(rows)))
    .toThrow('every index row must carry its retained keyring original');
});

test('two different keyrings across rows are refused as a split trust root', () => {
  const first = fixtureBytes('first');
  const second = fixtureBytes('second');
  const firstRef = ref(first);
  const secondRef = ref(second, 'inner/debian-source/indexes/other-keyring.gpg');
  const rows = new Map([[firstRef.path, first], [secondRef.path, second]]);
  expect(() => inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([firstRef, secondRef]), membersFor(rows)))
    .toThrow('all index rows must bind one identical retained keyring original');
});

test('identical refs on every row collapse to one identity', () => {
  const bytes = fixtureBytes('identical');
  const reference = ref(bytes);
  const rows = new Map([[reference.path, bytes]]);
  const retained = inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([reference, reference, reference]), membersFor(rows));
  expect(retained!.identities.length).toBe(1);
  expect(retained!.ref).toEqual(reference);
});

test('a member byte changed under the declared identity is refused', () => {
  const bytes = fixtureBytes('tamper');
  const reference = ref(bytes);
  const mutated = Buffer.from(bytes);
  mutated[mutated.length - 1] ^= 0xff;
  const rows = new Map([[reference.path, mutated]]);
  expect(() => inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([reference]), membersFor(rows)))
    .toThrow('retained keyring original reference differs');
});

test('a members entry with a different declared SHA is refused', () => {
  const bytes = fixtureBytes('sha');
  const reference = ref(bytes);
  const rows = new Map([[reference.path, bytes]]);
  const wrong = new Map([[reference.path, {
    path: reference.path, bytes: bytes.length, sha256: 'f'.repeat(64),
  }]]);
  expect(() => inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([reference]), wrong))
    .toThrow('retained keyring original reference differs');
});

test('the declared 4 MiB bound is enforced before any read', () => {
  const reference = Object.freeze({
    path: KEYRING_PATH, bytes: 4 * 1024 ** 2 + 1, sha256: 'e'.repeat(64),
  });
  const rows = new Map<string, Buffer>();
  let reads = 0;
  const reader = readerFor(rows);
  const counted: ReaderArg = {
    ...reader,
    readOriginal: (file: string, maximum: number) => {
      reads += 1;
      return reader.readOriginal(file, maximum);
    },
  };
  // The members entry must match the ref so the SIZE bound is what rejects it.
  const members: MembersArg = new Map([[reference.path, reference]]);
  expect(() => inspectRetainedControllerKeyring(counted, collectionFor([reference]), members))
    .toThrow('retained keyring original bound');
  expect(reads).toBe(0);
});

test('an untyped or non-positive keyring reference is refused', () => {
  const bytes = fixtureBytes('typed');
  const good = ref(bytes);
  const rows = new Map([[good.path, bytes]]);
  const badRefs = [
    {path: good.path, bytes: 0, sha256: good.sha256},
    {path: '', bytes: bytes.length, sha256: good.sha256},
    {path: good.path, bytes: bytes.length, sha256: 'not-a-sha'},
    {path: good.path, bytes: 1.5, sha256: good.sha256},
  ];
  for (const bad of badRefs) {
    expect(() => inspectRetainedControllerKeyring(
      readerFor(rows), collectionFor([bad as Ref]), membersFor(rows)))
      .toThrow('typed retained keyring reference required');
  }
});

/**
 * Behavioural, not source-regex: the adapter cannot widen trust because it
 * returns only bytes+identity. Feed a keyring whose CONTENT contradicts the
 * frozen policy and assert the adapter still performs no acceptance decision —
 * it succeeds on identity alone, and the policy module is the only place a
 * fingerprint or validity window is named. The policy decision itself is
 * exercised by the raw Linux full-core probe, not by this mechanics test.
 */
test('adapter returns identity only; it never decides OpenPGP acceptance', () => {
  const bytes = Buffer.from('MECHANICS-ONLY-NOT-A-DEBIAN-KEYRING no-key-material\n');
  const reference = ref(bytes);
  const rows = new Map([[reference.path, bytes]]);
  const retained = inspectRetainedControllerKeyring(
    readerFor(rows), collectionFor([reference]), membersFor(rows));
  expect(retained!.bytes.equals(bytes)).toBe(true);
  // Returning a value here is identity success, never cryptographic success:
  // the returned object has no verified/fingerprint/validity field at all.
  expect(Object.keys(retained!).sort()).toEqual(['bytes', 'identities', 'ref']);
});
