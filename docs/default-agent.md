# Default Agent 设计文档

## 概述

当用户没有配置 AI provider/密钥或配置不可用时，系统降级到 Default Agent。Default Agent 基于 Claude Code SDK，具备读写用户 Pod 的能力，核心职责是帮助用户完成初始化配置和数据收纳。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户请求                                │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    API Server                                │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  检查用户 AI 配置                                     │    │
│  │  ├─ 有效配置 → 用户 AI Provider                      │    │
│  │  └─ 无配置/失效 → Default Agent                      │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   Default Agent (CC SDK)                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ System Prompt │    │  Pod 访问    │    │   Skills     │   │
│  │ - 角色定义    │    │  (见下文)    │    │  - 收纳      │   │
│  │ - 语义网规范  │    │              │    │  - 初始化    │   │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Pod 访问方案

### 阶段一：HTTP + 环境变量注入（当前）

通过 Claude Code SDK 的 `env` 选项注入鉴权信息，CC 使用 curl 直接访问 Pod。

```typescript
const q = query({
  prompt: userMessage,
  options: {
    env: {
      ...process.env,
      SOLID_TOKEN: userToken,      // 用户的访问令牌
      POD_BASE_URL: podBaseUrl,    // 用户的 Pod 地址
    },
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    allowedTools: ['Bash', 'Read', 'Write'],
  },
});
```

System Prompt 中告知 CC 如何访问 Pod：

```
访问用户 Pod 使用 curl，鉴权信息已在环境变量中：

# 读取资源
curl -H "Authorization: Bearer $SOLID_TOKEN" "$POD_BASE_URL<path>"

# 写入 Turtle
curl -X PUT \
  -H "Authorization: Bearer $SOLID_TOKEN" \
  -H "Content-Type: text/turtle" \
  -d '<turtle-content>' \
  "$POD_BASE_URL<path>"

# 创建容器
curl -X POST \
  -H "Authorization: Bearer $SOLID_TOKEN" \
  -H "Content-Type: text/turtle" \
  -H "Link: <http://www.w3.org/ns/ldp#BasicContainer>; rel=\"type\"" \
  "$POD_BASE_URL<parent-path>/"
```

**优点**：
- 实现简单，快速验证
- 无需额外依赖

**缺点**：
- CC 需要理解 HTTP 协议细节
- 每次操作都要构造 curl 命令

### 阶段二：FUSE 挂载（未来）

将 Pod 通过 FUSE 挂载为本地文件系统，CC 直接以文件操作方式访问。

```
┌─────────────┐
│     CC      │  ← 看到的是普通文件系统
└──────┬──────┘
       │ 文件读写
┌──────▼──────┐
│ solid-fuse  │  ← 文件操作 ↔ LDP 请求
└──────┬──────┘
       │ HTTP (LDP)
┌──────▼──────┐
│  CSS Server │  ← 统一的 Solid 协议层
└──────┬──────┘
       │
   ┌───┴───┐
   ▼       ▼
SQLite   MinIO
(Local)  (Cloud)
```

#### FUSE 实现设计

**目录结构**：

```
packages/solid-fuse/
├── src/
│   ├── index.ts              # 入口
│   ├── SolidFuseFs.ts        # FUSE 主实现
│   ├── LdpClient.ts          # LDP 协议客户端
│   ├── ResourceMapper.ts     # 资源 ↔ 文件映射
│   ├── ContainerMapper.ts    # 容器 ↔ 目录映射
│   ├── ContentNegotiator.ts  # 内容协商处理
│   └── AuthProvider.ts       # 认证令牌管理
├── bin/
│   └── solid-mount.ts        # CLI: solid-mount <pod-url> <mount-point>
└── package.json
```

**映射规则**：

| Solid 概念 | 文件系统表示 | 说明 |
|-----------|-------------|------|
| Container | 目录 | `GET` 返回目录列表 |
| RDF Resource | `.ttl` 文件 | 默认序列化为 Turtle |
| Non-RDF Resource | 原始文件 | 保持原始格式 |
| ACL | `.acl` 文件 | 访问控制列表 |
| Metadata | `.meta` 文件 | 资源元数据 |

**核心接口**：

```typescript
interface SolidFuseOptions {
  podUrl: string;           // Pod 根 URL
  mountPoint: string;       // 本地挂载点
  token: string;            // 访问令牌
  cacheTimeout?: number;    // 缓存超时（毫秒）
  readOnly?: boolean;       // 只读模式
}

class SolidFuseFs {
  constructor(options: SolidFuseOptions);

  // FUSE 回调
  async getattr(path: string): Promise<Stats>;
  async readdir(path: string): Promise<string[]>;
  async read(path: string, offset: number, length: number): Promise<Buffer>;
  async write(path: string, buffer: Buffer, offset: number): Promise<number>;
  async create(path: string, mode: number): Promise<void>;
  async unlink(path: string): Promise<void>;
  async mkdir(path: string, mode: number): Promise<void>;
  async rmdir(path: string): Promise<void>;

  // 生命周期
  mount(): Promise<void>;
  unmount(): Promise<void>;
}
```

**LDP 操作映射**：

| 文件操作 | LDP 请求 | 说明 |
|---------|---------|------|
| `readdir()` | `GET` Container | 解析 `ldp:contains` |
| `read()` | `GET` Resource | 返回内容 |
| `write()` | `PUT` Resource | 更新/创建资源 |
| `create()` | `PUT` Resource | 创建新资源 |
| `unlink()` | `DELETE` Resource | 删除资源 |
| `mkdir()` | `POST` + Link header | 创建容器 |
| `rmdir()` | `DELETE` Container | 删除容器 |
| `getattr()` | `HEAD` | 获取元数据 |

