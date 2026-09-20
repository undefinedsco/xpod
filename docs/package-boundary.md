# 包边界：共享核 vs 产品（applet）

本文回答一个问题：**哪些包是可直接复用的共享核，哪些是 Xpod/LinX 这个产品自己的？**判据来自 [`catalog-ownership.md`](catalog-ownership.md)（`schema 进 models，内容进能力模块，行为留 applet`）与 `AGENTS.md` 的扩展抽象原则，本文把它落到**包级**并给出可执行守卫。

## 结论（一句话）

**`@undefineds.co/ai-connections` 是独立产品，不是共享包。**服务端要用的互操作部分已经抽成 **`@undefineds.co/ai-connections-core`**；产品保留组件、控制器、品牌图与文案，并从核导入契约。

```
models → pod-collections → extension-sdk → ai-connections-core → ai-connections（产品）
                                     solid-sdk / shared-ui 旁挂
```

| 包 | 角色 | 判定依据 |
|---|---|---|
| `@undefineds.co/ai-connections-core` | **共享核**：客户端协议、provider 目录、client-config 适配器、端点规则、凭据存储形状 | 服务端与产品都消费；纯 TypeScript，无 React/组件/商标/UI 文案 |
| `@undefineds.co/ai-connections` | **产品**：applet 定义、controller、26 个 `Ai*.tsx`、品牌图标、展示措辞 | 只有 UI 消费；`exports` 只留 `.` 与 `./manifest` |
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

`packages/ai-connections-core/test/package-boundary.test.ts` 把上述判据变成 7 条断言，**扫描核目录全体**（不靠闭包推导，避免"推导对了但漏了文件"）：

1. 目录里确实有东西（防止 walking 失效后其余断言空过）；
2. 无 `react`/`react-dom` 导入、无 `.tsx`、不导入 `Ai*` 组件、**不导入 `@undefineds.co/ai-connections`**；
3. 无 `data:image`；
4. 中文字面量只允许冻结清单（见下）；
5. 核的 `exports` 必须含 `./client`、`./provider-catalog`、`./client-config`、`./endpoint-urls`；
6. 产品的 `exports` **只允许** `.` 与 `./manifest`，且必须依赖核——互操作面不能被两个包同时发布；
7. 措辞表（`display-wording.ts`）必须存在于产品侧（并含预期文案），把"文案归产品"写成可失败的断言。

> 守卫曾经只遍历 `import`，而产品 `/client` barrel 是通过 `export … from` 取到 `client/normalize.ts` 的——**17 条用户可见错误文案因此对守卫不可见**。现已遍历 `export … from`；新守卫直接扫目录，此类"再导出藏文件"不再可能。

## 实测（`packages/<pkg>/src`，非测试的 `.ts`/`.tsx`）

| 包 | 行数 | 中文字面量（字符 / 唯一） | 内嵌品牌图 |
|---|---|---|---|
| `pod-collections` | 2001 | 0 / 0 | 0 |
| `solid-sdk` | 1776 | 0 / 0 | 0 |
| `extension-sdk` | 2179 | 14 / 2 | 0 |
| `shared-ui` | 3897 | 1593 / 122 | 0 |
| **`ai-connections-core`** | 3935 | **477 / 18** | **0** |
| `ai-connections`（产品） | 8890 | 1896 / 269 | 12 |

核占两者合计约 30.7%；搬迁后核内中文只剩下面冻结的 18 条，品牌图 12 张全在产品侧。

口径：**代码面字符串字面量中的中文字符数**，先剥离注释再匹配引号字面量。macOS 自带 `grep` 不支持 CJK 范围且会**静默返回 0**，必须用支持 Unicode 的工具（脚本见 [提交说明](#)）。

## 冻结清单（棘轮：只许收敛，不许增长）

核内 18 条中文，分两类：

- **1 条产品名**：`provider-catalog.ts` 的 `productLabel: '智谱 AI'`（两个 offering 同一字面量）。这是**目录内容**——它命名厂商，不随屏幕改写，而 catalog 正是本包命名事物的场所。
- **17 条错误文案**：`client/normalize.ts` 把失败码格式化成给用户看的句子。这是**下一刀**，不是可接受状态：客户端应当抛**带类型的失败**，由产品措辞。迁移前冻结，新增即失败。

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

## 已修正的归属裁定：内置项 vs UGC

`catalog-ownership.md` 曾把 `consoleUrl`/`subscriptionUrl`/`usagePolicyUrl`/`quota.url` 一律划给 applet，依据是"服务端只是把它们拷进 API 响应，没有功能判断"。**该依据不准确**：`src/api/ai-gateway/providers/ProviderRegistry.ts` 用 `consoleUrl` 做功能判断（缺失即抛错，并推导 `quota.url` 默认值）。

按"公开的第三方不用存、UGC 的需要存"修正为：

| 类别 | 展示元数据来源 | 是否需要存 | 服务端能否依赖 |
|---|---|---|---|
| **内置第三方 provider** | 规则（catalog） | 不存（Pod 里不落展示行） | 可以推导，不依赖透传 |
| **UGC（用户自建 custom provider）** | 用户录入的数据 | **必须存**（Pod） | 必须读，`consoleUrl` 推导 `quota.url` 是正当的 |

即：服务端依赖 UGC 的 `consoleUrl` 是**对的**，不能按旧依据删掉；旧依据只对内置项成立。细则见 [`catalog-ownership.md`](catalog-ownership.md)。

## 待办（按价值排序）

1. **错误文案归产品**：客户端抛带类型的失败（如错误码）而非成品句子，产品侧渲染；清空冻结清单里的 17 条。
2. **`shared-ui` 登录面的产品名收尾**：`ui/src/pages/admin/SettingsPage.tsx` 仍有 1 处写死 "LinX" 的运行期文案；`localizeProductTerms` 的其余替换项（"云端/本地空间"等）按需同样参数化。
3. **目录展示字段（`consoleUrl`/`productLabel`/`region`）按内置/UGC 分治**：内置项的展示元数据由产品规则推导，UGC 的继续存 Pod；逐字段核对 `catalog-ownership.md` 的旧裁定。
