import type { CommandModule } from 'yargs';
import { aiConfigModelRef, aiConfigProviderRef, getAIConfigProviderMetadata, XPOD_AI, XPOD_CREDENTIAL } from '@undefineds.co/models';
import { loadCredentials, getClientCredentials } from '../lib/credentials-store';
import { getAccessToken, authenticatedFetch } from '../lib/solid-auth';

interface ConfigArgs {
  url?: string;
}

interface SetArgs extends ConfigArgs {
  provider?: string;
  model?: string;
  'api-key'?: string;
}

/**
 * Config 子命令：配置 Pod 中的 AI provider。
 *
 * 写入 Pod 的两个资源，与服务端 PodChatKitStore.getAiConfig() 对齐：
 *   /settings/providers/{provider}.ttl          — Provider + optional Model
 *   /settings/credentials.ttl#cred-{provider}   — Credential (apiKey, service=ai, status=active, provider link)
 *
 * 用法:
 *   xpod config set --provider openai --model gpt-4o --api-key sk-xxx
 *   xpod config set --api-key sk-new-key          # 更新已有 provider 的 key
 *   xpod config show
 *   xpod config reset
 */

export const AI_NS = XPOD_AI.NAMESPACE;
export const CREDENTIAL_NS = XPOD_CREDENTIAL.NAMESPACE;

/** provider name → default baseUrl */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.ai/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  codebuddy: 'https://api.codebuddy.ai/v1',
};

export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

export function credentialId(provider: string): string {
  return `cred-${provider.toLowerCase()}`;
}

async function resolveAuth(argv: ConfigArgs): Promise<{ accessToken: string; podUrl: string }> {
  const creds = loadCredentials();
  if (!creds) {
    console.error('No credentials found. Run `xpod auth create-credentials` first.');
    process.exit(1);
  }

  const clientCreds = getClientCredentials(creds);
  if (!clientCreds) {
    console.error('OAuth authentication not yet supported. Please use client credentials.');
    process.exit(1);
  }

  const baseUrl = (argv.url ?? creds.url).replace(/\/?$/, '/');

  const tokenResult = await getAccessToken(clientCreds.clientId, clientCreds.clientSecret, baseUrl);
  if (!tokenResult) {
    console.error('Failed to obtain access token. Credentials may be expired — run `xpod auth create-credentials` again.');
    process.exit(1);
  }

  const webIdUrl = new URL(creds.webId);
  const pathParts = webIdUrl.pathname.split('/').filter(Boolean);
  const podUrl = `${webIdUrl.origin}/${pathParts[0]}/`;

  return { accessToken: tokenResult.accessToken, podUrl };
}

/**
 * Build SPARQL UPDATE to upsert a Provider at /settings/providers/{id}.ttl
 */
export function buildProviderSparql(resourceUrl: string, providerId: string, fields: { model?: string } = {}): string {
  const baseUrl = PROVIDER_BASE_URLS[providerId.toLowerCase()];
  const displayName = getAIConfigProviderMetadata(providerId).displayName
    ?? providerId.charAt(0).toUpperCase() + providerId.slice(1);
  const subject = `<${resourceUrl}>`;
  const deletes = [
    `${subject} ai:baseUrl ?oldBase .`,
    `${subject} ai:displayName ?oldName .`,
  ];
  const providerPredicates = [
    `a ai:Provider`,
    `ai:displayName "${displayName}"`,
  ];
  const insertTriples: string[] = [];
  const optionals = [
    `OPTIONAL { ${subject} ai:baseUrl ?oldBase }`,
    `OPTIONAL { ${subject} ai:displayName ?oldName }`,
  ];

  if (baseUrl) {
    providerPredicates.push(`ai:baseUrl "${baseUrl}"`);
  }

  if (fields.model) {
    const modelRef = aiConfigModelRef(providerId, fields.model);
    const fragmentIndex = modelRef.indexOf('#');
    const modelSubject = fragmentIndex >= 0
      ? `<${resourceUrl}#${modelRef.slice(fragmentIndex + 1)}>`
      : `<${resourceUrl}#${fields.model}>`;
    deletes.push(`${subject} ai:defaultModel ?oldDefaultModel .`);
    deletes.push(`${subject} ai:hasModel ?oldHasModel .`);
    optionals.push(`OPTIONAL { ${subject} ai:defaultModel ?oldDefaultModel }`);
    optionals.push(`OPTIONAL { ${subject} ai:hasModel ?oldHasModel }`);
    providerPredicates.push(`ai:defaultModel ${modelSubject}`);
    providerPredicates.push(`ai:hasModel ${modelSubject}`);
    insertTriples.push(`${modelSubject} a ai:Model ; ai:displayName "${fields.model}" ; ai:modelType "chat" ; ai:isProvidedBy ${subject} ; ai:status "active" .`);
  }
  insertTriples.unshift(`${subject} ${providerPredicates.join(' ;\n  ')} .`);

  return `PREFIX ai: <${AI_NS}>
DELETE { ${deletes.join(' ')} }
INSERT { ${insertTriples.join('\n  ')} }
WHERE { ${optionals.join(' ')} }`;
}

