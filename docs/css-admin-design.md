# xpod 设计文档

> xpod = 增强的 CSS + 个人 AI 平台

## 项目架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        开源项目                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  xpod (后端 + 管理 UI)                                           │
│  ├── 后端服务                                                    │
│  │   ├── CSS 扩展 (Pod 存储)                                     │
│  │   ├── AI API (ChatKit + OpenAI 兼容)                          │
│  │   └── Node 管理 API                                           │
│  │                                                              │
│  ├── 管理 UI                                                     │
│  │   ├── Web 版 (Pods/Nodes/Settings)                           │
│  │   └── 桌面版 (边缘节点管理)                                    │
│  │                                                              │
│  └── Cluster                                                    │
│      ├── Center (中心节点)                                       │
│      └── Edge (边缘节点)                                         │
│                                                                 │
│  linx (应用 UI)                                                  │
│  ├── Web 版                                                      │
│  └── 桌面版                                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        商业化 (不开源)                           │
├─────────────────────────────────────────────────────────────────┤
│  ├── 账号系统                                                    │
│  ├── 计费系统                                                    │
│  └── 营销页面                                                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        官网                                      │
├─────────────────────────────────────────────────────────────────┤
│  官网 = xpod Web UI + linx Web UI + 商业化部分                   │
│                                                                 │
│  ├── xpod 贡献：管理 UI (Account 级 + Pod Settings)             │
│  ├── linx 贡献：应用 UI (Chat/Files/Memory)                     │
│  └── 商业化贡献：账号/计费/营销                                  │
└─────────────────────────────────────────────────────────────────┘
```

### xpod 与 linx 的关系

```
两个独立项目，互相导流：

xpod 用户                          linx 用户
(技术向/自部署)                     (应用向/普通用户)
     │                                  │
     │ 需要好用的 AI 应用                │ 需要自己部署/更多控制
     │                                  │
     ▼                                  ▼
   linx                              xpod

不强绑定：
  - linx 可以连任何兼容的 Solid Pod（不只是 xpod）
  - xpod 可以被任何兼容的客户端访问（Cursor/Continue 等）
```

### xpod 包含的 UI

```
xpod UI（管理向）：
├── Web 版
│   ├── Account 级
│   │   ├── Pods 列表/管理
│   │   ├── Nodes 管理
│   │   └── 系统设置（节点级：Ollama/远程供应商）
│   │
│   └── Pod 级
│       └── Pod Settings（进入具体 Pod）
│           ├── 密钥（供应商 Key、AI API Key）
│           ├── 偏好（默认模型等）
│           ├── Profile（WebID 信息）
│           ├── 权限/ACL
│           └── 导入/导出
│
└── 桌面版 (边缘节点)
    ├── Account 级（同 Web 版）
    ├── Pod 级（同 Web 版）
    └── 边缘特有
        ├── 节点状态
        ├── Ollama 配置
        ├── 日志
        └── 终端

(无账单 - 账单在商业化部分)
```

### linx 包含的 UI

```
linx UI（应用向）：
├── Web 版
│   ├── Chat (ChatKit)
│   ├── Files
│   ├── Memory
│   └── Settings → 复用/跳转 xpod Pod Settings
│
└── 桌面版
    └── (同 Web 版)

分工：
  - xpod：管理一切（Account 级 + Pod Settings）
  - linx：用一切（Chat/Files/Memory），Settings 交给 xpod

鉴权方式：
  - 官网嵌入时：账号鉴权（已登录 → 找到对应 Pod）
  - 独立部署时：WebID 鉴权（Solid OIDC）
```

---

## 核心定位

```
xpod 是什么：
  1. Solid Pod 服务器（CSS 增强版）
     - 文件存储 + RDF 数据
     - 云边协同
     
  2. 个人 AI 平台（OpenAI 平台的自托管版）
     - ChatKit 协议（linx 使用）
     - OpenAI 兼容 API（第三方客户端使用）
     - 本地模型（Ollama）+ 远程代理
     
  3. 数据主权
     - 数据在哪，计算就在哪
     - Edge 用户数据永远不上云
```

## 功能分层概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         xpod 平台                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  xpod 管理 UI                        linx 应用 UI               │
│  ┌───────────────────┐              ┌───────────────────┐      │
│  │ Account 级        │              │ Pod 级（应用）     │      │
│  │ - Pods 列表       │              │ - AI 对话         │      │
│  │ - Nodes 管理      │              │ - 文件管理        │      │
│  │ - 系统设置        │              │ - Memory/RAG      │      │
│  │                   │              │                   │      │
│  │ Pod 级（设置）    │              │ Settings ─────────┼──┐   │
│  │ - Pod Settings ←──┼──────────────┼───────────────────┘  │   │
│  │   - 密钥          │              └───────────────────┘  │   │
│  │   - 偏好          │                    复用/跳转 ────────┘   │
│  │   - Profile       │                                         │
│  │   - 权限/ACL      │                                         │
│  └───────────────────┘                                         │
│           │                                                     │
│           └─────────────────────┬───────────────────────────────┘
│                                 ▼                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    xpod 核心服务                         │   │
│  │  - ChatKit 协议 (POST /chatkit)                         │   │
│  │  - OpenAI 兼容 API (/api/v1/...)                        │   │
│  │  - Pod 存储 (Solid 协议)                                │   │
│  │  - 认证 (OIDC / API Key)                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                        │                                        │
│                        ▼                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    模型调用层                            │   │
│  │  - Ollama（本地）                                       │   │
│  │  - OpenAI / Anthropic / DeepSeek（远程）                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

分工说明：
  - xpod：管理一切（Account 级 + Pod Settings）
  - linx：用一切（Chat/Files/Memory），Settings 交给 xpod
  - xpod 可独立运行，不依赖 linx
  - linx 的 Settings 复用/跳转到 xpod Pod Settings
```

---

## 第一部分：管理端设计

## 背景

### 现状问题

```
CSS 自带界面：
  - 非常简陋，静态页面
  - 只有基本的账户注册/登录
  - 不是为 Account 管理设计的

社区现有方案：
  - Mashlib / SolidOS Data Browser - Pod 浏览器，进入文件级别
  - Penny - 同上，轻量 Pod 浏览器
  - solid-ui-react - 已弃用（2024.12）
  
都是单一 WebID 的 Pod 文件浏览功能，不是 Account 级别的管理
```

### 目标

