#!/usr/bin/env bash
# Example: logical backup of Postgres used by Solomon (operator adapts to your environment).
# This repo does not assume pg_dump is inside the API image; typical patterns:
#
#   A) Dump from host when DATABASE_URL points at a reachable Postgres:
#      source .env && pg_dump "$DATABASE_URL" -Fc -f "solomon-$(date -u +%Y%m%dT%H%M%SZ).dump"
#
#   B) Exec into the postgres container (Compose service name often "postgres"):
#      docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backup.dump
#
# Restore (custom format): pg_restore -d "$DATABASE_URL" --clean backup.dump
#
# Schedule via cron or your platform backup product; test restores in a staging environment.
set -euo pipefail
echo "This file is documentation only. Copy the commands above into your runbook or a private script."
exit 0
