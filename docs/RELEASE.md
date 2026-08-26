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
4. 同一次 RC workflow 先复用当前 QLever SDK/local runtime reusable jobs，
   再构建一个 GHCR server 镜像，打 `sha-<full-sha>` 和 RC
   版本 tag，并记录 canonical digest，例如
   `ghcr.io/undefinedsco/xpod@sha256:<64-hex>`。
5. RC workflow 将该 digest 部署到 `https://id-rc.undefineds.co` 并运行公开
   和认证验收。
6. 验收成功后上传 acceptance artifact：artifact name 是 `release-acceptance-${GITHUB_SHA}`，artifact 内文件是 `release-acceptance.json`。该 artifact 是 stable tag promotion 的唯一凭证。
7. 只在接受的 exact commit 上创建 stable tag，例如 `v0.3.68`。
8. `.github/workflows/release.yml` 下载 exact commit 对应的 acceptance
   artifact，校验 stable tag、release branch、source SHA 和 accepted Xpod
   digest 后，才发布 npm `latest`，并把 accepted digest 重新标记为
   stable/latest 容器 tag。它不自动部署生产。

## 一次性 RC 环境

GitHub 需要配置独立的 GitHub Environment `rc`：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `KUBE_CONFIG_DATA` | CO Sealos 原始 kubeconfig（多行 YAML），使用 Sealos 分配的固定 namespace |
| Secret | `APP_ENV_FILE` | RC runtime env 文件内容 |
| Secret | `XPOD_RC_SEED_CONFIG` | 固定 RC seed JSON，必须包含 Alice 和 Bob 账号及 Pod 名称 |
| Variable | `XPOD_RUNTIME_SECRET_NAME` | 必填变量，推荐值 `xpod-rc-secret` |
| Variable | `XPOD_RC_SCALE_TO_ZERO` | 设为 `true` 时验收后执行 scale-to-zero |
| Variable | `XPOD_INSTALL_REGISTRY` | 可选，安装烟测 registry 覆盖 |

部署 namespace 直接取自 kubeconfig 当前 context，不再单独维护 `SEALOS_NAMESPACE` 变量。

RC 公开入口为 `https://id-rc.undefineds.co`、`https://pods-rc.undefineds.co`
和 `https://api-rc.undefineds.co`。`*.undefineds.co` DNS-only CNAME 统一指向
Sealos ingress，三个 Ingress 经统一 Nginx Gateway 路由到 RC 服务；TLS Secret
由 Sealos certificate controller 在 Ingress 创建后签发。overlay 不创建
physical PostgreSQL、Redis、object storage 或独立 Kubernetes cluster；它复用现有物理基础设施，
但必须使用独立 logical database or schema、独立 Redis DB 和独立 object bucket。
RC 的 Inngest worker 不共享生产 Deployment；overlay 会创建独立的
`xpod-rc-inngest`，只读取 RC Secret 并回调 `xpod-rc`。

推荐的 RC Kubernetes 资源拓扑：

- runtime Secret：`xpod-rc-secret`
- Xpod Deployment：`xpod-rc`
- Inngest Deployment / Service：`xpod-rc-inngest`
- ConfigMap：`xpod-rc-config`
- seed Secret：`xpod-rc-seed`

`XPOD_RC_SEED_CONFIG` 使用与 `CSS_SEED_CONFIG` 相同的 seed account JSON
数组格式，至少包含可密码登录的 Alice 和 Bob 账号，并分别声明 Alice/Bob 的
Pod 名称。candidate workflow 会把该 secret 写入 Kubernetes Secret
`xpod-rc-seed`，并把 Xpod 容器的 `CSS_SEED_CONFIG=/app/config/seeds/rc.json`
固定到只读挂载文件。RC 启动后由 CSS seed initializer 创建账号和 Pod。
认证验收随后通过真实浏览器 OIDC 流程登录 seed Alice/Bob，生成 Playwright
storage state、Alice Pod URL 和一次性 provider API-key canary，再运行真实 settings
验收。浏览器设置页必须使用自己的 Solid Session 和 drizzle-solid 直接读写 Alice
的 Pod；验收也使用 Alice/Bob 各自的浏览器 Session 直接检查 Pod，证明 Alice 保存
后的 provider 数量增加、Bob 的独立 Pod 数量不变，并锁定 `credential.apiKey` 的
明文 RDF 序列化。Xpod API 不代替浏览器读取设置，不接收浏览器的 Pod authority，
产品 UI/API 不回显 canary，也不创建或遗留额外 Solid Client Credentials。

