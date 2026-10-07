# 使用外部服务运行完整集成测试

完整测试可以连接独立的 PostgreSQL/pgvector、Redis 和 S3 兼容存储，避免在本机运行 Docker VM。测试目标、四个 Xpod runtime 和 lite/full 顺序保持不变。

将测试服务配置保存在权限为 `0600` 的本地文件，通过唯一入口运行：

```sh
XPOD_FULL_INFRA_ENV_FILE=/absolute/path/test-infra.env bun run test:integration
```

文件只接受以下八个键。Redis 的用户名和密码键必须存在，无认证的独立测试实例可使用空值。

```dotenv
XPOD_FULL_PG_URL=postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:15432/TEST_DATABASE
CSS_REDIS_CLIENT=redis://127.0.0.1:16379/0
CSS_REDIS_USERNAME=
CSS_REDIS_PASSWORD=
CSS_MINIO_ENDPOINT=http://127.0.0.1:19000
CSS_MINIO_ACCESS_KEY=TEST_ACCESS_KEY
CSS_MINIO_SECRET_KEY=TEST_SECRET_KEY
CSS_MINIO_BUCKET_NAME=TEST_BUCKET
```

替换示例值，使用专供本次测试的数据资源。Kubernetes 服务可用绑定 `127.0.0.1` 的 `kubectl port-forward` 接入；转发地址必须与文件中的地址一致。

PostgreSQL 需要已安装 `vector` 扩展，并用 `scripts/init-postgres.sql` 初始化测试数据库。S3 bucket 必须已创建。运行器以真实 PostgreSQL、Redis PING 和 S3 bucket 探测检查就绪状态；配置错误或探测失败会直接退出，不调用 Compose 启停或回退到本地服务。

Cloud 两个副本和测试客户端使用同一份配置。Redis 的独立认证字段会规范化进连接 URL，空字段会清除原 URL 的认证信息。运行器不自动继承开发或生产服务配置，也不会创建 bucket、清空 Redis 或删除外部数据库。测试完成后，由创建这些资源的验收流程按其资源清单清理独立测试资源和端口转发。

不设置 `XPOD_FULL_INFRA_ENV_FILE` 时，继续使用原 Compose 测试流程。外部服务探测和完整集成测试通过，均不能替代真实部署候选、正式桌面自动更新或真实模型 Chat 的验收。

## Kubernetes 集群选择

桌面壳验收使用广州（GZ）集群，不得自动回退到新加坡（SG）。当前上下文的 namespace 必须与测试资源的 namespace 一致，并在创建隔离夹具前建立可信的 TLS 连接。CA 校验失败的 kubeconfig 不能作为验收基础设施；应恢复有效的 GZ 配置。现有 SG 生产或 RC 资源不属于临时夹具的清理范围。

有效广州配置当前位于 `/Users/ganlu/develop/undefineds/config/kubeconfig.cn.yaml`，namespace 为 `ns-iknkxtc8`。先使用显式 `KUBECONFIG` 和 `SEALOS_NAMESPACE` 执行 `node scripts/verify-rc-cluster-target.cjs`，再检查真实 API 和测试资源权限。该文件包含凭据，不要复制进仓库或上传到日志。`kubeconfig.co.yaml` 属于 SG，不能作为本次验收的回退。
