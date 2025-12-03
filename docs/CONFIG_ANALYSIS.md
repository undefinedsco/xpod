# Xpod Configuration Analysis

## 运行模式分析

Xpod支持4种运行模式：

1. **yarn start (normal)** - 体验模式
   - 配置文件: `config/main.json` + `config/extensions.json`
   - 数据库: SQLite (内存/本地文件)
   - 存储: 本地文件系统
   - 认证: 启用
   - 场景: 快速体验、演示

2. **yarn local** - 本地单机模式
   - 配置文件: `config/main.local.json` + `config/extensions.local.json`
   - 环境文件: `.env.local`
   - 数据库: SQLite
   - 存储: 本地文件系统
   - 认证: 启用
   - 配额: 默认禁用
   - 场景: 桌面应用、个人开发环境

3. **yarn server** - 服务器模式
   - 配置文件: `config/main.server.json` + `config/extensions.server.json`
   - 环境文件: `.env.server`
   - 数据库: PostgreSQL
   - 存储: MinIO (S3兼容)
   - 缓存: Redis
   - 认证: 启用
   - 配额: 启用
   - 边缘节点: 可选启用
   - 场景: 云部署、生产环境

4. **yarn dev** - 开发模式
   - 配置文件: `config/main.dev.json` + `config/extensions.dev.json`
   - 环境文件: `.env.local`
   - 数据库: SQLite
   - 存储: MinIO (用于API调试)
   - 认证: 禁用/简化
   - 场景: 前后端开发调试

## 配置参数完整清单

### 一、CSS核心参数

#### 1. 服务器基础配置
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| baseUrl | `-b, --baseUrl` | `CSS_BASE_URL` | CLI优先 | 服务器公网URL，影响标识符生成 |
| port | `-p, --port` | - | CLI/默认3000 | TCP端口号 |
| socket | `--socket` | - | CLI可选 | Unix Domain Socket路径 |
| rootFilePath | `-f, --rootFilePath` | `CSS_ROOT_FILE_PATH` | ENV | 文件存储根目录 |
| loggingLevel | `-l, --loggingLevel` | `CSS_LOGGING_LEVEL` | CLI/ENV | 日志级别(error/warn/info/debug) |
| showStackTrace | `-t, --showStackTrace` | `CSS_SHOW_STACK_TRACE` | ENV/默认false | 错误页面显示堆栈 |

#### 2. 配置文件路径
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| config | `-c, --config` | - | CLI必需 | Components.js配置文件路径数组 |
| mainModulePath | `-m, --mainModulePath` | - | CLI必需 | Components.js模块查找起点 |
| podConfigJson | `--podConfigJson` | `CSS_POD_CONFIG_JSON` | ENV | 动态Pod配置存储路径 |
| seedConfig | `--seedConfig` | `CSS_SEED_CONFIG` | ENV/注释 | 测试账户种子文件 |

#### 3. 多线程配置
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| workers | `-w, --workers` | `CSS_WORKERS` | ENV/默认1 | Worker线程数(-1=cores-1, 0=cores) |

### 二、数据库配置

#### 1. SPARQL Endpoint (RDF数据)
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| sparqlEndpoint | `-s, --sparqlEndpoint` | `CSS_SPARQL_ENDPOINT` | ENV必需 | SPARQL查询端点URL |

**值格式示例：**
- SQLite: `sqlite:./quadstore.sqlite` (local/dev)
- PostgreSQL: `postgresql://user:pass@host:port/db` (server)
- MySQL: `mysql://user:pass@host:port/db`

**模式差异：**
- local/dev: SQLite，路径相对于工作目录
- server: PostgreSQL，远程连接

#### 2. Identity Database (账户管理)
| 参数名 | CLI选项 | 环境变量 | 配置层级建议 | 说明 |
|--------|---------|----------|-------------|------|
| identityDbUrl | 无 | `CSS_IDENTITY_DB_URL` | ENV必需 | 身份账户数据库URL |

**值格式：** 同 sparqlEndpoint

