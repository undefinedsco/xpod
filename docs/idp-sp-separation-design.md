# IdP/SP 分离架构设计 (子域名版)

## 架构概述

### DNS 配置

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                              DNS 配置                                           │
│  id.undefineds.co              → Cloud IP (IdP)                               │
│  *.pods.undefineds.site        → Cloud IP (Cluster Ingress)                   │
│  {node-id}.pods.undefineds.site → Local Node IP (SP)                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 多节点 SP 架构

```
                                    ┌─────────────────────────────────────┐
                                    │  IdP (id.undefineds.co)             │
                                    │  ┌─────────────────────────────┐    │
                                    │  │ WebID Profile 托管           │    │
                                    │  │ /.account/, /.oidc/         │    │
                                    │  └─────────────────────────────┘    │
                                    │              │                      │
                                    │              ▼                      │
                                    │  ┌─────────────────────────────┐    │
                                    │  │ alice WebID Profile          │    │
                                    │  │ solid:storage →             │    │
                                    │  │ https://node1.pods.         │    │
                                    │  │   undefineds.site/alice/    │    │
                                    │  └─────────────────────────────┘    │
                                    └──────────────┬──────────────────────┘
                                                   │
                      ┌────────────────────────────┼────────────────────────────┐
                      │                            │                            │
                      ▼                            ▼                            ▼
┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌─────────────────────────────┐
│  SP (node1.pods.undefineds  │  │  SP (node2.pods.undefineds  │  │  SP (node3.pods.undefineds  │
│     .site)                  │  │     .site)                  │  │     .site)                  │
│                             │  │                             │  │                             │
│  ┌───────────────────────┐  │  │  ┌───────────────────────┐  │  │  ┌───────────────────────┐  │
│  │ /alice/               │  │  │  │ /bob/                 │  │  │  │ /charlie/             │  │
│  │ Pod 数据存储           │  │  │  │ Pod 数据存储           │  │  │  │ Pod 数据存储           │  │
│  └───────────────────────┘  │  │  └───────────────────────┘  │  │  └───────────────────────┘  │
│                             │  │                             │  │                             │
│  Token 验证 (IdP JWKS)      │  │  Token 验证 (IdP JWKS)      │  │  Token 验证 (IdP JWKS)      │
│                             │  │                             │  │                             │
└─────────────────────────────┘  └─────────────────────────────┘  └─────────────────────────────┘
```

## 数据模型

### WebID Profile (IdP 托管)

```turtle
# https://id.undefineds.co/alice/profile/card
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<#me>
    a foaf:Person;
    foaf:name "Alice";
    solid:oidcIssuer <https://id.undefineds.co/>;
    solid:storage <https://node1.pods.undefineds.site/alice/>.
```

### 数据库表 (IdP)

```sql
-- WebID Profile 表
CREATE TABLE webid_profiles (
    username TEXT PRIMARY KEY,      -- alice
    webid_url TEXT NOT NULL,        -- https://id.undefineds.co/alice/profile/card#me
    storage_url TEXT,               -- https://node1.pods.undefineds.site/alice/
    storage_mode TEXT DEFAULT 'local-node', -- 'local-node' | 'cloud' | 'external'
    node_id TEXT,                   -- node1 (关联的 Local 节点)
    oidc_issuer TEXT NOT NULL,      -- https://id.undefineds.co/
    account_id TEXT,                -- 关联的账户 ID
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- Local Node (SP) 注册表
CREATE TABLE local_nodes (
    node_id TEXT PRIMARY KEY,       -- node1
    domain TEXT NOT NULL,           -- node1.pods.undefineds.site
    owner_account_id TEXT NOT NULL, -- 谁拥有这个节点
    status TEXT DEFAULT 'active',   -- active | inactive | suspended
    created_at TIMESTAMP,
    last_seen_at TIMESTAMP
);
```

## 组件设计

### 1. SP 端组件

#### ExternalIdpTokenValidator

