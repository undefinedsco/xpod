# 同镜像三模式 CI 契约（实现中，尚未执行）

本契约只描述新门禁；`30991483` 及早先镜像不因此取得新增资格。

A 负责隔离 Docker 拓扑、同平台同 digest 事实、分层 live runner、聚合及 required check。
B 负责 `scripts/accept-service-image-session.ts` 测试专用入口、TTL 派生、真实 Web 与桌面 SDK 会话验证。
共享声明唯一位于 `scripts/lib/service-image-session-contract.cjs`，两边不得另维护宽松 schema。

B 的两个命令（B 实现前保持门禁阻塞）：

```
bun scripts/accept-service-image-session.ts derive-config ORIGINAL_JSON DERIVED_JSON PROFILE POLICY_RECEIPT
bun scripts/accept-service-image-session.ts run PRIVATE_DEPLOYMENT_MANIFEST
```

`derive-config` 只允许修改实际镜像原配置的 AccessToken / RefreshToken TTL 与 clockTolerance，保留其余字段，恰好命中一个 IdP 配置。
输出 policy receipt 为 `{originalConfigSHA256, derivedConfigSHA256, accessTokenTtl, refreshTokenTtl}`。
renew / idle 为 30 / 180 秒，expire 为 30 / 5 秒；不能修改共享 RC，也不把它称默认 1 小时 / 14 天寿命实测。
A 在装载配置前独立检查摘要与 profile 声明。

私有输入由 A 创建，0600，包含：schemaVersion、sourceSha、mode、baseUrl、issuer、
image `{reference,platform,id}`、profile `{kind,accessTokenTtl,refreshTokenTtl,originalConfigSHA256,derivedConfigSHA256}`、
binding `{webId,podUrl}`、ownershipRoot、accountFile、outputDirectory。
`accountFile` 是同一 owned root 下单独的 0600 JSON `{email,password,webId,podUrl}`，不得进入安全报告。
绑定来自真实 Account / provision / Profile，不能用路径猜身份。Local 的 issuer 属于隔离 Cloud，Cloud / Standalone 使用自身 issuer。
B 必须检查文件是 owned root 内的普通非 symlink 文件，不启动替代 Xpod 或读取用户凭据。

B 产生 `outputDirectory/session.safe.json`，字段及成功条件由共享 `validateReceipt` 定义。
Web 证据需要真实 PKCE auth-code、持久化 Account Cookie 恢复、零新增密码提交、身份一致；
SDK 证据分别需要实际 refresh_token 成功或 invalid_grant 后完整重登，真实时间边界、私有读写、匿名拒绝及实际 host 持久化恢复。
Cookie 重登、client credentials、mock 服务均不能满足 SDK refresh。
所有 owned 子进程必须 actual wait / close / group absence，输出原件只允许固定安全字段，不得包含 token、密码、cookie 或用户页面正文。
安全原件相对路径、长度、SHA-256 由 B 声明，A 重新读取核对；A 只聚合所有模式 / profile 均通过的结果。

当前接口密钥规范见 `ai-connections-product-spec.md` 的 Web Management Contract、`pod-interface-key.md` 2026-10-07 更正及共享 `AiClientCredentialsCapability`。
Account 仅 create / list metadata / revoke，wrapper 只在创建时存在；没有 reveal 和 enable/disable。旧 2026-08-28 报告保留，不能复活历史接口或标作当前通过。

执行预算：当前只允许现有依赖下 tiny contract 测试，每批不超过 30 秒 / 20 MiB 写入。
真实 Docker / pull / 大构建由主会话排队。新 CI 运行全程 60 分钟，上层 55 分钟进入 cleanup，始终保留独立原始失败。
不得访问 60895、共享 RC、现网或其他任务资源。真实执行后才能报告三模式成功。

A 是唯一 Linux 运行准备方：固定 Ubuntu 24.04，安装 Xvfb / Chromium 系统依赖和锁内 Electron 可执行，并以 `ldd` 缺库即失败。
A 每个 B 调用用自己的 `runOwnedModeCommand('xvfb-run', ...)` 包装，Xvfb、B 的 actual wait/close 与 group absence 同属一次记录；B 不另起 display。
helper 的 `terminationGraceMs` 默认 1000，可选 1000..10000。A browser-* 父命令使用 10000，B 的 Playwright 子命令保留默认 1000，内部预算不超过 270 秒，父预算 300 秒。
最终 close 观察在 TERM/KILL 后仍有硬上限（默认 grace + 3000ms），未观察到 close 时独立标记 exit/wait/close、ownershipUnknown，禁止 hash/资格；销毁本地 reader handles 不算 child close。
安全 artifact 在任何读取前对整个目录作 lstat 预检（单件 1 MiB / 合计 16 MiB），目录 symlink、路径别名和中途替换均拒绝。
候选及 stable promotion 共用仅 Node 内置依赖的 `scripts/verify-service-image-modes.cjs`；stable 按 accepted manifest digest 和候选 API 原 run/attempt 重读原件，不安装服务依赖或运行产品。

部分重跑保留 matrix 成功原件：runtime job 输出自身 actual attempt 和精确 artifact name/id/digest；finalize 按该输出取原件，不能用 finalize 当轮的 global attempt 拼名字。
finalize 保存 selection 及真实 API jobs/artifact 原 metadata，stable 重新查询该 run 的全部 job attempts，要求最新实际 matrix job 成功且与选择的 attempt/source/artifact 一致。
若只有其它 job 重跑到 attempt 2，matrix 仍可保留 attempt 1；若 matrix 自己 attempt 2 失败，不能借 attempt 1 通过。
producer 自检仅输出 `runtime-mode-matrix-precheck`，最终 required check 必须经过实际 successful job 与原件 authority 验证。
