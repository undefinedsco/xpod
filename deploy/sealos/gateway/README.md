# Sealos 入口 App：单 `nginx`，多域名，多端口

> 适用场景：Sealos【应用管理】里“一个域名绑定一个端口”，但你希望只维护一个入口 App。

## 结论

不要给每个域名单独起一个 `nginx`。

直接起 **一个** `nginx` App，暴露多组端口，每个端口在 Sealos 里绑定一个域名：

| 域名 | 网关端口 | 集群内上游 |
| --- | --- | --- |
| `example.com` | `8081` | `homepage.ns-1yl0rye9.svc.cluster.local:80` |
| `id.example.com` | `8082` | `xpod.ns-1yl0rye9.svc.cluster.local:80` |
| `pods.example.com` | `8083` | `xpod.ns-1yl0rye9.svc.cluster.local:80` |
| `api.example.com` | `8084` | `xpod.ns-1yl0rye9.svc.cluster.local:80` |
| `discovery.example.com` | `8085` | `discovery.ns-1yl0rye9.svc.cluster.local:80` |
| `billing.example.com` | `8086` | `billing.ns-1yl0rye9.svc.cluster.local:80` |

这就是当前最省事的 **方案 A**。

## `undefineds.site` 要不要配

要配，但**不是**配到这个入口 `nginx` 上。

`undefineds.site` 的角色是 **local SP / edge 节点子域名根域**，对应 `xpod cloud` 里的 `CSS_BASE_STORAGE_DOMAIN`。代码里它会触发：

- DDNS 路由注册
- Provision 时预分配 `spDomain`
- DNS / tunnel 协调服务启用

也就是说，它更像：

- `<node-id>.undefineds.site`
- `<some-sp>.undefineds.site`

这类**动态子域名根域**，不是 `pods/api/discovery/homepage` 这种固定业务入口域名。

所以这里要分开看：

- `pods/api/discovery/homepage/billing`：走入口 `nginx`
- `undefineds.site`：写进 `xpod cloud` 环境变量 `CSS_BASE_STORAGE_DOMAIN=undefineds.site`

如果你要启用 local SP 子域名分配，还需要把 `undefineds.site` 交给你实际使用的 DNS Provider 管理，并配好对应 Token；**不是**给它单独绑定一个网关端口。

## 直接可填的 Sealos App 配置

### 应用基本信息

```text
应用名称: gateway
镜像:     nginx:1.27-alpine
CPU:      0.1 Core
内存:     128 MiB
副本数:   1
```

如果后面有大文件上传、长连接较多，再提到：

```text
CPU:  0.2 Core
内存: 256 MiB
```

### 端口

在 Sealos App 里添加这些容器端口：

```text
8081  -> example.com
8082  -> id.example.com
8083  -> pods.example.com
8084  -> api.example.com
8085  -> discovery.example.com
8086  -> billing.example.com
```

要点只有一个：

- **每个域名只绑一个端口**

### 健康检查

任意选一个业务端口做健康检查即可，建议：

```text
协议: HTTP
端口: 8081
路径: /healthz
```

## 环境变量

直接参考 `deploy/sealos/gateway/env.example`：

```bash
HOMEPAGE_PORT=8081
ID_PORT=8082
PODS_PORT=8083
API_PORT=8084
DISCOVERY_PORT=8085
BILLING_PORT=8086

HOMEPAGE_UPSTREAM=http://homepage.ns-1yl0rye9.svc.cluster.local:80
ID_UPSTREAM=http://xpod.ns-1yl0rye9.svc.cluster.local:80
PODS_UPSTREAM=http://xpod.ns-1yl0rye9.svc.cluster.local:80
API_UPSTREAM=http://xpod.ns-1yl0rye9.svc.cluster.local:80
DISCOVERY_UPSTREAM=http://discovery.ns-1yl0rye9.svc.cluster.local:80
BILLING_UPSTREAM=http://billing.ns-1yl0rye9.svc.cluster.local:80

CLIENT_MAX_BODY_SIZE=128m
```

如果入口 App 和后端在同一个 namespace，也可以直接写短 Service 名：

```bash
HOMEPAGE_UPSTREAM=http://homepage:80
ID_UPSTREAM=http://xpod:80
PODS_UPSTREAM=http://xpod:80
API_UPSTREAM=http://xpod:80
DISCOVERY_UPSTREAM=http://discovery:80
BILLING_UPSTREAM=http://billing:80
```

## 启动命令

### Command

```text
/bin/sh
```

### Args

