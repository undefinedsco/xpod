# AI 连接存储模型：确认口径与待改项

> 状态：**口径已确认（2026-09-14，用户拍板）；代码已按此实现（未提交、未发布）；存量数据迁移已在副本上演练（真实目录未动）**。
> 相关仓库：`@undefineds.co/models`（schema 权威）、Xpod（adapter）、存量 Pod 数据（迁移）。

## 1. 确认的模型（这是对的，不要改）

```
<Pod>/settings/
├── credentials.ttl          ← 凭据（udfs:Credential + encryptedSecret …）
└── providers/<provider>.ttl ← provider 身份 + 模型行 + hasModel
```

三条规则：

| 规则 | 含义 |
|---|---|
| **provider ↔ 凭据是边关系** | 凭据用 `udfs:provider` 指向 provider 资源；不靠路径或字符串表达归属 |
| **offering 是凭据的属性** | 订阅方式/接入方式写在**凭据自己**身上（属性），不编进 provider 文档名，也不当资源路径 |
| **模型跟着 provider 存** | 模型行与 `hasModel` 留在 `providers/<provider>.ttl`，这条现在的行为是对的 |

## 2. 现状与模型的偏差（已查实）

`ui/src/extensions/XpodAiConnectionsPodStore.ts` 的 `providerResourceIdForOffering()` 把 offering 编进了**文档名**：