```typescript
// src/identity/ExternalIdpTokenValidator.ts
import { OidcHttpHandler } from '@solid/community-server';

export interface ExternalIdpTokenValidatorOptions {
  /** 外部 IdP 的 JWKS URL */
  jwksUrl: string;
  /** 外部 IdP 的 issuer URL */
  issuerUrl: string;
  /** 缓存 JWKS 的时间 (ms) */
  jwksCacheMs?: number;
}

/**
 * 外部 IdP Token 验证器
 *
 * 与标准 OidcHttpHandler 的区别：
 * 1. 只验证 token，不处理授权码流程
 * 2. 从外部 IdP 获取 JWKS
 * 3. 不支持用户登录交互
 */
export class ExternalIdpTokenValidator extends OidcHttpHandler {
  private readonly jwksUrl: string;
  private readonly issuerUrl: string;
  private jwksCache?: { keys: JWK[]; expiresAt: number };

  constructor(options: ExternalIdpTokenValidatorOptions) {
    super();
    this.jwksUrl = options.jwksUrl;
    this.issuerUrl = options.issuerUrl;
  }

  /**
   * 只处理 token 验证相关的请求
   */
  public async canHandle(input: HttpHandlerInput): Promise<void> {
    const url = input.request.url ?? '';
    // 只处理 /.oidc/jwks (代理到外部 IdP)
    if (url.startsWith('/.oidc/jwks')) {
      return;
    }
    // 其他 OIDC 请求不支持
    if (url.startsWith('/.oidc/') || url.startsWith('/idp/')) {
      throw new NotImplementedHttpError('External IdP mode: authentication handled by IdP');
    }
    throw new NotImplementedHttpError('Not an OIDC request');
  }

  /**
   * 返回外部 IdP 的 JWKS
   */
  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const jwks = await this.fetchJwks();
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(jwks));
  }

  /**
   * 获取并缓存 JWKS
   */
  private async fetchJwks(): Promise<{ keys: JWK[] }> {
    if (this.jwksCache && this.jwksCache.expiresAt > Date.now()) {
      return { keys: this.jwksCache.keys };
    }
    const response = await fetch(this.jwksUrl);
    const jwks = await response.json();
    this.jwksCache = {
      keys: jwks.keys,
      expiresAt: Date.now() + (this.options.jwksCacheMs ?? 300000)
    };
    return jwks;
  }
}
```

#### ExternalIdpWebIdExtractor

```typescript
// src/identity/ExternalIdpWebIdExtractor.ts
import { DPoPWebIdExtractor } from '@solid/community-server';

export interface ExternalIdpWebIdExtractorOptions {
  /** 信任的 IdP 列表 */
  trustedIdPs: string[];
}

/**
 * 扩展 DPoP WebId Extractor
 *
 * 1. 验证 token 来自信任的 IdP
 * 2. 验证 WebID 的 solid:oidcIssuer 匹配 token 的 iss
 */
export class ExternalIdpWebIdExtractor extends DPoPWebIdExtractor {
  private readonly trustedIdPs: Set<string>;

  constructor(options: ExternalIdpWebIdExtractorOptions) {
    super();
    this.trustedIdPs = new Set(options.trustedIdPs);
  }

  protected async verifyToken(token: string, dpopProof?: string): Promise<TokenPayload> {
    const payload = await super.verifyToken(token, dpopProof);

    // 验证 issuer 是信任的 IdP
    const issuer = payload.iss;
    if (!this.trustedIdPs.has(issuer)) {
      throw new UnauthorizedHttpError(`Untrusted IdP: ${issuer}`);
    }

    // 验证 WebID 的 oidcIssuer 匹配 token 的 iss
    const webId = payload.webid || payload.sub;
    const webIdIssuer = await this.fetchWebIdOidcIssuer(webId);
    if (webIdIssuer !== issuer) {
      throw new UnauthorizedHttpError(
        `WebID issuer mismatch: expected ${webIdIssuer}, got ${issuer}`
      );
    }

    return payload;
  }

  /**
   * 获取 WebID Profile 中的 solid:oidcIssuer
   */
  private async fetchWebIdOidcIssuer(webId: string): Promise<string> {
    // 解析 WebID URL
    const webIdUrl = new URL(webId);
    // 如果 WebID 在 IdP 域名下，直接信任
    if (this.trustedIdPs.has(`${webIdUrl.protocol}//${webIdUrl.host}/`)) {
      // 从 WebID Profile 获取 oidcIssuer
      const profileUrl = webId.replace('#me', '');
      const response = await fetch(profileUrl, {
        headers: { Accept: 'text/turtle' }
      });
      // 解析 turtle 获取 solid:oidcIssuer
      // ... (简化处理)
      return `${webIdUrl.protocol}//${webIdUrl.host}/`;
    }
    throw new UnauthorizedHttpError(`WebID not hosted by trusted IdP: ${webId}`);
  }
}
```

### 2. IdP 端组件

#### StorageProviderHandler

```typescript
// src/api/handlers/StorageProviderHandler.ts
/**
 * SP 注册和管理 API
 */
