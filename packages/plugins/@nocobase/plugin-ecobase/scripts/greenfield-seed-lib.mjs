import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const SEED_PHASES = ['sellerboard', 'suppliers', 'orders', 'clickup', 'gold'];
export const EXPECTED_BUNDLE_GROUP_IDS = [
  'clickup-order-status',
  'order-management',
  'sellerboard-cogs-ecofission',
  'sellerboard-cogs-muxtex',
  'sellerboard-cogs-retail-heaven',
  'sellerboard-cogs-stop-shop',
  'sellerboard-history-ecofission',
  'sellerboard-history-muxtex',
  'sellerboard-history-retail-heaven',
  'sellerboard-history-stop-shop',
  'supplier-management',
];
export const STAGING_FAST_CLICKUP_GROUP_IDS = [
  'clickup-order-status',
  'order-management',
  'supplier-management',
];
const BUNDLE_GROUP_IDS_BY_PROFILE = new Map([
  ['complete', EXPECTED_BUNDLE_GROUP_IDS],
  ['staging-fast-clickup', STAGING_FAST_CLICKUP_GROUP_IDS],
]);
const STAGING_FAST_CLICKUP_FILE_PATHS_BY_GROUP = new Map([
  ['clickup-order-status', ['data/clickup/Order Management Clickup Data 06-07-2026.csv']],
  [
    'order-management',
    [
      'data/order-managment-sheets/Ecofission-Order Management - Purchase Orders.csv',
      'data/order-managment-sheets/Ecofission-Order Management - OrderDetails.csv',
    ],
  ],
  [
    'supplier-management',
    [
      'data/supplier-management-sheets/Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
      'data/supplier-management-sheets/Supplier Analysis Tracker - Supplier 2026.csv',
    ],
  ],
]);
const EXPECTED_BUNDLE_FILE_COUNTS = new Map([
  ['order-management', 2],
  ['supplier-management', 2],
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Ecobase greenfield seed failed: ${label} is required.`);
  }
  return value.trim();
}

function requireDate(value, label) {
  const date = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) {
    throw new Error(`Ecobase greenfield seed failed: ${label} "${date}" must be YYYY-MM-DD.`);
  }
  return date;
}

export function buildBundleChecksum(manifest) {
  return sha256(
    JSON.stringify({
      profile: manifest.profile,
      profileVersion: manifest.profileVersion,
      asOfDate: manifest.asOfDate,
      sourceVersion: manifest.sourceVersion,
      groups: manifest.groups.map((group) => ({
        id: group.id,
        files: group.files.map((file) => ({ path: file.path, checksum: file.checksum, rowCount: file.rowCount })),
      })),
    }),
  );
}

export async function validateBundleManifest({ manifestPath, projectRoot, profile }) {
  const resolvedManifestPath = path.resolve(requiredString(manifestPath, '--use-bundle'));
  const resolvedProjectRoot = path.resolve(requiredString(projectRoot, '--project-root'));
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolvedManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Ecobase greenfield seed failed: could not read bundle manifest ${resolvedManifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Ecobase greenfield seed failed: bundle manifest must be a JSON object.');
  }
  const manifestProfile = requiredString(manifest.profile, 'bundle profile');
  const expectedGroupIds = BUNDLE_GROUP_IDS_BY_PROFILE.get(manifestProfile);
  if (!expectedGroupIds) {
    throw new Error(`Ecobase greenfield seed failed: unsupported bundle profile ${manifestProfile}.`);
  }
  if (profile && profile !== manifestProfile) {
    throw new Error(`Ecobase greenfield seed failed: requested profile ${profile} does not match bundle profile ${manifestProfile}.`);
  }
  if (requiredString(manifest.profileVersion, 'bundle profileVersion') !== '2026-07-13.1') {
    throw new Error(`Ecobase greenfield seed failed: unsupported bundle profileVersion ${manifest.profileVersion}.`);
  }
  requireDate(manifest.asOfDate, 'bundle asOfDate');
  if (manifest.sourceVersion !== `${manifest.asOfDate}T00:00:00.000Z`) {
    throw new Error('Ecobase greenfield seed failed: bundle sourceVersion does not match asOfDate.');
  }
  if (!Array.isArray(manifest.groups)) {
    throw new Error('Ecobase greenfield seed failed: bundle groups must be an array.');
  }
  const groupIds = manifest.groups.map((group) => requiredString(group?.id, 'bundle group id'));
  if (JSON.stringify([...groupIds].sort()) !== JSON.stringify(expectedGroupIds)) {
    throw new Error(`Ecobase greenfield seed failed: bundle groups are incomplete or unexpected: ${groupIds.join(', ')}.`);
  }
  const seenPaths = new Set();
  const filesToValidate = [];
  let fileCount = 0;
  for (const group of manifest.groups) {
    if (!Array.isArray(group.files) || group.files.length === 0) {
      throw new Error(`Ecobase greenfield seed failed: bundle group ${group.id} has no files.`);
    }
    const expectedFileCount = EXPECTED_BUNDLE_FILE_COUNTS.get(group.id) ?? 1;
    if (group.files.length !== expectedFileCount) {
      throw new Error(
        `Ecobase greenfield seed failed: bundle group ${group.id} must contain ${expectedFileCount} file(s).`,
      );
    }
    for (const file of group.files) {
      const relativePath = requiredString(file?.path, `bundle group ${group.id} file path`);
      if (
        manifestProfile === 'staging-fast-clickup' &&
        !STAGING_FAST_CLICKUP_FILE_PATHS_BY_GROUP.get(group.id)?.includes(relativePath)
      ) {
        throw new Error(
          `Ecobase greenfield seed failed: staging-fast-clickup forbids unapproved source path: ${relativePath}.`,
        );
      }
      if (seenPaths.has(relativePath)) {
        throw new Error(`Ecobase greenfield seed failed: duplicate bundle file path ${relativePath}.`);
      }
      seenPaths.add(relativePath);
      if (!/^[a-f0-9]{64}$/.test(file.checksum)) {
        throw new Error(`Ecobase greenfield seed failed: bundle file ${relativePath} has an invalid checksum.`);
      }
      if (!Number.isInteger(file.rowCount) || file.rowCount < 0) {
        throw new Error(`Ecobase greenfield seed failed: bundle file ${relativePath} has an invalid rowCount.`);
      }
      const resolvedFilePath = path.resolve(resolvedProjectRoot, relativePath);
      if (resolvedFilePath !== resolvedProjectRoot && !resolvedFilePath.startsWith(`${resolvedProjectRoot}${path.sep}`)) {
        throw new Error(`Ecobase greenfield seed failed: bundle file path escapes project root: ${relativePath}.`);
      }
      filesToValidate.push({ relativePath, resolvedFilePath, checksum: file.checksum });
      fileCount += 1;
    }
  }
  const expectedFileCount = [...EXPECTED_BUNDLE_FILE_COUNTS.entries()].reduce(
    (total, [id, count]) => total + (expectedGroupIds.includes(id) ? count : 0),
    expectedGroupIds.length - [...EXPECTED_BUNDLE_FILE_COUNTS.keys()].filter((id) => expectedGroupIds.includes(id)).length,
  );
  if (fileCount !== expectedFileCount) {
    throw new Error(
      `Ecobase greenfield seed failed: ${manifestProfile} bundle must contain ${expectedFileCount} files, found ${fileCount}.`,
    );
  }
  const structuralBundleChecksum = buildBundleChecksum(manifest);
  if (structuralBundleChecksum !== manifest.bundleChecksum) {
    throw new Error('Ecobase greenfield seed failed: bundleChecksum does not match the manifest.');
  }
  for (const file of filesToValidate) {
    const actualChecksum = sha256(await readFile(file.resolvedFilePath));
    if (actualChecksum !== file.checksum) {
      throw new Error(`Ecobase greenfield seed failed: bundle file checksum changed for ${file.relativePath}.`);
    }
  }
  return {
    manifestPath: resolvedManifestPath,
    profile: manifestProfile,
    projectRoot: resolvedProjectRoot,
    profileVersion: manifest.profileVersion,
    asOfDate: manifest.asOfDate,
    sourceVersion: manifest.sourceVersion,
    bundleChecksum: manifest.bundleChecksum,
    groupCount: manifest.groups.length,
    fileCount,
  };
}

export function createSeedPlan({
  profile = 'complete',
  target = profile === 'staging-fast-clickup' ? 'staging' : 'local',
  startAt = 'sellerboard',
  stopAfter = 'gold',
  skipGold = false,
  skipReset = false,
} = {}) {
  if (!BUNDLE_GROUP_IDS_BY_PROFILE.has(profile)) {
    throw new Error(`Ecobase greenfield seed failed: unsupported profile ${profile}.`);
  }
  if (profile === 'staging-fast-clickup' && target !== 'staging') {
    throw new Error('Ecobase greenfield seed failed: staging-fast-clickup requires target staging.');
  }
  if (!SEED_PHASES.includes(startAt)) {
    throw new Error(`Ecobase greenfield seed failed: --start-at must be one of ${SEED_PHASES.join(', ')}.`);
  }
  if (stopAfter !== 'bundle' && !SEED_PHASES.includes(stopAfter)) {
    throw new Error(`Ecobase greenfield seed failed: --stop-after must be bundle or one of ${SEED_PHASES.join(', ')}.`);
  }
  if (stopAfter === 'bundle') {
    if (startAt !== 'sellerboard') {
      throw new Error('Ecobase greenfield seed failed: --stop-after bundle cannot be combined with a later --start-at phase.');
    }
    return {
      profile,
      target,
      startAt,
      stopAfter,
      skipGold,
      skipReset,
      phases: [],
      operations: ['validate_bundle'],
      stages: ['validate_bundle'],
    };
  }
  const startIndex = SEED_PHASES.indexOf(startAt);
  const stopIndex = SEED_PHASES.indexOf(stopAfter);
  if (startIndex > stopIndex) {
    throw new Error('Ecobase greenfield seed failed: --start-at must not be later than --stop-after.');
  }
  const phases = SEED_PHASES.slice(startIndex, stopIndex + 1);
  const operations = ['validate_bundle'];
  if (startAt === 'sellerboard' && !skipReset) operations.push('reset_db', 'restore_sources');
  operations.push('import_data');
  if (profile !== 'staging-fast-clickup') {
    return { profile, target, startAt, stopAfter, skipGold, skipReset, phases, operations, stages: phases };
  }
  const stages = ['validate_bundle', 'confirm_staging_target', 'preflight_sellerboard_api_current'];
  if (startAt === 'sellerboard' && !skipReset) {
    stages.push('backup_staging', 'reset_staging', 'restore_sources', 'upsert_approved_users');
  }
  if (phases.includes('sellerboard')) stages.push('sellerboard_api_current');
  if (phases.includes('suppliers')) stages.push('suppliers');
  if (phases.includes('orders')) stages.push('orders', 'checkpoint_c3');
  if (phases.includes('clickup')) stages.push('clickup_status_comments');
  if (phases.includes('gold') && !skipGold) stages.push('gold_refresh_once', 'verify_security_and_ui');
  return {
    profile,
    target,
    startAt,
    stopAfter,
    skipGold,
    skipReset,
    phases,
    operations: ['validate_bundle'],
    stages,
  };
}

function isVolatileKey(key) {
  return key === 'id' || key.endsWith('Id') || key.endsWith('At') || key === 'timestamp';
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isVolatileKey(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function bronzePurgeRecoveryEvidence({ before, error, commandPath }) {
  const instant = new Date(before);
  if (Number.isNaN(instant.getTime())) {
    throw new Error('Ecobase greenfield seed failed: purge recovery evidence requires a valid before instant.');
  }
  const operation = 'purge-expired-bronze';
  return {
    operation,
    status: 'failed',
    before: instant.toISOString(),
    error: error instanceof Error ? error.message : String(error),
    recovery: `Retry after correcting the failure: node ${commandPath} ${operation} --before ${instant.toISOString()} --confirm ${operation}`,
  };
}

export function businessFingerprint(value) {
  const canonical = canonicalize(value);
  return { algorithm: 'sha256', value: sha256(JSON.stringify(canonical)), canonical };
}
