# 快速修复模式 · 交接文档

- **来源会话**：`session-5608ce05-7034-404a-ae0e-8374d5d43799`（标题「快速修复模式」）
  - 时间：2026-09-12 11:46 → 2026-09-13 00:29（42 轮 / 4122 事件 / 一次 compaction）
  - 结束方式：最后一轮正常收尾并给出汇报，随后会话不可继续（GUI 侧中断）
- **提取方式**：接手会话（`session-a5a8a8e7-4143-427c-877b-f6548a8c7a65`）直接解压原会话事件日志
  `~/.dsh/sessions/--Users-ganlu-develop-xpod--/session-5608ce05-.../session.v3.jsonl.zstd`
  （`zstd -d`，4124 行 JSONL）后逐段提取，**不是**凭记忆复述。
- **提取时间**：2026-09-13 01:15

---

## 0. 一句话现状

「快速修复模式」的**四批改造（①单目录源 ②拆凭证池 ③夹具工厂 ④拆 client）已全部完成并提交**，
测试全绿；**没有半成品代码留在工作区**。剩下的是三项**验证/决策类**尾巴（见 §6），
以及继续接待你实时报的 UI 问题——**回路本身还活着**（§2 已实测）。

---

## 1. 这个会话在干什么（意图）

1. 你说：「类似开 dev server，我一边体验一边给你发问题，你快速修改完我立刻能看到结果」，
   **优先桌面端**。→ 建了 §2 的快速回路。
2. 过程中随报随修：桌面端加载失败后白屏不恢复、chat 没有日志、Dashboard 登录缺注册/忘记密码入口、
   provider offering 名称不一致、智谱/百炼 logo 错。
3. 架构清理（你指定顺序「先做 123」）：
   - ① 单一 provider 目录源（从 UI 和 server 各一份 → 共享包一份）
   - ② 拆 `AiCredentialPoolSection.tsx`（1329 行）
   - ③ 共享测试夹具工厂
   - ④ 拆 `ai-connections-client.ts`（1617 行）
   - 其中 ④ 原本被推迟，后来一并做了。
4. 边界口径讨论（你逐条给的判决，见 §4）→ 落成 `docs/catalog-ownership.md` + `AGENTS.md`。
5. rc 发布策略（你要求：rc 极小化对外影响）→ 落成发布脚本守卫。

---

## 2. 快速修复回路（**当前可用，已实测**）

### 2.1 正在跑的进程（2026-09-13 02:55 实测）

| 角色 | 端口 | PID | 实测 | 来源 |
|---|---|---|---|---|
| Xpod Gateway（真实运行时） | `:3000` | 4454 | `/service/status` css+api running；`/alice/` `/test/` `/gcloud/` 均 200；`/provision/status` registered | **仓库源码**运行时（cwd = 仓库根，日志写 `logs/xpod-2026-09-13.log`），01:59:58 启动 |
| CSS 内部 | `:3001` | 4496 | — | 同上 |
| API 内部 | `:3002` | 4497 | — | 同上 |
| Vite dev server | `:5174` | 14783 | `/ai-connections`、`/settings/`、`/status/overview` 均 200 且含 `@vite/client` | cwd = `ui/`，即 `BUILD_TARGET=settings bunx vite --host 127.0.0.1 --port 5174 --strictPort` |
| Vite dev server（另一个） | `:5173` | 2178 | 200 | cwd = `ui/`，来源不明（可能是用户自己起的） |

> ⚠️ **内部端口不固定**：原会话那次实例用 `5737`/`5738`，当前实例用 `3001`/`3002`。
> 别把端口号写进脚本或判断里——要判断「运行时是否健康」就查 `/service/status`。

节点身份：`7cca443f57b7b8bba68b56344237a4a2`，cloudUrl `https://api.undefineds.co/`，
oidcIssuer `https://id.undefineds.co/`。

> ⚠️ **运行时不会跨重启存活**，而且**它已经被弄挂过一次**（见 §10 事故记录）。
> 重启要按 §2.4；从沙箱里直接起会因为写不了 `~/Library/Application Support/Xpod` 而
> **CSS 起不来**（现象：`/service/status` 说 css running，但 `:5737` 没人听、Pod 全 502，
> 日志里是 `EPERM ... .xpod-cloud-registration.json`）——必须提权到 `danger-full-access`。

