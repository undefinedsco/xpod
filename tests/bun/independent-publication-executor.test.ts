import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { runPublicationCommand } = createRequire(import.meta.url)('../../scripts/lib/afs-publication-command.cjs');
import { executeIndependentPublication, promoteIndependentPublication, normalizeIndependentDistTags, estimateIndependentPublicationAuditWriteBytes, independentPublisherOwnWriteLimitBytes, independentPublicationUploadTimeoutMs, planIndependentPublicationTimeBudget, markPublicationCommandFailure, publicationRetainedArchiveMetadata, buildPublicationConsumerMaterials, publicationFrontierMetadata, planIndependentPublicationFrontier, authorizeIndependentPromotion, stageIndependentPublication, planPublicationStageTimeBudget, planPublicationStageBatch, planPublicationPromotionTimeBudget, publicationPhaseTimePolicy, assertReviewedPublicationPhaseTimeWindow, assertPublicationCommandTimeRemaining } from '../../scripts/lib/independent-admission/publication-executor';

describe('guarded independent publication executor', () => {
  test('JSON passed claims fail before disk writes or network', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort();
    const fake = { status: 'verified', allProfilesVerified: true, stage: 'prepublish' };
    await expect(executeIndependentPublication({ client: fake, cli: fake, clientSource: fake,
      cliSource: fake, clientConsumer: fake, cliConsumer: fake, token: 'never-used' })).rejects.toThrow('real central');
    expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort()).toEqual(before);
  });
  test('final job cannot restore promotion authority from serialized prior-wave success', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort();
    await expect(authorizeIndependentPromotion({ schemaVersion: 2, products: [{
      artifact: { verified: true }, source: { verified: true }, prepublishConsumer: { allProfilesVerified: true },
      registry: { verified: true }, postpublishConsumer: { stage: 'postpublish', allProfilesVerified: true, registryInstallVerified: true },
    }] } as never)).rejects.toThrow('real central');
    expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort()).toEqual(before);
  });
  test('serialized or absent permits cannot promote tags', async () => {
    for (const permit of [undefined, {}, { tagPromotion: { status: 'eligible' }, used: false }]) {
      await expect(promoteIndependentPublication(permit, 'never-used')).rejects.toThrow('real unused promotion permit');
    }
  });
});

