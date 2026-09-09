# Web silent session restoration incorrectly treated as native authorization

## Actual failure

On the Docker Cloud + managed Local acceptance stack, a signed-in Web user could
open AI Connections, copy a saved API Key and call Chat. A hard refresh then
returned to “Continue” and consent. The actual OIDC callback carried
`error=interaction_required`; the account cookie was still valid and no password
was required for the next interactive attempt. This was not evidence of an
expired refresh token or a stopped Local service.

The Inrupt current-session anchor fix made restoration start correctly, but its
isolated SDK test did not cover this real IdP interaction policy. A passing SDK
test must not be reported as successful end-to-end browser restoration.

## Root cause and boundary

Inrupt's installed DCR implementation explicitly registers
`application_type: "web"`. Xpod's `LoopbackClientIdAdapterFactory` instead inferred
`native` from any loopback redirect, including clients that explicitly declared
`web`. The installed oidc-provider consent policy has a `native_client_prompt`
check: native authorization requires interaction unless the current interaction
has consent. A remembered grant alone does not remove that check. Inrupt's
`prompt=none` restoration therefore failed with `interaction_required`.

The fix respects every explicitly supplied `application_type`. Only an absent
type retains the legacy loopback-to-native inference. Unknown explicit values
are not silently converted into a valid native type. The native consent policy,
redirect matching and upstream client validation are unchanged.

Do not fix this by globally removing native consent or accepting arbitrary
redirect URLs. Native redirect impersonation remains a separate security
boundary; see [RFC 8252 section 8.6](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.6)
and the [oidc-provider maintainer discussion](https://github.com/panva/node-oidc-provider/discussions/1307).

## Regression evidence

- Tests first reproduced the unwanted conversion of explicit `web` and an
  unknown explicit type to `native`; both failed before the source fix.
- Seven adapter/upstream-policy tests now pass. They cover loopback web clients,
  explicit native clients, legacy implicit native clients, unknown types, and
  the real installed `native_client_prompt` policy for web versus native.
- Root TypeScript build passes.
- On the updated same-image Docker stack, the actual Web browser completed two
  consecutive hard reloads without clicking Continue or Approve. Both callbacks
  had no OIDC error and returned to AI Connections. The saved Pod Key was then
  copied successfully (reveal HTTP 200), and that exact key still returned real
  Chat content `XPOD_WEB_OK`.
- After removing temporary request diagnostics and restarting only Vite, a
  third hard reload also restored the application automatically. The temporary
  diagnostics never logged identifiers, credentials or callback parameter values.
- See [the Web acceptance report](../acceptance/2026-08-28-web-ai-connections.md)
  for the final image, repeat checks and limitations.

This fix applies to the IdP's server code. Updating only a Local client while
leaving an older Cloud IdP running does not change the server's stored-client
adaptation or consent policy. Local Docker evidence is not production rollout
evidence.
