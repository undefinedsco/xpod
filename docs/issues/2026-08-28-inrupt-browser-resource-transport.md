# Inrupt browser resource transport injection

## Reproduction

Inrupt browser 3.1.1 signs a canonical managed Pod request only after Xpod's
outer local-route wrapper has changed it to the Vite origin. With Web at
`127.0.0.1:5173` and the real Local Gateway published from Docker at port 16310,
CSS receives the canonical resource but the DPoP proof targets port 5173. It
correctly returns 401. Account login and the durable profile binding succeed;
this failure is not a missing Pod binding or an expired refresh token.

## Dependency limitation and chosen fix

Inrupt core already supports `buildAuthenticatedFetch(token, { fetch })`, but
browser `Session` does not expose that resource transport option. Add a pinned,
idempotent browser 3.1.1 patch that passes optional `Session({ fetch })` through
its dependency builder and authorization-code handler to the existing core
factory. Do not implement token handling, DPoP signing, PKCE, or refresh in Xpod.

Xpod supplies the SDK's canonical-to-local transport *inside* the authenticated
fetch. Inrupt signs the logical canonical resource; the SDK routes that request
to the current SP and preserves its canonical identity. The server continues
checking the proof against the exact canonical target and checking Pod ACLs.
No Docker subnet, client forwarding header, or unverified proof gets trusted.
Transport aliases are not new RDF identities or redirects. Response URL metadata
must therefore resolve back into the canonical resource tree, including error
responses, so Inrupt does not mistake a 401 from the local hop for a redirect.

After the transport fix, the real Web request passes CSS token verification but
the Settings SPARQL sidecar returns 403. This is a separate authorization issue,
not an ORM query error. For diagnosis only, inspect the server's stored ACL
triples read-only because authenticated ORM access is denied before query
execution. Do not change ACLs, expose credential resources, or substitute this
inspection for the required authenticated Pod read/write acceptance.

The patch affects resource fetch only, not discovery, token exchange, or refresh
HTTP endpoints. Default sessions and injected custom client authentication keep
their existing behavior. Existing core refresh retry patch remains independent.

## Verification requirements

- Patch idempotence, version/shape guard, CJS/ESM and public type agreement.
- Actual Inrupt core signs canonical DPoP before transport, including refresh.
- SDK preserves method/body/headers, maps response URL/clone metadata to the
  canonical resource, and does not route sibling Pods or the Cloud issuer.
- Real Web login and AI Connections read/write using the current Local Gateway.
- Provider save/reload, selected models, Web-created Xpod key CRUD/reveal,
  `/v1/models`, and a real DeepSeek chat response using that key.

Protocol reference: [RFC 9449 §4.3](https://www.rfc-editor.org/rfc/rfc9449.html#section-4.3).
The proof must match the server's logical HTTP target; never recover by ignoring
the host/path or by trusting the `htu` value without comparison.
