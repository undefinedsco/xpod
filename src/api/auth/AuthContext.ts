/**
 * Authentication context representing the authenticated caller
 * 
 * Authenticated caller context.
 * - Solid Token: user provides Bearer or DPoP token
 * - CSS client credentials: third-party provides client_id/client_secret,
 *   API Server exchanges them for a Solid token
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
  dpopProof?: string;
  /** Whether this was authenticated via the sk-* client credentials wrapper */
  viaApiKey?: boolean;
}

export interface NodeAuthContext {
  type: 'node';
  nodeId: string;
  accountId?: string;
}

export interface ServiceAuthContext {
  type: 'service';
  serviceType: 'local' | 'business' | 'cloud' | 'compute';
  serviceId: string;
  scopes: string[];
}

export type AuthContext = SolidAuthContext | NodeAuthContext | ServiceAuthContext;

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
  if (ctx.type === 'solid') {
    return ctx.accountId;
  }
  if (ctx.type === 'node') {
    return ctx.accountId;
  }
  return undefined;
}

export function getNodeId(ctx: AuthContext): string | undefined {
  return ctx.type === 'node' ? ctx.nodeId : undefined;
}

export function isServiceAuth(ctx: AuthContext): ctx is ServiceAuthContext {
  return ctx.type === 'service';
}

/**
 * Check if a service auth context has the required scope.
 */
export function hasScope(ctx: AuthContext, scope: string): boolean {
  return ctx.type === 'service' && ctx.scopes.includes(scope);
}
