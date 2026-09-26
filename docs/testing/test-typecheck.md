# 测试程序类型检查（`bun run typecheck:test`）

`typecheck:test` = `tsc --noEmit -p tsconfig.test.json`，覆盖 `bin/`、`src/`、`tests/`，以及测试
import 到的 `ui/src`。它和 `build:ts`（只含 `bin/` + `src/`）互补，是唯一会检查测试代码类型的门禁。

## 2026-09-26：门禁恢复真实检查

在此之前该脚本**是空转的**：`@vitejs/plugin-react` 的 `dist/index.d.ts` 使用
`export { … as "module.exports" }`，根目录 TypeScript（5.5）无法解析，产生两个语法错误
（TS1003 / TS1128）。`tsc` 只要遇到语法错误就**只报语法、跳过全部语义诊断**，所以测试代码里的
类型错误一个也报不出来（探针：故意写 `export const y: string = 42` 同样不报）。历史记录见
`docs/testing/login-audit-2026-09-15.md` 与 `docs/superpowers/plans/2026-09-05-web-account-rc.md`。

修法：**不新增依赖、不关闭检查**。

- `tsconfig.test.json` 用 `paths` 把 `@vitejs/plugin-react` 指向 `types/vite-plugin-react.d.ts`：
  只声明 `ui/vite.config.ts` 用到的那一个入口；真实类型由 UI 自己的 `tsc -b`
  （`ui/tsconfig.app.json`）把关。
- 同一配置补 `lib: ["es2021", "DOM", "DOM.Iterable"]`（UI 源码用 `Headers.entries`），并纳入 UI
  ambient：`types/ui-test-env.d.ts`（`/// <reference types="vite/client" />`）加
  `ui/src/global.d.ts`、`ui/src/xpod-desktop.d.ts`。测试既然 import UI 源码，就要看到 UI 构建看到的
  同一套环境（`import.meta.env`、`*.svg`、`window.__XPOD__`）。
- `types/lucide-react/index.d.ts` 补上 UI 用到的 `ChevronRight` / `Clock` / `Layers`。

## 2026-09-26：欠账清零

打开检查后立刻报出 60+ 个历史类型错误（实测 64 个 / 30 个文件）。同一轮全部修完，`main` 上现在
`bun run typecheck:test` 干净通过。仍然**不加依赖、不关检查**：

- **缺类型依赖 → 用本仓库既有的 `types/` 垫片约定**：`types/jsdom/index.d.ts`（jsdom 不带类型、
  仓库也明确不装 `@types/jsdom`，垫片只声明测试真正调用的 `JSDOM` / `CookieJar` /
  `VirtualConsole`）、`types/bun/index.d.ts`（`tests/bun/*` 跑在 `bun test` 下，只声明该套件用到的
  `bun:test` 子集）。两者都刻意保持"窄"：清单外的 API 应当报错，而不是退化成 `any`。
- **测试夹具与源码签名漂移**：`RecordingCredentialRepository` 补上真实接口要求的
  `getActiveCredential`；`DdnsManager.getStatus` 夹具补 `allocated`；`PodChatKitStore` 构造项去掉
  已删除的 `tokenEndpoint`；`PostgresRdfEngine.replaceSource` 去掉已经不接受的超时参数；
  `AiGatewayPodIsolation` 的 `auth` 断言改用 `toMatchObject`（`AuthContext` 是联合类型）；
  `ingress-port` / `SakuraFrp` / `TunnelDeclaredOrigin` / `ManagedClientFetch` 的 mock 形状；
  `inrupt-session-restore` 的 `SigningJwk`（DOM 的 `JsonWebKey` 没有 `kid`）与 React 19 要求的
  `children`。
- **真 bug（不是类型噪点）**：`tests/cli/obj.test.ts` 与 `tests/scripts/p2p-dual-smoke.test.ts` 的
  对象字面量重复键（后者让 `debug` 永远取后一个值）；e2e 里的 `Object.hasOwn` 改成 ES2021 可用的
  `Object.prototype.hasOwnProperty.call`（仓库基线是 ES2021，不抬高 lib）。

顺带把两处**生产**类型收紧（都是"门禁本该早就拦住"的那类）：`guardPodAccessRoute` 的签名从
`<T extends (...args: any[]) => Promise<unknown>>` 改成 `RouteHandler`，包装错形状的路由会直接报错；
`createGatewayAdminProxyHeaders` 的返回类型从 `OutgoingHttpHeaders` 收到 `Record<string, string>`，
因为它实际只产出字符串值。

`tests/e2e/*`（Playwright）与 `tests/bun/*`（`bun test`）仍在这个程序里检查：前者靠依赖自带的类型，
后者靠上面的垫片。

## 下一步

把该脚本接进 CI（目前 CI 不跑它，因此修复前它坏了很久也没人发现）。合并前请确保新加的运行时专属
类型没有把真实错误挡在外面：垫片只声明用到的 API，新增 Bun / jsdom API 时先补齐垫片，或改成装官方类型。

