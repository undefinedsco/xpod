# RDF Search / QLever 当前状态

最后核验：2026-08-24（Asia/Shanghai）

本文是 RDF、FTS/VEC、QLever 和生产替换状态的唯一当前口径。日期型设计、
实施计划和验收报告只保留当时的决策或证据；与本文冲突时，以本文和当前代码为准。

## 结论

生产替换只完成了一部分，不能标记为全部完成。

| 层次 | 状态 | 当前事实 |
| --- | --- | --- |
| 公开源码 | 已合入 | `undefinedsco/xpod` `main` 已恢复 RC gate、无重建 promotion 和隔离 RC Inngest |
| 私有源码 | 已合入 | `undefinedsco/xpod-pro` `main` 已加入独立 RC PG 与双 digest enterprise promotion gate |
| Local runtime | 已发布并验收 | `ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:47e14c13b40bdf112648bc6b2f4f869fb973612b6b764f2758bb583f11f6f991` |
| 最终私有 PG17 artifact | 已发布并验收 | `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:be5a95bade37790b28d322300554500da79b61e93ac9047fb6a425efac64c517` |
| `.co` PostgreSQL 基础设施 | 已替换，但不是最终 artifact | 线上为 PG17 + `vector` + `xpod_rdf` + `xpod_qlever`，运行较早的 `szjrccr...@sha256:9e110...` |
| `.co` Xpod 应用 | 未提升到本次最终源码 | Cloud/RC 仍运行 2026-08-10 发布的 `ghcr.io/undefinedsco/xpod@sha256:7d79c7...` |
| `.co` 私有 QLever 查询路由 | 未启用 | Cloud/RC 都以 `-c config/cloud.json` 启动，未挂载 `cloud.enterprise.json`；普通 SPARQL 仍走公开 Cloud 的 Comunica 路径 |
| `.cn` | 未部署 | 目标 namespace 没有 `xpod-cloud` / `xpod-rc` workload |

因此，准确说法是：**`.co` 的数据库已经换成带 QLever 能力的 PG17，服务也在运行；
但最终 PG 镜像、最终 Xpod 镜像和私有 QLever 产品查询路由都还没有完成生产提升。**

## Compatibility Impact

本次生产替换是有意的 breaking change：旧 PostgreSQL 数据、旧 schema 和旧索引
不要求兼容，可以随各环境的旧 PVC 一起删除。RC 和生产都不做 dump/restore、
migration、backfill、双写、兼容层或 fallback；但两者必须分阶段处理，不能同时
停写或一起重建。

用户 AI Provider 凭据同样采用当前唯一格式：由 Xpod 写入用户 Pod 的明文凭据记录，
不再依赖部署级 SecretCell、KMS 或 root key。旧的加密记录不迁移、不回读；连接列表、
API 响应、日志和验收 artifact 仍必须隐藏实际 secret。

## Release Boundary

`xpod_rc` 是一次发布的临时候选环境，不是第二个长期生产 writer。发布顺序固定为：

1. 只构建一次，记录候选 Xpod 和 PostgreSQL 的不可变 digest。
2. 先用独立的 RC Service、StatefulSet/PVC 和空 `xpod_rc` 数据库部署这两个 digest，
   只切换 `xpod-rc`，不修改 `xpod-cloud` 或生产 PVC。
3. 在 RC 完成认证、RDF、FTS/VEC、native capability 和产品路径验收。
4. RC 通过后，不重新构建，以相同 digest 和相同 enterprise 查询配置单独提升生产；
   此时才停 `xpod-cloud`，删除生产旧 PG/PVC，并创建空 `xpod_cloud`。
5. 生产 smoke 通过前保留 RC 作为对照；通过后将 RC scale to zero，并删除候选数据库
   和候选 PG/PVC。下一次发布重新创建干净 RC。

仅发布应用代码时，独立数据库、Redis DB 和 object prefix 可以提供逻辑隔离；本次还要
验收 PostgreSQL 镜像和 native extensions，因此 RC 必须拥有独立 PostgreSQL 进程和
PVC。只把 `xpod_rc` 放在生产 PostgreSQL 的另一个数据库里，不能证明候选 PG artifact
可启动、可建库、可安装 extensions，也会让候选基础设施变更直接影响生产。

## Active Work

状态：implementation merged and verified locally（2026-08-24），尚未执行 live RC。
`release/0.3.71` 中的 RC promotion 模式已经选择性恢复到当前 `main`，并升级到
本次双 artifact 发布边界：

- 没有合并历史 release branch 的无关业务代码；只恢复 RC metadata、acceptance
  evidence、候选 overlay 和 stable promotion gate。
- 公开 application RC evidence 只绑定 source SHA 和 Xpod image digest，只能授权公开
  artifact 的无重建提升；它不能授权 enterprise 生产部署。私有 enterprise RC evidence
  必须同时绑定 source SHA、Xpod image digest 和 PostgreSQL image digest；任何一个
  不一致都禁止生产提升。
- 公开仓库负责通用 RC / stable promotion 协议；私有仓库负责独立 RC PostgreSQL
  manifest、`cloud.enterprise.json` 和 native capability 验收。
