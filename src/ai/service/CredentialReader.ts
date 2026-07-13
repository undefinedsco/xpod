import type { AiCredential } from './types';

/**
 * 凭据读取器抽象基类
 */
export abstract class CredentialReader {
  public abstract getAiCredential(
    podBaseUrl: string,
    providerId: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
    options?: { credentialId?: string },
  ): Promise<AiCredential | null>;
}
