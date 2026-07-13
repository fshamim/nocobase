#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bronzePurgeRecoveryEvidence, createSeedPlan, validateBundleManifest } from './greenfield-seed-lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const NOCOBASE_ROOT = path.resolve(PLUGIN_ROOT, '../../../..');
const PROJECT_ROOT = path.dirname(NOCOBASE_ROOT);
const BOOTSTRAP_SCRIPT = path.join(SCRIPT_DIR, 'live-gate-bootstrap.mjs');

function event(name, values = {}) {
  process.stdout.write(`${JSON.stringify({ event: name, at: new Date().toISOString(), ...values })}\n`);
}

function flag(argv, name) {
  return argv.includes(name);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Ecobase greenfield seed failed: ${name} requires a value.`);
  }
  return value;
}

function assertKnownOptions(argv, allowed) {
  for (const argument of argv) {
    if (argument.startsWith('--') && !allowed.has(argument)) {
      throw new Error(`Ecobase greenfield seed failed: unknown option ${argument}.`);
    }
  }
}

function assertCleanGit() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: NOCOBASE_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Ecobase greenfield seed failed: git status exited ${result.status ?? 'without a status'}.`);
  }
  if (result.stdout.trim()) {
    throw new Error('Ecobase greenfield seed failed: the NocoBase worktree must be clean.');
  }
}

async function runBootstrap(command, env = {}) {
  const startedAt = Date.now();
  event('seed_operation_started', { operation: command });
  const heartbeatMs = Number(process.env.ECOBASE_SEED_HEARTBEAT_MS ?? 30_000);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new Error('Ecobase greenfield seed failed: ECOBASE_SEED_HEARTBEAT_MS must be a positive number.');
  }
  const child = spawn(process.execPath, [BOOTSTRAP_SCRIPT, command], {
    cwd: NOCOBASE_ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const heartbeat = setInterval(
    () => event('seed_operation_heartbeat', { operation: command, elapsedMs: Date.now() - startedAt }),
    heartbeatMs,
  );
  heartbeat.unref();
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  }).finally(() => clearInterval(heartbeat));
  if (exitCode !== 0) {
    throw new Error(`Ecobase greenfield seed failed: ${command} exited with code ${exitCode ?? 'unknown'}.`);
  }
  event('seed_operation_completed', { operation: command, durationMs: Date.now() - startedAt });
}

async function runSeed(argv) {
  assertKnownOptions(
    argv,
    new Set([
      '--dry-run',
      '--use-bundle',
      '--project-root',
      '--profile',
      '--target',
      '--start-at',
      '--stop-after',
      '--skip-gold',
      '--skip-reset',
    ]),
  );
  const manifestPath = option(argv, '--use-bundle');
  if (!manifestPath) {
    throw new Error('Ecobase greenfield seed failed: --use-bundle is required.');
  }
  const dryRun = flag(argv, '--dry-run');
  const profile = option(argv, '--profile') ?? 'complete';
  const target = option(argv, '--target') ?? (profile === 'staging-fast-clickup' ? 'staging' : 'local');
  const plan = createSeedPlan({
    profile,
    target,
    startAt: option(argv, '--start-at'),
    stopAfter: option(argv, '--stop-after'),
    skipGold: flag(argv, '--skip-gold'),
    skipReset: flag(argv, '--skip-reset'),
  });
  event('seed_started', { dryRun, plan });
  const bundleStartedAt = Date.now();
  event('seed_stage_started', { phase: 'bundle', dryRun });
  const bundle = await validateBundleManifest({
    manifestPath,
    projectRoot: option(argv, '--project-root') ?? PROJECT_ROOT,
    profile,
  });
  event('seed_stage_completed', { phase: 'bundle', dryRun, durationMs: Date.now() - bundleStartedAt, bundle });
  if (dryRun) {
    for (const phase of plan.phases) {
      event('seed_stage_started', { phase, dryRun: true });
      event('seed_stage_completed', { phase, dryRun: true, durationMs: 0, skipGold: phase === 'gold' && plan.skipGold });
    }
    event('seed_completed', { dryRun: true, bundleChecksum: bundle.bundleChecksum, plan });
    return;
  }
  if (profile === 'staging-fast-clickup') {
    throw new Error(
      'Ecobase greenfield seed failed: staging-fast-clickup live execution must use the staging deployment procedure after this dry plan.',
    );
  }
  assertCleanGit();
  const env = {
    ECOBASE_BOOTSTRAP_SOURCE_VERSION: bundle.asOfDate,
    ECOBASE_GREENFIELD_BUNDLE_PATH: bundle.manifestPath,
    ECOBASE_GREENFIELD_PROJECT_ROOT: bundle.projectRoot,
    ECOBASE_SEED_PROFILE: plan.profile,
    ECOBASE_DEPLOYMENT_TARGET: plan.target,
    ECOBASE_SEED_START_AT: plan.startAt,
    ECOBASE_SEED_STOP_AFTER: plan.stopAfter,
    ECOBASE_SEED_SKIP_GOLD: plan.skipGold ? '1' : '0',
  };
  for (const operation of plan.operations.slice(1)) {
    const command = operation.replaceAll('_', '-');
    await runBootstrap(command, env);
  }
  event('seed_completed', { dryRun: false, bundleChecksum: bundle.bundleChecksum, plan });
}

