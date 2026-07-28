import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PATH_COMPONENTS = new Set([
  '.git',
  '.scratch',
  '.agents',
  '.codex',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'MEMORY.md',
  'backups',
  'docs',
  'fixtures',
  'test-results',
  'tests',
  'worktrees',
]);

const ALLOWED_TOP_LEVEL = new Set([
  '.dockerignore',
  '.github',
  '.gitignore',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'manifest.json',
  'package.json',
  'tavern-mnemosyne',
]);

const FORBIDDEN_ARCHIVE_SUFFIXES = [
  '.tar',
  '.tar.gz',
  '.tgz',
  '.zip',
  '.7z',
  '.dmg',
  '.exe',
  '.msi',
];

const SECRET_LIKE_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const PRIVATE_WORKSPACE_PATTERNS = [
  /(?:^|[\s"'=(])\/Users\/[^/\s"']+/,
  /(?:^|[\s"'=(])\/home\/(?!node(?:\/|\b))[^/\s"']+/,
  /[A-Za-z]:\\Users\\[^\\\s"']+/,
  /LocalVaults/,
  /\.scratch/,
  /replit\.dev/,
  /codex@localhost/,
  /winintony@yahoo\.com/,
  /个人助手/,
  /剧情创作质量优化第三阶段/,
  /VISION-CODE-ALIGNMENT-AUDIT\.md/,
  /PROMPT-FIDELITY-EVIDENCE\.md/,
];

const REQUIRED_RELEASE_FILES = [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'manifest.json',
  'package.json',
];

const RELEASE_POLICY_FILES = new Set([
  '.github/verify-public-release.mjs',
]);

async function publicFiles(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      if (!prefix && name === '.git') continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const metadata = await lstat(path.join(directory, name));
      if (metadata.isDirectory()) {
        await walk(path.join(directory, name), relative);
      } else if (metadata.isFile()) {
        files.push(relative);
      } else {
        throw new Error(`Unsupported release path type: ${relative}`);
      }
    }
  }
  await walk(root);
  return files;
}

export async function auditPublicRelease(root) {
  const resolvedRoot = path.resolve(root);
  const files = await publicFiles(resolvedRoot);
  const fileSet = new Set(files);
  for (const required of REQUIRED_RELEASE_FILES) {
    if (!fileSet.has(required)) {
      throw new Error(`Required release file is missing: ${required}.`);
    }
  }
  for (const relative of files) {
    const components = relative.split('/');
    if (!ALLOWED_TOP_LEVEL.has(components[0])) {
      throw new Error(`Forbidden top-level release path: ${relative}.`);
    }
    if (relative === 'tavern-mnemosyne/README.md') {
      throw new Error(
        'The developer workspace README must not be published.',
      );
    }
    const forbidden = components.find(component => (
      FORBIDDEN_PATH_COMPONENTS.has(component)
    ));
    if (forbidden) {
      throw new Error(
        `Forbidden release path ${relative} contains ${forbidden}.`,
      );
    }
    if (FORBIDDEN_ARCHIVE_SUFFIXES.some(suffix => (
      relative.toLowerCase().endsWith(suffix)
    ))) {
      throw new Error(
        `Binary release asset must not be committed: ${relative}.`,
      );
    }
    if (SECRET_LIKE_PATTERNS.some(pattern => pattern.test(relative))) {
      throw new Error(`Secret-like release path found: ${relative}.`);
    }
    if (PRIVATE_WORKSPACE_PATTERNS.some(pattern => (
      pattern.test(relative)
    ))) {
      throw new Error(`Private workspace path found: ${relative}.`);
    }
    if (RELEASE_POLICY_FILES.has(relative)) continue;
    const content = await readFile(path.join(resolvedRoot, relative));
    if (content.includes(0)) {
      throw new Error(
        `Binary content must not be committed: ${relative}.`,
      );
    }
    const text = content.toString('utf8');
    if (SECRET_LIKE_PATTERNS.some(pattern => pattern.test(text))) {
      throw new Error(`Secret-like content found in ${relative}.`);
    }
    if (PRIVATE_WORKSPACE_PATTERNS.some(pattern => pattern.test(text))) {
      throw new Error(`Private workspace content found in ${relative}.`);
    }
  }
  return Object.freeze({ files: Object.freeze(files) });
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.argv[2] ?? process.cwd();
  const result = await auditPublicRelease(root);
  process.stdout.write(
    `PUBLIC RELEASE AUDIT PASSED (${result.files.length} files)\n`,
  );
}
