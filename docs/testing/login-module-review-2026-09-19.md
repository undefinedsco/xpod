# 登录模块设计与测试评审（2026-09-19）

本轮对"当前登录模块"的设计与测试做独立评审，并执行验收。评审只读；
验收命令与实际结果见下文，未运行的项一律标注，不把静态阅读当作运行证据。

## 0. 发布状态核实（影响"发布"含义，须先确认）

| 事实 | 证据 |
| --- | --- |
| `v0.4.10` **已正式发布** | npm `latest` = `0.4.10`、`stable-staging` = `0.4.10`（registry.npmjs.org，`time.modified` 2026-09-19T01:30Z）；GitHub Release `v0.4.10` 2026-09-19T01:39Z |
| 本工作区分支 | `release/0.4.5` @ `92fc7d5b`（`git describe` = `v0.4.5-32-g92fc7d5b`），落后 `release/0.4.10` 9 个提交 |
| 工作树登录模块 | **基本与 `v0.4.10` 逐字节相同**：`ui/src/auth/**`、`ui/src/context/**`、`ui/src/pages/{LoginSelectPage,AuthPages}`、`packages/solid-sdk/src/**`、`src/identity/oidc/**`、`src/authentication/**`、`src/identity/LoginMethodGuardStorage.ts`、`tests/e2e/login-*.spec.ts`（`git hash-object` 对比 `git rev-parse v0.4.10:<path>`，除下列例外全部相等） |
| 上述范围内的例外 | `ui/src/solid/XpodSolidRuntime.ts` 与 `XpodSolidRuntimeProvider.tsx` 与 tag 不同（约 +19/+3 行，属 `resolveLocalUrl` 与 `/.notifications/` 本地路由，**与登录状态无关**，已被子代理核对）；`ui/src/pages/ConsentPage.tsx` 在本轮修复后与 tag 不同（第 1.1 节）。测试侧另有 `tests/identity/{PodLookupRepository*,AccountRoleRepository,DrizzleIndexedStorage.integration}.test.ts`、`ui/src/extensions/*.test.*`、`ui/vite.config.test.ts` 等与 tag 不同（346 个测试文件：same 306 / differs 30 / not-in-tag 10） |
| 工作树**领先** `v0.4.10` 的登录相关部分 | `src/identity/drizzle/`：`PodLookupRepository.ts`（678 行 vs 479）、`AccountRoleRepository.ts`（552 vs 384）、`db.ts`（595 vs 562）、`EdgeNodeRepository.ts`（780 vs 797）；`src/api/auth/index.ts` 启用了 tag 中注释掉的 `NodeTokenAuthenticator` 导出 |
| 运行中的真实实例 | 端口 3000 是**已安装的 0.4.9 运行时**（`/Users/ganlu/Library/Application Support/XpodRuntime/releases/0.4.9/runtime/bun`），非当前源码树 |

结论：**"当前登录模块"（UI + OIDC + 会话层）就是已发布的 0.4.10 内容**；工作树里真正未发布的登录相关增量是 `src/identity/drizzle` 的字段下推重构。因此"发布"的目标需要用户确认（见第 5 节）。

## 1. 验收执行结果（本轮实际运行）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 服务器类型检查 | `bun run build:ts` | ✅ EXIT 0 |
| Components.js 生成 | `bun run build:components` | ✅ EXIT 0 |
| 登录前端单元（`ui/src/auth`、`ui/src/solid`、`ui/src/context`、Consent/Auth/LoginSelect 页） | `./scripts/run-vitest-safe.sh --run …` | ✅ 全部通过（`AuthContext` 47、`xpod-remembered-login` 32、`XpodOidcCallbackApp` 46、`XpodSolidRuntimeProvider` 65、`WebIdAuthBoundary` 16 …） |
| 后端身份 / OIDC / 认证单元（`tests/identity`、`tests/identity/oidc`、`tests/authentication`） | 同上 | ✅ 全部通过（`PodLookupRepository` 24、`owner-boundary` 27、`legacy-compatibility` 9、`PodOwnershipResolver` 32、`RememberedClientGrant` 17、`RememberedClientGrantHttp` 16、`issuer-isolation` 3、`SolidTokenCaches` 18 …） |
| SDK 包 | `bun run --filter '@undefineds.co/solid-sdk' test` | ✅ **125/125**（`session` 36、`pod-runtime` 34、`storage-selection` 19、`local-route-fetch` 14、`login-store` 13、`webid-auth` 7、`react` 2） |
| 登录 HTTP 集成（强化版） | 集成 lite 内 | ✅ `tests/http/ServerLogin.integration.test.ts` **12/12** |
| 登录相关 HTTP / 集成 | 集成 lite 内 | ✅ `ServerApiAuth` 6/6、`PasswordRecovery` 1/1、`CliPasswordLogin` 1/1、`AccountCookieMemory` 1/1 |
| 集成 lite | `bun run test:integration:lite` | ✅ **151 通过 / 6 跳过**（29 文件通过、3 跳过） |
| 集成 full | `XPOD_FULL_PROJECT=xpod-full-review bun run test:integration:full` | ✅ **45/45**（4 文件） |
| 登录相关**失败**（修复前） | `tests/ui/consent-first-pod.test.ts` | ❌ **6 失败 / 12 通过**，见第 3.1 节 |
| 登录**无关**失败 | `tests/ui/dashboard-pages-contract.test.ts` | ❌ 2 失败，见第 3.2 节 |

### 1.1 本轮已修复并复验

评审后按"先补失败回归、再最小修复"的顺序处理了两项（**未发布**，改动留在工作区）：

| 修复 | 改动 | 回归 | 红→绿验证 |
| --- | --- | --- | --- |
| Consent 页"换一个账号"把登出失败当成功（第 2.2 节阻塞项） | `ui/src/pages/ConsentPage.tsx`：跳转前用既有 `isAnonymous()` 确认已匿名，沿用 `xpod-product-logout.ts` 的同一判定模式（+9 −2） | `ui/src/pages/ConsentResume.test.tsx` 新增 2 项：失败时留在原路由并显示"退出未完成，请重试。"；确认匿名后才跳登录页 | ✅ 移除守卫后新回归**失败**（`Unable to find role="alert"`），恢复后通过 |
| 陈旧测试 `consent-first-pod.test.ts`（第 3.1 节） | `tests/ui/consent-first-pod.test.ts`：为每个创建/轮询链补上守卫要求的 Account Pod 清单 GET，并让会话 token 与 `Authorization` 头一致（+46 −14） | 18/18 | ✅ 原 6 项失败全部转为通过 |

