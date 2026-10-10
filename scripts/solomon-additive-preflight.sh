#!/usr/bin/env bash
# Read-only checks before additive systemd Solomon install.
# Does not read secrets; does not modify /etc or Docker.
set -euo pipefail

echo "=== Solomon additive preflight ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="

need_ports=(8081 8082 8083 8080 9090 9091 6379 6380 5433)
echo "-- TCP listeners (ss) among candidate ports --"
for p in "${need_ports[@]}"; do
  if ss -tln 2>/dev/null | grep -q ":${p}"; then
    echo "IN_USE  :${p}"
    ss -tlnp 2>/dev/null | grep ":${p}" || true
  else
    echo "FREE    :${p}"
  fi
done

echo "-- Paths --"
for d in /opt/solomon /etc/solomon /etc/solomon/solomon.env /etc/cloudflared/config.yml; do
  if [[ -e "$d" ]]; then echo "EXISTS  $d"; else echo "MISSING $d"; fi
done

echo "-- systemd unit files (solomon*) --"
systemctl list-unit-files --type=service 2>/dev/null | grep -i solomon || echo "(none)"

echo "-- cloudflared --"
systemctl is-active cloudflared 2>/dev/null || true

echo "-- Docker containers matching question-mark-bot / solomon --"
docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'question-mark-bot|solomon' || echo "(none or docker unavailable)"

echo "=== Done. Review IN_USE vs recommended PORT/WORKER_HEALTH_PORT/REDIS in docs/SOLOMON_ADDITIVE_VERATITAN.md ==="
