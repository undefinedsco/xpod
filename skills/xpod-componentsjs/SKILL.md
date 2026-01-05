---
name: xpod-componentsjs
description: Xpod Components.js 变量和组件配置专家，处理 CLI 参数、变量解析、组件配置等问题
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# Xpod Components.js 配置专家

你是 Xpod 项目的 Components.js 配置专家。Xpod 基于 Community Solid Server (CSS)，使用 Components.js 进行依赖注入。

## 核心知识

### 变量解析流程

```
环境变量 (CSS_XXX) 
    ↓
YargsCliExtractor (cli.json) - 解析 CLI 参数
    ↓
ShorthandResolver (resolver.json) - 将参数映射到 Components.js 变量
    ↓
Variable (配置文件中) - 在组件配置中引用变量
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `config/cli.json` | 声明 CLI 参数（YargsParameter） |
| `config/resolver.json` | 将 CLI 参数映射到 Components.js 变量（KeyExtractor） |
| `config/*.json` | 使用 `"@type": "Variable"` 引用变量 |
| `dist/components/context.jsonld` | 自动生成的组件 context，包含参数名映射 |

## 添加新变量的完整步骤

### 步骤 1: cli.json 声明参数

```json
// config/cli.json
{
  "@type": "YargsParameter",
  "name": "myNewParam",
  "options": { 
    "type": "string",
    "hidden": true
  }
}
```

参数名使用 camelCase，对应环境变量自动转换：`myNewParam` → `CSS_MY_NEW_PARAM`

### 步骤 2: resolver.json 添加 KeyExtractor（最容易遗漏！）

```json
// config/resolver.json
{
  "CombinedShorthandResolver:_resolvers_key": "urn:solid-server:default:variable:myNewParam",
  "CombinedShorthandResolver:_resolvers_value": {
    "@type": "KeyExtractor",
    "key": "myNewParam",
    "defaultValue": ""
  }
}
```

### 步骤 3: 配置文件中使用变量

```json
{
  "myConfig": {
    "@id": "urn:solid-server:default:variable:myNewParam",
    "@type": "Variable"
  }
}
```

## 常见错误诊断

### 错误: Could not find (valid) component types

```
ErrorResourcesContext: Could not find (valid) component types for config "urn:xxx:MyComponent" among its types, or a requireName
```

**原因**: 新增或重命名了 TypeScript 类，但没有重新生成 Components.js 的 `.jsonld` 组件定义文件
**解决**: 运行完整编译 `npm run build`（不是 `npm run build:ts`），让 `componentsjs-generator` 生成新的 `.jsonld` 文件

```bash
# 错误 - 只编译 TypeScript，不会生成 .jsonld
npm run build:ts

# 正确 - 完整编译，包括 componentsjs-generator
npm run build
```

### 错误: Undefined variable

```
Error: Undefined variable: urn:solid-server:default:variable:xxx
```

**原因**: resolver.json 中缺少对应的 KeyExtractor
**解决**: 在 resolver.json 中添加变量映射

### 错误: Multiple values for parameter

```
ErrorResourcesContext: Detected multiple values for parameter ... YargsCliExtractor_options
```

**原因**: xpod 的 cli.json 和 CSS 的 cli.json 都定义了 `options` 块
**解决**: xpod 的 cli.json 不要添加 `options` 块，CSS 已经配置了 `envVarPrefix` 和 `loadFromEnv`

### 错误: xxx.map is not a function

```
TypeError: options.routes.map is not a function
```

**原因**: 组件参数名格式不正确
**解决**: 查看 `dist/components/context.jsonld` 中的正确参数名，使用简写形式

```json
// 正确
{ "@type": "MyComponent", "routes": [...], "fallback": {...} }

// 错误
{ "@type": "MyComponent", "MyComponent:_options_routes": [...] }
```

## 配置文件 @context 规范

### 正确写法

```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld",
    "https://linkedsoftwaredependencies.org/bundles/npm/@undefineds/xpod/^0.0.0/components/context.jsonld"
  ]
}
```

### 禁止自定义覆盖

不要在 @context 中添加与 dist/components/context.jsonld 冲突的自定义映射。

## 调试命令

```bash
# 验证环境变量加载
node_modules/.bin/dotenv -e .env.cluster -- node -e "console.log(process.env.CSS_MY_PARAM)"

# 直接传递 CLI 参数测试
community-solid-server -c config/xxx.json -m . --myNewParam test-value

# 查看组件参数名
grep -A 10 '"MyComponent"' dist/components/context.jsonld
```

## 检查清单

添加新变量时必须完成：

- [ ] `config/cli.json` - 添加 YargsParameter
- [ ] `config/resolver.json` - 添加 KeyExtractor
- [ ] `.env.xxx` - 添加环境变量（如需要）
- [ ] 组件配置文件 - 使用 `"@type": "Variable"` 引用
- [ ] 运行 `yarn build` 重新生成 components

## 隐藏内部实现

### 推荐做法：内部初始化

私有字段不作为构造参数，而是在类内部初始化（如 `initialize()` 方法中）。这样字段不会出现在生成的 jsonld 的 `constructorArguments` 中。

```typescript
// ✅ 推荐：db 不暴露到 jsonld
export class MyStore {
  private db: Database | null = null;  // 不是构造参数
  
  constructor(connectionString: string) {  // 只暴露必要的配置
    this.connectionString = connectionString;
  }
  
  async initialize() {
    this.db = new Database(this.connectionString);  // 内部创建
  }
}
```

```typescript
// ❌ 不推荐：db 会暴露到 jsonld 的 constructorArguments
export class MyStore {
  constructor(private db: Database) {}
}
```

### 使用 `@ignored` 注解

如果必须从构造函数传入，可以用 `/** @ignored */` 注解：

```typescript
export class MyStore {
  /**
   * @param config - 配置对象
   * @param internalDep - @ignored
   */
  constructor(config: Config, internalDep: InternalService) {}
}
```

### 隐藏整个类

在项目根目录创建 `.componentsjs-generator-config.json`：

```json
{
  "ignoreComponents": ["InternalHelper", "PrivateUtil"],
  "ignorePackagePaths": ["src/internal"]
}
```

## 为 TypeScript 接口创建 jsonld

当类 `implements` 一个 TypeScript 接口时，Components.js Generator 会在 `extends` 中引用该接口的 jsonld。但接口不会自动生成 jsonld，需要**手写**。

### 错误示例

```
Error: Resource .../types.jsonld#QuintStore is not a valid component
```

### 解决方案

1. 在 `components/` 目录手写接口的 jsonld：

```json
// components/types.jsonld
{
  "@context": ["...context.jsonld"],
  "@id": "npmd:@undefineds/xpod",
  "components": [{
    "@id": "npmd:.../types.jsonld#QuintStore",
    "@type": "AbstractClass",
    "requireElement": "QuintStore",
    "parameters": [],
    "constructorArguments": []
  }]
}
```

2. 在 `build:components:fix` 脚本中：
   - 复制到正确的 dist 目录
   - 在 `components.jsonld` 的 import 数组中添加引用

### 关于 memberFields

生成的 jsonld 中 `memberFields` 列出类的所有成员，这只是元数据，**不影响依赖注入**。真正影响注入的是 `parameters` 和 `constructorArguments`。