### 2.2 两种「立刻看到结果」的通道

- **A. 改完重建静态包（给打包版/桌面 App 用）**
  ```bash
  cd ui && BUILD_TARGET=settings  bunx vite build   # ≈23–30s，settings/ai-connections/status 等面
  cd ui && BUILD_TARGET=dashboard bunx vite build   # ≈8–10s
  ```
  重建后你在窗口里 `Cmd+R`。运行时是从仓库 `static/` 直接读盘的，不需要重启。
- **B. 挂 Vite dev server（HMR 亚秒级，已被桌面壳验证过）**
  dev server 已在 `:5174`；桌面壳可指过去：
  ```bash
  cd desktop && XPOD_DESKTOP_USER_DATA_DIR="$PWD/../.test-data/desktop-dev-shell" \
    XPOD_ENV_FILE=../.env.local \
    XPOD_DESKTOP_URL=http://127.0.0.1:5174/ai-connections \
    ../node_modules/.bin/electron --no-sandbox dist/main.js
  ```
  （`:5174` 上已配好 `/service`、`/status` 代理到网关，所以桌面壳的就绪探测能过。）

**已实测被否掉的方案**：`vite build --watch` 增量 ≈32–35s/次，不满足「立刻看到」，别再用。

### 2.3 常用验证命令

```bash
# 类型
bun run build:ts                 # 根（服务端）
cd ui && bunx tsc -b             # 前端

# 测试
bash ./scripts/run-vitest-safe.sh --run tests/api/ai-gateway      # 服务端 AI 网关（31 文件/506 用例）
cd packages/ai-connections && bunx vitest run --config ../../vitest.packages.config.mts   # 共享包（362）
bunx vitest run ui/src/extensions/XpodAiConnectionsPodStore.test.ts
bun scripts/run-integration-lite-local.ts                          # 集成 lite（≈几分钟）

# 包产物
cd packages/ai-connections && bun run build
```

### 2.4 重启运行时的正确姿势

```bash
cd /Users/ganlu/develop/xpod && CSS_LOGGING_LEVEL=debug \
  XPOD_ENV_FILE="$HOME/Library/Application Support/Xpod/.env" \
  bun src/cli/index.ts start --port 3000
```
- 这条要**写 `~/Library/Application Support/Xpod`**（工作区之外）→ 在沙箱里会 `EPERM`，
  需要提权到 `danger-full-access`；或者干脆 `open -a Xpod` 让打包版拉起。
- 从沙箱里 `open -a Xpod` 会留下坏窗口，**你手动开是可靠的**。

### 2.5 账号与其它环境事实

- 测试账号（均实测 200）：`alice@dev.local/alice123456`、`test@dev.local/test123456`、
  `bob@dev.local/bob123456`；种子见 `config/seed.dev.json`。
- 桌面 dev 壳的用户数据目录：`.test-data/desktop-dev-shell`（隔离单实例锁，避免和打包版抢）。
- `timeout` 命令在 macOS 上不存在（原会话踩过），要限时用 `gtimeout` 或不用。
- 沙箱里 `ps aux` 被禁；查进程用 `lsof -nP -iTCP -sTCP:LISTEN`。

---

## 3. 本轮已提交的工作（26 个提交，按批次）

### 3.1 随报随修（③ 之前的 bug/体验）

| 提交 | 内容 |
|---|---|
| `85d9a75e` | Dashboard 登录闸口补「创建账号 · 忘记密码？」入口（gated 到非 embedded 面） |
| `987fcb5a` | AI 网关成功推理日志（protocol/model/stream/outcome/durationMs/events/finishReason/usage；**绝不记 prompt 与凭据**） |
| `84b36963` | CLI 进程初始化 logger——之前 CLI 没有 logger，把心跳日志吞了 |
| `13eaff45` | 智谱/百炼官方 logo（base64 PNG，替换错图） |
| `b5c01976` | offering 名称收敛到唯一英文目录（删掉第二份中文 id→标题映射） |
| `73ed5954` | device-code 回退标签 `浏览器登录` → `设备码登录` |
| `7d033e75` | 桌面壳运行时可达性探测（`waitUntilReachable`/`isReachable`）——**修的是 HEAD 编译不过**（`74e4f499` 漏带了 `runtime-manager.ts`） |
| `74e4f499` | （**你的提交**）Local 节点流量走 loopback + 桌面窗口失败自愈 |

