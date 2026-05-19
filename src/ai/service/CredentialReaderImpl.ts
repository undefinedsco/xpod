import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq, and } from '@undefineds.co/drizzle-solid';
import { selectAIConfigCredential } from '@undefineds.co/models';
import { CredentialReader } from './CredentialReader';
import type { AiCredential } from './types';
import { Credential } from '../../credential/schema/tables';
import { Provider } from '../schema/provider';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';

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
      const db: any = drizzle(session, { schema });

      const credentials = await db.query.credential.findMany({
        where: and(
          eq(Credential.service, ServiceType.AI),
          eq(Credential.status, CredentialStatus.ACTIVE),
        ),
      });
      const providers = await db.query.provider.findMany();
      const selection = selectAIConfigCredential(providerId, credentials, providers);

      if (!selection) {
        this.logger.debug(`No active credential found for provider: ${providerId}`);
        return null;
      }

      return {
        provider: selection.providerId,
        apiKey: selection.apiKey,
        baseUrl: selection.baseUrl,
        proxyUrl: selection.proxyUrl,
      };
    } catch (error) {
      this.logger.error(`Failed to read credential for provider ${providerId}:`, error);
      return null;
    }
  }
}
