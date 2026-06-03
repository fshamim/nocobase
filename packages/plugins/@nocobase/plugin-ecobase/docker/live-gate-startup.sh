#!/bin/sh
set -eu

cd /app/nocobase

echo "[ecobase-live-gate] installing isolated QA database"
yarn nocobase install -f

echo "[ecobase-live-gate] enabling @nocobase/plugin-ecobase"
yarn pm enable @nocobase/plugin-ecobase

echo "[ecobase-live-gate] applying Ecobase migrations"
yarn nocobase upgrade --skip-code-update

echo "[ecobase-live-gate] Ecobase plugin is installed and enabled"
