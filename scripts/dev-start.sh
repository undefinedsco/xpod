#!/bin/bash
#
# 开发环境一键启动脚本
#
# 自动完成:
# 1. 清理旧数据
# 2. 启动 Cloud (带 Seed)
# 3. 等待服务就绪
# 4. 初始化 Client Credentials
# 5. 创建测试 Node
# 6. 输出环境变量供 Local 使用
#
# 用法:
#   ./scripts/dev-start.sh           # 启动 Cloud
#   ./scripts/dev-start.sh --local   # 启动 Local (连接已运行的 Cloud)
#   ./scripts/dev-start.sh --all     # 启动 Cloud + Local (两个进程)
#   bun run settings:dev             # 只启动 Dashboard Vite 调试服务
#   bun run settings:open            # 打开已运行 Xpod 的 /dashboard/models
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
CSS_PORT="${CSS_PORT:-6300}"
API_PORT="${API_PORT:-6301}"
CSS_BASE="http://localhost:$CSS_PORT"
API_BASE="http://localhost:$API_PORT"
ENV_FILE="$PROJECT_DIR/.env.dev.generated"
CLOUD_PID=""

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

cleanup_cloud() {
  local pid="${CLOUD_PID:-}"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

trap cleanup_cloud EXIT
trap 'cleanup_cloud; exit 130' INT
trap 'cleanup_cloud; exit 143' TERM

http_status() {
  printf '%s' "$1" | awk -F: '/^HTTP_STATUS:/ { status=$2 } END { print status }'
}

http_body() {
  printf '%s' "$1" | sed '/^HTTP_STATUS:/d'
}

http_success() {
  case "$1" in
    2??) return 0 ;;
    *) return 1 ;;
  esac
}

json_string_value() {
  local key=$1
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

curl_json() {
  curl -sS --proto '=http,https' --max-redirs 0 -w '\nHTTP_STATUS:%{http_code}\n' "$@"
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

validate_single_line() {
  local name=$1
  local value=$2
  local max_length=${3:-4096}

  if [ -z "$value" ] || [ "${#value}" -gt "$max_length" ]; then
    log_error "非法环境变量值: $name 长度无效"
    return 1
  fi
  case "$value" in
    *$'\n'*|*$'\r'*)
      log_error "非法环境变量值: $name 必须是单行"
      return 1
      ;;
  esac
}

validate_env_value() {
  local name=$1
  local value=$2
  local kind=${3:-secret}

  case "$kind" in
    id)
      validate_single_line "$name" "$value" 512 || return 1
      if [[ ! "$value" =~ ^[A-Za-z0-9._:@%+=,/~:-]+$ ]]; then
        log_error "非法环境变量值: $name 字符集无效"
        return 1
      fi
      ;;
    url)
      validate_single_line "$name" "$value" 2048 || return 1
      if ! node -e '
const value = process.argv[1];
try {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
' "$value"; then
        log_error "非法环境变量值: $name 必须是无 credentials 的 http(s) URL"
        return 1
      fi
      ;;
    secret)
      validate_single_line "$name" "$value" 4096 || return 1
      ;;
    token)
      validate_single_line "$name" "$value" 4096 || return 1
      if [[ ! "$value" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
        log_error "非法环境变量值: $name 字符集无效"
        return 1
      fi
      ;;
    *)
      log_error "未知环境变量类型: $kind"
      return 1
      ;;
  esac
}

write_env_value() {
  local name=$1
  local value=$2
  local kind=${3:-secret}

  validate_env_value "$name" "$value" "$kind" || return 1
  printf '%s=%s\n' "$name" "$(shell_quote "$value")" >> "$ENV_FILE"
}

is_sensitive_env_name() {
  local upper
  upper=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')

  case "$upper" in
    *SECRET|*_SECRET|*TOKEN|*_TOKEN|*AUTHTOKEN|PASSWORD|*_PASSWORD|*API_KEY|*_API_KEY|*APIKEY|*_APIKEY|*PRIVATE_KEY|*_PRIVATE_KEY)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

redact_env_output() {
  local line
  local name

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *=*)
        name="${line%%=*}"
        if is_sensitive_env_name "$name"; then
          printf '%s=[redacted]\n' "$name"
        else
          printf '%s\n' "$line"
        fi
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done
}

