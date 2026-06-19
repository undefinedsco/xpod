# Xpod Inrupt Smoke - iOS

Minimal SwiftUI/WKWebView shell for the shared Xpod Inrupt verifier page:

```text
/app/inrupt-smoke.html
```

The WebView page runs `@inrupt/solid-client-authn-browser`, logs into the Cloud OIDC issuer, discovers `solid:storage` as Pod home, and can use drizzle-solid to write/read/delete one RDF smoke record on the SP.

Example local verifier URL:

```text
http://192.168.3.15:3000/app/inrupt-smoke.html?issuer=http%3A%2F%2F192.168.3.15%3A3000%2F&sp=http%3A%2F%2F192.168.3.15%3A3000%2Falice%2Fa.txt
```

For Cloud/SP validation, open the verifier on the Cloud IdP origin, set `issuer` to the Cloud issuer, and let the page derive the SP from WebID `solid:storage`. `sp` remains an optional direct-resource override.

## Build / install

Open `XpodInruptSmoke.xcodeproj` in Xcode, select a development team, then run on an iPhone.

The project intentionally enables `NSAllowsArbitraryLoads` so local `http://192.168.x.x:3000` smoke URLs work. Do not use that setting for an App Store production build without a proper ATS policy.

This repository machine currently has CommandLineTools only, not full Xcode, so it cannot produce a signed installable `.ipa` locally.