```
构建个人管理自己 Pod 的界面：
  - Account 级别：管理我的 Pods
  - Pod 级别：WebID/密钥/权限/导入导出（不进入文件）
  - 桌面端：本地部署配置
  - 现代化 UI
```

### 定位澄清

```
这是：
  ✓ 个人管理自己的 Pod
  ✓ 个人管理自己的边缘节点
  ✓ Account 维度
  ✓ 本地部署友好

这不是：
  ✗ 网站管理员后台
  ✗ 多用户管理
  ✗ 文件管理器（不进入 Pod 内部浏览文件）
```

### 云边协同模型

```
用户在 Center 注册账户
        │
        ├──→ 在 Center 创建 Pod（云端托管）
        │
        └──→ 自己部署 Edge 节点（本地/家里/公司）
                    │
                    │ 配置 Signal Endpoint 指向 Center
                    ▼
              Edge 启动时向 Center 注册
                    │
                    ▼
              Center 记录节点、检测可达性、分配域名
                    │
                    ▼
              用户可以把 Pod 迁移到自己的 Edge 节点
```

### 功能按部署位置划分

```
┌─────────────────────────────────────────┐
│  Center Web 端                          │
│  - Account / Pod 管理                   │
│  - 我的边缘节点列表                      │
│  - 节点状态/健康监控                     │
│  - Pod 迁移（云 ↔ 边缘）                 │
│  - 连接管理、日志                        │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Edge 桌面端 / CLI                      │
│  - 启动/停止 Edge 服务                  │
│  - 配置 Signal Endpoint                 │
│  - 配置 nodeId、FRP、ACME 等            │
│  - 本地日志/终端                        │
│  - 托盘常驻                             │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Local 模式（纯本地，不连 Center）       │
│  - 完全独立运行                         │
│  - 本地 Account / Pod 管理              │
│  - 桌面端 + 本地 Web                    │
└─────────────────────────────────────────┘
```

---

## 产品形态

### 三端架构

```
1. CLI（命令行）
   - 服务管理
   - Pod 操作
   - 脚本自动化
   - 最轻量

2. 桌面端（Tauri）
   - GUI 启动/停止 CSS
   - 托盘常驻
   - 本地部署配置
   - 一键 yarn local

3. Web 端
   - Account/Pod 管理界面
   - 可视化监控
   - 远程访问

三者共享：
   - 核心 UI 组件
   - API 层抽象
```

---

## 功能层级

### CSS 结构理解

```
CSS 的结构：
  Account（账户）
    └── Pod 1（有自己的 WebID）
    └── Pod 2（有自己的 WebID）
    └── Pod 3（有自己的 WebID）

注意：密钥/凭证跟着 WebID 走，在 Pod 级别管理
```

### 功能分层

```
┌─────────────────────────────────────────┐
│  服务级别（Edge 桌面端/CLI）             │
│  - 启动/停止 CSS                        │
│  - 端口/目录配置                        │
│  - Edge 配置（Signal/FRP/ACME）         │
│  - 日志、终端                           │
│  - 托盘常驻                             │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  Account 级别（Web 端）                  │
│  - 我的 Pods 列表                       │
│  - 创建/删除 Pod                        │
│  - 存储总览                             │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  Pod 级别（Web 端，不进入文件）          │
│  - WebID / Profile                      │
│  - 密钥管理                             │
│  - 权限设置                             │
│  - 应用授权                             │
│  - 导入/导出                            │
│  - 存储/流量监控                        │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  我的边缘节点（Center Web 端）           │
│  - 已注册节点列表                        │
│  - 节点状态（在线/离线/降级）            │
│  - 连接模式（direct/proxy）             │
│  - 隧道/证书状态                        │
│  - Pod 所在位置                         │
│  - 迁移 Pod 到边缘/云端                 │
└─────────────────────────────────────────┘
```

---

## 功能详细设计

### 一、部署/服务（桌面端）

```
启动/停止：
  - 一键启动/停止 CSS 服务
  - 服务状态显示（运行中/已停止）
  - 重启服务

配置：
  - 端口设置
  - 数据存储目录
  - 基础 URL

部署模式（CSS_EDITION）：
  - local：本地开发模式
  - server：云端/集群模式
  
Edge 节点配置（CSS_EDGE_NODES_ENABLED=true 时）：
  - 节点 ID（CSS_NODE_ID）
  - Signal 端点（CSS_SIGNAL_ENDPOINT）
  - 心跳间隔（CSS_NODE_HEARTBEAT_INTERVAL）
  
FRP 隧道配置：
  - 服务器地址（CSS_FRP_SERVER_HOST/PORT）
  - Token（CSS_FRP_TOKEN）
  - 协议（tcp/quic/wss）
  - 自动端口分配

ACME 证书配置：
  - 邮箱（CSS_ACME_EMAIL）
  - 域名列表
  - CA 选择（Let's Encrypt / ZeroSSL）
  - 证书路径
  - 自动续期天数（默认 15 天前）

DNS 提供商配置：
  - 腾讯云 DNS（或其他）
  - API 密钥

存储后端配置：
  - SPARQL 端点（sqlite/postgres）
  - MinIO（对象存储）
  - Redis（缓存/锁）
  - PostgreSQL（身份数据库）

日志查看：
  - 实时日志流
  - 级别筛选（INFO/DEBUG/WARN/ERROR）
  - 搜索/过滤
  - 导出日志

托盘功能：
  - 系统托盘常驻
  - 快捷菜单
  - 开机自启（可选）
```

### 二、Account 级别

```
Pods 列表：
  - 显示我的所有 Pods
  - 每个 Pod 的名称/路径
  - 每个 Pod 的存储用量
  - Pod 状态

创建 Pod：
  - 指定 Pod 名称/路径
  - 初始配置

删除 Pod：
  - 确认删除
  - 可选：导出备份后删除

存储总览：
  - 所有 Pod 的总用量
  - 配额（如有）
```

### 三、Pod 级别

```
WebID / Profile：
  - 查看 WebID
  - 编辑 Profile 信息

密钥管理：
  - 查看/创建/删除凭证
  - API Token 管理

权限设置：
  - Pod 级别的 ACL
  - 公开/私有
  - 授权给特定 WebID

应用授权：
  - 已授权的应用列表
  - 撤销授权

导入/导出：
  - 导出 Pod（备份）
  - 导入 Pod（恢复/迁移）
  - 支持格式待定

存储监控：
  - 当前用量
  - 配额
  - 用量趋势图表
  - 按类型分布（可选）

流量监控：
  - 请求数（读/写）
  - 带宽消耗
  - 访问来源（哪些应用）
  - 时间趋势图表
```

