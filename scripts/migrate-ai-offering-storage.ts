#!/usr/bin/env bun
/**
 * Migrate AI Connections Pod data onto the confirmed storage model
 * (`docs/ai-connections-storage-model.md`):
 *
 *   <Pod>/settings/
 *   ├── credentials.ttl          credentials, each naming its offering
 *   └── providers/<provider>.ttl provider identity + model rows + hasModel
 *
 * Two corrections, both idempotent:
 *
 * 1. **Model reference folding.** Older applet builds encoded the offering in
 *    the provider document name, so a selection could persist a reference to
 *    `providers/openai-official-subscription.ttl#gpt-6-astra` - a document that
 *    was never written. Such references are folded onto the provider's own
 *    document and deduplicated by model fragment. A legacy offering document
 *    that does exist is folded the same way: its model rows move into the
 *    provider's document, its `hasModel` merges, and the emptied legacy
 *    document is removed.
 * 2. **Credential offering backfill.** The offering becomes the credential's own
 *    `udfs:offeringId` attribute, derived only from evidence already in the Pod
 *    (a legacy provider reference, `metadata.offeringId`, the account label, the
 *    configured base URL, or a provider with exactly one offering for the
 *    credential's auth mode). Anything ambiguous is reported and left alone -
 *    this script never guesses an offering.
 *
 * Usage:
 *
 *   bun scripts/migrate-ai-offering-storage.ts --pod <pod-root>            # offline dry run
 *   bun scripts/migrate-ai-offering-storage.ts --pod <pod-root> --apply    # offline write
 *
 *   bun scripts/migrate-ai-offering-storage.ts --live <pod-base-url>            # live dry run
 *   bun scripts/migrate-ai-offering-storage.ts --live <pod-base-url> --apply    # live write
 *
 * Two modes, same corrections, same report:
 *
 * * `--pod <pod-root>` is the **offline/file mode**. `<pod-root>` is a Pod's
 *   storage root (`<root>/settings/credentials.ttl` must exist there), for
 *   example a *copy* of `~/Library/Application Support/Xpod/data/<pod>`. It
 *   rewrites `.ttl` files. **Offline copies only - never run this mode against a
 *   running Pod.** A live Pod answers SPARQL reads from its quadstore index, so
 *   editing files behind the server neither reaches that index nor survives the
 *   server's next write. `--apply` first copies `<pod-root>/settings` into
 *   `<pod-root>/../<pod>-ai-offering-backup-<timestamp>` unless
 *   `--backup-dir <dir>` says otherwise.
 *
 * * `--live <pod-base-url>` is the **live mode** (e.g.
 *   `http://127.0.0.1:3000/glocal/` or the canonical
 *   `https://<node>.nodes.undefineds.co/glocal/`). It reads and writes through
 *   the running Pod's store, using the same drizzle-solid access path as
 *   `ui/src/extensions/XpodAiConnectionsPodStore.ts`: discovery is a
 *   drizzle-solid `select()` against `<pod>/settings/-/sparql`, the offering
 *   backfill is `database.updateById(credentialResource, …)`, and the
 *   `udfs:hasModel` removal is the narrowly scoped authenticated Solid PATCH
 *   that `XpodAiConnectionsPodStore.persistModelSelectionLinks()` established
 *   and `docs/drizzle-solid-link-array-update-todo.md` mandates until
 *   drizzle-solid serializes URI arrays. Live mode never falls back to file
 *   writes: without a usable session it fails loudly.
 *
 * Live mode needs a session for the Pod, from the environment
 * `docs/cli-dev-testing.md` documents (nothing else):
 *
 * 1. `$SOLID_HOME/auth/credentials.json` (default `~/.solid/auth/credentials.json`),
 *    written by `bun src/cli/index.ts auth login --url <gateway> --email <account>
 *    --password <password>`; both `client_credentials` and `oidc_oauth` entries
 *    are accepted.
 * 2. Client credentials in the environment, the way integration helpers read
 *    them: `TEST_SOLID_CLIENT_ID` / `TEST_SOLID_CLIENT_SECRET` (or
 *    `SOLID_CLIENT_ID` / `SOLID_CLIENT_SECRET`), with optional
 *    `TEST_SOLID_WEBID` / `SOLID_WEBID` and `TEST_SOLID_OIDC_ISSUER` /
 *    `SOLID_OIDC_ISSUER`. `.env.local` is loaded first, as `bun run dev` does.
 *
 * Both modes print the same before/after guard scan; live `--apply` then reads
 * the corrections back through the same endpoint and prints that evidence.
 *
 * `n3` comes from the shared RDF stack (`@undefineds.co/models` depends on it);
 * the root package does not list it separately.
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DataFactory, Parser, Writer, type Quad } from 'n3';
import { parsePodResourceRef, type SolidAuthSession, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { PROVIDER_OFFERINGS, providerOfferings } from '../packages/ai-connections/src/provider-catalog';
import { AI_CONNECTIONS_PROVIDERS } from '../packages/ai-connections/src/client/types';
import {
  getClientCredentials,
  getOAuthCredentials,
  getSolidCredentialsPath,
  loadCredentials,
  type StoredCredentials,
} from '../src/cli/lib/credentials-store';

const UDFS = 'https://undefineds.co/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const PREDICATE = {
  type: RDF_TYPE,
  providerType: `${UDFS}Provider`,
  credentialType: `${UDFS}Credential`,
  modelType: `${UDFS}AIModel`,
  provider: `${UDFS}provider`,
  authMode: `${UDFS}authMode`,
  offeringId: `${UDFS}offeringId`,
  accountLabel: `${UDFS}accountLabel`,
  label: `${UDFS}label`,
  displayName: `${UDFS}displayName`,
  status: `${UDFS}status`,
  baseUrl: `${UDFS}baseUrl`,
  metadata: `${UDFS}metadata`,
  hasModel: `${UDFS}hasModel`,
  defaultModel: `${UDFS}defaultModel`,
  isProvidedBy: `${UDFS}isProvidedBy`,
} as const;

const SETTINGS_DIRECTORY = 'settings';
const PROVIDERS_DIRECTORY = 'settings/providers';
const CREDENTIALS_DOCUMENT = 'settings/credentials.ttl';
const PREFIXES = { rdf: `${RDF_TYPE.split('#')[0]}#`, udfs: UDFS, xsd: XSD };

type ProviderId = string;

export interface Document {
  /** Pod-relative path, `/`-separated, e.g. `settings/providers/openai.ttl`. */
  readonly id: string;
  quads: Quad[];
  originalQuads: Quad[];
}

interface MigrationPlan {
  credentialFindings: { subject: string; provider: ProviderId; offeringId: string; evidence: string }[];
  credentialSkips: { subject: string; reason: string }[];
  referenceChanges: {
    document: string;
    action: 'rewrite' | 'remove' | 'dedupe';
    from: string;
    to: string;
    /** The predicate the reference hangs on; absent for a whole-row dedupe. */
    predicate?: string;
  }[];
  legacyMoves: {
    document: string;
    provider: ProviderId;
    target: string;
    movedRows: number;
    droppedRows: number;
    removed: boolean;
  }[];
  relationRewrites: { subject: string; from: string; to: string }[];
}

interface Options {
  podRoot: string;
  /** Pod base URL for live mode; `--pod` and `--live` are mutually exclusive. */
  live?: string;
  apply: boolean;
  verify: boolean;
  backupDirectory?: string;
  help: boolean;
}