export function registerStorageProviderRoutes(server: ApiServer, options: HandlerOptions): void {
  /**
   * POST /api/v1/storage-providers
   *
   * 注册新的 Storage Provider
   * Request: { domain: "pods.undefineds.site", url: "https://pods.undefineds.site" }
   */
  server.post('/api/v1/storage-providers', async (request, response) => {
    // 验证用户身份
    // 创建 SP 记录
    // 生成 SP 注册凭证
  });

  /**
   * POST /api/v1/storage-providers/{domain}/pods
   *
   * 在指定 SP 上创建 Pod
   * Request: { username: "alice" }
   */
  server.post('/api/v1/storage-providers/:domain/pods', async (request, response, params) => {
    // 验证用户身份
    // 检查用户名是否可用
    // 调用 SP API 创建 Pod
    // 更新 WebID Profile 的 storage 指针
  });

  /**
   * PUT /api/v1/profiles/{username}/storage
   *
   * 更新用户的 storage 指针
   */
  server.put('/api/v1/profiles/:username/storage', async (request, response, params) => {
    // 验证用户身份
    // 验证 storage URL 是否指向已注册的 SP
    // 更新 storage 指针
  });
}
```

## 配置文件

### SP 配置 (node-id.pods.undefineds.site)

每个 Local 节点使用子域名，支持多租户 Pod 存储。

```json
// config/local-storage-provider.json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld",
    "https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld"
  ],
  "import": [
    "./local.json"
  ],
  "@graph": [
    {
      "comment": "Override: 使用外部 IdP Token 验证",
      "@type": "Override",
      "overrideInstance": {
        "@id": "urn:solid-server:default:OidcHandler"
      },
      "overrideParameters": {
        "@type": "ExternalIdpTokenValidator",
        "ExternalIdpTokenValidator:_options_jwksUrl": "https://id.undefineds.co/.oidc/jwks",
        "ExternalIdpTokenValidator:_options_issuerUrl": "https://id.undefineds.co/",
        "ExternalIdpTokenValidator:_options_jwksCacheMs": 300000
      }
    },
    {
      "comment": "Override: 禁用账户管理 (SP 不提供注册/登录)",
      "@type": "Override",
      "overrideInstance": {
        "@id": "urn:solid-server:default:IdentityProviderHandler"
      },
      "overrideParameters": {
        "@type": "StaticThrowHandler",
        "factory": { "@id": "urn:solid-server:default:UnsupportedErrorFactory" }
      }
    },
    {
      "comment": "Override: 禁用账户创建 API",
      "@type": "Override",
      "overrideInstance": {
        "@id": "urn:solid-server:default:AccountStore"
      },
      "overrideParameters": {
        "@type": "StaticThrowHandler"
      }
    },
    {
      "comment": "Override: 使用外部 IdP WebId Extractor",
      "@type": "Override",
      "overrideInstance": {
        "@id": "urn:solid-server:default:CredentialsExtractor"
      },
      "overrideParameters": {
        "@type": "ExternalIdpWebIdExtractor",
        "ExternalIdpWebIdExtractor:_options_trustedIdPs": [
          "https://id.undefineds.co/"
        ]
      }
    },
    {
      "comment": "Override: 使用子域名标识策略 (支持 node-id.pods.undefineds.site/{pod}/)",
      "@type": "Override",
      "overrideInstance": {
        "@id": "urn:solid-server:default:IdentifierStrategy"
      },
      "overrideParameters": {
        "@type": "SubdomainPodIdentifierStrategy",
        "SubdomainPodIdentifierStrategy:_options_baseDomain": "pods.undefineds.site"
      }
    },
    {
      "comment": "SP 基础配置 - 子域名由运行环境注入 (如 node1.pods.undefineds.site)",
      "@id": "urn:solid-server:default:variable:baseUrl",
      "@type": "Variable"
    },
    {
      "comment": "禁用 Pod 创建 (由 IdP 管理，通过 API 创建)",
      "@id": "urn:solid-server:default:variable:registration",
      "@value": false
    }
  ]
}
```

### 新组件: SubdomainPodIdentifierStrategy

支持从子域名提取 node-id，并验证请求路径匹配 Pod 结构。

```typescript
// src/util/identifiers/SubdomainPodIdentifierStrategy.ts
export interface SubdomainPodIdentifierStrategyOptions {
  /** 基础域名，如 pods.undefineds.site */
  baseDomain: string;
}

