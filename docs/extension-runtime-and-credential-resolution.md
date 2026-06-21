# Extension Runtime and Credential Resolution

This document defines how Xpod and LinX invoke shared extensions while keeping
login/session acquisition, Pod settings, and raw secret access outside extension
packages.

## Core contract

Extensions provide capabilities. Hosts provide a target-Pod execution context.

```text
Login/session acquisition
  -> target Pod/SP ExtensionContext
  -> model URI selection
  -> just-in-time model/provider/credential resolution
  -> extension capability invocation
  -> provider call
```

An extension must not know whether the caller came from cloud Xpod, local Xpod,
LinX Desktop, LinX CLI, mobile delegation, or a test harness. Because Xpod
supports IdP/SP separation, a logged-in IdP session is not itself sufficient for
provider execution. The host must first build an `ExtensionContext` whose fetch
is authenticated for the target Pod/SP.

## Responsibilities

| Layer | Responsibility |
| --- | --- |
| `@undefineds.co/extensions` | Defines extension protocol, readers, adapters, registries, and provider-specific capability adapters. It does not read Pod settings. |
| `@undefineds.co/models` | Defines durable Provider / Model / Credential / policy semantics. |
| Xpod / LinX host | Acquires sessions, normalizes target-Pod context, reads Pod settings, chooses model URIs, resolves credentials just in time, and invokes extensions. |
| Runtime / Run | Records resolved provider/model/capability metadata. It never records raw secrets. |
| User Pod | Stores user-authoritative Provider / Model / Credential settings. |

## ExtensionContext

The context is intentionally smaller than any concrete login/session object.

```ts
interface ExtensionContext {
  webId: string;
  podBaseUrl: string;
  fetch: typeof fetch;        // authenticated for this target Pod/SP
  signal?: AbortSignal;
  emit?: (event: ExtensionEvent) => void;
}
```

Do not put runtime placement or filesystem details in this context:

```ts
location: 'server' | 'client' | 'local' // no
workspaceRoot: string                   // no
tempDir: string                         // no
canReadLocalFiles: boolean              // no
```

Those are source/materialization concerns owned by the host or source resolver.
The reader/embedding/chat capability receives already-resolved inputs.

Different clients create the same shape:

| Source | How it becomes `ExtensionContext` |
| --- | --- |
| cloud Xpod | User login, task auth binding, or delegated token becomes target-Pod authenticated fetch. |
| local Xpod | Local Solid session becomes target-Pod authenticated fetch. |
| LinX Desktop | Desktop login/session becomes target-Pod authenticated fetch. |
| LinX CLI | CLI login context becomes target-Pod authenticated fetch. |
| mobile-triggered remote run | Delegated executor session becomes target-Pod authenticated fetch. |

## Model and credential resolution

Provider/model/capability selection and raw secret resolution are separate.
Public runtime calls pass a durable Model URI, not loose provider/model strings.

```ts
runtime.embed(context, {
  model: 'https://pod/alice/settings/providers/dashscope.ttl#text-embedding-v4',
  texts: ['hello'],
});

runtime.read(context, {
  model: 'https://pod/alice/settings/providers/paddleocr.ttl#PP-OCRv6',
  source: 'https://pod/alice/files/report.pdf',
  output: 'markdown',
  pages: '1-10',
});
```

Ordinary product calls must not pass a credential. Credential selection is
resolver-owned through the Pod graph: `model -> provider -> active credential`.

`credential` is an advanced override only for task-bound secrets, explicit key
selection, tests, or key-rotation flows. When used, it is also a durable
Credential URI:

```ts
runtime.embed(context, {
  model: embeddingModelUri,
  credential: 'https://pod/alice/settings/credentials.ttl#cred_123',
  texts,
});
```

Internally, the runtime resolves:

```text
model URI
  -> Model
  -> Provider through Model.isProvidedBy
  -> default or explicitly selected Credential through Credential.provider
  -> RuntimeModel with provider key, provider-native model id, endpoint, proxy, raw credential
```

The raw credential exists only in memory during invocation.

## CredentialResolver

`CredentialResolver` is generic-first. AI is only one credential service. The
same boundary must also support storage, GitHub, calendar, payment, infra, and
other extension services.

```ts
interface CredentialResolver {
  resolve(input: {
    provider: string;
    credentialId?: string;
    service?: string;      // ai | storage | github | infra | ...
    capability?: string;   // reader | embedding | upload | issues | ...
    model?: string;        // durable Model URI that selected this provider
  }, context: ExtensionContext): Promise<ResolvedCredential | null>;
}

interface ResolvedCredential {
  provider: string;
  credentialId?: string;
  service?: string;
  capability?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | Date;
  baseUrl?: string;
  proxyUrl?: string;
  metadata?: Record<string, unknown>;
}
```

Recommended implementations:

| Resolver | Use |
| --- | --- |
| `PodCredentialResolver` | Default server/local path. Reads active credentials from the user's Pod through authenticated fetch. It keeps the existing AI selection path for `service=ai` and uses generic Credential resource lookup for non-AI extension services. |
| `LocalCredentialResolver` | Optional client path for local key stores or local Pod materialization. |
| `DelegatedCredentialResolver` | Remote executor path. Exchanges a delegated capability for a short-lived secret. |
| `EnvCredentialResolver` | Development/test fallback only. Not a product configuration path. |
| `CachingCredentialResolver` | Optional in-memory TTL wrapper. It must not persist raw secrets. |

Raw secrets are resolved just before invoking a provider. Logs, Run records,
reader cache keys, embedding index metadata, and extension audit records may
record credential URI/id, service, capability, provider, model, and policy
decisions, but not secret values.

## Capability calls

Reader, embedding, and chat should share the same style: context plus a
capability-specific input whose model is a URI.

```ts
interface ExtensionRuntime {
  read(context: ExtensionContext, input: {
    model: string;        // Model URI
    credential?: string;  // optional Credential URI
    source: string;       // source URI
    output?: 'text' | 'markdown' | 'structured';
    pages?: string;
    options?: Record<string, unknown>;
  }): Promise<ReadResult>;

  embed(context: ExtensionContext, input: {
    model: string;        // Model URI
    credential?: string;  // optional Credential URI
    texts: string[];
  }): Promise<{ vectors: number[][]; usage?: Record<string, unknown> }>;
}
```

Embedding receives only text. Source URI, chunk id, range, and metadata belong
to the indexing pipeline, not the embedding provider call.

Reader receives `source` as a URI. Filename, media type, size, hydration, local
path, temporary URL, R2/COS fetch, and Pod metadata lookup are host/source-layer
responsibilities. Provider-specific adapters may receive a materialized URL,
bytes, stream, or local path internally, but the public Xpod/LinX runtime API is
URI-first.

Trace/progress is not part of the business result. Use `context.emit` for
telemetry:

```ts
context.emit?.({
  type: 'extension.completed',
  capability: 'reader',
  provider: 'paddleocr',
  model: 'PP-OCRv6',
  latencyMs,
  usage,
});
```

## Current status

- Reader and embedding use the unified `context + model URI + input` boundary.
- Chat still needs migration from direct `getAiConfig(...).apiKey` paths to the
  same model URI / credential resolver boundary.
- `@undefineds.co/extensions` reader protocol is URI-first and no longer exposes
  `ReaderRuntime`, runtime location, workspace root, reader task enums, or trace
  fields in `ReadResult`.