**模式差异：**
- local/dev: 通常共享 SQLite 文件或使用 `:memory:`
- server: PostgreSQL，可与 SPARQL 共享数据库或独立

### 三、MinIO对象存储配置

| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| accessKey | `CSS_MINIO_ACCESS_KEY` | ENV敏感 | MinIO访问密钥 | server/dev |
| secretKey | `CSS_MINIO_SECRET_KEY` | ENV敏感 | MinIO秘密密钥 | server/dev |
| endpoint | `CSS_MINIO_ENDPOINT` | ENV | MinIO服务端点 | server/dev |
| bucketName | `CSS_MINIO_BUCKET_NAME` | ENV | 存储桶名称 | server/dev |

**模式差异：**
- local: 不使用MinIO，纯本地文件系统
- dev: 使用MinIO用于调试API
- server: 生产MinIO，支持分布式存储

### 四、Redis缓存配置

| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| client | `CSS_REDIS_CLIENT` | ENV | Redis连接URL | server |
| username | `CSS_REDIS_USERNAME` | ENV | Redis用户名 | server |
| password | `CSS_REDIS_PASSWORD` | ENV敏感 | Redis密码 | server |

**模式差异：**
- local/dev: 不使用Redis
- server: 用于分布式锁、会话存储

### 五、邮件服务配置

| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| host | `CSS_EMAIL_CONFIG_HOST` | ENV | SMTP服务器地址 | local/server |
| port | `CSS_EMAIL_CONFIG_PORT` | ENV | SMTP端口 | local/server |
| authUser | `CSS_EMAIL_CONFIG_AUTH_USER` | ENV | SMTP认证用户 | local/server |
| authPass | `CSS_EMAIL_CONFIG_AUTH_PASS` | ENV敏感 | SMTP认证密码 | local/server |

**模式差异：**
- dev: 通常不发送真实邮件
- local: 可选配置，用于密码重置等
- server: 必需配置

### 六、Xpod边缘节点配置

#### 1. 基础开关
| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| edgeNodesEnabled | `CSS_XPOD_EDGE_NODES_ENABLED` | ENV | 边缘节点功能总开关 | server |
| healthProbesEnabled | `CSS_XPOD_EDGE_HEALTH_PROBES_ENABLED` | ENV/默认false | 健康探测开关 | server |
| healthProbeTimeout | `CSS_XPOD_EDGE_HEALTH_PROBE_TIMEOUT` | ENV/默认5000 | 探测超时(毫秒) | server |

#### 2. DNS配置
| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| dnsRootDomain | `CSS_XPOD_DNS_ROOT_DOMAIN` | ENV必需 | 集群根域名 | server |
| dnsRecordTtl | `CSS_XPOD_DNS_RECORD_TTL` | ENV/默认300 | DNS记录TTL(秒) | server |

#### 3. 腾讯云DNS (可选DNS提供商)
| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| tencentDnsTokenId | `CSS_XPOD_TENCENT_DNS_TOKEN_ID` | ENV敏感 | 腾讯云Token ID | server |
| tencentDnsToken | `CSS_XPOD_TENCENT_DNS_TOKEN` | ENV敏感 | 腾讯云Token | server |
| tencentDnsBaseUrl | `CSS_XPOD_TENCENT_DNS_BASE_URL` | ENV/默认 | API端点 | server |
| tencentDnsDefaultLineId | `CSS_XPOD_TENCENT_DNS_DEFAULT_LINE_ID` | ENV/默认0 | 默认线路ID | server |

#### 4. FRP隧道配置
| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| frpServerHost | `CSS_XPOD_FRP_SERVER_HOST` | ENV | FRP服务器地址 | server |
| frpServerPort | `CSS_XPOD_FRP_SERVER_PORT` | ENV/默认7000 | FRP服务器端口 | server |
| frpToken | `CSS_XPOD_FRP_TOKEN` | ENV敏感 | FRP认证Token | server |
| frpProtocol | `CSS_XPOD_FRP_PROTOCOL` | ENV/默认tcp | FRP协议类型 | server |

