# CSS 默认 UI 路由与自定义指南

本文介绍 Community Solid Server（CSS）在未定制时的默认 UI 路由，并给出如何替换或扩展这些入口的示例，帮助熟悉 `BaseHttpHandler` 链路与自定义流程。

---

## 0. 根路径设计决策

### CSS 的两种根路径模式

CSS 提供两种根路径初始化方式：

| 配置文件 | 根路径 `/` 行为 | 适用场景 |
|---------|----------------|----------|
| `static-root.json` | 静态 HTML 欢迎页 | 多用户服务器 |
| `initialize-root.json` | LDP 容器（真正的 Pod） | 单用户场景 |

### xpod 的设计选择

**xpod 统一使用 `static-root.json` 模式**，原因：

1. **一致性**：无论 local/edge/server 模式，Pod 都在 `/{username}/` 下
2. **应用兼容**：ORM 和其他应用可以统一处理 Pod 路径，不需要区分模式
3. **家庭场景**：即使 local 模式也可能有多个家庭成员使用

| 模式 | 根路径 `/` | Pod 位置 |
|------|-----------|----------|
| local | SPA 欢迎页 | `/{username}/` |
| edge | SPA 欢迎页 | `/{username}/` |
| server | SPA 欢迎页 | `/{username}/` |

### 内容协商行为

**注意**：CSS 的 `StaticAssetHandler` **不检查 Accept 头**。

即使客户端请求 `Accept: text/turtle`，根路径 `/` 也会返回 HTML（而非 406 Not Acceptable）。这是 CSS 的设计选择，xpod 保持此行为。

如果客户端需要 RDF 数据，应该访问具体的 Pod 路径 `/{username}/`，而不是根路径。

### 配置方式

在 `config/xpod.base.json` 中 override `RootStaticAsset` 指向 SPA：

```json
{
  "@type": "Override",
  "overrideInstance": { "@id": "urn:solid-server:default:RootStaticAsset" },
  "overrideParameters": {
    "@type": "StaticAssetEntry",
    "relativeUrl": "/",
    "filePath": "./static/app/index.html"
  }
}
```

---

## 1. 默认 UI 路由

CSS 自带一组静态页面和账户操作，主要路径如下：

| 路径 | 说明 | 对应 handler |
| --- | --- | --- |
| `/` | 根页面（静态欢迎页）。 | `StaticAssetHandler` + `RootStaticAsset` |
| `/.account/` | 账户主页，包含登录/注册入口。 | `AuthResourceHttpHandler` |
| `/.account/login/password/…` | 密码登录相关页面。 | `HtmlViewHandler`（加载官方模板） |
| `/.well-known/css/**` | CSS 默认样式、字体。 | `StaticAssetHandler` |
| 其余路径 | 落到 Solid Pod / LDP 资源。 | `LdpHandler` |

这些路由对应的配置主要来自 `node_modules/@solid/community-server/config/http/handler/default.json`，核心逻辑是一个默认的 `BaseHttpHandler` 链：

- **StaticAssetHandler**：处理 `/.well-known/css/**` 等静态资源。
- **OidcHandler**：负责 `/authorize`、`/token` 等 OIDC 端点。
- **NotificationHttpHandler**、**StorageDescriptionHandler**：通知与存储描述。
- **AuthResourceHttpHandler** 与 **IdentityProviderHandler**：处理 `.account/**` 登录注册页面。
- **LdpHandler**：匹配其余资源路径，落到 LDP 存储。

在我们的 `config/main*.json` 中，首先 `import` 了这些默认配置，然后再通过 `config/xpod.json` 进行覆写和扩展。

---

## 2. 自定义静态页面

CSS 允许通过 override 的方式替换默认静态资源。例如将根页面改为自定义 HTML：

```json
{
  "@type": "Override",
  "overrideInstance": { "@id": "urn:solid-server:default:RootStaticAsset" },
  "overrideParameters": {
    "@type": "StaticAssetEntry",
    "relativeUrl": "/",
    "filePath": "./static/landing/index.html",
    "@id": "urn:undefineds:xpod:RootStaticAsset"
  }
}
```

- `filePath` 指向实际存在的 HTML 文件。
- 若希望继续使用 `.account` 等默认 UI，无需改动其它配置。

完成后执行：

```bash
yarn build:ts
yarn build:components
yarn local        # 或其它启动命令
```

---

## 3. 示例：添加自定义 Handler（Hello World）

除了覆盖静态页面，也可以在 `BaseHttpHandler` 链中插入自己的逻辑。以下示例演示如何在 `/hello` 返回简单文本：

1. **创建 Handler** (`src/http/HelloHttpHandler.ts`)
   ```ts
   import { HttpHandler, NotImplementedHttpError } from '@solid/community-server';
   import type { HttpHandlerInput } from '@solid/community-server';

   export class HelloHttpHandler extends HttpHandler {
     public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
       if (request.url !== '/hello') {
         throw new NotImplementedHttpError();
       }
     }

     public override async handle({ response }: HttpHandlerInput): Promise<void> {
       response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
       response.end('Hello World');
     }
   }
   ```

2. **暴露组件** (`src/index.ts`)
   ```ts
   export { HelloHttpHandler } from './http/HelloHttpHandler';
   ```

3. **生成 jsonld 描述**
   ```bash
   yarn build:components
   ```

4. **在配置中插入 handler**：
   ```json
   {
     "@type": "Override",
     "overrideInstance": { "@id": "urn:solid-server:default:BaseHttpHandler" },
     "overrideParameters": {
       "@type": "WaterfallHandler",
       "handlers": [
         { "@id": "urn:undefineds:xpod:HelloHttpHandler" },
         { "@id": "urn:solid-server:default:StaticAssetHandler" },
         { "@id": "urn:solid-server:default:OidcHandler" },
         { "@id": "urn:solid-server:default:NotificationHttpHandler" },
         { "@id": "urn:solid-server:default:StorageDescriptionHandler" },
         { "@id": "urn:solid-server:default:AuthResourceHttpHandler" },
         { "@id": "urn:solid-server:default:IdentityProviderHandler" },
         { "@id": "urn:solid-server:default:LdpHandler" }
       ]
     }
   }
   ```

5. **构建并重启**
   ```bash
   yarn build:ts
   yarn build:components
   yarn local
   ```

此时访问 `http://localhost:3000/hello` 即可返回 “Hello World”。若 handler 不想处理其他路径，`canHandle` 中抛出 `NotImplementedHttpError` 即可交由后续处理器。

> 注意：CSS 默认会以 404 作为初始状态码；自定义 handler 在返回内容前需显式 `writeHead(200, …)`，否则即使写入了内容也会以 404 响应。

---

## 4. 快速检查清单

1. 是否已执行 `yarn build:ts && yarn build:components` 并重启 CSS？
2. 日志中是否出现 “Serving …” 或自定义 handler 的日志？
3. 若仍为 404，确认 `BaseHttpHandler` 的 override 顺序是否正确。

掌握这些概念即可自由扩展 CSS 的路由和静态页面。
