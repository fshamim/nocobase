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
  if (!asOfDate || !output) {
    throw new Error(
      'Usage: tsx build-greenfield-seed-bundle.ts --as-of YYYY-MM-DD --output PATH [--project-root PATH]',
    );
  }
  const bundle = await buildGreenfieldSeedBundle({ projectRoot, asOfDate });
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
