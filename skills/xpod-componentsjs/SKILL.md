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

## 抽象类和接口的处理

### 关键规则：Generator 只处理导出的类

Components.js Generator (`componentsjs-generator`) 只会为 **从 `src/index.ts` 导出的类** 生成 `.jsonld` 文件。

### 问题场景

当一个类继承抽象基类或实现接口时：

```typescript
// 子类生成的 jsonld 会包含 extends 引用
"extends": ["undefineds:dist/path/to/BaseClass.jsonld#BaseClass"]
```

如果 `BaseClass` 没有被导出，Generator 不会为它生成 jsonld，启动时会报错：

```
Error: Resource .../BaseClass.jsonld#BaseClass is not a valid component
```

### 解决方案

**1. 确保抽象类/基类从 index.ts 导出**

```typescript
// src/index.ts
import { MyBaseClass } from './path/to/MyBaseClass';
import { MyImplClass } from './path/to/MyImplClass';

export default {
  MyBaseClass,      // ← 必须导出基类！
  MyImplClass,
};
```

**2. 使用 abstract class 而不是 interface**

Generator **不会为 TypeScript interface 生成 jsonld**。如果有类 `implements` 一个 interface，必须将 interface 改为 abstract class：

```typescript
// ❌ 错误 - interface 不会生成 jsonld
export interface QuintStore {
  get(pattern: QuintPattern): Promise<Quint[]>;
  put(quint: Quint): Promise<void>;
}

export class MyStore implements QuintStore { ... }
```

```typescript
// ✅ 正确 - abstract class 会生成 jsonld
export abstract class QuintStore {
  abstract get(pattern: QuintPattern): Promise<Quint[]>;
  abstract put(quint: Quint): Promise<void>;
}

export class MyStore extends QuintStore { ... }
```

**3. 子类继承时添加 super() 和 override**

```typescript
export class MyStore extends QuintStore {
  constructor(options: Options) {
    super();  // ← 必须调用 super()
    this.options = options;
  }
  
  override async get(pattern: QuintPattern): Promise<Quint[]> {
    // 如果基类有可选方法的实现，需要 override 修饰符
  }
}
```

### 检查清单

添加新的抽象类/基类时：

- [ ] 使用 `abstract class` 而不是 `interface`
- [ ] 在 `src/index.ts` 中导出该类
- [ ] 子类使用 `extends` 而不是 `implements`
- [ ] 子类构造函数调用 `super()`
- [ ] 覆盖父类方法时添加 `override` 修饰符
- [ ] 运行 `yarn build` 验证 jsonld 生成

## 常见错误诊断

### 错误: Resource is not a valid component

```
Error: Resource .../types.jsonld#QuintStore is not a valid component, 
either it is not defined, has no type, or is incorrectly referenced
```

**原因**: 
1. 使用了 TypeScript interface（Generator 不处理 interface）
2. 抽象类/基类没有从 index.ts 导出

**解决**: 
1. 将 interface 改为 abstract class
2. 在 index.ts 中导出该类
3. 运行 `yarn build`

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
    "https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld"
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

# 检查某个类的 jsonld 是否生成
ls dist/path/to/MyClass.jsonld

# 检查 components.jsonld 是否包含某个类的 import
grep "MyClass" dist/components/components.jsonld
```

## 检查清单

添加新变量时必须完成：

- [ ] `config/cli.json` - 添加 YargsParameter
- [ ] `config/resolver.json` - 添加 KeyExtractor
- [ ] `.env.xxx` - 添加环境变量（如需要）
- [ ] 组件配置文件 - 使用 `"@type": "Variable"` 引用
- [ ] 运行 `yarn build` 重新生成 components

添加新的抽象类/基类时：

- [ ] 使用 `abstract class` 而不是 `interface`
- [ ] 在 `src/index.ts` 中导出该类
- [ ] 子类使用 `extends` 而不是 `implements`
- [ ] 运行 `yarn build` 验证 jsonld 生成
