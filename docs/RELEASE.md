# 发布流程

Xpod 发布必须先经过 Release Candidate，再由 stable tag 提升同一个 commit
和同一个容器 digest。不要用 stable tag 调试发布问题；修复必须继续提交到
`release/<version>`，由新的 RC 重新验收。

## 生命周期总览

1. 从准备发布的 commit 创建 `release/<version>` 分支，例如
   `release/0.4.0`。
2. 每个推送到 `release/<version>` 的 commit 都触发
   `.github/workflows/candidate.yml`，生成一个新的 RC。
3. CI 从同一 source SHA 派生唯一候选版本。首次运行格式为 `0.4.0-rc.<run-number>`；rerun 格式为 `0.4.0-rc.<run-number>.<run-attempt>`。例如 `0.4.0-rc.41`，rerun 示例为 `0.4.0-rc.41.2`。
4. 同一次 RC workflow 构建一个 GHCR 镜像，打 `sha-<full-sha>` 和 RC
   版本 tag，并记录 canonical digest，例如
   `ghcr.io/undefinedsco/xpod@sha256:<64-hex>`。
5. RC workflow 将该 digest 部署到 `https://id-rc.undefineds.cn` 并运行公开
   和认证验收。
6. 同一个 workflow 在 macOS ARM64 构建并实测原生 QLever runtime，运行真实
   RDF、FTS、VEC Local conformance，但 RC 不向 npm 发布任何包。
7. 同一个 workflow 构建带 ad-hoc 签名、未 notarize 的 macOS ARM64 桌面产物，并验证版本、
   QLever runtime、manifest、真实自更新及同包真实权限操作；服务、QLever 和桌面全部通过后才接受该候选。
8. 验收成功后上传 acceptance artifact：artifact name 是 `release-acceptance-${GITHUB_SHA}`，artifact 内文件是 `release-acceptance.json`。该 artifact 是 stable tag promotion 的唯一凭证。
9. 只在接受的 exact commit 上创建 stable tag，例如 `v0.4.0`。
10. `.github/workflows/release.yml` 下载 exact commit 对应的 acceptance
   artifact，校验 stable tag、release branch、required
   checks 和 accepted digest 后，才首次发布该版本的 npm 包：先发布到不可见的
   `stable-staging` tag，并由 Node/Bun 重新安装验证；然后才移动 npm `latest`、把 accepted digest
   重新标记为 stable/latest 容器 tag，并调用生产部署。

## 一次性 RC 环境

GitHub 需要配置独立的 GitHub Environment `rc`：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `KUBE_CONFIG_DATA` | base64 编码的 GZ Sealos kubeconfig，使用广州集群分配的固定 namespace |
| Secret | `APP_ENV_FILE` | RC runtime env 文件内容 |
| Secret | `XPOD_RC_SEED_CONFIG` | 固定 RC seed JSON，必须包含 Alice 和 Bob 账号及 Pod 名称 |
| Secret | `XPOD_LIVE_PROVIDER_API_KEY_CONFIG` | 真实 AI Provider 验收配置，格式同 `scripts/live-provider-api-key.example`；用于证明 `/v1/chat/completions` 真可用 |
| Secret | `XPOD_AI_PROXY_URL` | 可选，真实 AI Provider 验收需要代理时填写 |
| Variable | `SEALOS_NAMESPACE` | 必填变量，填写 kubeconfig 的固定 namespace，例如 `ns-iknkxtc8` |
| Variable | `XPOD_RUNTIME_SECRET_NAME` | 必填变量，推荐值 `xpod-rc-secret` |
| Variable | `XPOD_RC_SCALE_TO_ZERO` | 已废弃：验收后固定执行 scale-to-zero（不再读取该变量；需 rc_kubeconfig 校验通过） |
| Variable | `XPOD_INSTALL_REGISTRY` | 可选，安装烟测 registry 覆盖 |

RC 公开入口为 `https://id-rc.undefineds.cn`、`https://pods-rc.undefineds.cn`
和 `https://api-rc.undefineds.cn`。这三个 `.cn` 别名（DNS-only CNAME）统一指向
Sealos ingress，三个 Ingress 经统一 Nginx Gateway 路由到 RC 服务；TLS Secret
由 Sealos certificate controller 在 Ingress 创建后签发。overlay 不创建
physical PostgreSQL、Redis、object storage 或独立 Kubernetes cluster；它复用现有物理基础设施，
但必须使用独立 logical database or schema、独立 Redis DB 和独立 object bucket。
`APP_ENV_FILE` 的 `CSS_IDENTITY_DB_URL` 与 `CSS_SPARQL_ENDPOINT` 均指向共享
`xpod-rdf-postgres` 的独立 `xpod_rc` 库和角色；不再丢弃这些配置或注入临时数据库 URL。

