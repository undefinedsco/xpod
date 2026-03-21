#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { registerCustomOAuthProviders } from './lib/oauth-providers';

// Known subcommands
const KNOWN_COMMANDS = [
  'start', 'stop', 'status', 'logs',
  'auth', 'login', 'config', 'import', 'pod',
  'account', 'backup', 'restore', 'doctor',
];

function createRootParser() {
  return yargs(hideBin(process.argv))
    .scriptName('xpod')
    .usage('$0 <command> [options]')
    .epilog(`Commands: ${KNOWN_COMMANDS.join(', ')}`)
    .help()
    .version();
}

async function createCommandParser() {
  const [
    { startCommand },
    { stopCommand },
    { statusCommand },
    { logsCommand },
    { authCommand },
    { loginCommandModule },
    { configCommand },
    { importCommand },
    { podCommand },
    { accountCommand },
    { backupCommand, restoreCommand },
    { doctorCommand },
  ] = await Promise.all([
    import('./commands/start'),
    import('./commands/stop'),
    import('./commands/status'),
    import('./commands/logs'),
    import('./commands/auth'),
    import('./commands/login'),
    import('./commands/config'),
    import('./commands/import'),
    import('./commands/pod'),
    import('./commands/account'),
    import('./commands/backup'),
    import('./commands/doctor'),
  ]);

  return createRootParser()
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
    .strict()
    .help()
    .version();
}

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
  const wantsRootHelp = argv.includes('--help') || argv.includes('-h') || argv[0] === 'help';
  const wantsVersion = argv.includes('--version') || argv.includes('-v');

  // If first arg is a known command, delegate to yargs
  if (argv.length > 0 && KNOWN_COMMANDS.includes(argv[0])) {
    (await createCommandParser())
      .demandCommand(1, 'Please specify a command')
      .parse();
    return;
  }

  if (wantsRootHelp || wantsVersion) {
    createRootParser().parse();
    return;
  }

  // Otherwise, run agent mode
  await runAgentMode(argv);
}

async function runAgentMode(argv: string[]) {
  const [
    credentialsStore,
    solidAuth,
    agentSession,
    podThreadStore,
    aiCredentials,
  ] = await Promise.all([
    import('./lib/credentials-store'),
    import('./lib/solid-auth'),
    import('./lib/agent-session'),
    import('./lib/pod-thread-store'),
    import('./lib/ensure-ai-credentials'),
  ]);

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
  const creds = credentialsStore.loadCredentials();
  if (!creds) {
    console.error('Error: No credentials found. Please run `xpod auth create-credentials` first.');
    process.exit(1);
  }

  // Authenticate with Pod
  let auth;
  try {
    const clientCreds = credentialsStore.getClientCredentials(creds);
    if (!clientCreds) {
      console.error('Error: OAuth authentication not yet supported. Please use client credentials.');
      process.exit(1);
    }
    auth = await solidAuth.authenticate(clientCreds.clientId, clientCreds.clientSecret, creds.url);
  } catch (error) {
    console.error(`Error: Failed to authenticate. ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const { session, apiKey } = auth;
  const workspace = process.cwd();

  // Check AI credentials (optional, uses platform default if not configured)
  const hasCredentials = await aiCredentials.ensureAiCredentials(session);
  if (!hasCredentials) {
    process.exit(0); // User chose to configure first
  }

  // Get or create default CLI chat (1v1 with SecretaryAI)
  const chatId = await podThreadStore.getOrCreateDefaultChat(session);

  // Resolve thread ID for continue mode
  let threadId: string | undefined;
  if (continueMode) {
    const threads = await podThreadStore.listThreads(session, chatId);
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
    result = await agentSession.initAgent({
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
    await agentSession.runOnce(agent, prompt, session, chatId, activeThreadId);
    await session.logout();
    process.exit(0);
  } else {
    await agentSession.runInteractive(agent, session, chatId, activeThreadId, prompt);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
