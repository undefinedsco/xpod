# Xpod service authentication boundaries (historical index)

> **Superseded on 2026-08-30.** The canonical authority boundary is
> [Xpod Auth Authority Boundaries](superpowers/specs/2026-08-30-xpod-auth-authority-boundaries.md).

This file previously described a composed Xpod Account/WebID login controller.
That design was removed because it created a third session authority above CSS
and the Inrupt SDK.

Do not restore XpodAuthProvider, useXpodAuth, Account-token authentication in
the Xpod API, or applet-owned Account login. Historical plans may still
mention those symbols; they are implementation archaeology, not current
requirements.
