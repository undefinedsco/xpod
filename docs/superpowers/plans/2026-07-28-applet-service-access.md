# Applet Service Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every Solid user grant an Xpod service WebID access to exact applet resources through a reusable Host SDK permission capability, then prove AI Connection works for a second browser WebID without forwarding browser DPoP tokens.

**Architecture:** Xpod publishes an authenticated, model-derived service-access descriptor and uses one stable service OIDC identity for Pod access. LinX implements a generic `solid.permissions` host capability over Inrupt access APIs; AI Connection discovers and verifies the descriptor before enabling Connect or Gateway Key mutations. Pod ACL/ACP remains the enforcement point, and the complete flow is verified with two real browser identities.

**Tech Stack:** TypeScript 5.9, Bun, Vitest, React, `@inrupt/solid-client`, `@inrupt/solid-client-authn-browser`, `@undefineds.co/models`, drizzle-solid, Solid OIDC/DPoP, Playwright.

---

## File map

### LinX

- `packages/extension-sdk/src/web.ts` — public host capability and permission data types only.
- `packages/extension-sdk/test/web-permissions.test.ts` — SDK surface contract.
- `apps/web/src/extensions/solid-permission-capability.ts` — Inrupt-backed resource creation, access inspection, grant, verification, and revoke adapter.
- `apps/web/src/extensions/solid-permission-capability.test.ts` — adapter behavior and safety validation.
- `apps/web/src/extensions/ai-connection-host-factory.ts` — attaches the permission capability to the host.
- `apps/web/src/extensions/ai-connection-host-factory.test.ts` — host capability wiring.
- `packages/ai-connection-extension/src/service-access.ts` — descriptor parsing and current-Pod validation.
- `packages/ai-connection-extension/src/ai-connection-client.ts` — authenticated descriptor request.
- `packages/ai-connection-extension/src/controller.tsx` — single-flight permission bootstrap and explicit state.
- `packages/ai-connection-extension/test/service-access.test.ts` — hostile/malformed descriptor rejection.
- `packages/ai-connection-extension/test/controller.test.tsx` — lifecycle and permission gating.
- `tests/e2e/specs/ai-connection-solid-runtime.spec.ts` — second browser WebID grant/write/read/revoke proof.

### Xpod

- `src/api/ai-gateway/auth/ClientCredentialsInternalPodAccessTokenProvider.ts` — stable service identity token cache.
- `tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts` — stable identity and changed-identity fail-closed behavior.
- `src/api/ai-gateway/service-access/AiConnectionServiceAccess.ts` — shared-model resource derivation and response contract.
- `tests/api/ai-gateway/AiConnectionServiceAccess.test.ts` — owner-bound resource derivation.
- `src/api/handlers/AiGatewayManagementHandler.ts` — authenticated discovery route.
- `tests/api/handlers/AiGatewayManagementHandler.test.ts` — route auth and response tests.
- `src/api/container/common.ts` — one singleton internal service identity shared by Gateway Key, Connect, quota, and inference repositories.
- `src/api/container/types.ts` — singleton registration type.
- `tests/api/container/config.test.ts` — dependency wiring.
- `src/api/ai-gateway/auth/PodGatewayAccessKeyRepository.ts` — service fetch only; no raw DPoP fallback.
- `src/api/ai-gateway/connect/index.ts` — service fetch only; no raw DPoP fallback.
- `tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts` — service identity access boundary.
- `tests/api/ai-gateway/ProviderConnectAdapters.test.ts` — service identity access boundary.

## Task 1: Add the generic Host SDK permission contract

**Files:**
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/extension-sdk/src/web.ts`
- Create: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/extension-sdk/test/web-permissions.test.ts`

- [ ] **Step 1: Write the failing public-contract test**

```ts
import { describe, expect, it, vi } from 'vitest'
import type {
  SolidPermissionCapability,
  SolidServiceAccessRequest,
  WebExtensionHost,
} from '../src/web'

describe('Solid permission host capability', () => {
  it('is host-owned and carries only service identity, exact resources, and access modes', async () => {
    const request: SolidServiceAccessRequest = {
      appletId: 'co.undefineds.ai-connection',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }
    const permissions: SolidPermissionCapability = {
      inspectAgentAccess: vi.fn(async () => ({ status: 'granted', resources: request.resources })),
      ensureAgentAccess: vi.fn(async () => ({ status: 'granted', resources: request.resources })),
      revokeAgentAccess: vi.fn(async () => ({ status: 'missing', resources: request.resources })),
    }
    const host = {
      solid: {
        session: {} as never,
        pod: { status: 'unavailable' as const },
        requireLogin: vi.fn(),
        permissions,
      },
      navigation: { openExternal: vi.fn() },
      capabilities: {},
    } satisfies WebExtensionHost

    await expect(host.solid.permissions.ensureAgentAccess(request))
      .resolves.toMatchObject({ status: 'granted' })
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
yarn workspace @undefineds.co/extension-sdk test --run test/web-permissions.test.ts
```

Expected: TypeScript transform fails because `SolidPermissionCapability` and `SolidServiceAccessRequest` are not exported and `permissions` is absent.

- [ ] **Step 3: Add the minimal public types**

Add to `packages/extension-sdk/src/web.ts`:

```ts
export interface SolidAgentAccess {
  read?: boolean
  append?: boolean
  write?: boolean
}

export interface SolidServiceAccessResource {
  id: string
  url: string
  mediaType: 'text/turtle'
  access: SolidAgentAccess
}

export interface SolidServiceAccessRequest {
  appletId: string
  service: {
    webId: string
    label: string
  }
  resources: SolidServiceAccessResource[]
}

export interface SolidServiceAccessStatus {
  status:
    | 'granted'
    | 'missing'
    | 'permissionDenied'
    | 'capabilityUnavailable'
  resources: SolidServiceAccessResource[]
  message?: string
}

export interface SolidPermissionCapability {
  inspectAgentAccess(
    request: SolidServiceAccessRequest,
  ): Promise<SolidServiceAccessStatus>
  ensureAgentAccess(
    request: SolidServiceAccessRequest,
  ): Promise<SolidServiceAccessStatus>
  revokeAgentAccess(
    request: SolidServiceAccessRequest,
  ): Promise<SolidServiceAccessStatus>
}
```

Extend `WebExtensionSolidCapability`:

```ts
export interface WebExtensionSolidCapability<Database = unknown> {
  readonly session: WebExtensionSolidSession
  readonly pod: WebExtensionSolidPod<Database>
  readonly permissions?: SolidPermissionCapability
  requireLogin(): Promise<void>
}
```

- [ ] **Step 4: Run SDK tests and build**

Run:

```bash
yarn workspace @undefineds.co/extension-sdk test
yarn workspace @undefineds.co/extension-sdk build
```

Expected: 4 test files pass and TypeScript emits without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/extension-sdk/src/web.ts packages/extension-sdk/test/web-permissions.test.ts
git commit -m "🧩 Let applet hosts broker precise Pod access" \
  -m "Constraint: Applets must not own WAC, ACP, OIDC, or DPoP mechanics
Confidence: high
Scope-risk: narrow
Tested: extension SDK tests and TypeScript build"
```

## Task 2: Implement the LinX Inrupt permission adapter

**Files:**
- Create: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/apps/web/src/extensions/solid-permission-capability.ts`
- Create: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/apps/web/src/extensions/solid-permission-capability.test.ts`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/apps/web/src/extensions/ai-connection-host-factory.ts`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/apps/web/src/extensions/ai-connection-host-factory.test.ts`

- [ ] **Step 1: Write failing validation and grant tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createSolidPermissionCapability } from './solid-permission-capability'

const request = {
  appletId: 'co.undefineds.ai-connection',
  service: {
    webId: 'https://id.example/xpod/profile/card#me',
    label: 'Xpod AI Connection',
  },
  resources: [{
    id: 'providerCredentials',
    url: 'https://pod.example/alice/settings/credentials.ttl',
    mediaType: 'text/turtle' as const,
    access: { read: true, append: true, write: true },
  }],
}

describe('createSolidPermissionCapability', () => {
  it('rejects resources outside the current Pod before making a request', async () => {
    const setAgentAccess = vi.fn()
    const capability = createSolidPermissionCapability({
      currentPodUrl: () => 'https://pod.example/alice/',
      fetch: vi.fn(),
      getAgentAccess: vi.fn(),
      setAgentAccess,
    })

    await expect(capability.ensureAgentAccess({
      ...request,
      resources: [{ ...request.resources[0], url: 'https://evil.example/credentials.ttl' }],
    })).rejects.toThrow('outside_current_pod')
    expect(setAgentAccess).not.toHaveBeenCalled()
  })

  it('creates a missing Turtle resource, grants exact access, and verifies it', async () => {
    const authenticatedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    const getAgentAccess = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ read: true, append: true, write: true })
    const setAgentAccess = vi.fn(async () => ({ read: true, append: true, write: true }))
    const capability = createSolidPermissionCapability({
      currentPodUrl: () => 'https://pod.example/alice/',
      fetch: authenticatedFetch,
      getAgentAccess,
      setAgentAccess,
    })

    await expect(capability.ensureAgentAccess(request))
      .resolves.toMatchObject({ status: 'granted' })
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      request.resources[0].url,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'Content-Type': 'text/turtle' }),
      }),
    )
    expect(setAgentAccess).toHaveBeenCalledWith(
      request.resources[0].url,
      request.service.webId,
      {
        read: true,
        append: true,
        write: true,
        controlRead: false,
        controlWrite: false,
      },
      expect.any(Object),
    )
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
yarn workspace @linx/web test --run src/extensions/solid-permission-capability.test.ts
```

Expected: FAIL because `createSolidPermissionCapability` does not exist.

- [ ] **Step 3: Implement validation, resource creation, grant, verification, and revoke**

Create `solid-permission-capability.ts`:

```ts
import * as universalAccess from '@inrupt/solid-client/universal'
import type {
  SolidAgentAccess,
  SolidPermissionCapability,
  SolidServiceAccessRequest,
  SolidServiceAccessResource,
  SolidServiceAccessStatus,
} from '@undefineds.co/extension-sdk/web'

interface PermissionAdapterOptions {
  currentPodUrl(): string | undefined
  fetch: typeof fetch
  getAgentAccess?: typeof universalAccess.getAgentAccess
  setAgentAccess?: typeof universalAccess.setAgentAccess
}

export function createSolidPermissionCapability(
  options: PermissionAdapterOptions,
): SolidPermissionCapability {
  const getAgentAccess = options.getAgentAccess ?? universalAccess.getAgentAccess
  const setAgentAccess = options.setAgentAccess ?? universalAccess.setAgentAccess

  async function validate(request: SolidServiceAccessRequest) {
    const podUrl = options.currentPodUrl()
    if (!podUrl) throw new Error('pod_unavailable')
    const root = new URL(podUrl)
    for (const resource of request.resources) {
      const url = new URL(resource.url)
      if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
        throw new Error('outside_current_pod')
      }
      if (resource.mediaType !== 'text/turtle') {
        throw new Error('unsupported_media_type')
      }
    }
  }

  async function accessFor(
    request: SolidServiceAccessRequest,
    resource: SolidServiceAccessResource,
  ): Promise<SolidAgentAccess | null> {
    return getAgentAccess(resource.url, request.service.webId, {
      fetch: options.fetch,
    })
  }

  function granted(expected: SolidAgentAccess, actual: SolidAgentAccess | null) {
    return Boolean(
      actual
      && (!expected.read || actual.read)
      && (!expected.append || actual.append)
      && (!expected.write || actual.write),
    )
  }

  async function inspectAgentAccess(
    request: SolidServiceAccessRequest,
  ): Promise<SolidServiceAccessStatus> {
    await validate(request)
    const access = await Promise.all(
      request.resources.map((resource) => accessFor(request, resource)),
    )
    return {
      status: access.every((value, index) => granted(request.resources[index].access, value))
        ? 'granted'
        : 'missing',
      resources: request.resources,
    }
  }

  return {
    inspectAgentAccess,
    async ensureAgentAccess(request) {
      await validate(request)
      for (const resource of request.resources) {
        const head = await options.fetch(resource.url, { method: 'HEAD' })
        if (head.status === 404) {
          const created = await options.fetch(resource.url, {
            method: 'PUT',
            headers: { 'Content-Type': resource.mediaType },
            body: '',
          })
          if (!created.ok) throw new Error(`resource_create_failed:${created.status}`)
        } else if (!head.ok) {
          throw new Error(`resource_inspect_failed:${head.status}`)
        }
        await setAgentAccess(
          resource.url,
          request.service.webId,
          {
            read: resource.access.read ?? false,
            append: resource.access.append ?? false,
            write: resource.access.write ?? false,
            controlRead: false,
            controlWrite: false,
          },
          { fetch: options.fetch },
        )
      }
      const status = await inspectAgentAccess(request)
      if (status.status !== 'granted') throw new Error('grant_verification_failed')
      return status
    },
    async revokeAgentAccess(request) {
      await validate(request)
      for (const resource of request.resources) {
        await setAgentAccess(
          resource.url,
          request.service.webId,
          {
            read: false,
            append: false,
            write: false,
            controlRead: false,
            controlWrite: false,
          },
          { fetch: options.fetch },
        )
      }
      return inspectAgentAccess(request)
    },
  }
}
```

- [ ] **Step 4: Wire the adapter through the AI Connection host**

In `ai-connection-host-factory.ts`, create one capability from the current Pod:

```ts
const permissions = createSolidPermissionCapability({
  currentPodUrl: () => solid.pod.status === 'ready'
    ? solid.pod.current.podUrl
    : undefined,
  fetch: solid.session.fetch,
})

return {
  solid: {
    ...solid,
    permissions,
  },
  navigation,
  capabilities,
}
```

Update the host-factory test to assert:

```ts
expect(host.solid.permissions).toEqual(expect.objectContaining({
  inspectAgentAccess: expect.any(Function),
  ensureAgentAccess: expect.any(Function),
  revokeAgentAccess: expect.any(Function),
}))
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
yarn workspace @linx/web test --run \
  src/extensions/solid-permission-capability.test.ts \
  src/extensions/ai-connection-host-factory.test.ts
yarn typecheck:web
```

Expected: all focused tests and TypeScript pass.

- [ ] **Step 6: Commit**

```bash
git add \
  apps/web/src/extensions/solid-permission-capability.ts \
  apps/web/src/extensions/solid-permission-capability.test.ts \
  apps/web/src/extensions/ai-connection-host-factory.ts \
  apps/web/src/extensions/ai-connection-host-factory.test.ts
git commit -m "🔐 Broker exact Pod grants through the applet host" \
  -m "Constraint: Inrupt universal access is experimental and must stay behind the SDK capability
Confidence: high
Scope-risk: moderate
Directive: Never grant a service resource outside the current Pod
Tested: focused Web tests and typecheck"
```

## Task 3: Make Xpod use one stable service identity

**Files:**
- Modify: `src/api/ai-gateway/auth/ClientCredentialsInternalPodAccessTokenProvider.ts`
- Modify: `tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts`
- Modify: `src/api/container/common.ts`
- Modify: `src/api/container/types.ts`
- Modify: `tests/api/container/config.test.ts`

- [ ] **Step 1: Write failing stable-identity tests**

Add:

```ts
it('uses one authoritative service identity for every delegated Pod', async () => {
  const tokenFetch = vi.fn(async () => Response.json({
    access_token: 'service-token',
    token_type: 'Bearer',
    expires_in: 300,
    webid: 'https://id.example/xpod-service/profile/card#me',
  }))
  const provider = new ClientCredentialsInternalPodAccessTokenProvider({
    tokenEndpoint: 'https://id.example/.oidc/token',
    clientId: 'service-client',
    clientSecret: 'service-secret',
    fetchImpl: tokenFetch as typeof fetch,
  })

  await provider.getTrustedFetch('https://pod.example/alice/profile/card#me')
  await provider.getTrustedFetch('https://pod.example/bob/profile/card#me')

  expect(tokenFetch).toHaveBeenCalledTimes(1)
  await expect(provider.getServicePrincipal()).resolves.toEqual({
    webId: 'https://id.example/xpod-service/profile/card#me',
  })
})

it('fails closed if a refreshed token changes service WebID', async () => {
  let now = 0
  const tokenFetch = vi.fn()
    .mockResolvedValueOnce(Response.json({
      access_token: 'first',
      token_type: 'Bearer',
      expires_in: 1,
      webid: 'https://id.example/xpod-service/profile/card#me',
    }))
    .mockResolvedValueOnce(Response.json({
      access_token: 'second',
      token_type: 'Bearer',
      expires_in: 300,
      webid: 'https://id.example/attacker/profile/card#me',
    }))
  const provider = new ClientCredentialsInternalPodAccessTokenProvider({
    tokenEndpoint: 'https://id.example/.oidc/token',
    clientId: 'service-client',
    clientSecret: 'service-secret',
    fetchImpl: tokenFetch as typeof fetch,
    now: () => now,
  })
  await provider.getServicePrincipal()
  now = 2_000
  await expect(provider.getServicePrincipal()).rejects.toThrow(
    'Gateway internal service WebID changed',
  )
})
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
bun test tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts
```

Expected: FAIL because `getServicePrincipal` and `now` are absent and the provider requests a token per owner.

- [ ] **Step 3: Implement one cached service token**

Change the provider to:

```ts
export interface InternalPodServicePrincipal {
  webId: string
}

export interface ClientCredentialsInternalPodAccessTokenProviderOptions {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  now?: () => number
}

type CachedToken = {
  accessToken: string
  tokenType: 'Bearer' | 'DPoP'
  expiresAt: number
  webId: string
}

private cached?: CachedToken
private verifiedServiceWebId?: string
private readonly now: () => number

public async getTrustedFetch(_owner: string): Promise<typeof fetch> {
  const token = await this.getAccessToken()
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `${token.tokenType} ${token.accessToken}`)
    }
    return this.fetchImpl(input, { ...init, headers })
  }
}

public async getServicePrincipal(): Promise<InternalPodServicePrincipal> {
  const token = await this.getAccessToken()
  return { webId: token.webId }
}

private async getAccessToken(): Promise<CachedToken> {
  const now = this.now()
  if (this.cached && this.cached.expiresAt - 30_000 > now) return this.cached
  const response = await this.fetchImpl(this.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'webid',
    }),
  })
  if (!response.ok) {
    throw new Error(`Gateway internal Pod token exchange failed: HTTP ${response.status}`)
  }
  const body = await response.json() as Record<string, unknown>
  const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined
  const webId = extractAuthoritativeWebIdFromTokenResponse(body)
  if (!accessToken || !webId) throw new Error('Gateway internal service token is incomplete')
  if (this.verifiedServiceWebId && this.verifiedServiceWebId !== webId) {
    throw new Error('Gateway internal service WebID changed')
  }
  this.verifiedServiceWebId = webId
  this.cached = {
    accessToken,
    webId,
    tokenType: body.token_type === 'DPoP' ? 'DPoP' : 'Bearer',
    expiresAt: now + (
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in
        : 300
    ) * 1000,
  }
  return this.cached
}
```

Do not include the target owner as a token request parameter and do not compare
the service WebID with the target owner.

- [ ] **Step 4: Register one singleton provider**

In `common.ts`, add:

```ts
gatewayInternalPodAccess: asFunction(({ config }: ApiContainerCradle) => {
  if (!config.gatewayInternalClientId || !config.gatewayInternalClientSecret) {
    throw new Error('Gateway internal Pod service credentials are required')
  }
  return new ClientCredentialsInternalPodAccessTokenProvider({
    tokenEndpoint: config.cssTokenEndpoint,
    clientId: config.gatewayInternalClientId,
    clientSecret: config.gatewayInternalClientSecret,
  })
}).singleton(),
```

Inject `gatewayInternalPodAccess` into Gateway Key, Connect, quota, and inference
repositories instead of constructing separate providers. Add the matching
property to `ApiContainerCradle`.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun test \
  tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts \
  tests/api/container/config.test.ts
bun run build:ts
```

Expected: tests and build pass.

- [ ] **Step 6: Commit**

```bash
git add \
  src/api/ai-gateway/auth/ClientCredentialsInternalPodAccessTokenProvider.ts \
  src/api/container/common.ts \
  src/api/container/types.ts \
  tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts \
  tests/api/container/config.test.ts
git commit -m "🔑 Give applet services one stable Solid identity" \
  -m "Constraint: The service token identity must stay independent from target Pod owners
Rejected: Target-owner impersonation | client credentials are bound to their authoritative WebID
Confidence: high
Scope-risk: moderate
Tested: service token, container configuration, and TypeScript tests"
```

## Task 4: Publish the authenticated AI Connection service-access descriptor

**Files:**
- Create: `src/api/ai-gateway/service-access/AiConnectionServiceAccess.ts`
- Create: `tests/api/ai-gateway/AiConnectionServiceAccess.test.ts`
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Modify: `tests/api/handlers/AiGatewayManagementHandler.test.ts`
- Modify: `src/api/container/common.ts`
- Modify: `src/api/container/types.ts`

- [ ] **Step 1: Write failing model-derived descriptor tests**

```ts
import { describe, expect, it } from 'vitest'
import { createAiConnectionServiceAccess } from '../../../src/api/ai-gateway/service-access/AiConnectionServiceAccess'