/**
 * Build SPARQL UPDATE to upsert a Credential at /settings/credentials.ttl#cred-{provider}
 */
export function buildCredentialSparql(
  resourceUrl: string,
  podUrl: string,
  provider: string,
  fields: { apiKey?: string; model?: string },
): string {
  const credId = credentialId(provider);
  const subject = `<${resourceUrl}#${credId}>`;
  const providerUri = `<${podUrl.replace(/\/$/, '')}${aiConfigProviderRef(provider)}>`;

  const deletes: string[] = [];
  const inserts: string[] = [
    `${subject} a cred:Credential`,
    `cred:service "ai"`,
    `cred:status "active"`,
    `cred:provider ${providerUri}`,
  ];
  const optionals: string[] = [];

  // Always delete+reinsert provider link
  deletes.push(`${subject} cred:provider ?oldProv .`);
  optionals.push(`OPTIONAL { ${subject} cred:provider ?oldProv }`);

  if (fields.apiKey) {
    deletes.push(`${subject} cred:apiKey ?oldKey .`);
    optionals.push(`OPTIONAL { ${subject} cred:apiKey ?oldKey }`);
    inserts.push(`cred:apiKey "${fields.apiKey}"`);
  }

  return `PREFIX cred: <${CREDENTIAL_NS}>
DELETE { ${deletes.join(' ')} }
INSERT { ${inserts.join(' ;\n  ')} }
WHERE { ${optionals.join(' ')} }`;
}

/**
 * Build SPARQL UPDATE to delete a Credential
 */
export function buildResetSparql(resourceUrl: string, provider: string): string {
  const credId = credentialId(provider);
  const subject = `<${resourceUrl}#${credId}>`;
  return `PREFIX cred: <${CREDENTIAL_NS}>\nDELETE WHERE { ${subject} ?p ?o }`;
}

async function writeProvider(podUrl: string, accessToken: string, providerId: string, fields: { model?: string }): Promise<boolean> {
  const resource = `${podUrl.replace(/\/$/, '')}${aiConfigProviderRef(providerId)}`;
  const sparql = buildProviderSparql(resource, providerId, fields);
  const res = await authenticatedFetch(resource, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/sparql-update' },
    body: sparql,
  });
  return res.ok;
}

async function writeCredential(
  podUrl: string,
  accessToken: string,
  provider: string,
  fields: { apiKey?: string; model?: string },
): Promise<boolean> {
  const resource = `${podUrl}settings/credentials.ttl`;
  const sparql = buildCredentialSparql(resource, podUrl, provider, fields);
  const res = await authenticatedFetch(resource, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/sparql-update' },
    body: sparql,
  });
  return res.ok;
}

