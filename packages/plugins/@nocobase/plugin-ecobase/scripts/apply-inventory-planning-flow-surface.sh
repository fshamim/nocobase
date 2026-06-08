#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${plugin_root}/../../../.." && pwd)"
blueprint_file="${ECOBASE_INVENTORY_PLANNING_BLUEPRINT:-${plugin_root}/ui/flow-surfaces/inventory-planning.json}"
api_base_url="${ECOBASE_API_BASE_URL:-http://127.0.0.1:${ECOBASE_LIVE_GATE_PORT:-13080}/api}"
admin_email="${ECOBASE_ADMIN_EMAIL:-${ECOBASE_LIVE_GATE_ADMIN_EMAIL:-admin@nocobase.com}}"
admin_password="${ECOBASE_ADMIN_PASSWORD:-${ECOBASE_LIVE_GATE_ADMIN_PASSWORD:-admin123}}"

if [ ! -f "${blueprint_file}" ]; then
  echo "BLOCKED: inventory planning Flow Surface blueprint not found: ${blueprint_file}" >&2
  exit 2
fi

if ! command -v nb >/dev/null 2>&1; then
  echo "BLOCKED: nb CLI is not installed or not on PATH." >&2
  exit 2
fi

token="${ECOBASE_API_TOKEN:-}"
if [ -z "${token}" ]; then
  token="$(node - "${api_base_url}" "${admin_email}" "${admin_password}" <<'NODE'
const [apiBaseUrl, email, password] = process.argv.slice(2);
(async () => {
  const response = await fetch(`${apiBaseUrl}/auth:signIn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.data?.token) {
    throw new Error(`Ecobase Flow Surface login failed with HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  process.stdout.write(body.data.token);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
)"
fi

echo "[ecobase-flow-surface] clearing existing inventory planning blocks on ${api_base_url}"
node - "${api_base_url}" "${token}" <<'NODE'
const [apiBaseUrl, token] = process.argv.slice(2);
const pageSchemaUid = 'qn3ajc8r0b3';
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  const subModels = node.subModels || {};
  for (const value of Object.values(subModels)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else walk(value, visit);
  }
}

async function get(path, params) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${apiBaseUrl}/${path}?${query}`, { method: 'GET', headers });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : {};
}

async function post(path, payload) {
  const response = await fetch(`${apiBaseUrl}/${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : {};
}

(async () => {
  const surface = await get('flowSurfaces:get', { pageSchemaUid });
  const tree = surface?.data?.tree || surface?.tree;
  const blockUids = [];
  walk(tree, (node) => {
    if ((node.use === 'JSBlockModel' || node.use === 'TableBlockModel') && node.uid) blockUids.push(node.uid);
  });
  for (const uid of blockUids) await post('flowSurfaces:removeNode', { target: { uid } });
  console.log(`[ecobase-flow-surface] cleared ${blockUids.length} existing blocks`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE

echo "[ecobase-flow-surface] applying ${blueprint_file} to ${api_base_url}"
(
  cd "${repo_root}"
  nb api flow-surfaces apply-blueprint \
    --body-file "${blueprint_file}" \
    --api-base-url "${api_base_url}" \
    -t "${token}" \
    -j >/tmp/ecobase-inventory-planning-flow-surface-apply.json
)

node - "/tmp/ecobase-inventory-planning-flow-surface-apply.json" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
const body = JSON.parse(fs.readFileSync(path, 'utf8'));
const target = body?.data?.target || body?.target || body?.data || body;
console.log(`[ecobase-flow-surface] applied pageSchemaUid=${target.pageSchemaUid || 'unknown'} pageUid=${target.pageUid || 'unknown'}`);
NODE

echo "[ecobase-flow-surface] cleaning generated actions to keep operator-safe controls"
node - "${api_base_url}" "${token}" <<'NODE'
const [apiBaseUrl, token] = process.argv.slice(2);
const pageSchemaUid = 'qn3ajc8r0b3';
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  const subModels = node.subModels || {};
  for (const value of Object.values(subModels)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else walk(value, visit);
  }
}

async function post(path, payload) {
  const response = await fetch(`${apiBaseUrl}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : {};
}

async function get(path, params) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${apiBaseUrl}/${path}?${query}`, { method: 'GET', headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : {};
}

(async () => {
  const surface = await get('flowSurfaces:get', { pageSchemaUid });
  const tree = surface?.data?.tree || surface?.tree;
  const removeUids = [];

  walk(tree, (node) => {
    if (node.use !== 'TableBlockModel') return;
    const collectionName = node.stepParams?.resourceSettings?.init?.collectionName;
    const actions = [];
    for (const column of node.subModels?.columns || []) {
      for (const action of column.subModels?.actions || []) actions.push(action);
    }
    for (const action of node.subModels?.actions || []) actions.push(action);

    for (const action of actions) {
      const use = action.use;
      const shouldRemove =
        use === 'BulkDeleteActionModel' ||
        (collectionName === 'ecobaseInventoryPlanningRows' && (use === 'DeleteActionModel' || use === 'AddNewActionModel')) ||
        ((collectionName === 'ecobaseSupplierOrders' || collectionName === 'ecobaseSupplierLeadTimes') && use === 'DeleteActionModel');
      if (shouldRemove && action.uid) removeUids.push(action.uid);
    }
  });

  for (const uid of removeUids) {
    await post('flowSurfaces:removeNode', { target: { uid } });
  }
  console.log(`[ecobase-flow-surface] removed ${removeUids.length} generated action nodes`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE

echo "[ecobase-flow-surface] done"
