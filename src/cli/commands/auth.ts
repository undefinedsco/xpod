import type { CommandModule } from 'yargs';
import {
  checkServer,
  login,
  getAccountControls,
  getAccountData,
  createClientCredentials,
  listClientCredentials,
  revokeClientCredential,
} from '../lib/css-account';
import { saveCredentials, clearCredentials, getSolidCredentialsPath } from '../lib/credentials-store';
import { promptPassword, promptText } from '../lib/prompt';
import { getStoredAuthStatus } from '../lib/auth-context';
import { CliCommandError, handleCliError, writeJsonResult } from '../lib/output';

interface AuthArgs {
  url?: string;
  json?: boolean;
}

interface LoginArgs extends AuthArgs {
  email?: string;
  password?: string;
  issuer?: string;
  'web-id'?: string;
}

interface CreateCredentialsArgs extends AuthArgs {
  email?: string;
  password?: string;
  'web-id'?: string;
  name?: string;
  output?: boolean;
}

interface ListArgs extends AuthArgs {
  email?: string;
  password?: string;
}

interface RevokeArgs extends AuthArgs {
  email?: string;
  password?: string;
  'client-id': string;
}

function resolveUrl(url?: string): string {
  const raw = url || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

async function resolveExplicitWebId(input: {
  token: string;
  baseUrl: string;
  explicitWebId?: string;
}): Promise<string> {
  if (input.explicitWebId) {
    return input.explicitWebId;
  }

  const accountData = await getAccountData(input.token, input.baseUrl);
  const webIds = accountData ? Object.keys(accountData.webIds) : [];
  if (webIds.length === 1 && webIds[0]) {
    return webIds[0];
  }
  if (webIds.length > 1) {
    throw new CliCommandError(
      'webid_ambiguous',
      'Multiple WebIDs are configured. Re-run with --web-id to select the acting identity.',
      2,
      { webIds },
    );
  }
  throw new CliCommandError('webid_missing', 'No WebID found. Specify --web-id explicitly.', 2);
}

const loginCommand: CommandModule<AuthArgs, LoginArgs> = {
  command: 'login',
  describe: 'Login and store CLI client credentials',
  builder: (yargs) =>
    yargs
      .option('issuer', { type: 'string', description: 'Issuer/base URL alias for --url' })
      .option('email', { type: 'string', description: 'Account email (will prompt if not provided)' })
      .option('password', { type: 'string', description: 'Account password (will prompt securely if not provided)' })
      .option('web-id', { type: 'string', description: 'WebID to bind credentials to when multiple identities exist' })
      .option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.issuer ?? argv.url);

    if (!(await checkServer(baseUrl))) {
      const error = new Error(`Cannot reach server at ${baseUrl}`);
      handleCliError(error, argv.json === true, 'server_unreachable');
    }

    // Prompt for email if not provided
    let email = argv.email;
    if (!email) {
      email = await promptText('Email: ');
      if (!email) {
        console.error('Email is required');
        process.exit(1);
      }
    }

    // Prompt for password if not provided (secure input)
    let password = argv.password;
    if (!password) {
      password = await promptPassword('Password: ');
      if (!password) {
        console.error('Password is required');
        process.exit(1);
      }
    }

    const token = await login(email, password, baseUrl);
    if (!token) {
      handleCliError(new Error('Login failed. Check email/password.'), argv.json === true, 'auth_failed');
    }

    const controls = await getAccountControls(token, baseUrl);
    if (!controls?.clientCredentials) {
      handleCliError(new Error('Cannot find client credentials endpoint.'), argv.json === true, 'credentials_endpoint_missing');
    }

    const webId = await resolveExplicitWebId({
      token,
      baseUrl,
      explicitWebId: argv['web-id'],
    }).catch((error) => handleCliError(error, argv.json === true));

    const cred = await createClientCredentials(token, controls.clientCredentials, webId, 'xpod-cli');
    if (!cred) {
      handleCliError(new Error('Failed to create credentials.'), argv.json === true, 'credentials_create_failed');
    }

    saveCredentials({
      url: baseUrl,
      webId,
      authType: 'client_credentials',
      secrets: {
        clientId: cred.id,
        clientSecret: cred.secret ?? '',
      },
    });

    const data = { baseUrl, webId, credentialsPath: getSolidCredentialsPath() };
    if (argv.json) {
      writeJsonResult(data);
      return;
    }
    console.log('Login successful. Credentials saved.');
    console.log(`  webId: ${webId}`);
    console.log(`  credentials: ${getSolidCredentialsPath()}`);
  },
};

