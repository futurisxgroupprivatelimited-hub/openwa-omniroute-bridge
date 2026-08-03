#!/usr/bin/env bash
set -euo pipefail
trap 'echo -e "\n\033[0;31mSetup failed on line $LINENO. Check errors above.\033[0m"; exit 1' ERR

# ──────────────────────────────────────────────────────────────────────────────
# OpenWA + OmniRoute + Bridge — One-Command Setup
# Pulls OpenWA (Docker), starts OmniRoute (Docker), configures & starts bridge.
# Tested on macOS, Linux (amd64/arm64). Requires: Docker, Node.js >=18, curl, git
# ──────────────────────────────────────────────────────────────────────────────

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*"; }
banner(){ echo -e "\n${BOLD}$*${NC}\n"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENWA_DIR="${SCRIPT_DIR}/openwa"
OMNIRoute_CONTAINER="omniroute"

# ── 1. Check prerequisites ──────────────────────────────────────────────────
banner "🔍 Checking prerequisites..."
for cmd in docker node npm git curl; do
  if command -v "$cmd" &>/dev/null; then ok "$cmd found: $(command -v "$cmd")"; else err "$cmd is required but not found. Install it first."; exit 1; fi
done

# Docker daemon check
if ! docker info &>/dev/null 2>&1; then
  err "Docker daemon is not running. Start Docker Desktop and try again."
  exit 1
fi
ok "Docker daemon is running"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then err "Node.js >= 18 required, found $(node -v)"; exit 1; fi
ok "Node.js $(node -v)"

# ── 2. Clone / pull OpenWA ─────────────────────────────────────────────────
banner "📦 Setting up OpenWA..."
if [ -d "$OPENWA_DIR/.git" ]; then
  info "OpenWA already cloned at $OPENWA_DIR — pulling latest..."
  (cd "$OPENWA_DIR" && git pull --ff-only 2>/dev/null || true)
  ok "OpenWA up to date"
else
  info "Cloning OpenWA..."
  git clone --depth 1 https://github.com/rmyndharis/OpenWA.git "$OPENWA_DIR"
  ok "OpenWA cloned"
fi

# ── 3. Build & start OpenWA container ───────────────────────────────────────
banner "🐳 Building & starting OpenWA Docker container..."
# Write SSRF allowlist + typing env to host .env (gitignored)
cat > "$OPENWA_DIR/.env" <<'ENVEOF'
SSRF_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal
SIMULATE_TYPING=true
SIMULATE_TYPING_MAX_MS=8000
DATABASE_TYPE=sqlite
DATABASE_NAME=./data/openwa.sqlite
DATABASE_SYNCHRONIZE=true
ENVEOF

# Ensure data dir exists
mkdir -p "$OPENWA_DIR/data"

# Build image (first time takes ~5 min, subsequent starts are fast)
info "Building OpenWA image (first run — may take a few minutes)..."
(cd "$OPENWA_DIR" && docker compose -f docker-compose.dev.yml build --quiet 2>&1 | tail -1 || true)

# Start container
info "Starting OpenWA..."
(cd "$OPENWA_DIR" && docker compose -f docker-compose.dev.yml up -d 2>&1 | tail -3)

# Wait for health
info "Waiting for OpenWA to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:2785/api/health/ready &>/dev/null 2>&1; then
    ok "OpenWA is healthy on port 2785"
    break
  fi
  sleep 2
done

# Extract API key (first boot only)
OPENWA_API_KEY=$(curl -sf http://localhost:2785/api/auth/validate -X POST 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('key',''))" 2>/dev/null || true)
if [ -z "$OPENWA_API_KEY" ]; then
  # Fallback: read from .api-key file in the container's data volume
  OPENWA_API_KEY=$(docker exec openwa-api cat /app/data/.api-key 2>/dev/null || true)
fi

# If still empty, grab from startup logs
if [ -z "$OPENWA_API_KEY" ]; then
  OPENWA_API_KEY=$(docker logs openwa-api 2>&1 | grep -oE 'owa_k1_[a-f0-9]{64}' | head -1 || true)
fi

if [ -n "$OPENWA_API_KEY" ]; then
  ok "OpenWA API key: ${OPENWA_API_KEY:0:16}..."
else
  warn "Could not auto-detect API key. Check http://localhost:2785 logs manually."
  OPENWA_API_KEY="CHANGE_ME"
fi

# ── 4. Start OmniRoute container ───────────────────────────────────────────
banner "🧠 Setting up OmniRoute (LLM gateway)..."
if docker ps --format '{{.Names}}' | grep -q "^${OMNIRoute_CONTAINER}$"; then
  ok "OmniRoute already running on port 20128"
elif docker ps -a --format '{{.Names}}' | grep -q "^${OMNIRoute_CONTAINER}$"; then
  docker start "$OMNIRoute_CONTAINER" >/dev/null 2>&1
  ok "OmniRoute started (existing container)"
else
  info "Pulling and starting OmniRoute..."
  docker run -d \
    --name "$OMNIRoute_CONTAINER" \
    --restart unless-stopped \
    --stop-timeout 40 \
    -p 20128:20128 \
    -v omniroute-data:/app/data \
    diegosouzapw/omniroute:latest >/dev/null
  ok "OmniRoute started on port 20128"
fi

# Wait for OmniRoute health
info "Waiting for OmniRoute..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:20128/api/monitoring/health &>/dev/null 2>&1; then
    ok "OmniRoute is healthy on port 20128"
    break
  fi
  sleep 2
done

# ── 5. Configure bridge .env ───────────────────────────────────────────────
banner "🔧 Configuring bridge..."
WEBHOOK_SECRET=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")

cat > "$SCRIPT_DIR/.env" <<EOF
BRIDGE_PORT=3001
OPENWA_BASE_URL=http://localhost:2785
OPENWA_API_KEY=${OPENWA_API_KEY}
OMNIROUTE_BASE_URL=http://localhost:20128
WEBHOOK_SECRET=${WEBHOOK_SECRET}
EOF

ok "Bridge .env written with random webhook secret"

# ── 6. Register webhook on OpenWA ──────────────────────────────────────────
banner "🔗 Registering webhook on OpenWA..."
# Get session UUID (or create one)
SESSIONS=$(curl -sf http://localhost:2785/api/sessions -H "X-API-Key: ${OPENWA_API_KEY}" 2>/dev/null || echo "[]")
SESSION_COUNT=$(echo "$SESSIONS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "$SESSION_COUNT" -eq "0" ]; then
  info "No session found — creating one..."
  SESSION_ID=$(curl -sf -X POST http://localhost:2785/api/sessions \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${OPENWA_API_KEY}" \
    -d '{"name":"default"}' 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
  ok "Session created: $SESSION_ID"
else
  SESSION_ID=$(echo "$SESSIONS" | python3 -c "import json,sys; s=json.load(sys.stdin); print(s[0]['id'] if s else '')" 2>/dev/null || echo "")
  ok "Existing session: $SESSION_ID"
fi

if [ -n "$SESSION_ID" ]; then
  # Delete any old webhooks
  OLD_WS=$(curl -sf "http://localhost:2785/api/sessions/${SESSION_ID}/webhooks" -H "X-API-Key: ${OPENWA_API_KEY}" 2>/dev/null || echo "[]")
  echo "$OLD_WS" | python3 -c "import json,sys; [print(w['id']) for w in json.load(sys.stdin)]" 2>/dev/null | while read -r WH_ID; do
    curl -sf -X DELETE "http://localhost:2785/api/sessions/${SESSION_ID}/webhooks/${WH_ID}" \
      -H "X-API-Key: ${OPENWA_API_KEY}" >/dev/null 2>&1 || true
  done

  # Register new webhook
  curl -sf -X POST "http://localhost:2785/api/sessions/${SESSION_ID}/webhooks" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${OPENWA_API_KEY}" \
    -d "{\"url\":\"http://host.docker.internal:3001/webhook\",\"events\":[\"message.received\"],\"secret\":\"${WEBHOOK_SECRET}\"}" \
    >/dev/null 2>&1 && ok "Webhook registered → http://host.docker.internal:3001/webhook" || warn "Webhook registration failed (you can register manually)"
fi

# ── 7. Start bridge ───────────────────────────────────────────────────────
banner "🚀 Starting bridge..."
pkill -f "node bridge.mjs" 2>/dev/null || true
sleep 1
(cd "$SCRIPT_DIR" && nohup bash start.sh > bridge.log 2>&1 &)
sleep 3

if curl -sf http://localhost:3001/health &>/dev/null 2>&1; then
  ok "Bridge is running on port 3001"
else
  warn "Bridge may still be starting — check http://localhost:3001 in a moment"
fi

# ── 8. Done ────────────────────────────────────────────────────────────────
banner "✅ Setup complete!"
echo -e "
${BOLD}Services:${NC}
  ${GREEN}●${NC} OpenWA (WhatsApp gateway)  →  http://localhost:2785
  ${GREEN}●${NC} OmniRoute (LLM gateway)   →  http://localhost:20128
  ${GREEN}●${NC} Bridge (character manager) →  http://localhost:3001

${BOLD}Next steps:${NC}
  1. Open ${CYAN}http://localhost:2785${NC} and scan the QR code to link your WhatsApp number
  2. Open ${CYAN}http://localhost:3001${NC} to manage characters and settings
  3. Send a WhatsApp message to your linked number — the AI character will reply!

${BOLD}Files:${NC}
  characters.json   → Edit character personas (name, bio, personality, typing)
  settings.json     → Edit model, memory, token limits, typing timings
  .env              → Secrets (API key, webhook secret) — do not commit

${BOLD}Docs:${NC}
  PLAN.md           → Architecture and roadmap
  README.md         → Full documentation

${BOLD}OpenWA API Key:${NC}
  ${OPENWA_API_KEY:0:16}...
"