/**
 * 子域名 Pod 标识策略
 *
 * 支持格式:
 * - {node-id}.pods.undefineds.site/{username}/resource
 *
 * 示例:
 * - https://node1.pods.undefineds.site/alice/data.ttl
 * - https://node1.pods.undefineds.site/bob/profile/card
 */
export class SubdomainPodIdentifierStrategy extends BaseIdentifierStrategy {
  private readonly baseDomain: string;

  constructor(options: SubdomainPodIdentifierStrategyOptions) {
    super();
    this.baseDomain = options.baseDomain.toLowerCase();
  }

  public supportsIdentifier(identifier: ResourceIdentifier): boolean {
    try {
      const url = new URL(identifier.path);
      const hostname = url.hostname.toLowerCase();

      // 必须匹配 *.pods.undefineds.site
      if (!hostname.endsWith(`.${this.baseDomain}`)) {
        return false;
      }

      // 提取 node-id
      const nodeId = this.extractNodeId(hostname);
      if (!nodeId) {
        return false;
      }

      // 路径必须以 /{username}/ 开头
      const pathMatch = url.pathname.match(/^\/([^\/]+)(\/|$)/);
      if (!pathMatch) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从 hostname 提取 node-id
   * node1.pods.undefineds.site -> node1
   */
  private extractNodeId(hostname: string): string | undefined {
    const suffix = `.${this.baseDomain}`;
    if (!hostname.endsWith(suffix)) {
      return undefined;
    }
    const nodeId = hostname.slice(0, -suffix.length);
    return nodeId || undefined;
  }

  /**
   * 从 identifier 提取 Pod 名称
   * /alice/data.ttl -> alice
   */
  public getPodName(identifier: ResourceIdentifier): string | undefined {
    const match = identifier.path.match(/^https:\/\/[^\/]+\/([^\/]+)/);
    return match?.[1];
  }
}
```

### IdP 配置 (id.undefineds.co)

```json
// config/cloud-idp.json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld",
    "https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld"
  ],
  "import": [
    "./cloud.json"
  ],
  "@graph": [
    {
      "comment": "IdP 专用配置",
      "@id": "urn:solid-server:default:variable:baseUrl",
      "@value": "https://id.undefineds.co"
    },
    {
      "comment": "启用 WebID Profile 托管",
      "@type": "Override",
      "overrideInstance": {
        "@id": "urn:solid-server:default:BaseHttpHandler"
      },
      "overrideParameters": {
        "@type": "StatusWaterfallHandler",
        "handlers": [
          { "@id": "urn:solid-server:default:StaticAssetHandler" },
          { "@id": "urn:solid-server:default:OidcHandler" },
          { "@id": "urn:solid-server:default:NotificationHttpHandler" },
          { "@id": "urn:solid-server:default:StorageDescriptionHandler" },
          { "@id": "urn:solid-server:default:AuthResourceHttpHandler" },
          { "@id": "urn:solid-server:default:IdentityProviderHandler" },
          {
            "comment": "WebID Profile Handler",
            "@id": "urn:undefineds:xpod:WebIdProfileHandler"
          }
        ]
      }
    }
  ]
}
```

## 数据流

### 1. 用户访问 Pod 数据 (子域名方式)

```
┌─────────┐     ┌──────────────────────────────┐     ┌──────────────────┐
│  User   │────▶│  SP                          │────▶│  IdP (JWKS)      │
│  Agent  │     │  node1.pods.undefineds.site  │     │  id.undefineds   │
└─────────┘     └──────────────────────────────┘     └──────────────────┘
                      │
                      │ 1. GET /alice/data.ttl
                      │    Host: node1.pods.undefineds.site
                      │    Authorization: DPoP ...
                      │
                      ▼
                ┌──────────────────┐
                │ SubdomainPod     │
                │ IdentifierStrategy
                │ 提取 pod: alice  │
                └──────────────────┘
                      │
                      │ 2. 从 IdP 获取 JWKS
                      │    GET https://id.undefineds.co/.oidc/jwks
                      │
                      ▼
                ┌──────────────────┐
                │ 验证 DPoP Token  │
                │ - 签名 (JWKS)    │
                │ - issuer         │
                │ - webid          │
                └──────────────────┘
                      │
                      │ 3. 验证 WebID 的 storage
                      │    匹配当前节点域名
                      │
                      ▼
                ┌──────────────────┐
                │ 返回 /alice/data │
                └──────────────────┘
