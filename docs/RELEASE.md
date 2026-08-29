# 发布流程

Xpod 发布必须先经过 Release Candidate，再由 stable tag 提升同一个 commit
和同一个容器 digest。不要用 stable tag 调试发布问题；修复必须继续提交到
`release/<version>`，由新的 RC 重新验收。

## 生命周期总览

1. 从准备发布的 commit 创建 `release/<version>` 分支，例如
   `release/0.3.68`。
2. 每个推送到 `release/<version>` 的 commit 都触发
   `.github/workflows/candidate.yml`，生成一个新的 RC。
3. RC 不发布 npm，只生成服务候选版本标识。首次运行格式为 `0.3.68-rc.<run-number>`；rerun 格式为 `0.3.68-rc.<run-number>.<run-attempt>`。例如 `0.3.68-rc.41`，rerun 示例为 `0.3.68-rc.41.2`。
4. 同一次 RC workflow 构建一个 GHCR 镜像，打 `sha-<full-sha>` 和 RC
   版本 tag，并记录 canonical digest，例如
   `ghcr.io/undefinedsco/xpod@sha256:<64-hex>`。
5. RC workflow 将该 digest 部署到 `https://id-rc.undefineds.co` 并运行公开
   和认证验收。
6. 验收成功后上传 acceptance artifact：artifact name 是 `release-acceptance-${GITHUB_SHA}`，artifact 内文件是 `release-acceptance.json`。该 artifact 是 stable tag promotion 的唯一凭证。
7. 只在接受的 exact commit 上创建 stable tag，例如 `v0.3.68`。
8. `.github/workflows/release.yml` 下载 exact commit 对应的 acceptance
   artifact，校验 stable tag、release branch、required
   checks 和 accepted digest 后，才发布 npm `latest`、把 accepted digest
   重新标记为 stable/latest 容器 tag，并调用生产部署。

## 一次性 RC 环境

GitHub 需要配置独立的 GitHub Environment `rc`：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `KUBE_CONFIG_DATA` | base64 编码的 CO Sealos kubeconfig，使用 Sealos 分配的固定 namespace |
| Secret | `APP_ENV_FILE` | RC runtime env 文件内容 |
| Secret | `XPOD_RC_SEED_CONFIG` | 固定 RC seed JSON，必须包含 Alice 和 Bob 账号及 Pod 名称 |
| Secret | `XPOD_LIVE_PROVIDER_API_KEY_CONFIG` | 真实 AI Provider 验收配置，格式同 `scripts/live-provider-api-key.example`；用于证明 `/v1/chat/completions` 真可用 |
| Secret | `XPOD_AI_PROXY_URL` | 可选，真实 AI Provider 验收需要代理时填写 |
| Variable | `SEALOS_NAMESPACE` | 必填变量，填写 kubeconfig 的固定 namespace，例如 `ns-1yl0rye9` |
| Variable | `XPOD_RUNTIME_SECRET_NAME` | 必填变量，推荐值 `xpod-rc-secret` |
| Variable | `XPOD_RC_SCALE_TO_ZERO` | 设为 `true` 时验收后执行 scale-to-zero |
| Variable | `XPOD_INSTALL_REGISTRY` | 可选，安装烟测 registry 覆盖 |

RC 公开入口为 `https://id-rc.undefineds.co`、`https://pods-rc.undefineds.co`
和 `https://api-rc.undefineds.co`。`*.undefineds.co` DNS-only CNAME 统一指向
Sealos ingress，三个 Ingress 经统一 Nginx Gateway 路由到 RC 服务；TLS Secret
由 Sealos certificate controller 在 Ingress 创建后签发。overlay 不创建
physical PostgreSQL、Redis、object storage 或独立 Kubernetes cluster；它复用现有物理基础设施，
但必须使用独立 logical database or schema、独立 Redis DB 和独立 object bucket。

推荐的 RC Kubernetes 资源拓扑：

- runtime Secret：`xpod-rc-secret`
- Xpod Deployment：`xpod-rc`
- shared Inngest Deployment：`xpod-inngest`（只复用，不由 RC overlay 创建或缩容）
- ConfigMap：`xpod-rc-config`
- seed Secret：`xpod-rc-seed`

