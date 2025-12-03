# SPARQL Support

Xpod 支持 **SPARQL 1.1** 规范，提供两种访问方式：Subgraph SPARQL 端点（直接查询）和 LDP PATCH 支持（通过标准 Solid 协议）。

## 1. Subgraph SPARQL 端点

`SubgraphSparqlHttpHandler` 提供 per-account 的 SPARQL 查询端点，支持对 Pod 内 RDF 数据的直接查询和更新。

### 端点模式

使用 `/-/sparql` Sidecar API 模式，权限继承自 `/-/` 之前的资源路径。

| 模式 | 路径示例 | 作用域 |
|------|---------|--------|
| Pod 级 | `/{pod}/-/sparql` | 查询整个 Pod 的 RDF 数据 |
| 目录级 | `/{pod}/{path}/-/sparql` | 查询特定目录下的 RDF 数据 |

详见 [sidecar-api.md](./sidecar-api.md) 了解 `/-/` 路径约定。

### 支持的查询类型

| 查询类型 | HTTP 方法 | 响应格式 |
|----------|-----------|----------|
| SELECT | GET, POST | `application/sparql-results+json` |
| ASK | GET, POST | `application/sparql-results+json` |
| CONSTRUCT | GET, POST | `application/n-quads` |
| DESCRIBE | GET, POST | `application/n-quads` |
| UPDATE | POST only | 204 No Content |

### 请求格式

**GET 请求（查询）**
```
GET /{pod}/-/sparql?query=SELECT%20*%20WHERE%20{%20?s%20?p%20?o%20}
```

**POST 请求（查询）**
```
POST /{pod}/-/sparql
Content-Type: application/sparql-query

SELECT * WHERE { ?s ?p ?o }
```

**POST 请求（更新）**
```
POST /{pod}/-/sparql
Content-Type: application/sparql-update

INSERT DATA { <http://example.org/s> <http://example.org/p> "value" }
```

**表单提交**
```
POST /{pod}/-/sparql
Content-Type: application/x-www-form-urlencoded

query=SELECT+*+WHERE+{+?s+?p+?o+}
```

### 授权模型

Subgraph SPARQL 端点继承 Solid 的 WAC (Web Access Control) 权限模型：

| 操作 | 所需权限 |
|------|----------|
| SELECT, ASK, CONSTRUCT, DESCRIBE | `read` |
| INSERT (UPDATE) | `append` |
| DELETE (UPDATE) | `delete` |

对于复合 UPDATE 操作（同时包含 INSERT 和 DELETE），需要同时具备 `append` 和 `delete` 权限。

### Graph 作用域限制

- UPDATE 操作中的 GRAPH IRI 必须在当前端点的 basePath 范围内
- 不允许使用变量作为 GRAPH 目标
- 违反作用域限制会返回 400 Bad Request

```sparql
# 允许：Graph 在 /alice/ 范围内
INSERT DATA { GRAPH <http://example.org/alice/profile> { ... } }

# 禁止：Graph 超出 /alice/ 范围
INSERT DATA { GRAPH <http://example.org/bob/profile> { ... } }
```

---

## 2. LDP PATCH SPARQL UPDATE 支持

通过标准 Solid LDP PATCH 接口，Xpod 支持将 SPARQL UPDATE 请求直接发送到后端 Quadstore，避免整资源读改写。

### 触发条件

- 后端 DataAccessor 支持 `executeSparqlUpdate` 方法
- PATCH 请求的 Content-Type 为 `application/sparql-update`

### 工作流程

```
┌────────────────┐    PATCH (sparql-update)    ┌───────────────────────┐
│     Client     │ ──────────────────────────► │ SparqlUpdateResourceStore │
└────────────────┘                             └───────────┬───────────┘
                                                           │
                                                           ▼
                                               ┌───────────────────────┐
                                               │ QuadstoreSparqlDataAccessor │
                                               │   executeSparqlUpdate()     │
                                               └───────────┬───────────┘
                                                           │
                                                           ▼
                                               ┌───────────────────────┐
                                               │   Quadstore Backend    │
                                               └───────────────────────┘
```

### Graph 重写

CSS 将 RDF 文档存储在以资源 IRI 命名的 Named Graph 中。PATCH 请求中的 SPARQL UPDATE 会自动重写以匹配目标资源的 Graph：

```sparql
# 客户端发送（Default Graph）
INSERT DATA { <http://example.org/s> <http://example.org/p> "value" }

# 服务端重写为（Named Graph）
INSERT DATA {
  GRAPH <http://example.org/alice/profile.ttl> {
    <http://example.org/s> <http://example.org/p> "value"
  }
}
```

### 支持的 UPDATE 操作

| 操作类型 | 支持状态 |
|----------|----------|
| INSERT DATA | ✓ |
| DELETE DATA | ✓ |
| INSERT ... WHERE | ✓ |
| DELETE ... WHERE | ✓ |
| DELETE/INSERT ... WHERE | ✓ |
| LOAD, CLEAR, CREATE, DROP | ✗ (返回 400) |

### Content-Type 说明

SPARQL UPDATE 直通路径仅处理 `application/sparql-update` Content-Type。其他格式（如 `text/n3` N3 Patch）不受影响，继续使用 CSS 默认处理流程。

---

## 3. 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CSS_SPARQL_ENDPOINT` | Quadstore SPARQL 端点 | `sqlite:./quadstore.sqlite` |
| `CSS_IDENTITY_DB_URL` | Identity 数据库（用于 Pod 查找） | - |

### 配置文件示例

```json
{
  "@type": "SubgraphSparqlHttpHandler",
  "queryEngine": { "@id": "urn:...:SubgraphQueryEngine" },
  "credentialsExtractor": { "@id": "urn:...:CredentialsExtractor" },
  "permissionReader": { "@id": "urn:...:PermissionReader" },
  "authorizer": { "@id": "urn:...:Authorizer" },
  "sidecarPath": "/-/sparql",
  "identityDbUrl": { "@id": "urn:solid-server:default:variable:identityDbUrl" }
}
```

> 注：`sidecarPath` 默认为 `/-/sparql`，通常不需要显式配置。

---

## 4. 相关组件

| 组件 | 路径 | 职责 |
|------|------|------|
| SubgraphSparqlHttpHandler | `src/http/SubgraphSparqlHttpHandler.ts` | SPARQL 查询端点 |
| SparqlUpdateResourceStore | `src/storage/SparqlUpdateResourceStore.ts` | PATCH → SPARQL UPDATE |
| QuadstoreSparqlDataAccessor | `src/storage/accessors/QuadstoreSparqlDataAccessor.ts` | Quadstore 后端 |
| SubgraphQueryEngine | `src/storage/sparql/SubgraphQueryEngine.ts` | 查询执行引擎 |

---

## 5. 限制与注意事项

1. **Subgraph SPARQL 端点仅支持 RDF 数据**：非 RDF 资源（如二进制文件）不可通过 `.sparql` 端点访问

2. **SPARQL UPDATE 限制**：
   - 不支持管理操作（LOAD, CLEAR, CREATE, DROP）
   - Graph IRI 必须在端点作用域内
   - 不支持变量作为 Graph 目标

3. **授权检查**：所有操作都需要通过 Solid WAC 授权检查

4. **部署模式**：
   - Subgraph SPARQL 端点在所有模式下可用
   - SPARQL UPDATE 直通需要后端支持（Quadstore 配置）