### 四、服务级别（运维）

```
连接管理：
  - 活跃连接列表（WebSocket/HTTP）
  - 每个连接关联的 Pod
  - 连接来源 IP/User-Agent
  - 断开连接操作
  
终端（Terminal）：
  - 创建终端会话
  - 工作目录选择（需要 acl:Control 权限）
  - 会话限制（每用户最多 5 个，总共 100 个）
  - 会话超时（默认 1 小时，最长 24 小时）
  - 可信命令白名单

日志功能：
  - 实时日志流
  - 级别筛选（INFO/DEBUG/WARN/ERROR）
  - 搜索/过滤
  - 导出日志
```

### 五、我的边缘节点（Center Web 端）

```
节点列表：
  - 我注册的所有边缘节点
  - 节点名称/ID
  - 节点状态（在线/离线/降级）
  - 最后心跳时间
  - 连接模式（direct/proxy）

节点详情：
  - 基本信息（nodeId、注册时间）
  - 公网 IP / 端口
  - 能力信息（存储后端、带宽、位置）
  - 可达性状态
  - 延迟数据

隧道状态：
  - 隧道状态（active/standby/unreachable）
  - 入口点 URL
  - 远程端口

证书状态：
  - 当前证书域名
  - 有效期
  - 下次续期时间

节点上的 Pod：
  - 该节点托管的 Pod 列表
  - 每个 Pod 的存储用量

操作：
  - 手动触发健康探测
  - 手动触发证书续期
  - 查看节点日志（如果支持）
```

### 六、Pod 位置与迁移（Center Web 端）

```
Pod 位置：
  - 每个 Pod 当前所在节点
  - 云端 vs 边缘标识

迁移操作：
  - 从云端迁移到我的边缘节点
  - 从边缘节点迁移回云端
  - 在我的多个边缘节点之间迁移

迁移状态：
  - 迁移是即时的（只更新路由）
  - 数据按需同步（lazy copy）
  - 迁移历史记录
```

### 七、服务级别运维（通用）

```
连接管理：
  - 活跃连接列表（WebSocket/HTTP）
  - 每个连接关联的 Pod
  - 连接来源 IP/User-Agent
  - 断开连接操作
  
终端（Terminal）：
  - 创建终端会话
  - 工作目录选择（需要 acl:Control 权限）
  - 会话限制（每用户最多 5 个，总共 100 个）
  - 会话超时（默认 1 小时，最长 24 小时）
  - 可信命令白名单

日志功能：
  - 实时日志流
  - 级别筛选（INFO/DEBUG/WARN/ERROR）
  - 搜索/过滤
  - 导出日志
```

### 八、CLI 功能

```bash
# 服务管理
css start [--port] [--config]
css stop
css status
css restart

# Pod 管理
css pod list
css pod create <name>
css pod delete <name>
css pod export <name> -o backup.zip
css pod import <file> [--to <name>]
css pod info <name>

# xpod 特有命令
css node status                    # 当前节点状态
css node health                    # 健康检查
css tunnel status                  # FRP 隧道状态
css cert status                    # ACME 证书状态
css cert renew                     # 手动续期证书
css migrate <pod> --to <node>      # Pod 迁移

# 连接管理
css connections list               # 列出活跃连接
css connections kill <id>          # 断开连接

# 终端
css terminal list                  # 列出终端会话
css terminal create [--workdir]    # 创建终端
css terminal kill <id>             # 关闭终端

# 系统
css info          # 服务器信息
css logs [-f]     # 查看日志
css config show   # 显示当前配置
```

---

## 功能设计

### 一、CLI 功能

```bash
# 服务管理
css start [--port] [--config]
css stop
css status
css restart

# 账户管理
css account list
css account create <email>
css account delete <webid>
css account disable <webid>

# Pod 管理
css pod list [--account]
css pod create <name> --account <webid>
css pod delete <pod-url>
css pod info <pod-url>
css pod export <pod-url> -o backup.zip

# 数据操作
css data ls <path>
css data cp <src> <dest>
css data rm <path>

# 系统
css info          # 服务器信息
css stats         # 统计摘要
css logs [-f]     # 查看日志
css config show   # 显示当前配置
```

### 二、桌面端功能

```
核心：
  - 一键启动/停止 CSS 服务
  - 服务状态显示（运行中/已停止）
  - 端口配置
  - 数据目录选择

便捷功能：
  - 系统托盘常驻
  - 开机自启（可选）
  - 日志实时查看
  - 快速打开浏览器访问

托盘菜单：
  ┌──────────────┐
  │ ● 运行中     │
  ├──────────────┤
  │ 打开面板     │
  │ 启动服务     │
  │ 停止服务     │
  ├──────────────┤
  │ 退出         │
  └──────────────┘
```

### 三、Web 端功能

#### 账户管理（Account）

```
基础功能：
  - 账户列表（搜索、筛选、分页）
  - 创建账户
  - 禁用/启用账户
  - 删除账户
  - 重置密码/凭证

账户详情：
  - 基本信息（WebID、邮箱、创建时间）
  - 关联的 Pod 列表
  - 登录历史/活动日志
  - 存储用量
```

#### Pod 管理

```
Pod 列表：
  - 所有 Pod 概览
  - 按账户筛选
  - 存储用量排序

Pod 操作：
  - 创建 Pod（为指定账户）
  - 删除 Pod
  - 设置配额
  - 导出/备份

Pod 详情：
  - 资源统计（文件数、总大小）
  - 访问权限概览
  - 最近活动
```

#### 权限/ACL 管理

```
全局权限：
  - 默认 ACL 模板
  - 公开/私有默认策略

Pod 级权限：
  - 查看某 Pod 的 ACL
  - 批量修改权限
  - 权限审计日志
```

#### 监控/统计

```
服务器状态：
  - 运行状态
  - CPU/内存/磁盘
  - 连接数

使用统计：
  - 总账户数
  - 总 Pod 数
  - 总存储量
  - 活跃用户数（日/周/月）

图表：
  - 注册趋势
  - 存储增长
  - 请求量/带宽
```

#### 系统配置

```
服务配置：
  - 注册开关（开放/关闭/邀请制）
  - 默认配额
  - 允许的身份提供商

安全配置：
  - CORS 设置
  - 速率限制
  - IP 黑白名单
```

#### 日志/审计

```
操作日志：
  - 管理员操作记录
  - 账户活动日志

错误日志：
  - 系统错误
  - 认证失败记录
```

