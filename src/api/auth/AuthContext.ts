/**
 * Authentication context representing the authenticated caller
 * 
 * Authenticated caller context.
 * - Solid Token: user provides Bearer or DPoP token
 * - API Key: third-party provides client_id, API Server exchanges for token
 * - Node Token: edge node provides node API key
 */

export interface SolidAuthContext {
  type: 'solid';
  webId: string;
  accountId?: string;
  clientId?: string;
  clientSecret?: string;  // For client credentials auth
  displayName?: string;
  accessToken?: string;
  tokenType?: 'Bearer' | 'DPoP';
  /** Whether this was authenticated via API Key (client credentials) */
  viaApiKey?: boolean;
}

export interface NodeAuthContext {
  type: 'node';
  nodeId: string;
  accountId?: string;
}

export type AuthContext = SolidAuthContext | NodeAuthContext;

export function isSolidAuth(ctx: AuthContext): ctx is SolidAuthContext {
  return ctx.type === 'solid';
}

export function isNodeAuth(ctx: AuthContext): ctx is NodeAuthContext {
  return ctx.type === 'node';
}

/**
 * Get webId from auth context
 */
export function getWebId(ctx: AuthContext): string | undefined {
  return ctx.type === 'solid' ? ctx.webId : undefined;
}

/**
 * Get display name from auth context
 */
export function getDisplayName(ctx: AuthContext): string | undefined {
  return ctx.type === 'solid' ? ctx.displayName : undefined;
}

/**
 * Get accountId from auth context (if available)
 */
export function getAccountId(ctx: AuthContext): string | undefined {
  return ctx.accountId;
}

export function getNodeId(ctx: AuthContext): string | undefined {
  return ctx.type === 'node' ? ctx.nodeId : undefined;
}
