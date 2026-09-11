# drizzle-solid SPARQL UPDATE provenance 400 blocks Pod model sync

## 背景

实际 OpenAI 模型刷新接口 `/api/ai/gateway/providers/openai/models/refresh` 已返回 7 models，但写入用户 Pod 时，`@undefineds.co/drizzle-solid@0.3.24` 默认优先发送 `application/sparql-update` PATCH。当前 Pod provider 对部分资源返回 400：

```text
prepared update source provenance is not uniquely identified
```

这不是认证失败，也不是用户配置缺失。相同变更可以通过 drizzle-solid 已有的 N3 Patch 路径完成。

## 影响

- `/api/ai/gateway/providers/openai/models/refresh` 能拿到上游 7 models，但 provider 配置写回 Pod 失败。
- 返回状态是 400，现有 drizzle-solid 只对更新路径的 405/415 回退到 N3 Patch，插入路径直接发送 SPARQL PATCH，因此 provider 或模型资源首次写入遇到 provenance 解析失败会直接中断同步。

## 修复边界

- 仅对状态码 400 且响应正文包含 `prepared update source provenance is not uniquely identified` 的 SPARQL UPDATE 失败回退到 N3 Patch。
- 继续让普通 400、401、403 直接失败，避免绕过真实认证、授权或请求格式错误。
- 复用 drizzle-solid 现有 N3 Patch fallback 逻辑，保留 `deleteWherePatterns` 的删除与 `solid:where` 语义。
- 覆盖 `executeInsert` 的 provider 文档写入和模型 fragment 写入入口，保留原有 404 创建、HEAD 探测和 document fragment 分组规则。

## 后续

应在 drizzle-solid 上游修复 provider provenance 判断或为该场景提供明确兼容策略。本仓库当前通过 package patch 做有界兜底。

## 同一同步操作的并发写入

桌面上同时保留导入凭据与网页登录凭据时，两路模型发现结果都写入同一 Provider 文档。原 controller 对两次 `saveDiscoveredModels` 使用 `Promise.all`，造成 Provider 建立、模型写入与目录读取相互重叠。真实回读曾返回 QLever `knownEmptyResult()` 与实际非空结果不一致的断言。

controller 现在保留并行的上游模型发现，但按顺序等待每份结果写入 Pod；共享目录写冲突的回归在旧实现失败、修改后通过。该变化不修改 QLever 原生实现，也不关闭原生一致性检查。
