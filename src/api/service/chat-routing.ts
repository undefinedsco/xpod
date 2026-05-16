import {
  supportsMessagesApi,
  supportsResponsesApi,
} from './provider-registry';

export type ChatExecutionRoute = 'ai-gateway' | 'provider';
export type ProviderProtocolRoute = 'native' | 'chat-fallback';

export async function resolveChatExecutionRoute(input: {
  model?: string;
  shouldUseAiGateway(model?: string): Promise<boolean>;
}): Promise<ChatExecutionRoute> {
  return await input.shouldUseAiGateway(input.model) ? 'ai-gateway' : 'provider';
}

export function resolveResponsesProviderRoute(baseUrl: string): ProviderProtocolRoute {
  return supportsResponsesApi(baseUrl) ? 'native' : 'chat-fallback';
}

export function resolveMessagesProviderRoute(baseUrl: string): ProviderProtocolRoute {
  return supportsMessagesApi(baseUrl) ? 'native' : 'chat-fallback';
}
