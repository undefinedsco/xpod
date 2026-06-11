import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as models from '@undefineds.co/models';
import type { PodModelDescriptor } from '@undefineds.co/models';

export type ModelTypeIndexScope = 'private' | 'public';

export const PRIVATE_TYPE_INDEX_PATH = 'settings/privateTypeIndex.ttl';
export const PUBLIC_TYPE_INDEX_PATH = 'settings/publicTypeIndex.ttl';
const requireFromHere = createRequire(__filename);

export interface ModelTypeIndexEntry {
  registrationId: string;
  name: string;
  rdfClass: string;
  containerPath: string;
  instanceContainer: string;
  resourceName: string;
}

export interface ModelTypeIndexTemplateData {
  privateTypeIndex: string;
  xpodTypeIndexEntries: ModelTypeIndexEntry[];
}

export type ModelTypeIndexSource =
  | 'models_interop_catalog'
  | 'models_top_level_catalog'
  | 'models_solid_resources_compat'
  | 'models_descriptor_compat'
  | 'explicit_descriptors';

export interface ModelTypeIndexResolution {
  source: ModelTypeIndexSource;
  entries: ModelTypeIndexEntry[];
}

interface JsonLdIri {
  '@id': string;
}

interface ModelTypeIndexJsonLdRegistration {
  '@id': string;
  '@type': 'solid:TypeRegistration';
  'solid:forClass': JsonLdIri;
  'solid:instanceContainer': JsonLdIri;
  'foaf:name': string;
}

export interface ModelTypeIndexJsonLdDocument {
  '@context': {
    foaf: 'http://xmlns.com/foaf/0.1/';
    solid: 'http://www.w3.org/ns/solid/terms#';
  };
  '@id': string;
  '@type': ['solid:TypeIndex', 'solid:ListedDocument' | 'solid:UnlistedDocument'];
  'foaf:name': string;
  '@graph': ModelTypeIndexJsonLdRegistration[];
}

export interface ModelTypeIndexCatalogIri {
  '@id'?: unknown;
}

export interface ModelTypeIndexCatalogRegistration {
  '@id'?: unknown;
  resourceName?: unknown;
  resourceKind?: unknown;
  name?: unknown;
  'foaf:name'?: unknown;
  classUri?: unknown;
  'solid:forClass'?: ModelTypeIndexCatalogIri | unknown;
  storageBase?: unknown;
  instanceContainerPath?: unknown;
}

export interface ModelTypeIndexCatalog {
  registrations?: unknown;
}

export interface ModelTypeIndexCatalogSource {
  modelTypeIndexCatalog?: ModelTypeIndexCatalog;
  modelTypeIndexRegistrations?: unknown;
}

interface SolidResourceConfig {
  name?: unknown;
  type?: unknown;
  base?: unknown;
}

interface SolidResourceLike {
  config?: SolidResourceConfig;
  containerPath?: unknown;
}

interface ModelsWithInterop extends ModelTypeIndexCatalogSource {
  solidResources?: Record<string, unknown>;
  podSchema?: {
    list(): PodModelDescriptor[];
  };
}

