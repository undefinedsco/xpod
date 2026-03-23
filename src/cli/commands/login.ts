/**
 * xpod login - OAuth login for AI providers
 *
 * Usage:
 *   xpod login codebuddy
 *   xpod login anthropic
 */

import type { CommandModule } from 'yargs';
import { loadCredentials, getClientCredentials } from '../lib/credentials-store';
import { authenticate } from '../lib/solid-auth';
import { loadPiAiOAuthUtils, type OAuthAuthInfo, type OAuthPrompt } from '../lib/pi-optional';
import { saveOAuthCredential } from '../lib/oauth-credential-manager';
import { registerCustomOAuthProviders } from '../lib/oauth-providers';
import { promptText } from '../lib/prompt';

interface LoginArgs {
  provider?: string;
}

const loginCommand: CommandModule<{}, LoginArgs> = {
  command: 'login [provider]',
  describe: 'Login to an AI provider (OAuth)',
  builder: (yargs) =>
    yargs.positional('provider', {
      type: 'string',
      description: 'Provider name (e.g., codebuddy, anthropic)',
    }),
  handler: async (argv) => {
    // 1. 检查 Solid credentials
    const creds = loadCredentials();
    if (!creds) {
      console.error('Error: No Solid credentials found.');
      console.error('Please run: xpod auth create-credentials');
      process.exit(1);
    }

    const clientCreds = getClientCredentials(creds);
    if (!clientCreds) {
      console.error('Error: Client credentials not found.');
      process.exit(1);
    }

    // 2. 认证到 Pod
    let auth;
    try {
      auth = await authenticate(clientCreds.clientId, clientCreds.clientSecret, creds.url);
    } catch (error) {
      console.error(`Error: Failed to authenticate. ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    const { session } = auth;
    const podUrl = creds.url.endsWith('/') ? creds.url : `${creds.url}/`;

    await registerCustomOAuthProviders();

    // 3. 获取 provider
    let providerId = argv.provider;
    if (!providerId) {
      console.log('Available OAuth providers:');
      console.log('  codebuddy    - CodeBuddy (Tencent AI)');
      console.log('  anthropic    - Anthropic (Claude Pro/Max)');
      console.log('  github-copilot - GitHub Copilot');
      console.log('');
      providerId = await promptText('Enter provider name: ');
      if (!providerId) {
        console.error('Provider name is required');
        process.exit(1);
      }
    }

    const { getOAuthProvider } = await loadPiAiOAuthUtils();
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      console.error(`Error: Unknown provider: ${providerId}`);
      console.error('Available providers: codebuddy, anthropic, github-copilot');
      process.exit(1);
    }

    // 4. OAuth 登录
    console.log(`\n🔐 Starting ${provider.name} OAuth login...\n`);

    try {
      const credentials = await provider.login({
        onAuth: (info: OAuthAuthInfo) => {
          console.log(info.instructions || 'Please login in your browser');
          console.log(`\nURL: ${info.url}\n`);
        },
        onPrompt: async (prompt: OAuthPrompt) => {
          return await promptText(prompt.message + (prompt.placeholder ? ` (${prompt.placeholder})` : '') + ': ');
        },
        onProgress: (message: string) => {
          console.log(message);
        },
      });

      // 5. 保存到 Pod
      const providerUri = `${podUrl}settings/ai/providers.ttl#${providerId}`;
      await saveOAuthCredential(
        session,
        providerId,
        providerUri,
        credentials,
        `${provider.name} OAuth`,
      );

      console.log(`\n✓ ${provider.name} credentials saved to your Pod!`);
      console.log('You can now use the AI agent with this provider.\n');

      await session.logout();
    } catch (error) {
      console.error(`\nError during OAuth login: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  },
};

export const loginCommandModule: CommandModule = {
  command: 'login',
  describe: 'OAuth login for AI providers',
  builder: (yargs) => yargs.command(loginCommand),
  handler: () => {
    // Parent command, delegate to subcommands
  },
};
