# SPARQL Sidecar 通知支持问题

## 背景

SPARQL Sidecar (`SubgraphSparqlHttpHandler`) 提供了一个独立的 SPARQL 端点 (`/-/sparql`)，允许直接对 Pod 数据执行 SPARQL 查询和更新操作。

当前问题：通过 Sidecar 执行 SPARQL UPDATE 时，不会触发 Solid Notifications（WebSocket/SSE），导致订阅该资源的客户端无法收到变更通知。

## 尝试过的方案

### 方案：注入 ActivityEmitter

在 `SubgraphSparqlHttpHandler` 构造函数中注入 `ActivityEmitter`，在 SPARQL UPDATE 执行后手动触发通知：

```typescript
import type { ActivityEmitter } from '@solid/community-server';

interface SubgraphSparqlHttpHandlerOptions {
  // ...
  activityEmitter?: ActivityEmitter;
}

export class SubgraphSparqlHttpHandler extends HttpHandler {
  private readonly activityEmitter?: ActivityEmitter;

  constructor(options: SubgraphSparqlHttpHandlerOptions) {
    // ...
    this.activityEmitter = options.activityEmitter;
  }

  private emitUpdateActivity(resourceUrl: string): void {
    if (!this.activityEmitter) return;
    const identifier: ResourceIdentifier = { path: resourceUrl };
    const metadata = new RepresentationMetadata(identifier);
    metadata.set(SOLID_AS.terms.activity, AS.terms.Update);
    this.activityEmitter.emit('changed', identifier, AS.terms.Update, metadata);
  }
}
```

### 问题

`ActivityEmitter` 类型的依赖链：
```
ActivityEmitter 
  -> GenericEventEmitter 
    -> EventEmitter (from node:events)
```

`componentsjs-generator` 在解析 `ActivityEmitter` 类型时，会尝试加载 `node:events` 的类型定义文件，但路径解析失败：

```
Could not load class or interface or other type EventEmitter from 
.../node_modules/@types/node/node:events:
ENOENT: no such file or directory
```

导致整个组件生成失败，所有 `.jsonld` 文件无法生成。

## 挑战

即使绕过 `ActivityEmitter` 的注入问题，Sidecar 支持通知还面临以下挑战：

1. **资源识别**：SPARQL UPDATE 可能影响多个 triple，难以准确识别所有受影响的资源 URL
2. **Activity 类型**：需要正确判断是 Create、Update 还是 Delete 操作
3. **Container 联动**：如果创建/删除资源，还需要通知父容器的变更
4. **Metadata 同步**：需要同步更新资源的 `dcterms:modified` 等元数据

## 可能的替代方案

1. **不支持**：明确 Sidecar 端点不触发通知，用户需通过标准 LDP 接口操作以获得通知支持

2. **运行时获取 Emitter**：不通过构造函数注入，而是在运行时动态获取 ActivityEmitter 实例，避免 componentsjs-generator 解析

3. **通过 ResourceStore 层**：让 Sidecar 的写操作经过 MonitoringStore 层，自动获得通知支持（但可能需要较大重构）

## 当前状态

回滚了相关改动，Sidecar 暂不支持通知触发。