describe('createAiConnectionServiceAccess', () => {
  it('derives exact resources from the authenticated owner and service WebID', () => {
    const descriptor = createAiConnectionServiceAccess({
      ownerWebId: 'https://pod.example/alice/profile/card#me',
      serviceWebId: 'https://id.example/xpod/profile/card#me',
    })

    expect(descriptor).toMatchObject({
      appletId: 'co.undefineds.ai-connection',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
    })
    expect(descriptor.resources.map((resource) => resource.url)).toEqual([
      'https://pod.example/alice/settings/credentials.ttl',
      'https://pod.example/alice/settings/providers.ttl',
      'https://pod.example/alice/settings/ai/gateway/access-keys.ttl',
      'https://pod.example/alice/settings/ai/quota-snapshots.ttl',
    ])
    expect(descriptor.resources.every((resource) =>
      resource.access.controlRead === undefined
      && resource.access.controlWrite === undefined,
    )).toBe(true)
  })
})
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
bun test tests/api/ai-gateway/AiConnectionServiceAccess.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure descriptor factory**

```ts
import {
  aiProviderResource,
  credentialResource,
  gatewayAccessKeyResource,
  quotaSnapshotResource,
} from '@undefineds.co/models'
import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid'

export const AI_CONNECTION_APPLET_ID = 'co.undefineds.ai-connection'

export function createAiConnectionServiceAccess(input: {
  ownerWebId: string
  serviceWebId: string
}) {
  const podRoot = resolvePodBaseUrl(input.ownerWebId)
  const resourceUrl = (resource: { buildId(value: { id: string }): string }) =>
    new URL(resource.buildId({ id: '__service_access__' }).split('#')[0], podRoot).href

  return {
    appletId: AI_CONNECTION_APPLET_ID,
    service: {
      webId: input.serviceWebId,
      label: 'Xpod AI Connection',
    },
    resources: [
      ['providerCredentials', resourceUrl(credentialResource)],
      ['providerDefinitions', resourceUrl(aiProviderResource)],
      ['gatewayAccessKeys', resourceUrl(gatewayAccessKeyResource)],
      ['quotaSnapshots', resourceUrl(quotaSnapshotResource)],
    ].map(([id, url]) => ({
      id,
      url,
      mediaType: 'text/turtle' as const,
      access: { read: true, append: true, write: true },
    })),
  }
}
```

- [ ] **Step 4: Add the authenticated route**

Extend handler options:

```ts
servicePrincipal?: {
  getServicePrincipal(): Promise<{ webId: string }>
}
```

Register:

```ts
server.get('/api/applets/service-access/ai-connection', async (request, response) => {
  if (!authorizeProviderConnect(request, response)) return
  if (!options.servicePrincipal) {
    sendJson(response, 503, { error: 'AI Connection service identity is unavailable' })
    return
  }
  const service = await options.servicePrincipal.getServicePrincipal()
  sendJson(response, 200, createAiConnectionServiceAccess({
    ownerWebId: request.auth!.webId,
    serviceWebId: service.webId,
  }))
})
```

Wire the singleton provider into handler registration.

- [ ] **Step 5: Test auth and owner derivation**

Add handler tests that assert:

```ts
expect(await anonymousGet('/api/applets/service-access/ai-connection'))
  .toMatchObject({ status: 401 })

expect(await solidGet('/api/applets/service-access/ai-connection', {
  webId: 'https://pod.example/bob/profile/card#me',
})).toMatchObject({
  status: 200,
  body: expect.objectContaining({
    resources: expect.arrayContaining([
      expect.objectContaining({
        url: 'https://pod.example/bob/settings/credentials.ttl',
      }),
    ]),
  }),
})
```

- [ ] **Step 6: Run tests and build**

Run:

```bash
bun test \
  tests/api/ai-gateway/AiConnectionServiceAccess.test.ts \
  tests/api/handlers/AiGatewayManagementHandler.test.ts \
  tests/api/container/config.test.ts
bun run build:ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/api/ai-gateway/service-access/AiConnectionServiceAccess.ts \
  src/api/handlers/AiGatewayManagementHandler.ts \
  src/api/container/common.ts \
  src/api/container/types.ts \
  tests/api/ai-gateway/AiConnectionServiceAccess.test.ts \
  tests/api/handlers/AiGatewayManagementHandler.test.ts \
  tests/api/container/config.test.ts
git commit -m "🔎 Publish owner-bound applet service access" \
  -m "Constraint: Resource URLs must come only from the authenticated WebID and shared models
Confidence: high
Scope-risk: moderate
Directive: Never accept service or resource locators from request input
Tested: descriptor, management handler, container, and TypeScript tests"
```

## Task 5: Gate AI Connection lifecycle on verified Pod access

**Files:**
- Create: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/src/service-access.ts`
- Create: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/test/service-access.test.ts`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/src/ai-connection-client.ts`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/src/controller.tsx`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/test/client.test.ts`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/test/controller.test.tsx`

- [ ] **Step 1: Write failing descriptor validation tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseAiConnectionServiceAccess } from '../src/service-access'

const currentPodUrl = 'https://pod.example/alice/'

describe('parseAiConnectionServiceAccess', () => {
  it('accepts the expected applet and exact current-Pod resources', () => {
    expect(parseAiConnectionServiceAccess({
      appletId: 'co.undefineds.ai-connection',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }, currentPodUrl)).toMatchObject({
      appletId: 'co.undefineds.ai-connection',
    })
  })

  it.each([
    ['wrong applet', { appletId: 'evil.applet' }],
    ['foreign resource', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://evil.example/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true },
      }],
    }],
    ['control access', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, controlWrite: true },
      }],
    }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseAiConnectionServiceAccess({
      appletId: 'co.undefineds.ai-connection',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
      resources: [],
      ...patch,
    }, currentPodUrl)).toThrow()
  })
})
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
yarn workspace @undefineds.co/ai-connection test --run test/service-access.test.ts
```

Expected: FAIL because parser does not exist.

- [ ] **Step 3: Implement strict parsing**

```ts
import type { SolidServiceAccessRequest } from '@undefineds.co/extension-sdk/web'