复验结果（修复后）：

| 项目 | 修复前 | 修复后 |
| --- | --- | --- |
| 登录相关单元套件 | 959 通过 / 8 失败 / 3 文件红 | **1010 通过 / 2 失败 / 1 文件红** |
| `tests/ui/consent-first-pod.test.ts` | 6 失败 | **18/18 通过** |
| 集成 lite | 151 通过 / 6 跳过 | **151 通过 / 6 跳过** |
| 集成 full | 45/45 | **45/45** |
| `bun run build:ts` | EXIT 0 | **EXIT 0** |
| UI 类型检查（`ui/` 内 TypeScript 5.9 `tsc -b`） | — | **EXIT 0** |
| 变更文件 ESLint | — | **EXIT 0** |

修复后剩余的唯一红灯仍是第 3.2 节的 `tests/ui/dashboard-pages-contract.test.ts`（settings/tunnel-providers 契约漂移，与登录无关，且属他人未提交的重构范围，本轮未改动）。

两类失败都不在 `bun run test:integration` 的覆盖范围内：lite/full 只跑 `tests/integration` 与
`tests/http`，`tests/ui/**` 由根 `bun run test` 覆盖。因此"集成全绿"不能推出"单元套件全绿"。

### 环境说明（不影响上述结论，但影响复现）

- 本机默认 `bun` 是 **1.3.8**，仓库固定 `bun@1.3.12`（`package.json:299`、`Dockerfile:19`），
  且 `docs/testing/bun-http-response-completeness.md` 记录 1.3.8 存在大脚本响应中断缺陷。
  本轮单元/集成套件由 vitest 以 **Node** 运行（`vitest.config.ts` 的 `pool: 'forks'`），
  故不受该差异影响；若要以 bun 起服务做浏览器验收，必须先切到 1.3.12（本轮已下载到
  `.test-data/review-toolchain/bun-darwin-aarch64/bun`）。
- `minio/minio:latest` 已被 Docker Hub 上游删除（`pull access denied`）。本机已有仓库固定并
  使用过的 `quay.io/minio/minio@sha256:14cea493…`，本轮以其本地别名让 full 套件可运行。
- 首次 full 运行在 `docker compose -p xpod-full-test` 留下 3 个无法删除的悬空容器元数据，
  导致同项目名重建失败；改用 `XPOD_FULL_PROJECT` 换项目名后通过。该残留属 Docker 守护进程
  状态问题，非产品缺陷。

## 2. 设计评审

### 2.1 站得住的部分

- **权威边界在会话层真实成立**。`docs/superpowers/specs/2026-08-30-xpod-auth-authority-boundaries.md`
  的"不存在第三个合成会话"在代码中得到落实：Account（CSS）、WebID（Inrupt）、Pod 三者没有合并；
  WebID 就绪判据是两个独立条件（`authenticated && storageState === 'ready'`），Pod 失败走独立
  `podError` 通道；**未发现任何"Account 失败 → 注销有效 WebID 会话"的路径**。
- **回调不凭 URL 宣告成功**。唯一成功来源是 SDK `handleIncomingRedirect`，且要求 state 精确匹配、
  marker WebID 与实际会话 WebID 相等；`store.consume` 只在 Pod 打开校验通过后执行。
- **WebID 原文身份规则在服务端执行扎实**。所有身份比较都是原文精确匹配；`url.href` 只用于
  *存储地址* 规范化，与 `login-state-matrix.md:13-15` 的职责划分一致。
- **缺 owner 时不猜**。本地所有权解析要求「账户 webIdLink ∩ 候选 ∩ 显式 owner 行 ∩ 存储范围」
  四重成立，否则返回空；`webIdLink` 索引不产生所有权。
- **记忆授权生命周期正确**。复用前回查 live grant；撤销、过期、换账号、新增权限都仍需交互。
- **快照层 generation/epoch 防护完备**（`AuthContext` 与 SDK `identityOperationGeneration`），
  `consent-first-pod.ts` 的 token 快照守卫是全模块最严谨的样板。

### 2.2 发现（按严重级别）

标注 **[已独立验证]** 的条目由本评审直接读代码确认；其余来自子代理深挖并附行号，未逐条复跑。

#### 阻塞级

1. **[阻塞][已独立验证] Consent 页"换一个账号"把 Account 登出失败当成功。**
   `ConsentPage.tsx:340-350` 的 `catch` 分支不可达：`AuthContext.logout()` 失败时只
   `setAccountState({status:'error'})` 后 `return`（`AuthContext.tsx:368-374`），**不抛错**。
   于是 CSS logout 返回 5xx/网络失败时仍执行 `navigate('/.account/login/password/')`，
   用户看不到失败提示，旧 Account 会话被静默保留。`xpodConsentErrors.signOutIncomplete`
   成为死文案。违反 `login-state-matrix.md:108`「两域成功才报告整体成功……不能静默保留另一层」。
   注意产品退出路径（`xpod-product-logout.ts`）用 `isAnonymous()` 正确兜底，**缺口只在 Consent 页**。
   建议：`logout()` 失败时 reject 或返回状态由调用方判定；跳转前显式校验已匿名；补回归。

#### 主要

2. **[主要][已独立验证] unknown/error 被当作匿名。** `ConsentPage.tsx:641`
   `needsSignIn = !isLoggedIn || …`，而 `isLoggedIn` 仅在 `status === 'authenticated'` 为真；
   controls 连续 5xx 时 `AuthContext` 落 `{status:'error'}` 且 `initError` 为 null，
   `App.tsx:22-23` 只拦 initializing/initError → 页面渲染"需要先登录"。`ProtectedRoute.tsx:21`
   同模式，服务错误直接跳登录页。违反 `login-coverage-and-modularity.md:22`。
3. **[主要][已独立验证] 桌面托盘身份把 Account 与 WebID 合成一个布尔。**
   `XpodDesktopIdentityBridge.tsx` 的 `projectDesktopIdentity` 首行 `if (!isLoggedIn) return null;`，
   `isLoggedIn = accountState.status === 'authenticated'`（`AuthContext.tsx:112`）。
   已算出的 `webId`/`podUrl` 被该布尔整体否决 → Account 故障清空有效 WebID 的托盘身份，
   WebID-only 用户永远没有托盘身份。现有测试让 Account 与 WebID 同真同假，未覆盖独立性。
