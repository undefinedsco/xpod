# 配置与参数约定（全局）

本文总结 Xpod 在“必填/可选”以及 “命令行参数 vs 环境变量” 两方面的约定，适用于云边集群及常规部署配置。

## 1. 什么时候必须填？

- **无法推导且无默认**：比如 `CSS_BASE_URL`，决定根域名和路由前缀，必须显式给出。
- **凭证/安全敏感**：DNS Token、邮件密码等，不能留空。
- **影响运行模式的硬开关**：`XPOD_EDITION`、`XPOD_EDGE_NODES_ENABLED` 等，默认值会导致行为差异，需要明确选择。

## 2. 什么时候可以不填？

- **可复用现有变量**：如 `XPOD_CLUSTER_INGRESS_DOMAIN` 可从 `CSS_BASE_URL` 的 hostname 推导。
- **有社区/库默认值**：ACME 目录、证书存储路径、DNS 传播等待等已在代码设置默认。
- **默认值常用且影响小**：如 `XPOD_DNS_RECORD_TTL=60`。
- **留空即关闭某能力**：如 `XPOD_FRP_SERVER_HOST` 为空则禁用隧道。

## 3. 云边最小必填清单（示例）

- 必填：`CSS_BASE_URL`、`XPOD_EDITION`、`XPOD_EDGE_NODES_ENABLED`、`XPOD_SIGNAL_ENDPOINT`、`XPOD_ACME_EMAIL`、`XPOD_TENCENT_DNS_TOKEN_ID`、`XPOD_TENCENT_DNS_TOKEN`。
- 选填/默认：`XPOD_CLUSTER_INGRESS_DOMAIN`（推导自 `CSS_BASE_URL`）、`XPOD_DNS_RECORD_TTL`（默认 60）、`XPOD_ACME_DIRECTORY_URL`、`XPOD_ACME_ACCOUNT_KEY_PATH`、`XPOD_ACME_CERTIFICATE_STORE`、`XPOD_ACME_DNS_PROPAGATION_DELAY`、`XPOD_TENCENT_DNS_BASE_URL`、`XPOD_TENCENT_DNS_DEFAULT_LINE_ID`。
- 可空即关闭：`XPOD_FRP_SERVER_HOST/PORT/TOKEN/PROTOCOL`。

## 4. 何时暴露为命令行参数？

- **需要频繁切换或公开给运维的入口**：模式开关、端口、域名（如 `--baseUrl`、`--xpodEdition`、`--xpodEdgeNodesEnabled`、`--xpodClusterIngressDomain`）。
- **与社区 CLI 习惯保持一致**：例如 CSS 已有的 `-b/--baseUrl`、`--sparqlEndpoint`。

## 5. 仅保留为环境变量的场景

- **敏感信息**：密钥、Token（避免暴露在 CLI 历史或进程列表）。
- **细粒度调优/路径**：证书存储路径、TTL、探测超时等，通常有默认值。
- **关闭某能力的空值开关**：如留空的 FRP 主机即禁用隧道，无需 CLI 暴露。

> 新增变量时，按照上述规则同时更新：配置文件（Variable 声明）、resolver 解析、必要的文档/示例 env，避免出现 “Undefined variable” 或不一致的默认行为。
