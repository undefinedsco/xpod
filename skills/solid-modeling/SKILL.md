---
name: solid-modeling
description: Solid/RDF 数据建模专家，处理 Pod 数据结构设计、类继承、属性定义、命名空间等问题
allowed-tools: Read, Write, Edit, Grep, Glob
---

# Solid/RDF 数据建模专家

你是 XPod 项目的 Solid/RDF 数据建模专家。帮助设计符合 Solid 规范和 RDF 最佳实践的数据模型。

## 核心原则

### 数据主权

用户数据存储在用户自己的 Pod 中，服务器不存储用户数据。

### 标准词汇表优先

优先复用已有的标准词汇表，只在必要时定义自定义词汇。

| 用途 | 词汇表 | 前缀 | 导入 |
|------|--------|------|------|
| 自定义 | Undefineds Namespace | `udfs:` | `import { UDFS } from '@/vocab'` |
| RDF 基础 | RDF/RDFS | `rdf:`, `rdfs:` | `import { RDF, RDFS } from '@/vocab'` |
| 时间/元数据 | Dublin Core | `dc:` | `import { DCTerms } from '@/vocab'` |
| 容器/资源 | LDP | `ldp:` | `import { LDP } from '@/vocab'` |
| 个人信息 | FOAF | `foaf:` | `import { FOAF } from '@/vocab'` |
| 访问控制 | ACL | `acl:` | `import { ACL } from '@/vocab'` |
| 数据类型 | XSD | `xsd:` | `import { XSD } from '@/vocab'` |

## 命名规范

### 词汇表命名

| 类型 | 格式 | 示例 |
|------|------|------|
| **Class** | PascalCase (大写开头) | `Credential`, `Provider`, `Model` |
| **Property** | camelCase (小写开头) | `apiKey`, `baseUrl`, `createdAt` |
| **实例 ID** | kebab-case | `#my-entity`, `#instance-001` |

### 使用 Vocab 定义

项目使用 `src/vocab/` 统一管理词汇表：

```typescript
// src/vocab/udfs.ts - UDFS 词汇表
export const UDFS = createNamespace('udfs', 'https://undefineds.co/ns#', {
  // Classes (大写)
  Credential: 'Credential',
  Provider: 'Provider',
  Model: 'Model',

  // Properties (小写)
  apiKey: 'apiKey',
  baseUrl: 'baseUrl',
  status: 'status',
});
```

**使用方式**：

```typescript
import { UDFS, UDFS_NAMESPACE } from '@/vocab';

// 使用 Class
const type = UDFS.Credential;  // 'https://undefineds.co/ns#Credential'

// 使用 Property
const prop = UDFS.apiKey;  // 'https://undefineds.co/ns#apiKey'

// 动态构建 URI
const custom = UDFS('CustomTerm');  // 'https://undefineds.co/ns#CustomTerm'
```

## drizzle-solid Schema 定义

### 基本结构

```typescript
import { podTable, string, uri, datetime, int } from 'drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../vocab';

/**
 * Credential - 凭据
 *
 * 存储位置: /settings/credentials.ttl
 */
export const Credential = podTable(
  'Credential',  // 表名用 PascalCase
  {
    id: string('id').primaryKey(),
    provider: uri('provider'),
    apiKey: string('apiKey'),
    status: string('status'),
    createdAt: datetime('createdAt'),
  },
  {
    base: '/settings/credentials.ttl',
    type: UDFS.Credential,  // 使用 vocab 而不是硬编码字符串
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);
```

### 关系定义

```typescript
import { relations } from 'drizzle-solid';

export const CredentialRelations = relations(Credential, ({ one }) => ({
  provider: one(Provider, {
    fields: [Credential.provider],
    references: [Provider.id],
  }),
}));
```

## 类设计

### 使用 Class 继承表达用途分类

当实体有共同特征但不同用途时，使用 `rdfs:subClassOf`：

