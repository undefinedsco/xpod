import type { Argv, CommandModule } from 'yargs';
import { readFileSync, writeFileSync } from 'fs';
import {
  createPodStorage,
  podSchema,
  type PodModelDescriptor,
  type PodModelFieldDescriptor,
  type PodStorageMutationPlan,
} from '@undefineds.co/models';
import { requireAuthContext, type CliAuthContext } from '../lib/auth-context';
import { CliCommandError, handleCliError, writeJsonItems, writeJsonResult } from '../lib/output';
import {
  type ModelTypeIndexEntry,
  buildModelTypeIndexInsertData,
  buildModelTypeIndexJsonLdDocument,
  buildProfileTypeIndexInsertData,
  modelPrivateTypeIndexUrl,
  renderModelTypeIndexTurtle,
  resolveModelTypeIndexEntries,
} from '../../provision/model-type-index';
import {
  ensureOk,
  fetchResource,
  readBodyFile,
  resolveResourceTarget,
  responseData,
} from '../lib/resource';
import { documentResourceInput, resolveSparqlEndpoint } from './rdf';

interface ObjArgs {
  url?: string;
  json: boolean;
}

interface ObjImportArgs extends ObjArgs {
  file: string;
  'dry-run'?: boolean;
  commit?: boolean;
}

interface ObjUpsertArgs extends ObjArgs {
  schema: string;
  from: string;
  'dry-run'?: boolean;
  commit?: boolean;
}

interface ObjRegisterArgs extends ObjArgs {
  'pod-root'?: string;
  'type-index'?: string;
  'dry-run'?: boolean;
  commit?: boolean;
}

interface ObjSelectorArgs extends ObjArgs {
  selector?: string;
  schema?: string;
  subject?: string;
  resource?: string;
  path?: string;
  where?: string;
  status?: string;
  relation?: string[];
  format: string;
  out?: string;
  limit: number;
  since?: string;
  'include-metadata': boolean;
}

interface ObjGetArgs extends ObjArgs {
  schema?: string;
  subject: string;
  out?: string;
  'include-metadata': boolean;
}

interface ObjPatchArgs extends ObjArgs {
  schema?: string;
  subject: string;
  set: string;
  'if-match'?: string;
  'dry-run'?: boolean;
  commit?: boolean;
}

interface ObjLinkArgs extends ObjArgs {
  schema?: string;
  subject: string;
  predicate: string;
  object: string;
  'if-match'?: string;
  'dry-run'?: boolean;
  commit?: boolean;
}

interface ObjDeleteArgs extends ObjArgs {
  schema?: string;
  subject: string;
  'if-match'?: string;
  'dry-run'?: boolean;
  commit?: boolean;
}

interface ObjMutationRow {
  op?: string;
  schema?: string;
  match?: Record<string, unknown>;
  set?: Record<string, unknown>;
  subject?: string;
  path?: string;
  resource?: string;
  predicate?: string;
  object?: string;
  ifMatch?: string;
  body?: string;
  from?: string;
  contentType?: string;
}

interface ResolvedObjSelector {
  descriptor: PodModelDescriptor;
  subject?: string;
  resourceUrl?: string;
  where: Record<string, unknown>;
  relations: Record<string, string>;
  limit: number;
  includeMetadata: boolean;
}

interface DescriptorObject {
  schema: string;
  subject: string;
  resourceUrl: string;
  etag?: string | null;
  revision?: string | null;
  object: Record<string, unknown>;
}

type SparqlBinding = {
  type?: string;
  value?: string;
  datatype?: string;
};

type ItemResult = {
  index: number;
  ok: boolean;
  code: string;
  message?: string;
  [key: string]: unknown;
};

function objOptions<T>(yargs: Argv): Argv<T> {
  return yargs
    .option('url', {
      alias: 'u',
      type: 'string',
      description: 'Server base URL override',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      description: 'Output JSON envelope',
    }) as unknown as Argv<T>;
}

function selectorOptions<T extends ObjSelectorArgs>(yargs: Argv): Argv<T> {
  return objOptions<T>(yargs)
    .option('schema', { type: 'string', description: 'Schema URI or descriptor alias' })
    .option('subject', { type: 'string', description: 'Exact object subject URI or Pod-relative subject' })
    .option('resource', { type: 'string', description: 'Exact RDF document/resource URI or Pod-relative path' })
    .option('path', { type: 'string', description: 'Pod-relative resource path' })
    .option('where', { type: 'string', description: 'JSON object of descriptor field filters' })
    .option('status', { type: 'string', description: 'Shortcut for --where {"status": "..."} when the descriptor has a status field' })
    .option('relation', { type: 'array', string: true, description: 'Descriptor URI relation filter, field=uri. Repeatable.' })
    .option('limit', { type: 'number', default: 100, description: 'Maximum number of rows' })
    .option('include-metadata', { type: 'boolean', default: true, description: 'Include etag/revision metadata when available' }) as unknown as Argv<T>;
}

function mutationModeCheck(argv: { 'dry-run'?: boolean; commit?: boolean }): true {
  if (argv['dry-run'] === argv.commit) {
    throw new Error('Specify exactly one of --dry-run or --commit.');
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Expected a JSON object.');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliCommandError(code, message, 2);
  }
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readTextInput(input: string): Promise<string> {
  return input === '-' ? readStdinText() : readFileSync(input, 'utf-8');
}

async function readJsonl(input: string): Promise<ObjMutationRow[]> {
  return (await readTextInput(input))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          throw new Error('Expected a JSON object.');
        }
        return parsed as ObjMutationRow;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliCommandError('invalid_jsonl', `Invalid JSONL at line ${index + 1}: ${message}`, 2);
      }
    });
}