---

## 优先级

```
P0（核心）：
  - Edge 桌面端：启动/停止 CSS、基础配置
  - Center Web：Account 登录、Pods 列表
  - Pod：基本信息、WebID

P1（重要）：
  - Edge 桌面端：托盘、Edge 配置（Signal Endpoint）
  - Center Web：我的边缘节点列表、节点状态
  - Pod：密钥管理、权限设置、导入/导出
  - 监控：存储用量

P2（增强）：
  - Pod：应用授权
  - 监控：流量、趋势图表
  - 服务：日志功能、连接管理
  - CLI 完整命令
  - Pod 迁移

P3（高级）：
  - 终端功能
  - FRP 隧道详细管理
  - ACME 证书手动操作
  - 高级部署配置
```

---

## UI 设计

### 两套 UI 的区分

```
1. xpod 管理端（Account 级）
   - 账户/Pod 管理
   - 节点管理
   - 系统配置
   - 账单/套餐
   - 自己开发的管理界面

2. linx 应用端（Pod 级）
   - AI 对话（ChatKit React）
   - 文件管理
   - 用户配置
   - Memory/RAG
   - 基于 ChatKit + 自定义组件
```

### 一、xpod 管理端（Account 级）

#### 布局

```
┌─────────────────────────────────────────────────────────┐
│  ◆ xpod    [搜索...]                    🔔  👤 user  ⚙️  │  ← 顶栏
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  📊 概览   │   内容区                                    │
│            │                                            │
│  📦 Pods   │   ┌──────────────────────────────────────┐ │
│            │   │                                      │ │
│  🖥️ 节点   │   │                                      │ │
│            │   │                                      │ │
│  💰 账单   │   │                                      │ │
│            │   │                                      │ │
│  ⚙️ 设置   │   └──────────────────────────────────────┘ │
│            │                                            │
└────────────┴────────────────────────────────────────────┘

导航说明：
  - 概览：账户概况、存储/用量总览
  - Pods：我的 Pod 列表、Pod 元数据（不进入内容）
  - 节点：边缘节点列表、状态、迁移
  - 账单：当前套餐、用量、升级
  - 设置：Ollama 端点、远程供应商配置
```

#### 概览页

```
┌─────────────────────────────────────────────────────────┐
│  ◆ xpod                                  🌙  👤 alice   │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  概览 ←    │   我的账户                                  │
│  Pods      │   ┌────────────────────────────────────┐   │
│  节点      │   │  alice@example.com                 │   │
│  账单      │   │  套餐: Pro    有效期至 2025-06-01  │   │
│  设置      │   └────────────────────────────────────┘   │
│            │                                            │
│            │   ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│            │   │    3     │ │    2     │ │  256MB   │  │
│            │   │   Pods   │ │   节点    │ │   存储   │  │
│            │   └──────────┘ └──────────┘ └──────────┘  │
│            │                                            │
│            │   我的 Pod                                  │
│            │   ┌────────────────────────────────────┐   │
│            │   │ 📦 /alice/       ☁️ Center  128MB  │   │
│            │   │ 📦 /photos/      🏠 home     64MB  │   │
│            │   │ 📦 /work/        🏢 office   64MB  │   │
│            │   └────────────────────────────────────┘   │
│            │                      [打开 linx →]         │
│            │                                            │
│            │   我的边缘节点                              │
│            │   ┌────────────────────────────────────┐   │
│            │   │ 🟢 home     direct   1 Pod         │   │
│            │   │ 🟡 office   proxy    1 Pod         │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
└────────────┴────────────────────────────────────────────┘
```

#### Pods 页

```
┌─────────────────────────────────────────────────────────┐
│  ◆ xpod                                  🌙  👤 alice   │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  概览      │   我的 Pods                    [+ 新建]    │
│  Pods ←    │                                            │
│  节点      │   ┌────────────────────────────────────┐   │
│  账单      │   │                                    │   │
│  设置      │   │  📦 /alice/                        │   │
│            │   │  位置: ☁️ Center                   │   │
│            │   │  存储: 128MB / 1GB                 │   │
│            │   │  WebID: https://pod.../alice/      │   │
│            │   │                                    │   │
│            │   │  [打开 linx] [设置] [迁移] [导出]  │   │
│            │   │                                    │   │
│            │   ├────────────────────────────────────┤   │
│            │   │                                    │   │
│            │   │  📦 /photos/                       │   │
│            │   │  位置: 🏠 home (Edge)              │   │
│            │   │  存储: 64MB / 500MB                │   │
│            │   │  WebID: https://home.../photos/    │   │
│            │   │                                    │   │
│            │   │  [打开 linx] [设置] [迁移] [导出]  │   │
│            │   │                                    │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
└────────────┴────────────────────────────────────────────┘

注意：
  - 「打开 linx」跳转到应用端（Chat/Files/Memory）
  - 「设置」进入 Pod Settings（密钥/偏好/Profile/权限）
  - 「迁移」在节点间迁移 Pod
```

#### Pod Settings 页（Pod 级配置）

```
┌─────────────────────────────────────────────────────────┐
│  ◆ xpod    📦 /alice/                    🌙  👤 alice   │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  ← 返回    │   Pod 设置                                  │
│            │                                            │
│  🔑 密钥   │   我的供应商 Key                            │
│            │   ┌────────────────────────────────────┐   │
│  ⚙️ 偏好   │   │  OpenAI                            │   │
│            │   │  API Key: sk-...****    [编辑]     │   │
│  👤 Profile│   │  ✅ 优先使用我的 Key               │   │
│            │   ├────────────────────────────────────┤   │
│  🔒 权限   │   │  Anthropic        [+ 添加]         │   │
│            │   └────────────────────────────────────┘   │
│  📤 导出   │                                            │
│            │   💡 使用自己的 Key 可以避免节点费用       │
│            │                                            │
│            │   我的 AI API Key                          │
│            │   ┌────────────────────────────────────┐   │
│            │   │  用于第三方客户端（Cursor 等）     │   │
│            │   │                                    │   │
│            │   │  xpod-sk-abc123...    [复制] [重置]│   │
│            │   │                                    │   │
│            │   │  端点: https://pod.../api/v1       │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
└────────────┴────────────────────────────────────────────┘

Pod Settings 子页：
  - 密钥：供应商 Key、AI API Key
  - 偏好：默认模型、路由规则
  - Profile：WebID 信息编辑
  - 权限：ACL 配置、应用授权
  - 导出：备份/迁移
```

#### 设置页（系统配置）