**缓存策略**：

```typescript
interface CacheEntry {
  content: Buffer;
  etag: string;
  lastModified: Date;
  expiresAt: Date;
}

class ResourceCache {
  private cache: Map<string, CacheEntry>;

  get(path: string): CacheEntry | undefined;
  set(path: string, entry: CacheEntry): void;
  invalidate(path: string): void;
  invalidatePrefix(prefix: string): void;  // 目录变更时
}
```

**使用方式**：

```typescript
// Default Agent 启动时
const mountPoint = `/tmp/xpod-mounts/${sessionId}`;
const fuse = new SolidFuseFs({
  podUrl: podBaseUrl,
  mountPoint,
  token: userToken,
});

await fuse.mount();

// 启动 CC，工作目录设为挂载点
const q = query({
  prompt: userMessage,
  options: {
    cwd: mountPoint,
    systemPrompt: `你的工作目录是用户的 Solid Pod，可以直接读写文件...`,
  },
});

// 会话结束后
await fuse.unmount();
```

**优点**：
- CC 无需理解 HTTP/LDP 协议
- 文件操作是 CC 的强项
- 语义网数据（.ttl）CC 可以直接理解

**缺点**：
- 需要开发 FUSE 实现
- 需要处理并发、缓存、错误恢复
- macOS/Linux 需要 FUSE 支持

## 环境变量

```bash
# --- Default Agent ---
DEFAULT_PROVIDER=openrouter                      # 默认 AI 提供商
DEFAULT_MODEL=stepfun/step-3.5-flash:free   # 默认模型
DEFAULT_API_KEY=                                 # 默认 API Key（必填）
```

## Default Agent System Prompt

```
你是 Xpod Default Agent，运行在用户的 Solid Pod 上。

## 你的职责
1. 帮助用户完成初始化配置（特别是 AI 配置）
2. 识别用户消息中的结构化数据并存储到 Pod
3. 按语义网规范组织数据

## 数据收纳能力
当用户的消息中包含以下类型的信息时，识别并保存：

### AI 配置
- API Key、Provider、Model、Base URL
- 存储位置：/settings/ai/
- 词汇表：自定义 xpod:AiProvider, xpod:AiCredential

### 联系人
- 姓名、邮箱、电话、WebID
- 存储位置：/contacts/
- 词汇表：vCard (http://www.w3.org/2006/vcard/ns#)

### 日程/事件
- 时间、地点、标题、参与者
- 存储位置：/calendar/
- 词汇表：schema:Event 或 ical

### 任务/Todo
- 标题、截止日期、优先级、状态
- 存储位置：/tasks/
- 词汇表：自定义或 schema:Action

### 笔记
- 标题、内容、标签
- 存储位置：/notes/
- 词汇表：schema:Note

## Pod 访问方式
[根据阶段动态生成：阶段一用 curl，阶段二用文件操作]

## 语义网规范
- 使用 Turtle 格式存储 RDF 数据
- 优先使用标准词汇表（vCard、schema.org、FOAF）
- 资源 URI 使用 Pod 相对路径 + fragment identifier
- 示例：
  ```turtle
  @prefix vcard: <http://www.w3.org/2006/vcard/ns#> .

  <#alice> a vcard:Individual ;
    vcard:fn "Alice" ;
    vcard:hasEmail <mailto:alice@example.com> .
  ```

## 交互原则
- 识别到结构化数据时，先确认再保存
- 保存成功后告知用户存储位置
- 如果是 AI 配置，提示用户后续可以使用自己的 AI
```

## 响应标识

在响应头中标识是否使用 Default Agent：

```
X-Xpod-Default-Agent: true
X-Xpod-Default-Agent-Reason: no_user_config | config_invalid | rate_limited
```

## 实现文件

| 文件 | 说明 |
|------|------|
| `src/api/chatkit/default-agent.ts` | Default Agent 核心实现 |
| `src/api/chatkit/ai-provider.ts` | 修改：添加降级逻辑 |
| `src/api/handlers/ChatHandler.ts` | 修改：添加响应头 |
| `example.env` | 新增 DEFAULT_* 环境变量 |
| `packages/solid-fuse/` | （阶段二）FUSE 实现 |

## 验证方式

### 阶段一验证

1. **无用户配置**：只配置 `DEFAULT_API_KEY`，发送聊天请求
   - 预期：使用 Default Agent，响应头 `X-Xpod-Default-Agent: true`

2. **密钥收纳**：发送 "我的 OpenAI key 是 sk-test123"
   - 预期：识别并存储到 Pod，确认消息
   - 后续请求使用新存储的密钥

3. **联系人收纳**：发送 "张三的邮箱是 zhangsan@example.com"
   - 预期：创建 /contacts/zhangsan.ttl，使用 vCard 词汇表

### 阶段二验证

1. **FUSE 挂载**：验证 Pod 能正确挂载为文件系统
2. **文件读写**：CC 能通过文件操作读写 Pod 数据
3. **并发安全**：多个会话同时操作不冲突

## 后续规划

1. **阶段一**（当前）：HTTP + curl 方案，快速验证流程
2. **阶段二**：开发 solid-fuse，提升 CC 操作体验
3. **阶段三**：Default Agent 技能扩展（更多数据类型、智能分类）
4. **阶段四**：Agent 配置外置到 Pod（支持用户自定义 Agent）