4. **[主要] 取消登录不中止在途 `runtime.login()`。** `WebIdAuthBoundary.tsx:120-129` 的 cancel
   只清 store 并抑制状态更新；协程继续走到 `window.location.assign`，用户取消后仍被跳到 IdP，
   返回时事务已失效。违反 `login-interaction-recovery.md:7`。
5. **[主要] 事务并发闸门 `loginInFlight` 是控制器实例级闭包。** `XpodLoginController.ts:51-74`；
   `WebIdAuthBoundary.tsx:50` 的控制器随 `runtime`（含 `snapshot`）变化重建、闸门归零；
   `ai-connections-host.ts:37` 另有一个控制器实例。于是"同标签页只允许一个活跃事务"没有单一所有者。
6. **[主要] ConsentPage 无 generation/abort 守卫。** `refreshConsentState` await 后无条件落状态，
   而挂载 effect 依赖登录态与 provisionCode；慢网络下迟到响应可覆盖用户刚做的绑定选择，
   随后按被覆盖的值完成授权。`AuthContext` 有完整 generation 机制，ConsentPage 完全没有。
7. **[主要·潜在] `handleIncomingRedirect(url)` 在 `initialize()` 挂起时丢弃回调 URL。**
   `packages/solid-sdk/src/session.ts:296-299` 直接 `return initialization`，URL 从不下传。
   当前主链路是整页导航故难触发；同文档内既恢复又处理回调的宿主会立即升级为阻塞。
8. **[主要·潜在] 无 logout epoch。** 代际守卫只保护快照与 capability，底层 Inrupt 的
   `session.fetch` 是稳定委托；退出**之后**到达的回调仍会发布 authenticated。
9. **[主要] Inrupt `login()` 永不 settle**（`solid-client-authn-browser` 内 `new Promise(() => {})`），
   `authenticationOperations` 在本 document 内永久 >0 → 所有身份绑定 fetch 抛 `AbortError`。
   主链路因换 document 归零而不可见；授权被 CSP/沙箱挡住、popup/embedded 授权面等场景会暴露。
10. **[主要] `login()` 与 `logout()` 无互斥**，logout 不取消进行中的登录。

#### 服务端

11. **[主要][已独立验证] 把"Pod 所有权"当成"账户身份"来解析角色。**
    `AccountRoleRepository.ts:310-326` 经 `owner` 行 → `pod.accountId` → 返回该账户 roles，
    被 `NetworkSettingsHandler`、`QuotaAdminHttpHandler` 消费。**可触发性未证明**
    （仓库内未找到授予 `admin` 的路径），且该语义在 v0.4.10 已存在，非本轮新增。
12. **[主要][已独立验证] 多 Pod 时静默取第一个。** `PodLookupRepository.ts:109-111`
    `findByWebId` 返回 `findAllByWebId(webId)[0]`；**紧邻其后的注释**
    （`:113-119`）恰好写着"调用方必须检查所有候选，而不是接受第一条记录"。
    调用点 `PodSettingsHandler.ts:88`、`AiConfigHandler.ts:201`、`container/common.ts:144-147`
    没有做歧义检查。与 `login-coverage-and-modularity.md:29` 冲突。
13. **[主要][已独立验证] 记忆授权写入发生在交互完成之后。**
    `RememberedConsentHandler.ts:40-64` 在 catch 到携带重定向的 `FoundHttpError` 之后
    才 `await rememberSchema.validate(...)` 与 `store.remember/forget`；
    `validate` 抛 `ValidationError` 会替换掉原始 `FoundHttpError` → 已批准的授权丢失跳转、变成 400/500。
    同模块 `ScopedPickWebIdHandler.ts:121` 用 `validateWithError`，口径不一致。
14. **[主要] 远端所有权解析分支疑为死路径。** `PodOwnershipResolver.ts` 约 150 行只在
    target 带 `lookupUrl/serviceAccessToken/…` 时进入，而 `ScopedPickWebIdHandler.ts:195-216`
    只填 `storageUrl`；grep 未找到生产构造点（仅单测注入）。

#### 次要（择要）

15. **[次要]（已更正）`queryIndexedStoreRows` 并非吞掉所有异常。**
    本节早先版本采信了 `.test-data/…/podlookup-refactor-review-20260918/README.md`
    的"把任何 SQL 异常转换为 `[]`"，但当前代码是
    `catch (error) { if (isMissingIdentityStore(error)) return []; throw error; }`
    （`PodLookupRepository.ts:438-448`）——**只有缺表才返回空，其余异常照常抛出**，属 fail-loud。
    该 README 的这条描述已过期，不应作为发布阻断依据。下推相关的真实结论见第 7 节。
16. **[次要][已独立验证] Account token cookie 缺 `Secure`**（`ui/src/utils/account-session.ts:30-44`）。
17. **[次要] 文档冲突待裁决**：spec 要求 Account token 为"session-scoped、无持久生命期"，
    而实现有意保留 CSS 的 14 天 `Expires`（`account-session.ts:87-97` 及测试断言），
    `login-coverage-and-modularity.md:31-32` 又把"记住账号"定义为决定该 cookie 生命周期。
    按 AGENTS.md 应上报裁决，不应默认现状正确。
18. **[次要] `automaticLoginBlocked` 只置位不复位**（`xpod-product-logout.ts:42`），
    实际是"本 document 内永久阻止自动登录"，仅整页刷新复位。
19. **[次要] 重复实现**：4 份逐字相同的 `sameUrl`、5 份 WebID/storage 归一化、
    两套 first-pod 实现、两套 Account 登出实现、两套 Consent 失效分类。
    其中 `XpodRememberedLoginBridge.tsx:32` 用裸字符串比较，与就绪门/用户卡的规范化比较不一致，
    **已产生真实行为差异**（Pod URL 表征不同时"记住登录"永不写入）。
20. **[次要] 服务端 WebID 原文合法性规则复制 8 份**，任一处放宽不会波及其他路径。

## 3. 测试评审

### 3.1 [已独立验证] v0.4.10 **带着 6 项失败的登录测试发布**

