const dynamicImport = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<any>;

function createMissingPackageError(packageName: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`Optional package ${packageName} is required for this CLI feature: ${reason}`);
}

export interface PiModel {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  maxTokens?: number;
}

export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  userId?: string;
  userName?: string;
}

export interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}

export interface OAuthPrompt {
  message: string;
  placeholder?: string;
}

export interface OAuthLoginCallbacks {
  onAuth(info: OAuthAuthInfo): void;
  onPrompt(prompt: OAuthPrompt): Promise<string>;
  onProgress(message: string): void;
}

export interface OAuthProviderInterface {
  id: string;
  name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey?(credentials: OAuthCredentials): string;
}

export interface PiAiOAuthUtils {
  getOAuthProvider(providerId: string): OAuthProviderInterface | undefined;
  registerOAuthProvider(provider: OAuthProviderInterface): void;
}

export interface PiAiModule {
  getModels(providerId: string): PiModel[];
}

export interface AgentSessionLike {
  subscribe(handler: (event: any) => void | Promise<void>): void;
}

export interface CreateAgentSessionResultLike {
  session: AgentSessionLike;
}

export interface SessionManagerLike {
  appendMessage(message: any): void;
}

export interface PiCodingAgentModule {
  createAgentSession(options: any): Promise<CreateAgentSessionResultLike>;
  runPrintMode(agent: AgentSessionLike, options: any): Promise<void>;
  AuthStorage: {
    inMemory(): {
      setRuntimeApiKey(provider: string, apiKey: string): void;
    };
  };
  SessionManager: {
    create(workspace: string, sessionDir: string): SessionManagerLike;
  };
  SettingsManager: {
    inMemory(): unknown;
  };
  DefaultResourceLoader: new(options: any) => {
    reload(): Promise<void>;
  };
  InteractiveMode: new(agent: AgentSessionLike, options: any) => {
    run(): Promise<void>;
  };
}

export async function loadPiAiOAuthUtils(): Promise<PiAiOAuthUtils> {
  try {
    return await dynamicImport('@mariozechner/pi-ai/dist/utils/oauth/index.js') as PiAiOAuthUtils;
  } catch (error) {
    throw createMissingPackageError('@mariozechner/pi-ai', error);
  }
}

export async function loadPiAi(): Promise<PiAiModule> {
  try {
    return await dynamicImport('@mariozechner/pi-ai') as PiAiModule;
  } catch (error) {
    throw createMissingPackageError('@mariozechner/pi-ai', error);
  }
}

export async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  try {
    return await dynamicImport('@mariozechner/pi-coding-agent') as PiCodingAgentModule;
  } catch (error) {
    throw createMissingPackageError('@mariozechner/pi-coding-agent', error);
  }
}
