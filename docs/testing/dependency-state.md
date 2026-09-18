# 依赖状态契约与自检

> 目的：让"依赖没管好"在**开跑前**就报出来，而不是变成几十个看起来无关的测试失败。

Xpod 的依赖有两类容易在 checkout / 重装之间漂移的状态：**打了补丁的依赖**和**工作区包的构建产物**。`bun run test`（经 `scripts/run-vitest-safe.sh`）会先跑 `bun scripts/check-dependency-state.ts` 做体检。

## 一、补丁依赖（`patchedDependencies`）

`package.json` 的 `patchedDependencies` 把 `patches/*.patch` 绑定到**确切版本**：

| 依赖 | 补丁 | 补丁做什么 |
|---|---|---|
| `@solid/community-server@8.0.0-alpha.1` | `patches/@solid%2Fcommunity-server@8.0.0-alpha.1.patch` | CSS 的 JSON 深拷贝会丢掉 `issueRefreshToken` 钩子；且 `interactions.url` 不传 interaction id，导致每次授权共用同一个交互 cookie 路径 |
| `@undefineds.co/drizzle-solid@0.3.24` | `patches/@undefineds.co%2Fdrizzle-solid@0.3.24.patch` | drizzle-solid 的既有修正 |

约定：

1. **补丁 key 的版本必须与安装版本一致**。升级依赖时同步"升版本 + 重做补丁"，不要留下 `0.2.53` 的补丁去配 `0.2.55` 的依赖（这种漂移曾让 `disabledAt` 消失，表现为 `PodGatewayAccessKeyRepository` 失败）。
2. **一个补丁恰好应用一次**。在已经打过补丁的 `node_modules` 上再次安装，bun 可能把 hunk 打到错误的对象里（曾把 `interactions.url` 的改动塞进 `config.routes`，留下一个多余路由，而真正的 interaction url 仍是旧实现）。
3. 自检脚本按补丁声明的最终行号和连续后像校验。相同声明可以合法出现在多个导出别名中；出现次数必须与补丁声明的位置数一致，缺失、错位和额外重复均拒绝。

失败时先检查版本和补丁声明，再由包管理器重装：

```bash
bun scripts/check-dependency-state.ts
bun install
```

脚本不再通过删除重复代码来猜测修复。缺少 pristine 包来源时，无法确定哪份重复声明合法；历史 `--repair` 参数也只会报告失败，不修改补丁包。若重装仍有安装残留，保留诊断后清理该 checkout 的失效安装目录，再由包管理器重建，禁止直接编辑依赖源码。

`bun run test` 入口先做上述检查。检查失败不会继续测试；工作区缺失构建产物的处理见下一节。

行为守卫仍然是测试：`tests/identity/oidc/SessionBoundIdentityProviderFactory.test.ts` 守 CSS 补丁，`tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts` 守模型 schema。

## 二、工作区包构建产物（`packages/*/dist`）

根目录的测试与 UI 构建会直接 import `@undefineds.co/{solid-sdk,shared-ui,extension-sdk,ai-connections}` 的子路径，这些子路径指向 `packages/*/dist`。`dist` 是构建产物且不进版本库，重装依赖时可能被清空，症状是 `Failed to resolve import "@undefineds.co/extension-sdk/react"` 之类。

自检脚本会读取每个工作区包 `package.json` 的 `exports`/`main`，发现产物缺失就**自动跑 `bun run build:packages`** 再复查；构建失败才报错。手工等价命令：

```bash
bun run build:packages
```

## 三、本地环境变量不要污染测试

`tests/vitest.setup.ts` 会加载 `.env.local`，所以测试**必须显式 stub 自己依赖的环境变量**，不能假设"没有环境变量"。反例：`ConfiguredLoopbackDPoPWebIdExtractor` 的三条用例依赖 `CSS_PORT` 决定内部回环端口，没有 stub 时会打到 `.env.local` 里的端口（本机无服务）而报 `ECONNREFUSED`。

## 四、验收命令

```bash
bun scripts/check-dependency-state.ts   # 体检（测试入口会自动执行）
bun install                             # 修复补丁相关漂移
bun run build:packages                  # 修复工作区产物
```
