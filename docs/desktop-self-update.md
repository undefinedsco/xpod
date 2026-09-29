# 桌面端自助更新（macOS）

桌面版不依赖 Electron 内置的 `autoUpdater`。原因、实现与验收都集中在这里，改更新链路前先读完本文。

## 为什么不能用 Electron 内置更新

内置 `autoUpdater` 在 macOS 上把安装交给 Squirrel.Mac。Squirrel 会用**当前运行 app 的 designated requirement** 去校验下载下来的新 bundle：

- Xpod 没有 Apple Developer ID 证书，构建产物只有链接器给的 ad-hoc 签名；
- ad-hoc 签名的 designated requirement 就是一条 `cdhash H"…"`（`codesign -d -r- Xpod.app` 可验证），**任何其它构建都不可能满足它**，包括下一个版本；
- 结果：下载能完成，安装必然失败。

实测证据（0.4.17 → 0.4.18）：

```
checking-for-update
update-available
error: Code signature at URL file:///…/ShipIt/update.h6GsgN5/Xpod.app/ did not pass validation: 代码不含资源，但签名指示这些资源必须存在
```

先手工 `codesign --force --deep --sign -` 把 bundle 重新签成合法 ad-hoc 签名后，错误变成“代码未能满足指定的代码要求”（`cdhash` 不匹配），说明这条路在无证书前提下无解。

## 现在的链路

`desktop/src/self-updater.ts`（`DesktopSelfUpdater`）自己拥有整条更新路径，并复用 `DesktopUpdateManager` 的状态机与托盘呈现：

```
manifest → 下载（进度/速度/断点续传）→ 校验 → ditto 解包 → 独立脚本替换 bundle → 重启
```

1. **清单**：默认 `https://github.com/undefinedsco/xpod/releases/latest/download/latest-mac.yml`（electron-builder 随每个 release 发布，含 `version`、`path`、`sha512`、`size`）。也接受 Electron 更新 JSON（`{url,name}`，本地验收夹具与 `update.electronjs.org` 的形状）。
2. **下载**：写入 `<userData>/updates/<archive>.part`，带 `Range` 断点续传；每约 1 秒发一次 `download-progress`（已传字节、总量、百分比、速度），托盘实时显示。120 秒没有任何新字节即判定停滞并中止（保留 `.part` 供下次续传）。
3. **校验**：清单有 `sha512` 时以校验和为门禁；另外对解包后的 bundle 跑 `codesign --verify --deep --strict`（校验和已通过时签名失败只记日志，因为签名文件可能被包内后置写入改动）。
4. **安装**：`ditto -x -k` 解包到 `<userData>/updates/staged-<version>/`，并核对 `CFBundleShortVersionString` 与清单一致。
5. **替换**：写一个 `/bin/sh` 脚本（`<userData>/updates/install-update.sh`）后退出应用；脚本等待本进程 pid 消失，备份旧 bundle、`ditto` 拷入新 bundle，失败则回滚并重启旧版本。生产用 `open` 走 LaunchServices 重启，验收用 `XPOD_DESKTOP_UPDATE_RELAUNCH=direct` 直接 exec 以保留验收环境变量。

拒绝安装的两种情况：应用正在 App Translocation 只读路径运行（提示先拖进“应用程序”），以及当前用户对 app 所在目录没有写权限（提示手动安装或用 `Show Update Package…` 在 Finder 中取出已下载的包）。

## 构建期：ad-hoc 签名钩子

`desktop/scripts/after-pack-adhoc-sign.cjs`（`build.afterPack`）在打包后、生成 dmg/zip 前对 bundle 执行 `codesign --force --deep --sign -`，并立即 `codesign --verify --deep --strict` 自检。

- 没有这一步，arm64 产物只有链接器签名并且**不封资源**，`codesign --verify` 直接报 “code has no resources but signature indicates they must be present”；
- 有了这一步，签名合法（identifier 为 `co.undefineds.xpod`，`Sealed Resources version=2`），更新器才有可校验的结构证据；
- 钩子必须挂在 `afterPack`：electron-builder 只有在它自己签名时才会执行 `afterSign`（日志里的 `skipping "afterSign" hook as no signing occurred`）。

## 配置

| 环境变量 | 作用 |
| --- | --- |
| `XPOD_DESKTOP_UPDATE_FEED_URL` | 覆盖清单地址（HTTPS 或 loopback HTTP），可用于镜像或本地夹具 |
| `XPOD_DESKTOP_AUTO_CHECK_UPDATES` | 是否启动即检查，默认开 |
| `XPOD_DESKTOP_AUTO_INSTALL_UPDATES` | 下载完成后是否直接安装重启，默认关（托盘/对话框让用户确认） |
| `XPOD_DESKTOP_UPDATE_CHECK_INTERVAL_MS` | 轮询间隔，默认 6 小时 |
| `XPOD_DESKTOP_UPDATE_RELAUNCH` | `open`（默认）或 `direct`；验收用 `direct` |
| `XPOD_DESKTOP_UPDATE_ACCEPTANCE_LOG` / `_VERSION_FILE` / `_INSTALL_MARKER` | 验收证据文件 |

## 验收

```bash
cd desktop
node scripts/packaged-update-acceptance.mjs \
  --old /tmp/xpod-old/Xpod.app \
  --new-app release/mac-arm64/Xpod.app \
  --version 0.4.19 \
  --user-data /tmp/xpod-update-acceptance
```

`--new-app` 会先签名再打包成 zip（`--new-zip` 可直接给现成归档）。脚本拉起本地夹具 feed，启动旧包，并只在下列证据齐备时打印 `XPOD_UPDATE_ACCEPTANCE_OK <version>`：

- `update-events.log` 含 `checking-for-update`、`update-available`、`download-verified`、`update-downloaded`、`auto-install-ready`；
- `install-requested.txt` 等于新版本号；
- `accepted-version.txt` 由**重启后的新包**写成新版本号（旧包自己写的是旧版本号）。

> 注意：0.4.18 及更早的版本内置的是 Electron 更新器，它们**无法**通过这条链路升级，需要用户手动安装一次 0.4.19（或更新）安装包；从装上带自我更新器的版本开始，后续升级才走自助更新。

## 已知边界

- 归档目前只托管在 GitHub Releases。中国大陆网络下载 ~190 MB 可能很慢；进度、速度、停滞检测与断点续传让这一过程可见可续，`Show Update Package…` / `Download Latest Xpod…` 提供人工兜底。要彻底提速需要自建可达镜像（`XPOD_DESKTOP_UPDATE_FEED_URL` 已预留）。
- 换用 Developer ID 签名 + 公证是另一条长期路线：那样可以恢复系统级信任，但不影响当前自我更新机制。