```turtle
# 基类
udfs:Provider a rdfs:Class ;
  rdfs:label "Provider" ;
  rdfs:comment "服务供应商基类" .

# 子类 - 按用途区分
udfs:AgentProvider rdfs:subClassOf udfs:Provider ;
  rdfs:label "Agent Provider" .
```

### 用属性区分实现细节

具体实现方式用属性表达，不用子类：

```turtle
# 正确：用属性区分实现类型
<#provider-a> a udfs:Provider ;
  udfs:executorType "claude" .

<#provider-b> a udfs:Provider ;
  udfs:executorType "openai" .

# 错误：不要为每种实现创建子类
# udfs:ClaudeProvider rdfs:subClassOf udfs:Provider .  ❌
```

**规则**：
- Class 继承区分**用途/功能**
- 属性区分**具体实现**

### 定义与实例分离

静态定义（模板）和运行时实例分开建模：

```turtle
# 定义（模板） - 静态配置，描述"是什么"
<#agent-config> a udfs:AgentConfig ;
    udfs:displayName "Indexing Agent" ;
    udfs:systemPrompt "..." .

# 实例 - 运行时状态，描述"正在做什么"
<#agent-status> a udfs:AgentStatus ;
    udfs:agentId "indexing" ;
    udfs:status "running" ;
    udfs:currentTaskId "task-123" .
```

## 属性设计

### 使用 URI 引用关联实体

实体间关系用 URI 引用，不用字符串：

```turtle
# 正确：URI 引用
<#credential> a udfs:Credential ;
  udfs:provider </settings/ai/providers.ttl#google> .

# 错误：字符串值
<#credential> a udfs:Credential ;
  udfs:provider "google" .  ❌
```

### 时间字段统一用 datetime

```typescript
// 正确
createdAt: datetime('createdAt'),
updatedAt: datetime('updatedAt'),

// 错误 - 不要用 string 存时间
startedAt: string('startedAt'),  // ❌
```

### 布尔值

drizzle-solid 目前用 string 存储布尔值：

```typescript
enabled: string('enabled'),  // 存储 "true" / "false"
```

代码中需要手动比较：`enabled === 'true'`

## 文件组织

### 按功能分文件

```
pod:/settings/
├── ai/
│   ├── providers.ttl      # AI 供应商
│   ├── models.ttl         # AI 模型
│   ├── agent-providers.ttl # Agent 供应商
│   ├── agents.ttl         # Agent 配置
│   ├── agent-status.ttl   # Agent 状态
│   ├── config.ttl         # Pod 级 AI 配置
│   ├── vector-stores.ttl  # 向量知识库
│   └── indexed-files.ttl  # 已索引文件
├── credentials.ttl        # 凭据（敏感信息单独存放）
└── prefs.ttl              # 用户偏好设置
```

### 文件引用规则

同文件用 `#fragment`，跨文件用完整路径：

```turtle
# 同文件引用
<#entity-a> udfs:relatedTo <#entity-b> .

# 跨文件引用
<#credential> udfs:provider </settings/ai/providers.ttl#google> .

# 跨 Pod 引用
<#entity-a> udfs:relatedTo <https://other.pod/file.ttl#entity-b> .
```

## 检查清单

设计新数据模型时：

- [ ] 是否有可复用的标准词汇表？
- [ ] 新词汇是否已添加到 `src/vocab/udfs.ts`？
- [ ] Class 名是否大写开头？Property 名是否小写开头？
- [ ] 类继承是否按用途区分（不是按实现）？
- [ ] 定义和实例是否分离？
- [ ] 实体关系是否用 URI 引用（不是字符串）？
- [ ] 时间字段是否用 `datetime()` 类型？
- [ ] 敏感数据是否单独存放？
- [ ] Schema 是否使用 `UDFS.ClassName` 而不是硬编码字符串？

## 参考文件

- **Vocab 定义**: `src/vocab/udfs.ts`, `src/vocab/external.ts`
- **Credential Schema**: `src/credential/schema/tables.ts`
- **Embedding Schema**: `src/embedding/schema/tables.ts`
- **Agent Schema**: `src/agents/schema/`
- **Task Schema**: `src/task/schema.ts`