validate_credentials_url() {
  local credentials_url=$1

  validate_env_value clientCredentials "$credentials_url" url || return 1
  if ! node -e '
const [baseValue, targetValue] = process.argv.slice(1);
try {
  const base = new URL(baseValue);
  const target = new URL(targetValue);
  if (target.origin !== base.origin) {
    process.exit(2);
  }
  if (!/^\/\.account\/account\/[^/]+\/client-credentials\/?$/.test(target.pathname)) {
    process.exit(3);
  }
  if (target.search || target.hash) {
    process.exit(4);
  }
} catch {
  process.exit(1);
}
' "$CSS_BASE" "$credentials_url"; then
    log_error "clientCredentials endpoint 不可信: 必须与 CSS_BASE 同源且位于 account client-credentials control 路径"
    return 1
  fi
}

# 等待服务就绪
wait_for_service() {
  local url=$1
  local name=$2
  local max_attempts=${3:-30}
  local attempt=1

  log_info "等待 $name 就绪..."
  while [ $attempt -le $max_attempts ]; do
    if curl -s "$url" > /dev/null 2>&1; then
      log_success "$name 已就绪"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  log_error "$name 启动超时"
  return 1
}

# 初始化 credentials
init_credentials() {
  log_info "初始化 Client Credentials..."

  # 测试账号
  local email="test@dev.local"
  local password="test123456"
  local pod_name="test"

  # 1. 登录并取得 CSS Account token
  log_info "登录 $email..."
  local login_response
  if ! login_response=$(curl_json -X POST "$CSS_BASE/.account/login/password/" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" 2>&1); then
    log_error "Client Credentials 初始化失败: 登录请求失败"
    return 1
  fi

  local login_status=$(http_status "$login_response")
  local login_body=$(http_body "$login_response")
  local account_token=$(printf '%s' "$login_body" | json_string_value authorization)

  if ! http_success "$login_status" || ! validate_env_value authorization "$account_token" token; then
    log_error "Client Credentials 初始化失败: 登录失败 (HTTP ${login_status:-unknown})"
    printf '%s\n' "$login_body"
    return 1
  fi

  # 2. 读取 account controls，使用服务端公布的 clientCredentials endpoint
  log_info "读取 Account controls..."
  local controls_response
  if ! controls_response=$(curl_json "$CSS_BASE/.account/" \
    -H "Accept: application/json" \
    -H "Authorization: CSS-Account-Token $account_token" 2>&1); then
    log_error "Client Credentials 初始化失败: Account controls 请求失败"
    return 1
  fi

  local controls_status=$(http_status "$controls_response")
  local controls_body=$(http_body "$controls_response")
  local credentials_url=$(printf '%s' "$controls_body" | json_string_value clientCredentials)

  if ! http_success "$controls_status" || [ -z "$credentials_url" ]; then
    log_error "Client Credentials 初始化失败: 无法获取 clientCredentials endpoint (HTTP ${controls_status:-unknown})"
    printf '%s\n' "$controls_body"
    return 1
  fi
  validate_credentials_url "$credentials_url" || return 1

  # 3. 创建 Client Credentials
  log_info "创建 Client Credentials..."
  local cred_response
  if ! cred_response=$(curl_json -X POST "$credentials_url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "Authorization: CSS-Account-Token $account_token" \
    -d "{\"name\":\"dev-test\",\"webId\":\"$CSS_BASE/$pod_name/profile/card#me\"}" 2>&1); then
    log_error "Client Credentials 初始化失败: 创建请求失败"
    return 1
  fi

  # 解析响应
  local cred_status=$(http_status "$cred_response")
  local cred_body=$(http_body "$cred_response")
  local client_id=$(printf '%s' "$cred_body" | json_string_value id)
  local client_secret=$(printf '%s' "$cred_body" | json_string_value secret)

  if http_success "$cred_status" && [ -n "$client_id" ] && [ -n "$client_secret" ]; then
    write_env_value XPOD_CLIENT_ID "$client_id" id || return 1
    write_env_value XPOD_CLIENT_SECRET "$client_secret" secret || return 1
    log_success "Client Credentials 已创建: $client_id"
    echo "XPOD_CLIENT_ID=$client_id"
  else
    log_error "Client Credentials 初始化失败: 创建失败或响应缺少 id/secret (HTTP ${cred_status:-unknown})"
    return 1
  fi
}

# 创建测试 Node
create_test_node() {
  log_info "创建测试 Node..."

  local response
  if ! response=$(curl_json -X POST "$API_BASE/dev/setup" \
    -H "Content-Type: application/json" \
    -d '{"testId":"dev-session","displayName":"Dev Test Node"}' 2>/dev/null); then
    log_error "Node 创建失败"
    return 1
  fi

  local node_status=$(http_status "$response")
  local node_body=$(http_body "$response")
  local node_id=$(printf '%s' "$node_body" | json_string_value nodeId)
  local node_token=$(printf '%s' "$node_body" | json_string_value token)
  local signaling_url=$(printf '%s' "$node_body" | json_string_value signalingUrl)

  if http_success "$node_status" && [ -n "$node_id" ] && [ -n "$node_token" ]; then
    write_env_value XPOD_NODE_ID "$node_id" id || return 1
    write_env_value XPOD_NODE_TOKEN "$node_token" token || return 1
    if [ -n "$signaling_url" ]; then
      write_env_value XPOD_SIGNALING_URL "$signaling_url" url || return 1
    fi
    log_success "Node 已创建: $node_id"
  else
    log_error "Node 创建失败 (HTTP ${node_status:-unknown})"
    printf '%s\n' "$node_body"
    return 1
  fi
}

# 启动 Cloud
start_cloud() {
  log_info "启动 Cloud 服务..."

  # 清理旧的环境变量文件
  rm -f "$ENV_FILE"
  echo "# 自动生成的开发环境变量 - $(date)" > "$ENV_FILE"
  write_env_value NODE_ENV development id

  # 启动服务
  NODE_ENV=development CSS_SEED_CONFIG="$PROJECT_DIR/config/seed.dev.json" \
    bun run dev:cloud &
  CLOUD_PID=$!
  write_env_value CLOUD_PID "$CLOUD_PID" id

  # 等待服务就绪
  wait_for_service "$API_BASE/health" "API Server" 60 || {
    exit 1
  }

  wait_for_service "$CSS_BASE/.well-known/openid-configuration" "CSS" 60 || {
    exit 1
  }

  # 初始化
  sleep 2  # 等待 seed 完成
  init_credentials || {
    exit 1
  }
  create_test_node || {
    exit 1
  }

  echo ""
  log_success "Cloud 服务已启动!"
  echo ""
  echo "=========================================="
  echo "环境变量已保存到: $ENV_FILE"
  echo "=========================================="
  redact_env_output < "$ENV_FILE"
  echo "=========================================="
  echo ""
  echo "启动 Local 节点:"
  echo "  source $ENV_FILE && bun run dev:seed"
  echo ""
  echo "或运行测试:"
  echo "  bun run dev:test"
  echo ""
  echo "Dashboard:"
  echo "  已运行的 Xpod: $CSS_BASE/dashboard/models"
  echo "  打开设置页: bun run settings:open"
  echo ""
  echo "按 Ctrl+C 停止服务"

  # 等待进程
  wait $CLOUD_PID
}

# 启动 Local
start_local() {
  if [ ! -f "$ENV_FILE" ]; then
    log_error "未找到环境变量文件: $ENV_FILE"
    log_error "请先运行: ./scripts/dev-start.sh"
    exit 1
  fi

  log_info "加载环境变量..."
  source "$ENV_FILE"

  if [ -z "$XPOD_NODE_ID" ] || [ -z "$XPOD_NODE_TOKEN" ]; then
    log_error "缺少 XPOD_NODE_ID 或 XPOD_NODE_TOKEN"
    exit 1
  fi

  log_info "启动 Local 节点..."
  log_info "  Node ID: $XPOD_NODE_ID"
  log_info "  Signaling URL: $XPOD_SIGNALING_URL"

  NODE_ENV=development \
    XPOD_NODE_ID="$XPOD_NODE_ID" \
    XPOD_NODE_TOKEN="$XPOD_NODE_TOKEN" \
    XPOD_SIGNALING_URL="$XPOD_SIGNALING_URL" \
    CSS_SEED_CONFIG="$PROJECT_DIR/config/seed.dev.json" \
    bun run dev:seed
}

# 主逻辑
case "${1:-}" in
  --local|-l)
    start_local
    ;;
  --all|-a)
    log_error "--all 模式暂未实现，请在两个终端分别运行:"
    echo "  终端1: ./scripts/dev-start.sh"
    echo "  终端2: ./scripts/dev-start.sh --local"
    exit 1
    ;;
  --help|-h)
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  (无参数)    启动 Cloud 服务"
    echo "  --local     启动 Local 节点 (需要先启动 Cloud)"
    echo "  --help      显示帮助"
    echo ""
    echo "Dashboard:"
    echo "  bun run settings:dev   只启动 Dashboard Vite 调试服务"
    echo "  bun run settings:open  打开已运行 Xpod 的 /dashboard/models"
    ;;
  *)
    start_cloud
    ;;
esac
