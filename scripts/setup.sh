#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

GREEN='\033[0;32m' YELLOW='\033[1;33m' RED='\033[0;31m' BLUE='\033[0;34m' NC='\033[0m'
ok()   { echo -e "${GREEN}  ✅ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠️  $1${NC}"; }
fail() { echo -e "${RED}  ❌ $1${NC}"; }
info() { echo -e "${BLUE}  ℹ️  $1${NC}"; }

echo "🚀 PodPaaS Setup"
echo "═══════════════════════════════════════════════════════"

# ── Detect user info ─────────────────────────────────────────────────────────
USER_ID=$(id -u)
USER_NAME=$(whoami)
IS_ROOTLESS=$([ "$USER_ID" -ne 0 ] && echo "true" || echo "false")
SOCKET_PATH="/run/user/$USER_ID/podman/podman.sock"

info "Running as: $USER_NAME (UID: $USER_ID)"
info "Rootless mode: $IS_ROOTLESS"

# ── Checks ───────────────────────────────────────────────────────────────────
echo -e "\n📋 Checking dependencies..."

# Podman
if command -v podman &>/dev/null; then
  PODMAN_VERSION=$(podman --version 2>&1 | head -1)
  ok "$PODMAN_VERSION"
else
  fail "podman not found — https://podman.io/getting-started/installation"
  exit 1
fi

# Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node.js $NODE_VERSION (≥20)"
  else
    fail "Node.js v20+ required (found $NODE_VERSION)"
    exit 1
  fi
else
  fail "node not found — https://nodejs.org (v20+)"
  exit 1
fi

# Podman Compose (critical for stack support)
if command -v podman-compose &>/dev/null; then
  ok "podman-compose found"
elif command -v docker-compose &>/dev/null; then
  warn "podman-compose not found, but docker-compose is available"
  warn "  Consider installing: pip3 install podman-compose"
else
  warn "neither podman-compose nor docker-compose found"
  warn "  Stack deployment will not work!"
  warn "  Install with: pip3 install podman-compose"
fi

# Optional tools
command -v caddy   &>/dev/null && ok "caddy $(caddy version 2>&1 | head -1)" || warn "caddy not found (optional) — https://caddyserver.com/docs/install"
command -v nixpacks &>/dev/null && ok "nixpacks found" || warn "nixpacks not found (optional, for auto-detect builds) — https://nixpacks.com"
command -v git &>/dev/null && ok "git found" || warn "git not found (optional, for git-based deployments)"

# ── Podman socket ────────────────────────────────────────────────────────────
echo -e "\n🔌 Configuring Podman socket..."

export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$USER_ID/bus}"

# Check if systemctl is available
if command -v systemctl &>/dev/null; then
  if systemctl --user is-active --quiet podman.socket 2>/dev/null; then
    ok "Podman socket is already running"
  else
    systemctl --user enable --now podman.socket 2>/dev/null && ok "Podman socket enabled" || warn "Could not enable via systemctl"
  fi
else
  warn "systemctl not available — please start podman socket manually"
fi

# Verify socket exists
if [ -S "$SOCKET_PATH" ]; then
  ok "Socket active: $SOCKET_PATH"
else
  warn "Socket not found at $SOCKET_PATH"
  echo -e "\n  To start the socket manually:"
  echo "    podman system service --time=0 unix://$SOCKET_PATH &"
  echo -e "\n  Or with systemctl:"
  echo "    systemctl --user start podman.socket"
fi

# Test Podman API connectivity
echo -e "\n🧪 Testing Podman API connectivity..."
if curl -s --unix-socket "$SOCKET_PATH" "http://d/v4.0.0/libpod/_ping" &>/dev/null; then
  ok "Podman API is responding"
else
  warn "Podman API not responding — deployments may fail"
fi

# ── Environment ───────────────────────────────────────────────────────────────
echo -e "\n⚙️  Configuring environment..."

# Create API .env
if [ ! -f api/.env ]; then
  if [ -f api/.env.example ]; then
    cp api/.env.example api/.env
  else
    touch api/.env
  fi
  
  # Generate JWT secret
  if command -v openssl &>/dev/null; then
    JWT_SECRET=$(openssl rand -hex 32)
  else
    JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || echo "change-this-secret-in-production-$(date +%s)")
  fi
  
  # Write base config
  cat > api/.env << EOF
