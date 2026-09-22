# Matrix 多 Agent 协作验收样例

这个样例通过**正在运行的 Xpod Gateway** 写入真实 Pod，并使用两个确定性脚本执行器验证消息、领取租约、交接、结果回写和增量同步。它不会请求 LLM，也不能证明模型推理、真实工具执行、不同身份隔离或跨实例故障恢复已经通过。

## 前提与运行

- Gateway 已启用 Matrix 与 `/v1/agent-wakes/*`，且接入同一持久队列。
- 已有有效 Solid/API 凭据；当前身份具有目标 Pod 的读写权。凭据放入环境变量，脚本不接受命令行明文 token，也不会输出 token。
- Pod 必须在当前 Gateway 的身份数据库中注册。单 Pod 可省略 `--pod`；多 Pod 必须明确选择。
- `whoami` 返回 `co.undefineds.pod_url` 和 `co.undefineds.webid` 时无需再次输入这些信息。`--webid` 可作为旧响应兼容输入；与服务器报告身份不一致会失败。
- 样例会创建一个持久房间、两项 Agent 执行授权、63 条消息及执行记录。使用专用验收 Pod；不会自动删除这些证据。

```bash
# 由现有凭据申请流程或凭据管理器设置 XPOD_MATRIX_TOKEN，勿提交到仓库。
bun scripts/accept-matrix-collaboration.ts \
  --url http://localhost:3000 \
  --pod https://storage.example/alice/ \
  --output .test-data/matrix-collaboration/result.json
```

可通过 `--token-env MY_MATRIX_TOKEN` 指定另一个环境变量名。运行 `--help` 不进行网络请求。输出文件只允许位于 `.test-data/` 中。

本样例使用 Bearer/API 凭据。不能把绑定 DPoP 的访问 token 当成普通 Bearer token；需要 DPoP 的客户端应使用现有 Solid SDK 按请求生成 proof。

## 协作契约

房间创建者写入 `co.undefineds.agents` state，声明可以调用谁、由哪个 WebID 执行、工作区和允许的交接目标。下面的 URI 是部署时替换的示例，身份以服务器认证结果为准。

```json
{
  "agents": [
    {
      "agent": "https://storage.example/alice/.data/agents/author.ttl#this",
      "executor": "https://id.example/alice/profile/card#me",
      "workspace": "https://storage.example/alice/",
      "allowedActors": ["https://id.example/alice/profile/card#me"],
      "handoffTo": ["https://storage.example/alice/.data/agents/reviewer.ttl#this"]
    },
    {
      "agent": "https://storage.example/alice/.data/agents/reviewer.ttl#this",
      "executor": "https://id.example/alice/profile/card#me",
      "workspace": "https://storage.example/alice/",
      "allowedActors": ["https://id.example/alice/profile/card#me"],
      "handoffTo": []
    }
  ]
}
```

顺序为：

1. `whoami` 确认身份和 Pod；`createRoom` 创建私有房间。
2. 创建者写入上面的授权 state，并获取后续增量同步的基线游标。
3. 用户发送 `m.room.message`，`mentions` 指向 author；重试同一 txn 验证返回相同事件 ID。
4. author 执行器 `claim` 获得 `{ job, input }`；使用 `job.id`、`job.fencingToken` 和自己的 `runtimeId` 续租。
5. author `complete` 写入结果，显式 `handoffTo` reviewer。授权范围外的交接应被拒绝；普通助手消息不会自动无限触发协作。
6. reviewer 领取交接输入并完成。两步的 evidence 引用实际前置消息事件 ID，不能用虚构测试结果冒充证据。
7. 再次提交已完成租约必须返回 409。客户端遇到结果写入后响应丢失时，应重新读取结果，并按执行接口约定恢复，不能直接再次执行外部副作用。
8. 清空本房间 grants，追加 60 条无执行目标的积压消息；以 `limit=7` 同步，核对原始、两次结果和积压共 63 个事件 ID 及正文全部可读。

租约是至少一次执行协议。外部工具仍须使用任务/执行标识提供幂等能力；fencing token 用于拒绝过期或被接替执行者的提交，不是访问凭据。

样例对交互调用使用 120 秒请求预算，对积压阶段的消息写入使用 240 秒预算并最多重试 3 次。Pod 繁忙时单次写入可能超过交互预算；重试沿用同一 txnId，因此不会产生第二条事件，也不改变 63 个事件的证据口径。失败输出会打印各阶段耗时与重试次数，用于区分脚本参数问题、Pod 背压与身份失败。

## HTTP 调用片段

以下变量中的身份、房间和租约应来自本次服务响应。`XPOD_MATRIX_TOKEN` 由现有认证流程设置；不要开启 `set -x`。为便于阅读使用 curl 展示请求，自动验收推荐上面的 Bun 脚本。

```bash
curl --fail-with-body "$GATEWAY/_matrix/client/v3/account/whoami" \
  -H "Authorization: Bearer $XPOD_MATRIX_TOKEN" \
  -H "X-Xpod-Pod-Url: $POD_URL"

curl --fail-with-body "$GATEWAY/v1/agent-wakes/claim" \
  -H "Authorization: Bearer $XPOD_MATRIX_TOKEN" \
  -H "X-Xpod-Pod-Url: $POD_URL" -H 'Content-Type: application/json' \
  --data-binary @.test-data/matrix-collaboration/claim.json
```

`claim.json`：

```json
{
  "roomId": "!replace-with-created-room-id",
  "agent": "https://storage.example/alice/.data/agents/author.ttl#this",
  "runtimeId": "author-runtime-1",
  "leaseMs": 30000
}
```

续租和完成均使用同一 executor 凭据，附带领取返回的 `id` 与 `fencingToken`。完成请求：

```json
{
  "roomId": "!replace-with-created-room-id",
  "agent": "https://storage.example/alice/.data/agents/author.ttl#this",
  "runtimeId": "author-runtime-1",
  "id": "replace-with-job-id",
  "fencingToken": "replace-with-current-lease-token",
  "body": "脚本作者的确定性结果",
  "handoffTo": "https://storage.example/alice/.data/agents/reviewer.ttl#this",
  "evidence": ["$replace-with-real-input-event-id"]
}
```

```bash
curl --fail-with-body "$GATEWAY/v1/agent-wakes/complete" \
  -H "Authorization: Bearer $XPOD_MATRIX_TOKEN" \
  -H "X-Xpod-Pod-Url: $POD_URL" -H 'Content-Type: application/json' \
  --data-binary @.test-data/matrix-collaboration/complete.json
```

失败时调用 `/v1/agent-wakes/fail`，带相同租约字段以及 `error`、`retry`。`retry: true` 表示允许重新领取；实际外部动作能否安全重试由工具自身幂等保证。

## 共享房间与验收边界

同一验收凭据执行 author/reviewer，是为了让样例可直接跑通协议。生产部署需为不同 executor 分配独立身份和授权，另行验证越权领取、写 state、读取输入及提交结果均被拒绝。

`X-Xpod-Pod-Url` 只选择已注册的 Pod 根，不提供额外权限。共享 Pod 请求始终携带请求者自身凭据；Matrix 邀请不会创建 Solid ACL。邀请其他人或 executor 后，必须通过已有 Pod 授权机制授予相应访问面，并验证读取/写入边界。

脚本输出 `mode: "deterministic-runtime"` 和明确的 `evidenceScope`。只有实际运行成功的报告才算这条真实 HTTP 验收通过；`--help`、转译成功或单测通过都不能替代。真实 LLM 对话、工具质量、租约过期接替、Redis 断连、进程崩溃恢复及跨实例并发仍需独立验收。
