import {
  decodePlaintextAiCredentialSecret,
  parseCredentialEnvelope,
  type AiCredentialSecret,
  type AiCredentialSecretDecoder,
} from '../../../ai/service/AiCredentialSecret';
import type { CredentialVault } from './CredentialVault';

export interface AiCredentialSecretDecoderOptions {
  /** Decodes wrapped (secret-cell / Cloud KMS) envelopes the Pod stores. */
  vault?: CredentialVault;
}

/**
 * Reads a Pod credential secret the way the Gateway does: plaintext payloads
 * first, then the configured credential vault. Embedding/indexing consumers use
 * this so an AI Connections credential behaves the same on both surfaces.
 */
export function createAiCredentialSecretDecoder(
  options: AiCredentialSecretDecoderOptions = {},
): AiCredentialSecretDecoder {
  return async (row, context): Promise<AiCredentialSecret | undefined> => {
    const plaintext = decodePlaintextAiCredentialSecret(row);
    if (plaintext) {
      return plaintext;
    }
    const envelope = parseCredentialEnvelope(row.encryptedSecret);
    if (!envelope || !options.vault) {
      return undefined;
    }
    try {
      return await options.vault.open(
        { webId: context.webId },
        context.credentialIri ?? '',
        context.provider ?? '',
        envelope as never,
      );
    } catch {
      // A wrapped secret this runtime cannot open is treated as unavailable, the
      // same as any other credential the deployment cannot use.
      return undefined;
    }
  };
}
