# 包边界：开源共享面 vs applet 特有

本文回答一个问题：**哪些包（或包内的哪些模块）属于可开源共享的平台面，哪些是 Xpod 这个 applet 特有的？**判定规则来自 [`catalog-ownership.md`](catalog-ownership.md)（`schema 进 models，内容进能力模块，行为留 applet`）与 `AGENTS.md` 的扩展抽象原则；本文把它落到**包级**，并给出可执行的守卫。

## 判据（四问）

一个包（或模块）可以进共享面，当且仅当它只含 ① 互操作契约 ② 通用机制，且**代码面不含**：

| 不该出现在共享面的东西 | 理由 |
|---|---|
| 第三方品牌资产（logo/商标） | 合规敏感，不能随"平台包"默认进入每个消费方的产物 |
| 面向用户的产品文案 | 展示/个性化归 applet（`catalog-ownership.md` §共享面只放互操作契约） |
| 页面组件与状态机 | 行为留 applet（`AGENTS.md`） |
| 某个 applet 的动作语义 | 同上 |

## 逐包裁定（实测）

依赖分层本身是干净的 DAG：`models → pod-collections → extension-sdk → ai-connections`，`solid-sdk` / `shared-ui` 旁挂。

| 包 | 代码面产品文案 | 内嵌品牌图 | 守卫测试 | 裁定 |
|---|---|---|---|---|
| `@undefineds.co/pod-collections` | 0 | 0 | 有（`test/guards.test.ts`，禁止表清单/字段映射/布局常量） | ✅ **共享面（模范）** |
| `@undefineds.co/solid-sdk` | 0 | 0 | 无 | ✅ 共享面 |
| `@undefineds.co/extension-sdk` | 14（2 个字面量：面板展开/折叠的 aria-label） | 0 | 无 | ✅ 共享面（宿主/applet 契约） |
| `@undefineds.co/shared-ui` | **1593**（122 个字面量） | 0 | 无 | ⚠️ **定位待澄清**：名为 UI 原语，却承载中文产品文案；若要作为开源工具箱，文案应外置或由消费方注入 |
| `@undefineds.co/ai-connections` | **2385**（285 个字面量；其中 `Ai*.tsx` 1602） | **10 张商标**（`data:image`，78 KB） | 有（本文的 `test/package-boundary.test.ts`） | ⚠️ **一包两面**：契约面与 applet 面已按入口分开并被守卫，但 applet 代码（约 69%）仍与共享契约同包发布 |

口径：上表"产品文案"指**代码面字符串字面量中的中文字符数**，范围 `packages/<pkg>/src` 下非测试的 `.ts`/`.tsx`，先剥离注释再匹配引号字面量（macOS 自带 `grep` 不支持 CJK 范围，会静默给出 0，必须用支持 Unicode 的工具）：

```bash
python3 - <<'PY'
import re, pathlib
HAN = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')
STR = re.compile(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`", re.S)
for name in ['shared-ui', 'solid-sdk', 'extension-sdk', 'pod-collections', 'ai-connections']:
    chars, lits = 0, set()
    for p in pathlib.Path(f'packages/{name}/src').rglob('*'):
        if p.suffix not in ('.ts', '.tsx') or '.test.' in p.name: continue
        s = re.sub(r'/\*.*?\*/', '', p.read_text(encoding='utf-8'), flags=re.S)
        s = re.sub(r'(?m)^\s*//.*$', '', s)
        for m in STR.finditer(s):
            h = HAN.findall(m.group(0))
            if h: chars += len(h); lits.add(m.group(0))
    print(f'{name}: {chars} chars / {len(lits)} unique')
PY
```

## `ai-connections` 的两面（当前落地方式）

同一个包通过**入口**区分两个受众，而不是拆成两个包——避免新包带来的发布登记成本，同时让边界立刻可执行。实测（含 `src/ai-connections-client.ts`、`provider-catalog.ts`、`manifest.ts`、`client-config/index.ts` 的传递导入闭包）：**契约面 15 个文件 / 3976 行 = 31.2%**，其余约 69%（`src` 共 12760 行）是 applet 面。

| 入口 | 消费方 | 内容 | 允许 |
|---|---|---|---|
| `/client`、`/provider-catalog`、`/client-config`、`/manifest` | **服务端**（`src/api/ai-gateway/**`、`src/api/handlers/**`）+ UI | 互操作契约、catalog 的互操作字段、集合适配、存储形状 | 只允许纯 TypeScript：无 React、无组件、无品牌资产、无产品文案 |
| 根入口 `.` | **只有 UI**（applet） | applet 定义、controller、26 个 `Ai*.tsx` 组件、展示投影、`provider-visuals.ts` 品牌图标 | 不受上述限制 |

守卫 `packages/ai-connections/test/package-boundary.test.ts` 从四个契约入口做**传递闭包**遍历并断言：无 `react` 导入、无 `.tsx`、不导入 `Ai*` 组件、无 `data:image`、无**新增**中文文案；同时断言四个契约子路径仍在 `exports` 里。新加到契约面的模块自动纳入管辖，不需要改清单。

## 已知欠债（棘轮冻结，允许收敛、禁止增长）

契约面里仍有 8 处（6 个不同字面量）中文产品文案，全部在 `provider-catalog.ts`：

```
'添加 API Key' · '浏览器登录' · '设备码登录' · '已有登录态'   ← 授权方式标签
'智谱 AI' · '百炼'                                          ← provider 展示名
```

按归属文档它们属于 applet。守卫把这些**冻结成一份清单**：新增第 7 个字面量会失败；把它们迁出（改成 applet 侧的 `id → label` 展示映射）是收敛这一步的既定做法。

## 待办（按价值排序）

1. **把展示字段迁出契约面**：`provider-catalog.ts` 的授权方式标签与 provider 展示名改为 applet 侧映射；`label` / `productLabel` / `consoleUrl` / `subscriptionUrl` / `usagePolicyUrl` / provider 级 `region` 同属此类（`catalog-ownership.md` 已逐字段判定）。收敛后把棘轮清单清空。
2. **把 applet 代码移出已发布包**（可选）：26 个组件 + `controller.tsx` + `collections.ts`（React hook）+ `provider-visuals.ts` 移到 `ui/src/` 或独立 applet 包。当前靠入口与守卫隔离，物理移动的收益是缩小已发布产物的体积与商标暴露面，代价是要在发布登记处登记新包。
3. **`shared-ui` 的定位**：明确它是"开源 UI 工具箱"还是"Xpod 产品 UI 层"。若是前者，1593 个字符的产品文案应改为消费方注入或 i18n 资源；`extension-sdk` 的 2 个 aria-label 属同类（量级可接受，但口径应一致）。