export const AI_CONNECTION_APPLET_ID = 'co.undefineds.ai-connection'

export function parseAiConnectionServiceAccess(
  value: unknown,
  currentPodUrl: string,
): SolidServiceAccessRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid_descriptor')
  const input = value as Record<string, unknown>
  if (input.appletId !== AI_CONNECTION_APPLET_ID) throw new Error('invalid_applet_id')
  const service = input.service as Record<string, unknown> | undefined
  if (
    !service
    || typeof service.webId !== 'string'
    || typeof service.label !== 'string'
  ) throw new Error('invalid_service')
  const resources = Array.isArray(input.resources) ? input.resources : []
  const root = new URL(currentPodUrl)
  const parsed = resources.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('invalid_resource')
    const resource = value as Record<string, unknown>
    const url = new URL(String(resource.url))
    const access = resource.access as Record<string, unknown> | undefined
    if (
      url.origin !== root.origin
      || !url.pathname.startsWith(root.pathname)
      || resource.mediaType !== 'text/turtle'
      || access?.controlRead !== undefined
      || access?.controlWrite !== undefined
    ) throw new Error('invalid_resource')
    return {
      id: String(resource.id),
      url: url.href,
      mediaType: 'text/turtle' as const,
      access: {
        read: access?.read === true,
        append: access?.append === true,
        write: access?.write === true,
      },
    }
  })
  if (parsed.length === 0) throw new Error('empty_resources')
  return {
    appletId: AI_CONNECTION_APPLET_ID,
    service: {
      webId: service.webId,
      label: service.label,
    },
    resources: parsed,
  }
}
```

- [ ] **Step 4: Add client discovery**

Add to `AiConnectionClient`:

```ts
async getServiceAccess(): Promise<unknown> {
  return this.request('/api/applets/service-access/ai-connection')
}
```

Test an authenticated GET and non-2xx error normalization.

- [ ] **Step 5: Add single-flight permission bootstrap**

Add controller state:

```ts
type ServiceAccessState =
  | 'checking'
  | 'granted'
  | 'missing'
  | 'permissionDenied'
  | 'capabilityUnavailable'
  | 'invalidDescriptor'

const [serviceAccessState, setServiceAccessState] =
  useState<ServiceAccessState>('checking')
let accessPromise: Promise<void> | undefined
```

Implement:

```ts
async function ensureServiceAccess() {
  if (accessPromise) return accessPromise
  accessPromise = (async () => {
    if (!host.solid.permissions) {
      setServiceAccessState('capabilityUnavailable')
      return
    }
    if (host.solid.pod.status !== 'ready') {
      setServiceAccessState('missing')
      return
    }
    try {
      const raw = await client.getServiceAccess()
      const descriptor = parseAiConnectionServiceAccess(
        raw,
        host.solid.pod.current.podUrl,
      )
      const status = await host.solid.permissions.ensureAgentAccess(descriptor)
      setServiceAccessState(status.status === 'granted'
        ? 'granted'
        : status.status)
      if (status.status === 'granted') await loadProviders()
    } catch (error) {
      setServiceAccessState(
        error instanceof Error && error.message.startsWith('invalid_')
          ? 'invalidDescriptor'
          : 'permissionDenied',
      )
    } finally {
      accessPromise = undefined
    }
  })()
  return accessPromise
}
```

Expose `serviceAccessState` and `ensureServiceAccess` from the controller.
Change applet `activate()` to call `ensureServiceAccess()` rather than
`loadProviders()` directly. Disable Connect and Gateway Key mutation actions
until state is `granted`.

- [ ] **Step 6: Test StrictMode and missing capability**

Add tests:

```ts
await Promise.all([
  controller.ensureServiceAccess(),
  controller.ensureServiceAccess(),
])
expect(client.getServiceAccess).toHaveBeenCalledTimes(1)
expect(permissions.ensureAgentAccess).toHaveBeenCalledTimes(1)

const noCapability = createController(hostWithoutPermissions)
await noCapability.ensureServiceAccess()
expect(noCapability.serviceAccessState).toBe('capabilityUnavailable')
expect(client.listProviders).not.toHaveBeenCalled()
```

- [ ] **Step 7: Run package and host tests**

Run:

```bash
yarn workspace @undefineds.co/ai-connection test
yarn workspace @linx/web test --run \
  src/extensions/ai-connection-host.test.tsx \
  src/modules/layout/ai-connection-registry.test.tsx \
  src/standalone/standalone-applet-host.test.tsx
yarn typecheck:web
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add \
  packages/ai-connection-extension/src/service-access.ts \
  packages/ai-connection-extension/src/ai-connection-client.ts \
  packages/ai-connection-extension/src/controller.tsx \
  packages/ai-connection-extension/src/index.ts \
  packages/ai-connection-extension/test/service-access.test.ts \
  packages/ai-connection-extension/test/client.test.ts \
  packages/ai-connection-extension/test/controller.test.tsx
git commit -m "🛡️ Gate AI Connection on verified Pod grants" \
  -m "Constraint: Connect mutations must not run before the host verifies service access
