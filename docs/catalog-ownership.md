# Catalog 与共享定义归属边界

本文回答一个反复出现的问题：**某个 provider / offering / 类型 / 常量，应该放进 `@undefineds.co/models`，还是留在使用它的 applet（或本仓库的共享包）里？**

## 两条判定规则

1. **按消费者判定**：公共的、大家都用得多的 → `@undefineds.co/models`；只有 UI 自己单独用的 → 跟着它所在的 applet 走。
2. **按性质判定**：**数据**进 models；**非数据**不进 models。

两条规则同时成立才进 models：**既是数据，又被多方共用**。

| | 是数据 | 不是数据 |
|---|---|---|
| **多方共用** | ✅ 进 `@undefineds.co/models` | ❌ 留在本仓库的共享包（如 `@undefineds.co/ai-connections`） |
| **单个 applet 自用** | ❌ 跟该 applet 走 | ❌ 跟该 applet 走 |

## 判定流程

1. 它是**数据**（catalog 条目、schema 字段、URI 词表、枚举取值、日期分桶规则…），还是**行为**（组件、hook、格式化、状态机、客户端逻辑）？非数据一律不进 models。
2. 数据的话，**谁消费**？只有一个 applet → 跟 applet 走。多个消费方（UI + 服务端 + CLI + 外部集成）→ 进 models。
3. 进 models 后，本仓库**只实现 adapter**，不再维护第二份副本。

## 当前归位

### Provider / offering catalog（目标：models）

provider 与 offering 的目录是**数据**，且被 UI、服务端（AI gateway / management API）双方消费，按规则应归 `@undefineds.co/models`。

现状与迁移路径：

| 阶段 | 状态 |
|---|---|
| 目标 | `@undefineds.co/models` 暴露 offerings，UI 与服务端都消费它 |
| **当前** | models 尚未暴露 offerings（`0.2.53` 里只有 `discovery/models.json`，那是**模型**目录，不是 provider/offering 目录）→ 本仓库保留**一份**回退副本 |
| 回退副本位置 | `@undefineds.co/ai-connections/provider-catalog`（单一副本，UI 先消费；服务端改为消费同一入口，删除 `ProviderRegistry` 里的 `LEGACY_PROVIDER_PRODUCT_DESCRIPTORS` 字面量，仅保留 capability 覆盖） |
| 切换点 | 回退入口内部**优先采用 models 暴露的 offerings**，缺失时才回落到副本 |
| models 就绪后 | 删掉回退副本，只留入口的转发 |

服务端 `ProviderRegistry` 的既有注释已经写明这个方向（"The shared models package owns the provider/offering catalog. Keep the legacy descriptors above only as a compatibility fallback…"）；本文把它固化为可执行的边界，避免回退副本被当成事实权威。

### 不归 models 的东西（留在本仓库）

- **展示逻辑**：offering 标题的展示策略、`offeringTitle` 之类的投影函数 —— 非数据。
- **UI 视图模型**：`AiProviderOffering` 在 UI 侧的字段裁剪、`productLabel` 的排版用法 —— 单个 applet 自用。
- **组件与交互**：provider 卡片、凭据列表、授权对话框、额度卡 —— 非数据。
- **运行时能力描述**：`upstream` / `auth` capability 覆盖（`codex-models`、`rolling-quota-windows` 等）—— 与后端运行时绑定，不是共享数据；即使 provider catalog 进 models，这一层也留在服务端。

## 相关约定

- 建模规则（Pod/RDF schema、URI 字段、日期分桶、exact id 操作）以 `@undefineds.co/models` 为权威，Xpod 只实现 adapter —— 见 `AGENTS.md`。
- 共享包通过 `workspace:*` 在仓库内解析；对外发布由 `scripts/publish-package.cjs` 单包发布，并把 `workspace:*` 改写成发布时的版本号。发布顺序：被依赖的包先发。
