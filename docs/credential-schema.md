# Credential Schema

本文档定义了 Xpod 中用于存储用户密钥和凭据的统一 Schema，遵循 RDF Schema 标准，并复用 W3C Security Vocabulary 中已定义的属性。

## 命名空间

```turtle
@prefix udfs: <https://undefineds.co/ns#> .
@prefix sec: <https://w3id.org/security#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
```

| 前缀 | 命名空间 | 来源 |
|------|----------|------|
| `udfs:` | `https://undefineds.co/ns#` | 自定义词汇 |
| `sec:` | `https://w3id.org/security#` | W3C Security Vocabulary |
| `rdfs:` | `http://www.w3.org/2000/01/rdf-schema#` | RDF Schema |
| `xsd:` | `http://www.w3.org/2001/XMLSchema#` | XML Schema |

## 属性来源

### 复用 W3C Security Vocabulary (`sec:`)

| 属性 | 用途 | 适用凭据类型 |
|------|------|-------------|
| `sec:privateKeyPem` | PEM 格式私钥 | TlsCredential, SshCredential |
| `sec:publicKeyPem` | PEM 格式公钥/证书 | TlsCredential |
| `sec:password` | 密码 | BasicAuthCredential |
| `sec:expires` | 过期时间 | 所有凭据（可选） |
| `sec:controller` | 控制者/所有者 | 所有凭据（可选） |

### 自定义词汇 (`udfs:`)

| 属性 | 用途 | 说明 |
|------|------|------|
| `udfs:provider` | 供应商标识 | Security Vocab 无此概念 |
| `udfs:service` | 服务类别 | Security Vocab 无此概念 |
| `udfs:apiKey` | API 密钥 | Security Vocab 无此概念 |
| `udfs:token` | Bearer Token | Security Vocab 无此概念 |
| `udfs:accessKeyId` | Access Key ID | AWS 风格，Security Vocab 无此概念 |
| `udfs:secretAccessKey` | Secret Access Key | AWS 风格，Security Vocab 无此概念 |
| `udfs:clientId` | OAuth Client ID | Security Vocab 无此概念 |
| `udfs:clientSecret` | OAuth Client Secret | Security Vocab 无此概念 |
| `udfs:username` | 用户名 | Security Vocab 无此概念 |

---

## Schema 定义

### 类层级

```turtle
@prefix udfs: <https://undefineds.co/ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

# 基类
udfs:CredentialStore a rdfs:Class ;
  rdfs:label "Credential Store" ;
  rdfs:comment "凭据存储容器" .

udfs:Credential a rdfs:Class ;
  rdfs:label "Credential" ;
  rdfs:comment "凭据基类" .

# 子类
udfs:ApiKeyCredential rdfs:subClassOf udfs:Credential ;
  rdfs:label "API Key Credential" ;
  rdfs:comment "单一 API 密钥认证" .

udfs:TokenCredential rdfs:subClassOf udfs:Credential ;
  rdfs:label "Token Credential" ;
  rdfs:comment "Bearer Token 认证" .

udfs:AccessKeyCredential rdfs:subClassOf udfs:Credential ;
  rdfs:label "Access Key Credential" ;
  rdfs:comment "AWS 风格 Access Key 认证" .

udfs:OAuthCredential rdfs:subClassOf udfs:Credential ;
  rdfs:label "OAuth Credential" ;
  rdfs:comment "OAuth 2.0 客户端凭据" .

udfs:BasicAuthCredential rdfs:subClassOf udfs:Credential ;
  rdfs:label "Basic Auth Credential" ;
  rdfs:comment "用户名密码认证" .

udfs:TlsCredential rdfs:subClassOf udfs:Credential ;
  rdfs:label "TLS Credential" ;
  rdfs:comment "TLS 证书和私钥" .

udfs:SshCredential rdfs:subClassOf udfs:Credential ;
  rdfs:label "SSH Credential" ;
  rdfs:comment "SSH 私钥认证" .
```

### 属性定义