describe('dist-tag evidence and fixed Bun credential mode', () => {
  test('mapping preserves only canonical npm tag/version pairs', () => {
    expect(JSON.stringify(normalizeIndependentDistTags({ next: '1.2.3-rc.1', latest: '1.2.2' })))
      .toBe('{"latest":"1.2.2","next":"1.2.3-rc.1"}');
    for (const value of [{}, [], { message: '1.2.3' }, { latest: 'token-bearing-error' },
      { '1.0': '1.0.0' }, { next: 'v1.2.3' }, { next: '1.2.3', token: '1.0.0' },
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['tag' + i, '1.0.0']))]) {
      expect(() => normalizeIndependentDistTags(value)).toThrow();
    }
  });
  test('actual Bun publish uses NPM_CONFIG_TOKEN at exact loopback registry', async () => {
    // This isolated protocol fixture never calls a production publication entry.
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'publisher-auth-'));
    const observed: { method: string; authorized: boolean; bytes: number }[] = [];
    let oversized = false;
    const fixtureToken = 'fixture-only-no-real-credential';
    const server = http.createServer((request, response) => {
      const address = server.address();
      const exactHost = typeof address === 'object' && address ? '127.0.0.1:' + address.port : '';
      if (request.headers.host !== exactHost || request.url !== '/xpod-auth-fixture' || request.method !== 'PUT') {
        response.writeHead(400).end('{}'); request.resume(); return;
      }
      let bytes = 0;
      request.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) { oversized = true; request.destroy(); } });
      request.on('end', () => {
        const authorized = request.headers.authorization === 'Bearer ' + fixtureToken;
        observed.push({ method: request.method!, authorized, bytes });
        response.writeHead(authorized ? 201 : 401, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('loopback fixture unavailable');
      const registry = 'http://127.0.0.1:' + address.port + '/';
      for (const directory of ['package', 'home', 'tmp', 'evidence']) fs.mkdirSync(path.join(root, directory));
      const manifest = JSON.stringify({ name: 'xpod-auth-fixture', version: '0.0.0', license: 'MIT' });
      // Bun initializes the invocation cwd even when publishing an explicit tarball.
      // Keep the fixture independent of an accidental repository parent manifest.
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'xpod-publication-work', version: '0.0.0', private: true }));
      fs.writeFileSync(path.join(root, 'package', 'package.json'), manifest);
      const archive = path.join(root, 'fixture.tgz');
      execFileSync('tar', ['-czf', archive, '-C', root, 'package'], { timeout: 1000, maxBuffer: 4096 });
      const config = path.join(root, '.npmrc'); fs.writeFileSync(config, 'registry=' + registry + '\n', { mode: 0o600 });
      const executable = fs.realpathSync(process.execPath);
      expect(Boolean(process.versions.bun)).toBe(true);
      const env = { PATH: path.dirname(executable), HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
        NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_GLOBALCONFIG: config, NPM_CONFIG_TOKEN: fixtureToken, LANG: 'C.UTF-8' };
      expect('NODE_AUTH_TOKEN' in env).toBe(false);
      const row = await runPublicationCommand(executable, ['publish', archive, '--ignore-scripts', '--registry=' + registry,
        '--access', 'public', '--tag', 'xpod-candidate-fixture'],
      { cwd: root, env, evidence: path.join(root, 'evidence'), label: 'fixture-auth', timeoutMs: 2500, rawLimit: 16 * 1024 });
      expect([row.code, row.actualWait, row.actualClose, row.groupAbsent, row.rawComplete, row.rawClosedBeforeHash]).toEqual([0, true, true, true, true, true]);
      expect(row.pipeEOF).toEqual([true, true]);
      expect(observed.length).toBe(1); expect(observed[0]?.authorized).toBe(true); expect(oversized).toBe(false);
      let written = 0;
      for (const entry of fs.readdirSync(root, { recursive: true })) {
        const file = path.join(root, String(entry)); const stat = fs.statSync(file);
        if (stat.isFile()) { written += stat.size; expect(fs.readFileSync(file).includes(Buffer.from(fixtureToken))).toBe(false); }
      }
      expect(written < 1024 * 1024).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 5000);
});


test('publication audit budget accounts for a complete multi-family cohort before any write', () => {
  expect(estimateIndependentPublicationAuditWriteBytes(14) < independentPublisherOwnWriteLimitBytes).toBe(true);
  for (const value of [0, -1, 1.5, NaN, Infinity, 128, 129]) expect(() => estimateIndependentPublicationAuditWriteBytes(value)).toThrow();
});

test('a full-shaped grouped JSON cannot enter archive callbacks or create publisher work', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort();
  const rows = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(target => ({
    artifact: { identity: { package: '@undefineds.co/xpod-api-' + target, target }, status: 'verified' },
    source: { status: 'verified' }, prepublishConsumer: { stage: 'prepublish', allProfilesVerified: true },
  }));
  await expect(executeIndependentPublication({ schemaVersion: 2, products: rows as any, token: 'never-used' })).rejects.toThrow('real central');
  expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort()).toEqual(before);
});


test('actual collected tgz bytes drive bounded upload time instead of a fixed CLI timeout', () => {
  expect(independentPublicationUploadTimeoutMs(1)).toBe(31_000);
  expect(independentPublicationUploadTimeoutMs(400 * 1024 ** 2)).toBe(430_000);
  expect(independentPublicationUploadTimeoutMs(700 * 1024 ** 2)).toBe(730_000);
  for (const bytes of [0, -1, NaN, 1.5, 1024 ** 3]) expect(() => independentPublicationUploadTimeoutMs(bytes)).toThrow();
});

test('the last large target exceeding the serial pipeline budget prevents first publication work', () => {
  const small = { archiveBytes: 1024 ** 2, targeted: false, consumerMaximumDurationMs: 400_000 };
  expect(() => planIndependentPublicationTimeBudget([small, small], 20 * 60_000)).toThrow('exceeds reviewed workflow');
  const portable = planIndependentPublicationTimeBudget([small, small], 40 * 60_000);
  expect(portable.totalMs <= portable.pipelineLimitMs).toBe(true);
  const large = { archiveBytes: 400 * 1024 ** 2, targeted: true, consumerMaximumDurationMs: 600_000 };
  expect(() => planIndependentPublicationTimeBudget([small, large], portable.totalMs)).toThrow('exceeds reviewed workflow');
  const platform = planIndependentPublicationTimeBudget([large, large, large, large], 3 * 60 * 60_000);
  expect(platform.members[3].uploadMs).toBe(430_000);
  expect(platform.members[3].registryConsumerMs).toBe(600_000);
  expect(() => planIndependentPublicationTimeBudget([{ ...large, consumerMaximumDurationMs: 0 }], 3 * 60 * 60_000)).toThrow('consumer time budget');
});


