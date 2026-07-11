#!/usr/bin/env node
/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const nocobaseRoot = path.resolve(pluginRoot, '../../../..');
const projectRoot = path.dirname(nocobaseRoot);
const artifactDir = process.env.ECOBASE_LIVE_GATE_BOOTSTRAP_DIR
  ? path.resolve(process.env.ECOBASE_LIVE_GATE_BOOTSTRAP_DIR)
  : path.join(nocobaseRoot, '.local', 'live-gate-bootstrap');
const inputPath =
  argument('--file=') ??
  path.join(projectRoot, 'data', 'order-managment-sheets', 'Ecofission-Order Management - OrderDetails.csv');
const jsonPath = argument('--json=') ?? path.join(artifactDir, 'order-details-relationship-verification.json');
const csvPath = argument('--csv=') ?? path.join(artifactDir, 'order-details-relationship-discrepancies.csv');
const baseUrl = (process.env.ECOBASE_LIVE_GATE_API_BASE ?? 'http://127.0.0.1:13080/api').replace(/\/$/, '');
const email = process.env.ECOBASE_LIVE_GATE_ADMIN_EMAIL ?? 'admin@nocobase.com';
const password = process.env.ECOBASE_LIVE_GATE_ADMIN_PASSWORD ?? 'admin123';

async function main() {
  try {
    if (!existsSync(inputPath))
      throw new Error(`Ecobase OrderDetails verification failed: file is missing: ${inputPath}`);
    const token = await signIn();
    const response = await fetch(`${baseUrl}/ecobaseImport:verifyOrderDetailsRelationships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ name: path.basename(inputPath), content: readFileSync(inputPath, 'utf8') }] }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Ecobase OrderDetails verification failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    const result = unwrap(body);
    mkdirSync(path.dirname(jsonPath), { recursive: true });
    mkdirSync(path.dirname(csvPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(csvPath, discrepancyCsv(result.discrepancies ?? []), { mode: 0o600 });
    console.log(
      `Ecobase OrderDetails verification: rows=${result.totals.sourceRows} accepted=${result.totals.acceptedRows} verified=${result.totals.verifiedRows} relationshipGaps=${result.totals.relationshipGaps} inventoryHistoryGaps=${result.totals.inventoryHistoryGaps}`,
    );
    console.log(`JSON: ${jsonPath}`);
    console.log(`CSV: ${csvPath}`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();

function argument(prefix: string) {
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? path.resolve(value.slice(prefix.length)) : undefined;
}

async function signIn() {
  const response = await fetch(`${baseUrl}/auth:signIn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || typeof body?.data?.token !== 'string') {
    throw new Error(`Ecobase OrderDetails verification sign-in failed with HTTP ${response.status}.`);
  }
  return body.data.token;
}

function unwrap(value: any): any {
  return value && typeof value === 'object' && Object.keys(value).length === 1 && 'data' in value
    ? unwrap(value.data)
    : value;
}

function csvCell(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function discrepancyCsv(discrepancies: Array<Record<string, unknown>>) {
  const header = ['sourceRow', 'classification', 'reason', 'expectedIdentity', 'actualIds'];
  return `${[
    header.join(','),
    ...discrepancies.map((item) =>
      [item.sourceRow, item.classification, item.reason, item.expectedIdentity, item.actualIds].map(csvCell).join(','),
    ),
  ].join('\n')}\n`;
}