let modelsInteropModule: ModelTypeIndexCatalogSource | undefined | null;

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizeContainerPath(value: string): string {
  const withLeading = value.startsWith('/') ? value : `/${value}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

function storageBaseToContainerPath(storageBase: string): string {
  const normalized = storageBase.startsWith('/') ? storageBase : `/${storageBase}`;
  if (normalized.endsWith('/')) {
    return normalizeContainerPath(normalized);
  }
  return normalizeContainerPath(normalized.slice(0, normalized.lastIndexOf('/') + 1));
}

function registrationSlug(name: string, rdfClass: string, instanceContainer: string): string {
  const slug = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase() || 'model';
  const hash = createHash('sha1').update(`${rdfClass}\n${instanceContainer}`).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readIri(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (isRecord(value)) {
    return readString(value['@id']);
  }
  return undefined;
}

function modelResourceKind(resourceName: string): string {
  return resourceName.replace(/Resource$/u, '');
}

function escapeTurtleLiteral(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r');
}

export function typeIndexLabel(typeIndexUrl: string): string {
  if (typeIndexUrl.includes('/publicTypeIndex.')) {
    return 'Public Type Index';
  }
  if (typeIndexUrl.includes('/privateTypeIndex.')) {
    return 'Private Type Index';
  }
  return 'Model Type Index';
}

export function typeIndexDocumentType(typeIndexUrl: string): 'solid:ListedDocument' | 'solid:UnlistedDocument' {
  return typeIndexUrl.includes('/publicTypeIndex.')
    ? 'solid:ListedDocument'
    : 'solid:UnlistedDocument';
}

export function modelPrivateTypeIndexUrl(podRoot: string): string {
  return modelTypeIndexUrl(podRoot, 'private');
}

export function modelPublicTypeIndexUrl(podRoot: string): string {
  return modelTypeIndexUrl(podRoot, 'public');
}

export function modelTypeIndexUrl(podRoot: string, scope: ModelTypeIndexScope): string {
  const path = scope === 'private' ? PRIVATE_TYPE_INDEX_PATH : PUBLIC_TYPE_INDEX_PATH;
  return new URL(path, ensureTrailingSlash(podRoot)).toString();
}

export function buildModelTypeIndexEntries(
  podRoot: string,
  descriptors?: readonly PodModelDescriptor[],
): ModelTypeIndexEntry[] {
  return resolveModelTypeIndexEntries(podRoot, descriptors).entries;
}

export function resolveModelTypeIndexEntries(
  podRoot: string,
  descriptors?: readonly PodModelDescriptor[],
): ModelTypeIndexResolution {
  if (descriptors) {
    return {
      source: 'explicit_descriptors',
      entries: buildEntriesFromDescriptors(podRoot, descriptors),
    };
  }

  const interopEntries = buildModelTypeIndexEntriesFromCatalog(podRoot, getModelsInteropCatalog() ?? {});
  if (interopEntries.length > 0) {
    return {
      source: 'models_interop_catalog',
      entries: interopEntries,
    };
  }

  const topLevelCatalogEntries = buildModelTypeIndexEntriesFromCatalog(podRoot, getModelsModule());
  if (topLevelCatalogEntries.length > 0) {
    return {
      source: 'models_top_level_catalog',
      entries: topLevelCatalogEntries,
    };
  }

  const resourceEntries = buildEntriesFromSolidResources(podRoot);
  if (resourceEntries.length > 0) {
    return {
      source: 'models_solid_resources_compat',
      entries: resourceEntries,
    };
  }

  return {
    source: 'models_descriptor_compat',
    entries: buildEntriesFromDescriptors(podRoot, getModelsModule().podSchema?.list() ?? []),
  };
}

function buildEntriesFromDescriptors(
  podRoot: string,
  descriptors: readonly PodModelDescriptor[],
): ModelTypeIndexEntry[] {
  const normalizedPodRoot = ensureTrailingSlash(podRoot);
  return dedupeAndSortEntries(descriptors.map((descriptor) => {
    const name = descriptor.resourceKind;
    const rdfClass = descriptor.class;
    const containerPath = storageBaseToContainerPath(descriptor.storage.base);
    const instanceContainer = new URL(containerPath.replace(/^\/+/u, ''), normalizedPodRoot).toString();
    return {
      registrationId: registrationSlug(name, rdfClass, instanceContainer),
      name,
      rdfClass,
      containerPath,
      instanceContainer,
      resourceName: descriptor.resourceKind,
    };
  }));
}

export function buildModelTypeIndexEntriesFromCatalog(
  podRoot: string,
  catalog: ModelTypeIndexCatalogSource,
): ModelTypeIndexEntry[] {
  const rawRegistrations = Array.isArray(catalog.modelTypeIndexRegistrations)
    ? catalog.modelTypeIndexRegistrations
    : Array.isArray(catalog.modelTypeIndexCatalog?.registrations)
      ? catalog.modelTypeIndexCatalog.registrations
      : [];
  const normalizedPodRoot = ensureTrailingSlash(podRoot);

  return dedupeAndSortEntries(rawRegistrations.flatMap((rawRegistration) => {
    if (!isRecord(rawRegistration)) {
      return [];
    }

    const registration = rawRegistration as ModelTypeIndexCatalogRegistration;
    const rdfClass = readIri(registration['solid:forClass']) ?? readString(registration.classUri);
    const containerPath = readString(registration.instanceContainerPath) ??
      (readString(registration.storageBase) ? storageBaseToContainerPath(readString(registration.storageBase) as string) : undefined);
    if (!rdfClass || !containerPath) {
      return [];
    }

    const resourceName = readString(registration.resourceName) ?? readString(registration.resourceKind) ?? 'model';
    const name = readString(registration.name) ??
      readString(registration['foaf:name']) ??
      readString(registration.resourceKind) ??
      modelResourceKind(resourceName);
    const normalizedContainerPath = normalizeContainerPath(containerPath);
    const instanceContainer = new URL(normalizedContainerPath.replace(/^\/+/u, ''), normalizedPodRoot).toString();

    return [{
      registrationId: registrationSlug(name, rdfClass, instanceContainer),
      name,
      rdfClass,
      containerPath: normalizedContainerPath,
      instanceContainer,
      resourceName,
    }];
  }));
}

function buildEntriesFromSolidResources(podRoot: string): ModelTypeIndexEntry[] {
  const solidResources = getModelsModule().solidResources ?? {};
  const normalizedPodRoot = ensureTrailingSlash(podRoot);

  return dedupeAndSortEntries(Object.entries(solidResources).flatMap(([resourceName, rawResource]) => {
    if (!isRecord(rawResource)) {
      return [];
    }

    const resource = rawResource as unknown as SolidResourceLike;
    const rdfClass = readString(resource.config?.type);
    const containerPath = readString(resource.containerPath) ??
      (readString(resource.config?.base) ? storageBaseToContainerPath(readString(resource.config?.base) as string) : undefined);
    if (!rdfClass || !containerPath) {
      return [];
    }

    const name = readString(resource.config?.name) ?? modelResourceKind(resourceName);
    const normalizedContainerPath = normalizeContainerPath(containerPath);
    const instanceContainer = new URL(normalizedContainerPath.replace(/^\/+/u, ''), normalizedPodRoot).toString();

    return [{
      registrationId: registrationSlug(name, rdfClass, instanceContainer),
      name,
      rdfClass,
      containerPath: normalizedContainerPath,
      instanceContainer,
      resourceName,
    }];
  }));
}

function dedupeAndSortEntries(entries: readonly ModelTypeIndexEntry[]): ModelTypeIndexEntry[] {
  const byRegistrationTarget = new Map<string, ModelTypeIndexEntry>();
  for (const entry of entries) {
    const key = `${entry.rdfClass}\n${entry.instanceContainer}`;
    if (!byRegistrationTarget.has(key)) {
      byRegistrationTarget.set(key, entry);
    }
  }

  return Array.from(byRegistrationTarget.values())
    .sort((left, right) => left.name.localeCompare(right.name) || left.rdfClass.localeCompare(right.rdfClass));
}

function getModelsModule(): ModelsWithInterop {
  return models as unknown as ModelsWithInterop;
}

function getModelsInteropCatalog(): ModelTypeIndexCatalogSource | undefined {
  if (modelsInteropModule !== undefined) {
    return modelsInteropModule ?? undefined;
  }

  try {
    try {
      modelsInteropModule = requireFromHere('@undefineds.co/models/interop') as ModelTypeIndexCatalogSource;
      return modelsInteropModule;
    } catch {
      // Older @undefineds.co/models packages did not expose the interop subpath.
    }

    const packageEntry = requireFromHere.resolve('@undefineds.co/models');
    const packageRoot = path.dirname(path.dirname(packageEntry));
    const candidatePaths = [
      path.join(packageRoot, 'dist/interop/model-type-index-catalog.json'),
      path.join(packageRoot, 'src/interop/model-type-index-catalog.json'),
      path.join(packageRoot, 'interop/model-type-index-catalog.json'),
    ];
    const catalogPath = candidatePaths.find((candidate) => existsSync(candidate));
    if (!catalogPath) {
      modelsInteropModule = null;
      return undefined;
    }

    const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as ModelTypeIndexCatalog;
    modelsInteropModule = {
      modelTypeIndexCatalog: parsed,
    };
  } catch {
    modelsInteropModule = null;
  }

  return modelsInteropModule ?? undefined;
}

export function buildModelTypeIndexJsonLdDocument(
  typeIndexUrl: string,
  entries: readonly ModelTypeIndexEntry[],
  label = typeIndexLabel(typeIndexUrl),
): ModelTypeIndexJsonLdDocument {
  return {
    '@context': {
      foaf: 'http://xmlns.com/foaf/0.1/',
      solid: 'http://www.w3.org/ns/solid/terms#',
    },
    '@id': typeIndexUrl,
    '@type': ['solid:TypeIndex', typeIndexDocumentType(typeIndexUrl)],
    'foaf:name': label,
    '@graph': entries.map((entry) => ({
      '@id': `${typeIndexUrl}#${entry.registrationId}`,
      '@type': 'solid:TypeRegistration',
      'solid:forClass': { '@id': entry.rdfClass },
      'solid:instanceContainer': { '@id': entry.instanceContainer },
      'foaf:name': entry.name,
    })),
  };
}