- `tests/ui/consent-first-pod.test.ts` → **6 failed / 12 passed**。
- 该文件、`ui/src/utils/consent-first-pod.ts` 与 `ui/src/utils/pod.ts` 均与 `v0.4.10`
  **逐字节相同**（`git hash-object` == `git rev-parse v0.4.10:<path>`）。
- **在干净的 `v0.4.10` 检出（`/Users/ganlu/develop/.worktrees/xpod-ai-connections-session-cancel`，
  `git status` 干净）上运行同一文件，结果同样是 6 failed / 12 passed。** 故失败随已发布产物存在，
  不是本工作区引入。
- 根因：v0.4.10 的提交 `8b2e2dbd` 给 `consent-first-pod.ts` 加了"创建前先读 Account Pod 清单"
  的守卫（`assertFirstPodCreationIsNew`），并新增了
  `ui/src/utils/consent-first-pod.guard.test.ts`（该文件 **24/24 通过**），
  但**没有同步更新**原来的 `tests/ui/consent-first-pod.test.ts`：后者的 `fetchMock` 只排了 3 个
  响应，缺 inventory 那一笔，于是被守卫判为 `inventory-unavailable` / `account-changed`。
- 影响判定：**这是测试陈旧，不是产品缺陷**——生产行为有独立的 24 项守卫测试覆盖，
  且失败方向是 fail-closed。但它使登录首 Pod 创建链路的回归套件处于红色状态。

### 3.2 [已独立验证] 工作树新增的无关失败

`tests/ui/dashboard-pages-contract.test.ts` → 2 failed。在干净 `v0.4.10` 上该文件
**11 passed / 1 todo**，故这是工作树未提交的 settings/tunnel-providers 重构
（新增 `ui/src/utils/tunnel-providers.ts`、`SettingsPage.tsx` -141 行）引入的契约漂移，
**与登录模块无关**，但会阻塞"全绿"。

### 3.3 流程缺口：RC 门禁不跑单元套件

`.github/workflows/candidate.yml`（发布分支唯一会跑的 workflow）**不执行** `bun run test` /
vitest；`ci.yml`（含 `bun run test:run`）的触发条件是 `on: push/pull_request: branches: [main]`。
因此 `release/0.4.x` 上的提交可以带着红色单元测试被 tag 并发布——3.1 正是这一缺口的实例。

CI 的浏览器登录覆盖也远小于文档印象：`ci.yml` 调用的 `bun run test:account-layout` 只匹配
`tests/e2e/account-web-layout.spec.ts`，该文件全部 `route.fulfill`（文件头自述不是真实验收证据）
且多处使用 `click({ trial: true })` 从不真正提交。`shared-login`、`login-deployment-matrix`、
`desktop-login-lifecycle`、`consent-recovery`、`account-webid-isolation`、`browser-session-refresh`
**均不在 CI**；`desktop/test/**` 被 `vitest.config.ts` 排除，且没有 CI job 调用
`desktop/package.json` 的测试脚本——属"有测试但永不执行"。

### 3.4 声明与可执行证据的落差

- `docs/testing/login-audit-2026-09-15.md:83-87` 把 `tests/http/ServerLogin.integration.test.ts`
  的"12/12 通过"作为"正确密码/错误密码/不存在邮箱/重复注册"的唯一分层证据，但该文件受
  `XPOD_RUN_INTEGRATION_TESTS === 'true'` 门禁，默认运行是 **12 项全 skip**。
  本轮已在集成 lite 中真实执行并确认 **12/12 通过**，故此声明成立，但需注意它的默认跳过状态。
  该文件已被 `scripts/run-integration-lite-local.ts` 显式纳入且 CI 跑 lite，故不是无证据，
  而是"默认单测 lane 里等于 0、文档未说明"。
- 18 格矩阵**没有任何测试带格子编号**（grep `W-A-C|W-I-C|D-A-C|A-I-C` 零命中）。12 个
  Web/applet 格由 `login-deployment-matrix.spec.ts` 的 6 条参数化用例代表，6 个桌面格由
  `desktop-login-lifecycle.spec.ts` 的 3 条代表，属**部分证实**；`login-coverage-and-modularity.md:76`
  的"18 格均已有对应入口与部署证据"是叙述性归纳。
- 安全矩阵 21 行中，可判定为已证实 14 行、部分证实 6 行、**无独立证据 1 行**：
  "记住账号与记住应用相互独立"没有证据——`ConsentPage.tsx` 把 `rememberClient` 写进提交体，
  但全仓库没有测试检查该请求体（现有测试只数 POST 次数），把 `remember` 硬编码为 `true`
  测试仍会全绿。
- `tests/e2e/login-deployment-matrix.spec.ts` 在无 `XPOD_E2E_LOGIN_MATRIX_MANIFEST` 时只产出
  1 条 skip 桩（带 manifest 是 9 条，而非文档写的 6/6）；`CliPasswordLogin.integration.test.ts`
  用 `it.skipIf(!XPOD_QLEVER_LOCAL_RUNTIME_COMMAND)`。这些套件的"通过"依赖环境变量而非默认执行。
- 文档中的 51/51、7/7 等浏览器/Electron 计数未被本轮复现（需要真实浏览器与 Electron 栈）；
  其中 `login-audit:133` 的"Host 29 文件/359 项、SDK 74、桌面 137"与 `login-interaction-recovery:64`
  的"77 项"经实测无法复现（实测 Host 25 文件/375、SDK 7 文件/125、桌面 20 文件/140、
  `WebIdAuthBoundary` 已从 15 变 16）。
- 正面确认：两个 Playwright 配置与两个 matrix runner **都没有配置 retries**，未发现以重试掩盖
  flaky；也未发现把 404 当作成功的断言。

## 4. 未覆盖 / 未验证

- 浏览器 Playwright 套件（`test:integration:auth`、`:auth:matrix`）与 Electron 桌面套件本轮**未执行**；
  它们需要系统 Chrome / Electron 与安装版原生 QLever。
- 未连接运行中的 3000 实例做真实账号验收：该实例是已安装的 **0.4.9**，不是本轮评审的源码状态。
- 子代理报告中标注"潜在/可达性推断"的条目（第 2.2 节第 4、6、7、8、9、10 项）未构造复现用例。
- Inrupt 补丁（`scripts/patch-inrupt-authn-operation-cleanup.js`）未生效时的行为差异未验证。

