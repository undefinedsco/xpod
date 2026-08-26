# Account、WebID 与 Pod 绑定架构

本文说明 Xpod 当前的账号元数据与 Pod 绑定边界，尤其是 Cloud IdP + Local
Storage Provider（SP）场景。这里记录的是运行时约束，不是 UI 实现建议。

## 1. CSS 默认语义

Community Solid Server（CSS）的 `BasePodStore.create` 同时做两件事：

1. 把 `settings.base.path` 写入 account Pod 记录；
2. 调用当前服务器的 `PodManager.createPod` 创建实际 Pod。

这个默认语义只适用于“账号服务与 Pod 存储在同一台 CSS”场景。若 Cloud IdP 已经
通过回调让 Local SP 创建了 Pod，再调用 Cloud `PodManager`，会额外创建一个并不存在
于用户预期中的 Cloud Pod；若仍把 `settings.base.path` 当作 Pod 地址写入账号记录，
account API 也会暴露错误的 Cloud 占位地址。

## 2. 当前持久化实现

- Local/standalone 默认沿用 CSS PodStore 行为；账号记录与实际 Pod 位于同一存储域。
- Cloud 的 `AccountStorage` 由 `DrizzleIndexedStorage` 持久化到集群 identity DB，
  多实例不能依赖容器本地 `.internal/accounts/**` 文件。
- `ProvisionPodStore` 等位替换 CSS `BasePodStore`，但只对带有内部
  `xpodRemoteProvisioned` 标记的远端 provisioning 生效：
  - `settings.storage` 是 Local SP 的 canonical Pod URL；
  - Cloud account Pod 记录的 `baseUrl` 必须保存这个 canonical URL；
  - Cloud 保存 account → Pod 与 Pod → owner(WebID) 关系；
  - Cloud **不得**再次调用自己的 `PodManager.createPod`；
  - 普通本地 Pod 创建仍完整委托 CSS，不能改变其行为。

该标记只是进程内 adapter 协议，不是用户 Pod 中的共享 RDF 模型，因此不放入
`@undefineds.co/models`。跨产品可见的事实仍是标准 WebID、Pod URL、owner 关系与
WebID profile 的 `solid:storage`。

## 3. Cloud + Local 首次绑定链路

1. Local Xpod 向 Cloud 注册 SP，Cloud 签发短期 provisioning code。
2. 用户在 Cloud IdP 完成 account session 登录。
3. Cloud `ProvisionPodCreator` 通过 managed route 连接 Local；若 raw P2P listener
   尚未就绪，必须继续保留 direct/user-tunnel fallback。
4. Local `/provision/pods` 创建实际 Pod、Local identity index 与 WebID profile，
   并返回实际 Pod URL。相同 WebID + Pod 名称的重试是幂等的。
5. Cloud `ProvisionPodStore` 只登记 canonical Local Pod URL 与 owner，不创建 Cloud Pod。
6. account API 返回 canonical Local Pod URL；Consent/Account UI 从 Cloud account facts
   选择 WebID，不在浏览器中携带 service token 直连 Local provisioning API。

```text
Cloud account
  └─ WebID: https://id.example/alice/profile/card#me
      └─ Pod record: https://<local-node-domain>/alice/
          └─ owner: the same WebID

Local SP
  └─ actual Pod: https://<local-node-domain>/alice/
      └─ profile solid:storage -> that Local Pod URL
```

## 4. 不变量

- Cloud account API 中的 Pod URL 必须是浏览器与 SDK 都认可的 canonical URL，不能是
  Cloud 内部占位路径、loopback callback URL 或信令地址。
- managed-route token 只表示“允许尝试建立路由”，不表示 Local 已启动 P2P listener；
  不得因此删除 tunnel/direct fallback。
- 浏览器不负责判断或建立 Local 最优路径，也不应获得 provisioning service token。
  路由选择属于服务端/SDK adapter 边界。
- “已有 WebID、缺少当前 Local Pod 记录”是异常修复态，不是正常的“正在同步”。UI
  可以从 Cloud account endpoint 重新提交同一 provisioning code，但底层 Local 创建必须幂等。
- 网络异常不得通过原生 `alert('fetch failed')` 暴露。页面显示可执行的内联错误；日志保留
  底层错误供诊断。

## 5. 必须验证的回归层级

1. `ProvisionPodStore`：远端 canonical URL 被保存且 Cloud PodManager 未调用；普通创建仍委托 CSS。
2. `ProvisionPodCreator`：managed route 与 tunnel/direct fallback 都可用；Local callback 重试幂等。
3. Cloud account API：Pod 列表返回 Local canonical URL，进程重启后仍存在。
4. Browser：Account/Consent/First Pod 页面不直接请求 Local `/provision/*`，也不出现原生
   `fetch failed` 弹窗。
5. 真实 Xpod：登录 → Local Pod 绑定 → Pod 读写 → API Key 创建/读取 → `/v1/models` →
   `/v1/chat/completions`。这些层级必须分项报告；单元测试或 mock 不能替代真实链路。

真实实例的命令与证据格式见 [`docs/cli-dev-testing.md`](cli-dev-testing.md)。