```sh
-c
cat >/etc/nginx/conf.d/default.conf <<EOF
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen \${PODS_PORT};
  server_name _;
  client_max_body_size \${CLIENT_MAX_BODY_SIZE};

  location = /healthz {
    default_type text/plain;
    return 200 'ok';
  }

  location / {
    proxy_pass \${PODS_UPSTREAM};
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_redirect off;
    proxy_buffering off;
  }
}

server {
  listen \${API_PORT};
  server_name _;
  client_max_body_size \${CLIENT_MAX_BODY_SIZE};

  location = /healthz {
    default_type text/plain;
    return 200 'ok';
  }

  location / {
    proxy_pass \${API_UPSTREAM};
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_redirect off;
    proxy_buffering off;
  }
}

server {
  listen \${DISCOVERY_PORT};
  server_name _;
  client_max_body_size \${CLIENT_MAX_BODY_SIZE};

  location = /healthz {
    default_type text/plain;
    return 200 'ok';
  }

  location / {
    proxy_pass \${DISCOVERY_UPSTREAM};
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_redirect off;
    proxy_buffering off;
  }
}

server {
  listen \${HOMEPAGE_PORT};
  server_name _;
  client_max_body_size \${CLIENT_MAX_BODY_SIZE};

  location = /healthz {
    default_type text/plain;
    return 200 'ok';
  }

  location / {
    proxy_pass \${HOMEPAGE_UPSTREAM};
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_redirect off;
    proxy_buffering off;
  }
}

server {
  listen \${BILLING_PORT};
  server_name _;
  client_max_body_size \${CLIENT_MAX_BODY_SIZE};

  location = /healthz {
    default_type text/plain;
    return 200 'ok';
  }

  location / {
    proxy_pass \${BILLING_UPSTREAM};
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_redirect off;
    proxy_buffering off;
  }
}
EOF
exec nginx -g 'daemon off;'
```

## 如果你要自己构建镜像

仓库里也已经有现成模板：

- `deploy/sealos/gateway/Dockerfile`
- `deploy/sealos/gateway/default.conf.template`

构建命令：

```bash
IMAGE=ghcr.io/<your-org>/sealos-gateway:0.1.0

docker build -t "$IMAGE" -f deploy/sealos/gateway/Dockerfile deploy/sealos/gateway
docker push "$IMAGE"
```

这时镜像里已经带好多端口模板，App 里只需要填环境变量即可。

## 你现在应该怎么配

### 入口 `nginx`

- 裸域 `example.com` 绑 `8081`
- `id` 绑 `8082`
- `pods` 绑 `8083`
- `api` 绑 `8084`
- `discovery` 绑 `8085`
- `billing` 绑 `8086`

### `xpod cloud`

- `CSS_BASE_URL=https://id.<你的主域名>`
- `CSS_ALLOWED_HOSTS=id.<你的主域名>,pods.<你的主域名>,api.<你的主域名>`
- `CSS_BASE_STORAGE_DOMAIN=undefineds.site`

## 文件

- 模板：`deploy/sealos/gateway/default.conf.template`
- 环境变量：`deploy/sealos/gateway/env.example`
- 云端部署：`deploy/sealos/cloud/DEPLOY.md`

```bash
XPOD_BASE_URL=https://id.example.com
XPOD_ISSUER=https://id.example.com
XPOD_JWKS_URL=https://id.example.com/.oidc/jwks
```

### discovery

- 现成 K8s Service 名：`discovery`
- 端口：`80 -> 3000`
- 参考：`~/develop/discovery/deploy/k8s/service.yaml`

## DNS 怎么填

这套方案里，这些业务域名都指向 **同一个 gateway 应用的公网地址**。

也就是：

```text
example.com            -> gateway 的 Public Address
id.example.com         -> gateway 的 Public Address
pods.example.com       -> gateway 的 Public Address
api.example.com        -> gateway 的 Public Address
billing.example.com    -> gateway 的 Public Address
discovery.example.com  -> gateway 的 Public Address
```

- 裸域 `example.com`：
  - DNS 服务商支持 `ALIAS / ANAME / CNAME flattening` 就用它
  - 如果 Sealos 给的是 IP，也可以直接填 `A`
- 子域名：
  - Sealos 给的是域名就填 `CNAME`
  - 给的是 IP 就填 `A`

## 风险提示

这套方案能否完整跑通，关键取决于 Sealos【应用管理】是否允许**同一个应用绑定多个自定义域名**。

- 如果允许：方案 A 可以继续推进
- 如果不允许：回退到方案 B（多个公网入口）

## 冒烟检查

在 DNS 生效后检查：

```bash
curl -I https://example.com/healthz
curl -I https://id.example.com/healthz
curl -I https://pods.example.com/healthz
curl -I https://api.example.com/healthz
curl -I https://billing.example.com/healthz
curl -I https://discovery.example.com/healthz
```

以及：

```bash
curl -I https://example.com/
curl -I https://id.example.com/service/status
curl -I https://pods.example.com/service/status
curl -I https://api.example.com/healthz
curl -I https://billing.example.com/healthz
curl -I https://discovery.example.com/health
```