interface ReferenceEntry {
  quad: Quad;
  /** The reference as stored. */
  reference: string;
  /** The same reference with the provider's own document. */
  canonical: string;
  /** The stored document does not exist, so the reference has to be folded. */
  needsRewrite: boolean;
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

const KNOWN_PROVIDERS: ProviderId[] = [
  ...new Set<string>([...Object.keys(PROVIDER_OFFERINGS), ...AI_CONNECTIONS_PROVIDERS]),
].sort((left, right) => right.length - left.length);

/**
 * The offering id an old document name used for a catalog offering.
 *
 * The bootstrap naming renamed two Bailian catalog ids while building document
 * names (`token-plan` -> `token-plan-personal`, `coding-plan` ->
 * `coding-plan-pro`). Both spellings are accepted and collapse onto the catalog
 * id the attribute stores.
 */
const DOCUMENT_NAME_OFFERING_VARIANTS: Record<string, string> = {
  'token-plan-personal': 'token-plan',
  'coding-plan-pro': 'coding-plan',
};

function normalizeOfferingId(offeringId: string): string {
  const trimmed = offeringId.trim().toLowerCase();
  return DOCUMENT_NAME_OFFERING_VARIANTS[trimmed] ?? trimmed;
}

function catalogOfferingId(provider: ProviderId, offeringId: string): string | undefined {
  const canonical = normalizeOfferingId(offeringId);
  return providerOfferings(provider).some((offering) => offering.id === canonical) ? canonical : undefined;
}

/** `openai.ttl` -> `openai`; `bailian-token-plan.ttl` -> `bailian` + offering. */
function providerIdentityForDocumentKey(key: string): { provider: ProviderId; offeringId?: string } | undefined {
  if (KNOWN_PROVIDERS.includes(key)) return { provider: key };
  for (const provider of KNOWN_PROVIDERS) {
    if (!key.startsWith(`${provider}-`)) continue;
    const offeringId = catalogOfferingId(provider, key.slice(provider.length + 1));
    if (offeringId) return { provider, offeringId };
  }
  return undefined;
}

function providerIdentityForRelation(value: string): { provider: ProviderId; offeringId?: string } | undefined {
  const document = value.split('#', 1)[0] ?? value;
  const fileName = document.split('/').filter(Boolean).at(-1) ?? document;
  if (!fileName.toLowerCase().endsWith('.ttl')) return undefined;
  const key = fileName.slice(0, -'.ttl'.length);
  // Per-credential instance documents and the Gateway's own key document are
  // not product provider documents.
  if (key.startsWith('custom-instance-') || key.startsWith('xpod-gateway')) return undefined;
  return providerIdentityForDocumentKey(key);
}

/** Replace a reference's document with the provider's own, keeping its fragment. */
function canonicalizeReference(reference: string, provider: ProviderId): string {
  const document = reference.split('#', 1)[0] ?? reference;
  const separator = document.lastIndexOf('/');
  const directory = separator < 0 ? '' : document.slice(0, separator + 1);
  const fragmentIndex = reference.indexOf('#');
  const fragment = fragmentIndex < 0 ? '' : reference.slice(fragmentIndex);
  return `${directory}${provider}.ttl${fragment}`;
}

/**
 * The relation a credential should carry for a provider.
 *
 * A reference whose document exists keeps its fragment - only the document
 * name was wrong. A dangling one is written the way the adapter writes it,
 * without the `#this` document-subject fragment.
 */
function canonicalProviderRelation(reference: string, provider: ProviderId, documentExists: boolean): string {
  const canonical = canonicalizeReference(reference, provider);
  if (documentExists || !canonical.endsWith('#this')) return canonical;
  return canonical.slice(0, -'#this'.length);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadPodDocuments(podRoot: string): Promise<Map<string, Document>> {
  const documents = new Map<string, Document>();
  if (!(await isDirectory(path.join(podRoot, SETTINGS_DIRECTORY)))) {
    throw new Error(`Not a Pod root: ${podRoot} has no ${SETTINGS_DIRECTORY}/ directory`);
  }
  for (const relativePath of await listTurtleDocuments(podRoot)) {
    const turtle = await readFile(path.join(podRoot, relativePath), 'utf8');
    const quads = new Parser({ baseIRI: `pod:///${relativePath}` }).parse(turtle);
    documents.set(relativePath, { id: relativePath, quads, originalQuads: [...quads] });
  }
  if (!documents.has(CREDENTIALS_DOCUMENT)) {
    documents.set(CREDENTIALS_DOCUMENT, { id: CREDENTIALS_DOCUMENT, quads: [], originalQuads: [] });
  }
  return documents;
}

async function listTurtleDocuments(podRoot: string): Promise<string[]> {
  const found: string[] = [];
  if (await isFile(path.join(podRoot, CREDENTIALS_DOCUMENT))) found.push(CREDENTIALS_DOCUMENT);
  const providersPath = path.join(podRoot, PROVIDERS_DIRECTORY);
  if (await isDirectory(providersPath)) {
    for (const entry of await readdir(providersPath)) {
      if (entry.endsWith('.ttl')) found.push(`${PROVIDERS_DIRECTORY}/${entry}`);
    }
  }
  return found.sort();
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function planMigration(documents: Map<string, Document>): MigrationPlan {
  const plan: MigrationPlan = {
    credentialFindings: [],
    credentialSkips: [],
    referenceChanges: [],
    legacyMoves: [],
    relationRewrites: [],
  };
  const foldedDocuments = foldLegacyProviderDocuments(documents, plan);
  backfillCredentialOfferings(documents, foldedDocuments, plan);
  normalizeProviderReferences(documents, foldedDocuments, plan);
  return plan;
}

/**
 * Move model rows out of `<provider>-<offering>.ttl` documents into
 * `<provider>.ttl`, merging the legacy document's `hasModel`.
 */
function foldLegacyProviderDocuments(
  documents: Map<string, Document>,
  plan: MigrationPlan,
): Map<string, ProviderId> {
  const folded = new Map<string, ProviderId>();
  for (const document of [...documents.values()]) {
    const key = providerKeyForDocumentId(document.id);
    const identity = key ? providerIdentityForDocumentKey(key) : undefined;
    if (!identity?.offeringId) continue;

    const targetId = `${PROVIDERS_DIRECTORY}/${identity.provider}.ttl`;
    const target = ensureDocument(documents, targetId);
    const legacyProviderSubject = providerSubjectOf(document.quads);
    let movedRows = 0;
    let droppedRows = 0;

    for (const subject of subjectsOf(document.quads)) {
      if (subject === legacyProviderSubject) continue;
      const fragment = fragmentOf(subject);
      if (!fragment) continue;
      const canonicalSubject = canonicalizeReference(subject, identity.provider);
      if (target.quads.some((candidate) => candidate.subject.value === canonicalSubject)) {
        droppedRows += 1;
        removeSubject(document, subject);
        plan.referenceChanges.push({ document: document.id, action: 'dedupe', from: subject, to: canonicalSubject });
        continue;
      }
      const providerIri = canonicalSubject.split('#', 1)[0]!;
      for (const quad of document.quads.filter((candidate) => candidate.subject.value === subject)) {
        target.quads.push(rewriteQuad(quad, {
          subject: canonicalSubject,
          object: quad.predicate.value === PREDICATE.isProvidedBy ? providerIri : undefined,
        }));
      }
      removeSubject(document, subject);
      movedRows += 1;
    }

    if (legacyProviderSubject) {
      const canonicalProviderSubject = canonicalizeReference(legacyProviderSubject, identity.provider);
      const targetHasProviderSubject = target.quads.some(
        (candidate) => candidate.subject.value === canonicalProviderSubject,
      );
      for (const quad of document.quads.filter((candidate) => candidate.subject.value === legacyProviderSubject)) {
        const isModelReference = quad.predicate.value === PREDICATE.hasModel
          || quad.predicate.value === PREDICATE.defaultModel;
        // The offering document's own model selections belong to the provider
        // either way; its identity triples only fill gaps.
        if (isModelReference || !targetHasProviderSubject) {
          target.quads.push(rewriteQuad(quad, { subject: canonicalProviderSubject }));
        }
      }
      removeSubject(document, legacyProviderSubject);
    }

    folded.set(document.id, identity.provider);
    plan.legacyMoves.push({
      document: document.id,
      provider: identity.provider,
      target: targetId,
      movedRows,
      droppedRows,
      removed: document.quads.length === 0,
    });
  }
  for (const document of [...documents.values()]) {
    if (folded.has(document.id) && document.quads.length === 0) documents.delete(document.id);
  }
  return folded;
}

/** Fold every model reference onto the provider's own document, deduplicated. */
function normalizeProviderReferences(
  documents: Map<string, Document>,
  foldedDocuments: Map<string, ProviderId>,
  plan: MigrationPlan,
): void {  for (const document of documents.values()) {
    if (document.id === CREDENTIALS_DOCUMENT) continue;
    const key = providerKeyForDocumentId(document.id);
    const identity = key ? providerIdentityForDocumentKey(key) : undefined;
    const provider = identity?.provider;
    if (!provider) continue;

    for (const predicate of [PREDICATE.hasModel, PREDICATE.defaultModel]) {
      // Group by model fragment: a fragment may appear both as a real reference
      // and as a phantom twin, and only one of them may survive.
      const entriesByFragment = new Map<string, ReferenceEntry[]>();
      for (const quad of document.quads) {
        if (quad.predicate.value !== predicate || quad.object.termType !== 'NamedNode') continue;
        const reference = quad.object.value;
        const fragment = fragmentOf(reference) ?? reference;
        const referencedDocument = documentIdForReference(reference);
        const documentExists = documents.has(referencedDocument) && !foldedDocuments.has(referencedDocument);
        const canonical = canonicalizeReference(reference, provider);
        const entries = entriesByFragment.get(fragment) ?? [];
        entries.push({ quad, reference, canonical, needsRewrite: !documentExists && canonical !== reference });
        entriesByFragment.set(fragment, entries);
      }
      for (const entries of entriesByFragment.values()) {
        // Keep a reference that already names the provider's document whenever
        // one exists, so the surviving triple is an original, not a rewrite.
        const kept = entries.find((entry) => !entry.needsRewrite) ?? entries[0]!;
        if (kept.needsRewrite) {
          replaceReference(document, kept.quad, kept.canonical);
          plan.referenceChanges.push({
            document: document.id,
            action: 'rewrite',
            from: kept.reference,
            to: kept.canonical,
            predicate,
          });
        }
        for (const entry of entries) {
          if (entry === kept) continue;
          removeQuad(document, entry.quad);
          plan.referenceChanges.push({
            document: document.id,
            action: 'remove',
            from: entry.reference,
            to: `duplicate of ${kept.canonical}`,
            predicate,
          });
        }
      }
    }
  }
}

function backfillCredentialOfferings(
  documents: Map<string, Document>,
  foldedDocuments: Map<string, ProviderId>,
  plan: MigrationPlan,
): void {
  const credentials = documents.get(CREDENTIALS_DOCUMENT);
  if (!credentials) return;
  for (const subject of subjectsOf(credentials.quads)) {
    if (!isCredentialSubject(credentials.quads, subject)) continue;
    const row = credentialRowFacts(credentials.quads, subject);
    if (row.offeringId) continue;
    if (!row.providerRelation) {
      plan.credentialSkips.push({ subject, reason: 'no udfs:provider relation' });
      continue;
    }
    const identity = providerIdentityForRelation(row.providerRelation);
    if (!identity) {
      plan.credentialSkips.push({
        subject,
        reason: `provider reference is not a product provider document (${row.providerRelation})`,
      });
      continue;
    }
    const referencedDocument = documentIdForReference(row.providerRelation);
    const documentExists = documents.has(referencedDocument) && !foldedDocuments.has(referencedDocument);
    const provider = foldedDocuments.get(referencedDocument) ?? identity.provider;

    const canonicalRelation = canonicalProviderRelation(row.providerRelation, provider, documentExists);
    if (canonicalRelation !== row.providerRelation) {
      replaceProviderRelation(credentials, subject, canonicalRelation);
      plan.relationRewrites.push({ subject, from: row.providerRelation, to: canonicalRelation });
    }

    const derived = deriveOffering({
      provider,
      authMode: row.authMode,
      accountLabel: row.accountLabel,
      baseUrl: row.baseUrl,
      relationOfferingId: identity.offeringId,
      metadataOfferingId: row.metadataOfferingId,
    });
    if ('offeringId' in derived) {
      credentials.quads.push(quad(subject, PREDICATE.offeringId, DataFactory.literal(derived.offeringId)));
      plan.credentialFindings.push({ subject, provider, offeringId: derived.offeringId, evidence: derived.evidence });
    } else {
      plan.credentialSkips.push({ subject, reason: derived.reason });
    }
  }
}

interface DerivationInput {
  provider: ProviderId;
  authMode?: string;
  accountLabel?: string;
  baseUrl?: string;
  relationOfferingId?: string;
  metadataOfferingId?: string;
}

/**
 * The offering a credential provably uses, or the reason it cannot be derived.
 *
 * Every source must agree; a source matching several offerings counts as
 * ambiguous rather than as a vote. Only when no source names anything does the
 * auth mode decide, and then only if the provider has a single offering that
 * accepts it.
 */
function deriveOffering(input: DerivationInput): { offeringId: string; evidence: string } | { reason: string } {
  const offerings = providerOfferings(input.provider);
  if (offerings.length === 0) return { reason: `no catalog offering for provider "${input.provider}"` };
  const sources: { evidence: string; matches: string[] }[] = [];

  if (input.relationOfferingId) {
    const known = catalogOfferingId(input.provider, input.relationOfferingId);
    if (known) sources.push({ evidence: `provider reference offering "${known}"`, matches: [known] });
  }
  if (input.metadataOfferingId) {
    const known = catalogOfferingId(input.provider, input.metadataOfferingId);
    if (known) sources.push({ evidence: `metadata.offeringId "${known}"`, matches: [known] });
  }
  if (input.accountLabel) {
    const matches = offerings
      .filter((offering) => labelMatches(offering.label, input.accountLabel!))
      .map((offering) => offering.id);
    if (matches.length > 0) sources.push({ evidence: `account label "${input.accountLabel}"`, matches });
  }
  if (input.baseUrl) {
    const normalized = normalizeEndpoint(input.baseUrl);
    const matches = offerings
      .filter((offering) => (offering.endpoints ?? []).some((endpoint) =>
        normalizeEndpoint(endpoint.baseUrl) === normalized))
      .map((offering) => offering.id);
    if (matches.length > 0) sources.push({ evidence: `base URL "${input.baseUrl}"`, matches });
  }

  const decisive = sources.filter((source) => source.matches.length === 1);
  const conflicting = decisive.filter((source, _index, all) =>
    all.some((other) => other.matches[0] !== source.matches[0]));
  if (conflicting.length > 0) {
    return {
      reason: `conflicting evidence (${conflicting
        .map((source) => `${source.evidence} -> ${source.matches[0]}`)
        .join('; ')})`,
    };
  }

  const agreed = sources.length > 0
    ? intersectMatches(sources.map((source) => source.matches))
    : offerings.map((offering) => offering.id);
  const compatible = agreed.filter((offeringId) => offeringAcceptsAuthMode(
    offerings.find((offering) => offering.id === offeringId)?.authModes,
    input.authMode,
  ));

  if (compatible.length === 1) {
    const evidence = sources.length > 0
      ? sources.map((source) => source.evidence).join(' + ')
      : `only offering for authMode "${input.authMode ?? 'unknown'}"`;
    return { offeringId: compatible[0]!, evidence };
  }
  if (compatible.length > 1) {
    return {
      reason: `${compatible.length} offerings remain possible (${compatible.join(', ')})`
        + ' - no label, base URL or legacy reference chooses between them',
    };
  }
  if (sources.length > 0) {
    return {
      reason: `evidence names ${sources.flatMap((source) => source.matches).join(', ')},`
        + ` none of which accepts authMode "${input.authMode ?? 'unknown'}"`,
    };
  }
  return { reason: 'no offering evidence: account label, base URL, provider reference and auth mode all stay silent' };
}

function intersectMatches(sets: string[][]): string[] {
  if (sets.length === 0) return [];
  return sets.reduce((left, right) => left.filter((value) => right.includes(value)));
}

/** Mirrors the Gateway's `offeringMatchesCredentialAuthMode`. */
function offeringAcceptsAuthMode(authModes: readonly string[] | undefined, authMode: string | undefined): boolean {
  if (!authModes) return false;
  if (authMode === 'apiKey') return authModes.includes('apiKey');
  if (authMode === 'local') return authModes.includes('local');
  if (authMode === 'deviceCodeOAuth' || authMode === 'deviceCode' || authMode === 'oauth') {
    return authModes.includes('deviceCode') || authModes.includes('oauth');
  }
  return false;
}

function labelMatches(offeringLabel: string, accountLabel: string): boolean {
  const normalized = accountLabel.trim().toLowerCase();
  const candidate = offeringLabel.trim().toLowerCase();
  if (!candidate || !normalized) return false;
  return normalized === candidate || normalized.startsWith(`${candidate} `) || normalized.includes(` ${candidate} `);
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Quad helpers
// ---------------------------------------------------------------------------

interface CredentialRowFacts {
  providerRelation?: string;
  authMode?: string;
  accountLabel?: string;
  baseUrl?: string;
  offeringId?: string;
  metadataOfferingId?: string;
}

function credentialRowFacts(quads: Quad[], subject: string): CredentialRowFacts {
  const own = quads.filter((candidate) => candidate.subject.value === subject);
  const valueOf = (predicate: string): string | undefined =>
    own.find((candidate) => candidate.predicate.value === predicate)?.object.value;
  return {
    providerRelation: valueOf(PREDICATE.provider),
    authMode: valueOf(PREDICATE.authMode),
    accountLabel: valueOf(PREDICATE.accountLabel) ?? valueOf(PREDICATE.label),
    baseUrl: valueOf(PREDICATE.baseUrl) ?? metadataString(own, 'baseUrl'),
    offeringId: valueOf(PREDICATE.offeringId),
    metadataOfferingId: metadataString(own, 'offeringId'),
  };
}

function metadataString(own: Quad[], key: string): string | undefined {
  const raw = own.find((candidate) => candidate.predicate.value === PREDICATE.metadata)?.object.value;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function isCredentialSubject(quads: Quad[], subject: string): boolean {
  return quads.some((candidate) =>
    candidate.subject.value === subject
    && candidate.predicate.value === PREDICATE.type
    && candidate.object.value === PREDICATE.credentialType);
}

function providerSubjectOf(quads: Quad[]): string | undefined {
  return quads.find((candidate) =>
    candidate.predicate.value === PREDICATE.type && candidate.object.value === PREDICATE.providerType)?.subject.value
    ?? quads.find((candidate) => candidate.predicate.value === PREDICATE.hasModel)?.subject.value;
}

function subjectsOf(quads: Quad[]): string[] {
  return [...new Set(quads
    .filter((candidate) => candidate.subject.termType === 'NamedNode')
    .map((candidate) => candidate.subject.value))];
}

function providerKeyForDocumentId(documentId: string): string | undefined {
  if (!documentId.startsWith(`${PROVIDERS_DIRECTORY}/`)) return undefined;
  const fileName = documentId.slice(PROVIDERS_DIRECTORY.length + 1);
  return fileName.toLowerCase().endsWith('.ttl') ? fileName.slice(0, -'.ttl'.length) : undefined;
}

function fragmentOf(reference: string): string | undefined {
  const index = reference.lastIndexOf('#');
  return index >= 0 && index < reference.length - 1 ? reference.slice(index + 1) : undefined;
}

/** The Pod-relative document a reference lives in. */
function documentIdForReference(reference: string): string {
  const document = reference.split('#', 1)[0] ?? reference;
  const marker = `/${PROVIDERS_DIRECTORY}/`;
  const index = document.lastIndexOf(marker);
  if (index >= 0) return `${PROVIDERS_DIRECTORY}/${document.slice(index + marker.length)}`;
  const bare = document.split('/').filter(Boolean).at(-1) ?? document;
  return `${PROVIDERS_DIRECTORY}/${bare}`;
}

function replaceReference(document: Document, quad: Quad, value: string): void {
  const index = document.quads.indexOf(quad);
  if (index >= 0) document.quads[index] = rewriteQuad(quad, { object: value });
}

function replaceProviderRelation(document: Document, subject: string, value: string): void {
  for (const quad of [...document.quads]) {
    if (quad.subject.value === subject && quad.predicate.value === PREDICATE.provider) {
      replaceReference(document, quad, value);
    }
  }
}

function removeQuad(document: Document, quad: Quad): void {
  const index = document.quads.indexOf(quad);
  if (index >= 0) document.quads.splice(index, 1);
}

function removeSubject(document: Document, subject: string): void {
  document.quads = document.quads.filter((candidate) => candidate.subject.value !== subject);
}

/**
 * A copy of `source` with some terms replaced.
 *
 * Built through `DataFactory` rather than object spread: n3 keeps a term's
 * fields behind prototype accessors, so a spread quad would lose `predicate`
 * and friends.
 */
function rewriteQuad(
  source: Quad,
  changes: { subject?: string; predicate?: string; object?: string | Quad['object'] },
): Quad {
  return DataFactory.quad(
    changes.subject === undefined ? source.subject : DataFactory.namedNode(changes.subject),
    changes.predicate === undefined ? source.predicate : DataFactory.namedNode(changes.predicate),
    changes.object === undefined
      ? source.object
      : typeof changes.object === 'string'
        ? DataFactory.namedNode(changes.object)
        : changes.object,
    source.graph,
  );
}

function quad(subject: string, predicate: string, object: Quad['object']): Quad {
  return DataFactory.quad(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate),
    object,
    DataFactory.defaultGraph(),
  );
}

function ensureDocument(documents: Map<string, Document>, id: string): Document {
  const existing = documents.get(id);
  if (existing) return existing;
  const created: Document = { id, quads: [], originalQuads: [] };
  documents.set(id, created);
  return created;
}

function serialize(quads: Quad[]): string {
  if (quads.length === 0) return '';
  const writer = new Writer({ prefixes: PREFIXES });
  writer.addQuads(quads);
  let output = '';
  writer.end((error, result) => {
    if (error) throw error;
    output = result;
  });
  return output;
}

function changedDocuments(documents: Map<string, Document>): string[] {
  return [...documents.values()]
    .filter((document) =>
      serialize([...document.quads].sort(compareQuads)) !== serialize([...document.originalQuads].sort(compareQuads)))
    .map((document) => document.id);
}

function compareQuads(left: Quad, right: Quad): number {
  return quadKey(left).localeCompare(quadKey(right));
}

function quadKey(quad: Quad): string {
  return `${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

async function applyPlan(
  podRoot: string,
  documents: Map<string, Document>,
  original: Map<string, Document>,
  backupDirectory: string,
): Promise<string[]> {
  await mkdir(backupDirectory, { recursive: true });
  await cp(path.join(podRoot, SETTINGS_DIRECTORY), path.join(backupDirectory, SETTINGS_DIRECTORY), {
    recursive: true,
  });
  const written: string[] = [];
  for (const document of documents.values()) {
    const previous = original.get(document.id);
    const next = serialize(document.quads);
    if (previous && serializationsMatch(previous.originalQuads, document.quads)) continue;
    if (!previous && next === '') continue;
    const absolute = path.join(podRoot, document.id);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.migrating`;
    await writeFile(temporary, next, 'utf8');
    await rename(temporary, absolute);
    written.push(document.id);
  }
  for (const document of original.values()) {
    if (documents.has(document.id)) continue;
    const absolute = path.join(podRoot, document.id);
    if (await isFile(absolute)) await rm(absolute);
    written.push(`-${document.id}`);
  }
  return written;
}

function serializationsMatch(left: Quad[], right: Quad[]): boolean {
  return serialize([...left].sort(compareQuads)) === serialize([...right].sort(compareQuads));
}

// ---------------------------------------------------------------------------
// Guard scan
// ---------------------------------------------------------------------------

/**
 * References that do not resolve to a stored model row.
 *
 * `docs/ai-connections-storage-model.md` §7 asks for a cheap guard that a model
 * reference names a document that exists; a reference whose document exists but
 * whose row was never written is the same defect one step further in, so both
 * are reported. The scan runs on the state the migration would leave behind, so
 * after `--apply` an empty scan is the acceptance criterion ("no URL-titled,
 * unavailable duplicates").
 */
export function guardScan(documents: Map<string, Document>): { document: string; reference: string; reason: string }[] {
  const dangling: { document: string; reference: string; reason: string }[] = [];
  for (const document of documents.values()) {
    if (document.id === CREDENTIALS_DOCUMENT) continue;
    for (const quad of document.quads) {
      if (quad.predicate.value !== PREDICATE.hasModel && quad.predicate.value !== PREDICATE.defaultModel) continue;
      if (quad.object.termType !== 'NamedNode') continue;
      const reference = quad.object.value;
      const referenced = documentIdForReference(reference);
      const target = documents.get(referenced);
      if (!target) {
        dangling.push({ document: document.id, reference, reason: 'referenced document does not exist' });
        continue;
      }
      if (!target.quads.some((candidate) => candidate.subject.value === reference)) {
        dangling.push({ document: document.id, reference, reason: 'model row is not in the referenced document' });
      }
    }
  }
  return dangling;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type GuardScan = { document: string; reference: string; reason: string }[];

function report(
  title: string,
  plan: MigrationPlan,
  scans: { found: GuardScan; after: GuardScan },
  changed: string[] | undefined,
  options: {
    extraLines?: string[];
    footerLines?: string[];
    changeLabel?: string;
    dryRunHint?: string;
  } = {},
): void {
  console.log(`${title}\n`);
  if (options.extraLines && options.extraLines.length > 0) {
    for (const line of options.extraLines) console.log(line);
    console.log('');
  }
  console.log(`Credential offering backfill (${plan.credentialFindings.length} derivable)`);
  for (const finding of plan.credentialFindings) {
    console.log(`  + ${shortSubject(finding.subject)}  offeringId=${finding.offeringId}  [${finding.provider}: ${finding.evidence}]`);
  }
  if (plan.credentialFindings.length === 0) console.log('  (nothing to backfill)');
  if (plan.credentialSkips.length > 0) {
    console.log(`\n  Left alone (${plan.credentialSkips.length} not derivable)`);
    for (const skip of plan.credentialSkips) {
      console.log(`  ? ${shortSubject(skip.subject)}  ${skip.reason}`);
    }
  }

  if (plan.relationRewrites.length > 0) {
    console.log(`\nCredential provider relations normalised (${plan.relationRewrites.length})`);
    for (const rewrite of plan.relationRewrites) {
      console.log(`  ~ ${shortSubject(rewrite.subject)}  ${rewrite.from} -> ${rewrite.to}`);
    }
  }

  if (plan.legacyMoves.length > 0) {
    console.log(`\nLegacy offering documents folded (${plan.legacyMoves.length})`);
    for (const move of plan.legacyMoves) {
      console.log(
        `  ~ ${move.document} -> ${move.target}: ${move.movedRows} model rows moved,`
        + ` ${move.droppedRows} duplicate rows dropped`
        + `${move.removed ? ', document removed' : ', document kept (other triples remain)'}`,
      );
    }
  }

  console.log(`\nReference guard scan (found now: ${scans.found.length}, after this migration: ${scans.after.length})`);
  for (const entry of scans.found) {
    console.log(`  ! ${entry.document}  ${entry.reference}  (${entry.reason})`);
  }
  if (scans.found.length === 0) {
    console.log('  (every hasModel/defaultModel reference resolves to a stored model row)');
  }

  console.log(`\nModel references (${plan.referenceChanges.length} changed)`);
  for (const change of plan.referenceChanges) {
    const marker = change.action === 'remove' ? '-' : change.action === 'dedupe' ? '=' : '~';
    console.log(`  ${marker} ${change.document}  ${change.from}${change.action === 'remove' ? `  (${change.to})` : ` -> ${change.to}`}`);
  }
  if (plan.referenceChanges.length === 0 && plan.legacyMoves.length === 0) {
    console.log('  (nothing dangling, nothing to deduplicate)');
  }
  console.log('');

  if (changed) {
    console.log(changed.length > 0
      ? `Applied. ${options.changeLabel ?? 'Documents written'}: ${changed.join(', ')}`
      : 'Applied. Nothing to write.');
    if (scans.after.length > 0) {
      console.log(`Note: ${scans.after.length} reference(s) still do not resolve after the migration - see the guard scan above.`);
    }
    if (options.footerLines && options.footerLines.length > 0) {
      console.log('');
      for (const line of options.footerLines) console.log(line);
    }
    return;
  }
  const pending = changedDocumentsFromPlan(plan);
  if (pending.length > 0) {
    console.log(`Dry run: nothing written. ${pending.length} document(s) would change: ${pending.join(', ')}`);
    console.log(options.dryRunHint ?? 'Re-run with --apply to write them (a backup of settings/ is taken first).');
  } else {
    console.log('Dry run: nothing to change - this Pod already matches the confirmed model.');
  }
}

/** A plan whose findings are non-empty always changes credentials.ttl. */
function changedDocumentsFromPlan(plan: MigrationPlan): string[] {
  const changed = new Set<string>();
  if (plan.credentialFindings.length > 0 || plan.relationRewrites.length > 0) changed.add(CREDENTIALS_DOCUMENT);
  for (const change of plan.referenceChanges) changed.add(change.document);
  for (const move of plan.legacyMoves) {
    changed.add(move.target);
    changed.add(move.document);
  }
  return [...changed].sort();
}

function shortSubject(subject: string): string {
  const fragment = fragmentOf(subject);
  const document = documentIdForReference(subject).split('/').at(-1) ?? subject;
  return fragment ? `${document}#${fragment}` : document;
}

// ---------------------------------------------------------------------------
// Live mode: the running Pod's store
// ---------------------------------------------------------------------------

/**
 * The live Pod is only ever reached through drizzle-solid against
 * `<pod>/settings/-/sparql`, the same access path
 * `ui/src/extensions/XpodAiConnectionsPodStore.ts` uses. One deviation is
 * deliberate: the `udfs:hasModel` removal is a narrowly scoped authenticated
 * Solid PATCH for that one predicate, mirroring
 * `XpodAiConnectionsPodStore.persistModelSelectionLinks()` and mandated by
 * `docs/drizzle-solid-link-array-update-todo.md` until drizzle-solid serializes
 * URI arrays. The ORM's own array update is *not* issued here even as the
 * "primary" call that doc pairs with the PATCH: it deletes every `hasModel`
 * triple and inserts one comma-joined *literal*, and a `DELETE/INSERT DATA` of
 * named nodes would leave that literal behind - which would break this
 * migration's contract that removing the dangling triples is the only effect.
 * The dry run prints the rendered ORM statement so the difference stays visible.
 */
export class LiveAuthError extends Error {}

export class LiveUnsupportedError extends Error {}

const HAS_MODEL_PREDICATE = PREDICATE.hasModel;

export interface LiveSession {
  readonly fetch: typeof fetch;
  readonly webId: string;
  /** Which documented source produced the session, for the report. */
  readonly source: string;
}

export interface LiveCredentialPatch {
  offeringId?: string;
  provider?: string;
}

export interface LiveLinkPatch {
  subject: string;
  predicate: string;
  documentUrl: string;
  remove: string[];
  add: string[];
}

export interface LiveWritePlan {
  credentialWrites: {
    subject: string;
    credentialId: string;
    patch: LiveCredentialPatch;
    reason: string;
  }[];
  linkPatches: LiveLinkPatch[];
  /** Corrections the live store cannot express; `--apply` refuses while any exist. */
  unsupported: string[];
}

export interface LivePodStore {
  readonly podUrl: string;
  readonly endpoint: string;
  readonly session: LiveSession;
  selectCredentials(): Promise<Record<string, unknown>[]>;
  selectProviders(): Promise<Record<string, unknown>[]>;
  selectModels(): Promise<Record<string, unknown>[]>;
  updateCredential(credentialId: string, patch: LiveCredentialPatch): Promise<void>;
  /** The drizzle-solid statement the ORM *would* run for the model set, rendered without executing. */
  renderProviderModelUpdate(providerId: string, modelIds: readonly string[]): string | undefined;
  patchLinks(patch: LiveLinkPatch): Promise<void>;
}

export interface LiveAuthInputs {
  env: Record<string, string | undefined>;
  stored: StoredCredentials | null;
  storedPath: string;
}

export interface LiveRows {
  credentials: Record<string, unknown>[];
  providers: Record<string, unknown>[];
  models: Record<string, unknown>[];
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function liveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * The subject IRI of a live row.
 *
 * drizzle-solid returns `@id`/`uri` (absolute) besides its base-relative `id`;
 * when only the relative form is present it is resolved through the resource
 * that produced the row, so `credentials.ttl#x` still becomes
 * `<pod>/settings/credentials.ttl#x`.
 */
function liveSubject(
  base: string,
  row: Record<string, unknown>,
  resource: typeof credentialResource,
): string | undefined {
  const reference = liveString(row['@id']) ?? liveString(row.uri) ?? liveString(row.subject);
  if (reference) return liveAbsoluteIri(base, reference);
  const relative = liveString(row.id);
  if (!relative) return undefined;
  return resource.buildIri(base, { id: relative } as never);
}

function liveAbsoluteIri(base: string, reference: string): string {
  return /^https?:\/\//u.test(reference) ? reference : new URL(reference, base).toString();
}

function liveValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => liveString(entry) ?? []);
  const single = liveString(value);
  return single ? [single] : [];
}

function liveMetadata(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  return undefined;
}

/** `…/settings/providers/openai.ttl#x` -> `settings/providers/openai.ttl`. */
export function liveDocumentId(base: string, subject: string): string {
  const document = subject.split('#', 1)[0] ?? subject;
  if (document.startsWith(base)) return document.slice(base.length);
  const marker = `/${SETTINGS_DIRECTORY}/`;
  const index = document.lastIndexOf(marker);
  return index >= 0 ? `${SETTINGS_DIRECTORY}/${document.slice(index + marker.length)}` : document;
}

/**
 * Present the live store's rows as the same documents the offline loader reads.
 *
 * Only the facts the shared planning code reads are projected (type, provider,
 * authMode, offeringId, labels, baseUrl, metadata; provider identity, hasModel,
 * defaultModel; model identity, isProvidedBy, displayName, status), so
 * `planMigration` and `guardScan` derive exactly what they derive from files.
 * Subject IRIs stay absolute; a row id is absolutized against the Pod base.
 */
export function documentsFromLiveRows(podUrl: string, rows: LiveRows): Map<string, Document> {
  const base = ensureTrailingSlash(podUrl);
  const documents = new Map<string, Document>();
  const add = (subject: string, predicate: string, object: Quad['object']): void => {
    ensureDocument(documents, liveDocumentId(base, subject)).quads.push(quad(subject, predicate, object));
  };

  for (const row of rows.credentials) {
    const subject = liveSubject(base, row, credentialResource);
    if (!subject) continue;
    add(subject, PREDICATE.type, DataFactory.namedNode(PREDICATE.credentialType));
    for (const [key, predicate] of [
      ['provider', PREDICATE.provider],
      ['authMode', PREDICATE.authMode],
      ['offeringId', PREDICATE.offeringId],
      ['label', PREDICATE.label],
      ['accountLabel', PREDICATE.accountLabel],
      ['baseUrl', PREDICATE.baseUrl],
    ] as const) {
      const value = liveString(row[key]);
      if (!value) continue;
      add(subject, predicate, key === 'provider'
        ? DataFactory.namedNode(liveAbsoluteIri(base, value))
        : DataFactory.literal(value));
    }
    const metadata = liveMetadata(row.metadata);
    if (metadata) add(subject, PREDICATE.metadata, DataFactory.literal(metadata));
  }

  for (const row of rows.providers) {
    const subject = liveSubject(base, row, aiProviderResource);
    if (!subject) continue;
    add(subject, PREDICATE.type, DataFactory.namedNode(PREDICATE.providerType));
    const displayName = liveString(row.displayName);
    if (displayName) add(subject, PREDICATE.displayName, DataFactory.literal(displayName));
    for (const reference of liveValues(row.hasModel)) {
      add(subject, PREDICATE.hasModel, DataFactory.namedNode(liveAbsoluteIri(base, reference)));
    }
    const defaultModel = liveString(row.defaultModel);
    if (defaultModel) add(subject, PREDICATE.defaultModel, DataFactory.namedNode(liveAbsoluteIri(base, defaultModel)));
  }

  for (const row of rows.models) {
    const subject = liveSubject(base, row, aiModelResource);
    if (!subject) continue;
    add(subject, PREDICATE.type, DataFactory.namedNode(PREDICATE.modelType));
    const displayName = liveString(row.displayName);
    if (displayName) add(subject, PREDICATE.displayName, DataFactory.literal(displayName));
    const providedBy = liveString(row.isProvidedBy);
    if (providedBy) add(subject, PREDICATE.isProvidedBy, DataFactory.namedNode(liveAbsoluteIri(base, providedBy)));
    const status = liveString(row.status);
    if (status) add(subject, PREDICATE.status, DataFactory.literal(status));
  }

  if (!documents.has(CREDENTIALS_DOCUMENT)) {
    documents.set(CREDENTIALS_DOCUMENT, { id: CREDENTIALS_DOCUMENT, quads: [], originalQuads: [] });
  }
  return documents;
}

export function liveAuthInputs(env: Record<string, string | undefined> = process.env): LiveAuthInputs {
  return { env, stored: loadCredentials(), storedPath: getSolidCredentialsPath() };
}

/**
 * `.env.local` is where `bun run dev` keeps the development client credentials
 * that `docs/cli-dev-testing.md` documents; loading it matches the other
 * `scripts/*` dev helpers. Values already in the environment win.
 */
async function loadLocalEnvFile(): Promise<void> {
  if (process.env.XPOD_MIGRATION_SKIP_ENV_FILE) return;
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  } catch {
    // No .env.local (or no dotenv): the documented credential sources still apply.
  }
}

const AUTH_ATTEMPT_TIMEOUT_MS = Number(process.env.XPOD_MIGRATION_AUTH_TIMEOUT_MS ?? 15_000);

type LiveAuthAttempt = 'auto' | 'dpop';

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${AUTH_ATTEMPT_TIMEOUT_MS}ms`)),
      AUTH_ATTEMPT_TIMEOUT_MS,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bearerSession(token: string, webId: string, source: string): LiveSession {
  return {
    fetch: (resource, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(resource, { ...init, headers });
    },
    webId,
    source,
  };
}

async function clientCredentialsSession(input: {
  clientId: string;
  clientSecret: string;
  webId?: string;
  issuer: string;
  source: string;
  failures: string[];
  attempt: LiveAuthAttempt;
}): Promise<LiveSession> {
  const { authenticate, getAccessToken } = await import('../src/cli/lib/solid-auth');
  // Two documented channels, both from `docs/cli-dev-testing.md`: the
  // client_credentials access token (`scripts/setup-google-provider.ts` reads it
  // the same way) and the `@inrupt/solid-client-authn-node` Solid Session that
  // the doc names for drizzle-solid Pod access. The session negotiates DPoP,
  // which a loopback-only runtime requires; `attempt: 'dpop'` retries it alone
  // after a Bearer token was rejected.
  const attempts: ('bearer' | 'dpop')[] = input.attempt === 'dpop' ? ['dpop'] : ['bearer', 'dpop'];
  for (const attempt of attempts) {
    if (attempt === 'bearer') {
      try {
        const token = (await withTimeout(
          getAccessToken(input.clientId, input.clientSecret, input.issuer),
          'client_credentials token request',
        ))?.accessToken;
        if (token) return bearerSession(token, input.webId ?? '', `${input.source}, Bearer access token`);
        input.failures.push(`${input.source}: the token endpoint issued no access token`);
      } catch (error) {
        input.failures.push(`${input.source} (Bearer token): ${describeError(error)}`);
      }
      continue;
    }
    try {
      const auth = await withTimeout(
        authenticate(input.clientId, input.clientSecret, input.issuer),
        'Solid session login',
      );
      const session = auth.session;
      if (session.info.isLoggedIn) {
        return {
          fetch: (resource, init) => session.fetch(resource as never, init as never),
          webId: session.info.webId ?? input.webId ?? '',
          source: `${input.source}, @inrupt/solid-client-authn-node session`,
        };
      }
      input.failures.push(`${input.source}: the Solid session did not log in`);
    } catch (error) {
      input.failures.push(`${input.source} (Solid session): ${describeError(error)}`);
    }
  }
  throw new LiveAuthError(`No usable live session (${input.source}).`);
}

/**
 * Resolve a session for the live Pod from the documented development sources.
 *
 * Nothing else is accepted, and nothing falls back to file writes: when no
 * source yields a session this throws with the inputs a human has to provide.
 */
export async function resolveLiveSession(
  podUrl: string,
  inputs: LiveAuthInputs,
  options: { attempt?: LiveAuthAttempt } = {},
): Promise<LiveSession> {
  const origin = ensureTrailingSlash(new URL(podUrl).origin);
  const issuer = inputs.env.TEST_SOLID_OIDC_ISSUER
    ?? inputs.env.SOLID_OIDC_ISSUER
    ?? origin;
  const attempt = options.attempt ?? 'auto';
  const failures: string[] = [];

  const envClientId = inputs.env.TEST_SOLID_CLIENT_ID ?? inputs.env.SOLID_CLIENT_ID;
  const envClientSecret = inputs.env.TEST_SOLID_CLIENT_SECRET ?? inputs.env.SOLID_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    try {
      return await clientCredentialsSession({
        clientId: envClientId,
        clientSecret: envClientSecret,
        webId: inputs.env.TEST_SOLID_WEBID ?? inputs.env.SOLID_WEBID,
        issuer,
        source: 'environment client credentials (TEST_SOLID_CLIENT_ID / SOLID_CLIENT_ID)',
        failures,
        attempt,
      });
    } catch (error) {
      if (!(error instanceof LiveAuthError)) throw error;
    }
  } else {
    failures.push('environment client credentials: TEST_SOLID_CLIENT_ID/SOLID_CLIENT_ID and its secret are not both set');
  }

  const stored = inputs.stored;
  const storedClient = stored ? getClientCredentials(stored) : null;
  const storedOAuth = stored ? getOAuthCredentials(stored) : null;
  if (stored && storedClient) {
    try {
      return await clientCredentialsSession({
        clientId: storedClient.clientId,
        clientSecret: storedClient.clientSecret,
        webId: stored.webId,
        issuer,
        source: `${inputs.storedPath} (client_credentials)`,
        failures,
        attempt,
      });
    } catch (error) {
      if (!(error instanceof LiveAuthError)) throw error;
    }
  } else if (stored && storedOAuth && attempt === 'auto') {
    try {
      const { getOidcAccessToken } = await import('../src/cli/lib/oidc-auth');
      const token = await withTimeout(getOidcAccessToken(stored), 'OIDC refresh');
      if (token) return bearerSession(token, stored.webId, `${inputs.storedPath} (oidc_oauth)`);
      failures.push(`${inputs.storedPath} (oidc_oauth): no usable access token and the refresh returned none`);
    } catch (error) {
      failures.push(`${inputs.storedPath} (oidc_oauth): ${describeError(error)}`);
    }
  } else if (stored && storedOAuth) {
    failures.push(`${inputs.storedPath}: an oidc_oauth entry has no DPoP client credentials to retry with`);
  } else if (!stored) {
    failures.push(`stored Solid session: ${inputs.storedPath} does not exist`);
  } else {
    failures.push(`${inputs.storedPath}: no client_credentials or oidc_oauth entry`);
  }

  throw new LiveAuthError([
    `No usable session for ${podUrl}. Live mode refuses to fall back to files; it only reads and writes through the Pod's store.`,
    'Provide one of the documented sources:',
    `  1. bun src/cli/index.ts auth login --url ${origin} --email <account-email> --password <password>`,
    `     (writes ${inputs.storedPath}; use SOLID_HOME=<dir> to keep it elsewhere)`,
    '  2. SOLID_CLIENT_ID / SOLID_CLIENT_SECRET (or TEST_SOLID_*) plus the matching webId in the environment,',
    '     e.g. via .env.local as `bun run dev` loads it.',
    'Attempts:',
    ...failures.map((failure) => `  - ${failure}`),
  ].join('\n'));
}

