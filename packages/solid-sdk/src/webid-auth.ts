export interface LoginEndpointDescriptor {
  url: string;
  label: string;
}

export interface WebIdLoginRouteDescriptor {
  id: string;
  label: string;
  description?: string;
  badge?: {
    label: string;
    tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
  };
  identityProvider: LoginEndpointDescriptor;
  storageProvider?: LoginEndpointDescriptor;
  availability: 'ready' | 'starting' | 'unavailable';
  unavailableReason?: string;
}

export interface RememberedWebIdLogin {
  displayName: string;
  avatarUrl?: string;
  webId?: string;
  routeId: string;
}

export interface StorageBinding {
  storageUrl: string;
  webId: string;
  label?: string;
}

export interface WebIdLoginTransaction {
  id: string;
  route: WebIdLoginRouteDescriptor;
  selectedStorage?: StorageBinding;
  authorizationSurface: 'redirect' | 'popup' | 'embedded' | 'external';
  prompt?: 'login' | 'consent' | 'select_account';
  discovery: 'standard' | 'strict';
  authorizationParameters?: Readonly<Record<string, string>>;
  returnTo?: string;
}

export type WebIdAuthState =
  | { status: 'restoring'; remembered?: RememberedWebIdLogin }
  | { status: 'anonymous'; remembered?: RememberedWebIdLogin }
  | { status: 'connecting'; route: WebIdLoginRouteDescriptor }
  | { status: 'authenticated'; webId: string }
  | { status: 'expired'; remembered?: RememberedWebIdLogin }
  | { status: 'error'; message: string; retryRouteId?: string };

/**
 * Hosts can omit cancel/retry when their authorization surface cannot provide
 * a reversible operation (for example, after a full-page redirect begins).
 */
export interface WebIdLoginActions {
  start(transaction: WebIdLoginTransaction): Promise<void> | void;
  cancel?: () => Promise<void> | void;
  retry?: (transaction?: WebIdLoginTransaction) => Promise<void> | void;
  logout(options?: unknown): Promise<void> | void;
}

const ENDPOINT_PROTOCOLS = new Set(['http:', 'https:']);
const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
  'state',
  'redirect_uri',
  'client_id',
  'response_type',
  'code_challenge',
  'code_challenge_method',
]);

function normalizeEndpoint(
  endpoint: LoginEndpointDescriptor,
  fieldName: string,
): LoginEndpointDescriptor {
  if (!endpoint || typeof endpoint.url !== 'string' || endpoint.url.trim() === '') {
    throw new TypeError(`${fieldName}.url must be a non-empty absolute URL`);
  }
  if (typeof endpoint.label !== 'string') {
    throw new TypeError(`${fieldName}.label must be a string`);
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint.url.trim());
  } catch {
    throw new TypeError(`${fieldName}.url must be a valid absolute URL`);
  }
  if (!ENDPOINT_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError(`${fieldName}.url must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${fieldName}.url must not contain credentials`);
  }
  if (parsed.hash) {
    throw new TypeError(`${fieldName}.url must not contain a fragment`);
  }

  return {
    url: parsed.href,
    label: endpoint.label,
  };
}