```

### 2. Pod 创建流程 (子域名方式)

```
┌─────────┐     ┌──────────────────┐     ┌──────────────────────────────┐
│  User   │────▶│  IdP             │────▶│  SP                          │
│         │     │  id.undefineds   │     │  node1.pods.undefineds.site  │
└─────────┘     └──────────────────┘     └──────────────────────────────┘
                      │
                      │ 1. POST /api/v1/pods
                      │    {
                      │      username: "alice",
                      │      nodeId: "node1",
                      │      domain: "node1.pods.undefineds.site"
                      │    }
                      │
                      ▼
                ┌──────────────────┐
                │ 创建 WebID       │
                │ Profile          │
                │                  │
                │ solid:storage →  │
                │ https://node1.   │
                │   pods.undefined │
                │   .site/alice/   │
                └──────────────────┘
                      │
                      │ 2. 调用 SP API 创建 Pod
                      │    POST https://node1.pods.undefineds.site/api/v1/pods
                      │    Authorization: Bearer {IdP service token}
                      │    { username: "alice" }
                      │
                      ▼
                ┌──────────────────┐
                │ SP 创建          │
                │ /alice/ 目录     │
                │ (基于子域名策略)  │
                └──────────────────┘
                      │
                      ▼
                ┌──────────────────┐
                │ 返回 Pod URL     │
                │ node1.pods...    │
                └──────────────────┘
```

### 3. DNS 和路由流程

```
┌─────────────┐     ┌─────────────────────┐     ┌──────────────────────────┐
│  DNS 查询   │     │  Cluster Ingress    │     │  Local Node              │
│             │     │  (Cloud)            │     │  (SP)                    │
└─────────────┘     └─────────────────────┘     └──────────────────────────┘

1. 查询 node1.pods.undefineds.site
   ↓
2. 返回 Local Node IP (若已注册)
   或 Cloud IP (通过 tunnel 代理)
   ↓
3. 请求直达 Local Node
   GET /alice/data.ttl
   Host: node1.pods.undefineds.site
   ↓
4. Local Node 验证 token 并返回数据
```

## 实现步骤

### Phase 1: SP 端 (node-id.pods.undefineds.site)

1. **创建 SubdomainPodIdentifierStrategy**
   - 支持 `node-id.pods.undefineds.site/{pod}/` 格式
   - 从子域名提取 node-id
   - 从路径提取 pod 名称

2. **创建 ExternalIdpTokenValidator**
   - 代理 JWKS 请求到外部 IdP
   - 缓存 JWKS 避免重复请求
   - 只支持 token 验证，不处理授权码流程

3. **创建 ExternalIdpWebIdExtractor**
   - 扩展 DPoPWebIdExtractor
   - 验证 issuer 是信任的 IdP
   - 验证 WebID 的 `solid:storage` 匹配当前节点域名

4. **创建 Pod 管理 API (供 IdP 调用)**
   ```typescript
   // POST /api/v1/pods
   // Authorization: Bearer {IdP service token}
   // Body: { username: "alice" }
   // Response: { podUrl: "https://node1.pods.undefineds.site/alice/" }

   // DELETE /api/v1/pods/:username
   // 删除 Pod 目录
   ```

5. **配置 Local Node**
   - 设置 `CSS_BASE_URL=https://node1.pods.undefineds.site`
   - 启用 `SubdomainPodIdentifierStrategy`
   - 禁用 OIDC 服务端和账户管理

