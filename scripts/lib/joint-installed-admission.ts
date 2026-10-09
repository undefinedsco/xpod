import { strictObject } from './strict-json-object';

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;

interface SuiteAuthority {
  fixtureSHA256: string;
  caseSetSHA256: string;
  validatorSHA256: string;
}

export interface JointAdmissionAuthority {
  sourceSha: string;
  serviceImage: string;
  postgresImage: string;
  runnerSHA256: string;
  producerSHA256: string;
  contractSHA256: string;
  privateContractSHA256: string;
  public: SuiteAuthority;
  pro: SuiteAuthority;
}

// Byte authority and source pins belong to the caller. This checks only the
// allowlisted projection; private fixtures and canonical rows never enter it.
export function validateJointInstalledAdmission(value: unknown, expected: JointAdmissionAuthority): Record<string, unknown> {
  if (!/^[a-f0-9]{40}$/.test(expected.sourceSha)
    || !IMAGE.test(expected.serviceImage) || !IMAGE.test(expected.postgresImage)
    || ![expected.runnerSHA256, expected.producerSHA256, expected.contractSHA256, expected.privateContractSHA256,
      ...Object.values(expected.public), ...Object.values(expected.pro)].every(hash => SHA256.test(hash))) {
    throw new Error('joint admission authority mismatch');
  }
  const proof = strictObject(value, ['schemaVersion', 'kind', 'status', 'sourceSha', 'serviceImage',
    'postgresImage', 'runnerSHA256', 'contractSHA256', 'privateContractSHA256', 'server', 'schema', 'public', 'pro', 'abi', 'producer', 'cleanup']);
  const server = strictObject(proof.server, ['systemIdentifier', 'containerId', 'database', 'versionNum']);
  const schema = strictObject(proof.schema, ['beforeOID', 'afterPrepareOID', 'afterSuitesOID',
    'projectionColumns', 'projectionTriggers']);
  const producer = strictObject(proof.producer, ['actualExit', 'signal', 'childCount',
    'closedRawSHA256', 'sourceSHA256', 'closedReceiptSHA256']);
  const cleanup = strictObject(proof.cleanup, ['databaseAbsent', 'semanticSchemasAbsent', 'ownedResourcesAbsent']);
  if (proof.schemaVersion !== 2 || proof.kind !== 'immutable-installed-joint-admission' || proof.status !== 'ok'
    || proof.sourceSha !== expected.sourceSha || proof.serviceImage !== expected.serviceImage
    || proof.postgresImage !== expected.postgresImage || proof.runnerSHA256 !== expected.runnerSHA256
    || proof.contractSHA256 !== expected.contractSHA256 || proof.privateContractSHA256 !== expected.privateContractSHA256
    || proof.abi !== '1|true') {
    throw new Error('joint candidate binding mismatch');
  }
  if (typeof server.systemIdentifier !== 'string' || !/^[1-9][0-9]{0,19}$/.test(server.systemIdentifier)
    || typeof server.containerId !== 'string' || !SHA256.test(server.containerId)
    || typeof server.database !== 'string' || !/^xpod_joint_[a-f0-9]{32}$/.test(server.database)
    || typeof server.versionNum !== 'number' || !Number.isInteger(server.versionNum)
    || server.versionNum < 170000 || server.versionNum >= 180000) {
    throw new Error('joint PG17 server identity mismatch');
  }
  if (typeof schema.beforeOID !== 'number' || !Number.isInteger(schema.beforeOID)
    || schema.beforeOID < 1 || schema.beforeOID > 4294967295
    || schema.afterPrepareOID !== schema.beforeOID || schema.afterSuitesOID !== schema.beforeOID
    || schema.projectionColumns !== 2 || schema.projectionTriggers !== 1) {
    throw new Error('joint base table composition mismatch');
  }
  for (const [name, count] of [['public', 16], ['pro', 17]] as const) {
    const suite = strictObject(proof[name], ['systemIdentifier', 'containerId', 'database', 'fixtureSHA256',
      'caseSetSHA256', 'validatorSHA256', 'completeCaseCount', 'canonicalDigest', 'reportSHA256',
      'failed', 'skipped', 'deniedRowsObserved', 'search']);
    const authority = expected[name];
    if (suite.systemIdentifier !== server.systemIdentifier || suite.containerId !== server.containerId
      || suite.database !== server.database || suite.fixtureSHA256 !== authority.fixtureSHA256
      || suite.caseSetSHA256 !== authority.caseSetSHA256 || suite.validatorSHA256 !== authority.validatorSHA256
      || suite.completeCaseCount !== count || suite.failed !== 0 || suite.skipped !== 0
      || suite.deniedRowsObserved !== 0 || suite.search !== 'verified'
      || typeof suite.canonicalDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(suite.canonicalDigest)
      || typeof suite.reportSHA256 !== 'string' || !SHA256.test(suite.reportSHA256)) {
      throw new Error(`joint ${name} conformance mismatch`);
    }
  }
  if (producer.actualExit !== 0 || producer.signal !== null || typeof producer.childCount !== 'number'
    || !Number.isInteger(producer.childCount) || producer.childCount < 1 || producer.childCount > 64
    || !Array.isArray(producer.closedRawSHA256) || producer.closedRawSHA256.length !== producer.childCount
    || producer.closedRawSHA256.some(hash => typeof hash !== 'string' || !SHA256.test(hash))
    || producer.sourceSHA256 !== expected.producerSHA256
    || typeof producer.closedReceiptSHA256 !== 'string' || !SHA256.test(producer.closedReceiptSHA256)
    || cleanup.databaseAbsent !== true || cleanup.semanticSchemasAbsent !== true || cleanup.ownedResourcesAbsent !== true) {
    throw new Error('joint producer closure mismatch');
  }
  return { status: 'ok', evidenceBoundary: 'immutable-installed-joint', sourceSha: proof.sourceSha,
    installedImage: proof.serviceImage, pgImage: proof.postgresImage, runnerSha256: proof.runnerSHA256,
    database: server.database, serverIdentifier: server.systemIdentifier, pgContainerId: server.containerId,
    baseTableOID: schema.beforeOID, publicCases: 16, proCases: 17 };
}
