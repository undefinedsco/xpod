# Xpod Desktop

Tauri 桌面应用，将 Xpod 服务打包为本地应用。

## 目录结构

```
desktop/
├── package.json          # 桌面应用配置
├── src/
│   ├── api.ts           # Tauri API 封装
│   └── DesktopApp.tsx   # 桌面应用入口组件
└── rust/                # Rust 后端
    ├── Cargo.toml
    ├── src/
    │   ├── main.rs           # 主程序
    │   └── process_manager.rs # 进程管理
    └── tauri.conf.json
```

## 开发

### 1. 安装依赖

```bash
cd desktop
yarn install
```

### 2. 开发模式

```bash
# 启动 Tauri 开发模式（会自动启动前端 dev server）
yarn dev
```

### 3. 构建

```bash
# 构建完整桌面应用（包含 sidecar）
cd ..
yarn build:desktop:all

# 或者分步构建
yarn build:desktop          # 构建 TypeScript + sidecar
cd desktop && yarn build    # 构建 Tauri 应用
```

## 打包说明

### Sidecar 打包

使用 `pkg` 将 Node 服务打包为可执行文件：

```bash
yarn build:desktop:sidecar
```

输出位置：`desktop/rust/sidecar/xpod-server`

### Tauri 构建

```bash
cd desktop/rust
cargo tauri build
```

输出位置：
- macOS: `desktop/rust/target/release/bundle/dmg/Xpod_*.dmg`
- Windows: `desktop/rust/target/release/bundle/msi/Xpod_*.msi`
- Linux: `desktop/rust/target/release/bundle/deb/xpod_*.deb`

## 配置

### 环境变量

Tauri 启动 Node 服务时会设置以下环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `XPOD_GATEWAY_PORT` | 网关端口 | 自动分配 |
| `XPOD_DATA_DIR` | 数据目录 | `~/Library/Application Support/Xpod` |
| `XPOD_MODE` | 运行模式 | `desktop` |
| `NODE_ENV` | Node 环境 | `production` |

### 数据目录

- **macOS**: `~/Library/Application Support/Xpod/`
- **Windows**: `%APPDATA%/Xpod/`
- **Linux**: `~/.config/xpod/`

## 功能

- ✅ 系统托盘图标
- ✅ 窗口最小化到托盘
- ✅ 自动启动服务
- ✅ 服务状态监控
- ✅ 自动更新（配置中预留）

## 注意事项

1. **首次启动**：应用会自动启动 xpod-server，可能需要几秒钟
2. **数据持久化**：数据存储在系统标准应用数据目录
3. **端口冲突**：如果默认端口被占用，会自动寻找可用端口
