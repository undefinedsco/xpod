# 多服务多二级域名入口方案（Sealos）

> 适用场景：`xpod`、`billing`、`discovery` 都跑在同一个 Sealos 集群，但使用不同二级域名。

> 注意：这份文档描述的是原生 Kubernetes `Ingress` 方案。对于 Sealos【应用管理】，当前更推荐 `deploy/sealos/gateway/README.md` 里的单入口 `nginx` App；原生 `kubectl` 创建的资源不会出现在应用管理列表里，自定义域名能力也以平台实际支持为准。

## 结论

- 在原生 Kubernetes 维度，可以直接用 `Ingress`
- 但在当前 Sealos 场景，更推荐一个独立 `gateway` App 做统一入口
- 如果三个服务在不同 namespace，推荐每个服务各自维护一个 `Ingress`
- 不建议依赖 Sealos 自动分配域名来做这类手写 `Ingress`；最稳的是用你自己的域名

## 推荐域名示例

```text
pods.example.com       -> xpod
billing.example.com    -> billing
discovery.example.com  -> discovery
```

## 推荐做法

### 1. 每个应用一个 Ingress

原因：

- 标准 `Ingress` backend 默认只引用同 namespace 下的 `Service`
- 你这三个项目大概率会分 namespace 部署
- 这样每个项目自己管理自己的域名、TLS、回滚更清晰

### 2. 使用自有域名

- `App Launchpad` 自动分配的 Sealos 域名更适合“单应用直接公网暴露”
- 多应用统一子域名路由，更适合你自己的域名 + DNS + Ingress

## 当前三个项目的已知信息

### xpod

- 现有 Service：`xpod`
- 现有端口：`80 -> 3000`
- 现有 Ingress 示例：`deploy/sealos/cloud/ingress.yaml`

### discovery

- 现有 Service：`discovery`
- 现有端口：`80 -> 3000`
- 现有清单位置：`~/develop/discovery/deploy/k8s/service.yaml`

### billing

- 当前仓库里还没有现成 K8s 清单
- `billing-api` 默认监听端口是 `8080`
- 参考位置：`~/develop/billing/internal/platform/config/config.go`

因此 `billing` 至少还需要一个类似下面的 Service：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: billing
  namespace: billing
spec:
  selector:
    app: billing
  ports:
    - name: http
      port: 80
      targetPort: 8080
```

## 示例文件

我已经放了一份多应用示例：

- `deploy/sealos/cloud/ingress.multi-apps.example.yaml`

这份示例采用“每个服务一个 Ingress”的写法，适合：

- `xpod` 在 `xpod-cloud` namespace
- `billing` 在 `billing` namespace
- `discovery` 在 `discovery` namespace

## TLS 注意事项

- `Ingress.spec.tls.secretName` 引用的证书 Secret 必须存在于 **同一个 namespace**
- 如果你使用同一个泛域名证书，需要把证书 Secret 分别放到各个 namespace
- 或者每个 namespace 自己签发自己的证书

## DNS 注意事项

在 Cloudflare 里把这些记录都指向 Sealos 对外入口：

```text
pods.example.com       CNAME -> <sealos-entry>
billing.example.com    CNAME -> <sealos-entry>
discovery.example.com  CNAME -> <sealos-entry>
```

## 什么时候才需要再套一层 Nginx

只有在下面这些情况才值得：

- 你想把多个服务挂在一个路径树下，而不是多个子域名
- 你需要统一鉴权、复杂 rewrite、灰度流量
- 你不想让每个应用自己维护 Ingress

否则如果你在 Sealos【应用管理】里做公网暴露，优先使用 `gateway` App 方案。
