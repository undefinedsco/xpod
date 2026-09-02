# 发布的 models 缺少 API Key 临时停用字段

## 现象与复现

2026-08-28，Cloud、Local、Standalone 真实 Gateway 的 Key 创建、列表、恢复明文和首次认证均成功，但 `PATCH /api/ai/gateway/keys/:id` 提交 `enabled: false` 后，返回的 Key 仍未停用。

`scripts/accept-live-gateway-login-chat.ts` 在 pause 阶段报 `Pausing an API Key must be reversible`，不是 Chat 或上游 Provider 故障。

安装包检查可独立复现：

```ts
import { gatewayAccessKeyResource } from '@undefineds.co/models';
if (!gatewayAccessKeyResource.columns.disabledAt) {
  throw new Error('Missing shared disabledAt column');
}
```

## 根因

- Xpod repository 使用 `db.updateById(gatewayAccessKeyResource, id, { disabledAt })` 实现可恢复停用，撤销字段 `revokedAt` 不参与此操作。
- 当次安装的 `@undefineds.co/models@0.2.51` 未包含 `disabledAt` 列。UI 还单独依赖 `0.2.50`，两端模型版本也未对齐。
- 实际 drizzle-solid 更新构造器跳过 schema 不存在的字段，因此更新没有写入停用时间。此前 mock 数据库直接回显 patch，未覆盖这个依赖契约。
- 共享 models 源码的 `src/ai-gateway.schema.ts`、`src/namespaces.ts` 和 `src/pod-storage-descriptor.ts` 已有对应定义；此次问题是发布产物缺失，不应在 Xpod 另定义 schema 或改用原生 SPARQL。

## 本机验收修复边界

1. 用 Bun `patchedDependencies` 将共享源码中已有的字段、词汇、descriptor 和类型声明回移到锁定的 `0.2.51`，补丁随仓库与 lockfile 交付。
2. UI 与服务端统一消费 `0.2.51`，不维护第二种字段或生命周期语义。
3. 消费方回归测试直接检查实际安装的 shared resource / descriptor，不再仅依赖 mock 数据库回显。
4. 在三模式真实 Pod 上复验停用拒绝、重新启用和删除。开发挂载的成功不作为最终镜像发布证据。

没有修改或发布其他 models 工作树。正式依赖收口时，应发布包含上述共享源码和测试的 models 版本，再统一升级 Xpod/UI 并移除这项临时补丁；不能只升级版本号而不检查安装产物。

## 已验证的安装残留问题

统一 manifest 和 lockfile 后，当前机器的 `ui/node_modules/@undefineds.co/models` 仍残留 `0.2.50`，会遮蔽 root hoisted 的已修补版本。普通 frozen install 在这次环境中没有移除该残留。将这个已确认过期的生成目录和 Vite 预构建缓存移入临时备份后，UI 才解析到同一份根依赖；没有移动整个 `ui/node_modules` 或用户数据。

`ui/src/shared-model-contract.test.ts` 放在 UI workspace 内，直接检查实际解析到的资源。该测试在残留存在时失败，清理后通过，防止只验证服务端的依赖版本。

2026-08-28 的三模式真实 Docker 复验中，创建、列表、恢复明文、停用拒绝、重新启用及删除后拒绝均通过。真实 Provider 凭据与 Chat 是独立验收项，此结果不代表 Chat 或不可变镜像发布验收完成。