export function buildModelTypeIndexTemplateData(
  podRoot: string,
  descriptors?: readonly PodModelDescriptor[],
): ModelTypeIndexTemplateData {
  const privateTypeIndex = modelPrivateTypeIndexUrl(podRoot);
  return {
    privateTypeIndex,
    xpodTypeIndexEntries: buildModelTypeIndexEntries(podRoot, descriptors),
  };
}

export function renderModelTypeIndexTurtle(
  entries: ModelTypeIndexEntry[],
  label = 'Private Type Index',
  documentType: 'solid:ListedDocument' | 'solid:UnlistedDocument' = 'solid:UnlistedDocument',
): string {
  const registrationBlocks = entries.map((entry) => [
    `<#${entry.registrationId}>`,
    '    a solid:TypeRegistration;',
    `    solid:forClass <${entry.rdfClass}>;`,
    `    solid:instanceContainer <${entry.instanceContainer}>;`,
    `    foaf:name "${escapeTurtleLiteral(entry.name)}".`,
  ].join('\n'));

  return [
    '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
    '@prefix solid: <http://www.w3.org/ns/solid/terms#>.',
    '',
    '<>',
    `    a solid:TypeIndex, ${documentType};`,
    `    foaf:name "${escapeTurtleLiteral(label)}".`,
    '',
    ...registrationBlocks,
    '',
  ].join('\n');
}

