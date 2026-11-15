/** Legacy AFS producer/consumer INTAKE negatives (real production entry points).
 *
 * This file deliberately covers ONE layer only: the runtime-coordinate and
 * selector admission gates of the real generic acquirer
 * (`acquireLegacyRootSupply(input, output, {fetch})`) and the real legacy wrapper
 * (`acquire(input, output, {fetch})`), both at the R5 three-parameter contract.
 *
 * Every case injects a fetch spy that would throw a loud sentinel, then asserts:
 *  - the EXACT production error message (no "any rejection passes" pattern),
 *  - the spy was never called (0 network attempts, not inferred from directories),
 *  - the R5 output side effect: no directory exists for an invalid runtime
 *    coordinate; for a legal runtime coordinate rejected only by the generic
 *    selector whitelist the wrapper's documented pre-acquisition `mkdir` exists
 *    but stays empty (no custody, originals or request were produced).
 *
 * The positive producer1/consumer2 full chain is intentionally NOT here; it lives
 * with the shared full-chain fixture so this file can never pass by accepting an
 * unrelated error.
 */
import {describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {
  acquireLegacyRootSupply,
  type ArtifactAcquisitionInput,
} from '../../scripts/acquire-independent-product-input';
import {acquire} from '../../scripts/legacy-root-afs-supply';

const SOURCE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const RUN_ID = 40637818669;
const PRODUCER = 1;
const CONSUMER = 2;

const ENV_KEYS = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'] as const;
type RuntimeEnv = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

const VALID_ENV: RuntimeEnv = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'undefinedsco/xpod',
  GITHUB_RUN_ID: String(RUN_ID),
  GITHUB_RUN_ATTEMPT: String(CONSUMER),
};

const COORDINATE_PRODUCER = 'Artifact acquisition: producer attempt coordinate required';
const COORDINATE_CONSUMER = 'Artifact acquisition: consumer attempt coordinate required';
const FUTURE_PRODUCER = 'Artifact acquisition: producer attempt is later than the consumer lane';
const RUNTIME_BINDING = 'Artifact acquisition: same-run runtime binding required';
const UNKNOWN_SELECTOR = 'Artifact acquisition: unknown acquisition selector';

function selector(runAttempt: number): ArtifactAcquisitionInput {
  return {
    schemaVersion: 1,
    sourceSha: SOURCE,
    runHeadSha: HEAD,
    runId: RUN_ID,
    runAttempt,
    artifactId: 12794257416,
    artifactSha256: DIGEST,
  };
}

/** Runs `operation` with exactly the four public GitHub coordinate variables and
 * restores their previous values afterwards. No other environment is read,
 * written or dumped. */
async function withRuntimeEnv(values: RuntimeEnv, operation: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as Record<string, string | undefined>;
  try {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await operation();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeNetworkSpy() {
  const calls = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error('unexpected network request');
  });
  // The injected transport only forwards to the spy, so a zero call count is a
  // real observation of "no network was attempted", not a directory inference.
  const transport: typeof fetch = (input, init) => calls(input, init);
  return {calls, transport};
}

function workspaceCase(label: string): string {
  const parent = path.resolve('.test-data/legacy-afs-producer-attempt-intake');
  mkdirSync(parent, {recursive: true});
  return realpathSync(mkdtempSync(path.join(parent, label + '-')));
}

type Entry = {
  generic: boolean;
  run: (input: ArtifactAcquisitionInput, output: string, transport: typeof fetch) => Promise<unknown>;
};

const ENTRIES: Entry[] = [
  {generic: true, run: (input, output, transport) => acquireLegacyRootSupply(input, output, {fetch: transport})},
  {generic: false, run: (input, output, transport) => acquire(input, output, {fetch: transport})},
];

async function expectRejectedWithoutSideEffect(
  entry: Entry,
  input: ArtifactAcquisitionInput,
  root: string,
  message: string,
): Promise<void> {
  const output = path.join(root, 'out');
  // The parent exists, so a coordinate rejection can never be confused with a
  // failed mkdir of the output itself.
  const {calls, transport} = makeNetworkSpy();
  const failure = await entry.run(input, output, transport).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(message);
  expect(calls).toHaveBeenCalledTimes(0);
  expect(existsSync(output)).toBe(false);
  expect(readdirSync(root)).toEqual([]);
}

