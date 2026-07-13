import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildGreenfieldSeedBundle,
  greenfieldSeedBundleManifest,
} from '../src/features/source-import/server/greenfield-seed-bundle';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const asOfDate = argument('--as-of');
  const output = argument('--output');
  const projectRoot = argument('--project-root') ?? path.resolve(process.cwd(), '..');
  const profile = argument('--profile') ?? 'complete';
  if (!asOfDate || !output) {
    throw new Error(
      'Usage: tsx build-greenfield-seed-bundle.ts --as-of YYYY-MM-DD --output PATH [--project-root PATH] [--profile complete|staging-fast-clickup]',
    );
  }
  if (profile !== 'complete' && profile !== 'staging-fast-clickup') {
    throw new Error(`Ecobase greenfield seed bundle failed: unsupported profile ${profile}.`);
  }
  const bundle = await buildGreenfieldSeedBundle({ projectRoot, asOfDate, profile });
  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(greenfieldSeedBundleManifest(bundle), null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ output: outputPath, bundleChecksum: bundle.bundleChecksum, groups: bundle.groups.length })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