## 5. 发布建议与待决事项

**本轮决定（用户确认）：只做评审与修复，本次不发布。** 因此没有任何 tag、push、
npm 发布或生产部署动作；下面保留后续发布的待办。

1. **发布目标仍待确认**。"当前登录模块"的 UI/OIDC/会话层已经作为 `v0.4.10` 发布
   （npm `latest` + GitHub Release），直接重发没有意义。工作树里真正未发布的登录相关增量是
   `src/identity/drizzle` 的字段下推重构，以及本轮的两项修复。可选目标：(a) 作为新版本
   （如 0.4.11）走完整 RC；(b) 继续只做评审；需用户明确。
2. ~~发布前应先修复阻塞级缺陷并同步更新陈旧测试~~ —— **本轮已完成并复验**（第 1.1 节）。
3. **建议把 `bun run test` 纳入 `candidate.yml`**，否则同类"红色发布"会继续发生。
4. **建议补上"记住账号 / 记住应用相互独立"的 consent 提交体断言**，这是安全矩阵中唯一
   无独立证据的一行。
5. 工作树当前有 414 个改动文件与 298 个未跟踪文件，且含与发布无关的临时目录
   （`data.bak-*`、`.xpod.bak*`、`tmp/pdfs`、`real-*-*`）。从该工作树直接切发布分支不可取，
   需要先界定提交范围。
6. 发布前需处理的环境障碍：`minio/minio:latest` 已从 Docker Hub 上游删除（full 套件依赖它）；
   首次中断的 full 运行留下 3 个无法删除的悬空容器元数据，占用 `xpod-full-test` 项目名，
   需重启 Docker 守护进程才能清理。

## 6. 复现命令

```sh
# 类型检查与组件定义
bun run build:ts && bun run build:components

# 登录单元 / 身份 / OIDC / 认证
./scripts/run-vitest-safe.sh --run ui/src/auth ui/src/solid ui/src/context \
  ui/src/pages/ConsentPage ui/src/pages/AuthPages ui/src/pages/LoginSelectPage \
  tests/ui tests/identity tests/authentication \
  tests/http/ServerLogin.integration.test.ts tests/http/AccountCookieMemory.integration.test.ts

# SDK
bun run --filter '@undefineds.co/solid-sdk' test

# 集成（lite 通过；full 需换项目名以避开残留 compose 状态）
bun run test:integration:lite
XPOD_FULL_PROJECT=xpod-full-review bun run test:integration:full

# 证明 6 项失败随 v0.4.10 一起存在（干净检出）
cd /Users/ganlu/develop/.worktrees/xpod-ai-connections-session-cancel
./node_modules/.bin/vitest --run tests/ui/consent-first-pod.test.ts

# UI 类型检查（必须用 ui/ 内的 TypeScript 5.9；根目录是 5.5，不认识新编译选项）
cd ui && ./node_modules/.bin/tsc -b
```

本轮日志：`.test-data/review-login-unit.log`（修复前）、
`.test-data/review-login-unit-after-fix.log`（修复后）、
`.test-data/review-integration.log`、`.test-data/review-integration-full2.log`、
`.test-data/review-integration-lite-after-fix.log`、`.test-data/review-integration-full-after-fix.log`。

## 7. `src/identity/drizzle` 未提交改动的性质（是否只影响性能）

这是工作树里唯一真正未发布的登录相关增量（`v0.4.10` 之后的改动）。结论：
**点查语义已核对为等价，但整批改动不止性能——其中夹带了真实的功能修复、容错语义变化、
一个公开方法删除，以及授权解析的优先级变化；而下推本身在最需要它的 PostgreSQL 上并没有用上索引。**

### 7.1 改了什么

| 文件 | 规模 | 性质 |
| --- | --- | --- |
| `db.ts` | +41 −7 | 新增方言化 JSON 谓词助手 `jsonFieldExtract/Equals/In/IsPrefixOf`（SQLite `json_extract` + `json_valid` 守卫；PG `->_>`）；删除空实现 `migratePostgresColumns`；**丢失文件末尾换行** |
| `PodLookupRepository.ts` | +316 −117 | 点查下推（见 7.2） |
| `AccountRoleRepository.ts` | +184 −16 | 下推 + 授权解析优先级变化（见 7.4） |
| `EdgeNodeRepository.ts` | +5 −22 | **非下推**：时间戳单位修复 + 容错变化 + 删除公开方法（见 7.4） |

动机：原先每个登录/Pod 解析路径都调用 `getAllPods()`，它执行
`SELECT container, id, payload FROM identity_store WHERE container IN ('pod','owner')`
——**读取全部 Pod 与 owner 行**，再在 JS 里过滤解析；Cloud 多账户下是每请求一次 O(N) 全表读。

下推后：
- `findById` → `container='pod' AND id IN (…)`
- `findByWebId(s)` → owner 行按 `payload->>'webId' IN (…)` 取其 `podId`，加上 pod 行自身 `webId IN (…)` 的 `id`，只加载这些 pod 及其 owner 行
- `listByAccountId` → `payload->>'accountId' = ?`
- `findByResourceIdentifier` → 反向前缀 `LIKE` 预筛 + JS `startsWith` 复核
- `listAllPods` 保留全量读取（本就需要候选全集）；KV 历史行仍全量读取（无法下推）

### 7.2 语义等价性：已逐项核对，成立

- **候选选择等价。** 装配函数 `buildIndexedStorePods`（`:454-496`）构造
  `webId = podWebIds[0]`、`webIds = podWebIds`，来源**只有两处**：pod 行自身的 `webId` 字段，
  以及 `podId` 指向该 pod 的 owner 行。而下推查询恰好按这两处取候选。
  这与旧路径 `getPodWebIds(pod) = [pod.webId, ...pod.webIds]` 的匹配条件**是同一个集合**。
- **canonical 遮蔽不变量保留。** `mergeCanonicalPods`（`:240-257`）不是用"成功构建的 pod"
  做遮蔽，而是重新按 `container='pod' AND id IN (legacyIds)` 取**原始行**构造 `canonicalIds`。
  因此**缺 baseUrl/accountId 而无法解析的 canonical 记录仍然遮蔽 legacy 记录**，
  `v0.4.10` 的"canonical 整条优先，包括无法解析的记录，不能恢复旧身份"未被破坏；
  代码里也有对应注释（"Raw ID queries must still see malformed rows for canonical shadowing"）。
