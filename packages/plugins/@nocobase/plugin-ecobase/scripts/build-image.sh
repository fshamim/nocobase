#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${plugin_root}/../../../.." && pwd)"
image_tag="${1:-ecobase/nocobase:local}"

docker build \
  --file "${plugin_root}/docker/Dockerfile" \
  --tag "${image_tag}" \
  "${repo_root}"
