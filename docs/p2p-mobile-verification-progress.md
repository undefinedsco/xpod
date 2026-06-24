# P2P Mobile Verification Progress

日期：2026-06-22；更新：2026-06-25

本文记录 raw TCP P2P 数据面在本地、Docker、Harmony、iPhone 路径上的验证进度。结论先行：

- 本地和 Docker 级别的自动化 smoke 可以证明控制面、信令、候选地址补全、raw TCP frame、node-side 转发和 managed-client fetch 的代码路径。
- 这些自动化 smoke **不能替代手机/跨 NAT 实网验收**。
- Harmony Mate 80 实机路径当前被应用签名信任链阻塞，尚未完成手机 P2P 验收。
- CI/CD 已支持 iOS 产物构建/分发；Xpod 侧仍需拿到 iPhone 真机运行后的 verifier JSON，才能把 iPhone P2P 记为通过。
- LinX Mobile 已具备 Android/iOS 原生 raw TCP P2P smoke bridge；Android 本机已构建 `1.0.1 (2)` product 与 p2pSmoke debug APK，但当前没有 ADB/HDC 连接设备，尚未完成手机安装后的实网 P2P 结果采集。

## 验证矩阵

| 路径 | 当前状态 | 证明内容 | 不能证明 |
| --- | --- | --- | --- |
| 本机 deterministic socket injection | 已有自动化测试入口 | route discovery、session 创建、node accept orchestration、`xpod-p2p-http/1` frame 转发 | 真实 TCP socket、跨 NAT simultaneous open |
| 本机 real TCP listener | 已有自动化测试入口 | Node TCP socket 上的数据面 round-trip | 跨 NAT simultaneous open、手机运行时能力 |
| Docker bridge E2E | 已有 smoke 与测试入口 | 两个容器之间的真实 TCP 数据面、signal-observed 地址补全 | 蜂窝/Wi-Fi NAT 行为、手机 OS socket 行为 |
| Harmony Mate 80 | HAP 可构建、可本地签名；安装被系统拒绝 | 项目结构、构建链、OpenHarmony 自签名包生成 | 商用 HarmonyOS 设备上的运行、真实 P2P 数据面 |
| Android LinX P2P Smoke | React Native bridge 已实现；本机已构建 `1.0.1 (2)` APK；未连接真机 | Android 原生 socket bridge、flavor 隔离、launcher 参数注入、JS verifier shape、APK 构建 | 真机网络/NAT 行为、手机上实际 PUT/GET 结果 |
| iPhone | CI/CD 已支持 iOS 产物构建/分发；真机 P2P 尚未执行 | 可通过 CI/CD 产物继续真机安装/分发；iOS bridge 代码已补齐 | socket 能力、实网 P2P、读写结果 |

## Harmony Mate 80 进度

设备与工具链记录：

- 设备：Huawei Mate 80，`VYG-AL00 6.1.0.125(SP9C00E120R3P7)`
- OpenHarmony API：`const.ohos.apiversion=24`
- HDC target：`62T0226101021775`
- UDID：`AF01642D8A0EB0B81FAEFFA72471E5AFE3D3549A60A2D42D588999EC2D4B5A3C`
- Harmony Command Line Tools：`26.0.0.461`，`HarmonyOS 26.0.0 Beta1`，`hvigor 6.26.1`

已完成：

1. 新增 `harmony/p2p-smoke` 最小 P2P smoke 工程，bundle 为 `com.undefineds.xpod.p2psmoke`。
2. `scripts/build-harmony-p2p-smoke.cjs` 可以发现 JDK、Hvigor 和 `DEVECO_SDK_HOME`，并把 HAP 输出到 `.artifacts/harmony-p2p-smoke/`。
3. 已生成 unsigned HAP：`.artifacts/harmony-p2p-smoke/entry-default-unsigned.hap`。
4. 用 OpenHarmony 本地工具链完成自签名：
   - `sign-profile success`
   - `sign-app success`
   - `verify-app success`
   - signed HAP：`.artifacts/harmony-p2p-smoke/entry-default-signed.hap`

阻塞点：

```text
code:9568257
error: fail to verify pkcs7 file.
```

设备 hilog 根因：

```text
it do not come from trusted root, issuer: C=CN, O=OpenHarmony, OU=OpenHarmony Team, CN=OpenHarmony Application Root CA
VerifyAppPkcs7: GetCertChains from pkcs7 failed
```

判断：商用 HarmonyOS 设备不信任 OpenHarmony 自签名 Root CA。要继续 Harmony 真机验收，需要二选一：

1. 使用华为 AGC / DevEco Studio 为 `com.undefineds.xpod.p2psmoke` 生成设备可信 debug profile 和证书；
2. 换 OpenHarmony 开发设备/镜像，允许 OpenHarmony 自签名应用安装。

因此当前不能声明 Harmony 手机 P2P 验收完成。

## Android LinX Mobile 进度

