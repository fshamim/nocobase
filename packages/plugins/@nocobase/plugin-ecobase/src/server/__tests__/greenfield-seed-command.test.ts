/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bronzePurgeRecoveryEvidence,
  buildBundleChecksum,
  businessFingerprint,
  createSeedPlan,
  EXPECTED_BUNDLE_GROUP_IDS,
  validateBundleManifest,
} from '../../../scripts/greenfield-seed-lib.mjs';

const roots: string[] = [];
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/greenfield-seed.mjs');

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixtureBundle() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'ecobase-greenfield-command-'));
  roots.push(projectRoot);
  const groups = [] as Array<{
    id: string;
    files: Array<{ name: string; path: string; checksum: string; rowCount: number }>;
  }>;
  for (const id of EXPECTED_BUNDLE_GROUP_IDS) {
    const count = ['order-management', 'supplier-management'].includes(id) ? 2 : 1;
    const files = [];
    for (let index = 1; index <= count; index += 1) {
      const relativePath = `fixtures/${id}-${index}.csv`;
      const content = `key,value\n${id}-${index},accepted\n`;
      const filePath = path.join(projectRoot, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
      files.push({ name: path.basename(relativePath), path: relativePath, checksum: sha256(content), rowCount: 1 });
    }
    groups.push({ id, files });
  }
  const manifest = {
    profileVersion: '2026-07-13.1',
    asOfDate: '2026-07-13',
    sourceVersion: '2026-07-13T00:00:00.000Z',
    bundleChecksum: '',
    groups,
  };
  manifest.bundleChecksum = buildBundleChecksum(manifest);
  const manifestPath = path.join(projectRoot, 'bundle.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { projectRoot, manifestPath, manifest };
}

function runDryRun(manifestPath: string, projectRoot: string, options: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [script, 'seed', '--dry-run', '--use-bundle', manifestPath, '--project-root', projectRoot, ...options],
    { encoding: 'utf8' },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('greenfield seed operations', () => {
  it('validates all 13 cached files and rejects changed source material', async () => {
    const fixture = await fixtureBundle();
    await expect(
      validateBundleManifest({ manifestPath: fixture.manifestPath, projectRoot: fixture.projectRoot }),
    ).resolves.toMatchObject({ groupCount: 11, fileCount: 13, bundleChecksum: fixture.manifest.bundleChecksum });

    const firstFile = fixture.manifest.groups[0].files[0].path;
    await writeFile(path.join(fixture.projectRoot, firstFile), 'key,value\nchanged,rejected\n');
    await expect(
      validateBundleManifest({ manifestPath: fixture.manifestPath, projectRoot: fixture.projectRoot }),
    ).rejects.toThrow(`bundle file checksum changed for ${firstFile}`);
  });

  it('rejects bundle paths outside the declared project root', async () => {
    const fixture = await fixtureBundle();
    fixture.manifest.groups[0].files[0].path = '../outside.csv';
    fixture.manifest.bundleChecksum = buildBundleChecksum(fixture.manifest);
    await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);

    await expect(
      validateBundleManifest({ manifestPath: fixture.manifestPath, projectRoot: fixture.projectRoot }),
    ).rejects.toThrow('bundle file path escapes project root: ../outside.csv');
  });

  it('plans resumable phases without repeating reset work', () => {
    expect(createSeedPlan()).toMatchObject({
      phases: ['sellerboard', 'suppliers', 'orders', 'clickup', 'gold'],
      operations: ['validate_bundle', 'reset_db', 'restore_sources', 'import_data'],
    });
    expect(createSeedPlan({ startAt: 'suppliers', stopAfter: 'clickup' })).toMatchObject({
      phases: ['suppliers', 'orders', 'clickup'],
      operations: ['validate_bundle', 'import_data'],
    });
    expect(createSeedPlan({ stopAfter: 'bundle' })).toMatchObject({ phases: [], operations: ['validate_bundle'] });
    expect(() => createSeedPlan({ startAt: 'gold', stopAfter: 'orders' })).toThrow(
      '--start-at must not be later than --stop-after',
    );
  });

  it.each([
    { options: ['--stop-after', 'bundle'], phases: ['bundle'] },
    {
      options: ['--start-at', 'suppliers', '--stop-after', 'clickup', '--skip-gold'],
      phases: ['bundle', 'suppliers', 'orders', 'clickup'],
    },
    { options: ['--start-at', 'gold', '--skip-gold', '--skip-reset'], phases: ['bundle', 'gold'] },
  ])('emits ordered machine-readable dry-run events for $options', async ({ options, phases }) => {
    const fixture = await fixtureBundle();
    const events = runDryRun(fixture.manifestPath, fixture.projectRoot, options);

    expect(events[0]).toMatchObject({ event: 'seed_started', dryRun: true });
    expect(events.filter((item) => item.event === 'seed_stage_completed').map((item) => item.phase)).toEqual(phases);
    expect(events.at(-1)).toMatchObject({
      event: 'seed_completed',
      dryRun: true,
      bundleChecksum: fixture.manifest.bundleChecksum,
    });
  });

  it('does not expose the old non-clean override', async () => {
    const fixture = await fixtureBundle();
    const result = spawnSync(
      process.execPath,
      [
        script,
        'seed',
        '--dry-run',
        '--use-bundle',
        fixture.manifestPath,
        '--project-root',
        fixture.projectRoot,
        '--allow-non-clean',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option --allow-non-clean');
  });

  it('supports safe maintenance dry runs without touching a database', () => {
    const deactivate = spawnSync(process.execPath, [script, 'deactivate-migration-sources', '--dry-run'], {
      encoding: 'utf8',
    });
    const purge = spawnSync(
      process.execPath,
      [script, 'purge-expired-bronze', '--dry-run', '--before', '2026-08-13T00:00:00.000Z'],
      { encoding: 'utf8' },
    );

    expect(deactivate.status).toBe(0);
    expect(JSON.parse(deactivate.stdout)).toMatchObject({
      event: 'maintenance_dry_run',
      operation: 'deactivate-migration-sources',
      sourceTypes: ['google_sheets', 'clickup'],
    });
    expect(purge.status).toBe(0);
    expect(JSON.parse(purge.stdout)).toMatchObject({
      event: 'maintenance_dry_run',
      operation: 'purge-expired-bronze',
      before: '2026-08-13T00:00:00.000Z',
    });
  });

  it('preserves an exact retry command when Bronze purge fails', () => {
    expect(
      bronzePurgeRecoveryEvidence({
        before: '2026-08-13T00:00:00.000Z',
        error: new Error('database unavailable'),
        commandPath: 'scripts/greenfield-seed.mjs',
      }),
    ).toEqual({
      operation: 'purge-expired-bronze',
      status: 'failed',
      before: '2026-08-13T00:00:00.000Z',
      error: 'database unavailable',
      recovery:
        'Retry after correcting the failure: node scripts/greenfield-seed.mjs purge-expired-bronze --before 2026-08-13T00:00:00.000Z --confirm purge-expired-bronze',
    });
  });

  it('fingerprints business values independently of random ids, timestamps, and row order', () => {
    const first = businessFingerprint({
      orders: [
        { id: 'random-1', orderRef: 'PO-2', status: 'paid', updatedAt: '2026-07-13T10:00:00Z' },
        { id: 'random-2', orderRef: 'PO-1', status: 'draft', updatedAt: '2026-07-13T11:00:00Z' },
      ],
    });
    const second = businessFingerprint({
      orders: [
        { id: 'other-2', orderRef: 'PO-1', status: 'draft', updatedAt: '2026-07-14T11:00:00Z' },
        { id: 'other-1', orderRef: 'PO-2', status: 'paid', updatedAt: '2026-07-14T10:00:00Z' },
      ],
    });
    const changed = businessFingerprint({
      orders: [
        { orderRef: 'PO-1', status: 'paid' },
        { orderRef: 'PO-2', status: 'paid' },
      ],
    });

    expect(first.value).toBe(second.value);
    expect(first.value).not.toBe(changed.value);
    expect(JSON.stringify(first.canonical)).not.toContain('random-');
    expect(JSON.stringify(first.canonical)).not.toContain('updatedAt');
  });
});