```turtle
@prefix udfs: <https://undefineds.co/ns#> .
@prefix sec: <https://w3id.org/security#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# ============================================
# CredentialStore 属性
# ============================================

udfs:credential a rdfs:Property ;
  rdfs:label "credential" ;
  rdfs:domain udfs:CredentialStore ;
  rdfs:range udfs:Credential .

# ============================================
# 通用属性（所有 Credential 子类）
# ============================================

udfs:provider a rdfs:Property ;
  rdfs:label "provider" ;
  rdfs:comment "供应商标识，如 google, openai, aws" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:string .

udfs:service a rdfs:Property ;
  rdfs:label "service" ;
  rdfs:comment "服务类别，如 ai, storage, dns" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:string .

udfs:label a rdfs:Property ;
  rdfs:label "label" ;
  rdfs:comment "用户可读标签" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:string .

udfs:baseUrl a rdfs:Property ;
  rdfs:label "baseUrl" ;
  rdfs:comment "自定义 API 端点" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:anyURI .

# sec:expires - 复用 W3C Security Vocabulary
# sec:controller - 复用 W3C Security Vocabulary

# ============================================
# ApiKeyCredential 属性
# ============================================

udfs:apiKey a rdfs:Property ;
  rdfs:label "apiKey" ;
  rdfs:comment "API 密钥" ;
  rdfs:domain udfs:ApiKeyCredential ;
  rdfs:range xsd:string .

# ============================================
# TokenCredential 属性
# ============================================

udfs:token a rdfs:Property ;
  rdfs:label "token" ;
  rdfs:comment "Bearer Token" ;
  rdfs:domain udfs:TokenCredential ;
  rdfs:range xsd:string .

# ============================================
# AccessKeyCredential 属性
# ============================================

udfs:accessKeyId a rdfs:Property ;
  rdfs:label "accessKeyId" ;
  rdfs:comment "Access Key ID (AWS 风格)" ;
  rdfs:domain udfs:AccessKeyCredential ;
  rdfs:range xsd:string .

udfs:secretAccessKey a rdfs:Property ;
  rdfs:label "secretAccessKey" ;
  rdfs:comment "Secret Access Key (AWS 风格)" ;
  rdfs:domain udfs:AccessKeyCredential ;
  rdfs:range xsd:string .

# ============================================
# OAuthCredential 属性
# ============================================

udfs:clientId a rdfs:Property ;
  rdfs:label "clientId" ;
  rdfs:comment "OAuth 2.0 Client ID" ;
  rdfs:domain udfs:OAuthCredential ;
  rdfs:range xsd:string .

udfs:clientSecret a rdfs:Property ;
  rdfs:label "clientSecret" ;
  rdfs:comment "OAuth 2.0 Client Secret" ;
  rdfs:domain udfs:OAuthCredential ;
  rdfs:range xsd:string .

# ============================================
# BasicAuthCredential 属性
# ============================================

udfs:username a rdfs:Property ;
  rdfs:label "username" ;
  rdfs:comment "用户名" ;
  rdfs:domain udfs:BasicAuthCredential ;
  rdfs:range xsd:string .

# sec:password - 复用 W3C Security Vocabulary

# ============================================
# TlsCredential 属性
# ============================================

# sec:publicKeyPem - 复用 W3C Security Vocabulary (证书)
# sec:privateKeyPem - 复用 W3C Security Vocabulary (私钥)

# ============================================
# SshCredential 属性
# ============================================

# sec:privateKeyPem - 复用 W3C Security Vocabulary

# ============================================
# 配置属性（可选）
# ============================================

udfs:region a rdfs:Property ;
  rdfs:label "region" ;
  rdfs:comment "区域，如 us-east-1" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:string .

udfs:projectId a rdfs:Property ;
  rdfs:label "projectId" ;
  rdfs:comment "项目 ID (Google/Azure)" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:string .

udfs:organizationId a rdfs:Property ;
  rdfs:label "organizationId" ;
  rdfs:comment "组织 ID (OpenAI)" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:string .

udfs:zoneId a rdfs:Property ;
  rdfs:label "zoneId" ;
  rdfs:comment "Zone ID (Cloudflare)" ;
  rdfs:domain udfs:Credential ;
  rdfs:range xsd:string .
```

---

## 存储位置

凭据存储在用户的 `pim:preferencesFile` 指向的文件中：

```turtle
# WebID Profile
<#me> pim:preferencesFile </settings/prefs.ttl> .
```

## 权限

- **读写权限**：仅 WebID Owner 及其授权代理
- **服务端访问**：通过用户 OIDC 认证后，以用户身份读取

---

## 数据模型

### CredentialStore

凭据存储容器，包含多个 Credential。

```turtle
@prefix pim: <http://www.w3.org/ns/pim/space#> .
@prefix udfs: <https://undefineds.co/ns#> .

# /settings/prefs.ttl
<>
  a pim:ConfigurationFile ;
  udfs:credentials <#credentials> .

<#credentials>
  a udfs:CredentialStore ;
  udfs:credential <#cred-google>, <#cred-aws>, <#cred-github> .
```

### 类层级总览