test('unknown actual process closure retains archive while ordinary closed failure may clean up', () => {
  const closed = { actualWait: true, actualClose: true, groupAbsent: true };
  const error = Object.assign(new Error('fixture command failed'), { outcome: closed });
  expect(markPublicationCommandFailure(error)).toEqual({ error, retainWorkData: false });
  for (const delta of [{ actualWait: false }, { actualClose: false }, { groupAbsent: false }, { actualWait: 'true' }]) {
    const result = markPublicationCommandFailure(Object.freeze(Object.assign(new Error('fixture'), { outcome: { ...closed, ...delta } })));
    expect(result.retainWorkData).toBe(true);
    expect((result.error as any).retainArchiveSnapshot).toBe(true);
    expect('releaseQualified' in (result.error as object)).toBe(false);
  }
});

test('central snapshot locator survives aggregate custody errors without raw diagnostics or credentials', () => {
  const directory = path.join(fs.realpathSync(os.tmpdir()), 'xpod-publication-archive-fixture');
  const retainedArchive = { path: path.join(directory, 'archive.tgz'), identity: { archiveBytes: 1,
    archiveSha256: 'b'.repeat(64), integrity: 'sha512-' + Buffer.alloc(64).toString('base64') }, reason: 'publisher-process-closure-unconfirmed' };
  const retained = Object.assign(new Error('fixture-only secret diagnostic must not propagate'), {
    retainArchiveSnapshot: true, retainedArchiveSnapshotDirectory: directory, retainedArchive, token: 'never-copy-this',
  });
  const result = publicationRetainedArchiveMetadata(new AggregateError([retained, new Error('changed custody')]));
  expect(result).toEqual({ retainArchiveSnapshot: true, retainedArchiveSnapshotDirectory: directory, retainedArchive });
  expect(JSON.stringify(result).includes('never-copy-this')).toBe(false);
  expect(JSON.stringify(result).includes('secret diagnostic')).toBe(false);
  expect(publicationRetainedArchiveMetadata(new Error('ordinary closed failure'))).toEqual({});
  expect(publicationRetainedArchiveMetadata({ retainArchiveSnapshot: true,
    retainedArchiveSnapshotDirectory: '/untrusted/../../token' })).toEqual({ retainArchiveSnapshot: true });
});


test('actual executor material builder omits a second client for primary client and resolves external registry client', () => {
  // These are inert test handles for the exact data builder, not central issuer substitutes.
  const client = Object.freeze({ fixture: 'registry-client-handle' });
  const cli = Object.freeze({ fixture: 'cohort-cli-handle' });
  const api = Object.freeze({ fixture: 'cohort-api-handle' });
  const peerPlan: any = Object.freeze({ fixture: 'opaque-nested-peer-plan' });
  const registryCandidates = [{ artifact: client, identity: { package: '@undefineds.co/xpod-client' } }];
  const primary = buildPublicationConsumerMaterials({ artifact: client, package: '@undefineds.co/xpod-client', candidates: registryCandidates });
  expect(primary.artifact).toBe(client);
  expect('client' in primary).toBe(false);
  for (const [artifact, name] of [[cli, '@undefineds.co/xpod-cli'], [api, '@undefineds.co/xpod-api-linux-x64']] as const) {
    const materials = buildPublicationConsumerMaterials({ artifact, package: name, candidates: registryCandidates,
      peerPlan, dependencies: [client], peers: [] });
    expect(materials.client).toBe(client);
    expect(materials.peerPlan).toBe(peerPlan);
    expect(materials.artifact).toBe(artifact);
    expect(Object.isFrozen(materials.dependencies)).toBe(true);
  }
  expect(() => buildPublicationConsumerMaterials({ artifact: cli, package: '@undefineds.co/xpod-cli', candidates: [] })).toThrow('one exact');
  expect(() => buildPublicationConsumerMaterials({ artifact: cli, package: '@undefineds.co/xpod-cli', candidates: [...registryCandidates, ...registryCandidates] })).toThrow('one exact');
});

