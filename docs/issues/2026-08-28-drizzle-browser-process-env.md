# drizzle-solid 浏览器初始化错误依赖 Node process

## 真实复现

Web 完成 OIDC 后，Cloud WebID profile 已声明 Cloud 分配的 Local Pod URL，CSS 的归属查询也返回有效绑定，但 Settings callback 在 `runtime.pod.open()` 中失败。

`@undefineds.co/drizzle-solid@0.3.18` 的 `PodDialect` 构造器在没有 `session.info.clientId/client_id` 时直接读取 `process.env.SOLID_CLIENT_ID`。Inrupt 浏览器 Session 不提供这两个字段，浏览器也没有 Node 的 `process`，因此数据库在发出 Pod 请求之前就抛异常。这不是 Pod 未绑定、访问令牌过期或存储地址错误。

复现条件：导入真实 ORM 与 models，用带 WebID 的 Session、已确定的 canonical `podUrl` 创建数据库，并在构造期间移除 Node `process`。普通 Bun/Node/默认 JSDOM 测试自带 `process`，不能证明浏览器可用。

同类问题还存在于 `SelectQueryBuilder.mergeRowsBySubject()`：非空查询结果会直接读取 `process.env.DEBUG_INLINE_MERGE`，导致初始化修复后仍无法读取已写入的数据。空列表测试不能覆盖此分支。

## 修复边界

- 保留 ORM；不改用裸 SPARQL，不给浏览器注入虚假的 Node 环境或服务器凭据。
- 仅在 Node 环境存在时读取已有环境变量回退；浏览器允许 clientId 未提供。
- 在已有版本绑定的 Bun patch 中同步修复 CJS/ESM。上游版本包含修复后删除对应补丁。
- 使用真实 ORM、缺失 `process` 的构造与非空 SELECT 结果回归，并继续真实 Web 的 Provider 写入与 Chat 验收。

记录范围：本仓库依赖问题记录，尚未向上游发布 issue。

## Web 开发缓存与清理计划

实际回调堆栈引用了已经不在当前服务磁盘上的旧 `PodDialect` 优化 chunk，
而新 chunk 中已有环境检查；修改 Vite 依赖优化配置后，浏览器使用了新的
资源版本。仅重启或 `--force` 重打包，不能代替核对浏览器实际加载的资源。

核对当前 Vite 7 的 `getLockfileHash` 后，不能把该问题归因于
`ui/yarn.lock` 遮挡根 `bun.lock`：它读取的是包管理器安装元数据与 Bun
锁文件，并不直接读取 `yarn.lock`。移除 UI 旧 Yarn 锁文件只是落实工作区
统一使用 Bun 的清理，不是已证实的缓存根因。

清理顺序：先用回归锁定 UI 不得保留独立的旧 Yarn 锁文件，再移除该文件；
另用回归确保 CommonJS Comunica 引擎与序列化器参与 Vite 预打包，不能
作为原生 ESM 排除；重启后核对实际资源版本，再验收真实 Web 写入。
不删除浏览器会话或 Pod 数据，也不使用随机 cache-buster 掩盖依赖源不一致。
