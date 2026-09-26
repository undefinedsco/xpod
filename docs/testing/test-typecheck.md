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

## 当前欠账（门禁已能报出，尚未清零）

打开检查后立刻报出 60+ 个历史类型错误（2026-09-26 在 `main` 上实测 64 个 / 30 个文件），分三类：

1. **缺类型依赖**（需要新增 devDependency；未在共享工作区擅自安装，因为 `bun install` 会重写
   `bun.lock`）：`jsdom` 缺 `@types/jsdom`（5 处），`Bun` / `bun:test` / `import.meta.dir` 缺
   `@types/bun`（`tests/bun/*`、`tests/helpers/seedProviderCredential.ts`）。
2. **测试夹具与源码签名漂移**（数量最多，门禁空转期间积累）：`RecordingCredentialRepository` 缺
   `getActiveCredential`、`DdnsManager.getStatus` 形状、`PodChatKitStore` 构造项、
   `PostgresRdfEngine` 参数个数、`tests/cli/obj.test.ts` 对象字面量重复属性等。
3. **运行环境差异**：`tests/e2e/*`（Playwright）与 `tests/bun/*`（`bun test`）跑在别的运行时里；
   `Object.hasOwn` 需要 ES2022 lib，而仓库基线是 ES2021，应改成 ES2021 可用的写法而不是抬高 lib。

清零后再把该脚本接进 CI（目前 CI 不跑它，因此这次修复前它坏了很久也没人发现）。
