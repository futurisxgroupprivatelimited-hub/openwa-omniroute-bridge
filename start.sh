set -e
cd "$(dirname "$0")"
set -a
source .env
set +a
exec node bridge.mjs
