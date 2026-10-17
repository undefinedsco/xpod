import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { planIndependentPublication, type IndependentPublicationInput } from './publication';
import { collectedArtifactView } from './artifact-collector';
import { consumerObservationView } from './consumer-context';
import { observeRegistryArtifact, observeRegistryArtifactIfPublished } from './registry-context';
const { runPublicationCommand } = createRequire(import.meta.url)('../afs-publication-command.cjs');
const { assertSafeFixturePublishConfig } = createRequire(import.meta.url)('../../check-package-registry-consumer.cjs');
const REGISTRY = 'https://registry.npmjs.org/';
const fail = (message: string): never => { throw new Error('Independent publisher: ' + message); };
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
declare const promotionBrand: unique symbol;
export interface IndependentPromotionPermit { readonly [promotionBrand]: true }
interface PermitState { input: IndependentPublicationInput; used: boolean; evidenceDirectory: string }
const permits = new WeakMap<object, PermitState>();
// Publisher-owned archive copies + raw/receipts <=16MiB. Consumers enforce
// separate budgets; peer-expanded writes and retained evidence are not included
// in this number. Formal execution requires the coordinator's pipeline budget.
export const independentPublisherOwnWriteLimitBytes = 16 * 1024 ** 2;
export interface IndependentPublicationExecutionInput extends IndependentPublicationInput {
  token: string;
  clientPeers?: readonly unknown[];
  cliPeers?: readonly unknown[];
}
function preflight(input: IndependentPublicationInput): void {
  const plan = planIndependentPublication(input);
  if (!plan.prepublishEligible) fail('prepublish gates pending: ' + plan.gaps.join('; '));
  for (const role of ['client', 'cli'] as const) {
    const view = collectedArtifactView(input[role]);
    if (view) assertSafeFixturePublishConfig(JSON.parse(view.readMember('package.json', 1024 ** 2).toString()));
    const consumer = consumerObservationView(role === 'client' ? input.clientConsumer : input.cliConsumer);
    if (!view || !consumer || consumer.stage !== 'prepublish' || !consumer.allProfilesVerified
      || !isDeepStrictEqual(view.identity, consumer.identity)) fail(role + ' requires complete real prepublish consumer');
  }
}
function token(value: string): string {
  if (typeof value !== 'string' || !value || /[\r\n\0]/u.test(value)) fail('registry credential required');
  return value;
}
function bunPath(): string {
  if (process.versions.bun) return fs.realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'bun');
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch { /* next installed Bun */ }
  }
  return fail('Bun runtime unavailable');
}
function archive(artifact: unknown, role: 'client' | 'cli'): Buffer {
  const view = collectedArtifactView(artifact);
  if (!view) return fail('real collected artifact required');
  const result = JSON.parse(view.readProducerOriginal('result.json', 1024 ** 2).toString());
  const reference = result.products?.[role]?.archive?.path;
  if (typeof reference !== 'string') return fail('missing archive original');
  const bytes = view.readProducerOriginal(reference, 8 * 1024 ** 2);
  if (bytes.length !== view.identity.archiveBytes || digest(bytes) !== view.identity.archiveSha256
    || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== view.identity.integrity) fail('archive custody mismatch');
  return bytes;
}

/** Explicitly mutating entry point. No caller transport/command can mint authority.
 * Every gate is recomputed before the first disk write or registry mutation.
 * Fixed registry-install consumers are required; archive import smoke is insufficient.
 * Candidate tags quarantine versions until both complete postpublish profiles pass.
 * A failed later step may leave an immutable candidate version in the registry. */
