import {
  apiKeyCredentialResource,
  credentialResource,
  oauthCredentialResource,
} from '@undefineds.co/models';

export const ApiKeyCredential = apiKeyCredentialResource as any;
export const OAuthCredential = oauthCredentialResource as any;
export const Credential = credentialResource as any;

export type ApiKeyCredentialRow = typeof ApiKeyCredential.$inferSelect;
export type ApiKeyCredentialInsert = typeof ApiKeyCredential.$inferInsert;
export type OAuthCredentialRow = typeof OAuthCredential.$inferSelect;
export type OAuthCredentialInsert = typeof OAuthCredential.$inferInsert;
export type CredentialRow = typeof Credential.$inferSelect;
export type CredentialInsert = typeof Credential.$inferInsert;