```
┌─────────────────────────────────────────────────────────┐
│  ◆ xpod                                  🌙  👤 alice   │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  概览      │   系统设置                                  │
│  Pods      │                                            │
│  节点      │   Ollama 配置                               │
│  账单      │   ┌────────────────────────────────────┐   │
│  设置 ←    │   │  端点: http://localhost:11434      │   │
│            │   │  状态: 🟢 已连接                    │   │
│            │   │  模型: llama3, qwen2, ...          │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
│            │   远程供应商（节点级 fallback）             │
│            │   ┌────────────────────────────────────┐   │
│            │   │  OpenAI                            │   │
│            │   │  Endpoint: https://api.openai.com  │   │
│            │   │  API Key: sk-...****               │   │
│            │   │  状态: 🟢 已配置                    │   │
│            │   ├────────────────────────────────────┤   │
│            │   │  Anthropic                         │   │
│            │   │  状态: ⚪ 未配置                    │   │
│            │   │  [配置]                            │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
│            │   ⚠️ 节点级 Key 由运营者配置，             │
│            │      用户请求可能产生费用                  │
│            │                                            │
└────────────┴────────────────────────────────────────────┘
```

### 二、linx 应用端（Pod 级）

#### 布局

```
┌─────────────────────────────────────────────────────────┐
│  linx    📦 alice's Pod              🔍  ⚙️  👤 alice   │  ← 顶栏
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  💬 对话   │   ┌────────────────────────────────────┐   │
│            │   │                                    │   │
│  📁 文件   │   │         ChatKit UI 区域            │   │
│            │   │                                    │   │
│  🧠 记忆   │   │      （对话界面、消息列表）         │   │
│            │   │                                    │   │
│  ⚙️ 设置   │   │                                    │   │
│            │   │                                    │   │
│            │   │                                    │   │
│            │   ├────────────────────────────────────┤   │
│            │   │  [输入消息...]              📎 ▶️  │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
└────────────┴────────────────────────────────────────────┘

导航说明：
  - 对话：ChatKit 对话界面（主要功能）
  - 文件：Pod 内文件管理
  - 记忆：Memory/RAG 管理
  - 设置：Pod Settings（密钥/偏好/Profile/权限），复用 xpod 组件
```

#### 对话页（ChatKit）

```
┌─────────────────────────────────────────────────────────┐
│  linx    📦 alice's Pod              🔍  ⚙️  👤 alice   │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  💬 对话 ← │   ┌────────────────────────────────────┐   │
│            │   │  今天能为你做什么？                 │   │
│  📁 文件   │   │                                    │   │
│            │   │  [写代码]  [分析数据]  [翻译]      │   │
│  🧠 记忆   │   │                                    │   │
│            │   └────────────────────────────────────┘   │
│  ⚙️ 设置   │                                            │
│            │   ┌────────────────────────────────────┐   │
│            │   │ 👤 帮我写一个快速排序              │   │
│            │   ├────────────────────────────────────┤   │
│  ─────     │   │ 🤖 好的，这是一个 Python 实现：    │   │
│  历史记录  │   │                                    │   │
│  ├─ 快排   │   │ ```python                          │   │
│  ├─ 数据.. │   │ def quicksort(arr):                │   │
│  └─ ...    │   │     if len(arr) <= 1:              │   │
│            │   │         return arr                 │   │
│            │   │     ...                            │   │
│            │   │ ```                                │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
│            │   ┌────────────────────────────────────┐   │
│            │   │  [消息...]           llama3 ▼  ▶️  │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
└────────────┴────────────────────────────────────────────┘

注意：
  - 对话区域使用 ChatKit React
  - 侧边栏、历史记录是自定义组件
  - 模型选择器通过 ChatKit composer.models 配置
  - 设置跳转到 xpod Pod Settings
```

### 三、Edge 桌面端

```
┌─────────────────────────────────────────────────────────┐
│  ▶️ 启动   ⏹️ 停止   🔄 重启        [端口: 3000]  ⚙️     │  ← 控制栏
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│  📊 状态   │   节点状态                                  │
│            │   ┌────────────────────────────────────┐   │
│  ⚙️ 配置   │   │  ● 运行中    localhost:3000        │   │
│            │   │  ⏱ 运行时间  3 天 14 小时           │   │
│  📋 日志   │   │  🔗 已连接 Center                   │   │
│            │   └────────────────────────────────────┘   │
│  💻 终端   │                                            │
│            │   连接状态                                  │
│            │   ┌────────────────────────────────────┐   │
│            │   │  模式: direct                      │   │
│            │   │  隧道: standby                     │   │
│            │   │  证书: 有效 (29天)                  │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
│            │   本地 Ollama                               │
│            │   ┌────────────────────────────────────┐   │
│            │   │  端点: http://localhost:11434      │   │
│            │   │  状态: 🟢 运行中                    │   │
│            │   │  已加载: llama3 (4.7GB)            │   │
│            │   └────────────────────────────────────┘   │
│            │                                            │
├────────────┴────────────────────────────────────────────┤
│  edge-node-1  |  direct ●  |  Center: pod.example.com   │  ← 状态栏
└─────────────────────────────────────────────────────────┘

导航说明：
  - 状态：节点运行状态、连接状态、Ollama 状态
  - 配置：Signal Endpoint、FRP、ACME、Ollama 端点
  - 日志：实时日志流
  - 终端：终端会话（高级）
```

### 美术风格

**方向：极简克制**

```
风格：
  - 黑白灰为主
  - 大量留白
  - 单一强调色（Solid 官方紫）
  - 无渐变、无阴影（或极轻）
  - 线性图标

调性：
  - 专业、技术感
  - 开发者友好
  - 类似：Linear、Vercel、Raycast
```

### 配色方案

#### 品牌色（Solid 官方）

```
主色：Royal Lavender
Hex：#7C4DFF
RGB：R124 G77 B255
```

#### 完整配色

```
主色（强调）：
  #7C4DFF - Royal Lavender（Solid 官方紫）

亮色主题：
  背景：#FFFFFF
  次级背景：#FAFAFA
  文字主：#171717
  文字次：#737373
  边框：#E5E5E5

暗色主题：
  背景：#0A0A0A
  次级背景：#171717
  文字主：#EDEDED
  文字次：#A3A3A3
  边框：#262626

功能色：
  成功：#10B981（绿）
  警告：#F59E0B（橙）
  错误：#EF4444（红）
  信息：#3B82F6（蓝）

状态色：
  运行中：#10B981
  已停止：#737373
  错误：#EF4444
```