function descriptorLocalName(value: string): string {
  return value.split(/[\/#]/u).filter(Boolean).pop() ?? value;
}

function resolveDescriptorOrNull(schema: string): PodModelDescriptor | null {
  const exact = podSchema.describe({ schemaUri: schema });
  if (exact) return exact;

  const normalized = schema.trim().toLowerCase();
  return podSchema.list().find((descriptor) =>
    descriptor.resourceKind.toLowerCase() === normalized ||
    descriptorLocalName(descriptor.uri).toLowerCase() === normalized ||
    descriptorLocalName(descriptor.class).toLowerCase() === normalized,
  ) ?? null;
}

function resolveDescriptor(schema: string): PodModelDescriptor {
  const descriptor = resolveDescriptorOrNull(schema);
  if (!descriptor) {
    throw new CliCommandError('schema_unknown', `Schema is not known by @undefineds.co/models: ${schema}`, 2);
  }
  return descriptor;
}

function resourceUrlFromPlan(podRoot: string, plan: PodStorageMutationPlan): string {
  return new URL(plan.resourceUri.replace(/^\/+/, ''), podRoot).toString();
}

function varName(field: string): string {
  return `v_${field.replace(/[^A-Za-z0-9_]/gu, '_')}`;
}

function fieldVar(field: string): string {
  return `?${varName(field)}`;
}

function sparqlIri(value: string): string {
  if (!/^https?:\/\//iu.test(value)) {
    throw new CliCommandError('invalid_uri', `Expected an absolute URI: ${value}`, 2);
  }
  return `<${value.replace(/[<>]/gu, '')}>`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function resolvePodRootOption(context: CliAuthContext, podRoot?: string): string {
  if (!podRoot) {
    return ensureTrailingSlash(context.podRoot);
  }
  const resolved = /^https?:\/\//iu.test(podRoot)
    ? new URL(podRoot).toString()
    : resolveResourceTarget(context, podRoot).resourceUrl;
  return ensureTrailingSlash(resolved);
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

function sparqlValue(value: unknown, field?: PodModelFieldDescriptor): string {
  if (field?.type === 'uri') {
    if (typeof value !== 'string') {
      throw new CliCommandError('invalid_uri', `Field expects a URI value: ${String(value)}`, 2);
    }
    return sparqlIri(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (field?.type === 'json') {
    return JSON.stringify(JSON.stringify(value));
  }
  return JSON.stringify(String(value));
}

function assertKnownFields(descriptor: PodModelDescriptor, values: Record<string, unknown>, code = 'field_unknown'): void {
  const unknown = Object.keys(values).filter((field) => !descriptor.fields[field]);
  if (unknown.length > 0) {
    throw new CliCommandError(code, `Fields are not known by descriptor ${descriptor.uri}: ${unknown.join(', ')}`, 2);
  }
}

function assertWritableFields(descriptor: PodModelDescriptor, values: Record<string, unknown>): void {
  assertKnownFields(descriptor, values);
  const invalid = Object.keys(values).filter((field) => !descriptor.writableFields.includes(field));
  if (invalid.length > 0) {
    throw new CliCommandError('invalid_set_fields', `Fields are not writable: ${invalid.join(', ')}`, 2);
  }
}

export function redactDescriptorObject(descriptor: PodModelDescriptor, value: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [ key, item ] of Object.entries(value)) {
    redacted[key] = descriptor.fields[key]?.secret ? '[redacted]' : item;
  }
  return redacted;
}

export function buildDescriptorUpsertSparql(descriptor: PodModelDescriptor, subject: string, row: ObjMutationRow): string {
  const fields = descriptor.fields;
  const match = row.match ?? {};
  const set = row.set ?? {};
  assertKnownFields(descriptor, match);
  assertWritableFields(descriptor, set);

  const merged = { ...match, ...set };
  const deleteFields = Object.keys(set).filter((field) => fields[field]);
  const deletes = deleteFields.map((field) =>
    `<${subject}> <${fields[field].predicate}> ?old_${field.replace(/[^A-Za-z0-9_]/gu, '_')} .`,
  );
  const optionals = deleteFields.map((field) =>
    `OPTIONAL { <${subject}> <${fields[field].predicate}> ?old_${field.replace(/[^A-Za-z0-9_]/gu, '_')} }`,
  );
  const inserts = [
    `<${subject}> a <${descriptor.class}>`,
    ...Object.entries(merged)
      .filter(([ field, value ]) => fields[field] && value !== undefined && value !== null)
      .map(([ field, value ]) => `<${subject}> <${fields[field].predicate}> ${sparqlValue(value, fields[field])}`),
  ];

  return `DELETE {\n  ${deletes.join('\n  ')}\n}\nINSERT {\n  ${inserts.join(' .\n  ')} .\n}\nWHERE {\n  ${optionals.join('\n  ')}\n}`;
}

export function buildDescriptorPatchSparql(descriptor: PodModelDescriptor, subject: string, set: Record<string, unknown>): string {
  return buildDescriptorUpsertSparql(descriptor, subject, { set });
}

export function buildDescriptorLinkSparql(subject: string, predicate: string, object: string): string {
  return `INSERT DATA {\n  <${subject}> <${predicate}> ${sparqlIri(object)} .\n}`;
}

export function buildDescriptorDeleteSparql(subject: string): string {
  return `DELETE {\n  <${subject}> ?p ?o .\n}\nWHERE {\n  <${subject}> ?p ?o .\n}`;
}

function parseWhere(where?: string): Record<string, unknown> {
  return where ? parseJsonObject(where, 'invalid_where') : {};
}

export function extractReservedWhereSelectors(where: Record<string, unknown>): {
  where: Record<string, unknown>;
  subject?: string;
  resource?: string;
  path?: string;
} {
  const filters = { ...where };
  const selectors: { subject?: string; resource?: string; path?: string } = {};

  for (const key of [ 'subject', 'resource', 'path' ] as const) {
    const value = filters[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new CliCommandError('invalid_where', `Reserved selector field "${key}" must be a string.`, 2);
    }
    selectors[key] = value;
    delete filters[key];
  }

  return { where: filters, ...selectors };
}

function applyReservedSelector(
  current: string | undefined,
  reserved: string | undefined,
  key: 'subject' | 'resource' | 'path',
): string | undefined {
  if (!reserved) return current;
  if (current && current !== reserved) {
    throw new CliCommandError('selector_conflict', `Conflicting ${key} selectors were provided.`, 2);
  }
  return reserved;
}

function parseRelations(input?: string[]): Record<string, string> {
  const relations: Record<string, string> = {};
  for (const item of input ?? []) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      const parsed = parseJsonObject(trimmed, 'invalid_relation');
      for (const [ key, value ] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
          throw new CliCommandError('invalid_relation', `Relation filter ${key} must be a URI string.`, 2);
        }
        relations[key] = value;
      }
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new CliCommandError('invalid_relation', `Relation filter must be field=uri: ${trimmed}`, 2);
    }
    relations[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return relations;
}

function classifySelector(selector: string): 'schema' | 'subject' | 'resource' | 'path' {
  if (resolveDescriptorOrNull(selector)) return 'schema';
  if (selector.includes('#')) return 'subject';
  if (/^https?:\/\//iu.test(selector)) return 'resource';
  if (selector.includes('/')) return 'path';
  return 'schema';
}

async function inferDescriptorForSubject(context: CliAuthContext, subject: string): Promise<PodModelDescriptor> {
  const target = resolveResourceTarget(context, documentResourceInput(subject));
  const response = await fetchResource(context, target, {
    method: 'GET',
    headers: { Accept: 'text/turtle' },
  });
  ensureOk(response, response.status === 404 ? 'resource_not_found' : 'schema_infer_failed', `Failed to infer schema from ${subject}`);
  const body = await response.text();
  const matches = podSchema.list().filter((descriptor) => body.includes(`<${descriptor.class}>`));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new CliCommandError('schema_ambiguous', 'Multiple known descriptor classes were found. Re-run with --schema.', 2, {
      schemas: matches.map((descriptor) => descriptor.uri),
    });
  }
  throw new CliCommandError('schema_required', 'Could not infer a known schema from the subject document. Re-run with --schema.', 2);
}

async function resolveObjectSelector(context: CliAuthContext, argv: ObjSelectorArgs): Promise<ResolvedObjSelector> {
  let schema = argv.schema;
  let subject = argv.subject;
  let resource = argv.resource;
  let path = argv.path;

  if (argv.selector) {
    const kind = classifySelector(argv.selector);
    if (kind === 'schema' && !schema) schema = argv.selector;
    if (kind === 'subject' && !subject) subject = argv.selector;
    if (kind === 'resource' && !resource) resource = argv.selector;
    if (kind === 'path' && !path) path = argv.selector;
  }

  const parsedWhere = parseWhere(argv.where);
  if (argv.status !== undefined) {
    parsedWhere.status = argv.status;
  }
  const {
    where,
    subject: whereSubject,
    resource: whereResource,
    path: wherePath,
  } = extractReservedWhereSelectors(parsedWhere);

  subject = applyReservedSelector(subject, whereSubject, 'subject');
  resource = applyReservedSelector(resource, whereResource, 'resource');
  path = applyReservedSelector(path, wherePath, 'path');

  const subjectUrl = subject ? resolveResourceTarget(context, subject).resourceUrl : undefined;
  const resourceUrl = resource
    ? resolveResourceTarget(context, documentResourceInput(resource)).resourceUrl
    : path
      ? resolveResourceTarget(context, documentResourceInput(path)).resourceUrl
      : subjectUrl
        ? documentResourceInput(subjectUrl)
        : undefined;

  const descriptor = schema
    ? resolveDescriptor(schema)
    : subjectUrl
      ? await inferDescriptorForSubject(context, subjectUrl)
      : undefined;

  if (!descriptor) {
    throw new CliCommandError('schema_required', 'Object selectors require --schema, a schema selector, or an exact subject with an inferable RDF type.', 2);
  }

  return {
    descriptor,
    subject: subjectUrl,
    resourceUrl,
    where,
    relations: parseRelations(argv.relation),
    limit: Math.max(1, Math.min(argv.limit || 100, 10000)),
    includeMetadata: argv['include-metadata'] !== false,
  };
}

function queryFilterTerm(field: PodModelFieldDescriptor, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => sparqlValue(item, field)).join(' ');
  }
  return sparqlValue(value, field);
}

export function buildDescriptorObjectQuery(selector: ResolvedObjSelector): string {
  const descriptor = selector.descriptor;
  assertKnownFields(descriptor, selector.where);

  const triples = [ `?subject a <${descriptor.class}> .` ];
  if (selector.subject) {
    triples.push(`VALUES ?subject { <${selector.subject}> }`);
  }
  if (selector.resourceUrl) {
    triples.push(`FILTER(STR(?subject) = ${JSON.stringify(selector.resourceUrl)} || STRSTARTS(STR(?subject), ${JSON.stringify(`${selector.resourceUrl}#`)}))`);
  }

  for (const [ field, fieldDescriptor ] of Object.entries(descriptor.fields)) {
    triples.push(`OPTIONAL { ?subject <${fieldDescriptor.predicate}> ${fieldVar(field)} . }`);
  }

  for (const [ field, value ] of Object.entries(selector.where)) {
    const descriptorField = descriptor.fields[field];
    if (!descriptorField) continue;
    if (Array.isArray(value)) {
      triples.push(`VALUES ${fieldVar(`filter_${field}`)} { ${queryFilterTerm(descriptorField, value)} }`);
      triples.push(`?subject <${descriptorField.predicate}> ${fieldVar(`filter_${field}`)} .`);
    } else {
      triples.push(`?subject <${descriptorField.predicate}> ${queryFilterTerm(descriptorField, value)} .`);
    }
  }

  for (const [ field, objectUri ] of Object.entries(selector.relations)) {
    const descriptorField = descriptor.fields[field];
    if (!descriptorField) {
      throw new CliCommandError('predicate_unknown', `Relation field is not known by descriptor ${descriptor.uri}: ${field}`, 2);
    }
    if (descriptorField.type !== 'uri') {
      throw new CliCommandError('relation_field_not_uri', `Relation field is not URI-valued: ${field}`, 2);
    }
    triples.push(`?subject <${descriptorField.predicate}> ${sparqlIri(objectUri)} .`);
  }

  const fieldVars = Object.keys(descriptor.fields).map(fieldVar).join(' ');
  return `SELECT ?subject ${fieldVars} WHERE {\n  ${triples.join('\n  ')}\n}\nLIMIT ${selector.limit}`;
}

function bindingToValue(binding: SparqlBinding | undefined, field: PodModelFieldDescriptor): unknown {
  if (!binding?.value) return undefined;
  if (binding.type === 'uri') return binding.value;
  if (field.type === 'number') {
    const number = Number(binding.value);
    return Number.isNaN(number) ? binding.value : number;
  }
  if (field.type === 'boolean') {
    return binding.value === 'true' || binding.value === '1';
  }
  if (field.type === 'json') {
    try {
      return JSON.parse(binding.value);
    } catch {
      return binding.value;
    }
  }
  return binding.value;
}

async function applyEtags(context: CliAuthContext, objects: DescriptorObject[]): Promise<void> {
  const cache = new Map<string, string | null>();
  for (const object of objects) {
    if (!cache.has(object.resourceUrl)) {
      try {
        const target = resolveResourceTarget(context, object.resourceUrl);
        const response = await fetchResource(context, target, { method: 'HEAD' });
        cache.set(object.resourceUrl, response.ok ? response.headers.get('etag') : null);
      } catch {
        cache.set(object.resourceUrl, null);
      }
    }
    const etag = cache.get(object.resourceUrl) ?? null;
    object.etag = etag;
    object.revision = etag;
  }
}

async function queryDescriptorObjects(context: CliAuthContext, selector: ResolvedObjSelector): Promise<DescriptorObject[]> {
  const endpoint = resolveSparqlEndpoint(context.podRoot);
  const query = buildDescriptorObjectQuery(selector);
  const response = await fetchResource(context, {
    input: endpoint,
    resourceUrl: endpoint,
    webId: context.webId,
    podRoot: context.podRoot,
    baseIri: context.baseIri,
  }, {
    method: 'POST',
    headers: {
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/sparql-query',
    },
    body: query,
  });
  ensureOk(response, 'obj_query_failed', `Failed to list objects for ${selector.descriptor.uri}`);
  const result = (await response.json()) as {
    results?: { bindings?: Array<Record<string, SparqlBinding>> };
  };

  const objects = (result.results?.bindings ?? []).flatMap((binding) => {
    const subject = binding.subject?.value;
    if (!subject) return [];
    const object: Record<string, unknown> = {};
    for (const [ field, descriptorField ] of Object.entries(selector.descriptor.fields)) {
      const value = bindingToValue(binding[varName(field)], descriptorField);
      if (value !== undefined) {
        object[field] = descriptorField.secret ? '[redacted]' : value;
      }
    }
    return [{
      schema: selector.descriptor.uri,
      subject,
      resourceUrl: documentResourceInput(subject),
      object,
    }];
  });

  if (selector.includeMetadata) {
    await applyEtags(context, objects);
  }
  return objects;
}

function jsonlForObjects(objects: DescriptorObject[]): string {
  return `${objects.map((object, index) => JSON.stringify({
    index,
    ok: true,
    code: 'ok',
    ...object,
  })).join('\n')}${objects.length > 0 ? '\n' : ''}`;
}

async function patchSubject(input: {
  context: CliAuthContext;
  subject: string;
  sparql: string;
  ifMatch?: string;
  errorCode: string;
}): Promise<ReturnType<typeof responseData>> {
  const target = resolveResourceTarget(input.context, documentResourceInput(input.subject));
  const headers: Record<string, string> = { 'Content-Type': 'application/sparql-update' };
  if (input.ifMatch) headers['If-Match'] = input.ifMatch;
  const response = await fetchResource(input.context, target, {
    method: 'PATCH',
    headers,
    body: input.sparql,
  });
  ensureOk(response, input.errorCode, `Failed to patch object ${input.subject}`);
  return responseData(target, response);
}

function mutationPlan(input: {
  operationId: string;
  context: CliAuthContext;
  summary: string;
  subject: string;
  schema?: string;
  etag?: string;
  change: string;
  diff?: unknown[];
}): Record<string, unknown> {
  return {
    operationId: input.operationId,
    webId: input.context.webId,
    podRoot: input.context.podRoot,
    summary: input.summary,
    risk: 'normal',
    resources: [
      {
        subject: input.subject,
        schema: input.schema,
        etag: input.etag,
        change: input.change,
      },
    ],
    diff: input.diff ?? [],
  };
}

async function resolveDescriptorForMutation(context: CliAuthContext, schema: string | undefined, subject: string): Promise<PodModelDescriptor> {
  return schema ? resolveDescriptor(schema) : inferDescriptorForSubject(context, subject);
}

async function executePatchCommand(argv: ObjPatchArgs): Promise<Record<string, unknown>> {
  const context = await requireAuthContext(argv);
  const subject = resolveResourceTarget(context, argv.subject).resourceUrl;
  const descriptor = await resolveDescriptorForMutation(context, argv.schema, subject);
  const set = parseJsonObject(argv.set, 'invalid_set');
  const sparql = buildDescriptorPatchSparql(descriptor, subject, set);
  const plan = mutationPlan({
    operationId: `op_patch_${Date.now()}`,
    context,
    summary: `Patch one descriptor-backed ${descriptor.resourceKind}`,
    subject,
    schema: descriptor.uri,
    etag: argv['if-match'],
    change: 'patch',
    diff: [ redactDescriptorObject(descriptor, set) ],
  });
  if (argv['dry-run']) {
    return { plan };
  }
  const response = await patchSubject({
    context,
    subject,
    sparql,
    ifMatch: argv['if-match'],
    errorCode: 'obj_patch_failed',
  });
  return { ...response, plan };
}

async function executeLinkCommand(argv: ObjLinkArgs): Promise<Record<string, unknown>> {
  const context = await requireAuthContext(argv);
  const subject = resolveResourceTarget(context, argv.subject).resourceUrl;
  const descriptor = argv.schema || !/^https?:\/\//iu.test(argv.predicate)
    ? await resolveDescriptorForMutation(context, argv.schema, subject)
    : undefined;
  let predicate = argv.predicate;
  if (!/^https?:\/\//iu.test(predicate)) {
    if (!descriptor?.fields[predicate]) {
      throw new CliCommandError('predicate_unknown', `Predicate field is not known by descriptor: ${predicate}`, 2);
    }
    const field = descriptor.fields[predicate];
    if (field.type !== 'uri') {
      throw new CliCommandError('relation_field_not_uri', `Relation field is not URI-valued: ${predicate}`, 2);
    }
    predicate = field.predicate;
  }
  const sparql = buildDescriptorLinkSparql(subject, predicate, argv.object);
  const plan = mutationPlan({
    operationId: `op_link_${Date.now()}`,
    context,
    summary: 'Link one descriptor-backed object relation',
    subject,
    schema: descriptor?.uri,
    etag: argv['if-match'],
    change: 'link',
    diff: [{ predicate, object: argv.object }],
  });
  if (argv['dry-run']) {
    return { plan };
  }
  const response = await patchSubject({
    context,
    subject,
    sparql,
    ifMatch: argv['if-match'],
    errorCode: 'obj_link_failed',
  });
  return { ...response, plan };
}

async function executeDeleteCommand(argv: ObjDeleteArgs): Promise<Record<string, unknown>> {
  const context = await requireAuthContext(argv);
  const subject = resolveResourceTarget(context, argv.subject).resourceUrl;
  const descriptor = await resolveDescriptorForMutation(context, argv.schema, subject);
  const sparql = buildDescriptorDeleteSparql(subject);
  const plan = mutationPlan({
    operationId: `op_delete_${Date.now()}`,
    context,
    summary: `Delete one descriptor-backed ${descriptor.resourceKind}`,
    subject,
    schema: descriptor.uri,
    etag: argv['if-match'],
    change: 'delete',
  });
  if (argv['dry-run']) {
    return { plan };
  }
  const response = await patchSubject({
    context,
    subject,
    sparql,
    ifMatch: argv['if-match'],
    errorCode: 'obj_delete_failed',
  });
  return { ...response, plan };
}

async function executeRawRow(context: CliAuthContext, row: ObjMutationRow, index: number, commit: boolean): Promise<ItemResult> {
  const op = row.op;
  if (!op) {
    throw new CliCommandError('schema_required', 'JSONL row without schema must declare an explicit raw resource op.', 2);
  }
  const targetInput = row.path ?? row.resource ?? row.subject;
  if (!targetInput) {
    throw new CliCommandError('explicit_target_required', 'Raw JSONL rows must declare path, resource, or subject.', 2);
  }
  const target = resolveResourceTarget(context, row.subject ? documentResourceInput(targetInput) : targetInput);
  if (!commit) {
    return {
      index,
      ok: true,
      code: 'plan_ready',
      operation: op,
      resourceUrl: target.resourceUrl,
      webId: context.webId,
      podRoot: context.podRoot,
    };
  }
  if (![ 'put', 'patch', 'delete' ].includes(op)) {
    throw new CliCommandError('unsupported_operation', `Unsupported raw JSONL operation: ${op}`, 2);
  }

  const headers: Record<string, string> = {};
  let body: Buffer | string | undefined;
  if (op !== 'delete') {
    if (row.from) {
      const file = readBodyFile(row.from);
      body = file.body;
      headers['Content-Type'] = row.contentType ?? file.contentType;
    } else if (row.body !== undefined) {
      body = row.body;
      headers['Content-Type'] = row.contentType ?? 'text/plain';
    } else {
      throw new CliCommandError('body_required', `Raw ${op} rows require body or from.`, 2);
    }
  }
  if (row.ifMatch) headers['If-Match'] = row.ifMatch;

  const response = await fetchResource(context, target, {
    method: op.toUpperCase(),
    headers,
    body,
  });
  ensureOk(response, 'raw_commit_failed', `Failed to commit raw row ${index}`);
  return {
    index,
    ok: true,
    code: 'committed',
    operation: op,
    ...responseData(target, response),
  };
}

async function executeDescriptorRow(context: CliAuthContext, row: ObjMutationRow, index: number, commit: boolean): Promise<ItemResult> {
  const descriptor = resolveDescriptor(row.schema!);
  const op = row.op ?? 'upsert';
  if (op !== 'upsert') {
    if (!row.subject) {
      throw new CliCommandError('subject_required', `Object operation ${op} requires subject.`, 2);
    }
    const subject = resolveResourceTarget(context, row.subject).resourceUrl;
    if (op === 'patch') {
      const set = row.set ?? {};
      const sparql = buildDescriptorPatchSparql(descriptor, subject, set);
      if (commit) {
        await patchSubject({ context, subject, sparql, ifMatch: row.ifMatch, errorCode: 'obj_patch_failed' });
      }
      return {
        index,
        ok: true,
        code: commit ? 'committed' : 'plan_ready',
        operation: op,
        schema: descriptor.uri,
        subject,
        set: redactDescriptorObject(descriptor, set),
      };
    }
    if (op === 'link') {
      if (!row.predicate || !row.object) {
        throw new CliCommandError('link_target_required', 'Link rows require predicate and object.', 2);
      }
      const field = descriptor.fields[row.predicate];
      const predicate = field ? field.predicate : row.predicate;
      if (field && field.type !== 'uri') {
        throw new CliCommandError('relation_field_not_uri', `Relation field is not URI-valued: ${row.predicate}`, 2);
      }
      if (!field && !/^https?:\/\//iu.test(predicate)) {
        throw new CliCommandError('predicate_unknown', `Predicate field is not known by descriptor: ${row.predicate}`, 2);
      }
      const sparql = buildDescriptorLinkSparql(subject, predicate, row.object);
      if (commit) {
        await patchSubject({ context, subject, sparql, ifMatch: row.ifMatch, errorCode: 'obj_link_failed' });
      }
      return {
        index,
        ok: true,
        code: commit ? 'committed' : 'plan_ready',
        operation: op,
        schema: descriptor.uri,
        subject,
        predicate,
        object: row.object,
      };
    }
    if (op === 'delete') {
      const sparql = buildDescriptorDeleteSparql(subject);
      if (commit) {
        await patchSubject({ context, subject, sparql, ifMatch: row.ifMatch, errorCode: 'obj_delete_failed' });
      }
      return {
        index,
        ok: true,
        code: commit ? 'committed' : 'plan_ready',
        operation: op,
        schema: descriptor.uri,
        subject,
      };
    }
    throw new CliCommandError('unsupported_operation', `Unsupported object operation: ${op}`, 2);
  }

  const storage = createPodStorage();
  const validation = storage.validate({
    schemaUri: descriptor.uri,
    operation: 'upsert',
    match: row.match ?? {},
    set: row.set ?? {},
  });
  if (!validation.ok) {
    throw new CliCommandError(validation.error.code, validation.error.message, 2);
  }

  const subject = resourceUrlFromPlan(context.podRoot, validation.plan);
  if (commit) {
    const sparql = buildDescriptorUpsertSparql(descriptor, subject, row);
    await patchSubject({ context, subject, sparql, ifMatch: row.ifMatch, errorCode: 'obj_commit_failed' });
  }

  return {
    index,
    ok: true,
    code: commit ? 'committed' : 'plan_ready',
    operation: op,
    schema: descriptor.uri,
    subject,
    resourceUrl: documentResourceInput(subject),
    planId: validation.plan.id,
    match: redactDescriptorObject(descriptor, row.match ?? {}),
    set: redactDescriptorObject(descriptor, row.set ?? {}),
  };
}

async function executeRows(input: {
  argv: ObjArgs;
  rows: ObjMutationRow[];
  defaultSchema?: string;
  commit: boolean;
}): Promise<ItemResult[]> {
  const context = await requireAuthContext(input.argv);
  const items: ItemResult[] = [];
  for (const [ index, originalRow ] of input.rows.entries()) {
    const row = {
      ...originalRow,
      schema: originalRow.schema ?? input.defaultSchema,
    };
    try {
      const item = row.schema
        ? await executeDescriptorRow(context, row, index, input.commit)
        : await executeRawRow(context, row, index, input.commit);
      items.push(item);
    } catch (error) {
      const err = error instanceof CliCommandError
        ? error
        : new CliCommandError('error', error instanceof Error ? error.message : String(error));
      items.push({ index, ok: false, code: err.code, message: err.message });
    }
  }
  return items;
}

async function ensureContainerResource(context: CliAuthContext, containerUrl: string): Promise<Record<string, unknown>> {
  const target = resolveResourceTarget(context, ensureTrailingSlash(containerUrl));
  const head = await fetchResource(context, target, { method: 'HEAD' });
  if (head.ok) {
    return {
      action: 'already_exists',
      ...responseData(target, head),
    };
  }
  if (head.status !== 404) {
    ensureOk(head, 'container_check_failed', `Failed to check container ${containerUrl}`);
  }

  const created = await fetchResource(context, target, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });
  ensureOk(created, 'container_create_failed', `Failed to create container ${containerUrl}`);
  return {
    action: 'created',
    ...responseData(target, created),
  };
}

async function writeOrPatchTypeIndex(input: {
  context: CliAuthContext;
  typeIndexUrl: string;
  entries: ModelTypeIndexEntry[];
}): Promise<Record<string, unknown>> {
  const target = resolveResourceTarget(input.context, input.typeIndexUrl);
  const head = await fetchResource(input.context, target, { method: 'HEAD' });
  if (head.ok) {
    const patch = await fetchResource(input.context, target, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: buildModelTypeIndexInsertData(input.typeIndexUrl, input.entries),
    });
    ensureOk(patch, 'type_index_patch_failed', `Failed to patch TypeIndex ${input.typeIndexUrl}`);
    return {
      action: 'patched',
      ...responseData(target, patch),
    };
  }
  if (head.status !== 404) {
    ensureOk(head, 'type_index_check_failed', `Failed to check TypeIndex ${input.typeIndexUrl}`);
  }

  const created = await fetchResource(input.context, target, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: renderModelTypeIndexTurtle(input.entries),
  });
  ensureOk(created, 'type_index_create_failed', `Failed to create TypeIndex ${input.typeIndexUrl}`);
  return {
    action: 'created',
    ...responseData(target, created),
  };
}