推荐的 RC Kubernetes 资源拓扑：

- runtime Secret：`xpod-rc-secret`
- Xpod Deployment：`xpod-rc`
- shared Inngest Deployment：`xpod-inngest`（只复用，不由 RC overlay 创建或缩容）
- ConfigMap：`xpod-rc-config`
- seed Secret：以 `xpod-rc-seed` 为前缀、按 workflow run 唯一命名

`XPOD_RC_SEED_CONFIG` 使用与 `CSS_SEED_CONFIG` 相同的 seed account JSON
数组格式，至少包含可密码登录的 Alice 和 Bob 账号，并分别声明 Alice/Bob 的
Pod 名称。candidate workflow 会把该 secret 写入以 `xpod-rc-seed` 为前缀的
本次运行专属 Kubernetes Secret，并把最终 image digest、Secret 名称以及 Xpod
容器的 `CSS_SEED_CONFIG=/app/config/seeds/rc.json` 一次性渲染到只读挂载文件
和最终 Deployment。部署只能对该最终 manifest 执行一次 apply，不得再分步
patch Deployment、set image 或 rollout restart；否则多个 ReplicaSet 会在 CSS
seed initializer 创建账号和 Pod 的过程中打断进程，留下不完整的 Profile/ACR。
RC 启动后由 CSS seed initializer 创建账号和 Pod。
认证验收使用测试专用的外部 RP，通过已部署 RC 的真实 IdP 为 seed Alice/Bob 分别执行
浏览器 OIDC、PKCE 和 DPoP token exchange；不会启动第二套 Xpod、模拟 issuer，或向
Chromium 注入桌面 bridge。两份私有 Playwright storage state 保存原生 Account Cookie
和浏览器存储，旁边的 identity JSON 只记录无密钥的 Account ID、WebID 和 storage URL；
RP token 与 DPoP 私钥仅在进程内使用，不写入该旁档或公开 artifact。

后续测试以独立浏览器上下文加载两份 state，向同一 RC 发起新的真实 OIDC 事务，要求不再
提交密码，并交叉核验 token WebID、Cookie 恢复的 Account controls/bindings 与公开 Profile
的规范 HTTPS storage 地址。每个用户都必须以真实 SDK authenticated fetch 完成私有文件
PUT/GET 精确内容校验；另一用户和匿名请求的 GET/PUT 必须被拒绝，拒绝写入后内容必须
保持原样，最终删除本次创建的文件。不同的 Pod URL 或公开 Profile 可读不能代替私有隔离。

部署浏览器的宽屏与窄屏 smoke 验证轻量账号页面和桌面入口，且不出现 AI Connections、
Pod、Network、Status 重管理工作区。Web 永远轻量，重管理只属于桌面 Xpod。这里的三个
Playwright 用例和 `solid-pod-isolation`、`browser-visual` 必过项保持不变，不得以 skip、
假 bridge 或 fixture 数据替代部署证据。

轻量账号页面是客户端渲染：文档本身立刻返回 200，`账号总览` 只在 SPA 解析出 Account
index 并取到 Cookie 认证的 controls 之后才绘制。因此验证按固定预算等待**已绘制**的页面，
而不是 `domcontentloaded` 之后的一帧；预算内只有 dashboard 形态算通过，其余形态
（bootstrap 加载/错误、login、consent 跳转、无法识别）在失败时以固定 token 报出，预算到期
不算通过。绘制文案、URL 凭据与原始浏览器错误都不进入该 token，失败信息只表达观察到的形态。
同一预算也约束每一次文档读取：渲染进程在剩余预算内没有应答时按原样上报，既不越过预算继续
等待，也不被当成通过。