const createCredentialsCommand: CommandModule<AuthArgs, CreateCredentialsArgs> = {
  command: 'create-credentials',
  describe: 'Create client credentials (client_id/secret)',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', description: 'Account email (will prompt if not provided)' })
      .option('password', { type: 'string', description: 'Account password (will prompt securely if not provided)' })
      .option('web-id', { type: 'string', description: 'WebID to bind credentials to' })
      .option('name', { type: 'string', description: 'Credential label' })
      .option('output', { type: 'boolean', default: false, description: 'Do not save credentials; print non-secret metadata only' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    // Prompt for email if not provided
    let email = argv.email;
    if (!email) {
      email = await promptText('Email: ');
      if (!email) {
        console.error('Email is required');
        process.exit(1);
      }
    }

    // Prompt for password if not provided (secure input)
    let password = argv.password;
    if (!password) {
      password = await promptPassword('Password: ');
      if (!password) {
        console.error('Password is required');
        process.exit(1);
      }
    }

    const token = await login(email, password, baseUrl);
    if (!token) {
      console.error('Login failed.');
      process.exit(1);
    }

    const controls = await getAccountControls(token, baseUrl);
    if (!controls?.clientCredentials) {
      console.error('Cannot find client credentials endpoint.');
      process.exit(1);
    }

    let webId: string;
    try {
      webId = await resolveExplicitWebId({
        token,
        baseUrl,
        explicitWebId: argv['web-id'],
      });
    } catch (error) {
      handleCliError(error, false);
    }

    const cred = await createClientCredentials(token, controls.clientCredentials, webId, argv.name);
    if (!cred) {
      console.error('Failed to create credentials.');
      process.exit(1);
    }

    if (!argv.output) {
      saveCredentials({
        url: baseUrl,
        webId,
        authType: 'client_credentials',
        secrets: {
          clientId: cred.id,
          clientSecret: cred.secret ?? '',
        },
      });
      console.log(`\nSaved to ${getSolidCredentialsPath()}`);
      console.log('\n✓ Setup complete! You can now use xpod commands without entering password.');
      console.log('  Example: xpod backup export');
    } else {
      console.log('Credentials created.');
    }
    console.log(`  client_id: ${cred.id}`);
    console.log(`  webId:     ${webId}`);
  },
};

const listCommand: CommandModule<AuthArgs, ListArgs> = {
  command: 'list',
  describe: 'List client credentials',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', description: 'Account email (will prompt if not provided)' })
      .option('password', { type: 'string', description: 'Account password (will prompt securely if not provided)' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    // Prompt for email if not provided
    let email = argv.email;
    if (!email) {
      email = await promptText('Email: ');
      if (!email) {
        console.error('Email is required');
        process.exit(1);
      }
    }

    // Prompt for password if not provided (secure input)
    let password = argv.password;
    if (!password) {
      password = await promptPassword('Password: ');
      if (!password) {
        console.error('Password is required');
        process.exit(1);
      }
    }

    const token = await login(email, password, baseUrl);
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
      .option('email', { type: 'string', description: 'Account email (will prompt if not provided)' })
      .option('password', { type: 'string', description: 'Account password (will prompt securely if not provided)' })
      .option('client-id', { type: 'string', demandOption: true, description: 'Client ID to revoke' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    // Prompt for email if not provided
    let email = argv.email;
    if (!email) {
      email = await promptText('Email: ');
      if (!email) {
        console.error('Email is required');
        process.exit(1);
      }
    }

    // Prompt for password if not provided (secure input)
    let password = argv.password;
    if (!password) {
      password = await promptPassword('Password: ');
      if (!password) {
        console.error('Password is required');
        process.exit(1);
      }
    }

    const token = await login(email, password, baseUrl);
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
  describe: 'Remove stored credentials from the shared Solid auth store',
  builder: (yargs) => yargs.option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: async (argv) => {
    clearCredentials();
    if (argv.json) {
      writeJsonResult({ authenticated: false });
      return;
    }
    console.log('Credentials removed.');
  },
};

const statusCommand: CommandModule<AuthArgs, AuthArgs> = {
  command: 'status',
  describe: 'Show stored authentication status',
  builder: (yargs) => yargs.option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: async (argv) => {
    const status = getStoredAuthStatus(argv.url);
    if (argv.json) {
      writeJsonResult(status);
      return;
    }
    if (!status.authenticated) {
      console.log('Not authenticated. Run `xpod auth login`.');
      return;
    }
    console.log('Authenticated.');
    console.log(`  webId:   ${status.webId}`);
    console.log(`  podRoot: ${status.podRoot}`);
    console.log(`  server:  ${status.baseUrl}`);
  },
};

const whoamiCommand: CommandModule<AuthArgs, AuthArgs> = {
  command: 'whoami',
  describe: 'Show acting WebID and Pod root',
  builder: (yargs) => yargs.option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: async (argv) => {
    const status = getStoredAuthStatus(argv.url);
    if (!status.authenticated) {
      if (argv.json) {
        handleCliError(new CliCommandError('auth_required', 'No credentials found. Run `xpod auth login` first.', 2), true);
      }
      console.log('Not authenticated. Run `xpod auth login`.');
      return;
    }
    if (argv.json) {
      writeJsonResult(status);
      return;
    }
    console.log(status.webId);
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
      })
      .command(statusCommand)
      .command(loginCommand)
      .command(createCredentialsCommand)
      .command(logoutCommand)
      .command(whoamiCommand)
      .command(listCommand)
      .command(revokeCommand)
      .demandCommand(1, 'Please specify an auth subcommand'),
  handler: () => {
    // parent command, no-op
  },
};