```ts
aiProviderResource.buildId({ id: `${provider}-${canonicalOfferingId}.ttl#this` })
// → …/settings/providers/openai-official-subscription.ttl#this
```

真实 Pod（`…/data/glocal/settings/providers/`）里只有 `openai.ttl` 一个文件，但 `openai.ttl` 的 `hasModel` 同时指着两类文档：

```
…/providers/openai.ttl#gpt-5.5                     ← 存在
…/providers/openai.ttl#gpt-5.6-sol                  ← 存在
…/providers/openai-official-subscription.ttl#gpt-5.6-sol     ← 文件不存在（悬空）
…/providers/openai-official-subscription.ttl#gpt-6-astra     ← 悬空
…/providers/openai-official-subscription.ttl#gpt-5.6-terra   ← 悬空
```

三个后果：

1. **悬空文档引用** —— 界面上表现为标题是 URL、标着「已失效」的重复模型（已在读取层按 fragment 折叠，**数据层未清理**）；
2. **同一模型两条引用**（一条真实、一条幽灵），取消勾选时要靠折叠规则才不至于漏；
3. **offering 只能靠 `accountLabel` 字符串表达**（如 `"OpenAI Subscription d6649e3a-…"`），不是凭据属性 —— 与「offering 是凭据的属性」不符。

这与 `@undefineds.co/models` 自身指南冲突：*Do not use a literal as the authoritative persisted discriminator when RDF classes already express the distinction.*

## 3. 待改项（按顺序，先改写入端再清数据）

| # | 仓库/层 | 动作 |
|---|---|---|
| 1 | `@undefineds.co/models` | `credentialResource` 增加 **offering 属性**（列 + `UDFS` 谓词；值用目录里的 offering id，如 `official-subscription` / `api-platform`）。schema 归 models，Xpod 不另立副本；需发版 |
| 2 | Xpod adapter | `XpodAiConnectionsPodStore`：provider 资源 id 不再带 offering 段（统一 `providers/<provider>.ttl`）；写凭据时把 offering 写进**凭据属性**；读取端（网关 `ProviderRegistry`/`ModelRouter`、applet）改为从凭据属性取 offering，而不是从 provider 资源 id 反推 |
| 3 | Xpod 读取层兼容 | 已有折叠逻辑（`AiModelCatalog.modelCatalogId`）保留一轮，作为迁移期回退路径；迁移完成后按 AGENTS.md 删除兼容入口 |
| 4 | 数据迁移/清理 | 清理存量 Pod 里指向幽灵文档的 `hasModel` 引用（按 fragment 归一化到真实 provider 文档），并给存量凭据补 offering 属性（可从 `accountLabel` 前缀 + `authMode` 推导）。清理脚本放 `scripts/`，带 dry-run 与备份 |
| 5 | 验收 | 清理前后对比同一 Pod（模型条数、无 URL 标题条目、凭据 offering 属性齐全）；`bun run test:integration`；真实实例按 `docs/cli-dev-testing.md` 的证据链复验 |

## 4. 为什么先改写入端

只清数据不改写入端，下一次创建凭据/选择模型会立刻再生成同形状的悬空引用；而只改写入端不清数据，存量引用会一直躺在 Pod 里靠折叠逻辑兜着。两者都要做，顺序不能反。

## 5. 影响面

- **跨仓库**：models 需要一次 schema 变更与发版；Xpod 侧涉及 applet 适配器、网关读取器、迁移脚本。
- **存量数据**：所有已接入 provider 的 Pod 都可能带悬空 `hasModel` 引用；迁移需要可 dry-run、可回滚。
- **界面**：模型列表在迁移完成后不再依赖折叠规则；`已失效` 计数应下降为真实值。

## 6. 根因（谁引进的、为什么会发生）

**引进者**：`1dac88bd`（`🚀 Integrate the verified QLever stack for Xpod 0.4`，YersiniaHerb，2026-09-02）里的

```ts
function providerResourceIdForOffering(provider, offeringId): string {
  const canonicalOfferingId = canonicalOfferingIdFor(provider, offeringId) ?? offeringId
  return aiProviderResource.buildId({ id: `${provider}-${canonicalOfferingId}.ttl#this` })
}
```

**为什么会写错 —— 是 schema 缺口，不只是失手**：`credentialResource` 与 `aiProviderResource` 从未提供 offering 属性
（`git log -S "offering"` 在两张表上均为空），而 `aiProviderResource.id` 的规则只有一维
（`default("{key}.ttl")`）。产品上 openai 必须区分 `official-subscription`（OAuth/local）与
`api-platform`（API Key）：网关侧有这一维（product → offerings），applet 侧也有，**唯独 Pod schema 没有**。
写适配器的人手上唯一可用的判别位就是资源 id，于是分类维度被塞进了 id。
按本仓库「绕过前先报告」的规则，正确做法是先立 issue 说明缺口，而不是就地找地方塞。

**为什么长期没被发现**（三个哑掉的环节叠加）：

1. 没有任何校验要求「引用必须指向存在的文档」；
2. 网关读取器会**静默跳过**匹配不到的引用（`PodModelSelectionRepository.findSelectedModel`、
   `ProviderConnectService.findActiveModelRow`），所以 `/v1/models` 看起来干净；
3. 只有「页面直读 Pod」这条路径暴露它，且症状是「标题是 URL 的模型」——像 UI bug，不像数据 bug。

## 7. 防复发规则（硬规则）

> **资源 id 只表达存储布局，不表达分类维度。**
> 需要新的分类维度时，先在 `@undefineds.co/models` 补属性，再在 adapter 里写值；
> 任何「用文件名/路径段区分类型」的写法都视为建模缺口，先报再动。

配套闸门：

- offering 属性进 models 后，写入端不再有任何理由构造带分类段的 id；
- 加一条「引用必须指向存在的文档」的守卫扫描（迁移脚本可顺手覆盖，成本低）。

## 8. 实施记录（2026-09-14）

**models**：`credentialResource.offeringId` 定为 **plain string 列** + `UDFS.offeringId`（非 relation）——
Pod 里没有 offering 资源可 link，offering 属于 `@undefineds.co/ai-connections` 的目录内容；在 models 里枚举
offering id 等于把目录复制进 schema，目录扩张即需发版。`bun run build` ✅ · `bun run test:ci` ✅ 190 tests。
**未发布**；为在发版前可用，dist 变更暂以 `patches/@undefineds.co%2Fmodels@0.2.55.patch` 桥接（+96 行，含此前的 `disabledAt`）。
发版后必须删桥接 hunk 并升级依赖：root `0.2.55` → 新版、`ui/package.json` `0.2.53` → 新版。

**Xpod**：写入端删掉 `providerResourceIdForOffering()`，provider 资源 id 统一为 `providers/<provider>.ttl`（无 offering 段、无 `#this`）；
四条写路径都写 `offeringId` 属性；`modelSelectionResourceId()` 不再用 offering 造模型资源 id（悬空引用即由此而来）。
读取端收敛到 `credentialOfferingIdFromRow()`（属性 → metadata → 旧文档名 → 目录默认），网关侧 `recordFromCredentialRow()` 先读属性；
`legacyOfferingFromProviderRelation` / `offeringIdFromProviderReference` / `startsWith('<provider>-')` 均标注 **MIGRATION WINDOW**，发版+迁移完成后删除。
`AiModelCatalog.modelCatalogId`（fragment 折叠）按 §3#3 留作迁移期回退。

