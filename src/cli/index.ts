#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { logsCommand } from './commands/logs';
import { authCommand } from './commands/auth';
import { loginCommandModule } from './commands/login';
import { configCommand } from './commands/config';
import { importCommand } from './commands/import';
import { podCommand } from './commands/pod';
import { accountCommand } from './commands/account';
import { backupCommand, restoreCommand } from './commands/backup';
import { doctorCommand } from './commands/doctor';
import { loadCredentials, getClientCredentials } from './lib/credentials-store';
import { authenticate } from './lib/solid-auth';
import { initAgent, runOnce, runInteractive } from './lib/agent-session';
import { listThreads, getOrCreateDefaultChat } from './lib/pod-thread-store';
import { registerCustomOAuthProviders } from './lib/oauth-providers';
import { ensureAiCredentials } from './lib/ensure-ai-credentials';

// Known subcommands
const KNOWN_COMMANDS = [
  'start', 'stop', 'status', 'logs',
  'auth', 'login', 'config', 'import', 'pod',
  'account', 'backup', 'restore', 'doctor',
];

/**
 * Entry point: support both subcommands and default agent behavior.
 *
 * - Known subcommand → delegate to yargs
 * - `-p <prompt>` → print mode (one-shot)
 * - `-c` → continue last conversation (interactive)
 * - `<prompt>` → interactive with initial prompt
 * - No args → interactive REPL
 */
async function main() {
  // 注册自定义 OAuth providers（CodeBuddy 等）
  registerCustomOAuthProviders();

  const argv = process.argv.slice(2);

  // If first arg is a known command, delegate to yargs
  if (argv.length > 0 && KNOWN_COMMANDS.includes(argv[0])) {
    yargs(hideBin(process.argv))
      .scriptName('xpod')
      .usage('$0 <command> [options]')
      .command(startCommand)
      .command(stopCommand)
      .command(statusCommand)
      .command(logsCommand)
      .command(authCommand)
      .command(loginCommandModule)
      .command(configCommand)
      .command(importCommand)
      .command(podCommand)
      .command(accountCommand)
      .command(backupCommand)
      .command(restoreCommand)
      .command(doctorCommand)
      .demandCommand(1, 'Please specify a command')
      .strict()
      .help()
      .parse();
    return;
  }

  // Otherwise, run agent mode
  await runAgentMode(argv);
}

async function runAgentMode(argv: string[]) {
  // Parse agent-specific flags
  let printMode = false;
  let continueMode = false;
  let modelOverride: string | undefined;
  let prompt: string | undefined;

  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--print') {
      printMode = true;
    } else if (arg === '-c' || arg === '--continue') {
      continueMode = true;
    } else if (arg === '--model' && i + 1 < argv.length) {
      modelOverride = argv[++i];
    } else {
      args.push(arg);
    }
  }

  // Remaining args form the prompt
  if (args.length > 0) {
    prompt = args.join(' ');
  }

  // Load credentials
  const creds = loadCredentials();
  if (!creds) {
    console.error('Error: No credentials found. Please run `xpod auth create-credentials` first.');
    process.exit(1);
  }

  // Authenticate with Pod
  let auth;
  try {
    const clientCreds = getClientCredentials(creds);
    if (!clientCreds) {
      console.error('Error: OAuth authentication not yet supported. Please use client credentials.');
      process.exit(1);
    }
    auth = await authenticate(clientCreds.clientId, clientCreds.clientSecret, creds.url);
  } catch (error) {
    console.error(`Error: Failed to authenticate. ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const { session, apiKey } = auth;
  const workspace = process.cwd();

  // Check AI credentials (optional, uses platform default if not configured)
  const hasCredentials = await ensureAiCredentials(session);
  if (!hasCredentials) {
    process.exit(0); // User chose to configure first
  }

  // Get or create default CLI chat (1v1 with SecretaryAI)
  const chatId = await getOrCreateDefaultChat(session);

  // Resolve thread ID for continue mode
  let threadId: string | undefined;
  if (continueMode) {
    const threads = await listThreads(session, chatId);
    if (threads.length > 0) {
      threadId = threads[0]; // Most recent
      console.log(`Continuing thread: ${threadId}`);
    } else {
      console.log('No previous threads found, starting fresh.');
    }
  }

  // Initialize agent — LLM calls go through xpod API, no AI keys needed on client
  let result;
  try {
    result = await initAgent({
      session,
      apiKey,
      xpodUrl: creds.url,
      model: modelOverride,
      chatId,
      workspace,
      threadId,
    });
  } catch (error) {
    console.error(`Error initializing agent: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const { agent, threadId: activeThreadId } = result;

  // Run appropriate mode
  if (printMode) {
    if (!prompt) {
      console.error('Error: -p/--print requires a prompt');
      process.exit(1);
    }
    await runOnce(agent, prompt, session, chatId, activeThreadId);
    await session.logout();
    process.exit(0);
  } else {
    await runInteractive(agent, session, chatId, activeThreadId, prompt);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
