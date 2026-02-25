import type { CommandModule } from 'yargs';
import {
  checkServer,
  login,
  getAccountData,
} from '../lib/css-account';
import { loadCredentials } from '../lib/credentials-store';

interface AccountArgs {
  url?: string;
}

interface AccountAuthArgs extends AccountArgs {
  email?: string;
  password?: string;
}

function resolveUrl(url?: string, credUrl?: string): string {
  const raw = url || credUrl || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

async function loginOrExit(email: string | undefined, password: string | undefined, baseUrl: string): Promise<string> {
  if (!email || !password) {
    console.error('This command requires --email and --password.');
    console.error('Account management commands use the CSS Account API which requires email/password authentication.');
    process.exit(1);
  }

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

const accountCreateCommand: CommandModule<AccountArgs, AccountAuthArgs> = {
  command: 'create',
  describe: 'Create a new account (register)',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' }),
  handler: async (argv) => {
    const creds = loadCredentials();
    const baseUrl = resolveUrl(argv.url, creds?.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    const res = await fetch(`${baseUrl}.account/login/password/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email: argv.email, password: argv.password }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Account creation failed: ${res.status} ${text.slice(0, 200)}`);
      process.exit(1);
    }

    const data = (await res.json()) as { authorization?: string };
    if (data.authorization) {
      console.log('Account created and logged in.');
    } else {
      console.log('Account created.');
    }
  },
};

const accountListCommand: CommandModule<AccountArgs, AccountAuthArgs> = {
  command: 'list',
  describe: 'Show current account info',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', description: 'Account email' })
      .option('password', { type: 'string', description: 'Account password' }),
  handler: async (argv) => {
    const creds = loadCredentials();
    const baseUrl = resolveUrl(argv.url, creds?.url);
    const token = await loginOrExit(argv.email, argv.password, baseUrl);

    const data = await getAccountData(token, baseUrl);
    if (!data) {
      console.error('Failed to get account info.');
      process.exit(1);
    }

    const podEntries = Object.entries(data.pods);
    const webIdEntries = Object.entries(data.webIds);
    const credEntries = Object.entries(data.clientCredentials);

    console.log('Account info:\n');

    if (podEntries.length > 0) {
      console.log(`  Pods (${podEntries.length}):`);
      for (const [url, name] of podEntries) {
        console.log(`    ${name} — ${url}`);
      }
    } else {
      console.log('  Pods: none');
    }

    if (webIdEntries.length > 0) {
      console.log(`\n  WebIDs (${webIdEntries.length}):`);
      for (const [url] of webIdEntries) {
        console.log(`    ${url}`);
      }
    }

    if (credEntries.length > 0) {
      console.log(`\n  Client credentials (${credEntries.length}):`);
      for (const [url, webId] of credEntries) {
        const id = url.split('/').filter(Boolean).pop() ?? url;
        console.log(`    ${id} → ${webId}`);
      }
    }
  },
};

export const accountCommand: CommandModule<object, AccountArgs> = {
  command: 'account',
  describe: 'Account management',
  builder: (yargs) =>
    yargs
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
      })
      .command(accountCreateCommand)
      .command(accountListCommand)
      .demandCommand(1, 'Please specify an account subcommand'),
  handler: () => {},
};
