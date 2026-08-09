import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const forkRoot = resolve(process.argv[2] ?? '../../upstreams/mastra');
const factoryForkRoot = resolve(process.env.MASTRA_FACTORY_FORK_ROOT ?? '../../upstreams/mastra-factory-0.5.0');
const outputRoot = resolve('vendor/mastra');
const requestedPackages = new Set(process.argv.slice(3));
const packages = [
  ['packages/core', '1.58.0', '2'],
  ['client-sdks/client-js', '1.39.0', '3'],
  ['packages/server', '1.58.0', '3'],
  ['observability/mastra', '1.16.6', '2'],
  ['mastracode/sdk', '1.2.0', '2'],
  ['mastracode/tui', '0.33.0', '6'],
  ['packages/deployer', '1.58.0-alpha.8', '4'],
  [
    'packages/server-adapters/hono',
    '1.6.0-alpha.8-rlabs.mz.2',
    '2',
    forkRoot,
    undefined,
    'mastra-hono-1.6.0-alpha.8-rlabs.mz.2.tgz',
  ],
  ['.', '0.5.0-rlabs.mz.2', '2', factoryForkRoot, 'factory', 'mastra-factory-0.5.0-rlabs.mz.2.tgz'],
].filter(([relativePath, , , , alias]) => requestedPackages.size === 0 || requestedPackages.has(alias ?? relativePath));
const canonicalVersions = {
  '@mastra/client-js': '1.39.0',
  '@mastra/code-sdk': '1.2.0',
  '@mastra/core': '1.58.0',
  '@mastra/deployer': '1.58.0-alpha.8',
  '@mastra/factory': '0.5.0-rlabs.mz.2',
  '@mastra/hono': '1.6.0-alpha.8-rlabs.mz.2',
  '@mastra/observability': '1.16.6',
  '@mastra/server': '1.58.0',
  mastracode: '0.33.0',
};

mkdirSync(outputRoot, { recursive: true });

for (const [relativePath, version, revision, sourceRoot = forkRoot, , outputName] of packages) {
  const scratch = mkdtempSync(join(tmpdir(), 'mastra-fork-pack-'));
  try {
    const sourcePath = join(sourceRoot, relativePath);
    if (relativePath === 'mastracode/tui') {
      execFileSync('corepack', ['pnpm', 'build:lib'], {
        cwd: sourcePath,
        stdio: 'inherit',
      });
    }
    const packedName = execFileSync('corepack', ['pnpm', 'pack', '--pack-destination', scratch], {
      cwd: sourcePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim().split('\n').at(-1);
    const packedPath = resolve(sourcePath, packedName);
    execFileSync('tar', ['-xzf', packedPath, '-C', scratch]);

    const manifestPath = join(scratch, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      if (!manifest[field]) continue;
      for (const [name, canonicalVersion] of Object.entries(canonicalVersions)) {
        if (name in manifest[field]) manifest[field][name] = canonicalVersion;
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const npmPackedName = execFileSync('npm', ['pack', join(scratch, 'package'), '--pack-destination', scratch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim().split('\n').at(-1);
    const stem = basename(npmPackedName, '.tgz');
    renameSync(join(scratch, npmPackedName), join(outputRoot, outputName ?? `${stem}-rlabs.mz.${revision}.tgz`));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
