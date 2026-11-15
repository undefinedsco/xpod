// Compatibility bridge; canonical runtime implementation belongs to xpod-client.
export { getSolidHomeDir, getSolidAuthDir, getSolidCredentialsPath, saveCredentials, loadCredentials, clearCredentials, isClientCredentials, isOidcOAuth, getClientCredentials, getOAuthCredentials } from '@undefineds.co/xpod-client';
export type { AuthType, StoredConfig, ClientCredentialsSecrets, OidcOAuthSecrets, StoredSecrets } from '@undefineds.co/xpod-client';
