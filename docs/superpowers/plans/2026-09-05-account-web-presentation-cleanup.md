# Account Web presentation cleanup

> 2026-09-13：本计划中“桌面 Account 可以复用 shared 紧凑认证壳”的边界已被替代。shared 登录只负责 WebID，App/Web 的 Account 页面均归 CSS UI；当前规则见 [展示边界](../../testing/auth-presentation-boundary.md)。下文保留历史实施记录。

## Boundary

- CSS-hosted Web Account pages own their page layout and visual components.
- Xpod desktop may reuse shared-ui authentication surfaces inside its native login window.
- Authentication, Account control discovery, Pod binding, and provisioning controllers are preserved.

## Cleanup sequence

1. Restore the Xpod-owned `CardWrapper` instead of forwarding Web pages into `AuthSurface`.
2. Render the Web credentials page with its original split layout and Xpod-owned form; retain the compact shared surface only for desktop.
3. Move storage bootstrap, consent, recovery, reset, loading, and error page shells back onto Xpod-owned components.
4. Stop ordinary Cloud/Standalone Account pages from probing the Local-only `/provision/status` endpoint.
5. Lock Web versus desktop presentation and provisioning request boundaries with behavioral tests.

## Constraints

- Do not revert later authentication or provisioning correctness fixes.
- Do not modify route slugs, Account controls, form field order, or public copy as part of the presentation cleanup.
- Do not hide request failures behind layout-only changes; validate the production endpoint boundary separately.
