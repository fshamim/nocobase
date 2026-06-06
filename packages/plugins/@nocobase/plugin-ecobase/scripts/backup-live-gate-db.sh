#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${plugin_root}/docker/live-gate.compose.yml"
project_name="${ECOBASE_LIVE_GATE_PROJECT:-ecobase-live-gate}"
backup_dir="${ECOBASE_LIVE_GATE_BACKUP_DIR:-${plugin_root}/tmp/live-gate-backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="${backup_dir}/ecobase-live-gate-${timestamp}.sql"

mkdir -p "${backup_dir}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is not installed or not on PATH; backup cannot run." >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; backup cannot run." >&2
  exit 2
fi

docker compose --project-name "${project_name}" --file "${compose_file}" exec -T postgres \
  pg_dump --username nocobase --dbname nocobase --no-owner --no-acl > "${backup_file}"

echo "Ecobase live-gate PostgreSQL backup created: ${backup_file}"
