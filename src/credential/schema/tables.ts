import {
  apiKeyCredentialTable,
  credentialTable,
  oauthCredentialTable,
} from '@undefineds.co/models';

export const ApiKeyCredential = apiKeyCredentialTable as any;
export const OAuthCredential = oauthCredentialTable as any;
export const Credential = credentialTable as any;

export type ApiKeyCredentialRow = typeof ApiKeyCredential.$inferSelect;
export type ApiKeyCredentialInsert = typeof ApiKeyCredential.$inferInsert;
export type OAuthCredentialRow = typeof OAuthCredential.$inferSelect;
export type OAuthCredentialInsert = typeof OAuthCredential.$inferInsert;
export type CredentialRow = typeof Credential.$inferSelect;
export type CredentialInsert = typeof Credential.$inferInsert;