`XPOD_RC_SEED_CONFIG` 使用与 `CSS_SEED_CONFIG` 相同的 seed account JSON
数组格式，至少包含可密码登录的 Alice 和 Bob 账号，并分别声明 Alice/Bob 的
Pod 名称。candidate workflow 会把该 secret 写入 Kubernetes Secret
`xpod-rc-seed`，并把 Xpod 容器的 `CSS_SEED_CONFIG=/app/config/seeds/rc.json`
固定到只读挂载文件。RC 启动后由 CSS seed initializer 创建账号和 Pod。
认证验收随后通过真实浏览器 OIDC 流程登录 seed Alice/Bob，生成两份 Playwright
storage state。候选环境只消费这两份会话，对已经部署的 RC 执行登录恢复、AI
Connections、Pod、Network、Status 的桌面/窄屏 smoke，并从账号卡实际解析
`data-selected-pod-url`：两名用户的 Pod 必须不同，且都必须位于由 RC Cloud
分配的 `*.pods-rc.undefineds.co` 协议域名。该阶段不得再启动第二套本地 Xpod。
完整的 provider 写入、Pod 读写、Gateway Key、Models 和真实 Chat 由紧随其后的
一次性 Local runtime 对同一 RC Cloud 执行；本地 hermetic Playwright 仍作为发布前
回归单独运行，不冒充部署环境证据。

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
不读取这些变量。RC 对象存储由 overlay 内置的独立 MinIO、PVC 和 Kubernetes
Secret 提供；隔离由 nonzero Redis DB index、数据库/schema principal 和独立
对象存储共同完成。

## Cloud-managed Local 与 AI Connections 发布契约

服务镜像内容与三种模式的共用规则见 [Xpod 镜像边界](docker-image-boundaries.md)。Cloud / Local / Standalone 的配置差异不产生三套 Xpod 发布镜像。

Account UI、Cloud provisioning、Local SP managed route 和 AI Connections
Gateway Key 不是可以各自热替换的四个独立版本。候选镜像必须从同一个 commit
完整构建，并在同一个镜像中同时包含后端 `dist` 与 `static/app`、
`static/settings` 等前端产物；不得只替换静态文件，也不得只更新 Cloud 后端。

发布前必须检查：

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
  `DrizzleIndexedStorage(identityDbUrl)`。发布门禁必须确认 `identity_store`
  已创建，并且种子账号、WebID 与 Pod 绑定均写入该表；仅看到
  `BaseLoginAccountStorage`/`internal_kv` 日志不能视为身份数据就绪。依赖
  `identity_store` 的查询不得在存储实现未启用时以重试或“同步中”掩盖配置错误。
- Cloud 注册 managed SP 必须在所选访问路径就绪后才报告成功。存在 managed signal
  route 时不得把首启强制绑定到可选的 Cloudflare Tunnel；仅当实际选择的信令、路由、
  DNS 或 tunnel 配置失败时才阻断注册。不得先持久化“已注册”状态再让 Account 页面在
  创建 Pod 时暴露 `fetch failed`；RC 日志中出现所选路径的注册失败必须直接阻断候选版本。
- 若候选版本包含 Gateway API Key，Cloud/RC 必须提供各副本共享的稳定
  `XPOD_GATEWAY_LOCATOR_SECRET`。Local/Standalone 默认从 SQLite 身份库目录
  派生私有文件 `.xpod/secrets/gateway-locator-secret`，随实例数据卷保留，
  不要求用户另配环境变量；显式配置仍优先。不得依赖进程随机值、临时
  Gateway ingress secret 或会轮换的服务访问 token，否则重启后历史 Key 的 locator
  无法解码，列表、reveal、停用和删除会出现不一致。验收必须在重建容器后
  用同一个 Web 创建的 Key 重验复制、模型列表和 Chat，而不只是复用存活进程。

RC 验收顺序固定为：验证静态 bundle 与 deployed digest → 用同一个 accepted image
启动一次性 Local edition 并注册到 RC Cloud（不得把 Cloud deployment 的端口转发冒充
Local）→ 注册 Cloud 身份 → 由 Cloud 为该 Local SP 创建 Pod → 从 canonical Pod URL 命中本地最优路径完成
读写 → 用 Solid Session 创建/list/reveal Xpod Gateway API Key → 使用该 Key 调用
`/v1/models` → 发出真实 `/v1/chat/completions` 并校验有效内容。任一层失败都不得
用下一层或隔离测试的结果替代。