- **异常处理是 fail-loud。** 见第 2.2 节第 15 条的更正。
- **PG 无 malformed 风险**：`payload JSONB NOT NULL`；SQLite 侧有 `json_valid` 守卫。

已知的窄口子（**两个版本都存在，非本次引入**）：一个 Pod 若有多个 owner WebID 且自身无 `webId`，
则 `webId: podWebIds[0]` 取哪个取决于数据库行序；新旧两条查询形状的行序本就都未定义，
故**多绑定 Pod 的"唯一 WebID"在设计上没有确定值**。这与设计中"多个绑定必须显式选择"
只被 UI 遵守、仓储层仍静默取第一个是同一个缺口。

### 7.3 下推并未用上索引：双引擎独立复现

代码生成的谓词与索引表达式**不是同一个表达式**，PostgreSQL 按表达式树语法匹配索引，无法命中：

| 引擎 | 索引定义 | 代码生成的谓词 | 实测计划 |
| --- | --- | --- | --- |
| PostgreSQL 16 | `(container, jsonb_extract_path_text(payload,'webId'))`（`DrizzleIndexedStorage.ts:117`） | `payload ->> 'webId'`（`db.ts:464`） | 索引表达式 → **Index Scan / Index Cond**；代码表达式 → **Seq Scan / Filter** |
| SQLite 3.51 | `(container, json_extract(payload,'$."webId"'))`（`DrizzleIndexedStorage.ts:112`） | `json_extract(payload, ?)` —— JSON 路径被**绑定为参数** | 字面量路径 → `SEARCH … (container=? AND <expr>=?)`；参数化路径 → `SEARCH … (container=?)` |

复现方式（本轮实跑，PG 用一次性 `postgres:16-alpine` 容器、20,000 行、`ANALYZE`，
SQLite 用 `bun:sqlite` 内存库 20,000 行；容器用后即删）：

```sh
# SQLite：参数化 JSON 路径使索引第二列退化为后置过滤
bun run /tmp/idx-probe.ts
# PostgreSQL：EXPLAIN (COSTS OFF) 对比两种表达式
docker run -d --rm --name pgprobe -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=probe \
  -p 127.0.0.1:60551:5432 postgres:16-alpine
# 建表 + 建索引 + 插入 20000 行 + ANALYZE，再对比：
#   jsonb_extract_path_text(payload,'webId') = '…'   → Index Scan
#   (payload ->> 'webId') = '…'                      → Seq Scan
```

影响：在 Cloud/PostgreSQL 上点查**仍是 Seq Scan**，收益来自"服务端过滤后返回更少的行、
不再在 JS 里解析全表"，而**不是索引定位**；该改动集刻意引入的 `payload ->> ...` 写法正是
拿不到索引的原因。这是**性能**结论，不改变 7.2 的功能等价性判断。

### 7.4 同一改动集里的**功能性**变化（不是纯性能）

1. **`EdgeNodeRepository` 时间戳单位修复（真实 bug 修复）。**
   `Math.floor(Date.now()/1000)` 被替换为 `toDbTimestamp(this.db, now)`
   （`db.ts:429-431`：SQLite → Unix 秒，PG → `Date`）。
   SQLite 行为不变；**PostgreSQL 上节点注册/心跳此前把 Unix 秒写进 timestamp 列**，现已修正。
   `DdnsRepository` 早已使用该助手，本次是对齐。
2. **`EdgeNodeRepository` JSON 容错语义变化。** 4 处内联 `JSON.parse(row.metadata)` 改为
   `parseJsonRecord`（`:767-780`），后者 `catch` 解析失败并返回 `null`。
   由"遇到坏 metadata 抛错"变为"返回 null"，是**失败语义的放宽**。
3. **`EdgeNodeRepository` 删除公开方法 `listNodesByAccount`。** 已确认唯一引用在
   `src/api/handlers/NodeHandler.ts.disabled`（禁用文件），**删除安全**。
4. **`AccountRoleRepository` 授权解析优先级（需关注）。**
   `findAccountIdByWebId`（`:286-326`）的解析顺序为：
   ① `webIdLink` 行 → ② `account` 行的 `webId/webid/primaryWebId/primary_webid` 字段 →
   ③ `owner` 行 → `pod` 行 → `pod.accountId`。且 `findByWebId` 在快路径命中时
   **短路跳过 legacy 全扫描**；`findByAccountId` 改为优先取 `webIdLink[0]` 而非 payload 内嵌 webId。
   - 顺序把权威的 `webIdLink` 放在最前，方向正确；
   - 但 ③ 使**账户角色（含 `admin`）可由 Pod 所有权推导**，这是第 2.2 节第 11 条；
   - 且每一步都是 `LIMIT 1` **且无 `ORDER BY`**：多个账户命中时返回哪个**未定义**，
     而该值直接进入 `NetworkSettingsHandler` / `QuotaAdminHttpHandler` 的授权判断。
     这是**设计缺口（缺少确定的 tie-break）**，不是性能问题。
   - 另：`legacyAccountDataDir` 从模块级 `path.resolve('.internal','accounts','data')`
     改为可注入选项（默认仍按 CWD 惰性解析），方向正确。

### 7.5 一句话回答

**对 Pod 查找路径，"只影响性能、不影响功能"这个判断我验证后成立**（候选集合与 canonical 遮蔽
均已逐项核对等价）。但**整批未提交改动不能这样概括**：它同时包含 PG 时间戳的真实 bug 修复、
JSON 解析的容错放宽、一个公开方法的删除，以及授权解析的优先级与不确定性变化；
而它想达成的索引加速，在两个引擎上都没有真正发生。

## 8. 设计层面：状态、链路与测试的遗漏

第 2 节主要基于实现阅读。本节专门回答"设计本身漏了什么"，结论是：
**权威边界这一层设计是扎实的，但状态清单与链路清单并不完整，且设计自己声明的验收契约缺少自动门禁。**

### 8.1 状态（states）

#### 8.1.1 设计状态机的节点在实现中没有对应物

