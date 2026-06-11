import type { Argv, CommandModule } from 'yargs';
import { requireAuthContext, type CliAuthContext } from '../lib/auth-context';
import { CliCommandError, handleCliError, writeJsonResult } from '../lib/output';
import {
  ensureOk,
  fetchResource,
  resolveResourceTarget,
  responseData,
} from '../lib/resource';
import {
  ensureContainerResource,
  patchProfileTypeIndexes,
  writeOrPatchModelTypeIndex,
} from '../lib/type-index-ops';
import { documentResourceInput } from './rdf';
import {
  type ModelTypeIndexScope,
  modelTypeIndexUrl,
} from '../../provision/model-type-index';
import {
  type ModelSchemaDdlPlan,
  type ProfileTypeIndexLinks,
  buildModelSchemaCatalog,
  buildModelSchemaDdlPlan,
  buildModelSchemaMigrationPlan,
  diffModelTypeIndexRegistrations,
  findModelSchemaCatalogEntry,
  parseModelTypeIndexRegistrations,
  parseProfileTypeIndexLinks,
} from '../../provision/model-schema-ddl';

interface SchemaArgs {
  url?: string;
  json: boolean;
}

interface SchemaPodArgs extends SchemaArgs {
  'pod-root'?: string;
}

interface SchemaScopeArgs extends SchemaPodArgs {
  scope: 'private' | 'public' | 'both';
}

interface SchemaDescribeArgs extends SchemaPodArgs {
  model: string;
}

interface SchemaApplyArgs extends SchemaScopeArgs {
  'dry-run'?: boolean;
  commit?: boolean;
}

interface SchemaMigrateArgs extends SchemaPodArgs {
  'dry-run'?: boolean;
  commit?: boolean;
}

interface TypeIndexReadResult {
  exists: boolean;
  resourceUrl: string;
  status: number;
  statusText: string;
  body?: string;
}

interface SchemaScopeStateDiff {
  scope: ModelTypeIndexScope;
  expectedTypeIndex: string;
  profileLinks: string[];
  profileLinked: boolean;
  profileLinkMatchesExpected: boolean;
  observedTypeIndex: string;
  typeIndexExists: boolean;
  registrationDiff: ReturnType<typeof diffModelTypeIndexRegistrations>;
  needsApply: boolean;
  recommendedOperations: string[];
}

interface SchemaStateDiff {
  webId: string;
  podRoot: string;
  profile: {
    resourceUrl: string;
    links: ProfileTypeIndexLinks;
  };
  ok: boolean;
  scopes: SchemaScopeStateDiff[];
}

