/**
 * 默认 AI 配置服务
 *
 * 当用户没有配置任何 AI provider 时，使用 OpenRouter 免费模型
 * 智能识别用户输入中的 AI 配置信息并存储到 Pod
 */

import { getLoggerFor } from 'global-logger-factory';
import { drizzle } from 'drizzle-solid';
import { Provider } from '../schema/provider';
import { Model } from '../schema/model';
import { Credential } from '../../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';

const logger = getLoggerFor('DefaultAiConfigService');

const schema = {
  provider: Provider,
  model: Model,
  credential: Credential,
};

/**
 * 默认 AI 配置（OpenRouter 免费模型）
 */
export const DEFAULT_AI_CONFIG = {
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: '', // 用户需要填入自己的 OpenRouter API Key
  model: 'stepfun/step-3.5-flash:free',
  displayName: 'OpenRouter Free',
};

/**
 * 从用户输入中识别 AI 配置信息
 */
export interface ParsedAiConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  proxyUrl?: string;
}

/**
 * 识别用户输入中的 AI 配置信息
 */
export function parseAiConfigFromInput(input: string): ParsedAiConfig | null {
  const result: ParsedAiConfig = {};
  
  // 识别 API Key (常见的 key 格式)
  const apiKeyPatterns = [
    /(?:api[_-]?key|key|token|sk)[\s:=]+["']?([a-zA-Z0-9_\-]{20,})["']?/i,
    /(sk-[a-zA-Z0-9]{20,})/i,
    /([a-f0-9]{32,})/i,
  ];
  
  for (const pattern of apiKeyPatterns) {
    const match = input.match(pattern);
    if (match) {
      result.apiKey = match[1];
      break;
    }
  }
  
  // 识别 Provider / Base URL
  const providerPatterns: Record<string, RegExp[]> = {
    openai: [/openai\.com/i, /api\.openai\.com/i],
    google: [/google.*gemini/i, /generativelanguage\.googleapis\.com/i, /gemini/i],
    anthropic: [/anthropic/i, /claude/i, /api\.anthropic\.com/i],
    deepseek: [/deepseek/i, /api\.deepseek\.com/i],
    openrouter: [/openrouter/i, /openrouter\.ai/i],
    ollama: [/ollama/i, /localhost:11434/i],
    mistral: [/mistral/i, /api\.mistral\.ai/i],
    cohere: [/cohere/i, /api\.cohere\.ai/i],
    zhipu: [/zhipu/i, /智谱/i, /bigmodel/i],
  };
  
  for (const [name, patterns] of Object.entries(providerPatterns)) {
    for (const pattern of patterns) {
      if (pattern.test(input)) {
        result.provider = name;
        break;
      }
    }
    if (result.provider) break;
  }
  
  // 识别 Base URL
  const urlPattern = /(https?:\/\/[a-zA-Z0-9\-\.]+(?:\:\d+)?(?:\/[a-zA-Z0-9\-\/]*)?)/i;
  const urlMatch = input.match(urlPattern);
  if (urlMatch) {
    result.baseUrl = urlMatch[1];
  }
  
  // 识别 Model
  const modelPatterns = [
    // OpenAI
    /gpt-4[\w\-]*/i,
    /gpt-3\.5-turbo/i,
    // Google
    /gemini-[\w\-]+/i,
    // Anthropic
    /claude-[\w\-]+/i,
    // DeepSeek
    /deepseek-[\w\-]+/i,
    // Llama
    /llama-[\d\.]+[\w\-]*/i,
    // Mistral
    /mistral-[\w\-]+/i,
    // Qwen
    /qwen[\w\-]*/i,
    // 通用
    /["']([a-zA-Z0-9\/\-\:]+free)["']/i,
    /model[:\s=]+["']?([a-zA-Z0-9\/\-\:_\.]+)["']?/i,
  ];
  
  for (const pattern of modelPatterns) {
    const match = input.match(pattern);
    if (match) {
      result.model = match[0].replace(/["']/g, '');
      break;
    }
  }
  
  // 识别 Proxy URL
  const proxyPattern = /proxy[:\s=]+["']?(https?:\/\/[^"'\s]+)["']?/i;
  const proxyMatch = input.match(proxyPattern);
  if (proxyMatch) {
    result.proxyUrl = proxyMatch[1];
  }
  
  // 如果什么都没识别到，返回 null
  if (Object.keys(result).length === 0) {
    return null;
  }
  
  logger.debug(`Parsed AI config from input: ${JSON.stringify(result)}`);
  return result;
}

/**
 * 获取完整的 AI 配置（默认 + 解析出的）
 */
export function getDefaultAiConfig(userInput?: string): {
  baseURL: string;
  apiKey: string;
  model: string;
  displayName: string;
  parsedConfig?: ParsedAiConfig;
} {
  const parsedConfig = userInput ? parseAiConfigFromInput(userInput) : null;
  
  // 如果用户提供了 baseUrl，使用用户的；否则使用默认
  const baseURL = parsedConfig?.baseUrl || 
    (parsedConfig?.provider ? getDefaultBaseUrl(parsedConfig.provider) : DEFAULT_AI_CONFIG.baseURL);
  
  // 使用用户提供的 API Key 或空字符串
  const apiKey = parsedConfig?.apiKey || DEFAULT_AI_CONFIG.apiKey;
  
  // 使用用户提供的模型或默认模型
  const model = parsedConfig?.model || DEFAULT_AI_CONFIG.model;
  
  return {
    baseURL,
    apiKey,
    model,
    displayName: parsedConfig?.provider 
      ? `${parsedConfig.provider.charAt(0).toUpperCase() + parsedConfig.provider.slice(1)}` 
      : DEFAULT_AI_CONFIG.displayName,
    parsedConfig: parsedConfig || undefined,
  };
}

/**
 * 根据 provider 名称获取默认 base URL
 */
function getDefaultBaseUrl(provider: string): string {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    anthropic: 'https://api.anthropic.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    ollama: 'http://localhost:11434/v1',
    mistral: 'https://api.mistral.ai/v1',
    cohere: 'https://api.cohere.ai/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  };
  return urls[provider.toLowerCase()] || DEFAULT_AI_CONFIG.baseURL;
}

/**
 * 保存 AI 配置到 Pod
 * 
 * 注意：这是一个占位实现，实际的保存逻辑需要调用 PodChatKitStore 的方法
 * 或通过 API 端点进行保存
 */
export async function saveAiConfigToPod(
  _podBaseUrl: string,
  config: ParsedAiConfig,
  _authenticatedFetch: typeof fetch,
  _webId?: string,
): Promise<{ success: boolean; message: string }> {
  const logger = getLoggerFor('DefaultAiConfigService');
  
  // 验证必要的字段
  if (!config.provider && !config.baseUrl) {
    return { success: false, message: '无法识别 AI Provider' };
  }
  if (!config.apiKey) {
    return { success: false, message: '无法识别 API Key' };
  }
  
  const providerId = config.provider || 'custom';
  const displayName = config.provider 
    ? config.provider.charAt(0).toUpperCase() + config.provider.slice(1)
    : 'Custom Provider';
  
  logger.debug(`AI config parsed: provider=${providerId}, model=${config.model}`);
  
  return { 
    success: true, 
    message: `已识别 AI 配置：${displayName}${config.model ? ` (${config.model})` : ''}。请在设置中确认保存。` 
  };
}
