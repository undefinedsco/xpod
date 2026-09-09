# Pod Ownership Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Local SQLite startup deterministic and make OIDC Consent resolve existing Pod/WebID ownership through CSS stores instead of opening the identity database.

**Architecture:** A shared database-URL normalizer runs before legacy and Runtime child processes receive environment variables. `ScopedPickWebIdHandler` delegates local and remote ownership checks to a `PodOwnershipResolver`; the CSS-backed implementation uses `WebIdStore` and `PodStore`, while remote provision-scoped lookups remain fail closed through `/provision/webids`.

**Tech Stack:** TypeScript, Community Solid Server Components.js, CSS `WebIdStore`/`PodStore`, Vitest, Bun, Playwright.

---

## File map

- Create `src/runtime/database-url.ts`: canonical database URL normalization and validation.
- Modify `src/runtime/bootstrap.ts`: consume the shared normalizer.
- Modify `src/runtime/css-process.ts`: normalize legacy CSS/API child environment values.
- Modify `tests/runtime/bootstrap.test.ts` and `tests/runtime/css-process.test.ts`: lock new and legacy startup behavior.
- Create `src/identity/oidc/PodOwnershipResolver.ts`: ownership interface and CSS/remote implementation.
- Create `tests/identity/PodOwnershipResolver.test.ts`: resolver authorization tests.
- Modify `src/identity/oidc/ScopedPickWebIdHandler.ts`: remove database construction and delegate to the resolver.
- Modify `tests/identity/ScopedPickWebIdHandler.test.ts`: handler contract tests with an injected resolver.
- Modify `config/xpod.base.json`: Components.js wiring for resolver, `WebIdStore`, and `PodStore`.
- Modify `src/index.ts`: export the resolver component.
- Regenerate `dist/components/*`: Components.js metadata.
- Modify `tests/ui/consent-page.test.ts`: browser-facing regression assertion.

### Task 1: Canonical database URL boundary

**Files:**
- Create: `src/runtime/database-url.ts`
- Modify: `src/runtime/bootstrap.ts`
- Test: `tests/runtime/bootstrap.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Add focused tests that exercise the exported helper and bootstrap state:

```ts
import { normalizeDatabaseUrl } from '../../src/runtime/database-url';

it('normalizes local database paths without guessing PostgreSQL', () => {
  expect(normalizeDatabaseUrl('./data/identity.sqlite', {
    resolvePath: (value) => `/workspace/${value.replace(/^\.\//u, '')}`,
  })).toBe('sqlite:/workspace/data/identity.sqlite');
});

it.each([
  'sqlite:/data/identity.sqlite',
  'postgres://db/xpod',
  'postgresql://db/xpod',
  'mysql://db/xpod',
])('preserves explicit database URL %s', (value) => {
  expect(normalizeDatabaseUrl(value, { resolvePath: (path) => path })).toBe(value);
});
```

- [ ] **Step 2: Run tests and confirm the helper is missing**

Run:

```bash
bun run test -- tests/runtime/bootstrap.test.ts
```

Expected: FAIL because `src/runtime/database-url.ts` does not exist.

- [ ] **Step 3: Extract the shared normalizer**

Create:

```ts
export interface DatabasePathPlatform {
  resolvePath(value: string): string;
}

const EXPLICIT_DATABASE_SCHEMES = [
  'sqlite:',
  'postgres://',
  'postgresql://',
  'mysql://',
] as const;

