#!/usr/bin/env bash
# Install system-wide systemd units so Solomon and cloudflared come back after reboot.
#
# Usage (from anywhere):
#   ./scripts/install-solomon-autostart.sh
#
# Re-run after moving the git repo (unit paths are rewritten from this script's location).
#
# Uninstall:
#   sudo systemctl disable --now solomon-local.service
#   sudo rm /etc/systemd/system/solomon-local.service && sudo systemctl daemon-reload
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
REPO="$(cd "$(dirname "$SELF")/.." && pwd)"
UNIT_IN="$REPO/deploy/systemd/solomon-local.service.in"
UNIT_OUT=/etc/systemd/system/solomon-local.service

if [[ ! -f "$UNIT_IN" ]]; then
  echo "Missing $UNIT_IN" >&2
  exit 1
fi

if [[ "${EUID:-0}" -ne 0 ]]; then
  exec sudo "$SELF" "$@"
fi

RUN_USER="${SUDO_USER:-}"
if [[ -z "$RUN_USER" ]] && command -v logname >/dev/null 2>&1; then
  RUN_USER="$(logname 2>/dev/null || true)"
fi
if [[ -z "$RUN_USER" ]]; then
  echo "Could not determine login user (empty SUDO_USER and logname). Run as: sudo -u YOURUSER $0" >&2
  exit 1
fi

if ! id "$RUN_USER" &>/dev/null; then
  echo "User not found: $RUN_USER" >&2
  exit 1
fi

if [[ ! -f "$REPO/server.js" ]]; then
  echo "Refusing: $REPO/server.js not found (wrong REPO?)." >&2
  exit 1
fi

if [[ ! -f "$REPO/.env" ]]; then
  echo "Warning: $REPO/.env missing — service will start with defaults only." >&2
fi

tmp="$(mktemp)"
sed -e "s|@@REPO@@|$REPO|g" -e "s|@@USER@@|$RUN_USER|g" "$UNIT_IN" >"$tmp"
install -m 644 "$tmp" "$UNIT_OUT"
rm -f "$tmp"

systemctl daemon-reload
systemctl enable solomon-local.service
systemctl restart solomon-local.service

if systemctl list-unit-files cloudflared.service &>/dev/null; then
  systemctl enable cloudflared.service
  systemctl is-active --quiet cloudflared.service || systemctl start cloudflared.service || true
else
  echo "Note: cloudflared.service not found — install cloudflared package or add a unit." >&2
fi

echo ""
echo "Installed $UNIT_OUT (User=$RUN_USER, WorkingDirectory=$REPO)"
systemctl --no-pager --full status solomon-local.service || true
echo ""
echo "On reboot: cloudflared + solomon-local start automatically (ensure PORT in .env matches tunnel, e.g. 8081)."
