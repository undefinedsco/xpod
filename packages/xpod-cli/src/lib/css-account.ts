// Compatibility bridge; canonical runtime implementation belongs to xpod-client.
export { checkServer, login, getAccountControls, getAccountData, createPod, createClientCredentials, listClientCredentials, revokeClientCredential } from '@undefineds.co/xpod-client';
export type { AccountControls, AccountData, ClientCredential } from '@undefineds.co/xpod-client';