async function patchProfileTypeIndex(input: {
  context: CliAuthContext;
  podRoot: string;
  typeIndexUrl: string;
}): Promise<Record<string, unknown>> {
  const target = resolveResourceTarget(input.context, documentResourceInput(input.context.webId));
  const response = await fetchResource(input.context, target, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/sparql-update' },
    body: buildProfileTypeIndexInsertData({
      webId: input.context.webId,
      podRoot: input.podRoot,
      privateTypeIndex: input.typeIndexUrl,
    }),
  });
  ensureOk(response, 'profile_patch_failed', `Failed to link TypeIndex from profile ${input.context.webId}`);
  return {
    action: 'patched',
    ...responseData(target, response),
  };
}

async function executeRegisterCommand(argv: ObjRegisterArgs): Promise<Record<string, unknown>> {
  const context = await requireAuthContext(argv);
  const podRoot = resolvePodRootOption(context, argv['pod-root']);
  const privateTypeIndex = argv['type-index']
    ? resolveResourceTarget({ ...context, podRoot, baseIri: podRoot }, argv['type-index']).resourceUrl
    : modelPrivateTypeIndexUrl(podRoot);
  const registrationResolution = resolveModelTypeIndexEntries(podRoot);
  const entries = registrationResolution.entries;
  const typeIndexContainer = containerUrlForResource(privateTypeIndex);

  const plan = {
    webId: context.webId,
    podRoot,
    privateTypeIndex,
    registrationSource: registrationResolution.source,
    registrations: entries,
    typeIndexJsonLd: buildModelTypeIndexJsonLdDocument(privateTypeIndex, entries),
    operations: [
      { method: 'PUT', resourceUrl: typeIndexContainer, whenMissing: true },
      { method: 'PUT_OR_PATCH', resourceUrl: privateTypeIndex },
      { method: 'PATCH', resourceUrl: documentResourceInput(context.webId) },
    ],
  };

  if (argv['dry-run']) {
    return { plan };
  }

  const operations = [
    await ensureContainerResource(context, typeIndexContainer),
    await writeOrPatchTypeIndex({ context, typeIndexUrl: privateTypeIndex, entries }),
    await patchProfileTypeIndex({ context, podRoot, typeIndexUrl: privateTypeIndex }),
  ];

  return {
    webId: context.webId,
    podRoot,
    privateTypeIndex,
    registrationSource: registrationResolution.source,
    registrationCount: entries.length,
    registrations: entries,
    operations,
  };
}

