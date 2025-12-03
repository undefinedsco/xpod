# Xpod 配置策略设计

## 一、运行模式（6种）

| 模式 | 命令 | 配置文件 | ENV文件 | 说明 |
|------|------|---------|---------|------|
| **normal** | `yarn start` | main.json + extensions.json | 无 | 体验模式 |
| **local** | `yarn local` | main.local.json + extensions.local.json | .env.local | 本地单机 |
| **server** | `yarn server` | main.server.json + extensions.server.json | .env.server | 生产服务器 |
| **dev** | `yarn dev` | main.dev.json + extensions.dev.json | .env.local | 开发调试 |
| **cluster:server** | `yarn cluster:server` | main.server.json + extensions.cluster.json | .env.cluster | 集群控制面 |
| **cluster:local** | `yarn cluster:local` | main.local.json + extensions.local.json | .env.cluster.local | 集群边缘节点 |

## 二、配置架构

### 变量解析流程

```
CLI参数 (--xxx)
    ↓ YargsCliExtractor (envVarPrefix: "CSS")
    ↓ 自动读取 CSS_XXX 环境变量
    ↓
args 字典
    ↓ resolver.json
    ↓ KeyExtractor (从args读) / EnvExtractor (从process.env读)
    ↓
urn:solid-server:default:variable:xxx
    ↓
组件通过 @id 引用变量
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `config/cli.json` | 定义CLI参数，Yargs自动映射到 CSS_* 环境变量 |
| `config/resolver.json` | 定义变量解析逻辑，使用各种Extractor |
| `src/init/EnvExtractor.ts` | 新增，直接从 process.env 读取（不走Yargs） |

## 三、变量分类设计

### 设计原则

1. **CSS原生参数** - 完全不动，保持CSS原有设计
2. **CLI参数** - 只放最核心的模式开关（进cli.json，用KeyExtractor）
3. **ENV参数** - 次重要的配置（不进cli.json，用EnvExtractor直接读process.env）
4. **默认值** - 常量值，在EnvExtractor的defaultValue或组件里处理
5. **推导值** - 从 baseUrl 等已有变量推导，在组件构造函数里处理

### 3.1 CSS原生参数（完全不动）

保持CSS原有的cli.json和resolver.json配置：

| 参数 | CLI选项 | ENV变量 | 说明 |
|------|---------|---------|------|
| baseUrl | `-b, --baseUrl` | CSS_BASE_URL | 服务器公网URL |
| port | `-p, --port` | CSS_PORT | TCP端口 |
| loggingLevel | `-l, --loggingLevel` | CSS_LOGGING_LEVEL | 日志级别 |
| showStackTrace | `-t, --showStackTrace` | CSS_SHOW_STACK_TRACE | 错误堆栈 |
| rootFilePath | `-f, --rootFilePath` | CSS_ROOT_FILE_PATH | 文件根目录 |
| sparqlEndpoint | `-s, --sparqlEndpoint` | CSS_SPARQL_ENDPOINT | SPARQL端点 |
| seedConfig | `--seedConfig` | CSS_SEED_CONFIG | 种子配置 |

### 3.2 CLI参数（进cli.json，我们新增的）

只放最核心的2个模式开关：

| 内部变量名 | CLI选项 | ENV变量 | 类型 | 默认值 | 说明 |
|-----------|---------|---------|------|--------|------|
| edition | `--edition` | CSS_EDITION | string | "server" | 版本模式：server/local |
| edgeNodesEnabled | `--edgeNodesEnabled` | CSS_EDGE_NODES_ENABLED | boolean | false | 启用边缘节点 |

**cli.json 配置：**
```json
{
  "@type": "YargsParameter",
  "name": "edition",
  "options": {
    "type": "string",
    "describe": "Xpod edition: server or local"
  }
}
```

**resolver.json 配置：**
```json
{
  "CombinedShorthandResolver:_resolvers_key": "urn:solid-server:default:variable:edition",
  "CombinedShorthandResolver:_resolvers_value": {
    "@type": "KeyExtractor",
    "key": "edition",
    "defaultValue": "server"
  }
}
```

### 3.3 ENV参数（用EnvExtractor，不进cli.json）

#### CSS_ 前缀（数据层、外部服务）

| 内部变量名 | ENV变量 | 说明 | 必需场景 |
|-----------|---------|------|----------|
| identityDbUrl | CSS_IDENTITY_DB_URL | 账户数据库连接 | 所有模式 |
| minioAccessKey | CSS_MINIO_ACCESS_KEY | MinIO访问密钥 | server/dev |
| minioSecretKey | CSS_MINIO_SECRET_KEY | MinIO秘密密钥 | server/dev |
| minioEndpoint | CSS_MINIO_ENDPOINT | MinIO端点 | server/dev |
| minioBucketName | CSS_MINIO_BUCKET_NAME | MinIO桶名 | server/dev |
| redisClient | CSS_REDIS_CLIENT | Redis连接URL | server |
| redisUsername | CSS_REDIS_USERNAME | Redis用户名 | server可选 |
| redisPassword | CSS_REDIS_PASSWORD | Redis密码 | server可选 |
| emailConfigHost | CSS_EMAIL_CONFIG_HOST | SMTP主机 | 可选 |
| emailConfigPort | CSS_EMAIL_CONFIG_PORT | SMTP端口 | 可选 |
| emailConfigAuthUser | CSS_EMAIL_CONFIG_AUTH_USER | SMTP用户 | 可选 |
| emailConfigAuthPass | CSS_EMAIL_CONFIG_AUTH_PASS | SMTP密码 | 可选 |

**resolver.json 配置：**
```json
{
  "CombinedShorthandResolver:_resolvers_key": "urn:solid-server:default:variable:minioAccessKey",
  "CombinedShorthandResolver:_resolvers_value": {
    "@type": "EnvExtractor",
    "envKey": "CSS_MINIO_ACCESS_KEY"
  }
}
```

#### XPOD_ 前缀（Xpod业务功能）

| 内部变量名 | ENV变量 | 说明 | 必需场景 | 可从baseUrl推导 |
|-----------|---------|------|----------|----------------|
| signalEndpoint | XPOD_SIGNAL_ENDPOINT | 集群信号端点 | cluster | ✅ `${baseUrl}api/signal` |
| clusterIngressDomain | XPOD_CLUSTER_INGRESS_DOMAIN | 集群入口域名 | cluster | ✅ hostname from baseUrl |
| clusterIngressIp | XPOD_CLUSTER_INGRESS_IP | 代理入口IP | 可选 | - |
| dnsRootDomain | XPOD_DNS_ROOT_DOMAIN | DNS根域名 | cluster:server | ✅ hostname from baseUrl |
| tencentDnsTokenId | XPOD_TENCENT_DNS_TOKEN_ID | 腾讯DNS Token ID | 可选 | - |
| tencentDnsToken | XPOD_TENCENT_DNS_TOKEN | 腾讯DNS Token | 可选 | - |
| frpServerHost | XPOD_FRP_SERVER_HOST | FRP服务器地址 | 可选 | - |
| frpToken | XPOD_FRP_TOKEN | FRP认证Token | 可选 | - |
| acmeEmail | XPOD_ACME_EMAIL | ACME账户邮箱 | 可选 | - |
| nodeId | XPOD_NODE_ID | 节点ID | cluster:local | - |
| nodeToken | XPOD_NODE_TOKEN | 节点认证Token | cluster:local | - |

**resolver.json 配置：**
```json
{
  "CombinedShorthandResolver:_resolvers_key": "urn:solid-server:default:variable:signalEndpoint",
  "CombinedShorthandResolver:_resolvers_value": {
    "@type": "EnvExtractor",
    "envKey": "XPOD_SIGNAL_ENDPOINT"
  }
}
```

### 3.4 默认值（EnvExtractor的defaultValue或组件里硬编码）

这些参数有合理的默认值，用户一般不需要配置：

| 内部变量名 | 默认值 | 说明 | 处理方式 |
|-----------|--------|------|----------|
| dnsRecordTtl | 60 | DNS TTL秒数 | EnvExtractor defaultValue |
| frpServerPort | 7000 | FRP端口 | EnvExtractor defaultValue |
| frpProtocol | "tcp" | FRP协议 | EnvExtractor defaultValue |
| tencentDnsBaseUrl | "https://dnsapi.cn" | 腾讯DNS API | EnvExtractor defaultValue |
| tencentDnsDefaultLineId | "0" | 默认线路 | EnvExtractor defaultValue |
| edgeHealthProbesEnabled | false | 健康探测开关 | EnvExtractor defaultValue |
| edgeHealthProbeTimeout | 3000 | 探测超时ms | EnvExtractor defaultValue |
| acmeDirectoryUrl | Let's Encrypt URL | ACME端点 | 组件硬编码 |
| acmeDnsPropagationDelay | 60000 | DNS传播等待ms | 组件硬编码 |

**resolver.json 配置（有ENV可覆盖）：**
```json
{
  "CombinedShorthandResolver:_resolvers_key": "urn:solid-server:default:variable:dnsRecordTtl",
  "CombinedShorthandResolver:_resolvers_value": {
    "@type": "EnvExtractor",
    "envKey": "XPOD_DNS_RECORD_TTL",
    "defaultValue": "60"
  }
}
```

### 3.5 推导值（组件内部处理）

这些变量可以从 `baseUrl` 推导，在组件构造函数里处理：

**组件引用已解析的 baseUrl 变量：**
```json
{
  "@type": "ClusterIngressRouter",
  "baseUrl": {
    "@id": "urn:solid-server:default:variable:baseUrl"
  },
  "clusterIngressDomain": {
    "@id": "urn:solid-server:default:variable:clusterIngressDomain"
  }
}
```

**组件构造函数处理推导逻辑：**
```typescript
constructor(options: {
  baseUrl: string;                    // 必传，引用 baseUrl 变量
  clusterIngressDomain?: string;      // 可选，ENV传入
  signalEndpoint?: string;            // 可选，ENV传入
}) {
  // 如果ENV没传，从 baseUrl 推导
  this.clusterIngressDomain = options.clusterIngressDomain
    || new URL(options.baseUrl).hostname;

  this.signalEndpoint = options.signalEndpoint
    || `${options.baseUrl}api/signal`;
}
```

## 四、EnvExtractor 实现

新建 `src/init/EnvExtractor.ts`：

```typescript
import { ShorthandExtractor } from '@solid/community-server';

