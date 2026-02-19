import type { CommandModule } from 'yargs';

interface ConfigArgs {
  url: string;
  email: string;
  password: string;
}

interface SetArgs extends ConfigArgs {
  key: string;
  value: string;
}

interface GetArgs extends ConfigArgs {
  key: string;
}

interface UnsetArgs extends ConfigArgs {
  key: string;
}

/**
 * Config 子命令通过 Solid 协议读写 Pod 内的配置。
 *
 * 当前实现使用 CSS Account Token + 内部 API 代理来操作 Pod 数据。
 * 后续 PR 可切换为 DPoP token + 直接 Solid 协议访问。
 *
 * 配置路径映射:
 *   ai.openai.api-key  → /settings/credentials.ttl 中 service=ai, provider 含 openai 的 apiKey 字段
 *   ai.openai.base-url → 同上的 baseUrl 字段
 */

// Key path → credential field mapping
const FIELD_MAP: Record<string, string> = {
  'api-key': 'apiKey',
  'base-url': 'baseUrl',
  'proxy-url': 'proxyUrl',
  'project-id': 'projectId',
  'organization-id': 'organizationId',
  'label': 'label',
};

function parseConfigKey(key: string): { service: string; provider: string; field: string } | null {
  // e.g. ai.openai.api-key → service=ai, provider=openai, field=apiKey
  const parts = key.split('.');
  if (parts.length < 3) return null;
  const [service, provider, ...rest] = parts;
  const fieldKey = rest.join('.');
  const field = FIELD_MAP[fieldKey];
  if (!field) return null;
  return { service, provider, field };
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

async function getAuthToken(email: string, password: string, baseUrl: string): Promise<string> {
  const { login } = await import('../lib/css-account');
  const { checkServer } = await import('../lib/css-account');

  if (!(await checkServer(baseUrl))) {
    console.error(`Cannot reach server at ${baseUrl}`);
    process.exit(1);
  }

  const token = await login(email, password, baseUrl);
  if (!token) {
    console.error('Login failed. Check email/password.');
    process.exit(1);
  }
  return token;
}

/**
 * Read credentials from Pod via SPARQL through the API server.
 * Uses the /v1/pod/sparql endpoint which proxies SPARQL queries to the Pod.
 */
async function readCredentials(
  baseUrl: string,
  token: string,
): Promise<Array<Record<string, string>>> {
  // Use the CSS account token to read the credentials resource directly
  const credUrl = `${baseUrl}.account/`;
  const accountRes = await fetch(credUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
  });

  if (!accountRes.ok) return [];

  const accountData = (await accountRes.json()) as { webIds?: Record<string, string>; pods?: Record<string, string> };
  const pods = accountData.pods;
  if (!pods || typeof pods !== 'object') return [];

  // Get the first pod URL
  const podUrl = Object.values(pods)[0];
  if (!podUrl) return [];

  // Read the credentials.ttl resource from the pod
  const settingsUrl = `${podUrl}settings/credentials.ttl`;
  const res = await fetch(settingsUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
  });

  if (!res.ok) return [];

  try {
    const data = await res.json();
    if (Array.isArray(data)) return data as Array<Record<string, string>>;
    return [];
  } catch {
    return [];
  }
}

const setCommand: CommandModule<ConfigArgs, SetArgs> = {
  command: 'set <key> <value>',
  describe: 'Set a Pod configuration value',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', demandOption: true, description: 'Config key (e.g. ai.openai.api-key)' })
      .positional('value', { type: 'string', demandOption: true, description: 'Config value' }),
  handler: async (argv) => {
    const parsed = parseConfigKey(argv.key);
    if (!parsed) {
      console.error(`Invalid config key: ${argv.key}`);
      console.error('Format: <service>.<provider>.<field>');
      console.error('Fields: api-key, base-url, proxy-url, project-id, organization-id, label');
      process.exit(1);
    }

    const baseUrl = argv.url.endsWith('/') ? argv.url : `${argv.url}/`;
    const token = await getAuthToken(argv.email, argv.password, baseUrl);

    // Get account info to find pod URL
    const accountRes = await fetch(`${baseUrl}.account/`, {
      headers: {
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
    });

    if (!accountRes.ok) {
      console.error('Failed to get account info.');
      process.exit(1);
    }

    const accountData = (await accountRes.json()) as { pods?: Record<string, string> };
    const pods = accountData.pods;
    const podUrl = pods ? Object.values(pods)[0] : undefined;

    if (!podUrl) {
      console.error('No pod found for this account.');
      process.exit(1);
    }

    // Build SPARQL UPDATE to insert/update the credential
    const credId = `cred-${parsed.provider}`;
    const ns = 'http://undefineds.co/ns/';
    const subject = `<${podUrl}settings/credentials.ttl#${credId}>`;

    const sparql = `
PREFIX udfs: <${ns}>
DELETE { ${subject} udfs:${parsed.field} ?old }
INSERT { ${subject} a udfs:Credential ;
  udfs:service "${parsed.service}" ;
  udfs:${parsed.field} "${argv.value}" }
WHERE { OPTIONAL { ${subject} udfs:${parsed.field} ?old } }
    `.trim();

    const patchUrl = `${podUrl}settings/credentials.ttl`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/sparql-update',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: sparql,
    });

    if (patchRes.ok) {
      const isSensitive = parsed.field === 'apiKey';
      const display = isSensitive ? maskSecret(argv.value) : argv.value;
      console.log(`Set ${argv.key} = ${display}`);
    } else {
      const text = await patchRes.text();
      console.error(`Failed to set config: ${patchRes.status} ${text.slice(0, 200)}`);
      process.exit(1);
    }
  },
};

