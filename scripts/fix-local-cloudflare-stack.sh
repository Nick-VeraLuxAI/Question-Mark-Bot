#!/usr/bin/env bash
# Fix common workstation issues: duplicate cloudflared, ICMP sysctl, stray root Node.
# Run from repo root. Steps that change the system use sudo (you will be prompted).
#
# Usage:
#   ./scripts/fix-local-cloudflare-stack.sh              # checks + prints fixes
#   ./scripts/fix-local-cloudflare-stack.sh --apply-sysctl   # also installs ICMP sysctl (sudo)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APPLY_SYSCTL=0
if [[ "${1:-}" == "--apply-sysctl" ]]; then APPLY_SYSCTL=1; fi

echo "== Solomon / Cloudflare workstation check =="
echo ""

if systemctl is-active --quiet cloudflared.service 2>/dev/null; then
  echo "[OK] systemd cloudflared.service is active (this should be the only host tunnel for /etc/cloudflared/config.yml)."
  echo "     If you also ran: sudo cloudflared tunnel --config /etc/cloudflared/config.yml run"
  echo "     in a terminal, press Ctrl+C there — duplicate connectors confuse debugging."
else
  echo "[!] cloudflared.service is not active. Start with: sudo systemctl enable --now cloudflared"
fi
echo ""

MANUAL_CF="$(pgrep -af '[c]loudflared tunnel --config /etc/cloudflared/config.yml' 2>/dev/null || true)"
if [[ -n "$MANUAL_CF" ]]; then
  echo "[!] Extra cloudflared using /etc/cloudflared/config.yml (not the systemd /usr/bin line):"
  echo "$MANUAL_CF" | sed 's/^/     /'
  echo "     Stop the manual tunnel (Ctrl+C in that terminal) or: sudo kill <PID>"
fi

ROOT_NODE_PIDS="$(ps -U root -o pid=,args= 2>/dev/null | awk '$2=="node" && $3=="server.js"{printf "%s ", $1}' | sed 's/[[:space:]]*$//')"
if [[ -n "${ROOT_NODE_PIDS:-}" ]]; then
  echo "[!] root-owned 'node server.js' detected (PIDs: $ROOT_NODE_PIDS). Never start the API with sudo."
  echo "    Stop with: sudo kill $ROOT_NODE_PIDS"
else
  echo "[OK] No root-owned node server.js processes."
fi
echo ""

echo "== ICMP / ping_group_range (removes cloudflared ICMP warnings when running as root) =="
SYSCTL_SRC="$ROOT/deploy/linux/99-cloudflared-ping.conf"
SYSCTL_DST=/etc/sysctl.d/99-cloudflared-ping.conf
if [[ -f "$SYSCTL_DST" ]] && grep -q 'ping_group_range' "$SYSCTL_DST" 2>/dev/null; then
  echo "[OK] $SYSCTL_DST already present."
elif [[ "$APPLY_SYSCTL" == "1" ]]; then
  sudo cp "$SYSCTL_SRC" "$SYSCTL_DST"
  sudo sysctl -p "$SYSCTL_DST"
  echo "[OK] Installed $SYSCTL_DST"
else
  echo "To silence ICMP warnings after next cloudflared restart, run:"
  echo "  $0 --apply-sysctl"
  echo "or: sudo cp $SYSCTL_SRC $SYSCTL_DST && sudo sysctl -p $SYSCTL_DST"
fi
echo ""

echo "== Auto-start after reboot (Solomon + cloudflared) =="
echo "    ./scripts/install-solomon-autostart.sh"
echo "  (or user unit: deploy/systemd/solomon-devel.user.service.example + loginctl enable-linger)"
echo ""
echo "Done."
