import type { AuthContext, ServiceAuthContext, SolidAuthContext } from '../../auth/AuthContext';

export interface GatewayKeyPrincipal {
  webId: string;
  accountId?: string;
  scopes: string[];
  keyId: string;
}

export function isGatewayApiKeyPrincipal(auth: AuthContext | undefined): auth is SolidAuthContext & {
  viaGatewayApiKey: true;
  gatewayKeyId: string;
  scopes: string[];
} {
  return auth?.type === 'solid' && auth.viaGatewayApiKey === true;
}

export function isInternalGatewayInvocationPrincipal(auth: AuthContext | undefined): auth is SolidAuthContext & {
  viaGatewayApiKey: true;
  internalInvocation: true;
  gatewayKeyId: string;
  scopes: string[];
} {
  return isGatewayApiKeyPrincipal(auth) && auth.internalInvocation === true;
}

export function canManageGatewayKeys(auth: AuthContext | undefined): boolean {
  if (!auth) {
    return false;
  }
  if (isGatewayApiKeyPrincipal(auth)) {
    return false;
  }
  if (auth.type === 'solid') {
    return Boolean(auth.webId);
  }
  return hasGatewayKeyManagementScope(auth);
}

export function ownerWebIdForGatewayKeyManagement(
  auth: AuthContext,
  requestedOwner: unknown,
): string | undefined {
  if (auth.type === 'solid') {
    return auth.webId;
  }
  if (hasGatewayKeyManagementScope(auth) && typeof requestedOwner === 'string' && requestedOwner.trim()) {
    return requestedOwner.trim();
  }
  return undefined;
}

function hasGatewayKeyManagementScope(auth: AuthContext): auth is ServiceAuthContext {
  return auth.type === 'service' && auth.scopes.includes('gateway:keys:write');
}