const getCommand: CommandModule<ConfigArgs, GetArgs> = {
  command: 'get <key>',
  describe: 'Get Pod configuration (masked for secrets)',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', demandOption: true, description: 'Config key prefix (e.g. ai)' }),
  handler: async (argv) => {
    const baseUrl = argv.url.endsWith('/') ? argv.url : `${argv.url}/`;
    const token = await getAuthToken(argv.email, argv.password, baseUrl);
    const creds = await readCredentials(baseUrl, token);

    if (creds.length === 0) {
      console.log('No credentials configured.');
      return;
    }

    // Filter by key prefix
    const prefix = argv.key.toLowerCase();
    const filtered = creds.filter((c) => {
      const service = (c.service ?? '').toLowerCase();
      return service.startsWith(prefix) || prefix === 'all';
    });

    if (filtered.length === 0) {
      console.log(`No credentials matching "${argv.key}".`);
      return;
    }

    for (const c of filtered) {
      console.log(`[${c.service ?? 'unknown'}] ${c.label ?? c.id ?? 'unnamed'}`);
      if (c.apiKey) console.log(`  api-key:  ${maskSecret(c.apiKey)}`);
      if (c.baseUrl) console.log(`  base-url: ${c.baseUrl}`);
      if (c.proxyUrl) console.log(`  proxy:    ${c.proxyUrl}`);
    }
  },
};

const listConfigCommand: CommandModule<ConfigArgs, ConfigArgs> = {
  command: 'list',
  describe: 'List all Pod configurations',
  builder: (yargs) => yargs,
  handler: async (argv) => {
    const baseUrl = argv.url.endsWith('/') ? argv.url : `${argv.url}/`;
    const token = await getAuthToken(argv.email, argv.password, baseUrl);
    const creds = await readCredentials(baseUrl, token);

    if (creds.length === 0) {
      console.log('No credentials configured.');
      return;
    }

    for (const c of creds) {
      console.log(`[${c.service ?? 'unknown'}] ${c.label ?? c.id ?? 'unnamed'}`);
      if (c.apiKey) console.log(`  api-key:  ${maskSecret(c.apiKey)}`);
      if (c.baseUrl) console.log(`  base-url: ${c.baseUrl}`);
      if (c.proxyUrl) console.log(`  proxy:    ${c.proxyUrl}`);
      console.log();
    }
  },
};

const unsetCommand: CommandModule<ConfigArgs, UnsetArgs> = {
  command: 'unset <key>',
  describe: 'Remove a Pod configuration',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', demandOption: true, description: 'Config key prefix to remove (e.g. ai.openai)' }),
  handler: async (argv) => {
    const parts = argv.key.split('.');
    if (parts.length < 2) {
      console.error('Format: <service>.<provider>');
      process.exit(1);
    }

    const [, provider] = parts;
    const baseUrl = argv.url.endsWith('/') ? argv.url : `${argv.url}/`;
    const token = await getAuthToken(argv.email, argv.password, baseUrl);

    // Get pod URL
    const accountRes = await fetch(`${baseUrl}.account/`, {
      headers: {
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
    });

    if (!accountRes.ok) {
      console.error('Failed to get account info.');
      process.exit(1);
    }

    const accountData = (await accountRes.json()) as { pods?: Record<string, string> };
    const pods = accountData.pods;
    const podUrl = pods ? Object.values(pods)[0] : undefined;

    if (!podUrl) {
      console.error('No pod found for this account.');
      process.exit(1);
    }

    const credId = `cred-${provider}`;
    const subject = `<${podUrl}settings/credentials.ttl#${credId}>`;

    const sparql = `DELETE WHERE { ${subject} ?p ?o }`;

    const patchUrl = `${podUrl}settings/credentials.ttl`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/sparql-update',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: sparql,
    });

    if (patchRes.ok) {
      console.log(`Removed config for ${argv.key}`);
    } else {
      const text = await patchRes.text();
      console.error(`Failed to unset config: ${patchRes.status} ${text.slice(0, 200)}`);
      process.exit(1);
    }
  },
};

export const configCommand: CommandModule<object, ConfigArgs> = {
  command: 'config',
  describe: 'Pod configuration management',
  builder: (yargs) =>
    yargs
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' })
      .command(setCommand)
      .command(getCommand)
      .command(listConfigCommand)
      .command(unsetCommand)
      .demandCommand(1, 'Please specify a config subcommand'),
  handler: () => {
    // parent command, no-op
  },
};