export async function executeIndependentPublication(input: IndependentPublicationExecutionInput): Promise<IndependentPromotionPermit> {
  preflight(input);
  const credential = token(input.token);
  const executable = bunPath();
  // Resolve the fixed CLI runner before any write; an unavailable implementation
  // blocks execution rather than skipping its profiles.
  const consumerModule = await import('./consumer-context');
  type RegistryInstallRunner = (input: {
    artifact: unknown; client?: unknown; peers: unknown[]; stage: 'postpublish';
    registryObservation: unknown; evidenceDirectory: string;
  }) => Promise<unknown>;
  const fixed = consumerModule as unknown as {
    observeRegistryInstalledClientConsumer?: RegistryInstallRunner;
    observeRegistryInstalledCliConsumer?: RegistryInstallRunner;
  };
  const observeInstalledClient = fixed.observeRegistryInstalledClientConsumer;
  const observeInstalledCli = fixed.observeRegistryInstalledCliConsumer;
  if (!observeInstalledClient || !observeInstalledCli)
    return fail('fixed actual registry install consumer runners unavailable; local archive smoke cannot authorize publication');
  const bytes = { client: archive(input.client, 'client'), cli: archive(input.cli, 'cli') };
  // Include four publish raw streams plus receipts/config under the 16MiB cap.
  if (bytes.client.length + bytes.cli.length > 14 * 1024 ** 2) fail('publication artifact write budget exceeded');
  // Check BOTH immutable versions before the first publish, including conflicts.
  const existing = {
    client: await observeRegistryArtifactIfPublished(input.client),
    cli: await observeRegistryArtifactIfPublished(input.cli),
  };
  preflight(input);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-independent-publish-'));
  let retain = false;
  // Deliberately pick capabilities: spread would retain token and peer arrays
  // in the private promotion permit despite its narrower TypeScript type.
  let current: IndependentPublicationInput = {
    client: input.client, cli: input.cli, clientSource: input.clientSource, cliSource: input.cliSource,
    clientConsumer: input.clientConsumer, cliConsumer: input.cliConsumer,
    clientRegistry: input.clientRegistry, cliRegistry: input.cliRegistry,
    clientRegistryConsumer: input.clientRegistryConsumer, cliRegistryConsumer: input.cliRegistryConsumer,
  };
  try {
    fs.mkdirSync(path.join(root, 'home')); fs.mkdirSync(path.join(root, 'tmp'));
    fs.writeFileSync(path.join(root, '.npmrc'), 'registry=' + REGISTRY + '\n', { flag: 'wx', mode: 0o600 });
    for (const role of ['client', 'cli'] as const) {
      preflight(current);
      const view = collectedArtifactView(input[role])!;
      const evidence = path.join(root, role); fs.mkdirSync(evidence);
      if (!existing[role]) {
        const file = path.join(root, role + '.tgz');
        fs.writeFileSync(file, bytes[role], { flag: 'wx', mode: 0o600 });
        const env = { PATH: path.dirname(executable), HOME: path.join(root, 'home'),
          TMPDIR: path.join(root, 'tmp'), NPM_CONFIG_USERCONFIG: path.join(root, '.npmrc'),
          NPM_CONFIG_GLOBALCONFIG: path.join(root, '.npmrc'), NPM_CONFIG_TOKEN: credential, LANG: 'C.UTF-8' };
        try {
          const row = await runPublicationCommand(executable, ['publish', file, '--ignore-scripts',
            '--registry=' + REGISTRY, '--access', 'public', '--tag', 'xpod-candidate-' + view.identity.archiveSha256.slice(0, 12)],
          { cwd: root, env, evidence, label: 'publish-' + role, timeoutMs: 30_000, rawLimit: 256 * 1024 });
          if (row.code !== 0 || !row.actualWait || !row.actualClose || !row.groupAbsent
            || !row.rawComplete || !row.rawClosedBeforeHash || !row.pipeEOF?.every(Boolean)) fail('unverified publish closure');
          for (const raw of row.raw) {
            const output = fs.readFileSync(path.join(evidence, raw.path));
            if (output.length !== raw.bytes || digest(output) !== raw.sha256) fail('publish raw custody mismatch');
          }
        } catch (error: any) {
          retain = !error.outcome?.groupAbsent || !error.outcome?.actualClose || !error.outcome?.actualWait;
          throw error;
        }
      }
      const registry = await observeRegistryArtifact(input[role]);
      const observation = role === 'client'
        ? await observeInstalledClient({ artifact: input.client, peers: [...(input.clientPeers ?? [])], stage: 'postpublish', registryObservation: registry, evidenceDirectory: path.join(evidence, 'consumer') })
        : await observeInstalledCli({ artifact: input.cli, client: input.client, peers: [...(input.cliPeers ?? [])], stage: 'postpublish', registryObservation: registry, evidenceDirectory: path.join(evidence, 'consumer') });
      const consumer = consumerObservationView(observation);
      if (!consumer?.allProfilesVerified || (consumer as typeof consumer & { registryInstallVerified?: boolean }).registryInstallVerified !== true
        || consumer.stage !== 'postpublish'
        || !isDeepStrictEqual(consumer.identity, view.identity)) fail(role + ' complete postpublish consumer pending');
      current = role === 'client' ? { ...current, clientRegistry: registry, clientRegistryConsumer: observation }
        : { ...current, cliRegistry: registry, cliRegistryConsumer: observation };
    }
    if (planIndependentPublication(current).tagPromotion.status !== 'eligible') fail('promotion gates pending');
    const permit = Object.freeze({}) as IndependentPromotionPermit;
    permits.set(permit, { input: current, used: false, evidenceDirectory: root });
    return permit;
  } catch {
    // Do not propagate candidate output or transport exception strings.
    throw Object.assign(new Error('Independent publication stopped; inspect retained audit evidence'), { evidenceDirectory: root });
  } finally {
    // Unknown process closure keeps its originals. The credential exists only in
    // the child environment, never in receipts, arguments, config or returned JSON.
    if (!retain) {
      // Keep closed receipts/raw originals for audit, remove only owned work data.
      for (const name of ['client.tgz', 'cli.tgz', '.npmrc', 'home', 'tmp'])
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
}
async function tagRequest(name: string, method: 'GET' | 'PUT', credential: string, evidence: string, label: string, version?: string): Promise<unknown> {
  const url = REGISTRY + '-/package/' + encodeURIComponent(name) + '/dist-tags'
    + (method === 'PUT' ? '/' + (version!.includes('-') ? 'next' : 'latest') : '');
  let response: Response;
  try { response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: 'Bearer ' + credential, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'PUT' ? { body: JSON.stringify(version) } : {}) });
  } catch {
    fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify({ method, status: null,
      responseBytes: 0, responseSha256: digest(Buffer.alloc(0)), responseComplete: false }), { flag: 'wx', mode: 0o600 });
    return fail('registry dist-tag transport failed');
  }
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  let responseComplete = false;
  try {
  if (reader) for (;;) {
    const row = await reader.read(); if (row.done) break;
    length += row.value.length; if (length > 64 * 1024) { await reader.cancel(); fail('registry tag response budget exceeded'); }
    chunks.push(row.value);
  }
  responseComplete = true;
  } finally {
    const retained = Buffer.concat(chunks);
    fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify({ method, status: response.status,
      responseBytes: retained.length, responseSha256: digest(retained), responseComplete }), { flag: 'wx', mode: 0o600 });
  }
  const bytes = Buffer.concat(chunks);
  // Retain response identity even for a failed/partial mutation; never retain
  // the registry body, which may contain credential-bearing diagnostic text.
  if (!response.ok) return fail('registry dist-tag request failed: ' + response.status);
  return length ? JSON.parse(bytes.toString()) : {};
}
/** Two tags cannot be promoted atomically by npm. A failure after the client PUT
 * leaves a partial promotion and requires investigation; no automatic rollback. */