完整 provider 写入、Pod 读写、Gateway Key、Models、真实 Chat 和 Tasks 审批由紧随其后的
一次性 Local runtime 对同一 RC Cloud 执行。本地 hermetic/部署模式矩阵只证明隔离栈，
不冒充已部署 RC 或真实桌面。0.4.25 的 macOS `desktop` 门禁证明旧包到新包的真实自更新，
未覆盖重管理权限操作。0.4.26 起该必需项同时要求 exact zip 的权限操作证据：真实
Electron/preload 与自带 Local runtime，Cloud card 身份、两份权威 Local Pod 绑定和无公网
路由，实际 Consent 绑定证明（显式选择，或观察到的 singleton/no-chooser 呈现形态加已认证且与
目标完全一致的 exact 运行态 binding；两条路径都必须另有实际批准提交与 callback/PKCE 证据）
与回调、两轮完整资源授权、Account Key/配置、collection 写入确认、
Models/Quota/单发 Chat、跨 Pod 拒绝与清理。缺任一证据不得写入 `desktop:passed`。
详见[桌面权限验收契约](testing/desktop-permission-acceptance.md)。这项并不声明 Pod、Network、
Status 所有管理操作、所有订阅 provider 或原安装 App 已验；不得用普通 Chromium 截图补足。
失败时的公开归因现在同时覆盖浏览器批准阶段（`oidc-approval` + 操作 token）与 mounted 权限
阶段（`pod-permission` + mounted 边界 token），并对 `AggregateError` 按 primary/cleanup 顺序取第一个受审失败；
stage 时长**不能**证明是哪个内部操作失败——RC `37580705243` 的 `pod-a` 内部操作仍然是
UNPROVEN，直到下一轮 RC 以该归因复现。

这些值必须由 RC seed 自动生成，不能作为 GitHub secret/variable 手工维护：

- 不要配置 `XPOD_SETTINGS_E2E_ALICE_STATE`
- 不要配置 `XPOD_SETTINGS_E2E_BOB_STATE`

Do not reuse the production `APP_ENV_FILE`。RC `APP_ENV_FILE` 必须提供
独立值，至少包括：

- `CSS_SPARQL_ENDPOINT`
- `CSS_IDENTITY_DB_URL`
- `CSS_REDIS_CLIENT`
- `XPOD_INNGEST_EVENT_KEY`
- `XPOD_INNGEST_SIGNING_KEY`

候选 workflow 会拒绝生产数据库名称或
`xpod-cloud`/`prod`/`production` 风格值。`CSS_REDIS_CLIENT` 必须显式指向
独立 Redis DB，格式上应类似 `CSS_REDIS_CLIENT=.../<nonzero>`；候选 workflow
会拒绝缺少 DB index、使用 Redis DB 0 或包含 production marker 的 Redis URL。
不要通过 `XPOD_REDIS_PREFIX` 或 `XPOD_OBJECT_PREFIX` 试图隔离 RC；当前代码
不读取这些变量。RC 对象存储使用独立 R2 bucket/credential，并在部署前执行真实
读写/删除 preflight；不得创建 overlay 内 MinIO 或复用生产 bucket。隔离由 nonzero
Redis DB index、数据库/schema principal 和独立对象存储共同完成。

## 原生 Local 与桌面发布边界

0.4.0 的 npm/桌面原生 Local 正式支持平台是 macOS ARM64。根包通过可选依赖安装
`@undefineds.co/xpod-darwin-arm64`；该包同时包含 Xpod Bun binary、QLever runtime、
所需 dylib 和带 SHA-256 的 manifest。不得发布没有真实 runtime 的占位平台包。

Linux Local、Cloud 与 Standalone 由同一个 public immutable container image 验收和
交付。Linux 原生 npm 包不是 0.4.0 的发布承诺；增加平台时必须先有对应原生构建、
安装后 conformance 与平台消费者门禁，不能只追加 optional dependency 名称。

候选 artifact 的 QLever runtime 必须由 exact source SHA 的 reusable workflow 构建，
先通过 runtime 自身 RDF/FTS/VEC smoke，再进入桌面验收。桌面必须复用同一个已验
runtime artifact，并验证版本、nested runtime 可执行文件和 manifest。
0.4.0 不承诺 Developer ID 签名或 notarization；该桌面 artifact 用于验收和直接分发，
macOS 可能显示未识别开发者提示。未来启用 Apple Developer Program 时，应直接恢复
签名与 notarization 作为新版本门禁，不在本次流程中保留双路径或 fallback。

### 平台包发布体积门禁

根 JavaScript 包与原生平台包分别验收。平台构建会测量实际 `npm pack --dry-run --json`
结果，保存 `*-pack.json`，再验证项目预算：gzip tarball ≤ 180 MiB、base64 attachment
加 64 KiB metadata 余量后的发布请求体 ≤ 240 MiB。这是 Xpod 的项目预算，**不是 npm
官方服务器大小保证**。RC 上传 `candidate-native-package-budget-<SHA>`，stable 上传
`stable-native-package-budget-<SHA>`；真实 tarball/请求体核对与公开 npm 发布仍独立验收。
预算失败不能通过删除对应源码、QLever/ICU 等必需文件来绕过。