### 3.2 ① 单一 provider 目录源

| 提交 | 内容 |
|---|---|
| `92a8391a` | `packages/ai-connections/src/provider-catalog.ts` 成为唯一目录源（≈410 行）；UI 的 `XpodAiConnectionsPodStore.ts` 1451 → 1077 行；`packages/ai-connections/package.json` 加 `./provider-catalog` 导出 + `typesVersions`（根 tsconfig 是 `module: CommonJS`，classic 解析**不认 `exports` 子路径**） |
| `589bbde2` | 把互操作值补齐回共享副本（openai subscription 的 `authModes: ['oauth','local']` + Codex endpoint；kimi `supportsDeveloperMessages: false`；ollama `usagePolicyUrl`；custom 默认对齐服务端旧值） |
| `c1996d4b` | 断言上述对齐结果 |
| `8d8b9845` | 服务端 `ProviderRegistry.ts` 的 326 行字面量副本 → 投影（`PROVIDER_PRODUCT_LABELS` + `PROVIDER_UPSTREAM_OVERRIDES`（5 条）+ `offeringsForProduct`），−322 行 |
| `d25a69fc` | 新增 `tests/api/ai-gateway/ProviderCatalogWiring.test.ts`（5 条守卫：发布、override 挂载、endpoint→inference 能力派生、kimi 限制） |
| `c5892e49` | 内置 provider 不再落一行 provider 记录（删 `ensureProviderRow` 调用与定义） |

### 3.3 ② 拆凭证池组件

| 提交 | 内容 |
|---|---|
| `288820fe` | 纯逻辑抽出：`authorization-methods` / `credential-labels` / `offering-endpoints` / `offering-label` |
| `57c9c2b3` | 组件拆分：1193 行 → 377 行组合层 + 5 个单一职责组件（194/60/50/376/119） |

### 3.4 ③ 夹具工厂

| 提交 | 内容 |
|---|---|
| `6cd13363` | `test/fixtures.ts` 从真实目录派生 + 守卫测试 + 迁移 6 处「撒谎」的夹具 |

### 3.5 ④ 拆 client + 附带

| 提交 | 内容 |
|---|---|
| `05210d19` | `client/{types 336, normalize 955, request 389}` + 显式 barrel（公共面 35 个导出前后一致，内部 parser 不外泄） |
| `934a8c97` | `provider-catalog` 补 `require` 条件（服务端编译成 CJS，之前只有 `import` 条件 → Node 侧 `ERR_PACKAGE_PATH_NOT_EXPORTED`） |

### 3.6 文档与发布策略

| 提交 | 内容 |
|---|---|
| `bcd768fc` | 新增 `docs/catalog-ownership.md`：归属边界 |
| `59bd96d1` | `AGENTS.md` + 文档：models 只管 schema，目录跟能力模块 |
| `94b4fa77` | 区分「互操作契约字段」与「展示字段」 |
| `38578ed8` | 「只存用户录入的，内置项用规则推导」 |
| `396e1618` | 注释与文档冲突时以文档为准 + 流程护栏 |
| `67ad2a18` | 预发布不占 `latest` dist-tag |
| `3b485fd1` | `scripts/lib/npm-publish-tag.cjs`：**rc 拒绝发布到 npm**（`assertPublishable`） |

---

## 4. 已确立的口径与边界（你亲口定的，别推翻）

1. **归属三句**：**schema 进 `@undefineds.co/models`，内容进能力模块，行为留 applet。**
   - models 只管实体/属性定义，**不许出现 action / UI / 目录内容**。
   - 公共且大家都用的是 schema → models；UI 自己单独用的跟着自己的 applet 走。
2. **只记 custom**：「我们只记录 custom 录入的 provider，我们再维护的供应商用规则就能写出来。」
3. **命名用英文**：offering 分类名（`Subscription` / `API Platform` / `Token Plan` / `Local`）保持英文，
   不做中文映射表。
4. **rc 策略**：rc 只为走 AI 验收（部署 digest），**不推 npm、不占 `latest`**；
   在不影响验收的前提下，对外界影响越小越好。镜像无所谓（那是使用者的主动行为）。
5. **两种登录要区分**：真正发起的「浏览器登录」≠「从已登录状态采集凭据」。
6. **不需要互操作/个性化价值的字段**不该塞进共享 schema，应留在 applet。
7. **文档写清楚**：边界必须在文档里讲明白，不能靠注释或口头约定。