**迁移脚本** `scripts/migrate-ai-offering-storage.ts`（Bun，默认 dry-run，`--apply`/`--backup-dir`/`--verify`/`--pod`）：
折叠去重悬空引用、把 legacy offering 文档里的模型行搬进 provider 文档、回填凭据 offering、悬空 provider 关系归一。
推导多解或冲突时**跳过并打印原因，绝不猜**。真实 Pod 副本（`.test-data/ai-offering-migration/glocal`，真实目录未触碰）演练结果：

```
Credential offering backfill (1 derivable)   → offeringId=official-subscription
Reference guard scan  found now: 3 → after: 0
Model references (3 changed)                 → 幽灵引用判为与真实引用重复，删除
apply 后幂等（第二次 Nothing to write）；--verify 迁移前 exit 1、迁移后 exit 0
副本前后：引用 6→3、解析不到 3→0、distinct 模型 3→3、凭据 offeringId 0→1
```

**验证**：models build/test:ci ✅；`packages/ai-connections` 370 ✅；root `build:ts` ✅；`ui tsc -b` ✅；
`tests/api/ai-gateway` + `tests/ai` + handlers + `ui/src/extensions` = 737 ✅；`bun run test:integration` ✅ EXIT=0（lite 149 passed|6 skipped，full 45）。
新增焦点测试断言真实 `INSERT` 含 `udfs:offeringId`、provider 指向 `settings/providers/<provider>.ttl` 且不含 offering 段，且新数据的模型引用无需折叠。

## 9. 待决 / 待办

1. **models 发版**：补 `region` 后发新版（见 §9.3），然后删桥接 hunk、升级 root 与 `ui/package.json` 的依赖。
2. **相邻缺陷（严重，静默丢数据）**：`credentialResource` 在 0.2.55 **已无 `metadata` 列**（0.2.53 有），
   因此 applet/网关对凭据 `metadata.*` 的写入（priority/enabled/health/baseUrl/compatibility/accountId…）现在**被 drizzle-solid 静默丢弃**。
   建议：其余仍需要的字段升为显式列，或停止读取它们。
3. **跨仓库目录漂移**：models 工作区未提交的 `src/discovery/providers.json` 新增 moonshot/kimi offerings，
   但 kimi `subscription-key` 的 chatCompletions 端点缺 `region: "cn"`，而 Xpod 的 `provider-catalog.ts` 与
   `ProviderCatalogWiring.test.ts` 期望它有 → **models 一发版 Xpod 该用例即变红**。发版前先在 models 补齐 region 或对齐口径。
4. **产品口径**：修正后一个 provider 的所有 offering 共享同一模型池，`AiGatewayModel.offeringId` 只对迁移前行有意义。
   若产品仍要「不同 offering 不同模型清单」，需要显式建模（模型行自带 offering 属性，或凭据↔模型关系）—— 未自行发明。