function normalizeStorageBinding(binding: StorageBinding): StorageBinding {
  if (!binding || typeof binding.storageUrl !== 'string' || binding.storageUrl.trim() === '') {
    throw new TypeError('selectedStorage.storageUrl must be a non-empty absolute URL');
  }
  if (typeof binding.webId !== 'string' || binding.webId.trim() === '') {
    throw new TypeError('selectedStorage.webId must be a non-empty identifier URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(binding.storageUrl.trim());
  } catch {
    throw new TypeError('selectedStorage.storageUrl must be a valid absolute URL');
  }
  if (!ENDPOINT_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError('selectedStorage.storageUrl must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('selectedStorage.storageUrl must not contain credentials');
  }
  if (parsed.hash) {
    throw new TypeError('selectedStorage.storageUrl must not contain a fragment');
  }

  return {
    storageUrl: parsed.href,
    webId: binding.webId,
    ...(binding.label === undefined ? {} : { label: binding.label }),
  };
}

function ensureEnum<T extends string>(value: T, values: readonly T[], fieldName: string): T {
  if (!values.includes(value)) {
    throw new TypeError(`${fieldName} has an unsupported value`);
  }
  return value;
}

export function normalizeWebIdLoginRoute(
  input: WebIdLoginRouteDescriptor,
): WebIdLoginRouteDescriptor {
  if (!input || typeof input.id !== 'string' || input.id.trim() === '') {
    throw new TypeError('route.id must be a non-empty opaque identifier');
  }
  if (typeof input.label !== 'string') {
    throw new TypeError('route.label must be a string');
  }

  const normalized: WebIdLoginRouteDescriptor = {
    id: input.id.trim(),
    label: input.label,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.badge === undefined ? {} : {
      badge: {
        label: input.badge.label,
        tone: ensureEnum(input.badge.tone, ['neutral', 'primary', 'success', 'warning', 'danger'], 'route.badge.tone'),
      },
    }),
    identityProvider: normalizeEndpoint(input.identityProvider, 'route.identityProvider'),
    ...(input.storageProvider === undefined ? {} : {
      storageProvider: normalizeEndpoint(input.storageProvider, 'route.storageProvider'),
    }),
    availability: ensureEnum(input.availability, ['ready', 'starting', 'unavailable'], 'route.availability'),
    ...(input.unavailableReason === undefined ? {} : { unavailableReason: input.unavailableReason }),
  };

  return normalized;
}

function decodeForValidation(value: string): string {
  let decoded = value;
  for (let index = 0; index < 4; index += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new TypeError('returnTo contains malformed percent encoding');
    }
    if (next === decoded) {
      return decoded;
    }
    decoded = next;
  }
  return decoded;
}

function matchesAllowedPrefix(pathname: string, allowedPrefixes: readonly string[]): boolean {
  return allowedPrefixes.some((prefix) => {
    if (prefix === '/') {
      return pathname.startsWith('/');
    }
    const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
  });
}

export function normalizeApplicationReturnTo(
  value: string | undefined,
  allowedPrefixes: readonly string[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('returnTo must be a non-empty application path');
  }

  const normalized = value.trim();
  const decoded = decodeForValidation(normalized);
  const pathname = decoded.split(/[?#]/, 1)[0];

  if (
    !normalized.startsWith('/')
    || normalized.startsWith('//')
    || normalized.includes('\\')
    || decoded.includes('\\')
    || /^[a-z][a-z\d+.-]*:/i.test(decoded)
    || decoded.startsWith('//')
    || pathname.split('/').some((segment) => segment === '..')
    || !matchesAllowedPrefix(pathname, allowedPrefixes)
  ) {
    throw new TypeError('returnTo must be a safe path within the application allow-list');
  }

  return normalized;
}

export function normalizeWebIdLoginTransaction(
  input: WebIdLoginTransaction,
): WebIdLoginTransaction {
  if (!input || typeof input.id !== 'string' || input.id.trim() === '') {
    throw new TypeError('transaction.id must be a non-empty opaque identifier');
  }

  const authorizationParameters = input.authorizationParameters === undefined
    ? undefined
    : { ...input.authorizationParameters };
  if (authorizationParameters) {
    for (const key of Object.keys(authorizationParameters)) {
      if (RESERVED_AUTHORIZATION_PARAMETERS.has(key.toLowerCase())) {
        throw new TypeError(`authorizationParameters cannot override ${key}`);
      }
    }
  }

  const prompt = input.prompt === undefined
    ? undefined
    : ensureEnum(input.prompt, ['login', 'consent', 'select_account'] as const, 'transaction.prompt');

  return {
    id: input.id,
    route: normalizeWebIdLoginRoute(input.route),
    ...(input.selectedStorage === undefined ? {} : {
      selectedStorage: normalizeStorageBinding(input.selectedStorage),
    }),
    authorizationSurface: ensureEnum(
      input.authorizationSurface,
      ['redirect', 'popup', 'embedded', 'external'],
      'transaction.authorizationSurface',
    ),
    ...(prompt === undefined ? {} : { prompt }),
    discovery: ensureEnum(input.discovery, ['standard', 'strict'], 'transaction.discovery'),
    ...(authorizationParameters === undefined ? {} : { authorizationParameters }),
    ...(input.returnTo === undefined ? {} : {
      returnTo: normalizeApplicationReturnTo(input.returnTo, ['/']),
    }),
  };
}

export { normalizeStorageBinding };
