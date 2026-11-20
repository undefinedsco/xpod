# Desktop Local onboarding transport

The Account document may be served by a remote trusted issuer while the Pod is
created on the same computer as Desktop. A Cloud-managed node domain is the
canonical storage identity; it does not imply a public DNS/HTTPS route exists.

Desktop exposes the existing provisioning protocol through an optional host
capability. Account profile preparation still uses the authenticated Account
control. Only `POST /provision/pods` and `POST /provision/webids` use the native
same-device transport. Ordinary browser clients keep their existing transport.

The native boundary:

- Accepts only the current window's reserved product or trusted issuer Account
  main document. Checks committed, frame and current document URLs; user Pod HTML,
  other windows, iframes and `pushState` impersonation cannot acquire the capability.
- Accepts two fixed relative paths, bounded JSON, and the original operation's
  signed, unexpired provision code; it accepts no arbitrary URL or headers.
- Reads the configured loopback Gateway's current status and checks the issuer,
  node ID, canonical node domain and registration against that operation before
  forwarding its short-lived service capability.
- Uses the original capability, not a privileged runtime key or a refreshed
  capability; the Local API continues to authenticate and authorize the request.
- Rejects redirects and mismatched/expired operations. It never switches an
  operation to another node, public route or Cloud storage.

Canonical WebID/storage bindings and the existing prepare/receipt/Account POST
transaction remain unchanged. A failed lookup remains an unreadable result and
must not permit a duplicate create.

An Account picker rejection `400/H400: Invalid or expired provisionCode.` has a
separate recovery view. Rereading the same OIDC interaction cannot refresh that
operation. Return through Desktop's trusted recovery entry and begin a new login;
do not replay callback code/state or relax cookie, DPoP or provision expiry.

Regression coverage lives in `desktop/test/provision-transport.test.ts`,
`ui/src/utils/provision-scope.test.ts`, and `ui/src/pages/ConsentResume.test.tsx`.
Real acceptance must use the packaged Desktop and actual Local Gateway with no
public route: create a fresh Local Pod, verify its canonical binding and complete
the original authorization. Unit tests are not evidence of that acceptance.

Tracked observations: [pairing recovery](https://github.com/undefinedsco/xpod/issues/222)
and [Local preparation transport](https://github.com/undefinedsco/xpod/issues/223).