---

## 5. 验证证据（跑过的 vs 没跑的，分开记）

**跑过并通过（原会话实测输出）**
- `packages/ai-connections`：**362 passed / 18 files**
- `tests/api/ai-gateway`：**506 passed / 31 files**
- 集成 lite：**149 passed / 6 skipped**（30 files，27 passed / 3 skipped）
- 根 `bun run build:ts` ✔、`ui` 的 `bunx tsc -b` ✔、`packages/ai-connections` 的 `bun run build` ✔
- **纯搬迁逐行核对**：② 的 5 个组件体、④ 的 3 个文件，与原文件逐行一致
  （④：原 1478 行全部找到，只多 1 行新注释）；公共面 ④ 前后都是 35 个导出，
  构建产物运行时只暴露原来那 9 个值
- 桌面白屏自愈：用 stub 做了 E2E（`chrome-error://chromewebdata/` → 自动 reload）

**没跑（诚实记录）**
- `bun run test:integration`（= lite + full）：**full 没跑**。`run-integration-full.ts`
  要 docker compose + postgres，占 5737/6300/6400——**5737 正被你在用的 :3000 运行时占着**，
  硬跑会撞。它覆盖集群/云路径，本轮只动前端包与服务端目录投影。
- `ensureProviderRow` 移除（`c5892e49`）**没有做真实 Pod 往返验证**。
- 原会话里 `packages/ai-connections/test/client-config-adapters.test.ts` 有一条
  「keeps Codex root and table scopes valid…」在**全并行跑时偶发失败**（单独跑 45/45 通过），
  与本次改动无关，但仍在。

---

## 6. 未完成 & 待你决定

1. **`openai/official-subscription` 的能力派生缺口**（原会话遗留、明确标为「待你决定」）
   —— **接手会话已查实，结论比原会话的判断更收敛**：

   **机制**：`ProviderRegistry.catalogOffering()` 第 362 行是
   `upstream: input.upstream ?? defaultUpstreamCapabilities(...)` ——
   **override 是整体替换，不是合并**。所以只要 `PROVIDER_UPSTREAM_OVERRIDES.openai['official-subscription']`
   给了两条，`endpoints: [{ protocol: 'responses', baseUrl: 'https://chatgpt.com/backend-api/codex' }]`
   就不会再派生出对应的 inference 能力。

   **是不是真缺口**：
   - **不是功能缺口**：订阅凭据的推理路由由运行时适配器**硬编码**实现——
     `ProviderRegistry.ts:15` 的 `OPENAI_SUBSCRIPTION_BASE_URL`，
     被 `OpenAiRuntimeAdapter.ts:35/54` 用于
     `safeBaseUrls` 与 `${OPENAI_SUBSCRIPTION_BASE_URL}/responses`（按 `subscription` 标志分支）。
   - **是声明不一致**：全仓库**没有任何消费者读 `capability === 'inference'`**。
     实测只有三处读 `upstream`：`ProviderModelsService.ts:258`（models）、
     `ProviderModelSelectionService.ts:390`（models）、`QuotaCapabilityRegistry.ts:25`（quota/balance）。
     也就是说 `inference` 条目目前是**惰性元数据**；而 `providerProductsForDeployment()`
     （`ProviderRegistry.ts:292`）会把整份 descriptor（含 `upstream`）发给客户端。
   - **守卫测试把这份不完整声明钉住了**：`ProviderCatalogWiring.test.ts` 的
     「keeps runtime capability overrides attached…」断言
     `protocols('openai','official-subscription') === ['codex-models','rolling-quota-windows']`，
     补 inference 条目必须同步改这条。

   **三个可选方案**（等用户拍）：
   - **A（最小、显式）**：给 override 补 `{ capability: 'inference', protocol: 'responses',
     options: { baseUrl: OPENAI_SUBSCRIPTION_BASE_URL } }`，同步改守卫测试。今天零行为影响，
     只让声明与 `endpoints` 一致。
   - **B（治本、动面大）**：把 override 语义从「整体替换」改成「**按 capability 逐项覆盖**」
     （override 命中某个 capability 时替换该项，其余保留派生结果）。注意不能按
     `capability:protocol` 合并——那会让 `codex-models` 与派生的 `openai-models` 并存。
   - **C（不动代码）**：在 `docs/catalog-ownership.md` 写明「override offering 的
     `endpoints` 与 `upstream` 是两套声明，前者是接入信息，后者是运行时能力覆盖」，
     把 `inference` 标为保留字段。
