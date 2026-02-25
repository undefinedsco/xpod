import type { CommandModule } from 'yargs';
import { loadCredentials } from '../lib/credentials-store';
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
 * Config 子命令：配置 SecretaryAI 使用的 AI 服务。
 *
 * 写入 Pod 的两个资源，与服务端 PodChatKitStore.getAiConfig() 对齐：
 *   /settings/ai/providers.ttl#{provider}       — Provider (baseUrl, displayName)
 *   /settings/credentials.ttl#cred-{provider}   — Credential (apiKey, service=ai, status=active, provider link)
 *
 * 用法:
 *   xpod config set --provider openai --model gpt-4o --api-key sk-xxx
 *   xpod config set --api-key sk-new-key          # 更新已有 provider 的 key
 *   xpod config show
 *   xpod config reset
 */

export const UDFS_NS = 'https://undefineds.co/ns#';

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

  const baseUrl = (argv.url ?? creds.url).replace(/\/?$/, '/');

  const tokenResult = await getAccessToken(creds.clientId, creds.clientSecret, baseUrl);
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
 * Build SPARQL UPDATE to upsert a Provider at /settings/ai/providers.ttl#{id}
 */
export function buildProviderSparql(resourceUrl: string, providerId: string): string {
  const baseUrl = PROVIDER_BASE_URLS[providerId.toLowerCase()];
  const displayName = providerId.charAt(0).toUpperCase() + providerId.slice(1);
  const subject = `<${resourceUrl}#${providerId}>`;

  return `PREFIX udfs: <${UDFS_NS}>
DELETE { ${subject} udfs:baseUrl ?oldBase . ${subject} udfs:displayName ?oldName }
INSERT { ${subject} a udfs:Provider ; udfs:displayName "${displayName}"${baseUrl ? ` ; udfs:baseUrl "${baseUrl}"` : ''} }
WHERE { OPTIONAL { ${subject} udfs:baseUrl ?oldBase } OPTIONAL { ${subject} udfs:displayName ?oldName } }`;
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
  const providerUri = `<${podUrl}settings/ai/providers.ttl#${provider}>`;

  const deletes: string[] = [];
  const inserts: string[] = [
    `${subject} a udfs:Credential`,
    `udfs:service "ai"`,
    `udfs:status "active"`,
    `udfs:provider ${providerUri}`,
  ];
  const optionals: string[] = [];

  // Always delete+reinsert provider link
  deletes.push(`${subject} udfs:provider ?oldProv .`);
  optionals.push(`OPTIONAL { ${subject} udfs:provider ?oldProv }`);

  if (fields.apiKey) {
    deletes.push(`${subject} udfs:apiKey ?oldKey .`);
    optionals.push(`OPTIONAL { ${subject} udfs:apiKey ?oldKey }`);
    inserts.push(`udfs:apiKey "${fields.apiKey}"`);
  }
  if (fields.model) {
    deletes.push(`${subject} udfs:defaultModel ?oldModel .`);
    optionals.push(`OPTIONAL { ${subject} udfs:defaultModel ?oldModel }`);
    inserts.push(`udfs:defaultModel "${fields.model}"`);
  }

  return `PREFIX udfs: <${UDFS_NS}>
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
  return `PREFIX udfs: <${UDFS_NS}>\nDELETE WHERE { ${subject} ?p ?o }`;
}

async function writeProvider(podUrl: string, accessToken: string, providerId: string): Promise<boolean> {
  const resource = `${podUrl}settings/ai/providers.ttl`;
  const sparql = buildProviderSparql(resource, providerId);
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
  describe: 'Configure SecretaryAI (provider, model, api-key — one or more)',
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
    const provOk = await writeProvider(podUrl, accessToken, provider);
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
    console.log('SecretaryAI config saved.');
  },
};

const showCommand: CommandModule<ConfigArgs, ConfigArgs> = {
  command: 'show',
  describe: 'Show current SecretaryAI config',
  builder: (yargs) => yargs,
  handler: async (argv) => {
    const { accessToken, podUrl } = await resolveAuth(argv);
    const resource = `${podUrl}settings/credentials.ttl`;
    const res = await authenticatedFetch(resource, accessToken, {
      headers: { Accept: 'text/turtle' },
    });

    if (!res.ok) {
      console.log('No SecretaryAI config found. Use `xpod config set --provider openai --api-key sk-xxx` to configure.');
      return;
    }

    const turtle = await res.text();
    // Parse simple triples from turtle to find AI credentials
    const credBlocks = turtle.split(/(?=<[^>]*#cred-)/);
    let found = false;
    for (const block of credBlocks) {
      if (!block.includes('service') || !block.includes('"ai"')) continue;
      found = true;

      const providerMatch = block.match(/providers\.ttl#(\w+)/);
      const apiKeyMatch = block.match(/apiKey\s+"([^"]+)"/);
      const modelMatch = block.match(/defaultModel\s+"([^"]+)"/);

      if (providerMatch) console.log(`  provider: ${providerMatch[1]}`);
      if (modelMatch) console.log(`  model:    ${modelMatch[1]}`);
      if (apiKeyMatch) console.log(`  api-key:  ${maskSecret(apiKeyMatch[1])}`);
    }

    if (!found) {
      console.log('No SecretaryAI config found. Use `xpod config set --provider openai --api-key sk-xxx` to configure.');
    }
  },
};

const resetCommand: CommandModule<ConfigArgs, SetArgs> = {
  command: 'reset',
  describe: 'Remove SecretaryAI config',
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
      console.log(`SecretaryAI config for ${provider} removed.`);
    } else {
      const text = await res.text();
      console.error(`Failed to reset config: ${res.status} ${text.slice(0, 200)}`);
      process.exit(1);
    }
  },
};

export const configCommand: CommandModule<object, ConfigArgs> = {
  command: 'config',
  describe: 'SecretaryAI configuration (provider, model, api-key)',
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