- 私有 workflow 显式接收并校验两个 immutable image ref；公开 workflow 不触发私有
  workflow，也不持有 TCR、Kubernetes 或 enterprise secrets。
- 公开 RC 使用独立 `xpod-rc-inngest`；RC workflow 不再读取或修改生产
  `xpod-inngest`。enterprise RC 使用独立 PG Service/StatefulSet/PVC 和空
  `xpod_rc`。
- 本地实现和聚焦测试已经通过；RC 验收通过之前不修改生产。
- 完成条件是两个仓库的 workflow/manifest 测试、配置渲染、类型检查和相关集成测试
  通过，并由唯一状态文档记录最终证据。生产发布本身仍是单独的外部变更边界。

本地实现证据（未触发任何外部部署）：

- public Xpod：RC/release/deploy/manifest 聚焦测试通过；RC overlay 可由
  `render-rc-manifests.cjs` 正常渲染，且公开 deploy 只允许 `.cn` 并重新校验
  stable Release 与 exact RC acceptance evidence。
- public Xpod：RC helper 脚本测试
  `assert-rc-authenticated-smoke`、`prepare-rc-authenticated-smoke`、
  `publish-release-tag`、`rc-deployment-manifest`、
  `render-rc-manifests`、`release-candidate`、`update-gateway-rc-configmap`、
  `verify-rc-r2-access` 通过，53 pass。
- private xpod-pro：
  `XPOD_QLEVER_PUBLIC_SDK_ROOT=/Users/ganlu/develop/.worktrees/xpod-rdf-release-status-docs/qlever bun run verify:qlever-release:static`
  通过；Python 25 tests OK，Bun 365 pass / 9 skip / 0 fail。
- `git diff --check` 在 public 和 private 两个 worktree 均通过。

## 当前产品边界

| 部署形态 | SPARQL authority | Facts / FTS / VEC | 依赖边界 |
| --- | --- | --- | --- |
| Public Local | `QleverSparqlEngine` + 静态 Local QLever runtime | 同一 SQLite 文件中的 `SolidRdfEngine`、text/vector indexes | 全部开源；不加载 `.so`，不暴露 backend selector |
| Public Cloud | `RdfQuerySparqlEngine`，由 Comunica 计算 algebra | `PostgresRdfEngine` + PostgreSQL FTS/VEC | 不要求、不探测私有 PG QLever extension |
| Private Cloud | `QleverSparqlEngine` 调用 `PostgresRdfEngine.sparqlQuery` | 与公开 Cloud 共用 PostgreSQL facts、scope 和 search identity | 由 `xpod-pro` 的 `cloud.enterprise.json` 显式启用 |

公共与私有 Cloud 不是两套数据模型。私有层只替换查询执行组件，不改变 SolidFS
文件权威、RDF facts、权限语义、FTS/VEC identity 或 HTTP SPARQL 协议。

## Search / Embedding 合同

- FTS 与 VEC 对齐到同一个文本实体和稳定检索身份：
  `sourceKey + retrievalPointKey`。
- FTS 不依赖 embedding，写入文本后即可查询。
- VEC 是 Pod-scoped 可选能力。只有 Pod 明确配置
  `AIConfig.embeddingModel` 以及该模型 provider 的 credential 时才执行。
- 没有模型、额度耗尽、限流或暂时性 provider 错误不会被假装成完成；
  reconciliation 会保留可重入状态，并在配置 fingerprint 改变或重试到期后继续。
- Reader 负责把非文本资源转换为一等文本表示并生成 retrieval points；
  RDF/search 只消费结果，不再维护第二套 reader kind 或把全文塞进 RDF metadata。

## `.co` 生产观察

以下是 2026-08-24 对实际集群的只读观察，不是由源码或 workflow 状态推断：

- kube context：`vl83mra4@sealos`；namespace：`ns-1yl0rye9`。
- `xpod-cloud` revision `157`、`xpod-rc` revision `79`，两者均 Ready。
- 两者实际命令都是 `node dist/main.js -c config/cloud.json -p 3000`。
- 两者镜像相同：
  `ghcr.io/undefinedsco/xpod@sha256:7d79c7e1f6b669864b12447e930fce98ed298b319218724e31c8f3142302821c`。
- 两者没有 `cloud.enterprise.json` 文件或 enterprise ConfigMap mount。
- Cloud 与 RC 分别连接同一 `xpod-rdf-postgres` 服务中的
  `xpod_cloud`、`xpod_rc` 数据库。
- 这只提供数据库名隔离，不提供 PG image、Service 或 PVC 隔离；因此当前
  `xpod_rc` 不能作为“先验收最终 PG artifact、再提升生产”的独立 RC 环境。
- PostgreSQL StatefulSet 为 `1/1` Ready，运行：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:9e110480035420481658b4fd90d6216cee6e1ea0cc3496902d1b3f73f5679ea9`。
- 数据库报告 PostgreSQL `17.10`、`vector=0.8.6`、
  `xpod_qlever=0.4.0`、`xpod_rdf=0.2.0`。
- `https://id.undefineds.co/service/status` 和
  `https://id-rc.undefineds.co/service/status` 均报告 CSS/API running。