## 操作命令

创建 release branch：

```bash
git switch -c release/0.3.68
git push -u origin release/0.3.68
```

正常修复继续推送普通 commit。每个 commit 都只构建并部署新的服务 RC，不会
创建 npm 版本或移动任何 npm dist-tag。

接受某个 RC 后，在 exact commit 上打 stable tag：

```bash
git tag -s v0.3.68 <accepted-sha>
git push origin v0.3.68
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
  `models` 和 `chat`。

`deployed-digest` 证明 RC Deployment 运行的是 accepted digest，
`direct-pod` 证明 ready Pod 的 imageID 包含同一个 digest。stable tag 只做
exact digest promotion，不重建镜像。

## 失败诊断和恢复

RC 失败时，先看 workflow 的 `Dump diagnostics` 输出。它会收集
deployment、replicaset、pod、service、describe 和当前/previous logs，不会
读取 Secret 内容。

常见硬 blocker：

- GitHub Environment `rc` 不存在或 secret/var 缺失；
- `id-rc`、`pods-rc` 或 `api-rc.undefineds.co` DNS/Ingress 未指向统一 Gateway；
- RC `APP_ENV_FILE` 复用了生产 domain、database、bucket、Redis DB 0 或凭据；
- logical database or schema、nonzero Redis DB index、object bucket 权限未创建；
- `XPOD_RC_SEED_CONFIG` 缺失、不是 seed account 数组，或没有 Alice/Bob 账号；
- seed Alice/Bob 无法完成浏览器 OIDC 登录，或一次性 provider canary 验收失败。

修复方式是提交新的 release branch commit，让 candidate workflow 产生新的
RC。不要删除 stable tag 重新试，也不要把失败 digest 手工推进生产。

如果 `XPOD_RC_SCALE_TO_ZERO=true`，candidate workflow 最后会把
`deployment/xpod-rc` scale-to-zero；共享 `deployment/xpod-inngest` 保持运行。
下一次 RC workflow 会重新 apply overlay、写入 Secret、设置 digest 并等待 rollout。
手动恢复 RC 时可在同一 namespace 将 Xpod Deployment scale 到 1，然后重新
运行 candidate workflow 做完整验收。

## 生产提升和回滚

stable release workflow 在 promotion guard 通过后执行三件事：

1. 从 exact commit 构建、验证并发布 npm stable version；这是发布流程中
   第一次触碰 npm。如果该版本已存在，会先验证 registry 中的版本号并保证
   npm `latest` 指向目标版本。
2. 使用 `docker buildx imagetools create` 将 accepted digest 标记为
   `ghcr.io/undefinedsco/xpod:<version>` 和 `ghcr.io/undefinedsco/xpod:latest`，
   不重新构建镜像。
3. 调用 `.github/workflows/deploy.yml`，以
   `ghcr.io/undefinedsco/xpod@sha256:<64-hex>` 的 digest 形式部署生产。

生产 deploy workflow 要求输入 stable SemVer、immutable image digest 和
目标 environment。它会先捕获当前 `deployment/xpod-cloud` 的 previous
image，apply runtime Secret 和 manifests，再 `set image` 到请求 digest。
公开健康、OIDC、dashboard、settings 401、Kubernetes Deployment image、
ready Pod imageID 和 direct pod health 全部通过后才算部署成功。

如果生产 rollout 或健康门禁失败，workflow 会 rollback 到捕获的 previous
image 并等待 readiness，然后输出 diagnostics。回滚不是新发布；需要修复时
继续在 `release/<version>` 上提交新 commit，重新走 RC 和 stable tag。

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
bunx github-actionlint .github/workflows/candidate.yml .github/workflows/release.yml .github/workflows/deploy.yml
bun run build:ts
bun run test:integration
```

`bun run test:integration` 会运行 lite 和 full 集成链路。若 Docker、数据库或
本机网络权限缺失，记录真实失败输出；不要把未运行的集成测试写成通过。