单文件运行归档使用内置 Brotli quality 9 并验证压缩字节摘要；解压后保留相同文件内容、
权限和启动参数。外置 `SOURCE/` 的固定归档和 pin 不变。冷/热缓存与 archive checksum
漂移回归不表示每个已缓存文件新增了防篡改检查。

`v0.4.23` 已签名后因原生 npm 包 `E413` 失败，标签及源码保持不可变；恢复发行使用
未占用 patch 的新源码、新 RC 和签名标签（本轮为 `0.4.25`），不提升失败发行。经过与原因见
[平台包发布体积问题](issues/2026-10-04-native-npm-publication-budget.md)。

### 嵌入式原生 CLI 的 Corresponding Source 与 NOTICE

平台包 `@undefineds.co/xpod-darwin-arm64` 内嵌 `inngest-cli@1.40.0`（SSPL-1.0，附
Apache-2.0 future 许可，生效日 2029-07-30）。发行必须随包附上**实际对应源码与 NOTICE**，
不能只留 private review 包或一个 URL/metadata：

- 平台包额外包含 `SOURCE/`：`SOURCE-MANIFEST.json`、`NOTICE`、`inngest-cli` 许可原文、
  上游源码归档（pin 到 commit `0d75b0b3…`，sha256 `dd6c84ec…`），以及被
  `internal/embeddocs/docs.go` 的 `//go:embed website/pages/docs/*` 编译进二进制的
  `inngest/website@159c0ac6…` 174 个 docs 输入。
- 版本/来源为单一 pin，位于 `scripts/lib/embedded-native-source.cjs`：绑定已安装包版本、
  二进制 sha256 与真实 Mach-O/ELF target、许可 sha、源码归档 sha/大小/成员数、embed docs
  子模块 commit/文件数/聚合 sha。任一漂移显式失败，不允许静默降级。
- 构建期从 public pinned URL 下载或复用固定缓存，并校验同一 hash；源码不嵌入 Bun 二进制。
- 安装验证：`scripts/package-consumer-smoke.cjs` 在隔离消费者中校验所选平台包的
  `xpodEmbeddedSource` 路径（必须留在包根内）与存在性，重算 manifest 摘要，并把 archive、
  license、embed docs、docs sha 清单与 NOTICE 逐项对 pin/manifest 契约复核；不信任自报摘要。
- 桌面 `desktop/package.json` 的 `extraResources: runtime` 直接携带平台包的 `SOURCE/`。
- pin 是程序侧构建声明，不引入用户配置；升级 `inngest-cli` 时必须同步 pin 并重新验证。

**§13 网络服务注意**：`EmbeddedInngestService` 默认以 `127.0.0.1` spawn Inngest dev/server，
但真实拓扑中 Xpod 可能位于反向代理/网关之后，cloud 部署使用集群内 Inngest service。不能因
默认监听 loopback 就一概判定 SSPL §13 不适用；任何让第三方直接或经代理/间接与 Inngest
功能交互的部署都需评估提供 Service Source Code。此处只记录事实，不替代当地法律判断。

无证书前提下的**自助更新**由桌面自行实现，不使用 Electron 内置更新器：Squirrel 要求
新 bundle 满足当前构建的 designated requirement，而 ad-hoc 签名的 requirement 就是
一条 `cdhash`，任何其它版本都无法满足。因此发布产物必须经
`desktop/scripts/after-pack-adhoc-sign.cjs` 封成合法 ad-hoc 签名，并用
`desktop/scripts/packaged-update-acceptance.mjs` 跑通“旧包 → 新包自动安装并重启”。
链路、配置与验收证据见 [`docs/desktop-self-update.md`](desktop-self-update.md)。

Linux QLever SDK/runtime 镜像先加载到 CI runner 执行真实冒烟，再由同一个
BuildKit builder 复用热缓存直接推 registry；不要再用 `docker push` 转发 daemon
本地镜像。上传后必须从 immutable registry digest 解析实际 `linux/amd64` manifest，
核对其 config digest 与已测镜像 ID 一致（不能拿 attestation index digest 比较），
才能把 registry digest 交给
后续作业。该检查失败时，已上传的 SHA tag 不构成验收或发布凭证。

## Cloud-managed Local 与 AI Connections 发布契约

服务镜像内容与三种模式的共用规则见 [Xpod 镜像边界](docker-image-boundaries.md)。Cloud / Local / Standalone 的配置差异不产生三套 Xpod 发布镜像。

