import type { CommandModule } from 'yargs';
import {
  checkServer,
  login,
  getAccountControls,
  createClientCredentials,
  listClientCredentials,
  revokeClientCredential,
} from '../lib/css-account';
import { saveCredentials, clearCredentials, getConfigPath } from '../lib/credentials-store';

interface AuthArgs {
  url: string;
}

interface LoginArgs extends AuthArgs {
  email: string;
  password: string;
}

interface CreateCredentialsArgs extends AuthArgs {
  email: string;
  password: string;
  'web-id'?: string;
  name?: string;
  output?: boolean;
}

interface ListArgs extends AuthArgs {
  email: string;
  password: string;
}

interface RevokeArgs extends AuthArgs {
  email: string;
  password: string;
  'client-id': string;
}

function resolveUrl(url: string): string {
  const raw = url || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

const loginCommand: CommandModule<AuthArgs, LoginArgs> = {
  command: 'login',
  describe: 'Login and get an account token',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    const token = await login(argv.email, argv.password, baseUrl);
    if (!token) {
      console.error('Login failed. Check email/password.');
      process.exit(1);
    }

    console.log('Login successful.');
    console.log(`Token: ${token}`);
  },
};

const createCredentialsCommand: CommandModule<AuthArgs, CreateCredentialsArgs> = {
  command: 'create-credentials',
  describe: 'Create client credentials (client_id/secret)',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' })
      .option('web-id', { type: 'string', description: 'WebID to bind credentials to' })
      .option('name', { type: 'string', description: 'Credential label' })
      .option('output', { type: 'boolean', default: false, description: 'Print credentials to terminal instead of saving to ~/.xpod/' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    const token = await login(argv.email, argv.password, baseUrl);
    if (!token) {
      console.error('Login failed.');
      process.exit(1);
    }

    const controls = await getAccountControls(token, baseUrl);
    if (!controls?.clientCredentials) {
      console.error('Cannot find client credentials endpoint.');
      process.exit(1);
    }

    // Determine WebID: explicit flag > first pod's profile
    let webId = argv['web-id'];
    if (!webId) {
      // Try to discover from account info
      const accountRes = await fetch(`${baseUrl}.account/`, {
        headers: {
          Accept: 'application/json',
          Authorization: `CSS-Account-Token ${token}`,
        },
      });
      if (accountRes.ok) {
        const accountData = (await accountRes.json()) as { webIds?: Record<string, string> };
        const webIds = accountData.webIds;
        if (webIds && typeof webIds === 'object') {
          const firstUrl = Object.keys(webIds)[0];
          if (firstUrl) webId = firstUrl;
        }
      }
    }

    if (!webId) {
      console.error('No WebID found. Specify --web-id explicitly.');
      process.exit(1);
    }

    const cred = await createClientCredentials(token, controls.clientCredentials, webId, argv.name);
    if (!cred) {
      console.error('Failed to create credentials.');
      process.exit(1);
    }

    console.log('Credentials created:');
    console.log(`  client_id:     ${cred.id}`);
    console.log(`  client_secret: ${cred.secret}`);
    console.log(`  webId:         ${webId}`);

    if (!argv.output) {
      saveCredentials({
        url: baseUrl,
        clientId: cred.id,
        clientSecret: cred.secret ?? '',
        webId,
      });
      console.log(`\nSaved to ${getConfigPath().replace('/config.json', '/')}`);
    }
  },
};

const listCommand: CommandModule<AuthArgs, ListArgs> = {
  command: 'list',
  describe: 'List client credentials',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    const token = await login(argv.email, argv.password, baseUrl);
    if (!token) {
      console.error('Login failed.');
      process.exit(1);
    }

    const creds = await listClientCredentials(token, baseUrl);
    if (creds.length === 0) {
      console.log('No client credentials found.');
      return;
    }

    console.log(`Found ${creds.length} credential(s):\n`);
    for (const c of creds) {
      console.log(`  ${c.id}`);
      if (c.webId) console.log(`    webId: ${c.webId}`);
    }
  },
};

const revokeCommand: CommandModule<AuthArgs, RevokeArgs> = {
  command: 'revoke',
  describe: 'Revoke a client credential',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' })
      .option('client-id', { type: 'string', demandOption: true, description: 'Client ID to revoke' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    const token = await login(argv.email, argv.password, baseUrl);
    if (!token) {
      console.error('Login failed.');
      process.exit(1);
    }

    const ok = await revokeClientCredential(token, argv['client-id'], baseUrl);
    if (ok) {
      console.log(`Credential ${argv['client-id']} revoked.`);
    } else {
      console.error(`Failed to revoke credential ${argv['client-id']}.`);
      process.exit(1);
    }
  },
};

const logoutCommand: CommandModule<AuthArgs, AuthArgs> = {
  command: 'logout',
  describe: 'Remove stored credentials from ~/.xpod/',
  builder: (yargs) => yargs,
  handler: async () => {
    clearCredentials();
    console.log('Credentials removed.');
  },
};

export const authCommand: CommandModule<object, AuthArgs> = {
  command: 'auth',
  describe: 'Authentication and credential management',
  builder: (yargs) =>
    yargs
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .command(loginCommand)
      .command(createCredentialsCommand)
      .command(logoutCommand)
      .command(listCommand)
      .command(revokeCommand)
      .demandCommand(1, 'Please specify an auth subcommand'),
  handler: () => {
    // parent command, no-op
  },
};
