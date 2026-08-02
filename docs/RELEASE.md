# 发布流程

Xpod 发布必须先经过 Release Candidate，再由 stable tag 提升同一个 commit
和同一个容器 digest。不要用 stable tag 调试发布问题；修复必须继续提交到
`release/<version>`，由新的 RC 重新验收。

## 生命周期总览

1. 从准备发布的 commit 创建 `release/<version>` 分支，例如
   `release/0.3.68`。
2. 每个推送到 `release/<version>` 的 commit 都触发
   `.github/workflows/candidate.yml`，生成一个新的 RC。
3. RC workflow 会发布 `@undefineds.co/xpod` 到 npm `next`。首次运行格式为 `0.3.68-rc.<run-number>`；rerun 格式为 `0.3.68-rc.<run-number>.<run-attempt>`。例如 `0.3.68-rc.41`，rerun 示例为 `0.3.68-rc.41.2`。RC 不发布平台子包，也不移动 npm `latest`。
4. 同一次 RC workflow 构建一个 GHCR 镜像，打 `sha-<full-sha>` 和 RC
   版本 tag，并记录 canonical digest，例如
   `ghcr.io/undefinedsco/xpod@sha256:<64-hex>`。
5. RC workflow 将该 digest 部署到 `https://rc.id.undefineds.co` 并运行公开
   和认证验收。
6. 验收成功后上传 acceptance artifact：artifact name 是 `release-acceptance-${GITHUB_SHA}`，artifact 内文件是 `release-acceptance.json`。该 artifact 是 stable tag promotion 的唯一凭证。
7. 只在接受的 exact commit 上创建 stable tag，例如 `v0.3.68`。
8. `.github/workflows/release.yml` 下载 exact commit 对应的 acceptance
   artifact，校验 stable tag、release branch、npm version、required
   checks 和 accepted digest 后，才发布 npm `latest`、把 accepted digest
   重新标记为 stable/latest 容器 tag，并调用生产部署。

## 一次性 RC 环境

GitHub 需要配置独立的 GitHub Environment `rc`：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `KUBE_CONFIG_DATA` | base64 编码的 kubeconfig，只授予 RC namespace 所需权限 |
| Secret | `APP_ENV_FILE` | RC runtime env 文件内容 |
| Secret | `XPOD_SETTINGS_E2E_ALICE_STATE` | RC 认证验收的 Alice OIDC state |
| Secret | `XPOD_SETTINGS_E2E_BOB_STATE` | RC 认证验收的 Bob OIDC state |
| Secret | `XPOD_SETTINGS_E2E_TEST_API_KEY` | RC 认证验收 API key |
| Variable | `SEALOS_NAMESPACE` | 必填变量，推荐值 `xpod-rc` |
| Variable | `XPOD_RUNTIME_SECRET_NAME` | 必填变量，推荐值 `xpod-rc-secret` |
| Variable | `XPOD_RC_SCALE_TO_ZERO` | 设为 `true` 时验收后执行 scale-to-zero |
| Variable | `XPOD_SETTINGS_E2E_ALICE_POD_URL` | Alice 的 RC Pod URL |
| Variable | `XPOD_INSTALL_REGISTRY` | 可选，安装烟测 registry 覆盖 |

RC 公开入口固定为 `https://rc.id.undefineds.co`，DNS 和 Ingress 必须将该
域名路由到 RC 服务。RC overlay 本身不创建 Ingress，不创建 physical PostgreSQL、
Redis、object storage 或独立 Kubernetes cluster；它复用现有物理基础设施，
但必须使用独立 logical database or schema、独立 Redis DB 和独立 object bucket。

推荐的 RC Kubernetes 资源拓扑：

- runtime Secret：`xpod-rc-secret`
- Xpod Deployment：`xpod-rc`
- Inngest Deployment：`xpod-inngest`
- ConfigMap：`xpod-rc-config`

Do not reuse the production `APP_ENV_FILE`。RC `APP_ENV_FILE` 必须提供
独立值，至少包括：

- `CSS_SPARQL_ENDPOINT`
- `CSS_IDENTITY_DB_URL`
- `CSS_REDIS_CLIENT`
- `CSS_MINIO_ENDPOINT`
- `CSS_MINIO_ACCESS_KEY`
- `CSS_MINIO_SECRET_KEY`
- `CSS_MINIO_BUCKET_NAME`
- `XPOD_INNGEST_EVENT_KEY`
- `XPOD_INNGEST_SIGNING_KEY`

候选 workflow 会拒绝生产域名、生产 bucket、生产数据库名称或
`xpod-cloud`/`prod`/`production` 风格值。不要通过 `XPOD_REDIS_PREFIX`
或 `XPOD_OBJECT_PREFIX` 试图隔离 RC；当前代码不读取这些变量，隔离必须由
Redis DB、数据库/schema principal 和 bucket 完成。

## 操作命令

创建 release branch：

```bash
git switch -c release/0.3.68
git push -u origin release/0.3.68
```

正常修复继续推送普通 commit。每个 commit 都发布新的 RC，旧 RC 不需要回滚
npm `next`，因为 npm 版本不可变。

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
- required checks 全部通过，包括 `image`、`npm-node`、`npm-bun`、
  `service-status`、`oidc`、`dashboard`、`protected-route`、
  `deployed-digest`、`direct-pod`、`public-service`、`secret-isolation`、
  `authenticated-pod`。

`deployed-digest` 证明 RC Deployment 运行的是 accepted digest，
`direct-pod` 证明 ready Pod 的 imageID 包含同一个 digest。stable tag 只做
exact digest promotion，不重建镜像。

## 失败诊断和恢复

RC 失败时，先看 workflow 的 `Dump diagnostics` 输出。它会收集
deployment、replicaset、pod、service、describe 和当前/previous logs，不会
读取 Secret 内容。

常见硬 blocker：

- GitHub Environment `rc` 不存在或 secret/var 缺失；
- `rc.id.undefineds.co` DNS/Ingress 未指向 RC；
- RC `APP_ENV_FILE` 复用了生产 domain、database、bucket 或凭据；
- logical database or schema、Redis DB、object bucket 权限未创建；
- 认证验收所需 Alice/Bob state、Alice Pod URL 或 test API key 缺失。

修复方式是提交新的 release branch commit，让 candidate workflow 产生新的
RC。不要删除 stable tag 重新试，也不要把失败 digest 手工推进生产。

如果 `XPOD_RC_SCALE_TO_ZERO=true`，candidate workflow 最后会把
`deployment/xpod-rc` 和 `deployment/xpod-inngest` scale-to-zero。下一次
RC workflow 会重新 apply overlay、写入 Secret、设置 digest 并等待 rollout。
手动恢复 RC 时可在同一 namespace 将两个 Deployment scale 到 1，然后重新
运行 candidate workflow 做完整验收。

## 生产提升和回滚

stable release workflow 在 promotion guard 通过后执行三件事：

1. 从 exact commit 构建并发布 npm stable version；如果该版本已存在，会先
   验证 registry 中的版本号并保证 npm `latest` 指向目标版本。
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
  tests/scripts/release-docs.test.ts
bunx github-actionlint .github/workflows/candidate.yml .github/workflows/release.yml .github/workflows/deploy.yml
bun run build:ts
bun run test:integration
```

`bun run test:integration` 会运行 lite 和 full 集成链路。若 Docker、数据库或
本机网络权限缺失，记录真实失败输出；不要把未运行的集成测试写成通过。
