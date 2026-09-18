# 登录发布 0.4.8：身份原文与安装依赖契约

0.4.7 的登录/RDF 修复与 RC 已通过，但稳定包的 Node 注册表安装失败，因此未推广为 `latest`。0.4.8 保留完整 WebID 原文作为身份的契约，修复打包声明和发布前验证；不覆盖既有标签或注册表版本。

## 缺陷与修复

根 tarball 含有当前 `ai-connections` 的 CJS/ESM 导出，但打包器只为 `patchedRuntime` 登记 `dependencies` 与 `bundledDependencies`，漏掉其他实际复制进包的模块。真实 Node 注册表安装在保留 optional dependencies 时下载旧版 `ai-connections`，使 `provider-catalog` 导出消失。

所有 16 个复制包都记录 bundled 声明；仅原有 patched runtime 保留精确 registry 依赖边，避免 Bun 从公网解析仅随包内置的私有模块。不增设另一套导出、不增加依赖、不使用 Bun 回退隐藏 Node 错误。

## 身份边界复查

0.4.7 的原文身份约束仍有实现遗漏：首次 Pod 授权绑定处理，以及 Solid SDK 的 storage selection 和 Pod runtime 缓存，存在 `URL.href` 归一化。不同原文的 WebID 因而可能被选为同一绑定或复用同一个运行时。0.4.8 已补齐这些入口的回归与修复，身份比较、缓存、清理键全部保留原始字符串；存储地址的规范化继续单独处理。`clear('')` 拒绝非法身份，只有无参数的 `clear()` 才清空全部。

## 发布前门禁

- 使用最终 tarball 建立 loopback registry，保留 optional dependencies，调用既有隔离消费者安装及运行检查。安装目录在 CI checkout 外，凭据和全局 registry 配置不参与。
- 核对 `provider-catalog` / `client-config` 的 CJS 和 ESM 入口来自安装包本身，并验证 runtime、test-utils 与 CLI。
- 同一 tarball 的旧声明必须失败、补全声明后必须通过；只解包执行或移除 optional dependencies 不算此缺陷的回归。
- RC 验收明确记录 `package-consumers`，稳定发布要求该项通过。正式注册表的 Node 22/24/25 与 Bun 消费者矩阵仍保留。

## 冷镜像拉取

已测同 digest 在 node14 冷拉取需 28 分 12 秒且最终正常执行。RC Deployment 进度期限设为 2100 秒，rollout 等待 2400 秒；原有 300 秒应用启动探测、readiness、Pod 和 Chat 验收均不放宽。此设置只覆盖拉取与调度等待，不代表已经解决镜像体积或节点网络问题。

## 验收状态

身份补修后完整构建退出 0，SDK 全量 105/105、独立身份复验 71/71、全量 UI 744/744、`tests/ui` 150 通过/1 跳过/1 todo、发布脚本 38/38。UI 跳过项需要专门包消费者输入（已另行验收）；todo 是尚无原生 Account-scoped contract 的 Account Usage 授权。

最终 tarball 压缩 11,084,358、解包 48,884,979 字节，预算通过；工作树外 Node 24.20/npm 11.19 与 Bun 1.3.12 的 registry-spec 安装均通过，保留 optional 原样并验证实际 auth、包内 CJS/ESM、runtime/test-utils 与 CLI。此项是 package-only，不替代 native 启动。

身份补修后的两轮完整集成每轮均 Lite 151 通过/6 跳过、Full 45/45，容器与卷已清理。Full 集成仍使用仓库 fake QLever，不能代替原生或实际实例。

真实短 TTL 浏览器两项均通过：自动刷新后越过原 access token 到期时间仍能读私有 Pod；refresh token 失效后由产品重新登录并恢复读取。使用隔离 Local、真实原生 QLever 和系统 Chrome，不模拟 token、时钟或网络响应。首次运行因未安装 Playwright 自带浏览器失败，改用现有系统 Chrome 后两项无重试通过。

新 source RC、稳定发布及实际两账号在线验收仍需分别收集证据；在全部完成前不声明发布成功。