`login-state-matrix.md:32-45` 的状态图使用 `AccountRequired / AccountReady / Authorizing /
IdentityReady / StorageRequired / StorageUnavailable / PodReady`，`:51-60` 的退出状态图使用
`SignOutWebID / RetryWebID / SignOutAccount / RetryAccount / SignedOut`。
两张图合计命名 **12 个状态、18 条边**；在 `ui/src` 与 `packages/solid-sdk/src` 中检索，
**11 个状态名命中数为 0**，唯一命中的 `Authorizing` 也只是同名的其他标识符
（`isAuthorizing`），并非该状态。

文档"状态归属"一节明确说"不另造一个覆盖 CSS 和 OIDC 内核的大状态机"，这是**有意的组合式设计**，
不是疏忽。但代价是真实的：状态图宣称的合法/非法转换**没有任何产物可以对照检验**；
实现把同一批情形表达为三个独立状态源加上登录链路上约 30 个分散的 `useState`
（`pending`/`actionError`/`podError`/`loginCancelled`/`switchRequested`/`resumeState`/
`failedAction`/`isSubmitting`/`isCreatingStorage`/`isAuthorizing`/`isCancelling`/`isReturning`/
`isSwitchingAccount` …）。每新增一个布尔，就是一次没有设计评审的状态扩展。

#### 8.1.2 三层状态清单的完整度不一致

| 层 | 设计是否给出状态清单 | 代码实际状态 |
| --- | --- | --- |
| Account | ✅ 5 态：initializing / anonymous / submitting / authenticated / error | 5 态，**一致**（`AuthContextValue.ts:5-10`） |
| WebID | ✅ 5 态：initializing / anonymous / authenticated / expired / error | 5 态，但**命名不同**：代码首位是 `loading` 而非 `initializing`（`ui/src/solid/XpodSolidRuntime.ts:32`） |
| Pod / 存储 | ❌ **只写了"成功证据"和"不能当作成功证据"，没有状态清单** | **8 态**：`packages/solid-sdk/src/storage-selection.ts:4-12` — loading / empty / selecting / creating / waiting_for_binding / ready / conflict / error |

也就是说，Pod 层是一个 8 态状态机，却既无状态清单、也无转换契约，并且没有出现在
`2026-08-30-xpod-auth-authority-boundaries.md` §8 的失败隔离矩阵里。这与 Account/WebID
两层受到的对待明显不对称。

#### 8.1.3 缺失的状态（设计没有表达、实现也没有）

1. **"身份变更中"没有状态。** Account 已清、新身份未成的中间态没有任何表示。这正是
   ConsentPage 迟到响应能覆盖用户刚做的绑定选择的根因（第 2.2 节第 6 项）——若该中间态存在，
   "在此期间到达的响应一律作废"就有地方可写。
2. **"退出部分完成"没有一等状态。** 现由 `xpod-product-logout.ts` 的模块级 `solidCleared` +
   `automaticLoginBlocked` 表达。后者**只置位、无复位路径**（`:42`）：设计写的是"退出过程中
   阻止自动登录"，实际语义是"本 document 内永久阻止自动登录"，只有整页刷新才复位，
   而且**没有任何测试**断言其复位语义（`grep automaticLoginBlocked --include='*.test.*'` 零命中）。
   设计没有定义"何时解除阻止"。
3. **"Pod 绑定歧义"没有状态。** 设计说"多个绑定显式选择；冲突不得静默选另一个 Pod"。
   **UI 层做到了**：`xpod-storage-selection.ts:79-85` 仅在唯一候选时返回 `ready`，
   多候选返回 `selecting` 交给显式选择器。但**服务端仓储没有**：`PodLookupRepository.findByWebId`
   返回 `findAllByWebId(webId)[0]`，且 `PodSettingsHandler`、`AiConfigHandler`、
   `container/common.ts` 都不做歧义检查。同一条设计规则在两层执行不一致——这是设计没有把
   "歧义"定义成需要跨层一致处理的状态。
4. **token 续期中间态未建模**：没有"refresh 进行中"与"refresh 失败但 access token 仍有效"的区分。
5. **error 与 anonymous 的区分在 WebID 侧被破坏**：`packages/solid-sdk/src/session.ts:76-85` 把
   `isLoggedIn && !webId` 归为 `anonymous` 并 latch（`initialized = true`，本 document 内不再重试）；
   `ui/src/solid/XpodSolidRuntimeProvider.tsx:91-97` 在 `logout()` 抛错时也无条件投影为 `anonymous`。
   设计明确要求"未知或损坏不得当作匿名"，这条在 Account 侧有实现、在 WebID 侧没有。
6. **"多 storage / 多 Pod"在 WebID-Pod 权威层没有"显式选择"状态。**
   已认证 WebID 的 profile 声明多个 storage 时，`XpodSolidRuntime.ts:143-147` 直接抛
   "declares multiple Solid storage URLs; **choose an explicit storage**"，该错误经 provider
   折进 `runtime.podError`（`XpodSolidRuntimeProvider.tsx:243-261`），再由 `storageSelectionState`
   折成 `{ status: 'error' }`（`WebIdAuthBoundary.tsx:286-288`）。
   需要精确表述的是：**这不是"无出口死端"** —— 边界渲染的是
   `无法打开选中的 Pod，请重试。`（`WebIdAuthBoundary.tsx:32`，**把具体原因压成了一句通用文案**）
   并同时给出"重试"与"切换账号"两个出口。真正的问题是：
   - 该路径**没有 storage 选择器**。`storageSelectionState`（`:279-306`）只能返回
     `waiting_for_binding / ready / conflict / error`，因此 SDK 明明定义了
     `selecting / empty / creating` 三态，**在这一层不可达**；
   - 于是"多个绑定显式选择"这条设计规则只在 **Consent 链路**实现，
     在直接登录/静默恢复链路缺失，用户唯一有效逃生是**切换账号**；
   - 运行时给出的"请显式选择 storage"提示**永远不会显示给用户**。

### 8.2 链路（chains）

以下是本轮已验证、**设计描述与实际链路不一致**的入口：

1. **Consent 页"换一个账号"缺少失败出口**（本轮已修）。设计写"两域成功才报告整体成功，
   不能静默保留另一层"，产品退出路径实现了，Consent 页这条链路没有——说明设计列了规则，
   但链路清单没有覆盖所有实现该规则的入口。
