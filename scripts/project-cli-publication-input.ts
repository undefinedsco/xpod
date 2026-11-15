import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CLI_PRODUCT_WORKFLOW, CLI_PUBLICATION_MATERIAL_ROLE, cliPublicationArtifactNames } from './acquire-independent-product-input';
import { productOriginal, withProductProjection, type ProductCustodyInput } from './lib/product-artifact-projection';
import { preparePublication } from './prepare-cli-publication';
export interface CliPublicationProjectionInput extends ProductCustodyInput { schemaVersion: 1 }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(message: string): never { throw new Error('CLI publication projection: ' + message); }
export async function projectCliPublicationInput(input: CliPublicationProjectionInput, output: string) {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(input.custodyReceiptSha256)) fail('bound acquisition required');
  return await withProductProjection(input, output, { workflowPath: CLI_PRODUCT_WORKFLOW, materialRole: CLI_PUBLICATION_MATERIAL_ROLE,
    artifactNames: cliPublicationArtifactNames }, async session => {
    const { custody, metadata, temporary, member, project, select, writeOutput } = session;
    const selected = new Map<string, any>();
    function pick(name: string, destination = name, limit = 4 * 1024 ** 2) {
      const row = member(name, limit); selected.set(destination, row); return select(row, destination);
    }
    const json = (destination: string) => JSON.parse(productOriginal(path.join(temporary, destination), selected.get(destination).sha256).toString());
    project([pick('result.json')]);
    const result = json('result.json'), context = result.context;
    const canonicalId = (value: unknown, actual: number) => typeof value === 'string' && /^[1-9]\d*$/u.test(value) && value === String(actual);
    if (result.schemaVersion !== 1 || result.kind !== 'cli-publication-preparation-producer' || result.status !== 'prepared-not-published'
      || !context || context.checkoutSha !== custody.expectedSourceSha || context.eventHeadSha !== custody.runHeadSha
      || !canonicalId(context.runId, custody.runId) || !canonicalId(context.runAttempt, custody.runAttempt)
      || context.environment !== 'github-actions' || context.workingTreeDirty !== false || !['Linux', 'macOS'].includes(context.runnerOS)
      || metadata.artifact.name !== `xpod-cli-publication-preparation-${context.runnerOS}-${context.checkoutSha}-${context.runId}-${context.runAttempt}`
      || result.embeddedClientIdentityVerified !== true || result.privateConsumerArtifactsReused !== false
      || result.published !== false || result.releaseQualified !== false || result.legalQualified !== false || result.nativeQualified !== false) fail('normal producer context/role mismatch');
    const refs = { inventory: 'inventory.json', sourceInputs: 'source-inputs.json', producerIndex: 'producer-index.json', preparation: 'preparation.json' };
    const documents = Object.entries(refs).map(([field, name]) => {
      const choice = pick(name);
      if (result[field]?.path !== name || result[field].sha256 !== choice.sha256) fail('result document binding mismatch');
      return choice;
    });
    project(documents);
    const inventory = json('inventory.json'), source = json('source-inputs.json'), preparation = json('preparation.json');
    if (inventory.schemaVersion !== 1 || inventory.scope !== 'all artifact members except this inventory and result.json, avoiding self-reference'
      || !Array.isArray(inventory.files) || new Set(inventory.files.map((row: any) => row.path)).size !== inventory.files.length) fail('producer inventory invalid');
    const files = custody.inventory.members.filter((row: any) => row.kind === 'file' && !['result.json', 'inventory.json'].includes(row.path));
    if (inventory.files.length !== files.length) fail('producer inventory incomplete');
    for (const row of inventory.files) {
      const actual = files.find((file: any) => file.path === row.path);
      if (!actual || actual.bytes !== row.bytes || actual.sha256 !== row.sha256 || actual.mode !== row.mode) fail('producer inventory drift');
    }
    if (source.schemaVersion !== 1 || !isDeepStrictEqual(source.context, context) || !Array.isArray(source.files)
      || new Set(source.files.map((row: any) => row.path)).size !== source.files.length) fail('source inputs context/inventory mismatch');
    for (const row of source.files) {
      if (typeof row.path !== 'string' || row.path.startsWith('/') || row.path.includes('\\') || row.path.split('/').some((part: string) => !part || part === '.' || part === '..')
        || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/u.test(row.sha256)) fail('source inputs file reference invalid');
    }
    const products = ['cli', 'client'] as const;
    project([...products.map(id => pick(`${id}.tgz`, `${id}.tgz`, 20 * 1024 ** 2)), pick('input.json'),
      ...products.map(id => pick(`source-manifests/${id}.package.json`, `${id}.package.json`))]);
    const originalInput = json('input.json');
    if (originalInput.schemaVersion !== 1) fail('publication input schema mismatch');
    const inputDocument: any = { schemaVersion: 1, sourceManifests: {} };
    for (const id of products) {
      const row = selected.get(`${id}.tgz`), product = result.products?.[id];
      if (product?.package !== `@undefineds.co/xpod-${id}` || product.archive?.path !== `${id}.tgz`
        || product.archive.sha256 !== row.sha256 || product.archive.bytes !== row.bytes
        || originalInput[id]?.path !== `${id}.tgz` || originalInput[id].sha256 !== row.sha256
        || originalInput[id].integrity !== product.archive.integrity) fail('product archive/result binding mismatch');
      const sourceMember = selected.get(`${id}.package.json`);
      const sourceRef = originalInput.sourceManifests?.[id];
      const canonicalSource = source.files.filter((file: any) => file.path === `packages/xpod-${id}/package.json`);
      if (sourceRef?.path !== `source-manifests/${id}.package.json` || sourceRef.sha256 !== sourceMember.sha256 || canonicalSource.length !== 1
        || canonicalSource[0].sha256 !== sourceMember.sha256 || canonicalSource[0].bytes !== sourceMember.bytes) fail('source manifest binding mismatch');
      inputDocument[id] = { ...originalInput[id], path: `${id}.tgz` };
      inputDocument.sourceManifests[id] = { path: `${id}.package.json`, sha256: sourceMember.sha256 };
    }
    // Reuse the normal producer's manifest/embedded-client verifier; never load
    // installed package code or normalize original archive/manifest bytes.
    const checked = preparePublication(inputDocument, temporary);
    if (preparation.schemaVersion !== 1 || preparation.kind !== checked.kind || preparation.status !== checked.status
      || preparation.embeddedClientIdentityVerified !== true || preparation.published !== false || preparation.releaseQualified !== false
      || preparation.legalQualified !== false || preparation.nativeQualified !== false) fail('original preparation flags mismatch');
    for (const id of products) {
      const actual = checked[id], saved = preparation[id];
      if (result.products[id].version !== actual.version || saved?.name !== actual.name || saved.version !== actual.version
        || saved.archive?.sha256 !== actual.archive.sha256 || saved.archive.integrity !== actual.archive.integrity || saved.archive.bytes !== actual.archive.bytes
        || !isDeepStrictEqual(saved.files, actual.files) || !isDeepStrictEqual(preparation.sourceManifests?.[id]?.original, checked.sourceManifests[id].original)
        || preparation.sourceManifests[id].sha256 !== checked.sourceManifests[id].sha256
        || preparation.sourceManifests[id].originalBytesBase64 !== checked.sourceManifests[id].originalBytesBase64) fail('original preparation material mismatch');
    }
    if (!isDeepStrictEqual(preparation.cli.embeddedClient, checked.cli.embeddedClient) || !isDeepStrictEqual(preparation.cli.runtimeClient, checked.cli.runtimeClient)) fail('embedded client preparation mismatch');
    const producerIndex = productOriginal(path.join(temporary, 'producer-index.json'), selected.get('producer-index.json').sha256);
    if (hash(producerIndex) !== checked.cli.embeddedClient.index.sha256) fail('producer index differs from archived original');
    const derivedInput = Buffer.from(JSON.stringify(inputDocument, null, 2) + '\n');
    const receipt = { schemaVersion: 1, kind: 'cli-publication-input-projection', status: 'projected-blocked',
      custodyReceipt: { path: path.join(session.root, 'receipt.json'), sha256: input.custodyReceiptSha256 },
      sourceSha: context.checkoutSha, eventHeadSha: context.eventHeadSha, runId: context.runId, runAttempt: context.runAttempt,
      products: result.products, selectedMembersProjected: selected.size, innerArchiveExpanded: false,
      publicationInput: { path: 'publication-input.json', bytes: derivedInput.length, sha256: hash(derivedInput) },
      actualCheckoutVerified: false, exactAttemptAdmitted: false, registryConsumerValidated: false, published: false, releaseQualified: false,
      blockers: ['producer-checkout-and-attempt-claims-not-independently-admitted', 'source-build-closure-unverified', 'registry-consumer-unverified', 'legal-native-release-admission-unverified'] };
    writeOutput(receipt, { 'publication-input.json': derivedInput }); return receipt;
  });
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) fail('input JSON and new output directory required');
    console.log(JSON.stringify(await projectCliPublicationInput(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