#### 5. 集群入口配置
| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| clusterIngressDomain | `CSS_XPOD_CLUSTER_INGRESS_DOMAIN` | ENV必需 | 集群入口域名 | server |
| clusterIngressIp | `CSS_XPOD_CLUSTER_INGRESS_IP` | ENV可选 | 代理入口IP(可选) | server |

### 七、ACME证书管理配置

| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| acmeEmail | `XPOD_ACME_EMAIL` | ENV必需 | ACME账户邮箱 | server |
| acmeDirectoryUrl | `XPOD_ACME_DIRECTORY_URL` | ENV | ACME服务端点 | server |
| acmeAccountKeyPath | `XPOD_ACME_ACCOUNT_KEY_PATH` | ENV | ACME账户密钥路径 | server |
| acmeCertificateStore | `XPOD_ACME_CERTIFICATE_STORE` | ENV | 证书存储目录 | server |
| acmeDnsPropagationDelay | `XPOD_ACME_DNS_PROPAGATION_DELAY` | ENV/默认15000 | DNS传播等待时间(毫秒) | server |

### 八、多位置探测配置

| 参数名 | 环境变量 | 配置层级建议 | 说明 | 适用模式 |
|--------|----------|-------------|------|----------|
| edgeProbeLocations | `XPOD_EDGE_PROBE_LOCATIONS` | ENV可选 | 探测节点位置列表 | server |

## 配置层级策略建议

### 1. CLI参数 (命令行优先级最高)
**适用场景：** 频繁变动、临时覆盖、开发调试

- `-b, --baseUrl`: 测试不同域名
- `-p, --port`: 端口冲突时快速切换
- `-l, --loggingLevel`: 调试时临时提升日志级别
- `-t, --showStackTrace`: 开发时启用错误堆栈

**推荐实践：**
```bash
# 开发时覆盖端口和日志
yarn server -p 3001 -l debug

# 测试时临时修改base URL
yarn server -b https://test.example.com
```

### 2. ENV环境变量 (持久化配置)
**适用场景：** 部署环境差异、敏感信息、基础设施配置

#### 必需ENV (各模式共同)
- `CSS_SPARQL_ENDPOINT`: 数据库连接
- `CSS_IDENTITY_DB_URL`: 身份数据库

#### 敏感ENV (永远不进git)
- `CSS_MINIO_SECRET_KEY`
- `CSS_REDIS_PASSWORD`
- `CSS_EMAIL_CONFIG_AUTH_PASS`
- `CSS_XPOD_TENCENT_DNS_TOKEN`
- `CSS_XPOD_FRP_TOKEN`

#### 基础设施ENV (环境相关)
- `CSS_MINIO_ENDPOINT`
- `CSS_REDIS_CLIENT`
- `CSS_EMAIL_CONFIG_HOST`

#### 功能开关ENV (根据部署需求)
- `CSS_XPOD_EDGE_NODES_ENABLED`
- `CSS_XPOD_EDGE_HEALTH_PROBES_ENABLED`

### 3. 默认值/配置文件 (最低优先级)
**适用场景：** 常量、合理默认、开发约定

- `CSS_XPOD_DNS_RECORD_TTL=300`
- `CSS_XPOD_EDGE_HEALTH_PROBE_TIMEOUT=5000`
- `CSS_XPOD_FRP_SERVER_PORT=7000`
- `CSS_XPOD_FRP_PROTOCOL=tcp`
- `CSS_XPOD_TENCENT_DNS_BASE_URL=https://dnsapi.cn`

### 4. 不暴露/硬编码 (内部配置)
**适用场景：** 架构决策、内部实现细节

- Components.js配置文件结构
- 存储策略选择 (MixDataAccessor/MinioDataAccessor)
- 内部服务发现端点
- 默认的文件路径约定

## 四种模式配置矩阵

