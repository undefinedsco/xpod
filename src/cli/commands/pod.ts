import type { CommandModule } from 'yargs';
import {
  checkServer,
  login,
  getAccountData,
  createPod,
} from '../lib/css-account';

interface PodArgs {
  url: string;
}

interface PodAuthArgs extends PodArgs {
  email: string;
  password: string;
}

interface PodCreateArgs extends PodAuthArgs {
  name: string;
}

function resolveUrl(url: string): string {
  const raw = url || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

async function loginOrExit(email: string, password: string, baseUrl: string): Promise<string> {
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

const podCreateCommand: CommandModule<PodArgs, PodCreateArgs> = {
  command: 'create <name>',
  describe: 'Create a new pod',
  builder: (yargs) =>
    yargs
      .positional('name', { type: 'string', demandOption: true, description: 'Pod name' })
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);
    const token = await loginOrExit(argv.email, argv.password, baseUrl);

    const data = await getAccountData(token, baseUrl);
    if (!data?.controls.pod) {
      console.error('Cannot find pod creation endpoint.');
      process.exit(1);
    }

    const result = await createPod(token, data.controls.pod, argv.name);
    if (!result) {
      console.error(`Failed to create pod "${argv.name}".`);
      process.exit(1);
    }

    console.log(`Pod created:`);
    console.log(`  URL:   ${result.podUrl}`);
    console.log(`  WebID: ${result.webId}`);
  },
};

const podListCommand: CommandModule<PodArgs, PodAuthArgs> = {
  command: 'list',
  describe: 'List all pods for the account',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);
    const token = await loginOrExit(argv.email, argv.password, baseUrl);

    const data = await getAccountData(token, baseUrl);
    if (!data) {
      console.error('Failed to get account info.');
      process.exit(1);
    }

    const podEntries = Object.entries(data.pods);
    if (podEntries.length === 0) {
      console.log('No pods found.');
      return;
    }

    console.log(`Found ${podEntries.length} pod(s):\n`);
    for (const [url, name] of podEntries) {
      console.log(`  ${name}`);
      console.log(`    URL: ${url}`);
    }

    const webIdEntries = Object.entries(data.webIds);
    if (webIdEntries.length > 0) {
      console.log(`\nWebIDs:`);
      for (const [url] of webIdEntries) {
        console.log(`  ${url}`);
      }
    }
  },
};

const podDeleteCommand: CommandModule<PodArgs, PodAuthArgs & { name: string }> = {
  command: 'delete <name>',
  describe: 'Delete a pod (not yet supported)',
  builder: (yargs) =>
    yargs
      .positional('name', { type: 'string', demandOption: true, description: 'Pod name' })
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' }),
  handler: async () => {
    console.error('Pod deletion is not yet supported by CSS.');
    console.error('Please delete the pod manually through the server admin interface.');
    process.exit(1);
  },
};

export const podCommand: CommandModule<object, PodArgs> = {
  command: 'pod',
  describe: 'Pod management',
  builder: (yargs) =>
    yargs
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .command(podCreateCommand)
      .command(podListCommand)
      .command(podDeleteCommand)
      .demandCommand(1, 'Please specify a pod subcommand'),
  handler: () => {},
};
