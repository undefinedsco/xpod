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

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

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

  # 1. 登录
  log_info "登录 $email..."
  local login_response
  login_response=$(curl -s -c - -b - -X POST "$CSS_BASE/.account/login/password/" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" 2>/dev/null) || true

  # 获取 cookie (简化处理，实际可能需要更复杂的 cookie 管理)
  local cookie_file=$(mktemp)
  curl -s -c "$cookie_file" -X POST "$CSS_BASE/.account/login/password/" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" > /dev/null 2>&1 || true

  # 2. 创建 Client Credentials
  log_info "创建 Client Credentials..."
  local cred_response
  cred_response=$(curl -s -b "$cookie_file" -X POST "$CSS_BASE/.account/client-credentials/" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"dev-test\",\"webId\":\"$CSS_BASE/$pod_name/profile/card#me\"}" 2>/dev/null) || true

  rm -f "$cookie_file"

  # 解析响应
  local client_id=$(echo "$cred_response" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
  local client_secret=$(echo "$cred_response" | grep -o '"secret":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$client_id" ] && [ -n "$client_secret" ]; then
    log_success "Client Credentials 已创建"
    echo "XPOD_CLIENT_ID=$client_id"
    echo "XPOD_CLIENT_SECRET=$client_secret"

    # 保存到环境变量文件
    echo "XPOD_CLIENT_ID=$client_id" >> "$ENV_FILE"
    echo "XPOD_CLIENT_SECRET=$client_secret" >> "$ENV_FILE"
  else
    log_warn "Client Credentials 创建失败，使用 /dev/setup 替代"
  fi
}

# 创建测试 Node
create_test_node() {
  log_info "创建测试 Node..."

  local response
  response=$(curl -s -X POST "$API_BASE/dev/setup" \
    -H "Content-Type: application/json" \
    -d '{"testId":"dev-session","displayName":"Dev Test Node"}' 2>/dev/null)

  local node_id=$(echo "$response" | grep -o '"nodeId":"[^"]*"' | cut -d'"' -f4)
  local node_token=$(echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  local signaling_url=$(echo "$response" | grep -o '"signalingUrl":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$node_id" ] && [ -n "$node_token" ]; then
    log_success "Node 已创建: $node_id"

    # 保存到环境变量文件
    echo "XPOD_NODE_ID=$node_id" >> "$ENV_FILE"
    echo "XPOD_NODE_TOKEN=$node_token" >> "$ENV_FILE"
    echo "XPOD_SIGNALING_URL=$signaling_url" >> "$ENV_FILE"
  else
    log_error "Node 创建失败"
    echo "$response"
    return 1
  fi
}

# 启动 Cloud
start_cloud() {
  log_info "启动 Cloud 服务..."

  # 清理旧的环境变量文件
  rm -f "$ENV_FILE"
  echo "# 自动生成的开发环境变量 - $(date)" > "$ENV_FILE"
  echo "NODE_ENV=development" >> "$ENV_FILE"

  # 启动服务
  NODE_ENV=development CSS_SEED_CONFIG="$PROJECT_DIR/config/seed.dev.json" \
    bun run dev:cloud &
  CLOUD_PID=$!
  echo "CLOUD_PID=$CLOUD_PID" >> "$ENV_FILE"

  # 等待服务就绪
  wait_for_service "$API_BASE/health" "API Server" 60 || {
    kill $CLOUD_PID 2>/dev/null
    exit 1
  }

  wait_for_service "$CSS_BASE/.well-known/openid-configuration" "CSS" 60 || {
    kill $CLOUD_PID 2>/dev/null
    exit 1
  }

  # 初始化
  sleep 2  # 等待 seed 完成
  init_credentials
  create_test_node

  echo ""
  log_success "Cloud 服务已启动!"
  echo ""
  echo "=========================================="
  echo "环境变量已保存到: $ENV_FILE"
  echo "=========================================="
  cat "$ENV_FILE"
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
