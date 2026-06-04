#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${plugin_root}/../../../.." && pwd)"
compose_file="${plugin_root}/docker/live-gate.compose.yml"
project_name="${ECOBASE_LIVE_GATE_PROJECT:-ecobase-live-gate}"
image_tag="${ECOBASE_LIVE_GATE_IMAGE:-ecobase/nocobase:qa-live-gate}"
build_mode="${ECOBASE_LIVE_GATE_BUILD_MODE:-overlay}"
app_port="${ECOBASE_LIVE_GATE_PORT:-13080}"
admin_email="${ECOBASE_LIVE_GATE_ADMIN_EMAIL:-admin@nocobase.com}"
admin_password="${ECOBASE_LIVE_GATE_ADMIN_PASSWORD:-admin123}"
base_url="http://127.0.0.1:${app_port}"

export ECOBASE_LIVE_GATE_IMAGE="${image_tag}"
export ECOBASE_LIVE_GATE_PORT="${app_port}"
export ECOBASE_LIVE_GATE_ADMIN_EMAIL="${admin_email}"
export ECOBASE_LIVE_GATE_ADMIN_PASSWORD="${admin_password}"

if ! command -v docker >/dev/null 2>&1; then
  echo "BLOCKED: docker CLI is not installed or not on PATH." >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "BLOCKED: Docker daemon is unavailable. Start Docker and rerun this live gate." >&2
  exit 2
fi

if [ "${ECOBASE_LIVE_GATE_SKIP_BUILD:-0}" != "1" ]; then
  echo "[ecobase-live-gate] building ${image_tag} with ${build_mode} mode"
  ECOBASE_LIVE_GATE_BUILD_MODE="${build_mode}" "${plugin_root}/scripts/build-image.sh" "${image_tag}"
else
  echo "[ecobase-live-gate] using existing image ${image_tag}"
fi

echo "[ecobase-live-gate] resetting isolated Docker Compose project ${project_name}"
docker compose --project-name "${project_name}" --file "${compose_file}" down --volumes --remove-orphans >/dev/null 2>&1 || true

echo "[ecobase-live-gate] starting app and database"
docker compose --project-name "${project_name}" --file "${compose_file}" up -d

echo "[ecobase-live-gate] waiting for ${base_url}/admin/settings/ecobase"
deadline=$((SECONDS + ${ECOBASE_LIVE_GATE_TIMEOUT_SECONDS:-600}))
last_status="000"
while [ "${SECONDS}" -lt "${deadline}" ]; do
  last_status="$(curl -k -sS -o /dev/null -w '%{http_code}' "${base_url}/admin/settings/ecobase" || true)"
  case "${last_status}" in
    200|301|302|401|403)
      echo "[ecobase-live-gate] app responded with HTTP ${last_status}"
      cat <<EOF

Ecobase live gate is ready.
URL: ${base_url}/admin/settings/ecobase
API: ${base_url}/api
Admin email: ${admin_email}
Admin password: ${admin_password}
Cleanup: packages/plugins/@nocobase/plugin-ecobase/scripts/stop-live-gate.sh

QA final gate requirements:
1. Open the URL above in a browser.
2. Log in with the printed admin credentials if prompted.
3. Verify the Ecobase settings/status page loads.
4. Capture browser evidence and then run the cleanup command.
EOF
      exit 0
      ;;
  esac
  sleep 5
done

echo "BLOCKED: Ecobase live gate did not become ready within timeout. Last HTTP status: ${last_status}" >&2
echo "Last app logs:" >&2
docker compose --project-name "${project_name}" --file "${compose_file}" logs --tail=120 app >&2 || true
exit 2