/**
 * 直接从 process.env 读取环境变量
 * 不走 Yargs，所以可以使用任意前缀（CSS_ 或 XPOD_）
 */
export class EnvExtractor extends ShorthandExtractor {
  private readonly envKey: string;
  private readonly defaultValue?: string;

  public constructor(envKey: string, defaultValue?: string) {
    super();
    this.envKey = envKey;
    this.defaultValue = defaultValue;
  }

  public async handle(args: Record<string, unknown>): Promise<string | undefined> {
    return process.env[this.envKey] ?? this.defaultValue;
  }
}
```

## 五、修改文件清单

### 新建文件

1. `src/init/EnvExtractor.ts` - 环境变量提取器

### 修改文件

2. `src/index.ts` - 导出 EnvExtractor
3. `config/cli.json` - 精简，只保留 `edition` 和 `edgeNodesEnabled`
4. `config/resolver.json` - 重写：
   - CLI参数用 `KeyExtractor`
   - ENV参数用 `EnvExtractor`
   - 默认值通过 `defaultValue` 参数

### 更新ENV文件

5. `.env.cluster` - 使用新的变量名
6. `.env.cluster.local` - 使用新的变量名
7. `.env.server` - 如有 CSS_XPOD_* 需改为 XPOD_*
8. `example.env` - 更新示例

## 六、ENV文件示例

### .env.cluster (cluster:server)

```bash
# CSS原生
CSS_BASE_URL=http://localhost:3100/
CSS_PORT=3100
CSS_SPARQL_ENDPOINT=postgresql://...
CSS_LOGGING_LEVEL=info