### 技术选型

```
前端框架：
  - React + TypeScript

UI 框架：
  - Shadcn/ui（Tailwind 基础，可定制）
  - 或 Radix + 自定义样式

图标：
  - Lucide（线性，和 Shadcn 配套）

桌面端：
  - Tauri（轻量，Rust + Web 前端）

构建：
  - Vite

状态管理：
  - Zustand 或 Jotai

API 层：
  - 抽象 CSS API
  - 本地/远程统一接口
```

### 架构

```
┌─────────────────────────────────────────┐
│              UI 组件库                   │
│   （账户管理、Pod 管理、统计等）          │
└─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ↓                       ↓
┌───────────────┐       ┌───────────────┐
│   桌面端壳     │       │   Web 端      │
│   (Tauri)     │       │   (纯浏览器)   │
├───────────────┤       ├───────────────┤
│ - 启动/停止   │       │ - 远程连接    │
│ - 托盘        │       │ - 多服务器    │
│ - 本地文件    │       │               │
└───────────────┘       └───────────────┘
        │                       │
        ↓                       ↓
┌───────────────┐       ┌───────────────┐
│  本地 CSS     │       │  远程 CSS     │
│  (spawn)      │       │  (HTTP API)   │
└───────────────┘       └───────────────┘
```

---

## 待讨论

- [ ] 具体页面设计
- [ ] 交互细节
- [ ] API 设计
- [ ] 开发计划

---

## 附录：xpod 配置参考

### 环境变量分类

#### 基础配置
```bash
CSS_EDITION=local|server           # 部署模式
CSS_BASE_URL=http://localhost:3000 # 基础 URL
CSS_PORT=3000                      # 端口
```

#### 边缘节点配置
```bash
CSS_EDGE_NODES_ENABLED=true        # 启用边缘节点
CSS_NODE_ID=edge-node-1            # 节点 ID
CSS_SIGNAL_ENDPOINT=http://...     # Signal 服务端点
CSS_NODE_HEARTBEAT_INTERVAL=30000  # 心跳间隔（ms）
```

#### FRP 隧道配置
```bash
CSS_FRP_SERVER_HOST=frp.example.com
CSS_FRP_SERVER_PORT=7000
CSS_FRP_TOKEN=your-token
CSS_FRP_PROTOCOL=tcp|quic|wss
```

#### ACME 证书配置
```bash
CSS_ACME_ENABLED=true
CSS_ACME_EMAIL=admin@example.com
CSS_ACME_DOMAINS=pod.example.com
CSS_ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory
CSS_ACME_ACCOUNT_KEY_PATH=./data/acme/account.pem
CSS_ACME_CERT_KEY_PATH=./data/acme/cert.key
CSS_ACME_CERT_PATH=./data/acme/cert.pem
CSS_ACME_RENEW_BEFORE_DAYS=15
```

#### 存储后端配置
```bash
# SPARQL 存储
CSS_SPARQL_ENDPOINT=sqlite:./data/quadstore.sqlite
# 或
CSS_SPARQL_ENDPOINT=postgres://user:pass@host/db

# MinIO 对象存储
CSS_MINIO_ENDPOINT=http://localhost:9000
CSS_MINIO_ACCESS_KEY=...
CSS_MINIO_SECRET_KEY=...
CSS_MINIO_BUCKET=pods

# Redis（缓存/锁）
CSS_REDIS_URL=redis://localhost:6379

# PostgreSQL（身份数据库）
CSS_IDENTITY_DB_URL=postgres://user:pass@host/db
```

### 节点能力检测

```typescript
interface NodeCapabilities {
  solidProtocolVersion?: string;     // Solid 协议版本
  storageBackends?: string[];        // 支持的存储后端
  authMethods?: string[];            // 认证方法
  maxBandwidth?: number;             // 最大带宽
  supportedModes?: ('direct' | 'proxy')[];  // 支持的访问模式
  location?: {
    country?: string;
    region?: string;
    coordinates?: { lat: number; lon: number };
  };
}
```

### 连接模式判断逻辑

```
1. 检查节点是否有公网 IP
2. 如果有公网 IP 且支持 direct 模式：
   - 进行连接测试（TCP 连接到公网 IP:端口）
   - 测试成功 → direct 模式
   - 测试失败 → 尝试 proxy 模式
3. 如果没有公网 IP 或不支持 direct：
   - 使用 proxy 模式（通过 FRP 隧道）
4. 周期性重新检测（在 proxy 模式下检测是否可以切换回 direct）
```

### 终端会话配置

```typescript
interface TerminalSessionManagerOptions {
  maxSessionsPerUser: number;    // 每用户最大会话数（默认 5）
  maxTotalSessions: number;      // 总最大会话数（默认 100）
  defaultTimeout: number;        // 默认超时秒数（默认 3600 = 1小时）
  maxTimeout: number;            // 最大超时秒数（默认 86400 = 24小时）
  defaultWorkdir: string;        // 默认工作目录
  requireAclControl: boolean;    // 是否需要 ACL Control 权限
}
```

### Pod 迁移机制

```
两种迁移类型：

1. 地域迁移（Center Node 之间）
   - WebID 不变（同一个域名）
   - 只改路由指向
   - 数据 lazy copy（共享存储 + 跨区 fallback）
   - 即时完成

2. 数据迁移（Center ↔ Edge）
   - WebID 会变（域名不同）
   - 数据完整复制
   - 需要双向确认（发起方 + 接收方）
   - 迁移完成后更新所有引用

迁移流程（Center ↔ Edge）：
  1. 一方发起迁移请求
  2. 另一方审批（同意/拒绝）
  3. 数据复制
  4. WebID 变更
  5. 完成确认
```

---

## 第二部分：AI 平台设计

### 设计原则

```
核心原则：数据在哪，计算就在哪

  Edge Pod → Edge 跑 AI
  Center Pod → Center 跑 AI
  
好处：
  - 数据主权：Edge 用户数据永远不上云
  - 隐私：对话历史/Memory/RAG 都在本地
  - 延迟：本地推理，无网络延迟
  - 离线：本地模型可离线使用
```

### API 设计（双协议支持）