2. ~~**`CreateCredentialDialog` 没有拆出**（② 计划里有，原会话**故意没照做**）~~
   —— **接手会话已完成，提交 `134d0213`**：拆成 `useAiConnectDialog.ts`（状态机：开哪个表单、
   busy、dialog error，以及工具栏驱动的 5 个转换）+ `AiConnectDialog.tsx`（对话框本体：
   外壳 + offering 迭代 + 4 个分支），`AiCredentialPoolSection.tsx` 353 → 239 行。
   只搬 JSX 不搬状态就还是「25 个 props 换个地方堆」，所以状态一起搬走；
   DOM、可选回调的 guard、attempt 完成即关闭的行为**逐行搬移未改**（唯一刻意移动：
   标题三元表达式进了 hook）。验证：包测试 362（1 条已知偶发用例在并行下超时，
   单跑 45/45 通过）、受影响三文件 158 passed、`ui tsc -b` ✔、包 build ✔、
   Pod store 21/21。
3. **`test:integration:full`**：要么停掉 `:3000` 运行时再跑，要么接受不跑。
4. **`ensureProviderRow` 移除的真实 Pod 往返**：需要真实账号会话，按
   `docs/cli-dev-testing.md` 的「真实 Xpod 集成验收」证据链走（运行时 → 身份 → Pod 数据 →
   客户端认证 → `/v1/models` → `/v1/chat/completions`，四层分开报告）。
5. **npm 侧（你自己的运维动作，不是代码）**：
   `npm dist-tag add @undefineds.co/shared-ui@0.1.0 latest`、`extension-sdk` 同理；
   `ai-connections` 还没有 stable 版本；可选 `npm deprecate` 掉泄漏的 rc 版本。
6. 原会话主动上报的**流程失误**（供参考，别再犯）：信了代码注释而不是 `AGENTS.md`；
   把 diff 脚本报的「`[custom]` offering 集合不同」当噪声放过了（它掩盖了真实分歧）；
   在没看到 2 个 UI store 失败前就提交了目录改动（已在 `c1996d4b` 补回）。

---

## 7. 工作区状态（**别乱动**）

- 当前分支 `release/0.4.5`，HEAD = `934a8c97`。
- **未提交但不是我的**（原会话刻意不碰，接手会话同样不要碰）：
  - `ui/vite.config.ts` + `ui/vite.config.test.ts`：**你的重构**（引了 `productSurfaceRoots`）；
    里面现在混着原会话加的 `/service`、`/status` 代理（55–60 行）——那是桌面壳 attach 用的。
  - `static/**`：重建产物，内嵌了你未提交的 `ui/src/solid/*` 改动（已验证 `WebIdAuthBoundary`
    在服务的 bundle 里）。**改动是「删除+新增带 hash 文件名」**，所以 `git status` 里
    `D` 很多是正常的，不代表文件丢了。
  - `ui/src/solid/*`、`ui/src/auth/*`、`ui/src/context/*`、`desktop/src/main.ts`、
    `desktop/src/navigation-policy.ts`、`package.json`、`src/api/handlers/ProvisionHandler.ts`、
    `tests/e2e/*`、`docs/dev-repair.md`、`scripts/dev-repair.ts` 等一批未提交/未跟踪文件——
    都是你自己的在建工作。
- 提交纪律：**按文件显式批提交，禁止 `git add -A` / `git add .`**；提交前 `git diff --cached`。

---

## 8. 你的偏好（原会话总结 + 复核）

- 中文回复。
- 先查实再判断，**不要用解释掩盖异常**；发现异常先质疑数据再质疑结论。
- 动你的文件 / 动 npm registry 之前先问。
- 分批提交，每批自成主题。
- 汇报要「跑过的」和「没跑的」分开写，不许把没做验证的说成验证过。
- 真实 Xpod 验收不可用 Vitest / 临时端口 / mock 替代。

---

## 9. 恢复流程（接手会话 checklist）

