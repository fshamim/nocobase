#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  previewSupplierEvidenceBackfill,
  type SupplierEvidenceFiles,
  type SupplierEvidenceSnapshot,
} from '../src/features/supplier-management/server/supplier-evidence-backfill-service';

function argument(prefix: string) {
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function requiredArgument(prefix: string) {
  const value = argument(prefix);
  if (!value) throw new Error(`Supplier evidence operation requires ${prefix}<value>.`);
  return value;
}

function sourceFile(root: string, relativePath: string) {
  const filePath = path.join(root, relativePath);
  return { name: path.basename(filePath), content: readFileSync(filePath, 'utf8') };
}

function sourceFiles(dataRoot: string): SupplierEvidenceFiles {
  return {
    supplierTracker: sourceFile(
      dataRoot,
      'supplier-management-sheets/Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
    ),
    supplier2026: sourceFile(dataRoot, 'supplier-management-sheets/Supplier Analysis Tracker - Supplier 2026.csv'),
    purchaseOrders: sourceFile(dataRoot, 'order-managment-sheets/Ecofission-Order Management - Purchase Orders.csv'),
    orderDetails: sourceFile(dataRoot, 'order-managment-sheets/Ecofission-Order Management - OrderDetails.csv'),
  };
}

function writeResult(outputPath: string, result: unknown) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

async function signIn(baseUrl: string) {
  const email = process.env.ECOBASE_LIVE_GATE_ADMIN_EMAIL;
  const password = process.env.ECOBASE_LIVE_GATE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Supplier evidence remote operation requires ECOBASE_REPAIR_TOKEN or explicit ECOBASE_LIVE_GATE_ADMIN_EMAIL and ECOBASE_LIVE_GATE_ADMIN_PASSWORD.',
    );
  }
  const response = await fetch(`${baseUrl}/auth:signIn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || typeof body?.data?.token !== 'string') {
    throw new Error(`Supplier evidence sign-in failed with HTTP ${response.status}.`);
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
      'Usage: supplier-evidence-backfill.ts --dry-run|--apply|--verify-idempotency --data-root=<path> --json=<path>.',
    );
  }
  const mode = modes[0][0] as 'dry-run' | 'apply' | 'verify-idempotency';
  const dataRoot = path.resolve(requiredArgument('--data-root='));
  const outputPath = path.resolve(requiredArgument('--json='));
  const files = sourceFiles(dataRoot);
  const snapshotPath = argument('--snapshot=');

  if (snapshotPath) {
    if (mode !== 'dry-run') throw new Error('Supplier evidence snapshot mode supports --dry-run only.');
    const snapshot = JSON.parse(readFileSync(path.resolve(snapshotPath), 'utf8')) as SupplierEvidenceSnapshot;
    const result = previewSupplierEvidenceBackfill({ snapshot, files });
    writeResult(outputPath, result);
    console.log(
      `Supplier evidence dry-run: acceptedRows=${result.historicalEvidence.acceptedDetailRows} candidateFamilies=${result.historicalEvidence.candidateFamilies} selected=${result.familySelectionProjection.projectedPreferredFamilies} unresolved=${result.familySelectionProjection.projectedUnresolvedFamilies} stagingWrites=${result.stagingWrites}`,
    );
    console.log(`Digest: ${result.decisionDigest}`);
    console.log(`JSON: ${outputPath}`);
    return;
  }

  const baseUrl = (process.env.ECOBASE_LIVE_GATE_API_BASE ?? 'http://127.0.0.1:13080/api').replace(/\/$/, '');
  const token = process.env.ECOBASE_REPAIR_TOKEN ?? (await signIn(baseUrl));
  const action = {
    'dry-run': 'previewSupplierEvidenceBackfill',
    apply: 'applySupplierEvidenceBackfill',
    'verify-idempotency': 'verifySupplierEvidenceBackfillIdempotency',
  }[mode];
  const values: Record<string, unknown> = { files: Object.values(files) };
  if (mode !== 'dry-run') {
    values.decisionDigest = requiredArgument('--digest=');
    values.confirmation = requiredArgument('--confirm=');
  }
  const response = await fetch(`${baseUrl}/ecobaseSupplierManagement:${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Supplier evidence ${mode} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  const result = unwrap(body);
  writeResult(outputPath, result);
  console.log(`Supplier evidence ${mode}: ${JSON.stringify(result)}`);
  console.log(`JSON: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
