#!/usr/bin/env bash
set -euo pipefail
BASE="${SMOKE_BASE_URL:-http://127.0.0.1:8080}"
BASE="${BASE%/}"
# Published worker health port (default 9090 matches docker-compose worker ports).
WORKER_PORT="${WORKER_HEALTH_PORT:-9090}"
# Set HEALTHCHECK_RELAXED=1 when probing a non-production API (skips redis/tenant assertions).
RELAXED="${HEALTHCHECK_RELAXED:-0}"

fail() { echo "healthcheck: $*" >&2; exit 1; }

code="$(curl -s -o /tmp/qmb-health.json -w "%{http_code}" "${BASE}/api/health")"
[[ "$code" == "200" ]] || fail "/api/health expected 200, got $code"
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' /tmp/qmb-health.json || fail "/api/health body missing status ok"

code="$(curl -s -o /tmp/qmb-ready.json -w "%{http_code}" "${BASE}/api/ready")"
[[ "$code" == "200" ]] || fail "/api/ready expected 200, got $code"
grep -q '"status":"ready"' /tmp/qmb-ready.json || fail "/api/ready body missing status ready"
if [[ "$RELAXED" != "1" ]]; then
  grep -q '"database":"ok"' /tmp/qmb-ready.json || fail "/api/ready database check not ok (expected production readiness)"
  grep -q '"redis":"ok"' /tmp/qmb-ready.json || fail "/api/ready redis check not ok"
  grep -q '"defaultTenant":"ok"' /tmp/qmb-ready.json || fail "/api/ready default tenant missing"
  echo "OK  /api/ready (db + redis + bootstrap tenant)"
else
  echo "OK  /api/ready (relaxed mode)"
fi

if [[ "$RELAXED" != "1" ]]; then
  code="$(curl -s -o /tmp/qmb-wh.json -w "%{http_code}" "http://127.0.0.1:${WORKER_PORT}/health")"
  [[ "$code" == "200" ]] || fail "worker /health on port ${WORKER_PORT} expected 200, got $code"
  echo "healthcheck: OK (api health + full ready + worker health)"
else
  echo "healthcheck: OK (api health + ready, worker skipped in relaxed mode)"
fi
