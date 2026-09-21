# 包边界：共享核 vs 产品（applet）

本文回答一个问题：**哪些包是可直接复用的共享核，哪些是 Xpod/LinX 这个产品自己的？**判据来自 [`catalog-ownership.md`](catalog-ownership.md)（`schema 进 models，内容进能力模块，行为留 applet`）与 `AGENTS.md` 的扩展抽象原则，本文把它落到**包级**并给出可执行守卫。

## 结论（一句话）

**`@undefineds.co/ai-connections` 是一个包、两层。**它整体是 ai-connections 这个能力自己的模块（applet + 它自己的互操作契约），契约层放在 `src/contract`，通过子路径导出给服务端与脚本。

```
models → pod-collections → extension-sdk → ai-connections
                                     solid-sdk / shared-ui 旁挂
```

曾经把它拆成 `@undefineds.co/ai-connections-core` + `@undefineds.co/ai-connections` 两个包，**已合回一个**：那份契约除了 ai-connections 自己（applet 与其服务端消费方）没有外部消费者，按 `AGENTS.md` 的口径它属于"内容进能力模块"，不该再占一个已发布包；两包并存还会让同一份互操作面被两个包各自发布。

| 包 | 角色 | 判定依据 |
|---|---|---|
| `@undefineds.co/ai-connections` | **能力模块**：`src/contract`（客户端协议、provider 目录、client-config 适配器、端点规则、凭据存储形状）+ applet（定义、controller、`Ai*.tsx`、品牌图标、展示措辞） | 服务端只读子路径（`./client`、`./provider-catalog`、`./client-config`、`./endpoint-urls`），UI 走 `.`/`./manifest`；契约层纯 TypeScript，无 React/组件/商标/UI 文案 |
| `@undefineds.co/pod-collections` | 共享核（机制） | 0 文案 0 商标，已有 `test/guards.test.ts` |
| `@undefineds.co/solid-sdk` | 共享核 | 0 文案 0 商标 |
| `@undefineds.co/extension-sdk` | 共享核（宿主/applet 契约） | 2 个字面量：面板展开/折叠的 aria-label |
| `@undefineds.co/shared-ui` | ⚠️ **定位未澄清（见下）** | 既含原语，也含产品登录面与错误文案 |

## 判据

一个模块可以进共享核，当且仅当它只含 ① 互操作契约 ② 通用机制，且**代码面不含**：

| 不该出现在共享核的东西 | 理由 |
|---|---|
| 第三方品牌资产（logo/商标） | 合规敏感，不能随共享包默认进入每个消费方的产物 |
| 面向用户的措辞 | 措辞由渲染它的产品决定（`catalog-ownership.md` §共享面只放互操作契约） |
| 页面组件与状态机 | 行为留 applet（`AGENTS.md`） |
| 反向依赖产品 | 核被产品依赖；反向依赖会把产品变成契约的一部分 |

## 守卫（可执行）

`packages/ai-connections/test/contract-boundary.test.ts` 把上述判据变成 7 条断言，**扫描契约层目录全体**（不靠闭包推导，避免"推导对了但漏了文件"）：

1. 目录里确实有东西（防止 walking 失效后其余断言空过）；
2. 无 `react`/`react-dom` 导入、无 `.tsx`、不导入 `Ai*` 组件，且相对导入**不得离开 `src/contract`**（回到 applet 层就等于把 applet 变成契约的一部分）；
3. 无 `data:image`；
4. 中文字面量只允许冻结清单（见下）；
5. 一个包的 `exports` 必须同时含契约子路径（`./client`、`./provider-catalog`、`./client-config`、`./endpoint-urls`）与 applet 入口（`.`、`./manifest`），互操作面只发布一次；
6. 措辞表（`display-wording.ts`）必须留在 applet 层（并含预期文案），把"文案归产品"写成可失败的断言；
7. applet 层专有的文件（`*.tsx`、`provider-visuals.ts`）不得出现在 `src/contract` 目录里。

> 守卫曾经只遍历 `import`，而产品 `/client` barrel 是通过 `export … from` 取到 `client/normalize.ts` 的——**17 条用户可见错误文案因此对守卫不可见**。现已遍历 `export … from`；新守卫直接扫目录，此类"再导出藏文件"不再可能。

## 实测（`packages/<pkg>/src`，非测试的 `.ts`/`.tsx`）

| 包 | 行数 | 中文字面量（字符 / 唯一） | 内嵌品牌图 |
|---|---|---|---|
| `pod-collections` | 2001 | 0 / 0 | 0 |
| `solid-sdk` | 1776 | 0 / 0 | 0 |
| `extension-sdk` | 2179 | 14 / 2 | 0 |
| `shared-ui` | 3897 | 1593 / 122 | 0 |
| `ai-connections` 契约层（`src/contract`） | 3935 | **477 / 18** | **0** |
| `ai-connections` applet 层（`src` 其余） | 8890 | 1896 / 269 | 12 |

契约层占两层合计约 30.7%；契约层内中文只剩下面冻结的 18 条，品牌图 12 张全在 applet 层。