2026-06-25 更新：移动端仓库 `LinX-Mobile` 已提交 `c8577bf Enable phone-side P2P tunnel validation`，补齐 React Native P2P smoke entry、Android `p2pSmoke` flavor、Android native socket bridge、iOS bridge、ADB/HDC launcher 和 update prompt。移动端本地验证结果：

```text
npm run lint -> pass
./node_modules/.bin/tsc --noEmit -> pass
npm test -- --runInBand -> 7 suites / 56 tests passed
:app:assembleP2pSmokeDebug -> BUILD SUCCESSFUL
:app:assembleProductDebug -> BUILD SUCCESSFUL
```

构建产物：

```text
productDebug  com.linxmobile           1.0.1 (2)  b85209a8ae8d0b6f52dd88543bf00825400096212111a6dcba4a22aa1606075f
p2pSmokeDebug com.linxmobile.p2psmoke  1.0.1 (2)  e60d234d65375d94a716ae111cc47fdf81f327bffc69a90040822eda51db44a3
```

本机设备状态：`ANDROID_ADB_SERVER_PORT=5041 adb devices -l` 无连接设备；默认 ADB 端口 5037 被已有 smartsocket 占用；未发现可用 HDC。因此当前只能声明“手机端代码和 APK 构建通过”，不能声明“Android 真机 P2P 验收通过”。下一步需要把 `app-p2pSmoke-debug.apk` 安装到真机后运行 smoke，拿到 `mobile-result.json`。

## iPhone 进度

本机直连路径记录：当前 Mac 仅有 Command Line Tools：

```text
xcode-select -p -> /Library/Developer/CommandLineTools
xcodebuild requires Xcode
devicectl not found
xctrace not found
0 valid identities found
```

已清理磁盘空间用于后续安装完整 Xcode：

- 清理前约 11 GiB 可用；
- 清理后约 38 GiB 可用。

要走本机原生 iPhone 安装/日志路径，需要完整 Xcode、可用签名身份和真机信任。仅 Command Line Tools 不足以完成安装验收。

2026-06-23 更新：CI/CD 已支持 iOS 产物构建/分发，因此后续可通过 CI/CD 获取 iOS 安装包，不必把这台 Mac 安装完整 Xcode 作为唯一产包路径。Xpod 侧验收口径不变：CI/CD 支持 iOS 只解决产物构建/分发，不等于 P2P 数据面通过；仍需 iPhone 真机运行 smoke 后提交 `mobile-result.json`，并与 node-side `node-result.json` 一起通过 `bun run smoke:p2p:realnet -- verify`。

可选低成本替代：用 iSH / a-Shell 等终端类 App 手工运行 CLI/raw TCP smoke 脚本，只能验证“iPhone 上的非浏览器 runtime 是否可跑 raw TCP 路径”，不能替代正式 iOS App 打包安装。

## 自动化验证入口

代码侧当前推荐的验证分三层：

### 1. 类型检查

```bash
bun run build:ts
```

### 2. P2P / Harmony / Docker 相关 targeted tests

```bash
./scripts/run-vitest-safe.sh --run \
  tests/scripts/build-harmony-p2p-smoke.test.ts \
  tests/scripts/harmony-p2p-project.test.ts \
  tests/scripts/harmony-p2p-smoke-launch.test.ts \
  tests/scripts/docker-managed-p2p-e2e-smoke.test.ts \
  tests/scripts/p2p-android-realnet-smoke.test.ts \
  tests/scripts/p2p-realnet-acceptance.test.ts \
  tests/scripts/managed-client-p2p-smoke.test.ts \
  tests/scripts/edge-node-p2p-accept-smoke.test.ts \
  tests/edge/reachability/P2PRealnetAcceptance.test.ts \
  tests/edge/reachability/ManagedClientP2PLocalE2E.test.ts \
  tests/edge/reachability/TcpP2PDataPlaneTransport.test.ts \
  tests/edge/EdgeNodeAgent.test.ts \
  tests/api/handlers/ReachabilityHandler.test.ts \
  tests/api/auth/NodeTokenAuthenticator.test.ts \
  tests/api/container/local.test.ts
```

### 3. Docker bridge smoke

```bash
bun run smoke:p2p:docker-e2e
```

验收解释：Docker bridge smoke 成功时可以证明两个独立容器之间的真实 TCP 数据面和 signal-observed 地址补全；它仍不是手机/蜂窝跨 NAT 验收。

## 后续验收门槛

手机/实网 raw TCP P2P 验收必须收集双端 JSON：

1. node side：`smoke:p2p:node-accept --require-accept` 输出同一 `clientId` 的 `accepted` 事件；
2. client/mobile side：`route.kind = "p2p"`，`connectorEvents` 包含 `success`；
3. 默认验收不手填 `--host` / `--address`，候选地址由 signal API 观测补全，结果中应看到：
   - `clientAddress = "signal-observed"`
   - `accepted[].nodeAddress = "signal-observed"`
4. 使用 `bun run smoke:p2p:realnet -- verify` 汇总校验，移动端读写 smoke 需带 `--require-put-status-2xx`。

未满足以上条件时，只能说“自动化/本地/容器验证通过到某个边界”，不能说“手机 P2P 已验收”。
