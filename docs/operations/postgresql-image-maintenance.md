# PostgreSQL 镜像维护（image-only，不改数据）

> 范围：**仅替换 PostgreSQL 镜像**（同一主版本内的镜像 digest 变更）。
> 不涉及 app 稳定版推进、不重建数据卷、不改数据库/角色/HBA。**不**等同于 full RC 接受。

## 1. 为什么 production PG 独立于 app 稳定版推进

生产 PostgreSQL 是**独立基础设施**，与 app 的 stable promotion 是两条路径：

- candidate / cleanup 流程**从不**升级共享生产 PG。app 的 29 项 stable 门禁保持不变，
  本流程**不新增** Source 审计或 SDK 门禁。
- 生产 PG 的镜像 pin 由 `deploy/sealos/cloud/xpod-rdf-postgres.yaml` 独立维护。
- **配置 pin 必须与已完成的生产 upgrade 一致**，否则后续 infra apply 会把生产回滚到旧镜像。

## 2. 允许的变更

| 允许 | 禁止 |
|---|---|
| 同一 PG 主版本内的镜像 digest 变更 | 跨主版本大版本升级 |
| 复用已验证的物理备份做独立 restore 验证 | 重建 PVC / 数据库 / 角色 / HBA |
| 先 quiesce 再 patch，随后 resume | 对生产数据 `apply -k` 整包 |
| image-only CAS（compare-and-swap）patch | 任何情况下打印凭据 |

**metadata 前后比对**证明的是元数据未被破坏（5 个 DB、extensions、sequences、system identifier、
PVC、PGDATA 路径），**不是**"全量数据逐行相等"的证明。

## 3. 前置条件

1. 已存在**不可变**的 PG 资格证据（非本次新造）：
   - 已安装形态的 17 semantic + 6 wire 校验；
   - 16 public + 17 private 兼容 / full integration。
2. 已有符合本次恢复计划的**已验证物理备份**与**独立 restore** 记录，可复用这些证据，避免无故重复全量备份。
3. 明确并固定以下对象（只读读回确认）：live StatefulSet、PVC、PGDATA 路径、system identifier、
   受保护的备份/恢复资源（`pgdata` 之外的备份卷与恢复卷）、备份 receiver、四个 writer。
4. 取得**独占操作权**：确认没有其他人/流程同时在动这套 PG 与 writer。

## 4. 步骤

1. **读回并固定身份**：StatefulSet UID、镜像、PVC UID、system identifier、writer 的 UID 与副本数。
   任何一项与预期不符就停止。
2. **quiesce** 四个 writer（缩到 0），确认没有残留 Pod。
3. **before 采集**：导出元数据（DB 列表、extensions、sequences、system identifier 等）。
4. **image-only CAS patch**：仅改容器 image 字段，且带 resourceVersion 前置条件；
   绝不动 volumes / PVC / env / 数据。
5. **等待 PG ready**，读回新镜像生效。
6. **after 采集**并与 before 比对元数据。
7. **resume** 四个 writer 到原始副本数，确认全部 Ready。
8. **健康验证**：PG 自身健康 + 实际 SPARQL 读路径可用。

## 5. 恢复语义（重要）

- **patch 之前失败**：`resume` 直接把 writer 恢复到原始副本数即可，数据未被触碰。
- **patch 之后失败**：**不要盲目 resume**。必须先验证 PG 是否真的健康、
  是否需要从已验证的备份恢复；在确认 PG 状态之前 resume 只会让 writer 连上坏 PG。

## 6. 回滚

确认数据格式兼容并停止写入后，可按同样的 CAS 流程恢复上一个 digest；**不要**通过重建资源回滚。
生产 PG 的数据卷在整个过程中保持不变。

## 7. 与 stable release 的关系

本 runbook 的结果**不构成** app 稳定版接受、也不构成 full RC 通过。
29 项 app stable 门禁及既有 SDK／原生校验继续按 `docs/RELEASE.md` 执行。
逐文件镜像 SOURCE／LEGAL／ABI 审计仍是独立可选诊断，本流程不改变其性质。
