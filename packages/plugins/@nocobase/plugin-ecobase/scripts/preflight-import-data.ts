#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightImportFiles } from '../src/features/source-import/server/import-preflight';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const NOCOBASE_ROOT = path.resolve(PLUGIN_ROOT, '../../../..');
const PROJECT_ROOT = path.dirname(NOCOBASE_ROOT);
const DEFAULT_OUTPUT = path.join(NOCOBASE_ROOT, '.local', 'live-gate-bootstrap', 'import-preflight.json');

function requiredFile(filePath: string) {
  if (!existsSync(filePath)) throw new Error(`Ecobase import preflight failed: required file is missing: ${filePath}`);
  return filePath;
}

function csvFilesIn(directory: string) {
  if (!existsSync(directory)) throw new Error(`Ecobase import preflight failed: directory is missing: ${directory}`);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.csv'))
    .sort()
    .map((name) => path.join(directory, name));
}

function sourceFiles() {
  return [
    ...csvFilesIn(path.join(PROJECT_ROOT, 'data', 'history')),
    requiredFile(
      path.join(
        PROJECT_ROOT,
        'data',
        'supplier-management-sheets',
        'Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
      ),
    ),
    requiredFile(
      path.join(PROJECT_ROOT, 'data', 'supplier-management-sheets', 'Supplier Analysis Tracker - Supplier 2026.csv'),
    ),
    requiredFile(
      path.join(PROJECT_ROOT, 'data', 'order-managment-sheets', 'Ecofission-Order Management - Purchase Orders.csv'),
    ),
    requiredFile(
      path.join(PROJECT_ROOT, 'data', 'order-managment-sheets', 'Ecofission-Order Management - OrderDetails.csv'),
    ),
    ...csvFilesIn(path.join(PROJECT_ROOT, 'data', 'clickup')),
  ];
}

function outputPath() {
  const argument = process.argv.find((value) => value.startsWith('--json='));
  return argument ? path.resolve(argument.slice('--json='.length)) : DEFAULT_OUTPUT;
}

try {
  const files = sourceFiles().map((filePath) => ({
    name: path.relative(PROJECT_ROOT, filePath),
    content: readFileSync(filePath, 'utf8'),
  }));
  const result = preflightImportFiles(files);
  const reportPath = outputPath();
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

  console.log(
    `Ecobase import preflight: files=${result.fileCount} rows=${result.rowCount} errors=${result.errorCount} warnings=${result.warningCount}`,
  );
  for (const [code, count] of Object.entries(result.issueCounts)) console.log(`  ${code}: ${count}`);
  console.log(`Report: ${reportPath}`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
