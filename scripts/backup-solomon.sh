#!/usr/bin/env bash
# Logical backup of Solomon Postgres (pg_dump custom format, gzip).
# Usage:
#   sudo -u solomon /opt/solomon/scripts/backup-solomon.sh /etc/solomon/solomon.env
# Env (optional, can be set in solomon.env):
#   BACKUP_DIR   default /var/backups/solomon
#   BACKUP_KEEP_DAYS  default 30
set -euo pipefail

ENV_FILE="${1:-/etc/solomon/solomon.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "backup-solomon: missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup-solomon: DATABASE_URL not set in $ENV_FILE" >&2
  exit 1
fi

DEST="${BACKUP_DIR:-/var/backups/solomon}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${DEST}/solomon-${STAMP}.dump"

pg_dump "$DATABASE_URL" -Fc -f "$OUT"
gzip -f "$OUT"

find "$DEST" -name 'solomon-*.dump.gz' -type f -mtime "+${KEEP}" -delete 2>/dev/null || true

echo "backup-solomon: wrote ${OUT}.gz"
