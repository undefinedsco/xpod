/**
 * Embedding 相关类型定义
 */

/**
 * AI 凭据
 */
export interface AiCredential {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
}