这些值必须由 RC seed 自动生成，不能作为 GitHub secret/variable 手工维护：

- 不要配置 `XPOD_SETTINGS_E2E_ALICE_STATE`
- 不要配置 `XPOD_SETTINGS_E2E_BOB_STATE`
- 不要配置 `XPOD_SETTINGS_E2E_TEST_API_KEY`

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
不读取这些变量。RC 对象存储使用独立 bucket（当前要求 `xpod-rc`），candidate
workflow 会先验证 R2 访问能力，并清理历史 overlay 里的临时 MinIO 资源。隔离由
nonzero Redis DB index、数据库/schema principal 和独立对象存储共同完成。

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
- artifact 是 schema v2，`sourceRef` 等于当前 tag SHA；
- `xpodImageDigest` 是 `ghcr.io/undefinedsco/xpod@sha256:<64-lowercase-hex>`；
- public application acceptance 不包含 PostgreSQL digest；private workflow
  复用同一 helper 时必须用 `--require-postgres-image` 和
  `--postgres-image-digest` 强制校验 PG artifact。

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
`deployment/xpod-rc` 和 `deployment/xpod-rc-inngest` 一起 scale-to-zero；生产
`deployment/xpod-inngest` 不会被 RC workflow 读取或修改。
下一次 RC workflow 会重新 apply overlay、写入 Secret、设置 digest 并等待 rollout。
手动恢复 RC 时可在同一 namespace 将 Xpod Deployment scale 到 1，然后重新
运行 candidate workflow 做完整验收。

## Artifact Promotion

stable release workflow 在 promotion guard 通过后执行三件事：

1. 从 exact commit 构建、验证并发布 npm stable version；这是发布流程中
   第一次触碰 npm。如果该版本已存在，会先验证 registry 中的版本号并保证
   npm `latest` 指向目标版本。
2. 使用 `docker buildx imagetools create` 将 accepted digest 标记为
   `ghcr.io/undefinedsco/xpod:<version>` 和 `ghcr.io/undefinedsco/xpod:latest`，
   不重新构建镜像。
3. 创建或更新 GitHub Release，记录 promoted digest。

生产部署是单独的外部变更边界。公开仓库的 `.github/workflows/deploy.yml`
只保留 `.cn` 非 enterprise 的手动 digest recovery 入口，要求输入 stable
SemVer 和 immutable image digest。`.co` 生产由 private enterprise workflow
接管，因为它需要 enterprise 配置和 PostgreSQL/QLever artifact 验收，公开
workflow 不能覆盖 `.co`。

`.cn` 手动 deploy 会先捕获当前 `deployment/xpod-cloud` 的 previous image，
并要求目标 stable tag 的 `Release` workflow 成功，再下载 exact SHA 的 RC
acceptance artifact，校验输入 digest 与 `xpodImageDigest` 完全一致。随后才会
apply runtime Secret 和 manifests，再 `set image` 到请求 digest。公开健康、
OIDC、dashboard、settings 401、Kubernetes Deployment image 和 ready Pod
imageID 全部通过后才算部署成功。失败时 workflow 会 rollback 到 previous
image 并输出 diagnostics。

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
  tests/scripts/prepare-rc-authenticated-smoke.test.ts \
  tests/scripts/verify-rc-r2-access.test.ts
bunx github-actionlint .github/workflows/candidate.yml .github/workflows/release.yml .github/workflows/deploy.yml
bun run build:ts
bun run build:components
bun run test:qlever:acceptance
bun run test:integration
```

`bun run test:integration` 会运行 lite 和 full 集成链路。若 Docker、数据库或
本机网络权限缺失，记录真实失败输出；不要把未运行的集成测试写成通过。