```
xpod 需要实现两套 API：

1. ChatKit 协议（linx 主要使用）
   ┌─────────────────────────────────────────────────────┐
   │  POST /chatkit                                      │
   │  - 请求类型：threads.create, threads.addUserMessage │
   │  - 响应格式：SSE 事件流                              │
   │  - 事件类型：thread.created, thread.item.added,     │
   │             thread.item.updated, thread.item.done   │
   └─────────────────────────────────────────────────────┘
   
   linx 使用 ChatKit React：
   - Web Component 从 OpenAI CDN 加载（只负责 UI 渲染）
   - 数据流完全走 xpod 后端
   - 支持主题定制（颜色、字体、圆角等）
   - 快速出 MVP，UI 不满意后续可换

2. OpenAI 兼容 API（第三方客户端使用）
   ┌─────────────────────────────────────────────────────┐
   │  /api/v1/chat/completions    - 对话补全             │
   │  /api/v1/models              - 模型列表             │
   │  /api/v1/files               - 文件管理（存 Pod）   │
   │  /api/v1/threads             - 对话线程（存 Pod）   │
   │  /api/v1/vector_stores       - 向量存储/RAG        │
   │  /api/v1/memory              - 长期记忆（存 Pod）   │
   └─────────────────────────────────────────────────────┘
   
   用于：
   - Cursor / Continue / 其他 OpenAI 兼容客户端
   - 如果未来要自己写 UI 也能用

两套 API 共享底层：
  - 同一个模型调用层（Ollama / 远程供应商）
  - 同一个存储层（Pod via drizzle-solid）
  - 同一个认证层（OIDC / API Key）
```

### ChatKit 协议验证结论

```
验证方式：TypeScript 实现 mock ChatKit 后端

验证结果：
  ✅ ChatKit React 可以指向自定义后端（url + domainKey）
  ✅ domainKey 在开发环境可选（'local-dev'）
  ✅ 前端发送请求到我们的 /chatkit 端点
  ✅ 后端用 SSE 返回事件流
  ✅ 前端能解析并渲染 UI

架构确认：
  linx (ChatKit React)
        │
        │ POST /chatkit + SSE
        ▼
  xpod (实现 ChatKit 协议)
        │
        │ respond()
        ▼
  Ollama / OpenAI / 任意模型

ChatKit 请求格式示例：
  {
    "type": "threads.create",
    "params": {
      "input": {
        "content": [{ "type": "input_text", "text": "hello" }],
        "attachments": [],
        "inference_options": {}
      }
    }
  }

ChatKit 响应事件示例：
  data: {"type":"thread.created","thread":{...}}
  data: {"type":"thread.item.added","item":{...}}
  data: {"type":"thread.item.updated","item_id":"...","update":{...}}
  data: {"type":"thread.item.done","item":{...}}

UI 定制能力：
  - theme: colorScheme, radius, density, color, typography
  - header: title, leftAction, rightAction
  - startScreen: greeting, prompts
  - composer: placeholder, attachments, models
  - 限制：核心 UI 组件样式固定，无法注入 Logo

风险点：
  - Web Component 闭源，从 OpenAI CDN 加载
  - 定制能力有限，可能显得像"套壳"
  - 备选方案：自己写 UI + OpenAI 兼容 API
```

### 认证方式

```
认证方式：
  1. Solid OIDC - linx 等 Solid 客户端
  2. API Key - 第三方客户端（Cursor、Continue 等）
```

### 内部数据访问架构

```
问题：AI 服务需要读写 Pod 数据，如何高效访问？

外部客户端：
  linx → HTTP + OIDC 鉴权 → xpod → Pod 数据

内部服务（同一节点）：
  /api/chat/completions
         │
         │ 已验证用户身份
         ▼
  Unix Socket（内部 HTTP）
         │
         │ X-Verified-WebId 头
         ▼
  xpod 内部端点（跳过 OIDC）
         │
         ▼
  drizzle-solid ORM → Pod 数据
```

### Unix Socket 内部访问

```typescript
// xpod 服务器监听两个端点
const server = createServer(app);

// 外部：TCP 端口，完整 OIDC 鉴权
server.listen(3000);

// 内部：Unix Socket，信任内部请求
server.listen('/var/run/xpod.sock');

// 中间件处理
app.use((req, res, next) => {
  if (isUnixSocketRequest(req)) {
    // 内部请求，信任 X-Verified-WebId
    req.webId = req.headers['x-verified-webid'];
    req.isInternalRequest = true;
    return next();
  }
  // 外部请求，走完整 OIDC 验证
  return solidOidcMiddleware(req, res, next);
});
```

### AI 服务内部调用

```typescript
// AI 服务使用 drizzle-solid ORM
import { drizzle } from 'drizzle-solid';
import { Agent } from 'undici';

// 创建 Unix Socket Agent
const socketAgent = new Agent({
  connect: { socketPath: '/var/run/xpod.sock' }
});

// 创建内部 Session
function createInternalSession(verifiedWebId: string) {
  return {
    info: {
      isLoggedIn: true,
      webId: verifiedWebId,
    },
    fetch: (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      return fetch(`http://internal${path}`, {
        ...options,
        // @ts-ignore undici dispatcher
        dispatcher: socketAgent,
        headers: {
          ...options?.headers,
          'X-Verified-WebId': verifiedWebId,
        },
      });
    },
  };
}

// AI 服务中使用
async function handleChatCompletion(req: Request) {
  const webId = req.webId; // 已验证的用户
  
  // 创建内部 session
  const session = createInternalSession(webId);
  const db = drizzle(session);
  
  // 读取用户配置
  const config = await db.select().from(aiConfigTable);
  
  // 读取对话历史
  const history = await db.select().from(threadsTable)
    .where(eq(threadsTable.threadId, req.body.thread_id));
  
  // 执行推理...
  
  // 保存对话
  await db.insert(threadsTable).values({...});
}
```

### 跨节点请求路由

```
用户请求 → Center 入口
              │
              ├─ Pod 在 Center？
              │     └─ 本地处理（Unix Socket）
              │
              └─ Pod 在 Edge？
                    └─ 转发到 Edge
                          │
                          ▼
                    Edge 本地处理（Unix Socket）
                          │
                          ▼
                    返回结果