口径：**代码面字符串字面量中的中文字符数**，先剥离注释再匹配引号字面量。macOS 自带 `grep` 不支持 CJK 范围且会**静默返回 0**，必须用支持 Unicode 的工具（脚本见 [提交说明](#)）。

## 冻结清单（棘轮：只许收敛，不许增长）

契约层内 18 条中文，分两类：

**只剩 1 条**：`provider-catalog.ts` 的 `productLabel: '智谱 AI'`（两个 offering 同一字面量）。这是**目录内容**——它命名厂商，不随屏幕改写，而 catalog 正是本包命名事物的场所。新增即失败，只许减少。

原先那 17 条错误文案**已全部搬出**（见下）。

## `shared-ui` 的定位（已裁定）

**裁定：登录算公共组件；但产品名必须是可变的。**

`shared-ui` 里的 `login/*`（含 `LoginModal`）不是"错位的产品界面"，它本来就是被复用的共享登录面——本仓库里没有任何地方渲染它，消费方是外部宿主（LinX 桌面端等），所以它**更不能假定自己属于哪个产品**。

| 文件 | 条数 | 性质 | 处理 |
|---|---|---|---|
| `user-facing-errors.ts` | 58 | 错误文案；其中 **12 处写死了 "LinX"** | ✅ 参数化：`formatErrorForUser(error, fallback, { productName })`，缺省为中性名 `应用`（`DEFAULT_PRODUCT_NAME`） |
| `login/presentation.ts` | 46 | 登录展示措辞（"本地空间"、"独立空间"） | 共享登录面本身，保留 |
| `login/LoginModal.tsx` | 44 | 共享登录弹窗 | ✅ 新增 `productName?` 宿主 prop，经 `LoginProductNameProvider` 注入文案（`brand` 早已是宿主注入） |
| `login/LocalReachabilitySummary.tsx`、`toast.tsx` | 6 | 同上 | 保留 |

配套：
- 定位注释同步修正（`index.ts`、`LoginModal.tsx`、`LoginView.tsx`、`host-types.ts`、`solid-sdk/src/login-store.ts` 原写 "LinX product login surface / LinX-only"，改为共享登录面 + 宿主注入）；
- **CI 断言**：`packages/shared-ui/test/login-modal.test.tsx` 新增用例——不传 `productName` 时用中性默认名，并断言**不出现 "LinX"**；传 `productName: '示例空间'` 时文案随之改变。

外部宿主显示自己的产品名只需传 `productName`；不传则得到中性文案，不会替别的产品说话。

## 错误措辞的边界（已落地）

客户端曾经把失败**格式化成句子**（9 条中文 + 若干英文兜底），于是共享包里带着"谁渲染它"才知道该怎么说的话。现在分两层：

| 层 | 负责 | 产物 |
|---|---|---|
| 契约层 | 归类失败并交回事实 | `AiConnectionsRequestError` 携带 `code` / `status` / `providerStatus` / `provider` / `authMode` / `payload`；`message` 只是诊断串（形如 `AI Connection request failed: <code>`） |
| 产品（applet） | 决定句子 | `error-wording.ts`：`aiConnectionsErrorMessage(error)`（错误对象 → 句子）、`aiConnectionsErrorMessageForPayload(payload, status, context)`（报文 → 句子）、`withDisplayableErrors(client)`（宿主在客户端边界包一层，使抛出的错误仍可直接展示） |

**宿主/消费方需要知道的一件事**：从契约层拿到的错误只说代码。要显示给用户，用 `withDisplayableErrors()` 包住 client（本仓库的 `ui/src/api/ai-connections.ts` 就是这么做的），或用 `aiConnectionsErrorMessage()` 在展示处转换。规则、净化（防内部信息泄漏）与文案本身一并搬走，因此**用户看到的句子没有变化**。

## 已修正的归属裁定：内置项 vs UGC

`catalog-ownership.md` 曾把 `consoleUrl`/`subscriptionUrl`/`usagePolicyUrl`/`quota.url` 一律划给 applet，依据是"服务端只是把它们拷进 API 响应，没有功能判断"。**该依据不准确**：`src/api/ai-gateway/providers/ProviderRegistry.ts` 用 `consoleUrl` 做功能判断（缺失即抛错，并推导 `quota.url` 默认值）。

按"公开的第三方不用存、UGC 的需要存"修正为：

| 类别 | 展示元数据来源 | 是否需要存 | 服务端能否依赖 |
|---|---|---|---|
| **内置第三方 provider** | 规则（catalog） | 不存（Pod 里不落展示行） | 可以推导，不依赖透传 |
| **UGC（用户自建 custom provider）** | 用户录入的数据 | **必须存**（Pod） | 必须读，`consoleUrl` 推导 `quota.url` 是正当的 |

即：服务端依赖 UGC 的 `consoleUrl` 是**对的**，不能按旧依据删掉；旧依据只对内置项成立。细则见 [`catalog-ownership.md`](catalog-ownership.md)。

## 待办（按价值排序）

1. ~~**错误文案归产品**~~ ✅ 已完成：契约层的 `AiConnectionsRequestError` 现在只带事实（`code` / `status` / `providerStatus` / `provider` / `authMode` / `payload`），句子由产品 `error-wording.ts` 决定；宿主在客户端边界用 `withDisplayableErrors()` 让抛出的错误依旧可直接展示。
2. **`shared-ui` 登录面的产品名收尾**：`ui/src/pages/admin/SettingsPage.tsx` 仍有 1 处写死 "LinX" 的运行期文案；`localizeProductTerms` 的其余替换项（"云端/本地空间"等）按需同样参数化。
3. **目录展示字段（`consoleUrl`/`productLabel`/`region`）按内置/UGC 分治**：内置项的展示元数据由产品规则推导，UGC 的继续存 Pod；逐字段核对 `catalog-ownership.md` 的旧裁定。
