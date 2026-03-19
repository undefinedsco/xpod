/**
 * Agent session initialization and execution for xpod CLI.
 *
 * Uses pi-coding-agent for the agent runtime (tools, extensions).
 * All LLM calls go through xpod API (/v1/chat/completions).
 * Server-side handles provider routing based on user's Pod config.
 */

import { SECRETARY_SYSTEM_PROMPT } from './secretary-prompt';
import { saveMessage, saveToolCall, createThread, loadThread } from './pod-thread-store';
import type { Session } from '@inrupt/solid-client-authn-node';
import * as os from 'os';
import * as path from 'path';

// Dynamic imports for ESM-only packages.
// Use indirect Function('return import(...)') to prevent TypeScript from
// converting `import()` to `require()` under CommonJS module output.
const dynamicImport = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<any>;

type PiCodingAgent = typeof import('@mariozechner/pi-coding-agent');
type AgentSession = import('@mariozechner/pi-coding-agent').AgentSession;
type AgentSessionEvent = import('@mariozechner/pi-coding-agent').AgentSessionEvent;
type CreateAgentSessionResult = import('@mariozechner/pi-coding-agent').CreateAgentSessionResult;
type InteractiveMode = import('@mariozechner/pi-coding-agent').InteractiveMode;
type Model = import('@mariozechner/pi-ai').Model<any>;

export interface InitAgentOptions {
  session: Session;       // Authenticated Solid session (for Pod ops)
  apiKey: string;         // xpod API key (sk-xxx format, for LLM proxy fallback)
  xpodUrl: string;        // xpod server URL (fallback endpoint)
  model?: string;         // Model ID override
  chatId: string;         // Chat ID (from getOrCreateDefaultChat)
  workspace?: string;     // Working directory path
  threadId?: string;      // Optional thread ID to continue
}

/**
 * Build a Model object for an OpenAI-compatible endpoint.
 */