export function buildModelTypeIndexInsertData(typeIndexUrl: string, entries: ModelTypeIndexEntry[]): string {
  const typeIndexSubject = `<${typeIndexUrl}>`;
  const documentTypeIri = typeIndexDocumentType(typeIndexUrl) === 'solid:ListedDocument'
    ? 'http://www.w3.org/ns/solid/terms#ListedDocument'
    : 'http://www.w3.org/ns/solid/terms#UnlistedDocument';
  const triples = [
    `${typeIndexSubject} a <http://www.w3.org/ns/solid/terms#TypeIndex>, <${documentTypeIri}> .`,
    `${typeIndexSubject} <http://xmlns.com/foaf/0.1/name> "${escapeTurtleLiteral(typeIndexLabel(typeIndexUrl))}" .`,
    ...entries.flatMap((entry) => {
      const subject = `<${typeIndexUrl}#${entry.registrationId}>`;
      return [
        `${subject} a <http://www.w3.org/ns/solid/terms#TypeRegistration> .`,
        `${subject} <http://www.w3.org/ns/solid/terms#forClass> <${entry.rdfClass}> .`,
        `${subject} <http://www.w3.org/ns/solid/terms#instanceContainer> <${entry.instanceContainer}> .`,
        `${subject} <http://xmlns.com/foaf/0.1/name> "${escapeTurtleLiteral(entry.name)}" .`,
      ];
    }),
  ];

  return `INSERT DATA {\n  ${triples.join('\n  ')}\n}`;
}

export function buildProfileTypeIndexInsertData(input: {
  webId: string;
  podRoot: string;
  privateTypeIndex?: string;
  publicTypeIndex?: string;
}): string {
  if (!input.privateTypeIndex && !input.publicTypeIndex) {
    throw new Error('At least one TypeIndex URL is required.');
  }

  const triples = [
    'INSERT DATA {',
  ];
  if (input.privateTypeIndex) {
    triples.push(`  <${input.webId}> <http://www.w3.org/ns/solid/terms#privateTypeIndex> <${input.privateTypeIndex}> .`);
  }
  if (input.publicTypeIndex) {
    triples.push(`  <${input.webId}> <http://www.w3.org/ns/solid/terms#publicTypeIndex> <${input.publicTypeIndex}> .`);
  }
  triples.push(`  <${input.webId}> <http://www.w3.org/ns/solid/terms#storage> <${ensureTrailingSlash(input.podRoot)}> .`);
  triples.push('}');
  return triples.join('\n');
}
