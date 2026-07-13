/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGreenfieldSeedBundle,
  GREENFIELD_SEED_SOURCE_SPECS,
  STAGING_FAST_CLICKUP_SOURCE_SPECS,
  greenfieldSeedBundleManifest,
} from '../../features/source-import/server/greenfield-seed-bundle';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function syntheticProjectRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'ecobase-greenfield-bundle-'));
  roots.push(root);
  for (const spec of GREENFIELD_SEED_SOURCE_SPECS) {
    for (const relativePath of spec.paths) {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      const content =
        spec.delimiter === ';'
          ? 'Company;ASIN;SKU\n"Ecofission LLC";"B000000001";"SKU-1"\n'
          : 'Company,ASIN,SKU\nEcofission LLC,B000000001,SKU-1\n';
      await writeFile(filePath, content);
    }
  }
  return root;
}

describe('greenfield seed bundle', () => {
  it('builds the complete source inventory deterministically without embedding content in the manifest', async () => {
    const projectRoot = await syntheticProjectRoot();
    const first = await buildGreenfieldSeedBundle({ projectRoot, asOfDate: '2026-07-13' });
    const second = await buildGreenfieldSeedBundle({ projectRoot, asOfDate: '2026-07-13' });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      profileVersion: '2026-07-13.1',
      asOfDate: '2026-07-13',
      sourceVersion: '2026-07-13T00:00:00.000Z',
      bundleChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.groups).toHaveLength(11);
    expect(first.groups.flatMap((group) => group.files)).toHaveLength(13);
    expect(first.groups.some((group) => group.id === 'amazon-operations')).toBe(false);
    expect(first.groups.find((group) => group.id === 'order-management')?.files.map((file) => file.name)).toEqual([
      'Ecofission-Order Management - Purchase Orders.csv',
      'Ecofission-Order Management - OrderDetails.csv',
    ]);
    expect(new Set(first.groups.flatMap((group) => group.files.map((file) => file.path))).size).toBe(13);
    expect(first.groups.every((group) => group.files.every((file) => file.rowCount === 1))).toBe(true);

    const manifest = greenfieldSeedBundleManifest(first);
    expect(JSON.stringify(manifest)).not.toContain('B000000001');
    expect(first.groups.map((group) => group.id)).toEqual([...first.groups.map((group) => group.id)].sort());
  });

  it('builds staging-fast-clickup from only the five retained-order inputs', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'ecobase-staging-fast-bundle-'));
    roots.push(projectRoot);
    for (const spec of STAGING_FAST_CLICKUP_SOURCE_SPECS) {
      for (const relativePath of spec.paths) {
        const filePath = path.join(projectRoot, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'Company,ASIN,SKU\nEcofission LLC,B000000001,SKU-1\n');
      }
    }

    const bundle = await buildGreenfieldSeedBundle({
      projectRoot,
      asOfDate: '2026-07-13',
      profile: 'staging-fast-clickup',
    });

    expect(bundle.profile).toBe('staging-fast-clickup');
    expect(bundle.groups.map((group) => group.id)).toEqual([
      'clickup-order-status',
      'order-management',
      'supplier-management',
    ]);
    expect(bundle.groups.flatMap((group) => group.files)).toHaveLength(5);
    expect(JSON.stringify(greenfieldSeedBundleManifest(bundle))).not.toMatch(/sellerboard-history|data\/history/i);
    await expect(
      buildGreenfieldSeedBundle({
        projectRoot,
        asOfDate: '2026-07-13',
        profile: 'staging-fast-clickup',
        specs: STAGING_FAST_CLICKUP_SOURCE_SPECS,
      }),
    ).rejects.toThrow('staging-fast-clickup source specs cannot be overridden');
  });

  it('fails on duplicate source paths and invalid as-of dates', async () => {
    const projectRoot = await syntheticProjectRoot();
    await expect(
      buildGreenfieldSeedBundle({
        projectRoot,
        asOfDate: '2026-07-13',
        specs: [GREENFIELD_SEED_SOURCE_SPECS[0], GREENFIELD_SEED_SOURCE_SPECS[0]],
      }),
    ).rejects.toThrow('duplicate source path');
    await expect(buildGreenfieldSeedBundle({ projectRoot, asOfDate: '13-07-2026' })).rejects.toThrow(
      'must be YYYY-MM-DD',
    );
  });
});