# 数据层（CSS_前缀，用EnvExtractor读）
CSS_IDENTITY_DB_URL=postgresql://...
CSS_MINIO_ACCESS_KEY=xxx
CSS_MINIO_SECRET_KEY=xxx
CSS_MINIO_ENDPOINT=xxx
CSS_MINIO_BUCKET_NAME=xxx
CSS_REDIS_CLIENT=xxx

# Xpod业务（XPOD_前缀，用EnvExtractor读）
# XPOD_SIGNAL_ENDPOINT=         # 可选，默认从baseUrl推导
# XPOD_CLUSTER_INGRESS_DOMAIN=  # 可选，默认从baseUrl推导
XPOD_DNS_ROOT_DOMAIN=cluster.example.com
XPOD_ACME_EMAIL=admin@example.com
XPOD_TENCENT_DNS_TOKEN_ID=xxx
XPOD_TENCENT_DNS_TOKEN=xxx
```

### .env.cluster.local (cluster:local)

```bash
# CSS原生
CSS_BASE_URL=http://node-local.localhost:3101/
CSS_PORT=3101
CSS_SPARQL_ENDPOINT=sqlite:./quadstore.sqlite
CSS_LOGGING_LEVEL=info

# 数据层（CSS_前缀）
CSS_IDENTITY_DB_URL=sqlite:./identity.sqlite

