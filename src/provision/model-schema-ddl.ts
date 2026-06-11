import { createRequire } from 'node:module';
import { Parser } from 'n3';
import { podSchema, type PodModelDescriptor, type PodModelFieldDescriptor } from '@undefineds.co/models';
import {
  type ModelTypeIndexEntry,
  type ModelTypeIndexScope,
  type ModelTypeIndexSource,
  buildModelTypeIndexJsonLdDocument,
  modelTypeIndexUrl,
  resolveModelTypeIndexEntries,
} from './model-type-index';

const requireFromHere = createRequire(__filename);

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SOLID_TYPE_REGISTRATION = 'http://www.w3.org/ns/solid/terms#TypeRegistration';
const SOLID_FOR_CLASS = 'http://www.w3.org/ns/solid/terms#forClass';
const SOLID_INSTANCE_CONTAINER = 'http://www.w3.org/ns/solid/terms#instanceContainer';
const SOLID_PRIVATE_TYPE_INDEX = 'http://www.w3.org/ns/solid/terms#privateTypeIndex';
const SOLID_PUBLIC_TYPE_INDEX = 'http://www.w3.org/ns/solid/terms#publicTypeIndex';
const SOLID_STORAGE = 'http://www.w3.org/ns/solid/terms#storage';
const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';

export interface ModelSchemaFieldCatalogEntry {
  name: string;
  predicate: string;
  type: PodModelFieldDescriptor['type'];
  required: boolean;
  secret: boolean;
  array: boolean;
  writable: boolean;
  description?: string;
}

export interface ModelSchemaCatalogEntry {
  name: string;
  resourceName: string;
  resourceKind: string;
  classUri: string;
  containerPath: string;
  instanceContainer: string;
  registrationId: string;
  schemaStatus: 'descriptor_available' | 'registration_only';
  schemaUri?: string;
  schemaVersion?: string;
  source?: PodModelDescriptor['source'];
  trustLevel?: PodModelDescriptor['trustLevel'];
  description?: string;
  fields?: ModelSchemaFieldCatalogEntry[];
  requiredFields: string[];
  secretFields: string[];
  writableFields: string[];
  storage?: PodModelDescriptor['storage'];
}

export interface ModelSchemaCatalog {
  packageName: '@undefineds.co/models';
  packageVersion?: string;
  podRoot: string;
  registrationSource: ModelTypeIndexSource;
  entries: ModelSchemaCatalogEntry[];
}

export interface ModelSchemaDdlOperation {
  method: 'PUT' | 'PUT_OR_PATCH' | 'PATCH';
  resourceUrl: string;
  whenMissing?: boolean;
  source: '@undefineds.co/models';
}

export interface ModelSchemaDdlPlan {
  kind: 'model_schema_apply';
  packageName: '@undefineds.co/models';
  packageVersion?: string;
  podRoot: string;
  scope: ModelTypeIndexScope;
  scopeSource: 'model_catalog' | 'operator_override' | 'default_private';
  typeIndexUrl: string;
  typeIndexJsonLd: ReturnType<typeof buildModelTypeIndexJsonLdDocument>;
  registrationSource: ModelTypeIndexSource;
  registrationCount: number;
  registrations: ModelTypeIndexEntry[];
  operations: ModelSchemaDdlOperation[];
  catalog: ModelSchemaCatalogEntry[];
  warnings: string[];
}

export interface ObservedTypeIndexRegistration {
  subject: string;
  rdfClass?: string;
  instanceContainer?: string;
  name?: string;
}

export interface ProfileTypeIndexLinks {
  privateTypeIndex: string[];
  publicTypeIndex: string[];
  storage: string[];
}

export interface ModelTypeIndexRegistrationDiff {
  ok: boolean;
  expectedCount: number;
  observedCount: number;
  matchingCount: number;
  missing: ModelTypeIndexEntry[];
  extra: ObservedTypeIndexRegistration[];
}

export interface ModelSchemaMigrationPlan {
  kind: 'model_schema_migrate';
  packageName: '@undefineds.co/models';
  packageVersion?: string;
  podRoot: string;
  supported: false;
  operations: [];
  reason: string;
  directive: string;
}

function readModelsPackageVersion(): string | undefined {
  try {
    const packageJson = requireFromHere('@undefineds.co/models/package.json') as { version?: string };
    return packageJson.version;
  } catch {
    return undefined;
  }
}

function containerUrlForResource(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  const path = url.pathname.endsWith('/')
    ? url.pathname
    : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  url.pathname = path || '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizeName(value: string): string {
  return value.replace(/Resource$/u, '').toLowerCase();
}

function resourceKindFromRegistration(entry: ModelTypeIndexEntry): string {
  return entry.resourceName.replace(/Resource$/u, '') || entry.name;
}