test('complete14-member upper bound does not fit hosted6h, without skipping any consumers', () => {
  const modules = Array.from({ length: 12 }, () => ({ archiveBytes: 1, targeted: true, consumerMaximumDurationMs: 840_000 }));
  const portable = Array.from({ length: 2 }, () => ({ archiveBytes: 1, targeted: false, consumerMaximumDurationMs: 420_000 }));
  let required = 0;
  try { planIndependentPublicationTimeBudget([...portable, ...modules], 360 * 60_000); }
  catch (error) { required = (error as { requiredDurationMs: number }).requiredDurationMs; }
  expect(required).toBe(23_534_000);
  const family = planIndependentPublicationTimeBudget([...portable, ...modules.slice(0, 4)], 240 * 60_000);
  const external = planIndependentPublicationTimeBudget(modules.slice(0, 4), 240 * 60_000, [false, false]);
  expect(family.totalMs < 240 * 60_000).toBe(true);
  expect(external.externalRegistryReadbackMs).toBe(120_000);
});


describe('combined publication prerequisite frontiers', () => {
  const cohort = { order: ['client', 'cli', 'css', 'api', 'afs'], dependencies: {
    client: [], cli: ['client'], css: ['cli'], api: ['cli', 'css'], afs: ['api'],
  } };
  test('remote consumer prerequisites control each subsequent wave', () => {
    const done = new Set<string>();
    for (const expected of ['client', 'cli', 'css', 'api', 'afs']) {
      const wave = publicationFrontierMetadata(cohort, done);
      expect(wave.frontier).toEqual([expected]); expect(wave.mutationAllowed).toBe(false);
      done.add(expected);
    }
    expect(publicationFrontierMetadata(cohort, done)).toMatchObject({ complete: true, frontier: [], remaining: [] });
    expect(() => publicationFrontierMetadata(cohort, new Set(['api']))).toThrow('unverified prerequisites');
    expect(() => publicationFrontierMetadata(cohort, new Set(['unknown']))).toThrow('invalid complete cohort');
  });
  test('independent ready branches share a wave and malformed DAGs are refused', () => {
    expect(publicationFrontierMetadata({ order: ['client', 'api', 'css'], dependencies: {
      client: [], api: ['client'], css: ['client'],
    } }, new Set(['client'])).frontier).toEqual(['api', 'css']);
    expect(() => publicationFrontierMetadata({ order: ['api', 'css'], dependencies: {
      api: ['css'], css: ['api'],
    } }, new Set())).toThrow('normalized combined prerequisite DAG');
  });
  test('JSON success claims cannot enter operational frontier planning', () => {
    expect(() => planIndependentPublicationFrontier({ schemaVersion: 2, products: [{
      artifact: { verified: true }, source: { verified: true }, registry: { verified: true },
      postpublishConsumer: { allProfilesVerified: true, registryInstallVerified: true, stage: 'postpublish' },
    }] } as never)).toThrow('real central');
  });
});


describe('bounded family candidate stages', () => {
  test('stage refuses serialized material before filesystem or registry mutation', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort();
    await expect(stageIndependentPublication({ schemaVersion: 2, products: [{
      artifact: { verified: true }, source: { verified: true }, prepublishConsumer: { stage: 'prepublish', allProfilesVerified: true },
    }], token: 'never-used' } as never, 'api')).rejects.toThrow('real central');
    expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort()).toEqual(before);
  });
  test('family budget includes full cohort conflicts, external dependencies and every large archive', () => {
    const cohort = [{}, {}, ...Array.from({ length: 12 }, () => ({ target: 'linux-x64' }))];
    const staged = Array.from({ length: 4 }, () => ({ target: 'linux-x64', archiveBytes: 256 * 1024 ** 2 }));
    const result = planPublicationStageTimeBudget(cohort, staged, [{}, {}]);
    expect(result.registryReadbackMs).toBe(34 * 60_000);
    expect(result.archiveMs).toBe(4 * (360_000 + 286_000));
    expect(result.totalMs < result.pipelineLimitMs).toBe(true);
    expect(() => planPublicationStageTimeBudget(cohort, staged.map(row => ({ ...row, archiveBytes: 768 * 1024 ** 2 })), [{}, {}])).toThrow('complete stage exceeds');
    expect(() => planPublicationStageTimeBudget(cohort, [...staged, staged[0]])).toThrow('bounded complete stage');
    expect(() => planPublicationStageTimeBudget(Array.from({ length: 128 }, () => ({ target: 'linux-x64' })), staged))
      .toThrow('complete stage exceeds');
  });
});


