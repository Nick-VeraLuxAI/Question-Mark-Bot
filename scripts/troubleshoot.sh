#!/usr/bin/env bash
# Structured first-pass troubleshooting for managed / Docker deployments.
# Does not mutate data. Set SMOKE_BASE_URL if the API is not on 127.0.0.1:8080.
set -euo pipefail
BASE="${SMOKE_BASE_URL:-http://127.0.0.1:8080}"
BASE="${BASE%/}"
WORKER_PORT="${WORKER_HEALTH_PORT:-9090}"

echo "=== Solomon troubleshoot ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
echo "API base: $BASE"
echo

echo "--- Liveness (should be 200) ---"
curl -sS -o /tmp/qmb-t-liveness.json -w "HTTP %{http_code}\n" "${BASE}/api/health" || true
cat /tmp/qmb-t-liveness.json 2>/dev/null | head -c 400 || true
echo
echo

echo "--- Readiness (503 = not ready; body explains checks) ---"
code="$(curl -sS -o /tmp/qmb-t-ready.json -w "%{http_code}" "${BASE}/api/ready" || true)"
echo "HTTP $code"
cat /tmp/qmb-t-ready.json 2>/dev/null || true
echo
echo

echo "--- Worker (default port $WORKER_PORT; 000 if nothing listening) ---"
curl -sS -o /tmp/qmb-t-worker.json -w "HTTP %{http_code}\n" "http://127.0.0.1:${WORKER_PORT}/health" || echo "(curl failed — is the worker published on this host?)"
cat /tmp/qmb-t-worker.json 2>/dev/null || true
echo
echo

echo "--- Docker Compose (if run from repo root) ---"
if command -v docker >/dev/null 2>&1; then
  docker compose ps 2>/dev/null || echo "(docker compose ps failed — not in a compose project?)"
  echo
  echo "Recent migrate / api / worker logs (last 40 lines each):"
  for s in migrate api worker; do
    echo "---- $s ----"
    docker compose logs --tail 40 "$s" 2>/dev/null || echo "(no logs for service $s)"
  done
else
  echo "docker not in PATH — skip compose section."
fi

echo
echo "=== Hints ==="
echo "• 503 bootstrap_tenant_missing → run migrations + seed (see INSTALL_RUN.md)."
echo "• 503 redis_* → Redis URL / network from API container."
echo "• 503 database_* → DATABASE_URL / Postgres health."
echo "• Ready JSON may include hints[] (e.g. tenants without per-tenant OpenAI when no global key)."
echo "• API boot logs [boot] lines — see utils/bootValidate.js (production escape hatches)."
echo "• Admin /admin → Tenant onboarding → Verify readiness (or: npm run tenant:verify -- --slug <slug>)."