# Xpod业务（XPOD_前缀）
XPOD_SIGNAL_ENDPOINT=http://localhost:3100/api/signal
XPOD_NODE_ID=node-local
XPOD_NODE_TOKEN=xxx
```

## 七、验证清单

修改完成后验证：

```bash
# 1. 构建
yarn build:ts && yarn build:components

# 2. 检查CLI帮助（应该只有少量新增参数）
yarn server --help

# 3. 测试各模式启动
yarn local
yarn server
yarn cluster:server
yarn cluster:local

# 4. 检查变量是否正确读取
CSS_LOGGING_LEVEL=debug yarn server
```

## 八、变量对照表（完整）

| 内部变量名 | ENV变量 | 提取器 | 默认值 | 可推导 |
|-----------|---------|--------|--------|--------|
| **CLI参数（KeyExtractor）** |
| edition | CSS_EDITION | KeyExtractor | "server" | - |
| edgeNodesEnabled | CSS_EDGE_NODES_ENABLED | KeyExtractor | false | - |
| **数据层（EnvExtractor + CSS_前缀）** |
| identityDbUrl | CSS_IDENTITY_DB_URL | EnvExtractor | - | - |
| minioAccessKey | CSS_MINIO_ACCESS_KEY | EnvExtractor | - | - |
| minioSecretKey | CSS_MINIO_SECRET_KEY | EnvExtractor | - | - |
| minioEndpoint | CSS_MINIO_ENDPOINT | EnvExtractor | - | - |
| minioBucketName | CSS_MINIO_BUCKET_NAME | EnvExtractor | - | - |
| redisClient | CSS_REDIS_CLIENT | EnvExtractor | - | - |
| redisUsername | CSS_REDIS_USERNAME | EnvExtractor | - | - |
| redisPassword | CSS_REDIS_PASSWORD | EnvExtractor | - | - |
| emailConfigHost | CSS_EMAIL_CONFIG_HOST | EnvExtractor | - | - |
| emailConfigPort | CSS_EMAIL_CONFIG_PORT | EnvExtractor | - | - |
| emailConfigAuthUser | CSS_EMAIL_CONFIG_AUTH_USER | EnvExtractor | - | - |
| emailConfigAuthPass | CSS_EMAIL_CONFIG_AUTH_PASS | EnvExtractor | - | - |
| **Xpod业务（EnvExtractor + XPOD_前缀）** |
| signalEndpoint | XPOD_SIGNAL_ENDPOINT | EnvExtractor | - | ✅ baseUrl |
| clusterIngressDomain | XPOD_CLUSTER_INGRESS_DOMAIN | EnvExtractor | - | ✅ baseUrl |
| clusterIngressIp | XPOD_CLUSTER_INGRESS_IP | EnvExtractor | - | - |
| dnsRootDomain | XPOD_DNS_ROOT_DOMAIN | EnvExtractor | - | ✅ baseUrl |
| dnsRecordTtl | XPOD_DNS_RECORD_TTL | EnvExtractor | "60" | - |
| tencentDnsTokenId | XPOD_TENCENT_DNS_TOKEN_ID | EnvExtractor | - | - |
| tencentDnsToken | XPOD_TENCENT_DNS_TOKEN | EnvExtractor | - | - |
| tencentDnsBaseUrl | XPOD_TENCENT_DNS_BASE_URL | EnvExtractor | "https://dnsapi.cn" | - |
| tencentDnsDefaultLineId | XPOD_TENCENT_DNS_DEFAULT_LINE_ID | EnvExtractor | "0" | - |
| frpServerHost | XPOD_FRP_SERVER_HOST | EnvExtractor | - | - |
| frpServerPort | XPOD_FRP_SERVER_PORT | EnvExtractor | "7000" | - |
| frpToken | XPOD_FRP_TOKEN | EnvExtractor | - | - |
| frpProtocol | XPOD_FRP_PROTOCOL | EnvExtractor | "tcp" | - |
| acmeEmail | XPOD_ACME_EMAIL | EnvExtractor | - | - |
| nodeId | XPOD_NODE_ID | EnvExtractor | - | - |
| nodeToken | XPOD_NODE_TOKEN | EnvExtractor | - | - |
| edgeHealthProbesEnabled | XPOD_EDGE_HEALTH_PROBES_ENABLED | EnvExtractor | "false" | - |
| edgeHealthProbeTimeout | XPOD_EDGE_HEALTH_PROBE_TIMEOUT | EnvExtractor | "3000" | - |
| tunnelEntrypoints | XPOD_TUNNEL_ENTRYPOINTS | EnvExtractor | "" | - |