function printItems(items: ItemResult[]): void {
  for (const item of items) {
    console.log(`${item.index}\t${item.ok ? item.code : `ERROR ${item.code}`}\t${String(item.subject ?? item.resourceUrl ?? item.message ?? '')}`);
  }
}

const importCommand: CommandModule<object, ObjImportArgs> = {
  command: 'import <file>',
  describe: 'Import descriptor-backed or explicit raw JSONL rows',
  builder: (yargs) =>
    objOptions<ObjImportArgs>(yargs)
      .positional('file', { type: 'string', demandOption: true, description: 'JSONL file to import, or - for stdin' })
      .option('dry-run', { type: 'boolean', description: 'Validate and print a plan without writing' })
      .option('commit', { type: 'boolean', description: 'Commit the validated mutations' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const items = await executeRows({
        argv,
        rows: await readJsonl(argv.file),
        commit: argv.commit === true,
      });
      const code = items.every((item) => item.ok)
        ? (argv.commit ? 'committed' : 'plan_ready')
        : 'partial_failure';
      if (argv.json) {
        writeJsonItems(items, code);
        return;
      }
      printItems(items);
      if (!items.every((item) => item.ok)) process.exit(1);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const upsertCommand: CommandModule<object, ObjUpsertArgs> = {
  command: 'upsert',
  describe: 'Upsert descriptor-backed JSONL rows',
  builder: (yargs) =>
    objOptions<ObjUpsertArgs>(yargs)
      .option('schema', { type: 'string', demandOption: true, description: 'Schema URI or descriptor alias' })
      .option('from', { type: 'string', demandOption: true, description: 'JSONL file to read, or - for stdin' })
      .option('dry-run', { type: 'boolean', description: 'Validate and print a plan without writing' })
      .option('commit', { type: 'boolean', description: 'Commit the validated mutations' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const items = await executeRows({
        argv,
        rows: await readJsonl(argv.from),
        defaultSchema: resolveDescriptor(argv.schema).uri,
        commit: argv.commit === true,
      });
      const code = items.every((item) => item.ok)
        ? (argv.commit ? 'committed' : 'plan_ready')
        : 'partial_failure';
      if (argv.json) {
        writeJsonItems(items, code);
        return;
      }
      printItems(items);
      if (!items.every((item) => item.ok)) process.exit(1);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const registerCommand: CommandModule<object, ObjRegisterArgs> = {
  command: 'register',
  describe: 'Register @undefineds.co/models resources in the private TypeIndex',
  builder: (yargs) =>
    objOptions<ObjRegisterArgs>(yargs)
      .option('pod-root', { type: 'string', description: 'Pod storage root to register. Defaults to the authenticated WebID-derived Pod root.' })
      .option('type-index', { type: 'string', description: 'Private TypeIndex URL/path. Defaults to settings/privateTypeIndex.ttl under the Pod root.' })
      .option('dry-run', { type: 'boolean', description: 'Validate and print the registration plan without writing' })
      .option('commit', { type: 'boolean', description: 'Create/patch the TypeIndex and link it from the profile' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const data = await executeRegisterCommand(argv);
      if (argv.json) {
        writeJsonResult(data, argv['dry-run'] ? 'plan_ready' : 'registered');
        return;
      }
      if (argv['dry-run']) {
        console.log(JSON.stringify(data.plan, null, 2));
        return;
      }
      console.log(`REGISTER ${String(data.registrationCount)} model types -> ${String(data.privateTypeIndex)}`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const listCommand: CommandModule<object, ObjSelectorArgs> = {
  command: 'list',
  describe: 'List descriptor-backed objects',
  builder: (yargs) =>
    selectorOptions<ObjSelectorArgs>(yargs)
      .option('schema', { type: 'string', demandOption: true, description: 'Schema URI or descriptor alias' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const selector = await resolveObjectSelector(context, argv);
      const objects = await queryDescriptorObjects(context, selector);
      if (argv.json) {
        writeJsonResult({
          webId: context.webId,
          podRoot: context.podRoot,
          schema: selector.descriptor.uri,
          objects,
        });
        return;
      }
      for (const object of objects) {
        console.log(object.subject);
      }
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const exportCommand: CommandModule<object, ObjSelectorArgs> = {
  command: 'export <selector>',
  describe: 'Export descriptor-backed objects as JSONL',
  builder: (yargs) =>
    selectorOptions<ObjSelectorArgs>(yargs)
      .positional('selector', { type: 'string', demandOption: true, description: 'Schema URI/alias, subject, resource URL, or Pod-relative path selector' })
      .option('format', { type: 'string', choices: [ 'jsonl' ], default: 'jsonl', description: 'Export format' })
      .option('out', { type: 'string', description: 'Output file path' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const selector = await resolveObjectSelector(context, argv);
      const objects = await queryDescriptorObjects(context, selector);
      const jsonl = jsonlForObjects(objects);
      if (argv.out) {
        writeFileSync(argv.out, jsonl, 'utf-8');
      }
      if (argv.json) {
        writeJsonResult({
          webId: context.webId,
          podRoot: context.podRoot,
          schema: selector.descriptor.uri,
          count: objects.length,
          out: argv.out ?? null,
          ...(argv.out ? {} : { objects }),
        });
        return;
      }
      if (!argv.out) {
        process.stdout.write(jsonl);
      }
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const getCommand: CommandModule<object, ObjGetArgs> = {
  command: 'get',
  describe: 'Read one descriptor-backed object as JSON',
  builder: (yargs) =>
    objOptions<ObjGetArgs>(yargs)
      .option('schema', { type: 'string', description: 'Schema URI or descriptor alias' })
      .option('subject', { type: 'string', demandOption: true, description: 'Object subject URI or Pod-relative subject' })
      .option('out', { type: 'string', description: 'Write JSON object to file' })
      .option('include-metadata', { type: 'boolean', default: true, description: 'Include etag/revision metadata when available' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const selector = await resolveObjectSelector(context, {
        ...argv,
        selector: undefined,
        limit: 1,
        format: 'jsonl',
        where: undefined,
        relation: undefined,
        status: undefined,
      });
      const objects = await queryDescriptorObjects(context, selector);
      const object = objects[0];
      if (!object) {
        throw new CliCommandError('object_not_found', `Object not found: ${argv.subject}`, 1);
      }
      const body = `${JSON.stringify(object, null, 2)}\n`;
      if (argv.out) {
        writeFileSync(argv.out, body, 'utf-8');
      }
      if (argv.json) {
        writeJsonResult({ webId: context.webId, podRoot: context.podRoot, object, out: argv.out ?? null });
        return;
      }
      if (!argv.out) {
        process.stdout.write(body);
      }
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const patchCommand: CommandModule<object, ObjPatchArgs> = {
  command: 'patch',
  describe: 'Patch one descriptor-backed object field set',
  builder: (yargs) =>
    objOptions<ObjPatchArgs>(yargs)
      .option('schema', { type: 'string', description: 'Schema URI or descriptor alias. Required if the subject document cannot be inferred.' })
      .option('subject', { type: 'string', demandOption: true, description: 'Object subject URI or Pod-relative subject' })
      .option('set', { type: 'string', demandOption: true, description: 'JSON object of descriptor field values to set' })
      .option('if-match', { type: 'string', description: 'If-Match header for stale-write protection' })
      .option('dry-run', { type: 'boolean', description: 'Print the mutation plan without writing' })
      .option('commit', { type: 'boolean', description: 'Commit the mutation' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const data = await executePatchCommand(argv);
      if (argv.json) {
        writeJsonResult(data, argv['dry-run'] ? 'plan_ready' : 'committed');
        return;
      }
      console.log(argv['dry-run'] ? JSON.stringify(data.plan, null, 2) : `PATCH ${String(data.resourceUrl)} -> HTTP ${String(data.status)}`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const linkCommand: CommandModule<object, ObjLinkArgs> = {
  command: 'link',
  describe: 'Link one descriptor-backed object to another URI',
  builder: (yargs) =>
    objOptions<ObjLinkArgs>(yargs)
      .option('schema', { type: 'string', description: 'Schema URI or descriptor alias when --predicate is a descriptor field' })
      .option('subject', { type: 'string', demandOption: true, description: 'Object subject URI or Pod-relative subject' })
      .option('predicate', { type: 'string', demandOption: true, description: 'Predicate URI or descriptor field' })
      .option('object', { type: 'string', demandOption: true, description: 'Object URI to link' })
      .option('if-match', { type: 'string', description: 'If-Match header for stale-write protection' })
      .option('dry-run', { type: 'boolean', description: 'Print the mutation plan without writing' })
      .option('commit', { type: 'boolean', description: 'Commit the mutation' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const data = await executeLinkCommand(argv);
      if (argv.json) {
        writeJsonResult(data, argv['dry-run'] ? 'plan_ready' : 'committed');
        return;
      }
      console.log(argv['dry-run'] ? JSON.stringify(data.plan, null, 2) : `LINK ${String(data.resourceUrl)} -> HTTP ${String(data.status)}`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const deleteCommand: CommandModule<object, ObjDeleteArgs> = {
  command: 'delete',
  describe: 'Delete triples for one descriptor-backed object subject',
  builder: (yargs) =>
    objOptions<ObjDeleteArgs>(yargs)
      .option('schema', { type: 'string', description: 'Schema URI or descriptor alias. Required if the subject document cannot be inferred.' })
      .option('subject', { type: 'string', demandOption: true, description: 'Object subject URI or Pod-relative subject' })
      .option('if-match', { type: 'string', description: 'If-Match header for stale-write protection' })
      .option('dry-run', { type: 'boolean', description: 'Print the mutation plan without writing' })
      .option('commit', { type: 'boolean', description: 'Commit the mutation' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const data = await executeDeleteCommand(argv);
      if (argv.json) {
        writeJsonResult(data, argv['dry-run'] ? 'plan_ready' : 'committed');
        return;
      }
      console.log(argv['dry-run'] ? JSON.stringify(data.plan, null, 2) : `DELETE ${String(data.resourceUrl)} -> HTTP ${String(data.status)}`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const watchCommand: CommandModule<object, ObjSelectorArgs> = {
  command: 'watch <selector>',
  describe: 'Stream descriptor-backed object changes as JSONL snapshots',
  builder: (yargs) =>
    selectorOptions<ObjSelectorArgs>(yargs)
      .positional('selector', { type: 'string', demandOption: true, description: 'Schema URI/alias, subject, resource URL, or Pod-relative path selector' })
      .option('format', { type: 'string', choices: [ 'jsonl' ], default: 'jsonl', description: 'Watch stream format' })
      .option('since', { type: 'string', description: 'Opaque cursor from a previous watch stream' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const selector = await resolveObjectSelector(context, argv);
      const objects = await queryDescriptorObjects(context, selector);
      const metadata = {
        cursorDurable: false,
        since: argv.since ?? null,
        cursor: null,
        message: 'Durable object cursors are not available; reconcile with a fresh obj list/export snapshot.',
      };
      if (argv.json) {
        writeJsonResult({ metadata, objects }, 'watch_snapshot');
        return;
      }
      console.log(JSON.stringify({ ok: true, code: 'cursor_unavailable', metadata }));
      for (const [ index, object ] of objects.entries()) {
        console.log(JSON.stringify({
          index,
          ok: true,
          code: 'snapshot',
          change: 'snapshot',
          ...object,
        }));
      }
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

export const objCommand: CommandModule<object, ObjArgs> = {
  command: 'obj',
  describe: 'Descriptor-backed object transport',
  builder: (yargs) =>
    (yargs
      .command(exportCommand)
      .command(importCommand)
      .command(getCommand)
      .command(listCommand)
      .command(upsertCommand)
      .command(registerCommand)
      .command(patchCommand)
      .command(linkCommand)
      .command(deleteCommand)
      .command(watchCommand)
      .demandCommand(1, 'Please specify an object subcommand') as unknown as Argv<ObjArgs>),
  handler: () => {},
};