Account UI、Cloud provisioning、Local SP managed route 和 AI Connections
Gateway Key 不是可以各自热替换的四个独立版本。候选镜像必须从同一个 commit
完整构建，并在同一个镜像中同时包含后端 `dist` 与 `static/app`、
`static/settings` 等前端产物；不得只替换静态文件，也不得只更新 Cloud 后端。

发布前必须检查：

- Cloud 与 managed Local 的身份 card 始终托管在 Cloud，Local 仅保存用户数据。新 card 不产生 Cloud 用户存储 Pod，也不能向身份命名空间上传任意文件；需额外验收一种真实部署条件：Local 从启动时就未配置可达的公网数据路由，但仍有本机私有入口；在此条件下证明 Cloud card 可匿名读取、身份与存储绑定一致、本机私有读写成功。该验收条件不表示禁用 Local 的公网访问能力。旧 node-origin 身份不能静默迁移；此前错误 Local-profile 拓扑的通过记录不得用作发布凭证。

- Account bundle 不再包含原始 `alert(` 错误路径；`fetch failed`、
  `provision_refresh_failed` 等错误只能进入页面内的可恢复状态。
- Cloud `/provision/nodes` 生成的 managed provision code 同时包含
  `signalApiUrl`、`routeAccessToken`、`routeAccessTokenExp`、`nodeId` 和
  canonical `spDomain`。Local `/provision/status` 必须拒绝缺少这些字段的旧
  managed provision code，不能把不可用状态报告为成功。
- 生产数据库已具备当前 managed route schema，至少包括
  `cluster_node.pod_base_urls`、`cluster_node.connectivity_status`、
  `cluster_node.last_connectivity_check`、`cluster_node.capabilities`、
  `cluster_node.metadata` 和 `cluster_service_token`。`CREATE TABLE IF NOT EXISTS`
  不会为旧表自动补列，缺失时必须先运行显式迁移。
- Cloud/RC 的 CSS `AccountStorage` 必须等位替换为
  `LoginMethodGuardStorage(DrizzleIndexedStorage(identityDbUrl))`，保留最后一种登录方法的保护。发布门禁必须确认 `identity_store`
  已创建，并且种子账号、WebID 与 Pod 绑定均写入该表；仅看到
  `BaseLoginAccountStorage`/`internal_kv` 日志不能视为身份数据就绪。依赖
  `identity_store` 的查询不得在存储实现未启用时以重试或“同步中”掩盖配置错误。
- Cloud 注册 managed SP 必须在所选访问路径就绪后才报告成功。存在 managed signal
  route 时不得把首启强制绑定到可选的 Cloudflare Tunnel；仅当实际选择的信令、路由、
  DNS 或 tunnel 配置失败时才阻断注册。不得先持久化“已注册”状态再让 Account 页面在
  创建 Pod 时暴露 `fetch failed`；RC 日志中出现所选路径的注册失败必须直接阻断候选版本。
- 本版本已移除 Gateway API Key（`xpod_gw_v1_*`）与为它服务的 locator 密钥
  `XPOD_GATEWAY_LOCATOR_SECRET`：不再有代码签发这类 Key，也不再从 Key 反解 owner 去
  Pod 里校验。任何环境都不需要、也不应再配置该变量；发布门禁不得把它列为必需项，
  配置里残留它不会启用任何功能。存量 `xpod_gw_v1_*` Key 立即全部失效（401），
  只能改用调用者自己的凭据。AI-Connections 的 invocation token
  （`xpod_inv_v1.*`）不在此次移除范围内，短期推理授权行为保持不变。

RC 验收顺序固定为：验证静态 bundle 与 deployed digest → 用同一个 accepted image
启动一次性 Local edition 并注册到 RC Cloud（不得把 Cloud deployment 的端口转发冒充
Local）→ 注册 Cloud 身份并通过 Account profile control 准备独立 Cloud card → 将同一 Cloud WebID 传入 Local prepare，Cloud 核验回执并 finalize Account/storage 绑定 → 从 canonical Pod URL 命中本地最优路径完成
读写 → 用调用者自己的 Solid 凭据换取 AI-Connections invocation token 调用
`/v1/models` → 发出真实 `/v1/chat/completions` 并校验有效内容 → 撤销该调用者凭据并删除 Pod 记录，
验证同一个 invocation token、以及缺失凭据的请求均被拒绝（401）。任一层失败都不得
用下一层或隔离测试的结果替代。

## 操作命令

创建 release branch：

```bash
git switch -c release/0.4.0
git push -u origin release/0.4.0
```

