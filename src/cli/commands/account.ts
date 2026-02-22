import type { CommandModule } from 'yargs';
import {
  checkServer,
  login,
  getAccountData,
} from '../lib/css-account';

interface AccountArgs {
  url: string;
}

interface AccountAuthArgs extends AccountArgs {
  email: string;
  password: string;
}

function resolveUrl(url: string): string {
  const raw = url || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

const accountCreateCommand: CommandModule<AccountArgs, AccountAuthArgs> = {
  command: 'create',
  describe: 'Create a new account (register)',
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

    // CSS uses the same endpoint for register and login.
    // POST to .account/login/password/ with new email creates the account.
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
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .command(accountCreateCommand)
      .command(accountListCommand)
      .demandCommand(1, 'Please specify an account subcommand'),
  handler: () => {},
};