const setCommand: CommandModule<ConfigArgs, SetArgs> = {
  command: 'set',
  describe: 'Configure Pod AI provider (provider, model, api-key — one or more)',
  builder: (yargs) =>
    yargs
      .option('provider', { type: 'string', description: `AI provider (${Object.keys(PROVIDER_BASE_URLS).join(', ')})` })
      .option('model', { type: 'string', description: 'Default model name' })
      .option('api-key', { type: 'string', description: 'API key' })
      .check((argv) => {
        if (!argv.provider && !argv.model && !argv['api-key']) {
          throw new Error('Specify at least one of --provider, --model, or --api-key');
        }
        if ((argv.model || argv['api-key']) && !argv.provider) {
          throw new Error('--provider is required when setting --model or --api-key');
        }
        return true;
      }),
  handler: async (argv) => {
    const { accessToken, podUrl } = await resolveAuth(argv);
    const provider = argv.provider!;

    // Write provider
    const provOk = await writeProvider(podUrl, accessToken, provider, { model: argv.model });
    if (!provOk) {
      console.error('Failed to write provider config.');
      process.exit(1);
    }

    // Write credential
    const credOk = await writeCredential(podUrl, accessToken, provider, {
      apiKey: argv['api-key'],
      model: argv.model,
    });
    if (!credOk) {
      console.error('Failed to write credential config.');
      process.exit(1);
    }

    console.log(`  provider: ${provider}`);
    if (argv.model) console.log(`  model:    ${argv.model}`);
    if (argv['api-key']) console.log(`  api-key:  ${maskSecret(argv['api-key'])}`);
    console.log('Pod AI provider config saved.');
  },
};

const showCommand: CommandModule<ConfigArgs, ConfigArgs> = {
  command: 'show',
  describe: 'Show current Pod AI provider config',
  builder: (yargs) => yargs,
  handler: async (argv) => {
    const { accessToken, podUrl } = await resolveAuth(argv);
    const resource = `${podUrl}settings/credentials.ttl`;
    const res = await authenticatedFetch(resource, accessToken, {
      headers: { Accept: 'text/turtle' },
    });

    if (!res.ok) {
      console.log('No Pod AI provider config found. Use `xpod config set --provider openai --api-key sk-xxx` to configure.');
      return;
    }

    const turtle = await res.text();
    // Parse simple triples from turtle to find AI credentials
    const credBlocks = turtle.split(/(?=<[^>]*#cred-)/);
    let found = false;
    for (const block of credBlocks) {
      if (!block.includes('service') || !block.includes('"ai"')) continue;
      found = true;

      const providerMatch = block.match(/settings\/providers\/([^/\s>]+)\.ttl/);
      const apiKeyMatch = block.match(/apiKey\s+"([^"]+)"/);

      if (providerMatch) console.log(`  provider: ${providerMatch[1]}`);
      if (apiKeyMatch) console.log(`  api-key:  ${maskSecret(apiKeyMatch[1])}`);
    }

    if (!found) {
      console.log('No Pod AI provider config found. Use `xpod config set --provider openai --api-key sk-xxx` to configure.');
    }
  },
};

const resetCommand: CommandModule<ConfigArgs, SetArgs> = {
  command: 'reset',
  describe: 'Remove Pod AI provider config',
  builder: (yargs) =>
    yargs.option('provider', {
      type: 'string',
      description: 'Provider to remove',
      demandOption: true,
    }),
  handler: async (argv) => {
    const { accessToken, podUrl } = await resolveAuth(argv);
    const provider = argv.provider!;
    const resource = `${podUrl}settings/credentials.ttl`;
    const sparql = buildResetSparql(resource, provider);

    const res = await authenticatedFetch(resource, accessToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: sparql,
    });

    if (res.ok) {
      console.log(`Pod AI provider config for ${provider} removed.`);
    } else {
      const text = await res.text();
      console.error(`Failed to reset config: ${res.status} ${text.slice(0, 200)}`);
      process.exit(1);
    }
  },
};

export const configCommand: CommandModule<object, ConfigArgs> = {
  command: 'config',
  describe: 'Pod AI provider configuration (provider, model, api-key)',
  builder: (yargs) =>
    yargs
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL (default: from ~/.xpod/)',
      })
      .command(setCommand)
      .command(showCommand)
      .command(resetCommand)
      .demandCommand(1, 'Please specify a config subcommand'),
  handler: () => {},
};