2. **取消链路缺少"中止在途授权导航"的定义。** 设计（`login-interaction-recovery.md:7`）说取消应
   "取消当前交易，持久化手动进入意图，不自动重入"，但没有定义"授权导航已经发出"之后取消的语义；
   实现因此只清 store，不 abort 在途 `runtime.login()`。
3. **登录与退出的并发链路未定义。** 设计只写了"退出过程中阻止自动登录"，没有定义
   "先点登录、再点退出"的最终状态；SDK 层 `login()`/`logout()` 无互斥、无 logout epoch。
4. **多标签 PKCE 隔离的保证没有落到 SDK 契约。** 设计声称 A 的 client/PKCE 不被 B 覆盖，
   实际依赖 Inrupt + Web Locks 的运行时行为；SDK 既不清理注入命名空间（`xpod.inrupt.insecure:*`）
   下的记录，也不暴露可断言的清理结果，等于把该保证留给宿主而未写成契约。
5. **设计 §11 的浏览器权威验收没有自动门禁。** 规范说"浏览器权威子集可用
   `bun run auth:accept:browser` 执行，使用真实一次性 CSS/OIDC 夹具，而不是 mock 或源码文本断言"。
   该命令存在，`tests/e2e/shared-login.spec.ts` 中确有 **5 条 `@auth-boundary` 真实用例**，
   但 `.github/workflows/*` 中**没有任何 workflow 调用 `auth:accept`**。
6. **18 个回调失败码及其三分处置没有设计文档（已抽样验证）。**
   `packages/solid-sdk/src/webid-auth.ts:57-67`（协议码）与
   `ui/src/solid/XpodOidcCallbackApp.tsx:38-46`（存储码）定义了失败分类，
   并按"可重试 / 自动重置后重试 / 重置并重启"三分处置。
   抽样 7 个码在 `docs/` 中检索：`invalid-state`、`expired-transaction`、
   `replayed-transaction`、`oidc-state-invalid`、`storage-unavailable`、`redirect-failed`
   **命中数均为 0**，仅 `local-binding-missing` 命中 1 处。
   这是一份产品级安全契约（决定"哪些失败可以悄悄重试、哪些必须让用户重新授权"），
   目前**无法评审**。
7. **产品退出没有取消点，且"第二次退出请求"语义未定义。**
   `xpod-product-logout.ts:41-43`：`inFlight` 时直接返回既有 promise 并**丢弃新的 `onComplete`**；
   非 inFlight 的**新**调用（`XpodUserCard.tsx` 的 `runSwitchAccount`）会重建 operation 并把
   `solidCleared` 重置为 `false`。文档的约束句是"已成功的 WebID 清理不因 **Account 重试**而重复执行"，
   而 `retryXpodProductLogout` 确实保留了该标志（合规）；**未被定义的是**"退出处于 error 态时
   用户改点切换账号"该走哪条语义——现状是静默重置并丢弃旧意图。
8. **`applet.requireLogin(): Promise<void>` 没有失败/取消信号**
   （`packages/extension-sdk/src/web.ts:264`），applet 无法区分"用户取消"与"登录失败"。

### 8.2.1 文档声明但代码不可达 / 无生产者的状态

| 状态 | 文档 | 代码现实 |
| --- | --- | --- |
| Account `submitting` | `login-state-matrix.md:25` 列为权威状态 | **无生产者**：`ui/src` 中除类型声明（`AuthContextValue.ts:8`）外没有任何 `setAccountState({status:'submitting'})`；只在 `AccountAuthBoundary.test.tsx:41,85` 以 prop 注入渲染 |
| WebID `connecting` | `webid-auth.ts:47` 有该取值 | 边界层不产出它，`connecting` 只是布尔派生（`WebIdAuthBoundary.tsx:169`） |
| Account `unknown` | `login-coverage-and-modularity.md:22` 明确要求区分 unknown/error/anonymous | **没有 unknown 态**：瞬时 502/503/504 由 `transientAccountState(exposeError)` 折叠成 `error` 或 `initializing` 二选一（`AuthContext.tsx:53-57`） |
| WebID `initializing`（文档用词） | `login-state-matrix.md:26` | 代码首位取值是 `loading`（`XpodSolidRuntime.ts:32`），命名不一致 |

### 8.3 测试遗漏（设计契约 → 可执行证据）

1. **§11 权威验收契约的常驻守卫是源码文本断言。**
   `tests/ui/auth-authority-boundaries.test.ts` 用 `expect(app).toContain('AuthProvider')`、
   `not.toContain('XpodAuthProvider')` 这类**读文件字符串**的断言检查代码形状。
   规范自己也说静态守卫只能"补充"而不能替代行为与视觉检查——但真实行为版本
   （`auth:accept:browser`）不在 CI，于是 CI 里实际生效的只有静态形状检查。
2. **Pod 层 8 态中有 2 态零测试覆盖。** 按 `status: '<state>'` 在测试文件中检索：
   `creating` **0** 个测试文件、`waiting_for_binding` **0** 个；其余 6 态有覆盖
   （loading 2、empty 2、selecting 3、ready 7、conflict 2、error 20）。
   而 `creating` / `waiting_for_binding` 正是首次创建 Pod 的两个状态。
3. **失败隔离契约只测了投影层。** spec §8 要求"Pod 资源 401/403/404/500 不得改变
   Account/WebID 会话状态"，实际只有 `WebIdAuthBoundary.test.tsx:174-193` 用**注入的
   `podError`** 验证 UI 反应，没有真实 401/403/404/500 下的会话状态不变量验证。
4. **18 格矩阵没有逐格证据。** 无任何测试带格子编号，12 格由 6 条参数化用例代表、6 格由 3 条代表。
5. **安全矩阵 21 行中有 1 行无独立证据**：记住账号与记住应用相互独立（consent 提交体无断言）。
6. **状态转换没有逐边测试。** 两张设计图共 18 条边，其中如 `StorageUnavailable → PodReady`
   （重试连接、不重复兑换 code）有测试，但**没有任何测试是对着状态图的边逐条映射的**；
   非法转换（如"账号已切换却仍返回 Pod ready"、"退出后迟到回调恢复身份"）也缺少系统负例。
7. **默认 `bun run test` 的实际覆盖远小于文档印象**：`tests/http/ServerLogin.integration.test.ts`
   12 项默认全跳过；`tests/e2e/**` 与 `desktop/test/**` 被 `vitest.config.ts` 排除，
   且没有 CI job 执行后者。
