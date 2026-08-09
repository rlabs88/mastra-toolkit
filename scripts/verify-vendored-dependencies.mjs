import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const failures = [];

for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
  if (typeof spec !== 'string' || !spec.startsWith('file:vendor/mastra/')) continue;
  const lockEntry = lock.packages?.[`node_modules/${name}`];
  if (!lockEntry || lockEntry.resolved !== spec) {
    failures.push(`${name}: lockfile does not resolve ${spec}`);
    continue;
  }
  const bytes = readFileSync(resolve(root, spec.slice('file:'.length)));
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (lockEntry.integrity !== integrity) failures.push(`${name}: vendored bytes do not match lockfile integrity`);
}

if (failures.length > 0) {
  throw new Error(`Vendored dependency verification failed:\n${failures.join('\n')}`);
}

console.log('Vendored Mastra artifacts match package-lock.json.');
