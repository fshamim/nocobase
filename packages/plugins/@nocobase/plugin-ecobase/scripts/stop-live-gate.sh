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

docker compose --project-name "${project_name}" --file "${compose_file}" down --volumes --remove-orphans

echo "Ecobase live gate stopped: ${project_name}"