GitHub 的 `QLever Production Cutover` workflow 没有运行记录，但集群已经存在目标
StatefulSet 和改写后的连接。这说明当前替换通过另一条或人工路径完成；不能用该
workflow 的空记录否定数据库替换，也不能把集群现状误记成该 workflow 已验收。

## 实现与交付不一致

### 阻塞最终生产验收

1. **最终 artifact 没有被提升。** 线上 PG digest 是 `9e110...`，不是本次发布的
   `be5a95...`；线上 Xpod digest 也早于两仓库最终 `main`。
2. **私有查询路由没有进入生产。** `xpod-pro` 已提供
   `deploy/sealos/enterprise/cloud.enterprise.json` 和 deployment patch，
   但线上仍使用公开 `config/cloud.json`，所以已安装的 `xpod_qlever` 只代表数据库
   有能力，不代表产品请求正在使用它。
3. **新门禁尚未经过 live RC。** 当前 `main` 已恢复 `Release Candidate`、schema v2
   acceptance、stable digest-only promotion，并删除公开 direct PG cutover；私有仓库
   已加入隔离 enterprise RC / production workflow。但它们还没有在实际 GitHub
   Environment 和 Sealos namespace 上完成一次成功运行，因此不能把静态测试等同于
   环境验收。
4. **当前集群仍是旧的共享 RC/生产形态。** 源码已经定义独立
   `xpod-rdf-postgres-rc` Service/StatefulSet/PVC，线上尚未应用；当前 `xpod_rc` 仍与
   `xpod_cloud` 共用 PG Service/PVC。
5. **缺少本次最终 Xpod server image。** 新的 public candidate workflow 尚未从
   release branch 成功产出并验收可用于 enterprise RC 的 Xpod digest。

### 非阻塞但应清理的漂移

- private installed-image workflow 的默认 public commit、Local runtime 和 PG image
  仍指向旧候选；其中最终 PG artifact 位于需要鉴权的广州 TCR，不能只替换字符串而
  不补 registry login。
- 历史计划曾同时写过“公开 Cloud 必须 QLever”和“公开 Cloud 不依赖 QLever”。
  当前边界以上表和实际 `config/local.json` / `config/cloud.json` 为准。

本次整理已经把 public installed-image workflow 的 Local runtime 默认值更新为
`47e14c...`，并把 `native-builder/.cnb/web_trigger.yml` 的默认 source、SDK 和输出
tag 更新为已验收的 `ab3018...` / `f3ad825...` 组合。

## 完成生产替换所需证据

只有以下项目全部成立，才能把整体状态改成“生产替换完成”：

1. 从公开 `main` 构建并发布一次不可变 Xpod server image；稳定发布只能
   提升该候选 digest，不能重新构建。
2. 建立隔离的 RC 发布候选栈，例如 `xpod-rdf-postgres-rc` Service /
   StatefulSet / PVC，只连接 `xpod-rc` 和 `xpod_rc`，使用最终 `be5a95...`
   PG artifact 创建空数据库和所需 extensions；不复制旧数据，不提供 migration
   或 fallback。
3. 由私有部署入口只把 `cloud.enterprise.json` 和最终 Xpod digest 提升到
   `xpod-rc`；验证 RC 的 immutable digest、启动参数、ConfigMap mount、数据库
   目标、service status、认证 SELECT/ASK/CONSTRUCT、权限拒绝、SPARQL update
   authority、FTS、VEC、native capability 和产品路径，并保存与两个 digest 绑定的
   acceptance evidence。
4. RC 通过后，用同一组不可变 Xpod/PG digest 提升生产：quiesce 生产 writers，
   删除当前生产 `xpod-rdf-postgres` StatefulSet、Service 和 PVC，用最终 artifact
   从受控 manifest 全新创建 `xpod_cloud` 数据库及 extensions，并把
   `cloud.enterprise.json` 应用到 `xpod-cloud`。
5. 验证生产 Deployment 的 immutable digest、启动参数、ConfigMap mount 和数据库目标；
   对生产执行同一组 service、SPARQL、权限、FTS、VEC 和 native capability smoke。
6. 将最终 workload digest、数据库 digest、RC/生产 smoke 结果和时间写回本文后，
   将 RC scale to zero，并清理候选数据库、PG Service/StatefulSet/PVC。

## 证据索引

- [Public Local/Cloud 与 private artifact 验收](superpowers/plans/2026-08-13-qlever-local-cloud-public-private-acceptance.md)
- [Local QLever / embedding 历史实施计划](superpowers/plans/2026-08-12-local-qlever-embedding-parity.md)
- [RDF P0/P1 历史交接](superpowers/plans/2026-07-29-rdf-p0-p1-acceptance-handoff.md)
- [RDF Engine Spec](rdf-engine-spec.md)
- [Progressive Semantic Index](progressive-semantic-index.md)
- private `xpod-pro/qlever/reports/2026-08-12-pg17-semantic-acceptance.md`