| 配置项 | start (normal) | local | server | dev |
|--------|---------------|-------|--------|-----|
| **配置文件** | main.json | main.local.json | main.server.json | main.dev.json |
| **ENV文件** | 无 | .env.local | .env.server | .env.local |
| **数据库** | SQLite(内存) | SQLite(文件) | PostgreSQL | SQLite(文件) |
| **存储** | 本地FS | 本地FS | MinIO | MinIO |
| **缓存** | 无 | 无 | Redis | 无 |
| **认证** | ✅ | ✅ | ✅ | ❌/简化 |
| **邮件** | ❌ | 可选 | ✅ | ❌ |
| **配额** | ❌ | ❌ | ✅ | ❌ |
| **边缘节点** | ❌ | ❌ | 可选✅ | ❌ |
| **FRP隧道** | ❌ | ❌ | 可选✅ | ❌ |
| **ACME证书** | ❌ | ❌ | 可选✅ | ❌ |

## 需要修改的文件清单

### 1. 文档文件
- **创建**: `docs/CONFIGURATION.md` - 用户配置指南
  - 四种模式说明
  - 参数完整列表
  - 常见配置示例

- **创建**: `docs/ENVIRONMENT_VARIABLES.md` - 环境变量参考
  - 按功能分组的变量说明
  - 默认值说明
  - 安全最佳实践

### 2. 环境文件模板
- **修改**: `example.env` - 完整的环境变量模板
  - 添加所有可配置参数
  - 注释说明默认值
  - 按模式分组

- **创建**: `example.env.local` - local模式专用模板
- **创建**: `example.env.server` - server模式专用模板
- **创建**: `example.env.dev` - dev模式专用模板

### 3. 配置文件
- **检查**: `config/main.*.json` - 确保变量名一致性
- **检查**: `config/extensions.*.json` - 确保默认值合理性

### 4. Package.json
- **修改**: `package.json` scripts部分
  - 统一命令行参数传递方式
  - 添加配置验证脚本

### 5. README
- **修改**: `README.md`
  - 更新配置章节
  - 链接到详细文档

### 6. CLAUDE.md
- **修改**: `CLAUDE.md`
  - 更新配置架构说明
  - 添加配置最佳实践

## 优化建议

### 1. 配置验证工具
创建 `scripts/validate-config.js` 用于：
- 检查必需环境变量
- 验证变量格式（URL、端口等）
- 模式一致性检查
- 生成配置报告

### 2. 配置向导
创建 `scripts/setup-wizard.js` 用于：
- 交互式配置生成
- 根据部署场景推荐配置
- 自动生成 `.env.*` 文件

### 3. 配置文档生成
创建 `scripts/generate-config-docs.js` 用于：
- 从配置文件自动提取变量
- 生成Markdown文档
- 保持文档与代码同步

### 4. 敏感信息管理
- 添加 `.env.*.example` 文件（不含真实值）
- 更新 `.gitignore` 确保 `.env.*` 不进版本控制
- 在CI/CD中使用密钥管理服务

## 配置优先级规则

1. **CLI参数** > **ENV变量** > **配置文件默认值**
2. 同一参数存在多个来源时，高优先级覆盖低优先级
3. CSS原生参数遵循CSS规则
4. Xpod扩展参数遵循上述约定

## 安全考虑

### 敏感变量标记
所有包含密码、密钥、Token的变量应：
1. 在文档中明确标记 🔒
2. 示例值使用占位符（如 `your-secret-key`）
3. 生产环境从密钥管理服务读取

### 建议的敏感变量：
- `CSS_MINIO_SECRET_KEY` 🔒
- `CSS_REDIS_PASSWORD` 🔒
- `CSS_EMAIL_CONFIG_AUTH_PASS` 🔒
- `CSS_XPOD_TENCENT_DNS_TOKEN` 🔒
- `CSS_XPOD_FRP_TOKEN` 🔒
- `CSS_SPARQL_ENDPOINT` 🔒 (包含数据库密码)
- `CSS_IDENTITY_DB_URL` 🔒 (包含数据库密码)

## 下一步行动

1. ✅ 完成配置参数梳理
2. ⏸️ 创建配置文档 (`docs/CONFIGURATION.md`)
3. ⏸️ 更新环境文件模板 (`example.env.*`)
4. ⏸️ 实现配置验证工具
5. ⏸️ 更新README和CLAUDE.md
6. ⏸️ 创建配置向导（可选）
