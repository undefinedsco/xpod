# drizzle-solid 显式 Pod 根地址被 WebID 推导地址覆盖

## 复现与影响

实际三模式验收补上默认 ORM（非 fake dbFactory）回归后，`@undefineds.co/drizzle-solid@0.3.18` 出现以下行为：

- WebID：`https://id.example/alice/profile/card#me`
- 已确认的 Pod：`https://alice.nodes.example/`
- `drizzle(session, { podUrl, resourcePreparation: 'off' })` 仍连接 `https://id.example/alice/`。
- 同源判断因此错误：真正 Pod 上的查询端点被视为跨源，丢弃已授权 fetch；托管 Pod 查询失败。

根因是 `core/utils/pod-root.resolvePodBase()` 对显式 `podUrl` 也使用“第一个路径段”推导，再优先挑有用户路径的候选。独立域名根路径输给 WebID 路径；多层显式 Pod 路径也会被截断。

这不是 RDF 模型错误，也不能通过扩大 HostedPodDataAccess 权限、伪造 WebID、裸 SPARQL 或业务层改写 URL 修复。

## 修复边界

1. 显式且合法的 `podUrl` 是上游已选择的存储根，应保留完整 URL，只补末尾斜杠；只有缺失/非法时才使用既有 storage/WebID 推导。
2. Xpod Gateway Key repository 必须传入已经解析的 Pod，关闭不属于该 scoped adapter 的资源发现/准备，列表查询仅使用 API Key 文档端点。
3. 通过 Bun 的版本绑定 patch 暂时修复 SDK 的 CJS/ESM 两个产物；不增加另一套 Xpod URL 推导器。后续 SDK 正式发布该修复后，升级并删除补丁。

## 验证要求

- 默认 ORM 在 Cloud IdP + 独立域名 Pod 根、普通用户路径、多层路径上都只访问 key 文档查询端点。
- 不访问 WebID、Pod 根探测或整个 Pod 的 SPARQL 端点。
- 三模式同一镜像实际创建/读回 Key；单元测试不能替代真实链路。
