import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputRoot = path.join(
  packageRoot,
  'distribution',
  'runtime-bundle',
);
const EXCLUDED_RUNTIME_BASENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);
const EXCLUDED_RUNTIME_PATHS = new Set([
  'node_modules/.package-lock.json',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function walk(directory, prefix) {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = path.join(directory, name);
    const relative = `${prefix}/${name}`;
    if (
      EXCLUDED_RUNTIME_BASENAMES.has(name)
      || EXCLUDED_RUNTIME_PATHS.has(relative)
    ) {
      continue;
    }
    const metadata = await stat(absolute);
    if (metadata.isDirectory()) {
      entries.push(...await walk(absolute, relative));
    } else if (metadata.isFile()) {
      entries.push({
        archivePath: relative,
        absolute,
        mode: 0o644,
      });
    } else {
      throw new Error(`Unsupported runtime bundle entry: ${relative}`);
    }
  }
  return entries;
}

function writeText(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new Error(`Tar field is too long: ${value}`);
  }
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeText(buffer, offset, length, `${encoded}\0`);
}

function tarEntry(name, content, mode) {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`Runtime bundle path is too long: ${name}`);
  }
  const header = Buffer.alloc(512);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, mode || 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  writeText(header, 265, 32, 'node');
  writeText(header, 297, 32, 'node');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(
    header,
    148,
    8,
    `${checksum.toString(8).padStart(6, '0')}\0 `,
  );
  const padding = Buffer.alloc(
    (512 - (content.length % 512)) % 512,
  );
  return Buffer.concat([header, content, padding]);
}

const packageJson = JSON.parse(await readFile(
  path.join(packageRoot, 'package.json'),
  'utf8',
));
const inputEntries = [
  ...(await walk(path.join(packageRoot, 'src'), 'src')),
  ...(await walk(
    path.join(packageRoot, 'node_modules'),
    'node_modules',
  )),
  {
    archivePath: 'package.json',
    absolute: path.join(packageRoot, 'package.json'),
    mode: 0o644,
  },
  {
    archivePath: 'package-lock.json',
    absolute: path.join(packageRoot, 'package-lock.json'),
    mode: 0o644,
  },
  {
    archivePath: 'companion-launcher.mjs',
    absolute: path.join(
      packageRoot,
      'distribution',
      'companion-launcher.mjs',
    ),
    mode: 0o644,
  },
  {
    archivePath: 'distribution/server-plugin/index.mjs',
    absolute: path.join(
      packageRoot,
      'distribution',
      'server-plugin',
      'index.mjs',
    ),
    mode: 0o644,
  },
].sort((left, right) => (
  left.archivePath < right.archivePath
    ? -1
    : (left.archivePath > right.archivePath ? 1 : 0)
));

const fileRecords = [];
const tarParts = [];
for (const entry of inputEntries) {
  const content = await readFile(entry.absolute);
  fileRecords.push({
    path: entry.archivePath,
    sha256: sha256(content),
    bytes: content.length,
  });
  tarParts.push(tarEntry(entry.archivePath, content, entry.mode));
}
tarParts.push(Buffer.alloc(1024));
const contentManifestHash = sha256(JSON.stringify(fileRecords));
const archive = gzipSync(Buffer.concat(tarParts), {
  // Level zero emits stored DEFLATE blocks. Unlike optimized compression,
  // that byte stream does not depend on the host zlib implementation, so a
  // macOS maintainer and Linux CI produce the same Release asset.
  level: 0,
  mtime: 0,
});
// RFC 1952 byte 9 is an informational OS marker. Normalizing it keeps the
// workspace bundle byte-identical when maintainers build on macOS and CI
// rebuilds on Linux.
archive[9] = 0xff;
const manifest = {
  schema: 'mnemosyne.self-contained-runtime-bundle.v1',
  runtime_build_id:
    `tavern-mnemosyne@${packageJson.version}`
    + `+runtime.${contentManifestHash.slice(0, 16)}`,
  package_version: packageJson.version,
  minimum_node_major: 22,
  entrypoint: 'companion-launcher.mjs',
  archive: 'runtime.tar.gz',
  archive_sha256: sha256(archive),
  archive_bytes: archive.length,
  release_asset: {
    repository: 'winintony/tavern-mnemosyne',
    tag: `v${packageJson.version}`,
    name:
      `Tavern-Mnemosyne-Runtime-v${packageJson.version}.tar.gz`,
  },
  content_manifest_sha256: contentManifestHash,
  files: fileRecords,
};
await mkdir(outputRoot, { recursive: true });
await writeFile(
  path.join(outputRoot, 'runtime.tar.gz'),
  archive,
);
await writeFile(
  path.join(outputRoot, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
process.stdout.write(
  `${manifest.runtime_build_id} ${manifest.archive_sha256}\n`,
);
