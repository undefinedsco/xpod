export interface ExternalIdentity {
  subject: string;
  unionId?: string;
}

export interface ExternalLoginProvider {
  /** Unique login entry / connector instance, used in routes and browser transactions. */
  readonly id: string;
  /** Stable identity provider type, shared by different applications of the same provider. */
  readonly provider: string;
  readonly name: string;
  readonly namespace: string;
  authorizationUrl(state: string, redirectUri: string): Promise<string>;
  identity(code: string): Promise<ExternalIdentity>;
}