```
udfs:Credential
├── udfs:ApiKeyCredential      # API 密钥 (udfs:apiKey)
├── udfs:TokenCredential       # Bearer Token (udfs:token)
├── udfs:AccessKeyCredential   # AWS 风格 (udfs:accessKeyId, udfs:secretAccessKey)
├── udfs:OAuthCredential       # OAuth 2.0 (udfs:clientId, udfs:clientSecret)
├── udfs:BasicAuthCredential   # 用户名密码 (udfs:username, sec:password)
├── udfs:TlsCredential         # TLS 证书 (sec:publicKeyPem, sec:privateKeyPem)
└── udfs:SshCredential         # SSH 密钥 (sec:privateKeyPem)
```

---

## 凭据类型示例

### ApiKeyCredential

单一 API 密钥认证，适用于大多数 AI 和 SaaS 服务。

**必需属性**：`udfs:provider`、`udfs:apiKey`

```turtle
@prefix udfs: <https://undefineds.co/ns#> .
@prefix sec: <https://w3id.org/security#> .

<#cred-google-ai>
  a udfs:ApiKeyCredential ;
  udfs:provider "google" ;
  udfs:service "ai" ;
  udfs:apiKey "AIzaSy..." ;
  udfs:baseUrl "https://generativelanguage.googleapis.com" ;  # 可选
  sec:expires "2025-12-31T00:00:00Z"^^xsd:dateTime .          # 可选

<#cred-openai>
  a udfs:ApiKeyCredential ;
  udfs:provider "openai" ;
  udfs:service "ai" ;
  udfs:apiKey "sk-..." ;
  udfs:organizationId "org-..." .

<#cred-anthropic>
  a udfs:ApiKeyCredential ;
  udfs:provider "anthropic" ;
  udfs:service "ai" ;
  udfs:apiKey "sk-ant-..." .
```

### TokenCredential

Bearer Token 认证。

**必需属性**：`udfs:provider`、`udfs:token`

```turtle
<#cred-cloudflare>
  a udfs:TokenCredential ;
  udfs:provider "cloudflare" ;
  udfs:service "dns" ;
  udfs:token "..." ;
  udfs:zoneId "..." .
```

### AccessKeyCredential

AWS 风格的 Access Key 认证。

**必需属性**：`udfs:provider`、`udfs:accessKeyId`、`udfs:secretAccessKey`

```turtle
<#cred-aws>
  a udfs:AccessKeyCredential ;
  udfs:provider "aws" ;
  udfs:service "storage" ;
  udfs:accessKeyId "AKIA..." ;
  udfs:secretAccessKey "..." ;
  udfs:region "us-east-1" .

<#cred-minio>
  a udfs:AccessKeyCredential ;
  udfs:provider "minio" ;
  udfs:service "storage" ;
  udfs:accessKeyId "..." ;
  udfs:secretAccessKey "..." ;
  udfs:baseUrl "https://minio.example.com" .
```

### OAuthCredential

OAuth 2.0 客户端凭据。

**必需属性**：`udfs:provider`、`udfs:clientId`、`udfs:clientSecret`

```turtle
<#cred-github>
  a udfs:OAuthCredential ;
  udfs:provider "github" ;
  udfs:service "oauth" ;
  udfs:clientId "..." ;
  udfs:clientSecret "..." .
```

### BasicAuthCredential

用户名密码认证。

**必需属性**：`udfs:provider`、`udfs:username`、`sec:password`

```turtle
<#cred-smtp>
  a udfs:BasicAuthCredential ;
  udfs:provider "sendgrid" ;
  udfs:service "email" ;
  udfs:username "apikey" ;
  sec:password "SG.xxx" .
```

### TlsCredential

TLS 证书和私钥。

**必需属性**：`udfs:provider`、`sec:publicKeyPem`、`sec:privateKeyPem`

```turtle
<#cred-tls>
  a udfs:TlsCredential ;
  udfs:provider "letsencrypt" ;
  sec:publicKeyPem "-----BEGIN CERTIFICATE-----..." ;
  sec:privateKeyPem "-----BEGIN PRIVATE KEY-----..." ;
  sec:expires "2025-12-31T00:00:00Z"^^xsd:dateTime .
```

### SshCredential

SSH 私钥认证。

**必需属性**：`udfs:provider`、`sec:privateKeyPem`

```turtle
<#cred-ssh>
  a udfs:SshCredential ;
  udfs:provider "github" ;
  udfs:service "git" ;
  sec:privateKeyPem "-----BEGIN OPENSSH PRIVATE KEY-----..." .
```

---

## 服务类别

`udfs:service` 用于标识凭据的用途：