function schemaOptions<T>(yargs: Argv): Argv<T> {
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

function podRootOptions<T extends SchemaPodArgs>(yargs: Argv): Argv<T> {
  return schemaOptions<T>(yargs)
    .option('pod-root', { type: 'string', description: 'Pod storage root. Defaults to the authenticated WebID-derived Pod root.' }) as unknown as Argv<T>;
}

function scopeOptions<T extends SchemaScopeArgs>(yargs: Argv): Argv<T> {
  return podRootOptions<T>(yargs)
    .option('scope', {
      choices: [ 'private', 'public', 'both' ] as const,
      default: 'private',
      description: 'TypeIndex scope to inspect or apply',
    }) as unknown as Argv<T>;
}

function mutationModeCheck(argv: { 'dry-run'?: boolean; commit?: boolean }): true {
  if (argv['dry-run'] === argv.commit) {
    throw new Error('Specify exactly one of --dry-run or --commit.');
  }
  return true;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function resolvePodRootOption(context: CliAuthContext | undefined, podRoot?: string): string {
  if (!podRoot) {
    if (!context) {
      throw new CliCommandError('auth_required', 'No --pod-root was provided. Run `xpod auth login` or pass an absolute Pod root.', 2);
    }
    return ensureTrailingSlash(context.podRoot);
  }
  if (/^https?:\/\//iu.test(podRoot)) {
    return ensureTrailingSlash(new URL(podRoot).toString());
  }
  if (!context) {
    throw new CliCommandError('invalid_pod_root', '--pod-root must be an absolute URL when no auth context is available.', 2);
  }
  return ensureTrailingSlash(resolveResourceTarget(context, podRoot).resourceUrl);
}

function scopesForArg(scope: 'private' | 'public' | 'both'): ModelTypeIndexScope[] {
  return scope === 'both' ? [ 'private', 'public' ] : [ scope ];
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

async function resolvePodRootForLocalCatalog(argv: SchemaPodArgs): Promise<string> {
  if (argv['pod-root']) {
    return resolvePodRootOption(undefined, argv['pod-root']);
  }
  const context = await requireAuthContext(argv);
  return resolvePodRootOption(context);
}

async function readTurtleResource(
  context: CliAuthContext,
  resourceUrl: string,
  missingCode: string,
  failureCode: string,
): Promise<TypeIndexReadResult> {
  const target = resolveResourceTarget(context, resourceUrl);
  const response = await fetchResource(context, target, {
    method: 'GET',
    headers: { Accept: 'text/turtle' },
  });
  if (response.status === 404) {
    return {
      exists: false,
      resourceUrl: target.resourceUrl,
      status: response.status,
      statusText: response.statusText,
    };
  }
  ensureOk(response, response.status === 404 ? missingCode : failureCode, `Failed to read RDF resource ${resourceUrl}`);
  return {
    exists: true,
    ...responseData(target, response),
    body: await response.text(),
  };
}

async function readSchemaStateDiff(
  context: CliAuthContext,
  podRoot: string,
  scopes: ModelTypeIndexScope[],
): Promise<SchemaStateDiff> {
  const profileUrl = documentResourceInput(context.webId);
  const profile = await readTurtleResource(context, profileUrl, 'profile_not_found', 'profile_read_failed');
  if (!profile.exists || !profile.body) {
    throw new CliCommandError('profile_not_found', `WebID profile was not found: ${profileUrl}`, 1, profile);
  }

  const profileLinks = parseProfileTypeIndexLinks(profile.body, profile.resourceUrl, context.webId);
  const scopeDiffs: SchemaScopeStateDiff[] = [];
  for (const scope of scopes) {
    const plan = buildModelSchemaDdlPlan({ podRoot, scope, scopeSource: 'operator_override' });
    const expectedTypeIndex = modelTypeIndexUrl(podRoot, scope);
    const links = scope === 'private' ? profileLinks.privateTypeIndex : profileLinks.publicTypeIndex;
    const observedTypeIndex = links[0] ?? expectedTypeIndex;
    const typeIndex = await readTurtleResource(context, observedTypeIndex, 'type_index_not_found', 'type_index_read_failed');
    const observedRegistrations = typeIndex.exists && typeIndex.body
      ? parseModelTypeIndexRegistrations(typeIndex.body, typeIndex.resourceUrl)
      : [];
    const registrationDiff = diffModelTypeIndexRegistrations(plan.registrations, observedRegistrations);
    const profileLinked = links.length > 0;
    const profileLinkMatchesExpected = links.includes(expectedTypeIndex);
    const recommendedOperations: string[] = [];
    if (!typeIndex.exists) recommendedOperations.push('create_type_index');
    if (!registrationDiff.ok) recommendedOperations.push('patch_type_index_registrations');
    if (!profileLinked || !profileLinkMatchesExpected) recommendedOperations.push('patch_profile_type_index_link');

    scopeDiffs.push({
      scope,
      expectedTypeIndex,
      profileLinks: links,
      profileLinked,
      profileLinkMatchesExpected,
      observedTypeIndex,
      typeIndexExists: typeIndex.exists,
      registrationDiff,
      needsApply: recommendedOperations.length > 0,
      recommendedOperations,
    });
  }

  return {
    webId: context.webId,
    podRoot,
    profile: {
      resourceUrl: profile.resourceUrl,
      links: profileLinks,
    },
    ok: scopeDiffs.every((diff) => !diff.needsApply),
    scopes: scopeDiffs,
  };
}

async function buildApplyPlans(argv: SchemaApplyArgs): Promise<{ context?: CliAuthContext; podRoot: string; plans: ModelSchemaDdlPlan[] }> {
  const context = argv['dry-run'] && argv['pod-root']
    ? undefined
    : await requireAuthContext(argv);
  const podRoot = resolvePodRootOption(context, argv['pod-root']);
  const plans = scopesForArg(argv.scope)
    .map((scope) => buildModelSchemaDdlPlan({ podRoot, scope, scopeSource: 'operator_override' }));
  return { context, podRoot, plans };
}

async function executeApply(argv: SchemaApplyArgs): Promise<Record<string, unknown>> {
  const { context, podRoot, plans } = await buildApplyPlans(argv);
  if (argv['dry-run']) {
    return {
      ...(context ? { webId: context.webId } : {}),
      podRoot,
      plans,
    };
  }
  if (!context) {
    throw new CliCommandError('auth_required', 'Schema apply --commit requires authentication.', 2);
  }

  const operations: Record<string, unknown>[] = [];
  const profilePatch: { privateTypeIndex?: string; publicTypeIndex?: string } = {};
  for (const plan of plans) {
    operations.push({
      scope: plan.scope,
      ...(await ensureContainerResource(context, containerUrlForResource(plan.typeIndexUrl))),
    });
    operations.push({
      scope: plan.scope,
      ...(await writeOrPatchModelTypeIndex({
        context,
        typeIndexUrl: plan.typeIndexUrl,
        entries: plan.registrations,
      })),
    });
    if (plan.scope === 'private') {
      profilePatch.privateTypeIndex = plan.typeIndexUrl;
    } else {
      profilePatch.publicTypeIndex = plan.typeIndexUrl;
    }
  }
  operations.push({
    scope: argv.scope,
    ...(await patchProfileTypeIndexes({
      context,
      podRoot,
      privateTypeIndex: profilePatch.privateTypeIndex,
      publicTypeIndex: profilePatch.publicTypeIndex,
    })),
  });

  return {
    webId: context.webId,
    podRoot,
    appliedScopes: plans.map((plan) => plan.scope),
    registrationCount: plans.reduce((sum, plan) => sum + plan.registrationCount, 0),
    operations,
  };
}

function printCatalogList(catalog: ReturnType<typeof buildModelSchemaCatalog>): void {
  for (const entry of catalog.entries) {
    const fields = entry.fields ? String(entry.fields.length) : '-';
    console.log(`${entry.resourceKind}\t${entry.schemaStatus}\t${fields}\t${entry.classUri}\t${entry.containerPath}`);
  }
}

function printDiff(diff: SchemaStateDiff): void {
  for (const scope of diff.scopes) {
    const status = scope.needsApply ? 'DRIFT' : 'OK';
    console.log(`${status}\t${scope.scope}\t${scope.expectedTypeIndex}\tmissing=${scope.registrationDiff.missing.length}\textra=${scope.registrationDiff.extra.length}`);
  }
}

const listCommand: CommandModule<object, SchemaPodArgs> = {
  command: 'list',
  describe: 'List model schema registrations from @undefineds.co/models',
  builder: (yargs) => podRootOptions<SchemaPodArgs>(yargs),
  handler: async (argv) => {
    try {
      const podRoot = await resolvePodRootForLocalCatalog(argv);
      const catalog = buildModelSchemaCatalog(podRoot);
      if (argv.json) {
        writeJsonResult(catalog);
        return;
      }
      printCatalogList(catalog);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const describeCommand: CommandModule<object, SchemaDescribeArgs> = {
  command: 'describe <model>',
  describe: 'Describe one model schema/catalog entry',
  builder: (yargs) =>
    podRootOptions<SchemaDescribeArgs>(yargs)
      .positional('model', { type: 'string', demandOption: true, description: 'Model resource kind, class URI, or schema URI' }),
  handler: async (argv) => {
    try {
      const podRoot = await resolvePodRootForLocalCatalog(argv);
      const catalog = buildModelSchemaCatalog(podRoot);
      const entry = findModelSchemaCatalogEntry(catalog, argv.model);
      if (!entry) {
        throw new CliCommandError('schema_unknown', `No model schema is registered for ${argv.model}`, 2);
      }
      if (argv.json) {
        writeJsonResult(entry);
        return;
      }
      console.log(JSON.stringify(entry, null, 2));
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const diffCommand: CommandModule<object, SchemaScopeArgs> = {
  command: 'diff',
  describe: 'Compare Pod schema DDL state with @undefineds.co/models',
  builder: (yargs) => scopeOptions<SchemaScopeArgs>(yargs),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const podRoot = resolvePodRootOption(context, argv['pod-root']);
      const diff = await readSchemaStateDiff(context, podRoot, scopesForArg(argv.scope));
      if (argv.json) {
        writeJsonResult(diff, diff.ok ? 'schema_in_sync' : 'schema_drift_detected');
        return;
      }
      printDiff(diff);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const applyCommand: CommandModule<object, SchemaApplyArgs> = {
  command: 'apply',
  describe: 'Apply model schema DDL plans exported by @undefineds.co/models',
  builder: (yargs) =>
    scopeOptions<SchemaApplyArgs>(yargs)
      .option('dry-run', { type: 'boolean', description: 'Print the DDL plan without writing' })
      .option('commit', { type: 'boolean', description: 'Create/patch TypeIndex resources and profile links' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const data = await executeApply(argv);
      if (argv.json) {
        writeJsonResult(data, argv['dry-run'] ? 'plan_ready' : 'schema_applied');
        return;
      }
      if (argv['dry-run']) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(`APPLY schema ${argv.scope} -> ${String(data.registrationCount)} registrations`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const verifyCommand: CommandModule<object, SchemaScopeArgs> = {
  command: 'verify',
  describe: 'Verify Pod schema DDL state is in sync with @undefineds.co/models',
  builder: (yargs) => scopeOptions<SchemaScopeArgs>(yargs),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const podRoot = resolvePodRootOption(context, argv['pod-root']);
      const diff = await readSchemaStateDiff(context, podRoot, scopesForArg(argv.scope));
      if (!diff.ok) {
        throw new CliCommandError('schema_drift_detected', 'Pod schema DDL state differs from @undefineds.co/models. Run `xpod schema apply --dry-run`.', 1, diff);
      }
      if (argv.json) {
        writeJsonResult(diff, 'schema_verified');
        return;
      }
      console.log(`SCHEMA OK ${argv.scope} ${podRoot}`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const migrateCommand: CommandModule<object, SchemaMigrateArgs> = {
  command: 'migrate',
  describe: 'Run model-owned schema migrations when @undefineds.co/models exports a migration plan',
  builder: (yargs) =>
    podRootOptions<SchemaMigrateArgs>(yargs)
      .option('dry-run', { type: 'boolean', description: 'Print the migration plan without writing' })
      .option('commit', { type: 'boolean', description: 'Commit model-owned migrations' })
      .check(mutationModeCheck),
  handler: async (argv) => {
    try {
      const context = argv['dry-run'] && argv['pod-root']
        ? undefined
        : await requireAuthContext(argv);
      const podRoot = resolvePodRootOption(context, argv['pod-root']);
      const plan = buildModelSchemaMigrationPlan(podRoot);
      if (argv.commit) {
        throw new CliCommandError('unsupported_model', plan.reason, 2, plan);
      }
      if (argv.json) {
        writeJsonResult(plan, 'migration_unavailable');
        return;
      }
      console.log(JSON.stringify(plan, null, 2));
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

export const schemaCommand: CommandModule<object, SchemaArgs> = {
  command: 'schema <command>',
  describe: 'Operate model schema DDL derived from @undefineds.co/models',
  builder: (yargs) =>
    schemaOptions<SchemaArgs>(yargs)
      .command(listCommand)
      .command(describeCommand)
      .command(diffCommand)
      .command(applyCommand)
      .command(verifyCommand)
      .command(migrateCommand)
      .demandCommand(1, 'Specify a schema command')
      .strict(),
  handler: () => undefined,
};
