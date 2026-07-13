#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
const baseUrl = (process.env.ECOBASE_LIVE_GATE_API_BASE ?? 'http://127.0.0.1:13080/api').replace(/\/$/, '');
const configuredToken = process.env.ECOBASE_REPAIR_TOKEN;
const repairVersion = argument('--version=') ?? 'supplier-resolution-v1';
const codeSha = argument('--code-sha=') ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const output = path.resolve(argument('--json=') ?? '.local/live-gate-bootstrap/supplier-resolution-repair.json');

async function main() {
  if (!['preview', 'apply'].includes(mode ?? '')) {
    throw new Error('Usage: supplier-resolution-repair.ts preview|apply [--version=...] [--code-sha=...]');
  }
  const token = configuredToken ?? (await signIn());
  const values =
    mode === 'preview'
      ? { repairVersion, codeSha }
      : {
          runId: requiredArgument('--run='),
          decisionDigest: requiredArgument('--digest='),
          codeSha,
          batchSize: Number(argument('--batch-size=') ?? 25),
          confirmation: requiredArgument('--confirm='),
        };
  const response = await fetch(
    `${baseUrl}/ecobaseSupplierManagement:${
      mode === 'preview' ? 'previewSupplierResolutionRepair' : 'applySupplierResolutionRepair'
    }`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(values),
    },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(`Ecobase supplier repair ${mode} failed (${response.status}): ${JSON.stringify(body)}`);
  const result = unwrap(body);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `Supplier repair ${mode}: status=${result.status} candidates=${result.candidateCount} excluded=${result.excludedCount} changed=${result.changedCount} cursor=${result.cursor}`,
  );
  console.log(`Run: ${result.id}`);
  console.log(`Digest: ${result.decisionDigest}`);
  console.log(`JSON: ${output}`);
}

function argument(prefix: string) {
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value?.slice(prefix.length);
}

function requiredArgument(prefix: string) {
  const value = argument(prefix);
  if (!value) throw new Error(`Ecobase supplier repair requires ${prefix}<value>.`);
  return value;
}

async function signIn() {
  const email = process.env.ECOBASE_LIVE_GATE_ADMIN_EMAIL;
  const password = process.env.ECOBASE_LIVE_GATE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Ecobase supplier repair requires ECOBASE_REPAIR_TOKEN or explicit ECOBASE_LIVE_GATE_ADMIN_EMAIL and ECOBASE_LIVE_GATE_ADMIN_PASSWORD.',
    );
  }
  const response = await fetch(`${baseUrl}/auth:signIn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || typeof body?.data?.token !== 'string') {
    throw new Error(`Ecobase supplier repair sign-in failed with HTTP ${response.status}.`);
  }
  return body.data.token;
}

function unwrap(value: any): any {
  return value && typeof value === 'object' && Object.keys(value).length === 1 && 'data' in value
    ? unwrap(value.data)
    : value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
