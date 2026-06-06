#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${plugin_root}/docker/live-gate.compose.yml"
project_name="${ECOBASE_LIVE_GATE_PROJECT:-ecobase-live-gate}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is not installed or not on PATH; nothing to stop from this shell." >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; cleanup could not be confirmed." >&2
  exit 2
fi

if [ "${ECOBASE_LIVE_GATE_DESTROY_DATA:-0}" = "1" ]; then
  if [ "${ECOBASE_LIVE_GATE_CONFIRM_DESTROY:-}" != "destroy-live-sellerboard-data" ]; then
    echo "Refusing destructive live-gate shutdown. Set ECOBASE_LIVE_GATE_CONFIRM_DESTROY=destroy-live-sellerboard-data to remove persisted PostgreSQL data." >&2
    exit 2
  fi
  docker compose --project-name "${project_name}" --file "${compose_file}" down --volumes --remove-orphans
  echo "Ecobase live gate stopped and persisted PostgreSQL data was destroyed: ${project_name}"
else
  docker compose --project-name "${project_name}" --file "${compose_file}" down --remove-orphans
  echo "Ecobase live gate stopped; persisted PostgreSQL data was preserved: ${project_name}"
fi