async function runMaintenance(command, argv) {
  const dryRun = flag(argv, '--dry-run');
  if (command === 'deactivate-migration-sources') {
    assertKnownOptions(argv, new Set(['--dry-run', '--confirm']));
    if (!dryRun && option(argv, '--confirm') !== command) {
      throw new Error(`Ecobase greenfield seed failed: pass --confirm ${command}.`);
    }
    if (dryRun) {
      event('maintenance_dry_run', { operation: command, sourceTypes: ['google_sheets', 'clickup'] });
      return;
    }
    assertCleanGit();
    await runBootstrap(command);
    return;
  }
  assertKnownOptions(argv, new Set(['--dry-run', '--before', '--confirm', '--evidence-dir']));
  const before = option(argv, '--before');
  if (!before || Number.isNaN(new Date(before).getTime())) {
    throw new Error('Ecobase greenfield seed failed: purge-expired-bronze requires a valid --before instant.');
  }
  if (!dryRun && option(argv, '--confirm') !== command) {
    throw new Error(`Ecobase greenfield seed failed: pass --confirm ${command}.`);
  }
  if (dryRun) {
    event('maintenance_dry_run', { operation: command, before: new Date(before).toISOString() });
    return;
  }
  assertCleanGit();
  try {
    await runBootstrap(command, { ECOBASE_BRONZE_PURGE_BEFORE: new Date(before).toISOString() });
  } catch (error) {
    const evidenceDir = path.resolve(option(argv, '--evidence-dir') ?? path.join(NOCOBASE_ROOT, '.local', 'greenfield-seed'));
    await mkdir(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, `bronze-purge-recovery-${Date.now()}.json`);
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        bronzePurgeRecoveryEvidence({
          before,
          error,
          commandPath: path.relative(NOCOBASE_ROOT, fileURLToPath(import.meta.url)),
        }),
        null,
        2,
      )}\n`,
    );
    throw new Error(`Ecobase greenfield seed failed: Bronze purge failed; recovery evidence written to ${evidencePath}.`);
  }
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/greenfield-seed.mjs seed --use-bundle PATH [--dry-run] [--project-root PATH]
    [--profile complete|staging-fast-clickup] [--target local|staging]
    [--start-at sellerboard|suppliers|orders|clickup|gold]
    [--stop-after bundle|sellerboard|suppliers|orders|clickup|gold] [--skip-gold] [--skip-reset]
  node scripts/greenfield-seed.mjs deactivate-migration-sources [--dry-run]
    [--confirm deactivate-migration-sources]
  node scripts/greenfield-seed.mjs purge-expired-bronze --before ISO_INSTANT [--dry-run]
    [--confirm purge-expired-bronze] [--evidence-dir PATH]
  node scripts/greenfield-seed.mjs verify
  node scripts/greenfield-seed.mjs fingerprint
`);
}

async function main() {
  const [command = 'help', ...argv] = process.argv.slice(2);
  if (command === 'seed') return runSeed(argv);
  if (command === 'deactivate-migration-sources' || command === 'purge-expired-bronze') {
    return runMaintenance(command, argv);
  }
  if (command === 'verify') {
    assertCleanGit();
    return runBootstrap('verify-links');
  }
  if (command === 'fingerprint') {
    assertCleanGit();
    return runBootstrap('business-fingerprint');
  }
  printUsage();
  if (command !== 'help') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
