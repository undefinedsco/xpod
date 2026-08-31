# RDF Search / QLever 当前状态

最后核验：2026-09-01（Asia/Shanghai）

本文是 RDF、FTS/VEC、QLever 和 `.co` 生产替换的唯一当前口径。日期型设计、
实施计划和验收报告只保留当时的决策或证据；与本文冲突时，以本文、不可变发布证据
和当前代码为准。

## 结论

QLever 的独立 RC 已通过，但**正式发布尚未完成**。RC 接受的 public Xpod source
`aaf911378f89faece05d7f307464e29c58421c52` 尚未进入 public `main`；因此它只能作为
特性集成证据，不能作为生产或 stable 发布批准。

`.co` 生产在 2026-08-31 被提前替换为该候选版本，随后还错误地产生了 `0.4.0`
stable 标记。当前生产运行实例暂不盲目回滚：替换时按 breaking-change 口径删除了旧
数据库 PVC，直接切回旧服务没有可验证的数据路径。不可变 production/stable evidence
保留为发生过这些操作的审计记录，但不再表示发布有效。

这里的 `0.4.0` 是私有 PG/QLever 集成版本，不改变公开 Xpod server 自己的
`0.3.x` 发布线。公开 Local/Cloud 的产品边界也没有改变。

| 层次 | 当前事实 |
| --- | --- |
| Public Xpod accepted source | `aaf911378f89faece05d7f307464e29c58421c52`，**未合入 `main`** |
| Public Xpod current `main` | `ec84c018e2af6ce83af24f024334b69bf5e45f6a`（2026-09-01 核验） |
| Private xpod-pro source | `ff604772d56186bc194643d9af85c01086930a16`；过早的 `v0.4.0` 远端 tag 已撤回 |
| Xpod server image | `ghcr.io/undefinedsco/xpod@sha256:b0b9a5cc250dea2ba24fc94530b6cd51c9f94cf62bf8844eb6cd197310b271c2` |
| PG17/QLever image | `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:aefedcf547fa510141807d82721db9862f1e6903f140b2be6e6573915f119ce2` |
| Withdrawn PG/QLever tag | `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres:0.4.0` 仍解析到上述运行 digest，但正式发布前不得消费 |
| Production namespace | `.co` Sealos `ns-1yl0rye9` |
| Production query route | `cloud.enterprise.json` 启用私有 `QleverSparqlEngine`，调用同一 `PostgresRdfEngine` facts/search authority |
| Production data | 按既定 breaking-change 口径全新创建；没有 migration、backfill、兼容层或 fallback |

## 发布证据链

### 1. 有效但不能晋级的独立 RC

- release：`0.4.0-rc.3`
- CNB wrapper：[`cnb-7bg-1k1bs8hfm`](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-7bg-1k1bs8hfm)
- CNB child：[`cnb-7r8-1k1bs8nms`](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-7r8-1k1bs8nms)
- immutable evidence：
  `docker.cnb.cool/undefineds.co/native-builder/enterprise-rc-acceptance@sha256:f5a95fad78dae8b76a41625912eb62bcc727d614da2d542b9bc0353d1fc87f68`

RC 使用广州 `ns-iknkxtc8` 中独立的 `xpod-qlever-rc-*` Service、StatefulSet、PVC、
应用和 Ingress。它没有读取或修改主线 RC 资源。验收后应用 scale to zero，bootstrap /
index Job 和候选数据库资源清理完毕。

RC 同时验证：

- exact public/private source SHA 与两个镜像 digest；
- PG17 native capability `1|true`；
- OIDC、认证 RDF update/query、ACL 拒绝、blob roundtrip；
- 17 个 SPARQL/RDF 语义用例；
- FTS 写入后立即可查，VEC 补齐后融合，exact 查询、资源 move、旧 source 清除和
  denied source 不泄漏。

该 evidence 不满足发布条件，因为其中的 public source 只存在于特性分支。它不得在
主线合并后重用；必须以合并后的 public SHA 和对应镜像重新产生 RC evidence。

### 2. 已发生但过早的生产替换

- CNB wrapper：[`cnb-bg8-1k1bvpirm`](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-bg8-1k1bvpirm)
- CNB child：[`cnb-1fb-1k1bvpqn6`](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-1fb-1k1bvpqn6)
- immutable evidence：
  `docker.cnb.cool/undefineds.co/native-builder/enterprise-production-acceptance@sha256:58944699d0bd8ef3bf8161713e009fa70215b58d9c275adf534ded038b80db52`

生产流程当时只接受上述 RC evidence，不接受任意 tag 或重新输入镜像，但缺失了
“accepted public SHA 已进入 `main`”这一发布门禁。替换过程先验证镜像和
namespace pull Secret，再停止 writer；随后删除两个明确枚举的 current/predecessor PVC，
全新创建 PG17/QLever，应用 enterprise 查询配置并恢复 Xpod/Inngest。

生产门禁重新验证 exact running imageID、native capability、17 个语义用例、FTS/VEC
状态迁移和公网 `service/status`。发布 evidence 前还要求：

- 当前 `data-xpod-rdf-postgres-0` 为 `Bound`；
- 前任 `postgres-data-xpod-rdf-postgres-0` 不存在；
- CSS/API 两项服务均为 `running`。

这份 evidence 证明当时的替换和运行检查确实通过，不证明它应当在主线之前发生。