正常修复继续推送普通 commit。每个 commit 会产生新的 immutable 服务镜像、原生
runtime 和桌面候选；失败候选保留为失败证据，不覆盖既有版本。RC 不发布 npm 包，
npm 只在 accepted commit 的 stable tag workflow 中发布。

接受某个 RC 后，在 exact commit 上打 stable tag：

```bash
git tag -s v0.4.0 <accepted-sha>
git push origin v0.4.0
```

不要在未通过 RC 的 commit 上打 tag。不要手动输入 digest 给 release
workflow；stable promotion 只能使用 acceptance artifact 里的 accepted
digest。

## RC 验收凭证

RC 成功后必须存在 artifact name `release-acceptance-${GITHUB_SHA}`，
且其中必须包含 artifact 内文件 `release-acceptance.json`。
stable promotion 校验以下内容：

- stable tag 是 `vX.Y.Z`，且 tag commit 是 workflow source SHA；
- tag commit 属于 `release/<version>`；
- tag commit 的 `package.json` version 等于 stable version；
- artifact 的 source SHA、source branch、target version、candidate version
  和 endpoint 与当前 tag 匹配；
- image digest 是 `sha256:<64-lowercase-hex>`；
- required checks 全部通过，包括 `image`、`service-status`、`oidc`、
  `dashboard`、`protected-route`、
  `deployed-digest`、`direct-pod`、`public-service`、`secret-isolation`、
  `authenticated-pod`、`pod-read-write`、`gateway-key`、`ai-connections`、
  `models`、`chat`、`task-approval`、`qlever-local`、`package-consumers` 和 `desktop`。

`deployed-digest` 证明 RC Deployment 运行的是 accepted digest，
`direct-pod` 证明 ready Pod 的 imageID 包含同一个 digest。stable tag 只做
exact digest promotion，不重建镜像。

## 失败诊断和恢复

RC 失败时，先看 workflow 的 `Dump diagnostics` 输出。它会收集
deployment、replicaset、pod、service、describe 和当前/previous logs，不会
读取 Secret 内容。

常见硬 blocker：

- GitHub Environment `rc` 不存在或 secret/var 缺失；
- `id-rc`、`pods-rc` 或 `api-rc.undefineds.cn` DNS/Ingress 未指向统一 Gateway；
- RC `APP_ENV_FILE` 复用了生产 domain、database、bucket、Redis DB 0 或凭据；
- logical database or schema、nonzero Redis DB index、object bucket 权限未创建；
- `XPOD_RC_SEED_CONFIG` 缺失、不是 seed account 数组，或没有 Alice/Bob 账号；
- seed Alice/Bob 无法完成浏览器 OIDC 登录，或一次性 provider canary 验收失败。

修复方式是提交新的 release branch commit，让 candidate workflow 产生新的
RC。不要删除 stable tag 重新试，也不要把失败 digest 手工推进生产。

candidate workflow 的 `cleanup_rc` 在服务、真实桌面和最终验收全部结束后无条件执行
scale-to-zero；即使前序验收失败，也只回收本轮持有的 `deployment/xpod-rc`、
存在时的 `deployment/xpod-rc-inngest` 和本轮 seed Secret。共享
`statefulset/xpod-rdf-postgres` 与 `deployment/xpod-inngest` 保持运行。
整个 workflow 通过跨 release 分支的共享锁串行化，防止桌面或最终验收时被下一轮重置。
下一次 RC workflow 会重新 apply overlay、写入 Secret、设置 digest 并等待 rollout。
手动恢复 RC 时可在同一 namespace 将 Xpod Deployment scale 到 1，然后重新
运行 candidate workflow 做完整验收。

## 生产提升和回滚

stable release workflow 在 promotion guard 通过后执行三件事：

仓库 secret `NPM_TOKEN` 只供 stable release workflow 使用，必须对
`@undefineds.co` scope 具有 read/write 权限，且能首次创建版本所需的平台包。

1. 从 accepted RC run 下载同一个 QLever runtime artifact，将 exact stable
   根包和原生包发布到 `stable-staging`；Node/Bun 公网安装和真实 Local conformance
   全部通过后，才把两个包的 npm `latest` 指向目标版本。
2. 使用 `docker buildx imagetools create` 将 accepted digest 标记为
   `ghcr.io/undefinedsco/xpod:<version>` 和 `ghcr.io/undefinedsco/xpod:latest`，
   不重新构建镜像。
3. 调用 `.github/workflows/deploy.yml`，以
   `ghcr.io/undefinedsco/xpod@sha256:<64-hex>` 的 digest 形式部署生产。

