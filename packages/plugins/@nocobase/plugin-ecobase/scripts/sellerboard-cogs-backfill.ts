#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function argument(prefix: string) {
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function requiredArgument(prefix: string) {
  const value = argument(prefix);
  if (!value) throw new Error(`Sellerboard COGS operation requires ${prefix}<value>.`);
  return value;
}

async function signIn(baseUrl: string) {
  const email = process.env.ECOBASE_LIVE_GATE_ADMIN_EMAIL;
  const password = process.env.ECOBASE_LIVE_GATE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Sellerboard COGS operation requires ECOBASE_REPAIR_TOKEN or explicit ECOBASE_LIVE_GATE_ADMIN_EMAIL and ECOBASE_LIVE_GATE_ADMIN_PASSWORD.',
    );
  }
  const response = await fetch(`${baseUrl}/auth:signIn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || typeof body?.data?.token !== 'string') {
    throw new Error(`Sellerboard COGS sign-in failed with HTTP ${response.status}.`);
  }
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
  if (modes.length !== 1) {
    throw new Error(
      'Usage: sellerboard-cogs-backfill.ts --dry-run|--apply|--verify-idempotency --data-root=<path> --json=<path>.',
    );
  }
  const mode = modes[0][0] as 'dry-run' | 'apply' | 'verify-idempotency';
  const historyRoot = path.join(path.resolve(requiredArgument('--data-root=')), 'history');
  const files = readdirSync(historyRoot)
    .filter((name) => name.includes('Cost_of_Goods_Sold') && name.endsWith('.csv'))
    .sort()
    .map((name) => ({ name, content: readFileSync(path.join(historyRoot, name), 'utf8') }));
  if (files.length !== 4) throw new Error(`Sellerboard COGS operation expected four files; found ${files.length}.`);

  const baseUrl = (process.env.ECOBASE_LIVE_GATE_API_BASE ?? 'http://127.0.0.1:13080/api').replace(/\/$/, '');
  const token = process.env.ECOBASE_REPAIR_TOKEN ?? (await signIn(baseUrl));
  const action = {
    'dry-run': 'previewSellerboardCogs',
    apply: 'applySellerboardCogsBackfill',
    'verify-idempotency': 'verifySellerboardCogsBackfillIdempotency',
  }[mode];
  const values: Record<string, unknown> = { files };
  if (mode !== 'dry-run') {
    values.decisionDigest = requiredArgument('--digest=');
    values.confirmation = requiredArgument('--confirm=');
    values.importedAt = argument('--imported-at=') ?? '2026-07-14T00:00:00.000Z';
  }
  const response = await fetch(`${baseUrl}/ecobaseImport:${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Sellerboard COGS ${mode} failed (${response.status}): ${JSON.stringify(body)}`);
  const result = unwrap(body);
  const output = path.resolve(requiredArgument('--json='));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`Sellerboard COGS ${mode}: digest=${result.decisionDigest ?? result.first?.decisionDigest ?? 'n/a'}`);
  console.log(`JSON: ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
