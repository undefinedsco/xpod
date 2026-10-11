import { describe, expect, it } from 'vitest';
import { validateJointInstalledAdmission, type JointAdmissionAuthority } from '../../scripts/lib/joint-installed-admission';

const hash = (character: string): string => character.repeat(64);
const expected: JointAdmissionAuthority = {
  sourceSha: 'a'.repeat(40), serviceImage: `ghcr.io/undefinedsco/xpod@sha256:${hash('b')}`,
  postgresImage: `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:${hash('c')}`,
  runnerSHA256: hash('d'), producerSHA256: hash('e'), contractSHA256: hash('f'), privateContractSHA256: hash('0'),
  public: { fixtureSHA256: hash('1'), caseSetSHA256: hash('2'), validatorSHA256: hash('3') },
  pro: { fixtureSHA256: hash('4'), caseSetSHA256: hash('5'), validatorSHA256: hash('6') },
};
function valid(): Record<string, any> {
  const server = { systemIdentifier: '7694358013082710061', containerId: hash('7'),
    database: `xpod_joint_${'8'.repeat(32)}`, versionNum: 170010 };
  const suite = (name: 'public' | 'pro', count: number) => ({
    systemIdentifier: server.systemIdentifier, containerId: server.containerId, database: server.database,
    ...expected[name], completeCaseCount: count, canonicalDigest: `sha256:${hash('9')}`,
    reportSHA256: hash('a'), failed: 0, skipped: 0, deniedRowsObserved: 0, search: 'verified',
  });
  return { schemaVersion: 2, kind: 'immutable-installed-joint-admission', status: 'ok',
    sourceSha: expected.sourceSha, serviceImage: expected.serviceImage, postgresImage: expected.postgresImage,
    runnerSHA256: expected.runnerSHA256, contractSHA256: expected.contractSHA256, privateContractSHA256: expected.privateContractSHA256,
    server, schema: { beforeOID: 17238, afterPrepareOID: 17238, afterSuitesOID: 17238,
      projectionColumns: 2, projectionTriggers: 1 }, public: suite('public', 16), pro: suite('pro', 17),
    abi: '1|true', producer: { actualExit: 0, signal: null, childCount: 2,
      closedRawSHA256: [hash('b'), hash('c')], sourceSHA256: expected.producerSHA256, closedReceiptSHA256: hash('d') },
    cleanup: { databaseAbsent: true, semanticSchemasAbsent: true, ownedResourcesAbsent: true } };
}
describe('joint installed PG17 admission projection', () => {
  it('admits only both complete suites on the same owned PG17 and extended base table', () => {
    expect(validateJointInstalledAdmission(valid(), expected)).toMatchObject({ status: 'ok',
      evidenceBoundary: 'immutable-installed-joint', publicCases: 16, proCases: 17, baseTableOID: 17238 });
  });
  it.each(['sourceSha', 'serviceImage', 'postgresImage', 'runnerSHA256', 'contractSHA256', 'privateContractSHA256', 'abi', 'status', 'kind'])
  ('rejects mixed candidate %s', field => {
    const proof = valid(); proof[field] = 'wrong';
    expect(() => validateJointInstalledAdmission(proof, expected)).toThrow();
  });
  it('rejects legacy independent proof and malformed authority', () => {
    const proof = valid(); proof.schemaVersion = 1;
    expect(() => validateJointInstalledAdmission(proof, expected)).toThrow();
    expect(() => validateJointInstalledAdmission(valid(), { ...expected, producerSHA256: 'wrong' })).toThrow();
  });
  for (const name of ['public', 'pro'] as const) {
    it.each(['systemIdentifier', 'containerId', 'database', 'fixtureSHA256', 'caseSetSHA256', 'validatorSHA256',
      'completeCaseCount', 'canonicalDigest', 'reportSHA256', 'failed', 'skipped', 'deniedRowsObserved', 'search'])
    (`rejects ${name} incomplete or foreign %s`, field => {
      const proof = valid(); proof[name][field] = 'wrong';
      expect(() => validateJointInstalledAdmission(proof, expected)).toThrow();
    });
    it(`rejects missing ${name} and private raw fields`, () => {
      const missing = valid(); delete missing[name];
      const raw = valid(); raw[name].rows = 'PRIVATE_SENTINEL';
      expect(() => validateJointInstalledAdmission(missing, expected)).toThrow(/fields/);
      expect(() => validateJointInstalledAdmission(raw, expected)).toThrow(/fields/);
    });
  }
  it.each(['systemIdentifier', 'containerId', 'database', 'versionNum'])('rejects unowned or non-PG17 server %s', field => {
    const proof = valid(); proof.server[field] = field === 'versionNum' ? 160004 : 'wrong';
    expect(() => validateJointInstalledAdmission(proof, expected)).toThrow();
  });
  it.each(['beforeOID', 'afterPrepareOID', 'afterSuitesOID', 'projectionColumns', 'projectionTriggers'])
  ('rejects replaced or incompletely extended base %s', field => {
    const proof = valid(); proof.schema[field] += 1;
    expect(() => validateJointInstalledAdmission(proof, expected)).toThrow();
  });
  it.each(['actualExit', 'signal', 'childCount', 'closedRawSHA256', 'sourceSHA256', 'closedReceiptSHA256'])
  ('rejects uncertain producer %s', field => {
    const proof = valid(); proof.producer[field] = field === 'closedRawSHA256' ? [] : 'wrong';
    expect(() => validateJointInstalledAdmission(proof, expected)).toThrow();
  });
  it.each(['databaseAbsent', 'semanticSchemasAbsent', 'ownedResourcesAbsent'])('rejects uncertain cleanup %s', field => {
    const proof = valid(); proof.cleanup[field] = false;
    expect(() => validateJointInstalledAdmission(proof, expected)).toThrow();
  });
  it('rejects raw or unknown fields at each object boundary', () => {
    for (const field of [undefined, 'server', 'schema', 'producer', 'cleanup']) {
      const proof = valid(); (field ? proof[field] : proof).raw = 'PRIVATE_SENTINEL';
      expect(() => validateJointInstalledAdmission(proof, expected)).toThrow(/fields/);
    }
  });
});