生产 deploy workflow 要求输入 stable SemVer、immutable image digest 和
目标 environment。它会读取目标环境的实际 `Deployment` manifest，按目标
镜像 repository 选出唯一的 service container（`.co` 为 `xpod-co`，`.cn`
为 `xpod`），先捕获该容器的 previous image，再仅对该容器执行 `set image`
提升到请求 digest。service container 由已部署 manifest 推导，不硬编码、
不改名；缺失、歧义或 malformed 时显式失败，普通 sidecar 不受影响。正式
发布不 apply runtime Secret、ConfigMap 或通用 Cloud manifests；现有启动
参数、环境变量、initContainers 和挂载属于环境部署流程，不由镜像提升覆盖。
这也保证 QLever 等已安装的运行配置在 stable 发布后保持不变。
首次部署或配置变更必须由该环境的部署流程单独应用并验收，再进行镜像提升；
此 workflow 要求生产 Deployment 已存在，不承担集群初始化。
公开健康、OIDC、dashboard、settings 401、Kubernetes Deployment image、
ready Pod imageID 和 direct pod health 全部通过后才算部署成功。

如果生产 rollout 或健康门禁失败，workflow 会 rollback 到捕获的 previous
image 并等待 readiness，然后输出 diagnostics。回滚不是新发布；需要修复时
继续在 `release/<version>` 上提交新 commit，重新走 RC 和 stable tag。

## 共享包版本复用与 provenance

同一共享包版本（例如 `@undefineds.co/solid-sdk@0.1.4`）一旦发布即不可变，
stable promotion 不得覆写它。`scripts/publish-workspace-packages.cjs` 对已存在的
版本执行只读复用校验：从 registry 下载该版本的精确 tarball，先按
`dist.integrity` 校验原始字节，再逐项比较完整载荷——成员文件名、类型、权限位、
内容以及 manifest 语义字段——仅显式排除 provenance 字段 `gitHead`。内容一致
（只有 `gitHead` 不同）时，直接复用该已验证的已发布 tarball，不再重新发布。

必须区分两个 SHA：

- **accepted root SHA**：本轮 candidate 验收的 exact commit（`github.sha`），
  也是 `npm pack` 注入到 `gitHead` 的值；
- **shared artifact original gitHead**：该共享包版本最初发布时的 commit。

用一个新的 accepted root SHA 重跑时，`gitHead` 必然变化，所以重新打包的 tarball
字节不可能与已发布版本逐字节相同；这不是内容漂移。只要该版本的运行时、类型、
CSS、文件集合、权限位与 manifest 语义字段都未变、仅 `gitHead` 不同，就判定为可
复用并沿用已发布字节，而不是重新发布。若除 `gitHead` 外任何内容、成员集合、
权限或 manifest 语义字段（`name`、`version`、`types`、`exports`、`dependencies`、
`peerDependencies`、`optionalDependencies`、`devDependencies` 等）发生变化，或
tarball 损坏、integrity 不匹配、出现重复成员、路径穿越、链接或不受支持的条目
类型，复用校验会 fail closed 并提示提升共享包版本，绝不覆写既有版本。新版本仍
发布 packed tarball，并把发布后的 `dist.integrity` 绑定回 packed 文件的 sha512。

`rc_prerequisites` 在 `bun install --frozen-lockfile` 与 `bun run build:packages`
之后、任何 artifact job 之前运行只读 preflight
`node scripts/publish-workspace-packages.cjs --verify-only`（`XPOD_ACCEPTED_SHA`
为 `github.sha`）：它执行复用、原始完整性与载荷校验，并对精确的混合 tarball
（已存在版本用已验证的已发布字节，新版本用打包字节）运行 clean consumer 检查，
但不发布、不移动 `latest`。没有新版本时该 preflight 不产生任何 registry 副作用。

## 构建耗时与缓存

RC 里最重的一环是 `build_qlever_macos_runtime`（macOS ARM64 原生运行时）。
它用 ccache 做了增量：构建步实测 **23.1 分钟（冷）→ 1.5 分钟（暖）**，暖启动
631 次编译命中 630 次（99.8%，只有 1 次新增未命中），签名的 smoke 验收照常通过。
缓存体积只有约 0.1 GiB，恢复代价可忽略。

**GitHub 的缓存在分支间是隔离的**：一个 run 只能恢复自己分支的缓存和默认分支
（main）的缓存，永远读不到别的分支的。因此只在 `release/*` 上跑这个 workflow
时，每条新的 release 分支第一次都是全量冷编译。workflow 已经在 main 上按
`qlever/**` 路径触发来"预热"默认分支缓存，新 release 分支才会一上来就是暖的。
改 QLever 版本或构建脚本会让缓存键轮换，这是有意的：键只决定恢复哪个压缩包，
能不能用由 ccache 自己重新哈希编译器和源码决定，恢复错了最多是一次 miss，
不会产出错误二进制。

