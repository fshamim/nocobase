#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${plugin_root}/../../../.." && pwd)"
image_tag="${1:-ecobase/nocobase:local}"
build_mode="${ECOBASE_IMAGE_BUILD_MODE:-${ECOBASE_LIVE_GATE_BUILD_MODE:-overlay}}"
base_image="${ECOBASE_LIVE_GATE_BASE_IMAGE:-nocobase/nocobase:beta-full}"

if ! command -v docker >/dev/null 2>&1; then
  echo "BLOCKED: docker CLI is not installed or not on PATH." >&2
  exit 2
fi

case "${build_mode}" in
  full)
    echo "[ecobase-image] building full image ${image_tag} from ${repo_root}"
    docker build \
      --file "${plugin_root}/docker/Dockerfile" \
      --tag "${image_tag}" \
      "${repo_root}"
    ;;
  overlay)
    if ! command -v yarn >/dev/null 2>&1; then
      echo "BLOCKED: yarn is not installed or not on PATH; cannot package plugin overlay." >&2
      exit 2
    fi

    build_context="$(mktemp -d "${TMPDIR:-/tmp}/ecobase-plugin-overlay.XXXXXX")"
    cleanup() {
      rm -rf "${build_context}"
    }
    trap cleanup EXIT

    echo "[ecobase-image] packaging @nocobase/plugin-ecobase from local source"
    (
      cd "${repo_root}"
      yarn nocobase build @nocobase/plugin-ecobase --no-dts
      yarn nocobase tar @nocobase/plugin-ecobase
    )

    tarball="$(find "${repo_root}/storage/tar" -maxdepth 2 -type f -path '*/@nocobase/plugin-ecobase-*.tgz' 2>/dev/null | sort | tail -1)"
    if [ -z "${tarball}" ] || [ ! -f "${tarball}" ]; then
      echo "BLOCKED: packaged @nocobase/plugin-ecobase tarball was not found in ${repo_root}/storage/tar." >&2
      exit 2
    fi

    mkdir -p "${build_context}/plugin"
    tar -xzf "${tarball}" -C "${build_context}/plugin"

    echo "[ecobase-image] building overlay image ${image_tag} from base ${base_image}"
    docker build \
      --file "${plugin_root}/docker/Dockerfile.overlay" \
      --build-arg "ECOBASE_BASE_IMAGE=${base_image}" \
      --tag "${image_tag}" \
      "${build_context}"
    ;;
  *)
    echo "BLOCKED: unknown ECOBASE_IMAGE_BUILD_MODE/ECOBASE_LIVE_GATE_BUILD_MODE '${build_mode}'. Use 'overlay' or 'full'." >&2
    exit 2
    ;;
esac