export async function promoteIndependentPublication(permit: unknown, registryToken: string): Promise<void> {
  const state = permit !== null && typeof permit === 'object' ? permits.get(permit) : undefined;
  if (!state || state.used) return fail('real unused promotion permit required');
  const credential = token(registryToken);
  preflight(state.input);
  if (planIndependentPublication(state.input).tagPromotion.status !== 'eligible') fail('postpublish gates pending');
  // Recheck both identities before either tag changes.
  await observeRegistryArtifact(state.input.client); await observeRegistryArtifact(state.input.cli);
  state.used = true;
  try {
  for (const role of ['client', 'cli'] as const) {
    preflight(state.input);
    if (planIndependentPublication(state.input).tagPromotion.status !== 'eligible') fail('promotion gates changed');
    const identity = collectedArtifactView(state.input[role])!.identity;
    await observeRegistryArtifact(state.input[role]);
    await tagRequest(identity.package, 'PUT', credential, state.evidenceDirectory, 'promotion-' + role + '-put', identity.version);
    const tags = await tagRequest(identity.package, 'GET', credential, state.evidenceDirectory, 'promotion-' + role + '-get') as Record<string, unknown>;
    if (tags[identity.version.includes('-') ? 'next' : 'latest'] !== identity.version) fail('dist-tag readback mismatch');
    fs.writeFileSync(path.join(state.evidenceDirectory, 'promotion-' + role + '.json'),
      JSON.stringify({ package: identity.package, version: identity.version,
        tag: identity.version.includes('-') ? 'next' : 'latest', verified: true,
        readbackSha256: digest(Buffer.from(JSON.stringify(tags))) }), { flag: 'wx', mode: 0o600 });
  }
  } catch {
    throw Object.assign(new Error('Independent tag promotion stopped; partial promotion may exist'),
      { evidenceDirectory: state.evidenceDirectory });
  }
}

/** Read-only audit locator, never publication or promotion authority. */
export function independentPublicationEvidence(permit: unknown): string | undefined {
  return permit !== null && typeof permit === 'object' ? permits.get(permit)?.evidenceDirectory : undefined;
}