describe('runtime coordinate intake', () => {
  const producerFailures: Array<[string, number]> = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ];

  for (const [label, producer] of producerFailures) {
    it(`rejects a ${label} producer attempt before any request or mkdir`, async () => {
      for (const entry of ENTRIES) {
        const root = workspaceCase('producer-' + label.replace(/\s+/g, '-'));
        try {
          await withRuntimeEnv(VALID_ENV, () =>
            expectRejectedWithoutSideEffect(entry, selector(producer), root, COORDINATE_PRODUCER));
        } finally {
          rmSync(root, {recursive: true, force: true});
        }
      }
    });
  }

  const consumerFailures: Array<[string, string | undefined]> = [
    ['leading zero', '01'],
    ['exponent spelling', '2e0'],
    ['decimal spelling', '2.0'],
    ['leading space', ' 2'],
    ['empty', ''],
    ['missing', undefined],
    ['unsafe integer', '9007199254740993'],
  ];

  for (const [label, raw] of consumerFailures) {
    it(`rejects a consumer attempt with ${label} spelling before any request or mkdir`, async () => {
      for (const entry of ENTRIES) {
        const root = workspaceCase('consumer-' + label.replace(/\s+/g, '-'));
        try {
          await withRuntimeEnv({...VALID_ENV, GITHUB_RUN_ATTEMPT: raw}, () =>
            expectRejectedWithoutSideEffect(entry, selector(PRODUCER), root, COORDINATE_CONSUMER));
        } finally {
          rmSync(root, {recursive: true, force: true});
        }
      }
    });
  }

  it('rejects a fully self-consistent future producer 3 against live consumer 2 before any fetch', async () => {
    for (const entry of ENTRIES) {
      const root = workspaceCase('future-producer');
      try {
        // The selector is internally valid; only the live consumer coordinate
        // makes producer 3 impossible. No metadata is consulted at this layer.
        await withRuntimeEnv(VALID_ENV, () =>
          expectRejectedWithoutSideEffect(entry, selector(3), root, FUTURE_PRODUCER));
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    }
  });

  it('keeps producer equality with the consumer lane legal at intake', async () => {
    // Intake must not reject producer 2 / consumer 2 as a "future" attempt. The
    // call then reaches the injected transport, which throws its sentinel; that
    // proves the coordinate gate passed without pretending a full chain ran.
    for (const entry of ENTRIES) {
      const root = workspaceCase('equal-attempts');
      try {
        await withRuntimeEnv(VALID_ENV, async () => {
          const {calls, transport} = makeNetworkSpy();
          const output = path.join(root, 'out');
          const failure = await entry.run(selector(CONSUMER), output, transport).then(() => undefined, (error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toBe('unexpected network request');
          expect(calls).toHaveBeenCalledTimes(1);
          expect(existsSync(path.join(output, 'custody'))).toBe(false);
          expect(existsSync(path.join(output, 'request.original.json'))).toBe(false);
        });
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    }
  });

  const bindingFailures: Array<[string, RuntimeEnv]> = [
    ['GitHub Actions is not the live runner', {...VALID_ENV, GITHUB_ACTIONS: 'false'}],
    ['GitHub Actions is missing', {...VALID_ENV, GITHUB_ACTIONS: undefined}],
    ['the repository is another one', {...VALID_ENV, GITHUB_REPOSITORY: 'other/xpod'}],
    ['the repository is missing', {...VALID_ENV, GITHUB_REPOSITORY: undefined}],
    ['the run id differs', {...VALID_ENV, GITHUB_RUN_ID: '999'}],
    ['the run id is missing', {...VALID_ENV, GITHUB_RUN_ID: undefined}],
    ['the run id has non-canonical spelling', {...VALID_ENV, GITHUB_RUN_ID: '040637818669'}],
  ];

  for (const [label, env] of bindingFailures) {
    it(`rejects live binding when ${label} before any request or mkdir`, async () => {
      for (const entry of ENTRIES) {
        const root = workspaceCase('binding-' + label.replace(/[^a-z0-9]+/gi, '-'));
        try {
          await withRuntimeEnv(env, () =>
            expectRejectedWithoutSideEffect(entry, selector(PRODUCER), root, RUNTIME_BINDING));
        } finally {
          rmSync(root, {recursive: true, force: true});
        }
      }
    });
  }
});

describe('generic selector whitelist', () => {
  async function expectUnknownSelector(entry: Entry, input: ArtifactAcquisitionInput, root: string): Promise<void> {
    await withRuntimeEnv(VALID_ENV, async () => {
      const output = path.join(root, 'out');
      const {calls, transport} = makeNetworkSpy();
      const failure = await entry.run(input, output, transport).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(UNKNOWN_SELECTOR);
      expect(calls).toHaveBeenCalledTimes(0);
      if (entry.generic) {
        // The generic entry point validates the selector before its output
        // handling, so nothing at all is created.
        expect(existsSync(output)).toBe(false);
        expect(readdirSync(root)).toEqual([]);
      } else {
        // R5 validates runtime coordinates first and only then creates the
        // output directory; the generic whitelist rejects before any request, so
        // the wrapper leaves an empty directory and nothing else.
        expect(existsSync(output)).toBe(true);
        expect(readdirSync(output)).toEqual([]);
      }
    });
  }

  it('rejects a smuggled consumerAttempt key through the real generic whitelist', async () => {
    for (const entry of ENTRIES) {
      const root = workspaceCase('smuggled-consumer');
      try {
        // Object.assign keeps the value structurally an ArtifactAcquisitionInput
        // for the compiler while carrying an unknown runtime key the production
        // whitelist must still refuse.
        await expectUnknownSelector(entry, Object.assign(selector(PRODUCER), {consumerAttempt: CONSUMER}), root);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    }
  });

  it('rejects any other unknown selector key through the real generic whitelist', async () => {
    for (const entry of ENTRIES) {
      const root = workspaceCase('unknown-key');
      try {
        await expectUnknownSelector(entry, Object.assign(selector(PRODUCER), {expectedProducerAttempt: PRODUCER}), root);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    }
  });
});
