import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq, and } from 'drizzle-solid';
import { CredentialReader } from './CredentialReader';
import type { AiCredential } from './types';
import { Credential } from '../credential/schema/tables';
import { Provider } from './schema/tables';
import { ServiceType, CredentialStatus } from '../credential/schema/types';

const schema = {
  credential: Credential,
  provider: Provider,
};

export class CredentialReaderImpl extends CredentialReader {
  protected readonly logger = getLoggerFor(this);

  public override async getAiCredential(
    podBaseUrl: string,
    providerId: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<AiCredential | null> {
    try {
      const session = {
        info: { isLoggedIn: true, webId },
        fetch: authenticatedFetch,
      };
      const db = drizzle(session, { schema });

      // 构建 Provider URI
      const providerUri = `${podBaseUrl}settings/ai/providers.ttl#${providerId}`;

      // 查询 credential，直接通过 provider URI 过滤
      const credentials = await db.query.credential.findMany({
        where: and(
          eq(Credential.service, ServiceType.AI),
          eq(Credential.status, CredentialStatus.ACTIVE),
          eq(Credential.provider, providerUri),
        ),
        with: {
          provider: true,
        },
      });

      if (credentials.length === 0) {
        this.logger.debug(`No active credential found for provider: ${providerId}`);
        return null;
      }

      // 随机选择一个（负载均衡）
      const credential = credentials[Math.floor(Math.random() * credentials.length)] as any;

      return {
        provider: providerId,
        apiKey: credential.apiKey,
        baseUrl: credential.baseUrl || credential.provider?.baseUrl || undefined,
        proxyUrl: credential.provider?.proxyUrl || undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to read credential for provider ${providerId}:`, error);
      return null;
    }
  }
}