```

### 模型管理（分层配置）

```
┌─────────────────────────────────────────────────────────────────┐
│  Account 级配置（xpod 管理端）                                   │
│  存储位置：xpod 节点配置                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Ollama 集成：                                                   │
│    - Ollama 端点地址                                            │
│    - 已安装模型列表（只读，由 Ollama 管理）                      │
│    - 模型运行状态                                               │
│                                                                 │
│  远程供应商（节点级 fallback）：                                 │
│    - OpenAI / Anthropic / DeepSeek                              │
│    - API Endpoint + Key                                         │
│    - 作为本地模型不可用时的 fallback                            │
│    - 节点运营者配置，可能产生费用                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Pod 级配置（linx 应用端）                                       │
│  存储位置：用户 Pod                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  我的供应商 Key：                                                │
│    - 用户自己的 OpenAI/Anthropic/DeepSeek Key                   │
│    - 优先使用用户 Key，节省节点成本                             │
│    - 用户自行管理额度                                           │
│                                                                 │
│  我的 AI API Key：                                               │
│    - xpod 颁发的 API Key                                        │
│    - 给第三方客户端用（Cursor、Continue）                       │
│    - 绑定到用户的 Pod                                           │
│                                                                 │
│  偏好设置：                                                      │
│    - 默认模型                                                   │
│    - 路由规则（哪个任务用哪个模型）                             │
│    - 上下文长度偏好                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 路由策略

```
请求 model: "gpt-4"
        │
        ▼
  用户有 OpenAI Key？
        │
        ├─ 是 → 用用户的 Key 调 OpenAI
        │
        └─ 否 → 节点有配置 OpenAI？
                    │
                    ├─ 是 → 用节点 Key（可能计费）
                    │
                    └─ 否 → 返回错误 / 用本地模型替代

请求 model: "llama3"
        │
        ▼
  本地有 llama3？
        │
        ├─ 是 → 本地推理
        │
        └─ 否 → 返回错误 / 下载提示
```

### 功能分层：Account 级 vs Pod 级

```
┌─────────────────────────────────────────────────────────────────┐
│                    Account 级（xpod 管理端）                     │
│                    不涉及具体 Pod 数据内容                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  账户管理               节点管理                 系统配置        │
│  ├─ 我的 Pods 列表      ├─ 边缘节点列表          ├─ Ollama 端点  │
│  ├─ 创建/删除 Pod       ├─ 节点状态监控          ├─ 远程供应商   │
│  ├─ Pod 元数据          ├─ 隧道/证书状态         │   (节点级 Key)│
│  └─ 存储配额            └─ Pod 迁移              └─ 日志/监控    │
│                                                                 │
│  账单/套餐                                                       │
│  ├─ 当前套餐                                                    │
│  ├─ 用量统计                                                    │
│  └─ 升级/续费                                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 不同入口
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Pod 级（linx 应用端）                        │
│                     涉及用户 Pod 数据内容                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  AI 对话（ChatKit UI）           文件管理                        │
│  ├─ 对话界面                     ├─ Pod 内文件浏览               │
│  ├─ 对话历史（存 Pod）           ├─ 上传/下载                    │
│  ├─ 模型选择                     └─ 分享/权限                    │
│  └─ 工具/插件调用                                                │
│                                                                 │
│  用户配置（存 Pod）              Memory/RAG                      │
│  ├─ 我的供应商 Key               ├─ 长期记忆                     │
│  ├─ 我的 AI API Key              ├─ 知识库管理                   │
│  ├─ 偏好设置                     └─ 向量索引                     │
│  └─ 默认模型                                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### xpod 与 linx 的分工

```
┌─────────────────────────────────────────────────────────────────┐
│  xpod（平台层）                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  提供的 API：                                                    │
│    - ChatKit 协议 (POST /chatkit)     ← linx 主要使用           │
│    - OpenAI 兼容 API (/api/v1/...)    ← 第三方客户端使用        │
│                                                                 │
│  后端能力：                                                      │
│    - 模型调用（Ollama / 远程供应商）                             │
│    - Pod 存储（对话、文件、配置）                                │
│    - 认证（OIDC / API Key）                                     │
│    - 内部数据访问（Unix Socket）                                │
│                                                                 │
│  管理端 UI（Account 级）：                                       │
│    - 账户/Pod 管理                                              │
│    - 节点管理                                                   │
│    - 系统配置                                                   │
│    - 账单/套餐                                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ ChatKit 协议 / OpenAI API
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  linx（应用层）                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  使用的技术：                                                    │
│    - ChatKit React（对话 UI）                                   │
│    - 自定义组件（文件管理、设置等）                              │
│                                                                 │
│  功能（Pod 级）：                                                │
│    - AI 对话界面                                                │
│    - 文件管理                                                   │
│    - 用户配置                                                   │
│    - Memory/RAG 管理                                            │
│                                                                 │
│  数据存储：                                                      │
│    - 所有数据存用户 Pod                                         │
│    - 通过 xpod API 读写                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ OpenAI 兼容 API
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  其他客户端                                                      │
├─────────────────────────────────────────────────────────────────┤
│  - Cursor / Continue / 任何 OpenAI 兼容客户端                   │
│  - 用 AI API Key 认证                                           │
│  - 调用 xpod /api/v1/chat/completions                          │
└─────────────────────────────────────────────────────────────────┘
```

### 两个入口的区分

```
用户访问 xpod：

1. 管理端入口（Account 级）
   URL: https://xpod.example.com/admin
   功能：账户管理、节点管理、账单
   UI：xpod 自己的管理界面
   
2. 应用端入口（Pod 级）
   URL: https://xpod.example.com/app 或 linx 独立部署
   功能：AI 对话、文件管理、用户配置
   UI：linx（ChatKit React + 自定义组件）

两者关系：
  - 管理端：配置「在哪里跑、怎么跑」
  - 应用端：实际「用 AI 做事」
```

### AI 相关环境变量

```bash
# 本地模型
XPOD_AI_MODELS_PATH=/data/models        # 模型存储路径
XPOD_AI_DEFAULT_MODEL=llama3            # 默认模型
XPOD_AI_MAX_CONTEXT_LENGTH=8192         # 最大上下文

# Ollama 集成（可选）
XPOD_OLLAMA_ENDPOINT=http://localhost:11434

# 节点级供应商（fallback）
XPOD_OPENAI_API_KEY=sk-...              # 节点的 OpenAI Key
XPOD_ANTHROPIC_API_KEY=sk-ant-...       # 节点的 Anthropic Key

# 内部通信
XPOD_INTERNAL_SOCKET=/var/run/xpod.sock # Unix Socket 路径

# RAG
XPOD_VECTOR_STORE=sqlite                # 向量存储后端
XPOD_EMBEDDING_MODEL=bge-small          # Embedding 模型
```

---

## 待讨论

- [ ] 具体页面设计
- [ ] 交互细节
- [ ] API 详细规范
- [ ] 开发计划
- [ ] AI API 详细字段定义
- [ ] Memory/RAG 数据结构设计