export async function createLivePodStore(podUrl: string, session: LiveSession): Promise<LivePodStore> {
  const base = ensureTrailingSlash(podUrl);
  const { ensureDrizzleSolidRuntimeConfigured } = await import('../src/runtime/configure-drizzle-solid');
  ensureDrizzleSolidRuntimeConfigured();
  const { drizzle } = await import('@undefineds.co/drizzle-solid');
  const endpoint = new URL(`${SETTINGS_DIRECTORY}/-/sparql`, base).toString();
  credentialResource.setSparqlEndpoint(endpoint);
  aiProviderResource.setSparqlEndpoint(endpoint);
  aiModelResource.setSparqlEndpoint(endpoint);
  const authSession: SolidAuthSession = {
    info: { webId: session.webId, isLoggedIn: true, sessionId: 'migrate-ai-offering-storage' },
    fetch: session.fetch,
  } as SolidAuthSession;
  const database = drizzle(authSession, {
    podUrl: base,
    schema: {
      aiModel: aiModelResource,
      aiProvider: aiProviderResource,
      credential: credentialResource,
    },
    autoConnect: false,
    resourcePreparation: 'off',
  }) as unknown as SolidDatabase;
  const rows = async (resource: typeof credentialResource): Promise<Record<string, unknown>[]> =>
    await database.select().from(resource).execute() as Record<string, unknown>[];

  return {
    podUrl: base,
    endpoint,
    session,
    selectCredentials: () => rows(credentialResource),
    selectProviders: () => rows(aiProviderResource),
    selectModels: () => rows(aiModelResource),
    async updateCredential(credentialId, patch) {
      const updated = await database.updateById(credentialResource, credentialId, patch as never);
      if (!updated) throw new Error(`credential_update_failed:${credentialId}`);
    },
    renderProviderModelUpdate(providerId, modelIds) {
      try {
        const iri = aiProviderResource.buildIri(base, { id: providerId } as never);
        return database.session
          .update(aiProviderResource)
          .set({ hasModel: [...modelIds] } as never)
          .whereByIri(iri)
          .toSPARQL().query;
      } catch {
        return undefined;
      }
    },
    /**
     * Only `udfs:hasModel`: mirrors `persistModelSelectionLinks()` in
     * `ui/src/extensions/XpodAiConnectionsPodStore.ts` (PATCH the document,
     * `application/sparql-update`, DELETE DATA + INSERT DATA of named nodes).
     */
    async patchLinks(patch) {
      const triples = (iris: readonly string[]): string => iris
        .map((iri) => `<${patch.subject}> <${patch.predicate}> <${iri}> .`)
        .join('\n');
      const operations = [
        patch.remove.length > 0 ? `DELETE DATA { ${triples(patch.remove)} }` : undefined,
        patch.add.length > 0 ? `INSERT DATA { ${triples(patch.add)} }` : undefined,
      ].filter((operation): operation is string => Boolean(operation));
      if (operations.length === 0) return;
      const response = await session.fetch(patch.documentUrl, {
        method: 'PATCH',
        headers: { 'content-type': 'application/sparql-update' },
        body: operations.join(';\n'),
      });
      if (!response.ok) throw new Error(`has_model_patch_failed:${response.status}:${patch.documentUrl}`);
    },
  };
}