`publish_qlever_runtime_sdk` 与 `publish_qlever_local_runtime` 另有 BuildKit
GHA 缓存（scope `qlever-runtime-sdk`）和"复用已有 SDK 镜像"两条增量路径。缓存
暖态下整个 job 约 4 分钟；但**缓存是分支隔离的**，而这条 workflow 只在
`release/*`（或 `workflow_dispatch`）上跑，所以新建 release 分支的第一次仍然是
冷编译（实测 37.5 分钟）。

因此 SDK 侧靠的是**按构建输入复用**，而不是预热缓存：

- SDK 镜像除了不可变的 `sha-<commit>`，还会打一个按 QLever 构建输入命名的别名
  `qlever-inputs-<hash12>`（hash 取自该 commit 的 `qlever/` 与
  `docker/qlever-runtime-sdk/` 两棵树）；
- 同一批输入已经构建过时，新的 RC 直接复用该镜像（0 构建分钟）；输入变了才全量
  编译。这个别名是**追加式**的：已存在的名字不会被覆盖，digest 不一致只记进
  summary；
- 复用路径同样要过镜像 smoke（与新建路径相同的 `docker run` 检查），
  `resolve-runtime-sdk-build.sh` 里 `reuse_identical_inputs=false` 可强制重建。

即：只要这一版没有改 `qlever/**` 或 SDK Dockerfile，RC 就不会再花那 36–39 分钟。

**并行度按机器实测决定，不再手写**：

| 作业 | runner | 实测 | 并行度 |
|---|---|---|---|
| `build_qlever_macos_runtime` | `macos-15-arm64` | `cpus=3`、内存 7 GiB | 推导为 3（= 每 2 GiB 一个作业的上限，也是核数）；值由 `Resolve build parallelism` 步骤算出并打进日志 |
| `publish_qlever_runtime_sdk` | `ubuntu-24.04` | BuildKit 日志 `CPUs: 4` | 4（与 Dockerfile 默认值一致；此前 workflow 把它覆盖成 2，只用了一半机器） |

macOS 那条原先硬编码 3——实测证明这台机器**本来就没有欠并行**，改成推导是为了
让更大的 runner 不被静默浪费，并把依据写进日志。SDK 那条则是真的只用了一半。

SDK 冷编译（BuildKit 无缓存）的实测对比——同一镜像、同一 runner，只差并行度：

| 运行 | 并行度 | persist 步 | Job 合计 |
|---|---|---|---|
| `35493311659`（0.4.12 首个 RC） | 2 | 36.7 min | 39.3 min |
| `35508765168` | 4 | 33.7 min | 36.4 min |

即约 **8%**，不是翻倍：那一步里 apt 安装、取源、cmake configure 也占时间，编译并非
唯一瓶颈；稳态成本看暖缓存（同分支重跑 persist 步 0～0.1 min、整个 job 3～4 min）。
**身份不受影响**：`-j4` 构建出的镜像与 `-j2` 版（RC）的 `.xpod-build-identity` 与
`.xpod-build-contract.json` **逐字节相同**（contract 只记录基础镜像、cmake 开关与
工具链版本，本来就不含并行度）。

## 本地验证

发布相关改动提交前至少运行：

```bash
bun run test -- \
  tests/scripts/release-candidate.test.ts \
  tests/scripts/release-acceptance-manifest.test.ts \
  tests/scripts/render-rc-manifests.test.ts \
  tests/scripts/rc-deployment-manifest.test.ts \
  tests/scripts/candidate-workflow.test.ts \
  tests/scripts/release-promotion-workflow.test.ts \
  tests/scripts/deploy-workflow-health-gate.test.ts \
  tests/scripts/production-diagnostics-workflow.test.ts \
  tests/scripts/release-docs.test.ts \
  tests/scripts/prepare-rc-authenticated-smoke.test.ts
bunx github-actionlint .github/workflows/build-qlever-macos-runtime.yml .github/workflows/candidate.yml .github/workflows/release.yml .github/workflows/deploy.yml
bun run build:ts
bun run test:integration
```

`bun run test:integration` 会运行 lite 和 full 集成链路。若 Docker、数据库或
本机网络权限缺失，记录真实失败输出；不要把未运行的集成测试写成通过。
