#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example to .env and configure it."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ "${OPENAI_BOOT_OPTIONAL:-}" != "1" && -z "${OPENAI_API_KEY// }" ]]; then
  echo "ERROR: OPENAI_API_KEY is empty. Add your key to .env or set OPENAI_BOOT_OPTIONAL=1."
  exit 1
fi

if [[ "${SKIP_KMS_MASTER_KEY:-}" != "1" && -z "${KMS_MASTER_KEY// }" ]]; then
  echo "ERROR: KMS_MASTER_KEY is empty. Add a key to .env (see .env.example) or set SKIP_KMS_MASTER_KEY=1."
  exit 1
fi

echo "Starting stack with Docker Compose (postgres, redis, migrate+seed, api, worker)…"
docker compose up --build -d

HP="${HOST_PORT:-8080}"
WH="${WORKER_HOST_PORT:-9090}"

echo "Waiting for API readiness on http://127.0.0.1:${HP}/api/ready …"
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${HP}/api/ready" | grep -q '"status"'; then
    if curl -sf "http://127.0.0.1:${HP}/api/ready" | grep -q '"status":"ready"'; then
      break
    fi
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "ERROR: API did not become ready in time."
    echo "Try: docker compose logs migrate api worker"
    exit 1
  fi
  sleep 2
done

export SMOKE_BASE_URL="http://127.0.0.1:${HP}"
export WORKER_HEALTH_PORT="${WH}"
./scripts/healthcheck.sh

echo "Running in-container smoke (health + ready; SMOKE_LITE=1 skips OpenAI /message)…"
docker compose exec -T \
  -e SMOKE_BASE_URL=http://127.0.0.1:8080 \
  -e SMOKE_TENANT=default \
  -e SMOKE_LITE="${SMOKE_LITE:-1}" \
  api node smoke-readiness.js

echo ""
echo "✅ Stack is up."
echo "   API:    http://127.0.0.1:${HP}"
echo "   Admin:  http://127.0.0.1:${HP}/admin"
echo "   Worker: http://127.0.0.1:${WH}/health"
echo "   Logs:   docker compose logs -f api worker"