Confidence: high
Scope-risk: moderate
Directive: Keep access-control mechanics outside the applet package
Tested: AI Connection, host, standalone, and Web typecheck suites"
```

## Task 6: Remove unsafe request-token Pod fallbacks

**Files:**
- Modify: `src/api/ai-gateway/auth/PodGatewayAccessKeyRepository.ts`
- Modify: `src/api/ai-gateway/connect/index.ts`
- Modify: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Modify: `tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts`
- Modify: `tests/api/ai-gateway/ProviderConnectAdapters.test.ts`
- Modify: `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`

- [ ] **Step 1: Write failing tests that reject raw DPoP fallback**

For each repository, use an internal service provider spy and a caller DPoP
context:

```ts
const serviceFetch = vi.fn(async () => new Response('', { status: 404 }))
const internalPodAccess = {
  getTrustedFetch: vi.fn(async () => serviceFetch as typeof fetch),
}
await repositoryOperation({
  auth: {
    type: 'solid',
    webId: 'https://pod.example/bob/profile/card#me',
    accessToken: 'browser-dpop-token',
    tokenType: 'DPoP',
    dpopProof: 'proof-for-management-url',
  },
})
expect(internalPodAccess.getTrustedFetch)
  .toHaveBeenCalledWith('https://pod.example/bob/profile/card#me')
expect(fetch).not.toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({
    headers: expect.objectContaining({
      Authorization: 'DPoP browser-dpop-token',
    }),
  }),
)
```

Add a failure test where service access returns 403 and assert the operation
throws `service_access_missing`, not an empty list.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test \
  tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts \
  tests/api/ai-gateway/ProviderConnectAdapters.test.ts \
  tests/api/ai-gateway/ProviderQuotaAdapters.test.ts
```

Expected: at least one test fails because request-auth fallback remains or 403
is not normalized.

- [ ] **Step 3: Require internal service fetch**

Replace each repository resolver with:

```ts
private async resolveTrustedFetch(owner: string): Promise<typeof fetch> {
  const trustedFetch = await this.internalPodAccess?.getTrustedFetch(owner)
  if (!trustedFetch) {
    throw new Error('AI Connection service identity is not configured')
  }
  return async (input, init) => {
    const response = await trustedFetch(input, init)
    if (response.status === 403) {
      throw new Error('service_access_missing')
    }
    return response
  }
}
```

Remove `createAuthFetch`, the internal-owner mismatch catch, and all code that
adds a caller's Bearer or DPoP token to a Pod request. Keep `AuthContext` only
where it is still needed to authorize the management route itself.

- [ ] **Step 4: Run tests and build**

Run:

```bash
bun test \
  tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts \
  tests/api/ai-gateway/ProviderConnectAdapters.test.ts \
  tests/api/ai-gateway/ProviderQuotaAdapters.test.ts
bun run build:ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add \
  src/api/ai-gateway/auth/PodGatewayAccessKeyRepository.ts \
  src/api/ai-gateway/connect/index.ts \
  src/api/ai-gateway/quota/ProviderQuotaAdapter.ts \
  tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts \
  tests/api/ai-gateway/ProviderConnectAdapters.test.ts \
  tests/api/ai-gateway/ProviderQuotaAdapters.test.ts
git commit -m "🔒 Keep browser DPoP outside service Pod access" \
  -m "Constraint: Xpod cannot generate a target-bound proof from a browser DPoP token
Rejected: Request-token fallback | invalid across resource URLs
Confidence: high
Scope-risk: moderate
Tested: Gateway Key, Connect, quota, and TypeScript suites"
```

## Task 7: Prove a second browser WebID can grant and use AI Connection

**Files:**
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/tests/e2e/specs/ai-connection-solid-runtime.spec.ts`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/tests/e2e/helpers/seeded-xpod-runtime.ts`

- [ ] **Step 1: Extend the E2E with a real second-browser write flow**

After first-user assertions, create a new browser context and execute:

```ts
const secondContext = await browser.newContext()
const secondPage = await secondContext.newPage()
await secondPage.goto('/applets/ai-connection/')
await loginToSeededRuntime(secondPage, runtime, {
  email: OTHER_EMAIL,
  password: OTHER_PASSWORD,
})
await expect(secondPage.getByTestId('standalone-ai-connection-host'))
  .toBeVisible({ timeout: 60_000 })
await expect(secondPage.getByText('服务访问已授权'))
  .toBeVisible({ timeout: 30_000 })

await secondPage.getByRole('button', { name: 'OpenAI API Key' }).click()
await secondPage.getByLabel('OpenAI API Key 输入').fill(SECOND_PROVIDER_API_KEY)
await secondPage.getByRole('button', { name: '保存 OpenAI API Key' }).click()
await expect(secondPage.getByText('已配置').first()).toBeVisible()

const secondCredentialIri =
  new URL(`${OTHER_POD}/settings/credentials.ttl#cloud-openai`, runtime.baseUrl).href
const secondCredentialText =
  await readPrivatePodResource(runtime, secondWebId, secondCredentialIri)
expect(secondCredentialText).toContain('wrappedDataKey')
expect(secondCredentialText).not.toContain(SECOND_PROVIDER_API_KEY)

await secondPage.getByRole('button', { name: /Gateway Keys/ }).click()
await secondPage.getByRole('button', { name: /创建 Gateway Key/ }).click()
const secondGatewayKey =
  await secondPage.locator('code').filter({ hasText: /^xpod_gw_/ }).innerText()
