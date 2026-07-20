#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function argument(prefix: string) {
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function requiredArgument(prefix: string) {
  const value = argument(prefix);
  if (!value) throw new Error(`EcoBase source coverage bootstrap requires ${prefix}<value>.`);
  return value;
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
  ].filter(([, enabled]) => enabled);
  if (modes.length !== 1) {
    throw new Error(
      'Usage: source-coverage-bootstrap.ts --dry-run|--apply --base-url=<url> --evidence-digest=<sha256> --import-run-id=<id>... --json=<path> [--plan-digest=<sha256> --confirm=<token>].',
    );
  }
  const mode = modes[0][0] as 'dry-run' | 'apply';
  const importRunIds = process.argv
    .filter((item) => item.startsWith('--import-run-id='))
    .map((item) => item.slice('--import-run-id='.length))
    .filter(Boolean);
  if (!importRunIds.length) throw new Error('EcoBase source coverage bootstrap requires at least one --import-run-id.');
  const token = process.env.ECOBASE_REPAIR_TOKEN;
  if (!token) throw new Error('EcoBase source coverage bootstrap requires ECOBASE_REPAIR_TOKEN.');
  const baseUrl = requiredArgument('--base-url=').replace(/\/$/, '');
  const values: Record<string, unknown> = {
    mode,
    expectedEvidenceDigest: requiredArgument('--evidence-digest='),
    importRunIds,
  };
  if (mode === 'apply') {
    values.expectedPlanDigest = requiredArgument('--plan-digest=');
    values.confirmation = requiredArgument('--confirm=');
  }
  const response = await fetch(`${baseUrl}/ecobaseImport:bootstrapSourceCoverage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`EcoBase source coverage bootstrap ${mode} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  const result = unwrap(body);
  const output = path.resolve(requiredArgument('--json='));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`EcoBase source coverage bootstrap ${mode}: planDigest=${result.planDigest}`);
  console.log(`JSON: ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