export class LivePodReadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function liveReadFailure(error: unknown, store: LivePodStore, operation: string): LivePodReadError {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(/\b(401|403)\b/u.exec(message)?.[1]) || undefined;
  const reason = status
    ? `the live store rejected the session from ${store.session.source}`
      + ` (webId ${store.session.webId || 'unknown'}) with HTTP ${status}`
    : 'the live store did not answer the read';
  return new LivePodReadError(
    `Live ${operation} through ${store.endpoint} failed: ${reason}.\n`
    + `  ${message.split('\n')[0]}\n`
    + '  Live mode never falls back to file writes; supply a session that may read this Pod.',
    status,
  );
}

export async function loadLiveDocuments(store: LivePodStore): Promise<Map<string, Document>> {
  const read = async (
    operation: string,
    select: () => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> => {
    try {
      return await select();
    } catch (error) {
      throw liveReadFailure(error, store, operation);
    }
  };
  const rows: LiveRows = {
    credentials: await read('credential read', () => store.selectCredentials()),
    providers: await read('provider read', () => store.selectProviders()),
    models: await read('model read', () => store.selectModels()),
  };
  return documentsFromLiveRows(store.podUrl, rows);
}

/** The drizzle-solid call a live write issues, as the dry run prints it. */
function liveCredentialCall(write: LiveWritePlan['credentialWrites'][number]): string {
  const patch = Object.entries(write.patch)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
  return `db.updateById(credentialResource, ${JSON.stringify(write.credentialId)}, { ${patch} })`;
}

export function planLiveWrites(
  podUrl: string,
  plan: MigrationPlan,
  documents: Map<string, Document>,
): LiveWritePlan {
  const base = ensureTrailingSlash(podUrl);
  const credentialWrites: LiveWritePlan['credentialWrites'] = [];
  const writeFor = (subject: string): LiveWritePlan['credentialWrites'][number] | undefined => {
    const existing = credentialWrites.find((write) => write.subject === subject);
    if (existing) return existing;
    const reference = parsePodResourceRef(credentialResource, subject);
    if (!reference) return undefined;
    const created: LiveWritePlan['credentialWrites'][number] = {
      subject,
      credentialId: reference.resourceId,
      patch: {},
      reason: '',
    };
    credentialWrites.push(created);
    return created;
  };

  for (const finding of plan.credentialFindings) {
    const write = writeFor(finding.subject);
    if (!write) continue;
    write.patch.offeringId = finding.offeringId;
    write.reason = `offeringId=${finding.offeringId} [${finding.provider}: ${finding.evidence}]`;
  }
  for (const rewrite of plan.relationRewrites) {
    const write = writeFor(rewrite.subject);
    if (!write) continue;
    write.patch.provider = rewrite.to;
    write.reason = write.reason
      ? `${write.reason}; provider relation ${rewrite.from} -> ${rewrite.to}`
      : `provider relation ${rewrite.from} -> ${rewrite.to}`;
  }

  // Group the model-reference corrections per provider document and predicate:
  // the PATCH speaks one subject/predicate at a time.
  const patches = new Map<string, LiveLinkPatch>();
  const unsupported: string[] = [];
  for (const change of plan.referenceChanges) {
    if (change.action === 'dedupe') {
      unsupported.push(
        `${change.document}: folding the legacy offering document row ${change.from} into ${change.to}`
        + ' (moving model rows between documents; live mode does not implement it)',
      );
      continue;
    }
    const predicate = change.predicate ?? PREDICATE.hasModel;
    const document = documents.get(change.document);
    if (!document) continue;
    const patch = patches.get(`${change.document} ${predicate}`) ?? (() => {
      const created: LiveLinkPatch = {
        subject: '',
        predicate,
        documentUrl: new URL(change.document, base).toString(),
        remove: [],
        add: [],
      };
      patches.set(`${change.document} ${predicate}`, created);
      return created;
    })();
    patch.remove.push(change.from);
  }
  for (const patch of patches.values()) {
    const surviving = new Set<string>();
    for (const candidate of documents.get(liveDocumentId(base, patch.documentUrl))?.quads ?? []) {
      if (candidate.predicate.value !== patch.predicate || candidate.object.termType !== 'NamedNode') continue;
      patch.subject = patch.subject || candidate.subject.value;
      if (candidate.subject.value === patch.subject) surviving.add(candidate.object.value);
    }
    patch.add = [...surviving].sort();
    patch.remove = [...new Set(patch.remove)].sort();
  }
  for (const move of plan.legacyMoves) {
    unsupported.push(
      `${move.document}: moving ${move.movedRows} model row(s) into ${move.target}`
      + `${move.removed ? ' and removing the emptied document' : ''}`
      + ' (live mode does not implement document folding; use the offline mode on an offline copy)',
    );
  }
  // Only the patches that actually drop a reference are corrections; a patch
  // whose removals are empty would only re-assert what is already there.
  const effective = [...patches.values()].filter((patch) => patch.remove.length > 0);
  return {
    credentialWrites,
    linkPatches: effective.sort((left, right) => left.documentUrl.localeCompare(right.documentUrl)),
    unsupported,
  };
}

/** The exact calls `--apply` would issue, with the drizzle-solid API named. */
export function describeLiveWrites(store: LivePodStore, plan: LiveWritePlan): string[] {
  const lines: string[] = [];
  const total = plan.credentialWrites.length + plan.linkPatches.length;
  lines.push(`Planned live writes (${total})`);
  for (const write of plan.credentialWrites) {
    lines.push(`  ~ ${liveCredentialCall(write)}`);
    lines.push(`      ${write.reason}`);
  }
  for (const patch of plan.linkPatches) {
    lines.push(`  ~ PATCH ${patch.documentUrl}  (content-type: application/sparql-update)`);
    lines.push(`      DELETE DATA { <${patch.subject}> <${patch.predicate}> <…> . }  ${patch.remove.length} triple(s)`);
    for (const reference of patch.remove) lines.push(`        - ${shortSubject(reference)}`);
    lines.push(`      INSERT DATA { <${patch.subject}> <${patch.predicate}> <…> . }  ${patch.add.length} triple(s)`);
    for (const reference of patch.add) lines.push(`        + ${shortSubject(reference)}`);
    const rendered = store.renderProviderModelUpdate(
      parsePodResourceRef(aiProviderResource, patch.subject)?.resourceId ?? patch.subject,
      patch.add,
    );
    if (rendered) {
      lines.push('      drizzle-solid cannot state this predicate correctly: its array update renders');
      lines.push(`        ${rendered.replace(/\s+/gu, ' ').trim()}`);
      lines.push('      which deletes every hasModel triple and writes one literal, so this script sends the');
      lines.push('      PATCH above instead (docs/drizzle-solid-link-array-update-todo.md).');
    }
  }
  for (const entry of plan.unsupported) lines.push(`  ! not expressible in live mode: ${entry}`);
  if (total === 0 && plan.unsupported.length === 0) lines.push('  (nothing to write)');
  return lines;
}

export async function applyLivePlan(store: LivePodStore, writePlan: LiveWritePlan): Promise<string[]> {
  if (writePlan.unsupported.length > 0) {
    throw new LiveUnsupportedError([
      'Live --apply refused: this Pod needs corrections the live store path cannot express yet.',
      ...writePlan.unsupported.map((entry) => `  - ${entry}`),
      'Nothing was written. Run the offline mode against an offline copy, or extend the live writer first.',
    ].join('\n'));
  }
  const applied: string[] = [];
  for (const write of writePlan.credentialWrites) {
    await store.updateCredential(write.credentialId, write.patch);
    applied.push(`${CREDENTIALS_DOCUMENT}#${write.credentialId.split('#').at(-1) ?? write.credentialId}`);
  }
  for (const patch of writePlan.linkPatches) {
    await store.patchLinks(patch);
    applied.push(liveDocumentId(store.podUrl, patch.documentUrl));
  }
  return applied;
}

/**
 * Read the corrections back through the same endpoint. This - not the local
 * files - is the acceptance evidence.
 */
export async function readBackEvidence(
  store: LivePodStore,
  writePlan: LiveWritePlan,
): Promise<{ lines: string[]; problems: string[] }> {
  const lines: string[] = [];
  const problems: string[] = [];
  const documents = await loadLiveDocuments(store);
  const references = new Map<string, number>();
  for (const document of documents.values()) {
    for (const candidate of document.quads) {
      if (candidate.predicate.value !== PREDICATE.hasModel || candidate.object.termType !== 'NamedNode') continue;
      references.set(candidate.object.value, (references.get(candidate.object.value) ?? 0) + 1);
    }
  }
  for (const patch of writePlan.linkPatches) {
    for (const reference of patch.remove) {
      if (references.has(reference)) {
        problems.push(`dangling reference still present: ${reference}`);
        lines.push(`  ! still present  ${reference}`);
      }
    }
    for (const reference of patch.add) {
      const count = references.get(reference) ?? 0;
      if (count !== 1) problems.push(`reference ${reference} appears ${count} time(s), expected exactly 1`);
      lines.push(`  ${count === 1 ? 'ok' : '!'} ${shortSubject(reference)}  present exactly once: ${count === 1}`);
    }
  }
  for (const write of writePlan.credentialWrites) {
    const expected = write.patch;
    const row = (await store.selectCredentials()).find((candidate) =>
      liveSubject(store.podUrl, candidate, credentialResource) === write.subject);
    if (!row) {
      problems.push(`credential ${write.subject} is not readable after the write`);
      continue;
    }
    if (expected.offeringId !== undefined) {
      const actual = liveString(row.offeringId);
      const ok = actual === expected.offeringId;
      if (!ok) problems.push(`credential offeringId is ${actual ?? 'absent'}, expected ${expected.offeringId}`);
      lines.push(`  ${ok ? 'ok' : '!'} ${shortSubject(write.subject)}  udfs:offeringId = ${JSON.stringify(actual ?? null)}`);
    }
    if (expected.provider !== undefined) {
      const actual = liveString(row.provider);
      const ok = actual === expected.provider;
      if (!ok) problems.push(`credential provider is ${actual ?? 'absent'}, expected ${expected.provider}`);
      lines.push(`  ${ok ? 'ok' : '!'} ${shortSubject(write.subject)}  udfs:provider = ${actual ?? 'absent'}`);
    }
  }
  const unresolved = guardScan(documents);
  lines.push(`  guard scan through ${store.endpoint}: ${unresolved.length} unresolved`);
  for (const entry of unresolved) lines.push(`  ! ${entry.document}  ${entry.reference}  (${entry.reason})`);
  if (unresolved.length > 0) problems.push(`${unresolved.length} reference(s) still do not resolve`);
  return { lines, problems };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseOptions(argv: string[]): Options {
  let podRoot: string | undefined;
  let live: string | undefined;
  let apply = false;
  let verify = false;
  let backupDirectory: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--apply') apply = true;
    else if (argument === '--verify') verify = true;
    else if (argument === '--dry-run') apply = false;
    else if (argument === '--pod' || argument === '--pod-root') podRoot = argv[++index];
    else if (argument === '--live') live = argv[++index];
    else if (argument === '--backup-dir') backupDirectory = argv[++index];
    else if (!argument.startsWith('-')) {
      if (live !== undefined) throw new Error(`Unexpected positional argument after --live: ${argument}`);
      podRoot = argument;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (podRoot !== undefined && live !== undefined) {
    throw new Error('--pod and --live are mutually exclusive: --pod repairs an offline copy, --live writes through a running Pod.');
  }
  if (live !== undefined && backupDirectory !== undefined) {
    throw new Error('--backup-dir is offline-only: live mode writes through the store and copies no files.');
  }
  return { podRoot: podRoot ?? '', live, apply, verify, backupDirectory, help };
}

function usage(): string {
  return [
    'Migrate AI Connections Pod data onto the confirmed storage model.',
    '',
    'Usage:',
    '  bun scripts/migrate-ai-offering-storage.ts --pod <pod-root> [--apply] [--backup-dir <dir>]',
    '  bun scripts/migrate-ai-offering-storage.ts --live <pod-base-url> [--apply]',
    '',
    'Modes:',
    '  --pod <dir>        OFFLINE FILE MODE, for offline copies only. Rewrites .ttl files',
    '                     under <dir>/settings/. Never point it at a running Pod: the server',
    '                     answers SPARQL reads from its quadstore index, so file edits reach',
    '                     neither the index nor the server\'s next write. Use --live for that.',
    '  --live <url>       LIVE MODE, through the running Pod\'s store (drizzle-solid against',
    '                     <url>settings/-/sparql). Example: http://127.0.0.1:3000/glocal/',
    '',
    'Options:',
    '  --apply            Write the changes. Without it the script only reports.',
    '  --verify           Only run the reference guard scan; exit 1 if any',
    '                     hasModel/defaultModel reference does not resolve.',
    '  --backup-dir <dir> Offline only: where to copy settings/ before writing.',
    '                     Defaults to <pod-root>/../<pod>-ai-offering-backup-<timestamp>.',
    '  -h, --help         Show this help.',
    '',
    'Live mode resolves its session only from the documented development sources, and',
    'fails loudly when neither yields one (it never falls back to file writes):',
    '  1. $SOLID_HOME/auth/credentials.json (default ~/.solid/auth/credentials.json), from',
    '     `bun src/cli/index.ts auth login --url <gateway> --email <account> --password <pw>`;',
    '  2. SOLID_CLIENT_ID / SOLID_CLIENT_SECRET (or TEST_SOLID_*) with the matching webId,',
    '     read from the environment and .env.local.',
    'Live --apply then reads the corrections back through the same endpoint and prints that',
    'read-back; those lines, not the local files, are the acceptance evidence.',
  ].join('\n');
}

async function runLive(options: Options): Promise<void> {
  const podUrl = ensureTrailingSlash(new URL(options.live!).toString());
  await loadLocalEnvFile();
  const inputs = liveAuthInputs();
  let session = await resolveLiveSession(podUrl, inputs);
  let store = await createLivePodStore(podUrl, session);
  let documents: Map<string, Document>;
  try {
    documents = await loadLiveDocuments(store);
  } catch (error) {
    // A Bearer token this runtime refuses may still be usable as a DPoP-bound
    // Solid session; retry that documented channel once before giving up.
    if (!(error instanceof LivePodReadError) || (error.status !== 401 && error.status !== 403)) throw error;
    const retry = await resolveLiveSession(podUrl, inputs, { attempt: 'dpop' }).catch(() => undefined);
    if (!retry) throw error;
    session = retry;
    store = await createLivePodStore(podUrl, session);
    documents = await loadLiveDocuments(store);
  }
  const original = new Map([...documents].map(([id, document]) => [
    id,
    { ...document, quads: [...document.quads], originalQuads: [...document.originalQuads] },
  ]));
  const scanFound = guardScan(original);
  const plan = planMigration(documents);
  const pending = changedDocumentsFromPlan(plan);
  const scans = { found: scanFound, after: guardScan(documents) };
  const writePlan = planLiveWrites(podUrl, plan, documents);
  const header = [
    `Endpoint: ${store.endpoint}`,
    `Session:  ${session.source}${session.webId ? `  (webId ${session.webId})` : ''}`,
  ];

  if (options.verify && !options.apply) {
    console.log(`Live Pod: ${podUrl}\n`);
    for (const line of header) console.log(line);
    console.log(`\nReference guard scan (${scanFound.length} unresolved)`);
    for (const entry of scanFound) {
      console.log(`  ! ${entry.document}  ${entry.reference}  (${entry.reason})`);
    }
    if (scanFound.length === 0) {
      console.log('  (every hasModel/defaultModel reference resolves to a stored model row)');
    }
    if (scanFound.length > 0 || pending.length > 0) process.exitCode = 1;
    return;
  }

  let changed: string[] | undefined;
  let footerLines: string[] | undefined;
  if (options.apply) {
    changed = await applyLivePlan(store, writePlan);
    const evidence = await readBackEvidence(store, writePlan);
    footerLines = [
      `Read-back through ${store.endpoint} (acceptance evidence)`,
      ...evidence.lines,
    ];
    if (evidence.problems.length > 0) {
      console.log('Read-back found problems:');
      for (const problem of evidence.problems) console.log(`  ! ${problem}`);
      process.exitCode = 1;
    }
  }

  report(`Live Pod: ${podUrl}`, plan, scans, changed, {
    extraLines: [...header, '', ...describeLiveWrites(store, writePlan)],
    footerLines,
    changeLabel: `Written through ${store.endpoint}`,
    dryRunHint: 'Re-run with --apply to write them through the store (no file backup is involved).',
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || (!options.podRoot && !options.live)) {
    console.log(usage());
    if (!options.help) process.exitCode = 1;
    return;
  }
  if (options.live) {
    await runLive(options);
    return;
  }
  const podRoot = path.resolve(options.podRoot);
  const documents = await loadPodDocuments(podRoot);
  const original = new Map([...documents].map(([id, document]) => [
    id,
    { ...document, quads: [...document.quads], originalQuads: [...document.originalQuads] },
  ]));
  const scanFound = guardScan(original);
  const plan = planMigration(documents);
  const pending = changedDocuments(documents);
  const scans = { found: scanFound, after: guardScan(documents) };

  if (options.verify && !options.apply) {
    console.log(`Pod root: ${podRoot}\n`);
    console.log(`Reference guard scan (${scanFound.length} unresolved)`);
    for (const entry of scanFound) {
      console.log(`  ! ${entry.document}  ${entry.reference}  (${entry.reason})`);
    }
    if (scanFound.length === 0) {
      console.log('  (every hasModel/defaultModel reference resolves to a stored model row)');
    }
    if (scanFound.length > 0 || pending.length > 0) process.exitCode = 1;
    return;
  }

  let changed: string[] | undefined;
  if (options.apply) {
    const backupDirectory = options.backupDirectory
      ? path.resolve(options.backupDirectory)
      : path.join(podRoot, '..', `${path.basename(podRoot)}-ai-offering-backup-${timestamp()}`);
    changed = await applyPlan(podRoot, documents, original, backupDirectory);
    console.log(`Backup: ${backupDirectory}\n`);
  }
  report(`Pod root: ${podRoot}`, plan, scans, changed);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

if (import.meta.main) {
  main().then(
    () => {
      // A timed-out auth probe or a Comunica engine can leave handles open, and a
      // migration script must not linger after it has reported its result.
      process.exit(process.exitCode ?? 0);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      if (process.env.DEBUG && error instanceof Error && error.stack) console.error(error.stack);
      process.exit(1);
    },
  );
}
