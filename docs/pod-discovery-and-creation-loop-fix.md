# Pod Discovery And Creation Loop Fix

## 背景

当前 LinX / Xpod 集成里，用户在浏览器 consent 流中可能进入 `/.account/account/` 或 `/.account/oidc/consent/` 相关路径后，被要求先创建 Pod。

用户实际反馈：

1. 账号已经有 Pod
2. 输入已存在的 Pod 名称时，后端报错：
   - `Pod creation failed: There already is a resource at https://id.undefineds.co/<name>/`
3. 但账号页 / Pod 列表里又看不到这个 Pod
4. 换一个新名字创建成功后，重新进入仍然继续要求创建 Pod

这说明“已有 Pod 判定”“Pod 列表展示”“创建 Pod 目标 URL”三条路径没有共享同一份真相。

## 直接结论

这不是单一 UI bug，而是以下几层逻辑未对齐：

1. **Pod 真正归属域与 Identity 域未分离清楚**
   - `id.undefineds.co` 应是身份域 / account / OIDC issuer
   - Pod 托管域应是 `pods.undefineds.co` 或用户真实 storage domain
   - 但现有链路里仍有代码把 WebID 或创建目标隐式推成 `https://id.undefineds.co/<name>/`

2. **账号页展示的 Pod 列表与创建接口成功/失败的真相源不同**
   - 创建阶段可能是“资源路径上已经存在”
   - 列表阶段却只看 `json.pods` 或其他映射，且未做统一归一化

3. **“是否已有 Pod”判断只看列表，不看 WebID->storage / profile / provision 侧证据**
   - 导致已有资源未被识别，用户被重复要求创建

## 本次客户端联调发现的证据

### 1. LinX 客户端曾错误地从 WebID 机械推导 Pod URL

在外部联调仓里，旧逻辑会把：

- `https://id.undefineds.co/ganbb/profile/card#me`

推成：

- `https://id.undefineds.co/ganbb/`

这与用户看到的错误 URL 一致，说明至少某些路径把 identity 域直接当作 Pod 基址。

虽然该错误已在客户端侧修复，但它暴露了服务端/API 也很可能存在相同的域名混淆。

### 2. Xpod UI 的 AccountPage 当前只展示 `controls.account.pod` 返回的 `json.pods`

见：

- [ui/src/pages/AccountPage.tsx](ui/src/pages/AccountPage.tsx)

当前逻辑：

- 先取 `controls.account.pod`
- `GET` 该地址
- 只读取 `json.pods`
- `setPods(Object.keys(podObj).map(id => ({ id })))`

问题：

1. 未归一化 Pod URL / storage URL / podId
2. 未同时结合 `webIdLinks`、profile 中的 `solid:storage`、consent 当前 webId 来判断
3. 如果 `json.pods` 不完整或返回的是另一种形态，UI 会误判“无 Pod”

### 3. 注册流在创建 Pod 后只等待 `pick-webid` 可见，不验证 storage/pod list 一致性

见：

- [ui/src/utils/registration-flow.ts](ui/src/utils/registration-flow.ts)

当前 `completeRegistrationProvisioning()`：

1. 调 `controls.account.pod` 创建 Pod
2. `defaultWaitForWebIdReady()` 轮询 `/.account/oidc/pick-webid/`
3. 如果 consent 可用则跳转 consent

问题：

- 它只验证“WebID 选项出现”，不验证“Pod 列表已同步”“当前 webId 的 storage 已就绪”
- 所以可能形成：
  - Pod 资源存在
  - WebID 存在
  - 但 AccountPage 的 Pod 列表仍为空
  - 上层继续判定“需要创建 Pod”

### 4. ProvisionPodCreator 明确区分了 identity WebID 与 storage URL

见：

- [src/provision/ProvisionPodCreator.ts](src/provision/ProvisionPodCreator.ts)

这里已经有正确方向：

- `webId` 指向 Cloud identity space
- `podUrl` / `canonicalStorageUrl` 指向真实 SP / storage domain

这说明架构上是知道“identity 与 storage 分离”的。

问题不是缺设计，而是**账户视图、列表接口、consent 前置判断没有完全复用这份设计真相**。

## 需要修改的内容

### A. 统一 Pod 真相源

**目标**：任何需要判断“用户是否已有 Pod”的逻辑，都必须走同一个归一化后的 Pod 视图。

建议新增共享服务，供 AccountPage、ConsentPage、注册流、Provision 完成后的回查共同使用：

- 候选位置：
  - `src/api/service/`
  - 或 `src/identity/`

建议职责：

1. 输入：
   - account id / session user
   - 相关 WebID
2. 汇总来源：
   - account controls / account repository 中的 pod records
   - webIdLinks
   - WebID Profile 中的 `solid:storage`
   - provision / pod lookup repository
3. 输出统一结构：
   - `pods: Array<{ podId, webId?, storageUrl, source, status }>`
   - `hasAnyPod: boolean`
   - `defaultPod?: { ... }`

### B. AccountPage 的 Pod 列表不能只信 `json.pods`

需要修改：

- [ui/src/pages/AccountPage.tsx](ui/src/pages/AccountPage.tsx)

建议：

1. 如果 `controls.account.pod` 仍返回 `json.pods`，先保留兼容
2. 但需要支持新的统一结构返回
3. UI 展示至少要区分：
   - Pod 名称
   - Storage URL
   - 对应 WebID
4. 如果 `webIdLinks` 已有值但 `pods` 为空，应展示“正在同步 Pod 信息”而不是直接视为“无 Pod”

