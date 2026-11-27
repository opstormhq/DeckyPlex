import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory = '.', tag] = process.argv.slice(2);
const readJson = filename => JSON.parse(readFileSync(join(directory, filename), 'utf8'));

try {
  const { version } = readJson('package.json');
  const lockfile = readJson('package-lock.json');
  const manifest = readJson('.release-please-manifest.json');

  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('package.json must contain a stable release version.');
  }

  const versions = [
    ['package-lock.json version', lockfile.version],
    ['package-lock.json root package version', lockfile.packages?.['']?.version],
    ['.release-please-manifest.json root version', manifest['.']],
  ];
  for (const [label, fileVersion] of versions) {
    if (fileVersion !== version) {
      throw new Error(`${label} must match package.json (${version}).`);
    }
  }

  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`The release tag must match the version in package.json (v${version}).`);
  }

  console.log(`Release version files agree on ${version}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
