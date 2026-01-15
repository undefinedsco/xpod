# Xpod Configuration Analysis

## 运行模式分析

Xpod 支持 2 种主要运行模式：

1. **yarn dev / yarn local** - 本地开发模式
   - 配置文件: `config/local.json`
   - 环境文件: `.env.local`
   - 数据库: SQLite
   - 存储: 本地文件系统
   - 认证: 启用
   - 配额: 默认禁用
   - 场景: 桌面应用、个人开发环境

2. **yarn cloud** - 云部署模式
   - 配置文件: `config/cloud.json`
   - 环境文件: `.env.cloud`
   - 数据库: PostgreSQL
   - 存储: MinIO (S3兼容)
   - 缓存: Redis
   - 认证: 启用
   - 配额: 启用
   - 边缘节点: 可选启用
   - 场景: 云部署、生产环境

## 配置文件结构

```
config/
├── main.json              # CSS 核心配置和 Override
├── xpod.base.json         # Xpod 通用组件定义
├── local.json             # 本地开发入口 (imports main.json + xpod.base.json)
├── cloud.json             # 生产部署入口 (imports main.json + xpod.base.json + xpod.cluster.json)
├── xpod.cluster.json      # 集群特定组件
├── cli.json               # CLI 参数定义
├── resolver.json          # 变量解析配置
└── terminal.json          # Terminal 组件配置
```

## 配置参数完整清单

### 一、CSS核心参数

#### 1. 服务器基础配置
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| baseUrl | `-b, --baseUrl` | `CSS_BASE_URL` | CLI优先 | 服务器公网URL，影响标识符生成 |
| port | `-p, --port` | - | CLI/默认3000 | TCP端口号 |
| rootFilePath | `-f, --rootFilePath` | `CSS_ROOT_FILE_PATH` | ENV | 文件存储根目录 |
| loggingLevel | `-l, --loggingLevel` | `CSS_LOGGING_LEVEL` | CLI/ENV | 日志级别(error/warn/info/debug) |

#### 2. 配置文件路径
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| config | `-c, --config` | - | CLI必需 | Components.js配置文件路径 |
| mainModulePath | `-m, --mainModulePath` | - | CLI必需 | Components.js模块查找起点 |
| seedConfig | `--seedConfig` | `CSS_SEED_CONFIG` | ENV/注释 | 测试账户种子文件 |

### 二、数据库配置

#### 1. SPARQL Endpoint (RDF数据)
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| sparqlEndpoint | `-s, --sparqlEndpoint` | `CSS_SPARQL_ENDPOINT` | ENV必需 | SPARQL查询端点URL |

**值格式示例：**
- SQLite: `sqlite:./quadstore.sqlite` (local)
- PostgreSQL: `postgresql://user:pass@host:port/db` (cloud)

#### 2. Identity Database (账户管理)
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| identityDbUrl | 无 | `CSS_IDENTITY_DB_URL` | ENV必需 | 身份账户数据库URL |

### 三、MinIO对象存储配置 (cloud 模式)

| 参数名 | 环境变量 | 配置层级建议 | 说明 |
|--------|----------|-------------|------|
| accessKey | `CSS_MINIO_ACCESS_KEY` | ENV敏感 | MinIO访问密钥 |
| secretKey | `CSS_MINIO_SECRET_KEY` | ENV敏感 | MinIO秘密密钥 |
| endpoint | `CSS_MINIO_ENDPOINT` | ENV | MinIO服务端点 |
| bucketName | `CSS_MINIO_BUCKET_NAME` | ENV | 存储桶名称 |

### 四、Redis缓存配置 (cloud 模式)

| 参数名 | 环境变量 | 配置层级建议 | 说明 |
|--------|----------|-------------|------|
| client | `CSS_REDIS_CLIENT` | ENV | Redis连接URL |
| password | `CSS_REDIS_PASSWORD` | ENV敏感 | Redis密码 |

### 五、邮件服务配置

| 参数名 | 环境变量 | 配置层级建议 | 说明 |
|--------|----------|-------------|------|
| host | `CSS_EMAIL_CONFIG_HOST` | ENV | SMTP服务器地址 |
| port | `CSS_EMAIL_CONFIG_PORT` | ENV | SMTP端口 |
| authUser | `CSS_EMAIL_CONFIG_AUTH_USER` | ENV | SMTP认证用户 |
| authPass | `CSS_EMAIL_CONFIG_AUTH_PASS` | ENV敏感 | SMTP认证密码 |

### 六、Xpod边缘节点配置 (cloud 模式)

#### 1. 基础开关
| 参数名 | 环境变量 | 配置层级建议 | 说明 |
|--------|----------|-------------|------|
| edgeNodesEnabled | `CSS_XPOD_EDGE_NODES_ENABLED` | ENV | 边缘节点功能总开关 |
| healthProbesEnabled | `CSS_XPOD_EDGE_HEALTH_PROBES_ENABLED` | ENV/默认false | 健康探测开关 |

#### 2. DNS配置
| 参数名 | 环境变量 | 配置层级建议 | 说明 |
|--------|----------|-------------|------|
| dnsRootDomain | `CSS_XPOD_DNS_ROOT_DOMAIN` | ENV必需 | 集群根域名 |
| dnsRecordTtl | `CSS_XPOD_DNS_RECORD_TTL` | ENV/默认300 | DNS记录TTL(秒) |

## 两种模式配置矩阵

| 配置项 | local | cloud |
|--------|-------|-------|
| **配置文件** | local.json | cloud.json |
| **ENV文件** | .env.local | .env.cloud |
| **数据库** | SQLite(文件) | PostgreSQL |
| **存储** | 本地FS | MinIO |
| **缓存** | 无 | Redis |
| **认证** | ✅ | ✅ |
| **邮件** | 可选 | ✅ |
| **配额** | ❌ | ✅ |
| **边缘节点** | ❌ | 可选✅ |

## 配置优先级规则

1. **CLI参数** > **ENV变量** > **配置文件默认值**
2. 同一参数存在多个来源时，高优先级覆盖低优先级
3. CSS原生参数遵循CSS规则
4. Xpod扩展参数遵循上述约定

## 安全考虑

### 敏感变量标记
所有包含密码、密钥、Token的变量应：
1. 在文档中明确标记
2. 示例值使用占位符（如 `your-secret-key`）
3. 生产环境从密钥管理服务读取

### 建议的敏感变量：
- `CSS_MINIO_SECRET_KEY`
- `CSS_REDIS_PASSWORD`
- `CSS_EMAIL_CONFIG_AUTH_PASS`
- `CSS_XPOD_TENCENT_DNS_TOKEN`
- `CSS_XPOD_FRP_TOKEN`
- `CSS_SPARQL_ENDPOINT` (包含数据库密码)
- `CSS_IDENTITY_DB_URL` (包含数据库密码)