| 服务类别 | 说明 | 示例供应商 |
|----------|------|-----------|
| `ai` | AI 服务（embedding、chat） | google, openai, anthropic |
| `storage` | 对象存储 | aws, minio, cloudflare |
| `dns` | DNS 服务 | cloudflare, aws |
| `email` | 邮件服务 | sendgrid, mailgun |
| `oauth` | OAuth 登录 | github, google |
| `git` | Git 服务 | github, gitlab |
| `payment` | 支付服务 | stripe |

## 供应商标识

`udfs:provider` 使用小写标识符：

| 类别 | 供应商 |
|------|--------|
| **AI** | `google`, `openai`, `anthropic`, `azure`, `local` |
| **云存储** | `aws`, `minio`, `cloudflare`, `gcp` |
| **DNS** | `cloudflare`, `aws`, `gcp` |
| **邮件** | `sendgrid`, `mailgun`, `ses` |
| **OAuth** | `github`, `google`, `microsoft` |
| **支付** | `stripe` |

---

## 查询示例

### SPARQL 查询

```sparql
PREFIX udfs: <https://undefineds.co/ns#>
PREFIX sec: <https://w3id.org/security#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

# 获取所有 API Key 凭据
SELECT ?cred ?provider ?apiKey
WHERE {
  ?cred a udfs:ApiKeyCredential ;
        udfs:provider ?provider ;
        udfs:apiKey ?apiKey .
}

# 获取指定供应商的 AI 凭据
SELECT ?cred ?apiKey
WHERE {
  ?cred a udfs:ApiKeyCredential ;
        udfs:provider "google" ;
        udfs:service "ai" ;
        udfs:apiKey ?apiKey .
}

# 获取所有凭据（利用 RDFS 推理）
SELECT ?cred ?provider
WHERE {
  ?cred a/rdfs:subClassOf* udfs:Credential ;
        udfs:provider ?provider .
}

# 获取即将过期的凭据
SELECT ?cred ?provider ?expires
WHERE {
  ?cred a ?type ;
        udfs:provider ?provider ;
        sec:expires ?expires .
  ?type rdfs:subClassOf udfs:Credential .
  FILTER (?expires < "2025-06-01T00:00:00Z"^^xsd:dateTime)
}
```

### TypeScript 接口

```typescript
// 基类
interface Credential {
  '@type': string;
  provider: string;
  service?: string;
  label?: string;
  baseUrl?: string;
  expires?: string;      // sec:expires
  controller?: string;   // sec:controller
  region?: string;
  projectId?: string;
  organizationId?: string;
  zoneId?: string;
}

// 子类
interface ApiKeyCredential extends Credential {
  '@type': 'ApiKeyCredential';
  apiKey: string;
}

interface TokenCredential extends Credential {
  '@type': 'TokenCredential';
  token: string;
}

interface AccessKeyCredential extends Credential {
  '@type': 'AccessKeyCredential';
  accessKeyId: string;
  secretAccessKey: string;
}

interface OAuthCredential extends Credential {
  '@type': 'OAuthCredential';
  clientId: string;
  clientSecret: string;
}

interface BasicAuthCredential extends Credential {
  '@type': 'BasicAuthCredential';
  username: string;
  password: string;      // sec:password
}

interface TlsCredential extends Credential {
  '@type': 'TlsCredential';
  publicKeyPem: string;  // sec:publicKeyPem
  privateKeyPem: string; // sec:privateKeyPem
}

interface SshCredential extends Credential {
  '@type': 'SshCredential';
  privateKeyPem: string; // sec:privateKeyPem
}

// 联合类型
type AnyCredential = 
  | ApiKeyCredential 
  | TokenCredential 
  | AccessKeyCredential 
  | OAuthCredential 
  | BasicAuthCredential 
  | TlsCredential 
  | SshCredential;

// 查询凭据
async function getCredential<T extends AnyCredential>(
  store: CredentialStore,
  type: T['@type'],
  filter: { provider?: string; service?: string }
): Promise<T | null>;
```

---

## 安全考虑

1. **存储位置**：凭据存储在 `preferencesFile` 中，仅 Owner 可访问
2. **传输安全**：所有访问必须通过 HTTPS
3. **访问控制**：服务端通过用户 OIDC Token 以用户身份读取
4. **最小权限**：服务仅读取所需的特定凭据
5. **过期管理**：使用 `sec:expires` 标记凭据过期时间

---

## 相关文档

- [W3C Security Vocabulary](https://w3c-ccg.github.io/security-vocab/) - 复用的安全词汇表
- [Solid WebID Profile](https://solid.github.io/webid-profile/) - preferencesFile 规范
- [RDF Schema](https://www.w3.org/TR/rdf-schema/) - RDFS 规范
- [vector-sidecar.md](./vector-sidecar.md) - Vector Sidecar 设计（使用 AI 凭据）