function buildModel(baseUrl: string, modelId: string): Model {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

/**
 * Resolve AI config: always use xpod API proxy.
 * Server-side handles provider routing based on user's Pod config.
 */
async function resolveAiConfig(
  xpodUrl: string,
  apiKey: string,
  modelOverride?: string,
): Promise<{ model: Model; providerApiKey: string; source: string }> {
  const base = xpodUrl.endsWith('/') ? `${xpodUrl}v1` : `${xpodUrl}/v1`;
  return {
    model: buildModel(base, modelOverride || 'default'),
    providerApiKey: apiKey,
    source: 'xpod API',
  };
}

/**
 * Initialize an AgentSession with Pod-specific configuration.
 *
 * LLM routing: Pod AI config → direct provider call; fallback → xpod API proxy.
 */
export async function initAgent(opts: InitAgentOptions): Promise<{ agent: AgentSession; threadId: string }> {
  const {
    session,
    apiKey,
    xpodUrl,
    model: modelOverride,
    chatId,
    workspace = process.cwd(),
    threadId: existingThreadId,
  } = opts;

  // Create or use existing thread (workspace stored as first-class field)
  const threadId = existingThreadId ?? await createThread(session, chatId, workspace);

  // Dynamic import ESM packages (must bypass tsc's CJS transform)
  const piCodingAgent = await dynamicImport('@mariozechner/pi-coding-agent') as PiCodingAgent;
  const { createAgentSession, AuthStorage, SessionManager, SettingsManager, DefaultResourceLoader } = piCodingAgent;

  // 1. Resolve AI config (always use xpod API)
  const aiConfig = await resolveAiConfig(xpodUrl, apiKey, modelOverride);
  console.error(`[xpod] AI source: ${aiConfig.source}, model: ${aiConfig.model.id}`);

  // 2. Inject API key for the openai provider
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey('openai', aiConfig.providerApiKey);

  // 3. SessionManager with local persistence
  const sessionDir = path.join(os.homedir(), '.xpod', 'sessions');
  const sessionManager = SessionManager.create(workspace, sessionDir);
  const settingsManager = SettingsManager.inMemory();

  // 4. Resource loader with extensions, skills, and themes enabled
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    settingsManager,
    systemPrompt: SECRETARY_SYSTEM_PROMPT,
    noExtensions: false,
    noSkills: false,
    noPromptTemplates: false,
    noThemes: false,
  });
  await resourceLoader.reload();

  // 5. Create agent session (allow runtime model/thinking switching)
  const result: CreateAgentSessionResult = await createAgentSession({
    cwd: workspace,
    authStorage,
    model: aiConfig.model,
    thinkingLevel: 'off', // User can change via Ctrl+T in interactive mode
    sessionManager,
    settingsManager,
    resourceLoader,
  });

  const { session: agent } = result;

  // 6. Load history for continue mode
  if (existingThreadId) {
    const threadData = await loadThread(session, chatId, existingThreadId);
    if (threadData && threadData.messages.length > 0) {
      console.error(`[xpod] Loading ${threadData.messages.length} messages from thread ${existingThreadId}`);

      // Convert Pod messages to AgentMessage format and add to session
      for (const msg of threadData.messages) {
        const agentMessage: any = {
          role: msg.role,
          content: [{ type: 'text', text: msg.content }],
        };

        // Add message to session history
        sessionManager.appendMessage(agentMessage);
      }
    }
  }

  // Track current assistant message for audit
  let currentAssistantMessage = '';
  const currentToolCalls = new Map<string, any>();

  // 6. Set up event handlers for audit
  agent.subscribe(async (event: AgentSessionEvent) => {
    try {
      // Audit: track tool call start
      if (event.type === 'tool_execution_start') {
        currentToolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          arguments: event.args,
          status: 'pending',
        });
      }

      // Audit: track assistant message updates
      if (event.type === 'message_update' && event.message.role === 'assistant') {
        const content = event.message.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text') {
              currentAssistantMessage = part.text;
            }
          }
        }
      }

      // Audit: save assistant message when complete
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (currentAssistantMessage) {
          await saveMessage(session, chatId, threadId, {
            role: 'assistant',
            content: currentAssistantMessage,
            timestamp: new Date().toISOString(),
          });
          currentAssistantMessage = '';
        }
      }

      // Audit: save tool call when complete
      if (event.type === 'tool_execution_end') {
        const toolCall = currentToolCalls.get(event.toolCallId);
        if (toolCall) {
          toolCall.output = event.result;
          toolCall.status = event.isError ? 'failed' : 'completed';
          await saveToolCall(session, chatId, threadId, toolCall);
          currentToolCalls.delete(event.toolCallId);
        }
      }
    } catch (error) {
      console.error('Error in event handler:', error);
    }
  });

  return { agent, threadId };
}

/**
 * Run in print mode: send one message, output result, exit.
 * Uses pi-coding-agent's runPrintMode for proper formatting.
 */
export async function runOnce(
  agent: AgentSession,
  message: string,
  session: Session,
  chatId: string,
  threadId: string,
): Promise<void> {
  await saveMessage(session, chatId, threadId, {
    role: 'user',
    content: message,
    timestamp: new Date().toISOString(),
  });

  const piCodingAgent = await dynamicImport('@mariozechner/pi-coding-agent') as PiCodingAgent;
  await piCodingAgent.runPrintMode(agent, {
    mode: 'text',
    initialMessage: message,
  });
}

/**
 * Run in interactive mode using pi-coding-agent's full TUI.
 * Provides diff preview, tool execution visualization, multi-line editor, etc.
 */
export async function runInteractive(
  agent: AgentSession,
  _session: Session,
  _chatId: string,
  _threadId: string,
  initialPrompt?: string,
): Promise<void> {
  const piCodingAgent = await dynamicImport('@mariozechner/pi-coding-agent') as PiCodingAgent;
  const mode = new piCodingAgent.InteractiveMode(agent, {
    initialMessage: initialPrompt,
  });
  await mode.run();
}
