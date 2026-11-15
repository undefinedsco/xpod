import type { CommandModule } from 'yargs';
import {
  checkServer,
  login,
  getAccountControls,
  createClientCredentials,
  getAccountData,
} from '../lib/css-account';
import { saveCredentials, getSolidCredentialsPath } from '../lib/credentials-store';
import { promptPassword, promptText } from '../lib/prompt';
import { CliCommandError, handleCliError } from '../lib/output';

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

async function resolveWebId(baseUrl: string, token: string, explicitWebId?: string): Promise<string> {
  if (explicitWebId) {
    return explicitWebId;
  }

  const accountData = await getAccountData(token, baseUrl);
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
      .option('output', { type: 'boolean', default: false, description: 'Do not save credentials; print non-secret metadata only' }),
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

    const webId = await resolveWebId(baseUrl, token, argv['web-id'])
      .catch((error) => handleCliError(error, false));

    const credential = await createClientCredentials(token, controls.clientCredentials, webId, argv.name);
    if (!credential) {
      console.error('Failed to create client credentials.');
      process.exit(1);
    }

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
      console.log(`\nSaved to ${getSolidCredentialsPath()}`);
    } else {
      console.log('Credentials created.');
    }
    console.log(`  client_id: ${credential.id}`);
    console.log(`  webId:     ${webId}`);
  },
};