test('large family frontier splits without changing whole-cohort coverage or skipping malformed deferred archive', () => {
  const cohort = [{}, {}, ...Array.from({ length: 12 }, () => ({ target: 'linux-x64' }))];
  const ready = Array.from({ length: 4 }, () => ({ target: 'linux-x64', archiveBytes: 768 * 1024 ** 2 }));
  const batch = planPublicationStageBatch(cohort, ready, [{}, {}]);
  expect(batch).toMatchObject({ mutationAllowed: false, count: 2, deferredCount: 2 });
  expect(batch.timeBudget.totalMs <= batch.timeBudget.pipelineLimitMs).toBe(true);
  expect(ready.length).toBe(4); expect(cohort.length).toBe(14);
  expect(() => planPublicationStageBatch(cohort, [...ready.slice(0, 3), { archiveBytes: -1 }])).toThrow('invalid collected archive');
});


test('final promotion budgets all3 fresh registry rounds and both tag operations per member', () => {
  const products = [{}, {}, ...Array.from({ length: 12 }, () => ({ target: 'linux-x64' }))];
  const budget = planPublicationPromotionTimeBudget(products, [{}, {}]);
  expect(budget.registryReadbackMs).toBe(77 * 60_000);
  expect(budget.tagsMs).toBe(14 * 60_000);
  expect(budget.totalMs).toBe(111 * 60_000);
  expect(() => planPublicationPromotionTimeBudget(Array.from({ length: 24 }, () => ({ target: 'linux-x64' }))))
    .toThrow('complete promotion exceeds');
});


test('phase planners refuse work outside the real command windows instead of approving job-timeout slack', () => {
  const cohort = [{}, {}, ...Array.from({ length: 12 }, () => ({ target: 'linux-x64' }))];
  // This106.7min stage fit the old120min policy but exceeds the real100min command.
  const ready = Array.from({ length: 4 }, () => ({ target: 'linux-x64', archiveBytes: 400 * 1024 ** 2 }));
  expect(() => planPublicationStageTimeBudget(cohort, ready, [{}, {}])).toThrow('complete stage exceeds');
  const batch = planPublicationStageBatch(cohort, ready, [{}, {}]);
  expect(batch.count).toBe(3);
  expect(batch.timeBudget.pipelineLimitMs).toBe(100 * 60_000);
  expect(batch.timeBudget.totalMs <= 100 * 60_000).toBe(true);
  // Fourteen targets plus2portable peers require121min, fitting135min job but
  // not its115min command. Reject before the first tag mutation.
  expect(() => planPublicationPromotionTimeBudget(Array.from({ length: 14 }, () => ({ target: 'linux-x64' })), [{}, {}]))
    .toThrow('complete promotion exceeds');
  for (const policy of Object.values(publicationPhaseTimePolicy)) {
    expect(policy.executionMinutes + policy.installationMinutes + policy.uploadMinutes + policy.setupReserveMinutes).toBe(policy.jobMinutes);
  }
});


test('actual runtime workflow-window guard reads both reviewed literal command limits', () => {
  for (const phase of ['stage', 'promotion'] as const)
    expect(() => assertReviewedPublicationPhaseTimeWindow(process.execPath, phase)).not.toThrow();
});


test('actual preparation time consumes the command window and cannot use the enclosing job slack', () => {
  expect(() => assertPublicationCommandTimeRemaining(20 * 60_000, 80 * 60_000, 100 * 60_000)).not.toThrow();
  expect(() => assertPublicationCommandTimeRemaining(21 * 60_000, 80 * 60_000, 100 * 60_000)).toThrow('actual command time remaining');
  expect(() => assertPublicationCommandTimeRemaining(30 * 60_000, 90 * 60_000, 115 * 60_000)).toThrow('actual command time remaining');
});
