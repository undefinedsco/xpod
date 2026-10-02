# 桌面外壳与 applet 发布审计（2026-10-02）

依据：`docs/superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md`、画板归档 README 与 `docs/RELEASE.md`。实施分支 `codex/desktop-shell-applets`，原目标版本 0.4.21；发现并行目录功能已占用该候选分支，桌面发布版本与集成顺序待对齐。本文件记录当前证据，不作为未完成门禁的通过凭证。

## 功能归位

- 64px rail、270px 对象列与单一 48px 内容头；任务、AI 连接、Pod 使用 WebID，设备和设置保留匿名本机入口。390px 抽屉、焦点恢复和关闭行为复用共享工作区接口。
- AI 连接提供两步密钥创建、整个 Pod 访问面、复制/配置能力降级、模型类型和真实 dimensions、凭据错误码及时间；schema 属 models，目录与行为属能力模块。
- Pod 的模型、搜索、应用、数据共用 `pod-settings` body；embedding 更换只有一个编辑入口，重建需要明确确认。
- 待办、清单、日程及运行通过共用 `tasks` body 与公开 Tasks API；终止传播到活跃执行，同次运行审批按当前 tool checkpoint 恢复。
- 通知分为需要处理与动态，Inbox 从真实 Pod 读取；桌面托盘使用同一快照，显示最多三条并支持审批和身份隔离。
- 设备页显示网络、服务、运行设置与日志；退出确认、自动重启策略、数据目录选择和安全 IPC 已实现。
- 长期 Grant、导入/导出/迁移、多隧道、尚无合同的模型默认项按设计标记待接入。

## 保留已发布行为

对照 stable v0.4.20，选择性保留 DesktopSelfUpdater、ad-hoc afterPack seal 与打包更新验收；Account app 样式固定为 `main.css`，candidate 检查 auth 文档引用资产。账号/Consent 的过期、取消、interaction 与当前 storage 绑定安全逻辑已选择性保留并回归；不通过整笔旧分支合并覆盖新外壳。

## 已收集证据

| 验证层 | 当前结果 |
| --- | --- |
| 包构建、服务 TypeScript、Components、完整 UI 构建、测试类型检查 | 正式 models 消费后完整构建、测试类型检查及全 UI lint 已通过；审批创建、取消、普通 Chat 同 Run 续跑及会话 metadata 转发补全后，build:ts / typecheck:test / UI lint 全部通过；静态 root package.json import 改变编译布局的问题已改为读取权威 PACKAGE_ROOT |
| 全量单测 | build17 与第十轮全部通过：680 文件/6665 项；40 文件/276 项跳过、1 项 todo（现有环境门禁）。内部动态端口冲突及 localhost DNS 延迟边界已修复：端口回归 33 项、真实 runtime 16 项及 unit/helper 10 项通过；数值连接且保留原 Host/DPoP/canonical metadata 与 Response.url，未修改全局 DNS/timeout/ACL |
| RDF Run 权限 | 新 resolver 每次恢复真实认证、HEAD 验证有限来源集合并拒绝重定向/越界/失败响应；不信任旧 context。SQLite/PGlite 空集与 OPTIONAL 基数泄漏回归 162 项通过，安全复核无剩余阻断；共享语义夹具改为真实有限授权；默认容器图按 basePath、图/来源 allow 和 deny 共同下推，物理 default graph 不越权；最终 5 套件/55 项、安全复核通过 |
| 日志 | Supervisor / API 采集先去 ANSI、规范级别并统一脱敏；UI 同源 service/logs 仅在 404/405 时回退，401/403/500 保留错误；36 项针对性回归通过 |
| 完整集成测试 | 第八轮完整通过：lite 30 文件/155 项、6 项跳过；full 5 文件/46 项，无跳过，服务/容器/卷/network 全部清理。第七轮曾发生一次 credentials 写锁 6000ms 超时，原样复验未重现；旧日志不足以证明具体慢 await 或 CPU 根因，保留失败证据，未修改生产锁或测试断言 |
| 桌面 | 最终桌面 build/typecheck/main+preload+console bundle 与 169 项/547 assertions 通过（使用当前已安装 Electron 的实际 MacOS 执行目录）；隔离两版本真实 .app 下载、校验、替换及重启通过（服务 runtime 复用已发布产物，最终新源码仍走 candidate） |
| 公共 API 授权重试 | helper/Provider 118 项通过；真实浏览器无等待的首次两次 Tasks GET 均 200；Pod Config 403 正确触发重试且实际 200；错误字符串与 OpenAI 结构化错误均受同一 narrow missing-access 判定保护 |
| 真实隔离 Standalone | 真实账号/Pod/OIDC 登录通过，13 路由×4 种 viewport/theme/text-size 截图，无 pageErrors |
| 审批与运行并发 | 两个独立登录客户端的审批强 ETag 决策一个 decided、一个 conflict；ORM 回读 approved。Run、Session、续跑 claim/release 统一强 ETag CAS，412 后重新读取和计算；103 项回归及独立复核通过。真实 Pod 独立 DPoP 客户端 Run 取消与 stale completed 写、Session 终态与 stale active 写均回读保留取消/终态；后续取消投影和审计遗漏通过 89 项回归及五个修前失败的屏障用例 |
| AI 层级 | 正式实际实例：Pod TTL PUT/GET、Gateway Key 登记/认证/撤销、Models 非空（1 模型）、Chat 200 且有效内容 XPOD_OK 全部通过；OpenCode 会话标识经同一 typed adapter 接口受限透传 |
| 原生 RDF | 原 Docker/Linux 与 macOS writer 混合夹具导致 WAL 异常；相同 ABI/patch 的 macOS 原生 runtime 已通过 Todo PATCH 与 drizzle updateByIri/deleteByIri 回读。默认图 cache 缺陷通过旧/新严格编译回归；当前源码 macOS arm64 产物 d6d639dbe7c8a757b363d00d749c3e255ccbd65deb37651dc5351725d666355e 已构建并通过完整 CRUD 回读（本地 Homebrew 动态库版本，正式 bundle 由 candidate 验证）；QLever 311 项通过、1 项需要 upstream 环境的语义测试跳过 |
| models | authority worktree 0.2.60 已正式发布（f4ef9877efb6571aeac6f7e3b054a38168c3c064）；26 suites/232 tests、npm registry tarball integrity、导出与新字段类型消费通过；临时补丁已删除 |
| 共用 applet npm | 七包 stable manifests（SDK 0.1.1 等）、拓扑 staging、干净 Bun 消费者 25 个模块/类型及 CSS/integrity 门禁通过；stable exact-SHA guard 后发布，尚未实际发布 |