### C. Consent 前置判断不能只看“是否有 webId”

当前问题是：即使用户已有 WebID，也可能因 Pod 列表为空而被要求创建 Pod。

需要梳理：

- `ui/src/pages/ConsentPage.tsx`
- `ui/src/context/AuthContext.tsx`
- `ui/src/pages/IndexPage.tsx`
- `ui/src/components/ProtectedRoute.tsx`

改动目标：

1. “是否允许进入 consent” 应看：
   - 是否有待处理 OIDC client
   - 是否至少存在一个可授权的 WebID
2. “是否要求创建 Pod” 应看：
   - 统一 Pod 视图 `hasAnyPod`
3. 不能把“Pod 列表为空”直接等价为“必须创建 Pod”，除非统一视图明确确认没有任何 Pod / storage / webId 绑定

### D. 创建 Pod 的冲突错误要返回规范化原因

当前用户看到的是：

- `There already is a resource at https://id.undefineds.co/<name>/`

这个错误暴露了内部资源地址，且容易误导用户以为 identity 域就是 Pod 域。

需要修改：

- [src/provision/ProvisionPodCreator.ts](src/provision/ProvisionPodCreator.ts)
- 以及实际处理 `controls.account.pod` 的 handler / store

建议：

1. 对“资源已存在”类错误做语义化映射：
   - `pod-name-taken`
   - `pod-already-exists-for-account`
   - `storage-conflict`
2. 返回结构化 JSON：
   - `error`
   - `message`
   - `podName`
   - `conflictingResource?`
3. UI 层再决定展示文案，不直接暴露底层 identity URL

### E. 注册流在创建成功后要等待“Pod 可见”，不是只等待“WebID 可见”

需要修改：

- [ui/src/utils/registration-flow.ts](ui/src/utils/registration-flow.ts)

新增等待逻辑：

1. 创建 Pod 成功后
2. 不仅轮询 `pick-webid`
3. 还要轮询：
   - 统一 Pod 视图接口
   - 或 account pod list 接口
4. 直到以下条件之一满足再跳转：
   - 当前 WebID 对应 storage 已存在
   - 当前 account 的 pod list 包含新建 Pod

否则会出现“创建完成 -> 页面回跳 -> 仍判定无 Pod -> 再次要求创建”的循环。

## 建议新增/调整的接口

如果现有 `controls.account.pod` 无法承载完整真相，建议在 account API 层新增一类面向 UI 的聚合接口，例如：

- `GET /.account/account/summary/`

返回：

```json
{
  "webIds": [
    {
      "webId": "https://id.undefineds.co/ganbb/profile/card#me",
      "storage": "https://ganbb.pods.undefineds.co/"
    }
  ],
  "pods": [
    {
      "podId": "ganbb",
      "storageUrl": "https://ganbb.pods.undefineds.co/",
      "webId": "https://id.undefineds.co/ganbb/profile/card#me",
      "status": "ready"
    }
  ],
  "hasAnyPod": true
}
```

然后：

- AccountPage 用它展示
- Consent / Index / ProtectedRoute 用它判断是否需要建 Pod
- 注册流用它轮询创建完成

## 验收标准

### 场景 1：账号已有 Pod

1. 用户登录后进入账号页
2. 能看到已有 Pod
3. 不再要求重复创建 Pod
4. Consent 流可以直接继续

### 场景 2：Pod 名称已被当前账号占用

1. 输入已存在的 Pod 名
2. UI 返回“该 Pod 已存在/已归属于当前账号”之类的结构化提示
3. 若该 Pod 已可用，应直接进入后续流程，而不是报错后卡死

### 场景 3：创建新 Pod 后立即回到 consent

1. 创建成功
2. 页面刷新/跳转后能识别刚创建的 Pod
3. 不会再次弹出“Create Pod”

### 场景 4：Identity 域与 Pod 域分离

1. 任何用户可见错误信息不再出现 `https://id.undefineds.co/<pod>/` 被当作 Pod 资源根
2. WebID 与 storage URL 在 UI/API 上都可区分

## 优先级建议

### P0

1. 修 `AccountPage` / consent 判定的统一 Pod 真相源
2. 修创建成功后的“Pod 可见性”等待条件
3. 修错误映射，避免直接暴露 identity 资源 URL

### P1

1. 补聚合 summary 接口
2. 在 UI 上同时展示 WebID 与 storage URL
3. 为“当前账号已拥有该 Pod”提供自动恢复流程

### P2

1. 清理所有仍从 WebID 机械推导 Pod URL 的旧逻辑
2. 把“identity / storage 分离”沉淀成 shared helper / service contract

## 受影响文件（建议重点检查）

### UI

- [ui/src/pages/AccountPage.tsx](ui/src/pages/AccountPage.tsx)
- [ui/src/pages/ConsentPage.tsx](ui/src/pages/ConsentPage.tsx)
- [ui/src/pages/IndexPage.tsx](ui/src/pages/IndexPage.tsx)
- [ui/src/components/ProtectedRoute.tsx](ui/src/components/ProtectedRoute.tsx)
- [ui/src/utils/registration-flow.ts](ui/src/utils/registration-flow.ts)

### Provision / API

- [src/provision/ProvisionPodCreator.ts](src/provision/ProvisionPodCreator.ts)
- [src/api/container/routes.ts](src/api/container/routes.ts)
- `controls.account.pod` 背后的 handler / repository

### Domain / model

- account / webId / pod 聚合查询所在 service / repository
- 任何仍把 WebID pathname 直接等同于 Pod base URL 的 helper