### Phase 2: IdP 端 (id.undefineds.co)

1. **扩展 WebIdProfileHandler**
   - 支持 storage 指向子域名 SP
   - 验证节点是否注册
   - 管理 Local Node 注册表

2. **创建 LocalNodeService**
   - 注册 Local Node (`node1.pods.undefineds.site`)
   - 分配 Pod 到指定节点
   - 调用 SP API 创建 Pod

3. **创建 IdP Service Token**
   - 用于 IdP 调用 SP API
   - 预共享密钥或 mTLS

### Phase 3: DNS 和集群配置

1. **配置 DNS**
   - `*.pods.undefineds.site` → Cluster Ingress (Cloudflare Tunnel)
   - `node1.pods.undefineds.site` → Local IP (DDNS)

2. **ClusterIngressRouter 支持**
   - 识别 `*.pods.undefineds.site`
   - 根据 DDNS 记录路由到 Local Node
   - 或降级到 Tunnel 模式

### Phase 4: 集成测试

1. **端到端测试**
   ```
   1. Local Node 启动，注册 DDNS: node1.pods.undefineds.site
   2. 用户访问 IdP: https://id.undefineds.co
   3. 创建 Pod，指定 node1
   4. WebID storage: https://node1.pods.undefineds.site/alice/
   5. 访问 Pod 数据 (经 DDNS 直达 Local Node)
   6. Local Node 验证 IdP token
   7. 返回数据
   ```


## 安全考虑

1. **Token 验证**
   - SP 必须验证 token 签名 (使用 IdP 的 JWKS)
   - SP 必须验证 token 的 `iss` 匹配 WebID 的 `solid:oidcIssuer`
   - SP 必须验证 token 未过期

2. **CORS 配置**
   ```
   IdP: Access-Control-Allow-Origin: https://*.pods.undefineds.site
   SP: Access-Control-Allow-Origin: https://id.undefineds.co
   ```

3. **HTTPS 强制**
   - 所有通信必须使用 HTTPS
   - SP 拒绝 HTTP 请求
   - 证书自动管理 (ACME)

4. **子域名验证**
   - SP 验证请求的 Host 匹配配置的 baseUrl
   - 防止 node-id 伪造攻击

## 部署配置

### 环境变量

#### Local Node (SP)
```bash
# 基础配置
CSS_BASE_URL=https://node1.pods.undefineds.site
CSS_PORT=443

# IdP 配置
XPOD_IDP_URL=https://id.undefineds.co
XPOD_IDP_JWKS_URL=https://id.undefineds.co/.oidc/jwks

# 节点标识
XPOD_NODE_ID=node1
XPOD_BASE_DOMAIN=pods.undefineds.site

# DDNS 配置
XPOD_DDNS_ENABLED=true
```

#### IdP
```bash
CSS_BASE_URL=https://id.undefineds.co
XPOD_ALLOWED_NODE_DOMAINS="*.pods.undefineds.site"
```

### Docker Compose (多节点)

```yaml
# docker-compose.local-cluster.yml
version: '3.8'

services:
  idp:
    image: xpod:idp
    environment:
      CSS_BASE_URL: https://id.undefineds.co
      XPOD_MODE: idp
    ports:
      - "443:443"

  node1:
    image: xpod:sp
    environment:
      CSS_BASE_URL: https://node1.pods.undefineds.site
      XPOD_MODE: storage-provider
      XPOD_IDP_URL: https://id.undefineds.co
      XPOD_NODE_ID: node1
    ports:
      - "3001:3000"

  node2:
    image: xpod:sp
    environment:
      CSS_BASE_URL: https://node2.pods.undefineds.site
      XPOD_MODE: storage-provider
      XPOD_IDP_URL: https://id.undefineds.co
      XPOD_NODE_ID: node2
    ports:
      - "3002:3000"
```

---

**下一步**: 实现 Phase 1 的 SP 端组件 (SubdomainPodIdentifierStrategy, ExternalIdpTokenValidator)
