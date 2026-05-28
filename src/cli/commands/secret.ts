import type { Argv, CommandModule } from 'yargs';
import { createPodStorage, credentialDescriptor } from '@undefineds.co/models';
import { requireAuthContext } from '../lib/auth-context';
import { CliCommandError, handleCliError, writeJsonResult } from '../lib/output';
import {
  ensureOk,
  fetchResource,
  resolveResourceTarget,
  responseData,
} from '../lib/resource';

interface SecretArgs {
  url?: string;
  json: boolean;
}

interface SecretSelectorArgs extends SecretArgs {
  selector?: string;
  kind?: string;
  provider?: string;
  service?: string;
}

interface ResolvedSecretSelector extends SecretArgs {
  kind: string;
  provider: string;
  service?: string;
}

interface SecretPlanArgs extends ResolvedSecretSelector {
  label?: string;
}

interface SecretSetArgs extends SecretPlanArgs {
  'from-stdin': boolean;
}

function secretOptions<T>(yargs: Argv): Argv<T> {
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

function selectorOptions<T extends SecretSelectorArgs>(yargs: Argv, demandFlags = true): Argv<T> {
  return secretOptions<T>(yargs)
    .option('kind', { type: 'string', demandOption: demandFlags, description: 'Secret kind, for example api-key or tunnel-token' })
    .option('provider', { type: 'string', demandOption: demandFlags, description: 'Provider identifier' })
    .option('service', { type: 'string', default: 'ai', description: 'Service grouping' }) as unknown as Argv<T>;
}

export function resolveSecretSelector(input: SecretSelectorArgs): ResolvedSecretSelector {
  let service = input.service ?? 'ai';
  let provider = input.provider;
  let kind = input.kind;

  if (input.selector) {
    const selector = input.selector.trim();
    if (selector.startsWith('{')) {
      const parsed = JSON.parse(selector) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CliCommandError('invalid_selector', 'Secret selector JSON must be an object.', 2);
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.service === 'string') service = record.service;
      if (typeof record.provider === 'string') provider = record.provider;
      if (typeof record.kind === 'string') kind = record.kind;
    } else {
      const parts = selector.split(/[/:]/u).map((part) => part.trim()).filter(Boolean);
      if (parts.length === 3) {
        [ service, provider, kind ] = parts;
      } else if (parts.length === 2) {
        [ provider, kind ] = parts;
      } else {
        throw new CliCommandError('invalid_selector', 'Secret selector must be provider/kind, service/provider/kind, or a JSON object.', 2);
      }
    }
  }

  if (!provider || !kind) {
    throw new CliCommandError('selector_required', 'Secret provider and kind are required.', 2);
  }
  return {
    url: input.url,
    json: input.json,
    service,
    provider,
    kind,
  };
}

function escapeSparqlLiteral(value: string): string {
  return JSON.stringify(value);
}

function localId(input: ResolvedSecretSelector): string {
  return [ input.service ?? 'ai', input.provider, input.kind ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

export interface SecretPlan {
  schemaUri: string;
  resourceKind: string;
  service: string;
  provider: string;
  kind: string;
  subject: string;
  resourceUrl: string;
  redacted: true;
}

export function buildSecretPlan(podRoot: string, input: ResolvedSecretSelector): SecretPlan {
  const service = input.service ?? 'ai';
  const storage = createPodStorage();
  const validation = storage.validate({
    schemaUri: credentialDescriptor.uri,
    operation: 'upsert',
    match: {
      service,
      providerId: input.provider,
      secretType: input.kind,
    },
    set: {
      status: 'active',
    },
  });
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }

  const resourcePath = validation.plan.resourceUri.replace(/^\/+/, '');
  const resourceUrl = new URL(resourcePath, podRoot).toString();
  return {
    schemaUri: credentialDescriptor.uri,
    resourceKind: credentialDescriptor.resourceKind,
    service,
    provider: input.provider,
    kind: input.kind,
    subject: resourceUrl,
    resourceUrl: resourceUrl.replace(/#.*$/u, ''),
    redacted: true,
  };
}

export function buildSecretUpsertSparql(plan: SecretPlan, input: {
  value?: string;
  label?: string;
  status?: string;
  revoke?: boolean;
}): string {
  const subject = `<${plan.subject}>`;
  const fields = credentialDescriptor.fields;
  const values: Record<string, string> = {
    service: plan.service,
    providerId: plan.provider,
    secretType: plan.kind,
    status: input.status ?? (input.revoke ? 'revoked' : 'active'),
  };
  if (input.label) values.label = input.label;
  if (input.value !== undefined && !input.revoke) values.apiKey = input.value;

  const deleteTriples = [
    `${subject} <${fields.label.predicate}> ?oldLabel .`,
    `${subject} <${fields.apiKey.predicate}> ?oldApiKey .`,
    `${subject} <${fields.status.predicate}> ?oldStatus .`,
  ];
  const optionals = [
    `OPTIONAL { ${subject} <${fields.label.predicate}> ?oldLabel }`,
    `OPTIONAL { ${subject} <${fields.apiKey.predicate}> ?oldApiKey }`,
    `OPTIONAL { ${subject} <${fields.status.predicate}> ?oldStatus }`,
  ];
  const insertTriples = [
    `${subject} a <${credentialDescriptor.class}>`,
    `${subject} <${fields.service.predicate}> ${escapeSparqlLiteral(values.service)}`,
    `${subject} <${fields.providerId.predicate}> ${escapeSparqlLiteral(values.providerId)}`,
    `${subject} <${fields.secretType.predicate}> ${escapeSparqlLiteral(values.secretType)}`,
    `${subject} <${fields.status.predicate}> ${escapeSparqlLiteral(values.status)}`,
  ];
  if (values.label) {
    insertTriples.push(`${subject} <${fields.label.predicate}> ${escapeSparqlLiteral(values.label)}`);
  }
  if (values.apiKey !== undefined) {
    insertTriples.push(`${subject} <${fields.apiKey.predicate}> ${escapeSparqlLiteral(values.apiKey)}`);
  }

  return `DELETE {\n  ${deleteTriples.join('\n  ')}\n}\nINSERT {\n  ${insertTriples.join(' .\n  ')} .\n}\nWHERE {\n  ${optionals.join('\n  ')}\n}`;
}

async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/u, '');
}