### 3. 已撤回的 Stable 0.4.0 标记

- CNB wrapper：[`cnb-ado-1k1c7ljec`](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-ado-1k1c7ljec)
- CNB child：[`cnb-hd1-1k1c7lpjn`](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-hd1-1k1c7lpjn)
- immutable evidence：
  `docker.cnb.cool/undefineds.co/native-builder/enterprise-release@sha256:1899396ba09e37c08985f1c33c504b0bef7d13d7cedcc19a8d4ce090cc49c2f0`

该流程只消费 immutable production evidence，但同样没有验证 public source 已进入
`main`，所以结论无效。它当时重新校验 candidate line、源码、
运行镜像、QLever conformance、active PVC 和 predecessor PVC，再用 registry manifest
retag 将 accepted PG digest 标记为 `0.4.0`。整个阶段没有访问 Kubernetes、编译或再次
部署生产。远端 Git `v0.4.0` 已撤回；OCI evidence 和 TCR tag 保留为审计痕迹，状态为
withdrawn，不得作为依赖或发布依据。

native-builder `6473f3d8cab08942b3f37f4fcae31e346b99e8ae` 已在 production 和 stable
两条路径增加相互独立的 public-main ancestry 门禁，并用 Git fixture 验证 main 提交
通过、未合入 feature 提交失败。门禁发生在任何 Kubernetes 变更或 registry retag 之前。

## 正式发布前的唯一顺序

1. 主线完成验收并合入 public Xpod `main`。
2. 从合并后的完整 SHA 构建新的 immutable public Xpod 镜像。
3. 用该 SHA/镜像重新跑隔离 QLever RC；不得重用 `f5a95f…`。
4. 新 RC 通过后再升级生产，并产生新的 production evidence。
5. 最后才能恢复 `v0.4.0` 和 stable evidence。

## 当前产品边界

| 部署形态 | SPARQL authority | Facts / FTS / VEC | 依赖边界 |
| --- | --- | --- | --- |
| Public Local | `QleverSparqlEngine` + 静态 Local QLever runtime | 同一 SQLite 文件中的 `SolidRdfEngine`、text/vector indexes | 全部开源；不加载 `.so`，不暴露 backend selector |
| Public Cloud | `RdfQuerySparqlEngine`，由 Comunica 计算 algebra | `PostgresRdfEngine` + PostgreSQL FTS/VEC | 不要求、不探测私有 PG QLever extension |
| Private Cloud | `QleverSparqlEngine` 调用 `PostgresRdfEngine.sparqlQuery` | 与公开 Cloud 共用 PostgreSQL facts、scope 和 search identity | `xpod-pro` 的 `cloud.enterprise.json` 显式启用 |

公共与私有 Cloud 不是两套数据模型。私有层只替换查询执行组件，不改变 SolidFS
文件权威、RDF facts、权限语义、FTS/VEC identity 或 HTTP SPARQL 协议。

## Search / Embedding 合同

- FTS 与 VEC 对齐到同一个文本实体和稳定检索身份：
  `sourceKey + retrievalPointKey`。
- FTS 不依赖 embedding，写入文本后即可查询。
- VEC 是 Pod-scoped 可选能力。只有 Pod 明确配置
  `AIConfig.embeddingModel` 以及该模型 provider 的 credential 时才执行。
- 没有模型、额度耗尽、限流或暂时性 provider 错误不会被假装成完成；
  reconciliation 保留可重入状态，并在配置 fingerprint 改变或重试到期后继续。
- Reader 负责把非文本资源转换为一等文本表示并生成 retrieval points；
  RDF/search 只消费结果，不维护第二套 reader kind，也不把全文塞进 RDF metadata。

## Compatibility Impact

本次生产替换是有意的 breaking change：旧 PostgreSQL 数据、旧 schema 和旧索引不兼容。
RC 和生产都没有 dump/restore、migration、backfill、双写、兼容层或 fallback。

用户 AI Provider 凭据同样采用当前唯一格式：由 Xpod 写入用户 Pod 的明文凭据记录，
不依赖部署级 SecretCell、KMS 或 root key。连接列表、API 响应、日志和验收 artifact
不得回显实际 secret。

## 已知非阻塞项

Sealos 当前以 warning 而不是 enforce 模式提示 `restricted:v1.25` PodSecurity 差异：
`allowPrivilegeEscalation`、capability drop、`runAsNonRoot` 和 seccomp 尚未全部显式声明。
这没有影响本次启动、查询或数据验收，但属于后续部署安全加固，不应误写成 QLever
功能或发布失败。

## 证据索引

- [Public Local/Cloud 与 private artifact 验收](superpowers/plans/2026-08-13-qlever-local-cloud-public-private-acceptance.md)
- [Local QLever / embedding 历史实施计划](superpowers/plans/2026-08-12-local-qlever-embedding-parity.md)
- [RDF P0/P1 历史交接](superpowers/plans/2026-07-29-rdf-p0-p1-acceptance-handoff.md)
- [RDF Engine Spec](rdf-engine-spec.md)
- [Progressive Semantic Index](progressive-semantic-index.md)
- private `xpod-pro/docs/acceptance-fixture-contract.md`
- private `xpod-pro/qlever/reports/2026-08-12-pg17-semantic-acceptance.md`
