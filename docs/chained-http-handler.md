# ChainedHttpHandler 中间件系统

## 概述

`ChainedHttpHandler` 是一个链式 HTTP 处理器，支持洋葱模型（Onion Model）的中间件执行方式。它解决了原有包装式（Wrapper）中间件设计的无限嵌套问题，提供了更清晰、可扩展的中间件组合方式。对于纯路径分发场景，推荐使用 `RouterHttpHandler` 来统一路由内部 handler。

## 核心组件

### MiddlewareHttpHandler 接口

定义透传型中间件的接口，位于 `src/http/MiddlewareHttpHandler.ts`：

```typescript
interface MiddlewareHttpHandler {
  before?(input: HttpHandlerInput, context: MiddlewareContext): Promise<void>;
  after?(input: HttpHandlerInput, context: MiddlewareContext, error?: Error): Promise<void>;
}
```

- `before()`: 请求进入时执行，用于设置上下文、修改请求等
- `after()`: 请求处理完成后执行（无论成功或失败），用于清理、日志记录等
- `context`: 在 before/after 之间传递数据的共享上下文

### ChainedHttpHandler

链式处理器，位于 `src/http/ChainedHttpHandler.ts`，支持两种类型的 handler：

1. **透传型（Pass-through）中间件**：实现 `MiddlewareHttpHandler` 接口
   - 执行 `before()` 后继续调用链中的下一个 handler
   - 所有 handler 处理完后，逆序执行 `after()`
   
2. **拦截型（Intercept）Handler**：标准 `HttpHandler`
   - 调用 `canHandle()` 检查是否能处理
   - 能处理则执行 `handle()` 并终止链
   - 不能处理则跳过，尝试下一个

### RouterHttpHandler

路径路由处理器，位于 `src/http/RouterHttpHandler.ts`，用于单 baseUrl 模式下的路径分发：

- 按 `routes` 顺序匹配路径前缀
- 命中后转发给对应 handler
- 未命中时交给 `fallback`

## 执行流程

```
请求 -> [TracingMiddleware.before] 
     -> [AuthMiddleware.before] 
     -> [SignalHandler.canHandle? 不匹配，跳过]
     -> [HttpHandler.canHandle? 匹配，执行 handle()]
     -> [AuthMiddleware.after]
     -> [TracingMiddleware.after] 
     -> 响应
```

## 配置示例

### 基础配置 (xpod.base.json)

```json
{
  "comment": "Tracing middleware for request ID and logging.",
  "@id": "urn:undefineds:xpod:TracingMiddleware",
  "@type": "RequestIdHttpHandler"
},
{
  "comment": "Main HTTP handler using chained middleware pattern.",
  "@id": "urn:undefineds:xpod:MainHttpHandler",
  "@type": "ChainedHttpHandler",
  "handlers": [
    { "@id": "urn:undefineds:xpod:TracingMiddleware" },
    { "@id": "urn:solid-server:default:HttpHandler" }
  ]
}
```

### 扩展配置 (xpod.cluster.json)

通过 Override 机制在链中插入额外的 handler：

```json
{
  "comment": "Override MainHttpHandler to include SignalAwareHttpHandler in the chain.",
  "@type": "Override",
  "overrideInstance": {
    "@id": "urn:undefineds:xpod:MainHttpHandler"
  },
  "overrideParameters": {
    "@type": "ChainedHttpHandler",
    "handlers": [
      { "@id": "urn:undefineds:xpod:TracingMiddleware" },
      { "@id": "urn:undefineds:xpod:SignalAwareHttpHandler" },
      { "@id": "urn:solid-server:default:HttpHandler" }
    ]
  }
}
```

## 实现自定义中间件

### 透传型中间件示例

```typescript
import { HttpHandler, HttpHandlerInput, getLoggerFor } from '@solid/community-server';
import type { MiddlewareHttpHandler, MiddlewareContext } from './MiddlewareHttpHandler';

export class MyMiddleware extends HttpHandler implements MiddlewareHttpHandler {
  protected readonly logger = getLoggerFor(this);

  async canHandle(_input: HttpHandlerInput): Promise<void> {
    // 透传型中间件总是可以处理
  }

  async handle(_input: HttpHandlerInput): Promise<void> {
    throw new Error('Should be used as middleware in ChainedHttpHandler');
  }

  async before(input: HttpHandlerInput, context: MiddlewareContext): Promise<void> {
    // 请求前处理
    context['startTime'] = Date.now();
  }

  async after(input: HttpHandlerInput, context: MiddlewareContext, error?: Error): Promise<void> {
    // 请求后处理
    const duration = Date.now() - (context['startTime'] as number);
    this.logger.info(`Request completed in ${duration}ms`);
  }
}
```

### 拦截型 Handler

标准的 `HttpHandler` 实现，通过 `canHandle()` 决定是否拦截请求：

```typescript
export class MyInterceptHandler extends HttpHandler {
  async canHandle(input: HttpHandlerInput): Promise<void> {
    if (!input.request.url?.startsWith('/my-path')) {
      throw new Error('Not my path');
    }
  }

  async handle(input: HttpHandlerInput): Promise<void> {
    // 处理请求
  }
}
```

## 与 CSS 原有机制的对比

| 特性 | WaterfallHandler | SequenceHandler | ChainedHttpHandler |
|------|------------------|-----------------|-------------------|
| 执行模式 | 首个能处理的执行 | 全部顺序执行 | 洋葱模型 |
| 前后钩子 | 不支持 | 不支持 | 支持 before/after |
| 错误处理 | 抛出给调用方 | 抛出给调用方 | after() 可捕获处理 |
| 上下文传递 | 不支持 | 不支持 | MiddlewareContext |

## 内置中间件

### RequestIdHttpHandler (TracingMiddleware)

提供请求追踪功能：
- 读取或生成 `X-Request-ID`
- 设置响应头
- 将 ID 注入日志上下文（AsyncLocalStorage）
- 记录请求耗时和状态码