1. `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|5174)\b'` → 回路是否还在（不在就按 §2.4 拉起）。
2. `curl -s http://127.0.0.1:3000/service/status` → css/api `running`。
3. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/alice/` → `200`。
4. `git log --oneline -3` → 应是 `134d0213`。
5. 从 §6 挑一条继续，或直接等用户报问题。

---

## 10. 接手会话的进展（本文件持续更新）

| 时间 | 事项 | 结果 |
|---|---|---|
| 2026-09-13 01:15 | 环境复核 | `:3000` 运行时（pid 48062，**仓库源码**运行时）+ `:5174` Vite dev server（pid 14783）都还活着；pods 200；节点 `7cca443f…` |
| 2026-09-13 01:20 | §6.1 openai 缺口 | **已查实**：不是功能缺口（路由硬编码在 `OpenAiRuntimeAdapter`），是**声明不一致**；`inference` 目前无消费者。三个方案待用户拍（见 §6.1） |
| 2026-09-13 01:22 | §6.2 拆 `CreateCredentialDialog` | **完成**，提交 `134d0213` |
| 2026-09-13 01:20 | 回归门禁 | 集成 lite：**27 passed / 3 skipped（30 文件）、149 passed / 6 skipped（155 用例）**，exit 0 |
| 2026-09-13 02:55 | 环境真相 | 当前 `:3000` 那套是**用户的 dev monitor**（`scripts/dev-repair.ts --desktop`，pid 1100）在 **01:59:58** 拉起的（网关 4454 + CSS 3001 + API 3002 + Vite 5173 + Electron 开发壳 4711）；端口冲突日志 `.test-data/login-redesign/dev-monitor-port-conflict.log`（01:18）显示 monitor 是先撞端口、后来才起来的。**`test:integration:full` 更不能随便跑**：它要 5737/6300/6400，且会踩在 monitor 的端口上 |
| 2026-09-13 02:58 | 清理 Dock 僵尸 | `~/.codex/skills/electron-debugger` 的截图工具（pid 2597 + Electron 2602）昨晚 22:04 起、只截了第一张就挂死 5 小时；`kill` 无效、`kill -9` 清掉。**该 skill 会挂**：截完不退，下次用之前先看 Dock 里有没有多出来的 Electron |
| 2026-09-13 10:45 | 产品默认落点改为 WebID 工作区 | 用户口径：「app 打开应该是 WebID 登录、落进 ai-connections，进 Xpod 相关 page 才是账号登录」。改了 6 处落点定义（`canonical-routes.ts` 的 `XPOD_DEFAULT_RETURN_PATH`、shell 的 index/`*`、`XpodShellApp` 兜底、`XpodUserCard` 切换账号、`desktop/src/target-url.ts`、`scripts/dev-repair.ts`）。**未改**：浏览器访问网关根 `/`（那是 `.account` 账号文档入口，服务端路由层面的事） |

### 事故记录：运行时被外部终止（2026-09-13 01:20）

- **现象**：原会话那套运行时（网关 48062 + CSS 48083 + API 48084）在 01:20:08 发出最后一次心跳后**三个进程全部消失**；`logs/xpod-2026-09-13.log` 里**没有崩溃/异常栈**，是被 SIGTERM 一类外部信号带走的。时间正好落在集成 lite 开始的那一分钟。
- **查证**：`run-integration-lite-local.ts` + `XpodTestStack` + `src/runtime/XpodRuntime.ts` 里**没有任何 kill 外部进程的逻辑**（全仓库 `process.kill` 只出现在 `xpod stop`、tunnel、qlever 自身子进程）；集成栈用的是随机端口（33775/33777），没有抢 `:3000`。**根因未定位**，怀疑与「老会话的后台 job 被回收」或集成跑动时的某个环节有关。
- **结论（操作纪律）**：**用户在用 `:3000` 时，跑集成测试前后都要确认运行时是否还活着**；不要在没告知的情况下让集成跑动影响到在用的实例。跑完 `curl -s http://127.0.0.1:3000/service/status` 复核一次。
- **恢复过程中的教训**：
  1. 沙箱内启动运行时是**假成功**——`/service/status` 会说 css running，但 CSS 实际没起来（`EPERM .../Application Support/Xpod/data/.xpod-cloud-registration.json`），Pod 全 502。判断健康要看**Pod 是否 200**，不能只看 status。
  2. 提权启动要**等审批**；审批期间别人可能已经把 `:3000` 占了，命令再执行就是 `EADDRINUSE` 退出——**先查端口再启动**。
