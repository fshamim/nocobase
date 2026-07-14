#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function argument(prefix: string) {
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}
function requiredArgument(prefix: string) {
  const value = argument(prefix);
  if (!value) throw new Error(`Family target operation requires ${prefix}<value>.`);
  return value;
}
async function signIn(baseUrl: string) {
  const email = process.env.ECOBASE_LIVE_GATE_ADMIN_EMAIL;
  const password = process.env.ECOBASE_LIVE_GATE_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Family target operation requires explicit staging admin credentials.');
  const response = await fetch(`${baseUrl}/auth:signIn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || typeof body?.data?.token !== 'string') throw new Error('Family target sign-in failed.');
  return body.data.token as string;
}
function unwrap(value: any): any {
  return value && typeof value === 'object' && Object.keys(value).length === 1 && 'data' in value
    ? unwrap(value.data)
    : value;
}

async function main() {
  const modes = [
    ['dry-run', process.argv.includes('--dry-run')],
    ['apply', process.argv.includes('--apply')],
    ['verify-idempotency', process.argv.includes('--verify-idempotency')],
  ].filter(([, enabled]) => enabled);
  if (modes.length !== 1) throw new Error('Use exactly one of --dry-run, --apply, or --verify-idempotency.');
  const mode = modes[0][0] as 'dry-run' | 'apply' | 'verify-idempotency';
  const baseUrl = (process.env.ECOBASE_LIVE_GATE_API_BASE ?? 'http://127.0.0.1:13080/api').replace(/\/$/, '');
  const token = process.env.ECOBASE_REPAIR_TOKEN ?? (await signIn(baseUrl));
  const action = {
    'dry-run': 'previewAutomaticTargetCorrections',
    apply: 'applyAutomaticTargetCorrections',
    'verify-idempotency': 'verifyAutomaticTargetCorrections',
  }[mode];
  const values =
    mode === 'apply'
      ? { decisionDigest: requiredArgument('--digest='), confirmation: requiredArgument('--confirm=') }
      : {};
  const response = await fetch(`${baseUrl}/ecobaseInventoryPlanning:${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Family target ${mode} failed (${response.status}): ${JSON.stringify(body)}`);
  const result = unwrap(body);
  const output = path.resolve(requiredArgument('--json='));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`Family target ${mode}: ${JSON.stringify(result)}`);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
