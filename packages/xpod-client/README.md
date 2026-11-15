# Xpod runtime client

Canonical authentication, credential storage and Pod HTTP APIs. CLI commands, launchers, presentation, build tooling and capability payloads belong to their independent modules.

The root API loads the optional Solid authentication SDK only when `authenticate` or a stored OAuth refresh needs it. `Session` is a type at the root; the explicit `/session` subpath exposes the SDK's real Session class and requires that peer. No fallback Session is provided.