真实测试中使用的账号、客户端密钥及 Provider 参数只存受保护的 `.test-data` 私有文件，不作为发布产物。

## 发布门禁

1. AI 四层已通过；真实生产 Task 验收发现 drizzle-solid 嵌套 metadata IRI 未按父资源隔离（两个 Task 均写入 #metadata-1），日程/授权对象合并。问题已记录并正式发布 drizzle-solid 0.3.25（86983384f9ea98f6748631bc859a5fc187e4cd1d），839 unit + 真实两 Task CRUD 通过，Xpod patch 重新精确生成且冻结锁通过。freshTask 日程创建/暂停/执行已成功；随后发现 Run RDF context 缺少显式 accessScope，授权范围 producer 已补齐，每次使用实际 Task 身份重新探测 workspace/source 权限；空授权、隐式根 pattern、OPTIONAL 查询 fail-closed 回归与安全复核通过。真实 Task 已越过该检查，随后进入 waiting_runner：API 的权威目录映射已改为启动时捕获并按实例传给 Pi 与子进程，同时显式传递已有 token endpoint；88 项回归通过。旧 waiting_runner 已通过正式 stop 接口取消并回读确认；build13 fresh Task 已进入 running，实际模型每轮成功但 request_approval 参数为空而循环，runNow 同步等待导致默认约 5 分钟后客户端超时。该运行已正式 stop 并独立回读 cancelled，隔 20 秒步骤数量保持 50 条。manual runNow 已改为持久化后立即 ACK queued（71 项回归通过），真实 SSE 探针已复现空参数，同请求真实上游 73 分片/183 字节参数完整，而 Gateway 仅 1 分片/0 字节，已定位重复 assistant role 被误判新响应、重置工具参数缓存；通用 streaming parser 已修复并以真实 Pi SDK 的重复 role/响应身份回归验证，53 项通过；build14/15 的有界真实探针持续收到 B 上游 HTTP 500 空正文，现有账号 A 独立探针返回 429 GoUsageLimitError，Retry-After 为 259216 秒（约三天）。审批创建→同次运行恢复仍未验收通过；不得用人工 checkpoint、mock 或 HTTP 成功状态代替完整链路。Pod CRUD 和审批 CAS 已通过同系统原生回读。
2. 切换正式 models 0.2.60，删除过渡补丁，同步冻结 lock；重跑最终 build/typecheck/lint/单测/完整集成/桌面/视觉验收。
3. 并行目录功能的 `release/0.4.21` 已有成功候选（cb0bbb39abe90e8cf657f10936aba5db7321b826），不覆盖该分支。桌面版本与集成顺序确定后，从经过验收的 source commit 创建对应 release 分支。candidate 从同一 SHA 构建服务、原生 QLever 和桌面，记录 immutable digest 与完整 acceptance artifact。
4. 仅在 exact SHA 的 candidate 全部通过后创建对应 stable tag；stable guard 校验 acceptance，staging 发布、独立 Node/Bun 消费验收后提升 latest，再提升同一 digest 并部署。
5. 共用包通过 stable guard 后按依赖顺序 staging 发布，清洁安装检查 exports/types/CSS 和真实模块导入，再提升 latest。根包 latest 等待此门禁成功，独立 tag/manual workflow 不绕过 RC。
