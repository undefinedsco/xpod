import type { CommandModule } from 'yargs';
import {
  checkServer,
  login,
  getAccountControls,
  createClientCredentials,
} from '../lib/css-account';
import { saveCredentials, getConfigPath } from '../lib/credentials-store';
import { promptPassword, promptText } from '../lib/prompt';

interface LoginArgs {
  url?: string;
  email?: string;
  password?: string;
  'web-id'?: string;
  name?: string;
  output?: boolean;
}

function resolveUrl(url?: string): string {
  const raw = url || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

async function resolveWebId(baseUrl: string, token: string, explicitWebId?: string): Promise<string | undefined> {
  if (explicitWebId) {
    return explicitWebId;
  }

  const accountRes = await fetch(`${baseUrl}.account/`, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
  });
  if (!accountRes.ok) {
    return undefined;
  }

  const accountData = await accountRes.json() as { webIds?: Record<string, string> };
  const webIds = accountData.webIds;
  if (!webIds || typeof webIds !== 'object') {
    return undefined;
  }

  return Object.keys(webIds)[0];
}

export const loginCommandModule: CommandModule<object, LoginArgs> = {
  command: 'login',
  describe: 'Login to xpod/Solid and store CLI client credentials',
  builder: (yargs) =>
    yargs
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .option('email', { type: 'string', description: 'Account email (will prompt if not provided)' })
      .option('password', { type: 'string', description: 'Account password (will prompt securely if not provided)' })
      .option('web-id', { type: 'string', description: 'WebID to bind credentials to' })
      .option('name', { type: 'string', description: 'Credential label' })
      .option('output', { type: 'boolean', default: false, description: 'Print credentials instead of saving to ~/.xpod/' }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!(await checkServer(baseUrl))) {
      console.error(`Cannot reach server at ${baseUrl}`);
      process.exit(1);
    }

    let email = argv.email;
    if (!email) {
      email = await promptText('Email: ');
      if (!email) {
        console.error('Email is required');
        process.exit(1);
      }
    }

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

    const webId = await resolveWebId(baseUrl, token, argv['web-id']);
    if (!webId) {
      console.error('No WebID found. Specify --web-id explicitly.');
      process.exit(1);
    }

    const credential = await createClientCredentials(token, controls.clientCredentials, webId, argv.name);
    if (!credential) {
      console.error('Failed to create client credentials.');
      process.exit(1);
    }

    console.log('Credentials created:');
    console.log(`  client_id:     ${credential.id}`);
    console.log(`  client_secret: ${credential.secret}`);
    console.log(`  webId:         ${webId}`);

    if (!argv.output) {
      saveCredentials({
        url: baseUrl,
        webId,
        authType: 'client_credentials',
        secrets: {
          clientId: credential.id,
          clientSecret: credential.secret ?? '',
        },
      });
      console.log(`\nSaved to ${getConfigPath().replace('/config.json', '/')}`);
    }
  },
};
