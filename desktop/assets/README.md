# 桌面产品资产清单（§9.1 资产合同）

本目录的资产由 [`../scripts/generate-brand-assets.mjs`](../scripts/generate-brand-assets.mjs)
从相邻 homepage 检出的选定品牌几何**导入并生成**，产品侧不复制、不改写几何。
逐文件的来源与校验值记录在 [`brand-provenance.json`](./brand-provenance.json)，
本清单只说明来源、选定记录与生成方式。

## 来源与选定记录

- 选定记录：`homepage/public/brand/manifest.json`（`selectedAt: 2026-09-26`，
  `xpod: B · 留缝折角`），源几何为 `xpod-app.svg` 与 `xpod-symbol.svg`。
- App / Dock / 安装包：复制选定栅格 `xpod-app.png`（1024px，圆角瓦片外透明），
  与 `xpod-app.svg` 同源；生成脚本会先核对下列 sha256，源漂移即报错：

  | 源文件 | sha256 |
  |---|---|
  | `xpod-app.png` | `415585c548edc845d4f74bd811b6d4c8516d3c8fa3e0337d8e3e86e5152d2ab8` |
  | `xpod-app.svg` | `a7eacfade11a11252a65c0e7b691b095f06c9b3af749fc68d1fcfb177df7656b` |
  | `xpod-symbol.svg` | `1d6f23f4256fe442bdb22ad34e0edc231896e97d9a29feeafdf897462f898a49` |

- 登录展示：同一生成脚本逐字节导入 `xpod-app.svg` 到 `ui/src/assets/xpod-app.svg`，
  由现有 `XpodLoginBrand` 统一消费，不在组件里重画几何。
- AI 连接中的 Xpod 头像：生成脚本将同一 SVG 写入能力包现有的 `XPOD_AVATAR`
  数据 URI，避免运行时依赖 UI 应用，也无需维护第二份品牌几何。

- 选定前的旧资产保留在 `homepage/docs/reference/archive/2026-09-26-before-selection/`
  （D-05「保留旧 Logo」）；本目录不再保留盾牌/旧 X 托盘图形。

## 生成方式（无新增依赖）

```sh
# 默认读取仓库相邻的 homepage/public/brand；worktree 可显式指定源目录
bun desktop/scripts/generate-brand-assets.mjs /path/to/homepage/public/brand
```

脚本使用系统既有工具：`sips`（iconset 切片）、`iconutil`（`icon.icns` 打包）、
ImageMagick（托盘/预览栅格化）。生成是确定性的（已剥离 PNG 时间戳块）。

## 资产一览

| 资产 | 用途 | 派生 |
|---|---|---|
| `icon.png` / `icon-master.png` | Dock / 安装包母版 | 逐字节复制 `xpod-app.png` |
| `icon.icns` + `icon.iconset/*` | macOS 应用图标 | `sips -z` 切片，`iconutil` 打包 |
| `icon-size-preview.png` | 尺寸评审预览（800×160） | 由母版合成 |
| `tray-{healthy,starting,degraded,failed,stopped}Template.svg` | 托盘五态单色模板源 | 导入 `xpod-symbol.svg` 几何 + 状态镂空 |
| `tray-{state}Template.png` / `@2x.png` | 托盘 16/32 RGBA 模板 | 由对应 SVG 栅格化 |
| `trayTemplate.svg` / `.png` / `@2x.png` | 旧回退单色托盘 | 同上，无状态标记 |
| `tray.png` / `tray@2x.png` | 旧回退彩色托盘（墨紫 `#563E84`） | 由单色几何着色 |

托盘保持既有状态语义与单色 template 行为，仅把底盘几何替换为选定符号；
`brand-provenance.json` 记录每个生成文件的 sha256 与字节数，可用
`shasum -a 256` 复核。
