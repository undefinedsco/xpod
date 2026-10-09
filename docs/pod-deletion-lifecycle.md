# Pod 删除：账号、数据和独立部署

这份文档记录登录模块用户验收后补充的删除契约。前端设计与入口说明见 `docs/superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md` §13。

## 页面与能力

账号页使用共享 `ConfirmationDialog`，显示完整存储地址、永久删除说明、取消和删除按钮。默认焦点在取消，取消不发送请求；请求期间禁止重复提交和关闭，失败保留弹窗并允许重试。Solid 客户端凭据撤销复用该组件。

账号 Pod inventory 的 `pods[storageUrl]` 仍是原有 owner 管理地址，支持 GET/POST，不能据此推断 DELETE。`podDeletionControls[storageUrl]` 单独声明服务器可执行的删除能力。没有能力时前端不提供删除按钮，也不从 URL 拼接删除接口。后端仍独立验证创建账号，页面声明不能替代授权。

## 执行边界

- `PodDeletionInteractionHandler` 在原有账号 Pod 资源上增加 DELETE，保留 upstream GET/POST。删除账号内 Pod 的请求以认证账号和路由 Pod ID 为准，不接受正文提供另一账号或存储目标。
- `PodDataDeletionService` 先遍历容器、子资源和辅助 ACL/ACR，准备完整后序计划。生命周期服务把计划持久化之后才删除。每个资源先删除权威内容/文件镜像，再删除 RDF source 索引；只有明确 NotFound 可以忽略。
- 收尾按规范 Pod 图地址范围清除未被目录列出的 RDF 图及旧 quint 镜像，覆盖私有 type index 等隐藏资源。对象存储容器使用创建时的 `.container` 键；文件镜像与独立对象存储镜像分别清理，其他 Pod 的图和对象保留。
- `PodDeletionLifecycleService` 负责删除、失败恢复和 metadata 清理。数据成功删除后清理该 Pod 的 owner 和 Pod 记录；账号、密码及 WebID 登录关系保留。失败不能只移除账号绑定以隐藏残留数据。
- `PodMutationLockingHttpHandler` 包装整个 CSS 数据请求链，让写入和删除共同参与服务器 namespace 与 Pod 锁；锁内复查持久删除屏障及目标代次。精确资源锁本身不能保护子树。服务器根 SPARQL 写入也参与 namespace 屏障；等待期间发生删除则旧请求不再执行。
- API 创建与 CSS 删除使用同一身份数据库中的存储地址 reservation，防止不同进程同时创建/删除同一地址。未完成删除保留 reservation 和删除计划，重试继续相同操作。创建进程崩溃遗留的 reservation 安全拒绝后续操作，不能自动抢占未知存活的创建任务。

Pod 生命周期使用独立的关键锁。普通资源锁的超时不能释放仍在执行的生命周期操作；Cloud 关键锁不能因固定 TTL 或另一个节点的初始化而被清除。进程崩溃后保留的关键锁需要确认旧执行者已经退出，再由运维恢复；不能自动猜测锁已失效。

Cloud 关键锁接入实际初始化和关闭顺序，先等待锁内回调结束，再关闭 RDF accessor。Local 复用 HTTP 服务关闭时等待在途请求的行为。外层 runtime 对 API/CSS 关闭超时只告警，继续等待服务实际结束；关闭失败保留共享 Redis/身份数据库等资源并报告失败，不能因超过五秒就关闭仍被写入使用的连接。

异步向量计算完成后通过 `indexVectorSourceIfCurrent` 提交：SQLite 在同库事务中核对当前文本来源与分块，PostgreSQL 在同一事务中锁定文本来源行并核对，再写入向量。来源被删除或变更时返回 skipped，不能把旧结果写回。无法证明文本与向量属于同库的实现也跳过条件写入；原始 engine 的直接向量写入接口保持原契约。

## Cloud 管理的独立 Local

Cloud 与 Local 的 Pod ID、账号 ID 可以不同，不能按 URL 或 owner 标签猜测创建代次。新建 Local Pod 使用新的 Pod ID；Cloud 删除命令须绑定可信创建事实的 Local 代次。无法证明代次的旧绑定不应声明删除能力。

预配 receipt 只有在实际创建新 Pod 时才携带 `podId`。对已有 Pod 的普通预配请求保留地址与 WebID 信息，但不返回可登记删除代次的 `podId`；否则普通短期预配凭据可能把已有 Pod 关联到另一账号并取得删除权限。已有 Pod 的删除能力只能通过下面的管理员授权流程恢复。

旧绑定通过明确授权当前 Pod 恢复能力，不按 heartbeat 的地址/owner 交集自动迁移：同一 WebID 可以关联不同账号，同地址也可能已重建。账号页先对当前 Pod 控件 POST `requestDeletionAuthorization` 建立短期 challenge，再进入可信节点的 Pod 管理重页面。Local 同源预检取得 Cloud 权威目标及当前 Local Pod ID，管理员确认后再次核对该 ID，通过既有 `XpodNode` 身份向固定注册 Cloud 回调。Cloud 原子消费 challenge 并首次登记代次；已有代次或任何删除操作都不覆盖。该步骤不执行删除，也不向浏览器提供根 serviceToken。

此授权只接受既有管理员权限，普通短期预配凭据不能升级为删除权限；浏览器请求还要求严格同源。公共节点/隧道入口不因传输在本机终止就获得管理员身份。需要在运行该 Pod 的设备本机管理地址继续时，前端只携带 challenge 和 Pod 名导航，不能自定回调服务器。

Cloud 生成绑定账号、Cloud Pod、节点、存储地址、动作及代次的短期 opaque grant。grant 明文不持久化，不出现在浏览器。Local 只向持久注册状态中的固定 `cloudApiUrl` 回查，通过既有 `XpodNode nodeId:nodeToken` 身份验证；请求头不能指定回查服务器。

Gateway 将精确 `DELETE /provision/pods/:podName` 转交 CSS 的 `LocalPodDeletionHttpHandler`。GET/POST 预配仍走 API。旧 API 的目录级删除关闭，避免存在第二条遗漏 RDF 或 metadata 的删除路径。Local 根 serviceToken 可用于根操作；普通预配 access token 的 network:read/connect 权限不能授权删除。

Local 完成持久数据删除与本地 metadata 清理，再通过 `/api/pod-deletions/:operationId/complete` 回执 Cloud。节点不可达、拒绝、删除失败或回执丢失，Cloud 都保留绑定。重试使用相同 operationId，并且旧操作不能删除同地址重建的新代次。

## 验收范围

浏览器 fixture 证明弹窗、能力声明和页面交互，不证明真实数据删除。真实存储验收须分别覆盖 Local/Standalone 自有 Pod，以及 Cloud→独立 Local 的授权、删除和回执流程；断言 RDF、文件、ACL、Pod/owner metadata 清除、其他 Pod 保留和原账号仍可登录。

本地修改、测试或隔离实例通过，不表示用户当前 Gateway 或生产实例已经更新。生产真实 Pod 删除属于不可逆操作，不能为了测试销毁用户现有数据。
