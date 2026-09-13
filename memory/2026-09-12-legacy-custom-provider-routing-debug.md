# Legacy custom-provider routing debug

## Symptom

- Existing agents stored an explicit model route such as `timecc/gpt-5.6-terra`.
- The current model service credential is registered under the canonical `custom` provider.
- Text-only chat first failed with `Unknown provider in explicit model route`, then reached the custom adapter but used the placeholder endpoint and returned 502.

## Root cause

Two compatibility gaps overlapped:

1. `ModelRouter` rejected historical dynamic provider ids before considering an active custom credential that explicitly exposes the same model.
2. `PodConnectedCredentialRepository` hydrated selected models from the Provider resource but did not carry that resource's `baseUrl` and capabilities into the runtime credential. `AiGatewayService` therefore fell back to the catalog placeholder endpoint. During cold startup, an empty collection read could also omit the Provider row on the first request.

## Fix

- Normalize legacy duplicated Provider resource paths and map an unknown historical provider route to `custom` only when an eligible custom credential explicitly supports the requested model.
- Hydrate runtime `baseUrl` and capabilities from the credential's Provider resource.
- If the Provider collection is temporarily incomplete, precisely read the already-declared product Provider resource; custom instance resources remain protected by the existing allow-list rule.
- Log sanitized gateway error details to make provider/status classification diagnosable without exposing credentials.

## Verification

- ModelRouter and ProviderConnect adapter suites: 80/80 passed.
- TypeScript build and diff whitespace checks passed.
- Integration lite: 150 passed, 6 skipped.
- Integration full (alternate local ports because 16379 was occupied): 45/45 passed.
- Docker image `xpod:local-routing-fixed-final` built with the pinned QLever runtime and started healthy.
- Browser cold-start acceptance returned `冷启动首次调用正常` from `gpt-5.6-terra` through the configured custom endpoint.

## Status

DONE for the local environment. The Guangzhou deployment was not changed in this investigation.