# PodPaaS Environment Configuration
# Generated on $(date)

# Required: JWT Secret (min 32 chars)
JWT_SECRET=$JWT_SECRET

# Node environment
NODE_ENV=development

# API server
PORT=3001
HOST=0.0.0.0

# Database directory
DATA_DIR=./data

# Podman socket path
PODMAN_SOCKET=$SOCKET_PATH

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:5173

# Build configuration
BUILD_DIR=/tmp/podman-paas-builds
BUILD_TIMEOUT_MS=600000

# Deploy timeout
DEPLOY_TIMEOUT_MS=900000

# Default resource limits
DEFAULT_MEMORY_LIMIT=536870912
DEFAULT_CPU_LIMIT=1.0

# Podman API timeout
PODMAN_TIMEOUT_MS=15000
EOF
  
  ok "Created api/.env with generated JWT secret"
  warn "IMPORTANT: Change JWT_SECRET in production!"
else
  ok "api/.env already exists"
  # Update socket path if needed
  if grep -q "PODMAN_SOCKET=" api/.env; then
    CURRENT_SOCKET=$(grep "PODMAN_SOCKET=" api/.env | cut -d'=' -f2)
    if [ "$CURRENT_SOCKET" != "$SOCKET_PATH" ]; then
      sed -i "s|PODMAN_SOCKET=.*|PODMAN_SOCKET=$SOCKET_PATH|" api/.env
      ok "Updated PODMAN_SOCKET to $SOCKET_PATH"
    fi
  fi
fi

# Create production .env if it doesn't exist
if [ ! -f .env ]; then
  cat > .env << EOF
# PodPaaS Production Environment
# Copy this to .env and customize for your setup

JWT_SECRET=change-this-to-a-secure-random-string
NODE_ENV=production
FRONTEND_URL=https://your-domain.com
PODMAN_SOCKET=$SOCKET_PATH
COMPOSE_CMD=podman-compose
EOF
  ok "Created root .env template for production"
fi

# ── Install deps ─────────────────────────────────────────────────────────────
echo -e "\n📦 Installing dependencies..."

if [ -f api/package.json ]; then
  (cd api && npm install --silent 2>&1 | tail -1) && ok "API dependencies installed" || warn "API install had warnings"
fi

if [ -f frontend/package.json ]; then
  (cd frontend && npm install --silent 2>&1 | tail -1) && ok "Frontend dependencies installed" || warn "Frontend install had warnings"
fi

# ── Data dirs ────────────────────────────────────────────────────────────────
echo -e "\n📁 Creating data directories..."
mkdir -p data /tmp/podman-paas-builds /tmp/podman-paas-stacks
chmod 700 data /tmp/podman-paas-builds /tmp/podman-paas-stacks 2>/dev/null || true
ok "Data directories ready"

# ── Podman network ───────────────────────────────────────────────────────────
echo -e "\n🌐 Checking Podman network..."
if podman network ls | grep -q "podman-paas"; then
  ok "Network 'podman-paas' exists"
else
  if podman network create podman-paas &>/dev/null; then
    ok "Created network 'podman-paas'"
  else
    warn "Could not create network 'podman-paas' (may need manual creation)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${GREEN}✅ Setup complete!${NC}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "📋 Configuration:"
echo "  Podman socket: $SOCKET_PATH"
echo "  Rootless mode: $IS_ROOTLESS"
echo ""
echo "🚀 Start development:"
echo "  Terminal 1:  cd api      && npm run dev"
echo "  Terminal 2:  cd frontend && npm run dev"
echo "  Browser:     http://localhost:5173"
echo ""
echo "🔐 Default login: admin / admin"
echo "   ⚠️  CHANGE THIS AFTER FIRST LOGIN!"
echo ""
echo "🐳 To run with podman-compose:"
echo "   export PODMAN_SOCKET=$SOCKET_PATH"
echo "   podman-compose up -d"
echo ""
echo "📖 For more info: README.md"
echo "═══════════════════════════════════════════════════════"