const secondModels = await gatewayJson(runtime.baseUrl, secondGatewayKey, '/v1/models')
expect(secondModels.data.map((model: { id: string }) => model.id)).toContain('gpt-5')
await secondContext.close()
```

Also assert the first user's Pod text does not contain the second key's
ciphertext or account label.

- [ ] **Step 2: Add service-access revocation proof**

Use the generic host permission capability through the standalone host's
existing E2E test hook:

```ts
await secondPage.evaluate(async () => {
  await (window as any).__LINX_E2E_AI_CONNECTION__.revokeServiceAccess()
})
await expect(secondPage.getByText('服务访问未授权')).toBeVisible()
const denied = await gatewayRaw(
  runtime.baseUrl,
  secondGatewayKey,
  '/v1/models',
)
expect(denied.status).toBe(403)
expect(await denied.json()).toMatchObject({
  error: expect.objectContaining({ code: 'service_access_missing' }),
})
```

The hook delegates to `revokeAgentAccess`; it contains no AI-specific ACL
implementation and is installed only when the E2E test flag is enabled.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
LINX_XPOD_ROOT=/Users/ganlu/develop/.worktrees/xpod-pod-ai-gateway \
yarn workspace @linx/e2e playwright test \
  specs/ai-connection-solid-runtime.spec.ts --workers=1
```

Expected before Tasks 2–6: FAIL when second user tries to grant or save.

- [ ] **Step 4: Make only fixture-level corrections required by the real flow**

Permitted helper changes:

```ts
export interface SeededLoginInput {
  email: string
  password: string
}

export async function loginToSeededRuntime(
  page: Page,
  runtime: SeededXpodRuntime,
  input: SeededLoginInput = {
    email: runtime.email,
    password: runtime.password,
  },
): Promise<void> {
  // Existing real CSS login steps use input.email and input.password.
}
```

Do not bypass the browser OIDC flow with a pre-issued Bearer token.

- [ ] **Step 5: Run E2E twice**

Run the command from Step 3 twice.

Expected: both runs pass, proving the result is not dependent on stale Pod or
browser state.

- [ ] **Step 6: Commit**

```bash
git add \
  tests/e2e/specs/ai-connection-solid-runtime.spec.ts \
  tests/e2e/helpers/seeded-xpod-runtime.ts
git commit -m "🧪 Prove applet service grants across browser identities" \
  -m "Constraint: The second identity must use the real browser Solid OIDC and Pod ACL path
Confidence: high
Scope-risk: moderate
Tested: AI Connection Solid runtime E2E twice"
```

## Task 8: Full verification and completion audit

**Files:**
- Modify only files required to fix regressions caused by Tasks 1–7.

- [ ] **Step 1: Run LinX package and Web verification**

```bash
yarn workspace @undefineds.co/extension-sdk test
yarn workspace @undefineds.co/extension-sdk build
yarn workspace @undefineds.co/ai-connection test
yarn workspace @linx/extension-test-host test
yarn typecheck:web
yarn workspace @linx/web test --run
```

Expected:

- extension SDK: all tests pass;
- AI Connection: all tests pass;
- standalone extension host: all tests pass;
- Web typecheck passes;
- Web full suite passes with zero failed tests.

- [ ] **Step 2: Run Xpod verification**

```bash
bun run build:ts
bun test \
  tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts \
  tests/api/ai-gateway/AiConnectionServiceAccess.test.ts \
  tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts \
  tests/api/ai-gateway/ProviderConnectAdapters.test.ts \
  tests/api/ai-gateway/ProviderQuotaAdapters.test.ts \
  tests/api/handlers/AiGatewayManagementHandler.test.ts \
  tests/api/container/config.test.ts \
  tests/gateway/proxy-headers.test.ts
bun run test:integration:lite
```

Expected: TypeScript, focused tests, and lite integration all pass.

- [ ] **Step 3: Run Docker-backed integration when available**

```bash
docker info
bun run test:integration:full
```

Expected: Docker daemon responds and full integration passes. If Docker remains
unavailable, record the exact `docker info` failure and do not misreport the
full suite as executed.

- [ ] **Step 4: Run the real E2E one final time**

```bash
LINX_XPOD_ROOT=/Users/ganlu/develop/.worktrees/xpod-pod-ai-gateway \
yarn workspace @linx/e2e playwright test \
  specs/ai-connection-solid-runtime.spec.ts --workers=1
```

Expected: first and second browser identities both pass the complete workflow.

- [ ] **Step 5: Audit security invariants**

Run:

```bash
rg -n "Authorization.*DPoP|console\\.log|apiKey|clientSecret|dpopProof" \
  src/api/ai-gateway src/api/auth \
  /Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/src \
  /Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/apps/web/src/extensions
```

Inspect every match and prove:

- no Pod fetch forwards browser DPoP credentials;
- no log prints secrets or URL query strings;
- descriptor responses contain no credentials;
- applets only invoke host permission APIs;
- every resource URL is current-Pod-bound.

- [ ] **Step 6: Request final code review**

Dispatch a read-only reviewer with the approved design, both branch diffs, and
the verification output. Fix every Critical or Important finding before
continuing.

- [ ] **Step 7: Completion evidence**

Record:

- both worktree branch names and final SHAs;
- exact passing test counts;
- E2E duration and two-WebID assertions;
- Docker-backed integration result;
- any remaining non-blocking warnings;
- confirmation that unrelated pre-existing dirty LinX files were not staged.