export function normalizeDatabaseUrl(
  value: string,
  platform: DatabasePathPlatform,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Database URL must not be empty.');
  }
  if (EXPLICIT_DATABASE_SCHEMES.some((scheme) => trimmed.startsWith(scheme))) {
    return trimmed;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    throw new Error(`Unsupported database URL scheme: ${trimmed.split(':', 1)[0]}`);
  }
  return `sqlite:${platform.resolvePath(trimmed)}`;
}
```

Import this function in `bootstrap.ts`, delete its private duplicate, and pass the existing runtime platform.

- [ ] **Step 4: Run the bootstrap tests**

Run:

```bash
bun run test -- tests/runtime/bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/database-url.ts src/runtime/bootstrap.ts tests/runtime/bootstrap.test.ts
git commit -m "Prevent local database paths from becoming PostgreSQL targets"
```

### Task 2: Normalize legacy child-process environments

**Files:**
- Modify: `src/runtime/css-process.ts`
- Test: `tests/runtime/css-process.test.ts`
- Test: `tests/scripts/runtime-script-env-isolation.test.ts`

- [ ] **Step 1: Write a failing legacy environment test**

Add:

```ts
it('normalizes legacy identity and usage database paths before child startup', () => {
  const env = buildCssChildEnv(
    'http://localhost:3000/',
    3001,
    undefined,
    'acp',
    {
      CSS_IDENTITY_DB_URL: './data/identity.sqlite',
      DATABASE_URL: './data/identity.sqlite',
      CSS_USAGE_DB_URL: './data/usage.sqlite',
    },
  );

  expect(env.CSS_IDENTITY_DB_URL).toMatch(/^sqlite:/u);
  expect(env.DATABASE_URL).toBe(env.CSS_IDENTITY_DB_URL);
  expect(env.CSS_USAGE_DB_URL).toMatch(/^sqlite:/u);
});
```

- [ ] **Step 2: Run it and confirm raw paths leak through**

Run:

```bash
bun run test -- tests/runtime/css-process.test.ts
```

Expected: FAIL because the returned environment still contains `./data/*.sqlite`.

- [ ] **Step 3: Normalize child database variables once**

Add an internal helper in `css-process.ts` that calls `normalizeDatabaseUrl` with `path.resolve` for defined values and keeps `DATABASE_URL` aligned with `CSS_IDENTITY_DB_URL`:

```ts
function normalizeChildDatabaseEnv(env: Record<string, string>): void {
  const platform = { resolvePath: (value: string): string => path.resolve(value) };
  if (env.CSS_IDENTITY_DB_URL) {
    env.CSS_IDENTITY_DB_URL = normalizeDatabaseUrl(env.CSS_IDENTITY_DB_URL, platform);
    env.DATABASE_URL = env.CSS_IDENTITY_DB_URL;
  } else if (env.DATABASE_URL) {
    env.DATABASE_URL = normalizeDatabaseUrl(env.DATABASE_URL, platform);
    env.CSS_IDENTITY_DB_URL = env.DATABASE_URL;
  }
  if (env.CSS_USAGE_DB_URL) {
    env.CSS_USAGE_DB_URL = normalizeDatabaseUrl(env.CSS_USAGE_DB_URL, platform);
  }
}
```

Call it from both CSS and API legacy child environment builders before returning.

- [ ] **Step 4: Run legacy environment regressions**

Run:

```bash
bun run test -- tests/runtime/css-process.test.ts tests/scripts/runtime-script-env-isolation.test.ts
```

Expected: PASS with no environment leakage regression.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/css-process.ts tests/runtime/css-process.test.ts tests/scripts/runtime-script-env-isolation.test.ts
git commit -m "Give legacy child processes canonical database URLs"
```

### Task 3: CSS-backed Pod ownership resolver

**Files:**
- Create: `src/identity/oidc/PodOwnershipResolver.ts`
- Create: `tests/identity/PodOwnershipResolver.test.ts`

- [ ] **Step 1: Write failing same-process ownership tests**

Create mocks for CSS `WebIdStore` and `PodStore` and assert:

```ts
it('returns only WebIDs owned by the account on the target storage root', async () => {
  webIdStore.findLinks.mockResolvedValue([
    { webId: 'http://localhost:3000/alice/profile/card#me' },
    { webId: 'https://external.example/profile#me' },
  ]);
  podStore.findPods.mockResolvedValue([
    { id: 'pod-a', baseUrl: 'http://localhost:3000/alice/' },
    { id: 'pod-b', baseUrl: 'https://other.example/alice/' },
  ]);
  podStore.getOwners.mockImplementation(async (id) => id === 'pod-a'
    ? [{ webId: 'http://localhost:3000/alice/profile/card#me', visible: false }]
    : [{ webId: 'https://external.example/profile#me', visible: false }]);

  await expect(resolver.resolveOwnedWebIds({
    accountId: 'alice-account',
    candidateWebIds: [
      'http://localhost:3000/alice/profile/card#me',
      'https://external.example/profile#me',
    ],
    target: { storageUrl: 'http://localhost:3000/' },
  })).resolves.toEqual([{
    webId: 'http://localhost:3000/alice/profile/card#me',
    storageUrl: 'http://localhost:3000/alice/',
    storageMode: 'cloud',
  }]);
});
```

Also assert another account's WebID and a mismatched storage root are excluded.

- [ ] **Step 2: Run the new test and confirm the resolver is missing**

Run:

```bash
bun run test -- tests/identity/PodOwnershipResolver.test.ts
```

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement the resolver interface and CSS path**

Define:

```ts
export interface PodOwnershipTarget {
  storageUrl: string;
  lookupUrl?: string;
  serviceAccessToken?: string;
}

export interface OwnedWebIdEntry {
  webId: string;
  storageUrl: string;
  storageMode: 'cloud' | 'local' | 'custom';
}

export interface PodOwnershipResolver {
  listAccountWebIds(accountId: string): Promise<string[]>;
  resolveOwnedWebIds(input: {
    accountId: string;
    candidateWebIds: string[];
    target: PodOwnershipTarget;
  }): Promise<OwnedWebIdEntry[]>;
}
```

Implement `CssPodOwnershipResolver` with injected CSS `WebIdStore`, CSS `PodStore`, and optional `fetch`. For same-process targets, call `podStore.findPods(accountId)` and `podStore.getOwners(pod.id)`; include only candidate owners whose Pod base URL belongs to `target.storageUrl`.

- [ ] **Step 4: Run the resolver tests**

Run:

```bash
bun run test -- tests/identity/PodOwnershipResolver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/identity/oidc/PodOwnershipResolver.ts tests/identity/PodOwnershipResolver.test.ts
git commit -m "Resolve local Pod ownership through CSS stores"
```

### Task 4: Move remote SP ownership verification into the resolver

**Files:**
- Modify: `src/identity/oidc/PodOwnershipResolver.ts`
- Modify: `tests/identity/PodOwnershipResolver.test.ts`

- [ ] **Step 1: Write failing remote fail-closed tests**

Cover a successful `/provision/webids` response, an unknown candidate, an HTTP 500, and a storage-root mismatch:

```ts
it('fails closed when the remote SP cannot verify ownership', async () => {
  fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(resolver.resolveOwnedWebIds({
    accountId: 'alice-account',
    candidateWebIds: ['https://id.example/alice#me'],
    target: {
      storageUrl: 'https://alice.nodes.example/',
      lookupUrl: 'https://sp.example/',
      serviceAccessToken: 'short-lived-token',
    },
  })).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run the tests and confirm remote targets are unsupported**

Run:

```bash
bun run test -- tests/identity/PodOwnershipResolver.test.ts
```

Expected: FAIL on remote expectations.

- [ ] **Step 3: Implement remote verification**

When both `lookupUrl` and `serviceAccessToken` are present, POST candidate WebIDs to `/provision/webids`, require `response.ok`, filter entries to the candidate set, and require each returned `storageUrl`/`podUrl` to match `target.storageUrl`. Return `[]` on network, status, or schema failure without logging tokens.

- [ ] **Step 4: Run resolver tests**

Run:

```bash
bun run test -- tests/identity/PodOwnershipResolver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/identity/oidc/PodOwnershipResolver.ts tests/identity/PodOwnershipResolver.test.ts
git commit -m "Keep remote Pod ownership verification fail closed"
```

### Task 5: Replace OIDC database coupling with resolver injection

**Files:**
- Modify: `src/identity/oidc/ScopedPickWebIdHandler.ts`
- Modify: `tests/identity/ScopedPickWebIdHandler.test.ts`
- Modify: `config/xpod.base.json`
- Modify: `src/index.ts`
- Regenerate: `dist/components/`

- [ ] **Step 1: Rewrite handler tests to require resolver injection**

Construct the handler with:

```ts
const ownershipResolver = {
  listAccountWebIds: vi.fn().mockResolvedValue([aliceWebId]),
  resolveOwnedWebIds: vi.fn().mockResolvedValue([{
    webId: aliceWebId,
    storageUrl: 'http://localhost:3000/alice/',
    storageMode: 'cloud',
  }]),
};
```

Assert GET returns the resolver entries, POST rejects a WebID absent from the resolver result, and no database URL is required.

- [ ] **Step 2: Run the handler tests and confirm constructor mismatch**

Run:

```bash
bun run test -- tests/identity/ScopedPickWebIdHandler.test.ts
```

Expected: FAIL because the handler still constructs `PodLookupRepository`.

- [ ] **Step 3: Simplify the handler**

Replace `webIdStore`, `identityDbUrl`, `podLookupRepository`, and direct remote lookup members with:

```ts
export interface ScopedPickWebIdHandlerOptions {
  ownershipResolver: PodOwnershipResolver;
  providerFactory: ProviderFactory;
  storageBaseUrl?: string;
  provisionBaseUrl?: string;
}
```

GET calls `listAccountWebIds()` followed by `resolveOwnedWebIds()`. POST resolves the allowed set again and only finishes the interaction when the submitted WebID is present.

- [ ] **Step 4: Wire Components.js**

Add a singleton `CssPodOwnershipResolver` component in `config/xpod.base.json` with:

```json
{
  "@id": "urn:undefineds:xpod:PodOwnershipResolver",
  "@type": "CssPodOwnershipResolver",
  "webIdStore": { "@id": "urn:solid-server:default:WebIdStore" },
  "podStore": { "@id": "urn:solid-server:default:PodStore" }
}
```

Inject it into `ScopedPickWebIdHandler`, export the class in `src/index.ts`, and run:

```bash
bun run build:components
```

- [ ] **Step 5: Run OIDC and Components tests**

Run:

```bash
bun run test -- tests/identity/PodOwnershipResolver.test.ts tests/identity/ScopedPickWebIdHandler.test.ts
bun run build:components
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/identity/oidc/ScopedPickWebIdHandler.ts src/identity/oidc/PodOwnershipResolver.ts tests/identity/ScopedPickWebIdHandler.test.ts config/xpod.base.json src/index.ts dist/components
git commit -m "Keep OIDC consent behind the Pod ownership boundary"
```

### Task 6: Product-level Local seed regression

**Files:**
- Modify: `tests/ui/consent-page.test.ts`
- Modify: `tests/integration/XpodSettings.integration.test.ts`
- Modify: `docs/cli-dev-testing.md`

- [ ] **Step 1: Add a failing seeded Consent regression**

Add an integration assertion that starts Local Xpod with a file-path identity configuration and seed account, logs in, starts the Settings OIDC flow, and verifies the picker response contains the seeded WebID. Add a UI assertion that non-empty picker WebIDs render the radio choice and do not render “Create your first storage”.

- [ ] **Step 2: Run the focused product regression**

Run:

```bash
bun run test -- tests/ui/consent-page.test.ts tests/integration/XpodSettings.integration.test.ts
```

Expected before all wiring is complete: FAIL on the seeded Consent assertion; after Tasks 1–5: PASS.

- [ ] **Step 3: Document the canonical local launch form**

Update `docs/cli-dev-testing.md` to use `bun run dev:seed` or the Runtime entry point and state that filesystem identity paths are normalized to `sqlite:` before CSS/API child startup. Remove examples that rely on raw legacy child configuration.

- [ ] **Step 4: Run build and full regression**

Run:

```bash
bun run build:ts
bun run build:packages
bun run test -- tests/runtime/bootstrap.test.ts tests/runtime/css-process.test.ts tests/identity/PodOwnershipResolver.test.ts tests/identity/ScopedPickWebIdHandler.test.ts tests/ui/consent-page.test.ts tests/integration/XpodSettings.integration.test.ts
bun run test:integration
```

Expected: all commands exit 0.

- [ ] **Step 5: Run real local browser acceptance**

Start the seeded Local Xpod with a clean `.test-data/pod-ownership-acceptance` root. Verify:

```text
service/status = 200
Local startup log contains no PostgreSQL connection attempt
Account API lists the seeded Pod and WebID
Consent directly lists the same WebID
FirstPodCreator is absent
Authorize returns to /settings/auth/callback
```

- [ ] **Step 6: Commit**

```bash
git add tests/ui/consent-page.test.ts tests/integration/XpodSettings.integration.test.ts docs/cli-dev-testing.md
git commit -m "Prove seeded Local consent reuses the existing Pod"
```

### Task 7: Final acceptance audit

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-ai-connection-acceptance-matrix.md`

- [ ] **Step 1: Re-run the Connections core suite**

Run the existing 16-file, 326-test Connections command recorded in the acceptance matrix.

Expected: all tests pass, with the final count updated if new tests increase it.

- [ ] **Step 2: Check source and secret hygiene**

Run:

```bash
git diff --check release/0.3.71...HEAD
git status --short
git diff --name-only release/0.3.71...HEAD
```

Confirm no `.env`, test database, generated screenshot, API key, or temporary seed file is staged.

- [ ] **Step 3: Update acceptance evidence**

Record the successful seed login, existing-Pod Consent selection, no-PG Local startup evidence, and exact regression counts. Keep external OAuth and real-provider Codex gates honest until they run.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-06-ai-connection-acceptance-matrix.md
git commit -m "Record the canonical Local Pod ownership acceptance"
```