function descriptorForRegistration(entry: ModelTypeIndexEntry, descriptors: PodModelDescriptor[]): PodModelDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.class === entry.rdfClass) ??
    descriptors.find((descriptor) =>
      normalizeName(descriptor.resourceKind) === normalizeName(entry.name) ||
      normalizeName(descriptor.resourceKind) === normalizeName(entry.resourceName),
    );
}

function fieldCatalogEntries(descriptor: PodModelDescriptor): ModelSchemaFieldCatalogEntry[] {
  return Object.entries(descriptor.fields)
    .map(([ name, field ]) => ({
      name,
      predicate: field.predicate,
      type: field.type,
      required: field.required === true,
      secret: field.secret === true,
      array: field.array === true,
      writable: descriptor.writableFields.includes(name),
      ...(field.description ? { description: field.description } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function catalogEntryFromRegistration(entry: ModelTypeIndexEntry, descriptor?: PodModelDescriptor): ModelSchemaCatalogEntry {
  const fields = descriptor ? fieldCatalogEntries(descriptor) : undefined;
  return {
    name: entry.name,
    resourceName: entry.resourceName,
    resourceKind: descriptor?.resourceKind ?? resourceKindFromRegistration(entry),
    classUri: entry.rdfClass,
    containerPath: entry.containerPath,
    instanceContainer: entry.instanceContainer,
    registrationId: entry.registrationId,
    schemaStatus: descriptor ? 'descriptor_available' : 'registration_only',
    ...(descriptor ? {
      schemaUri: descriptor.uri,
      schemaVersion: descriptor.version,
      source: descriptor.source,
      trustLevel: descriptor.trustLevel,
      description: descriptor.description,
      fields,
      requiredFields: fields?.filter((field) => field.required).map((field) => field.name) ?? [],
      secretFields: fields?.filter((field) => field.secret).map((field) => field.name) ?? [],
      writableFields: descriptor.writableFields,
      storage: descriptor.storage,
    } : {
      requiredFields: [],
      secretFields: [],
      writableFields: [],
    }),
  };
}

export function buildModelSchemaCatalog(podRoot: string): ModelSchemaCatalog {
  const resolution = resolveModelTypeIndexEntries(podRoot);
  const descriptors = podSchema.list();
  return {
    packageName: '@undefineds.co/models',
    packageVersion: readModelsPackageVersion(),
    podRoot,
    registrationSource: resolution.source,
    entries: resolution.entries.map((entry) =>
      catalogEntryFromRegistration(entry, descriptorForRegistration(entry, descriptors))),
  };
}

export function findModelSchemaCatalogEntry(catalog: ModelSchemaCatalog, selector: string): ModelSchemaCatalogEntry | undefined {
  const normalized = selector.trim().toLowerCase();
  return catalog.entries.find((entry) =>
    entry.schemaUri?.toLowerCase() === normalized ||
    entry.resourceKind.toLowerCase() === normalized ||
    entry.resourceName.toLowerCase() === normalized ||
    entry.name.toLowerCase() === normalized ||
    entry.classUri.toLowerCase() === normalized ||
    entry.classUri.split(/[\/#]/u).filter(Boolean).pop()?.toLowerCase() === normalized,
  );
}

export function buildModelSchemaDdlPlan(input: {
  podRoot: string;
  scope?: ModelTypeIndexScope;
  scopeSource?: ModelSchemaDdlPlan['scopeSource'];
}): ModelSchemaDdlPlan {
  const scope = input.scope ?? 'private';
  const catalog = buildModelSchemaCatalog(input.podRoot);
  const registrationResolution = resolveModelTypeIndexEntries(input.podRoot);
  const typeIndexUrl = modelTypeIndexUrl(input.podRoot, scope);
  const warnings = [
    ...(catalog.entries.some((entry) => entry.schemaStatus === 'registration_only')
      ? [ 'Some registrations have no PodModelDescriptor compatibility metadata in this @undefineds.co/models version.' ]
      : []),
    ...(scope === 'public'
      ? [ 'Public scope links a public TypeIndex and marks it as solid:ListedDocument, but it does not change Pod ACL/ACP access policy.' ]
      : []),
  ];
  return {
    kind: 'model_schema_apply',
    packageName: '@undefineds.co/models',
    packageVersion: catalog.packageVersion,
    podRoot: catalog.podRoot,
    scope,
    scopeSource: input.scopeSource ?? (input.scope ? 'operator_override' : 'default_private'),
    typeIndexUrl,
    typeIndexJsonLd: buildModelTypeIndexJsonLdDocument(typeIndexUrl, registrationResolution.entries),
    registrationSource: catalog.registrationSource,
    registrationCount: catalog.entries.length,
    registrations: registrationResolution.entries,
    operations: [
      { method: 'PUT', resourceUrl: containerUrlForResource(typeIndexUrl), whenMissing: true, source: '@undefineds.co/models' },
      { method: 'PUT_OR_PATCH', resourceUrl: typeIndexUrl, source: '@undefineds.co/models' },
      { method: 'PATCH', resourceUrl: 'WEBID_PROFILE', source: '@undefineds.co/models' },
    ],
    catalog: catalog.entries,
    warnings,
  };
}

function registrationKey(input: { rdfClass?: string; instanceContainer?: string }): string | undefined {
  return input.rdfClass && input.instanceContainer ? `${input.rdfClass}\n${input.instanceContainer}` : undefined;
}

export function parseModelTypeIndexRegistrations(turtle: string, baseIRI: string): ObservedTypeIndexRegistration[] {
  const quads = new Parser({ baseIRI }).parse(turtle);
  const registrations = new Map<string, ObservedTypeIndexRegistration>();
  for (const quad of quads) {
    const subject = quad.subject.value;
    if (quad.predicate.value === RDF_TYPE && quad.object.value === SOLID_TYPE_REGISTRATION) {
      registrations.set(subject, registrations.get(subject) ?? { subject });
    }
    if (quad.predicate.value === SOLID_FOR_CLASS) {
      const existing = registrations.get(subject) ?? { subject };
      registrations.set(subject, {
        ...existing,
        rdfClass: quad.object.value,
      });
    }
    if (quad.predicate.value === SOLID_INSTANCE_CONTAINER) {
      const existing = registrations.get(subject) ?? { subject };
      registrations.set(subject, {
        ...existing,
        instanceContainer: quad.object.value,
      });
    }
    if (quad.predicate.value === FOAF_NAME) {
      const existing = registrations.get(subject) ?? { subject };
      registrations.set(subject, {
        ...existing,
        name: quad.object.value,
      });
    }
  }
  return Array.from(registrations.values()).sort((left, right) => left.subject.localeCompare(right.subject));
}

export function parseProfileTypeIndexLinks(turtle: string, baseIRI: string, webId: string): ProfileTypeIndexLinks {
  const quads = new Parser({ baseIRI }).parse(turtle);
  const links: ProfileTypeIndexLinks = {
    privateTypeIndex: [],
    publicTypeIndex: [],
    storage: [],
  };
  for (const quad of quads) {
    if (quad.subject.value !== webId) continue;
    if (quad.predicate.value === SOLID_PRIVATE_TYPE_INDEX) {
      links.privateTypeIndex.push(quad.object.value);
    }
    if (quad.predicate.value === SOLID_PUBLIC_TYPE_INDEX) {
      links.publicTypeIndex.push(quad.object.value);
    }
    if (quad.predicate.value === SOLID_STORAGE) {
      links.storage.push(quad.object.value);
    }
  }
  return {
    privateTypeIndex: Array.from(new Set(links.privateTypeIndex)).sort(),
    publicTypeIndex: Array.from(new Set(links.publicTypeIndex)).sort(),
    storage: Array.from(new Set(links.storage)).sort(),
  };
}

export function diffModelTypeIndexRegistrations(
  expected: readonly ModelTypeIndexEntry[],
  observed: readonly ObservedTypeIndexRegistration[],
): ModelTypeIndexRegistrationDiff {
  const observedByKey = new Map<string, ObservedTypeIndexRegistration>();
  for (const registration of observed) {
    const key = registrationKey(registration);
    if (key) {
      observedByKey.set(key, registration);
    }
  }

  const expectedKeys = new Set<string>();
  const missing: ModelTypeIndexEntry[] = [];
  let matchingCount = 0;
  for (const entry of expected) {
    const key = registrationKey({ rdfClass: entry.rdfClass, instanceContainer: entry.instanceContainer });
    if (!key) continue;
    expectedKeys.add(key);
    if (observedByKey.has(key)) {
      matchingCount += 1;
    } else {
      missing.push(entry);
    }
  }

  const extra = observed.filter((registration) => {
    const key = registrationKey(registration);
    return key ? !expectedKeys.has(key) : true;
  });

  return {
    ok: missing.length === 0,
    expectedCount: expected.length,
    observedCount: observed.length,
    matchingCount,
    missing,
    extra,
  };
}

export function buildModelSchemaMigrationPlan(podRoot: string): ModelSchemaMigrationPlan {
  return {
    kind: 'model_schema_migrate',
    packageName: '@undefineds.co/models',
    packageVersion: readModelsPackageVersion(),
    podRoot,
    supported: false,
    operations: [],
    reason: 'The installed @undefineds.co/models package does not export a schema migration plan API yet.',
    directive: 'Add migrations to @undefineds.co/models first; xpod schema migrate must execute that exported plan instead of inventing local schema changes.',
  };
}
