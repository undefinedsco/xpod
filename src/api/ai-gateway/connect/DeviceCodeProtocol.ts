export type DeviceCodeHttpBodyEncoding = 'form' | 'json';

export type DeviceCodeBeginCodec = 'oauthDeviceCode' | 'oauthDeviceCodePkce' | 'deviceCodeJson';

export type DeviceCodePollCodec = 'oauthDeviceCode' | 'oauthDeviceCodePkce' | 'deviceCodeJson';

export type DeviceCodeTokenExchangeCodec = 'none' | 'authorizationCodeForm';

export type OAuthConnectMode = 'deviceCodeOAuth' | 'authorizationCodeOAuth';

export interface DeviceCodeEndpointDescriptor {
  endpoint: string;
  headers?: Record<string, string>;
}

export interface DeviceCodeProtocolDescriptor {
  id: string;
  verificationUriOrigins?: string[];
  begin: DeviceCodeEndpointDescriptor & {
    codec: DeviceCodeBeginCodec;
    deviceCodeField?: string;
    userCodeField?: string;
    verificationUriField?: string;
    verificationUriCompleteField?: string;
    expiresInField?: string;
    expiresAtField?: string;
    intervalField?: string;
    defaultExpiresInSeconds?: number;
    defaultIntervalSeconds?: number;
  };
  poll: DeviceCodeEndpointDescriptor & {
    codec: DeviceCodePollCodec;
    deviceCodeField?: string;
    pendingHttpStatuses?: number[];
  };
  tokenExchange?: DeviceCodeEndpointDescriptor & {
    codec: DeviceCodeTokenExchangeCodec;
    redirectUri?: string;
    codeField?: string;
    codeVerifierField?: string;
  };
  refresh?: DeviceCodeEndpointDescriptor & {
    codec: 'refreshTokenForm';
  };
  defaultVerificationUri?: string;
  accountIdClaim?: string | string[];
}

export interface AuthorizationCodeProtocolDescriptor {
  id: string;
  authorization: DeviceCodeEndpointDescriptor & {
    redirectUris: string[];
    scopes?: string[];
    responseType?: 'code';
    codeChallengeMethod?: 'S256';
    extraParams?: Record<string, string>;
  };
  token: DeviceCodeEndpointDescriptor & {
    codec: 'authorizationCodeForm';
    codeField?: string;
    codeVerifierField?: string;
  };
  refresh?: DeviceCodeEndpointDescriptor & {
    codec: 'refreshTokenForm';
  };
  accountIdClaim?: string | string[];
}

interface BaseOAuthIntegration {
  provider: string;
  offeringId: string;
  mode: OAuthConnectMode;
  integrationId: string;
  issuedBy: string;
  clientId: string;
  accountLabel?: string;
  accountId?: string;
}

export interface DeviceCodeOAuthIntegration extends BaseOAuthIntegration {
  mode: 'deviceCodeOAuth';
  protocol: DeviceCodeProtocolDescriptor;
}

export interface AuthorizationCodeOAuthIntegration extends BaseOAuthIntegration {
  mode: 'authorizationCodeOAuth';
  protocol: AuthorizationCodeProtocolDescriptor;
}

export type OAuthIntegration = DeviceCodeOAuthIntegration | AuthorizationCodeOAuthIntegration;
