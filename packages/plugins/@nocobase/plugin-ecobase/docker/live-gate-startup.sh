#!/bin/sh
set -eu

cd /app/nocobase

if node <<'NODE'
const { Client } = require('pg');
const client = new Client({
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
(async () => {
  await client.connect();
  const result = await client.query("select to_regclass('public.\"applicationVersion\"') as table_name");
  await client.end();
  process.exit(result.rows[0]?.table_name ? 0 : 1);
})().catch(async (error) => {
  try { await client.end(); } catch (_) {}
  console.error(`[ecobase-live-gate] database installation check failed: ${error.message}`);
  process.exit(1);
});
NODE
then
  echo "[ecobase-live-gate] existing QA database detected; preserving data"
else
  echo "[ecobase-live-gate] installing isolated QA database"
  yarn nocobase install -f
fi

echo "[ecobase-live-gate] enabling @nocobase/plugin-ai"
yarn pm enable @nocobase/plugin-ai || true

echo "[ecobase-live-gate] enabling @nocobase/plugin-ecobase"
yarn pm enable @nocobase/plugin-ecobase

echo "[ecobase-live-gate] enabling @nocobase/plugin-ai-codex-subscription"
yarn pm enable @nocobase/plugin-ai-codex-subscription

echo "[ecobase-live-gate] applying Ecobase and AI provider migrations"
yarn nocobase upgrade --skip-code-update

echo "[ecobase-live-gate] Ecobase and Codex subscription plugins are installed and enabled"