5. 真实实例验收链未跑（需活 Gateway + 真实 provider 登录 + models 发版）。

## 10. 归属定案：discovery 是关键元数据（2026-09-14 用户拍板）

> **`@undefineds.co/models` 的 `src/discovery/providers.json` 是关键元数据（key metadata），跟着 models 发布。**

因此它**留在 models、随 models 包发布**，并且是这一层的权威来源。实测该快照含 14 个 provider 的：
`id` / `label` / `endpoints`（`protocol` + `baseUrl`，34 处 baseUrl）/ `region` / `authModes` / `modelDiscovery` /
`quota` / `offerings` / `runtimeProviderIds` / `consoleUrl`。

### 边界（据此收敛，取代「内容全进能力模块」的宽解释）

| 层 | 归属 | 内容 |
|---|---|---|
| **关键元数据** | **models（随包发布）** | provider/offering 标识、endpoint（protocol/baseUrl/**region**）、authModes、modelDiscovery / quota 策略、runtimeProviderIds |
| **展示与动作** | **能力模块 `@undefineds.co/ai-connections`** | 本地化展示名、console/申请入口、授权动作与按钮文案、视觉 mark、订阅说明 |

判据：**能被机械消费、影响行为的事实 → models；给人看或描述「怎么接入」的 → 能力模块。**

### 由此产生的收敛动作

1. `packages/ai-connections/src/provider-catalog.ts` **不得再存第二份元数据**（现状：baseUrl 24 处、region 21 处、
   consoleUrl 22 处、authModes 17 处与 models discovery 重复）→ 改为从 `@undefineds.co/models/discovery` 投影，
   只补展示/动作字段。这正是本文件 §3 给 offering 做过的同一道题，只是横向到了两个仓库。
2. **kimi `region: "cn"` 的缺失按 models 为准修数据**（models 侧补），不在 Xpod 侧改期望值；
   `ProviderCatalogWiring.test.ts` 保留为「投影一致性」守卫（它抓到的正是两份元数据漂移）。
3. 若要保留任何过渡副本，必须显式标注 MIGRATION WINDOW 并把切换点收敛到一个入口（AGENTS.md 已有此要求）。
4. 待确认的唯一歧义：`label` 与 `consoleUrl` 同时出现在 discovery 与能力模块中 —— 按上表判据应留在**能力模块**
   （给人看/点击），models 里的同名条目只作为机械消费的回退。

## 11. 订阅刷新取代数据清理（2026-09-14 裁决）

用户裁决：**表级 subscribe 优先，历史脏数据不做清理**（换账号即换 Pod，天然是干净文档）；
迁移脚本保留为工具，不对运行中的实例执行。理由与边界：

- **订阅由 store 的 activity 触发**：`config/main.json` 引入 CSS 通知子系统，`ListeningActivityHandler` 监听
  `urn:solid-server:default:ResourceStore`，而该 id 是最外层的 `MonitoringStore`
  （`css:config/storage/middleware/base/base.json`）。Xpod 的等位替换只换 `ResourceStore_Backend` /
  `ResourceStore_Converting`，因此**任何经过 store 的写入都会产生通知**，与写入方是谁无关。
- **反向结论**：绕开服务改 `.ttl` 文件既不进 quadstore 索引，也不产生 activity —— 既看不到变化，也不通知任何人；
  离线文件模式只适用于离线副本。
- **"谁更新界面都刷新"的成立条件**：更新必须走 store；订阅把这一条从「每次进页面重读」升级为「变化即读」。
- 根因（offering 编进文档名）已在代码侧修掉：provider 文档 id 只由 provider 决定，
  新写入不会再产生 `providers/<provider>-<offering>.ttl` 这类幻影引用。
- 排期：表级 subscribe（§12）先落地，再由它作为迁移的可见性验收手段。