function printSecretPlan(plan: SecretPlan): void {
  console.log(`subject: ${plan.subject}`);
  console.log(`resource: ${plan.resourceUrl}`);
  console.log(`schema: ${plan.schemaUri}`);
  console.log('value: [redacted]');
}

const planCommand: CommandModule<object, SecretPlanArgs> = {
  command: 'plan',
  describe: 'Plan a descriptor-backed secret write',
  builder: (yargs) =>
    selectorOptions<SecretPlanArgs>(yargs)
      .option('label', { type: 'string', description: 'Secret label metadata' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const plan = buildSecretPlan(context.podRoot, argv);
      if (argv.json) {
        writeJsonResult({ plan }, 'plan_ready');
        return;
      }
      printSecretPlan(plan);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const setCommand: CommandModule<object, SecretSetArgs> = {
  command: 'set',
  describe: 'Set a descriptor-backed secret from stdin',
  builder: (yargs) =>
    selectorOptions<SecretSetArgs>(yargs)
      .option('from-stdin', { type: 'boolean', demandOption: true, description: 'Read secret value from stdin' })
      .option('label', { type: 'string', description: 'Secret label metadata' }),
  handler: async (argv) => {
    try {
      if (!argv['from-stdin']) {
        throw new Error('Secret values must be provided with --from-stdin.');
      }
      const value = await readSecretFromStdin();
      const context = await requireAuthContext(argv);
      const plan = buildSecretPlan(context.podRoot, argv);
      const target = resolveResourceTarget(context, plan.resourceUrl);
      const sparql = buildSecretUpsertSparql(plan, { value, label: argv.label });
      const response = await fetchResource(context, target, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/sparql-update' },
        body: sparql,
      });
      ensureOk(response, 'secret_set_failed', `Failed to set secret ${plan.subject}`);
      const data = { ...responseData(target, response), plan };
      if (argv.json) {
        writeJsonResult(data);
        return;
      }
      console.log(`Secret saved: ${plan.subject}`);
      console.log('value: [redacted]');
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const metadataCommand: CommandModule<object, SecretSelectorArgs> = {
  command: 'get-metadata [selector]',
  describe: 'Show descriptor-backed secret metadata without revealing the value',
  builder: (yargs) =>
    selectorOptions<SecretSelectorArgs>(yargs.positional('selector', {
      type: 'string',
      description: 'provider/kind, service/provider/kind, or selector JSON',
    }), false),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const plan = buildSecretPlan(context.podRoot, resolveSecretSelector(argv));
      if (argv.json) {
        writeJsonResult({ ...plan, value: '[redacted]' });
        return;
      }
      printSecretPlan(plan);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const revokeCommand: CommandModule<object, SecretSelectorArgs> = {
  command: 'revoke [selector]',
  describe: 'Revoke a descriptor-backed secret without printing its value',
  builder: (yargs) =>
    selectorOptions<SecretSelectorArgs>(yargs.positional('selector', {
      type: 'string',
      description: 'provider/kind, service/provider/kind, or selector JSON',
    }), false),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const plan = buildSecretPlan(context.podRoot, resolveSecretSelector(argv));
      const target = resolveResourceTarget(context, plan.resourceUrl);
      const sparql = buildSecretUpsertSparql(plan, { revoke: true });
      const response = await fetchResource(context, target, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/sparql-update' },
        body: sparql,
      });
      ensureOk(response, 'secret_revoke_failed', `Failed to revoke secret ${plan.subject}`);
      const data = { ...responseData(target, response), plan, status: 'revoked' };
      if (argv.json) {
        writeJsonResult(data);
        return;
      }
      console.log(`Secret revoked: ${plan.subject}`);
      console.log('value: [redacted]');
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

export const secretCommand: CommandModule<object, SecretArgs> = {
  command: 'secret',
  describe: 'Secret-safe descriptor-backed credential operations',
  builder: (yargs) =>
    (yargs
      .command(planCommand)
      .command(setCommand)
      .command(metadataCommand)
      .command(revokeCommand)
      .demandCommand(1, 'Please specify a secret subcommand') as unknown as Argv<SecretArgs>),
  handler: () => {},
};
