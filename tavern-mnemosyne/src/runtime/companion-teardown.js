import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

// Uninstalling the extension card used to leave the whole companion behind:
// the server plugin, the installed runtime, the binding and the install
// receipts. The next install then met its own wreckage and failed, which is
// what the pile of install/failure-*.json records. Removal is cascaded here,
// and it stops at the user's data: chat saves and everything derived from
// them are the one thing an uninstall must never take with it.
export const COMPANION_TEARDOWN_TARGETS = Object.freeze([
  'data/_mnemosyne/runtime',
  'data/_mnemosyne/config',
  'data/_mnemosyne/install',
  'plugins/tavern-mnemosyne/binding.json',
]);
export const COMPANION_PRESERVED_PATHS = Object.freeze([
  'data/_mnemosyne/chat-saves',
]);
export const COMPANION_PLUGIN_ROOT = 'plugins/tavern-mnemosyne';
export const COMPANION_REMOVAL_SENTINEL =
  'plugins/tavern-mnemosyne/uninstall-pending.json';
export const COMPANION_EXTENSION_CODE_ROOTS = Object.freeze([
  'data/default-user/extensions/tavern-mnemosyne',
  'public/scripts/extensions/third-party/tavern-mnemosyne',
]);

const SENTINEL_SCHEMA = 'mnemosyne.companion-uninstall-pending.v1';

function resolveWithin(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Companion teardown refused a path outside the install root: ${relativePath}.`,
    );
  }
  return resolved;
}

export function companionExtensionInstalled({
  rootDir,
  codeRoots = COMPANION_EXTENSION_CODE_ROOTS,
}) {
  return codeRoots.some(relativePath => existsSync(
    resolveWithin(rootDir, relativePath),
  ));
}

export async function runCompanionTeardown({
  rootDir,
  stopCompanion = async () => {},
  now = () => new Date(),
  reason = 'extension_uninstalled',
}) {
  const preservedBefore = COMPANION_PRESERVED_PATHS.filter(
    relativePath => existsSync(resolveWithin(rootDir, relativePath)),
  );
  await stopCompanion();
  const removed = [];
  for (const relativePath of COMPANION_TEARDOWN_TARGETS) {
    const target = resolveWithin(rootDir, relativePath);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(relativePath);
  }
  // The plugin cannot delete the directory it is running from and still be
  // there to finish the job, so it leaves a note the next start acts on.
  const sentinelPath = resolveWithin(rootDir, COMPANION_REMOVAL_SENTINEL);
  mkdirSync(path.dirname(sentinelPath), { recursive: true });
  writeFileSync(
    sentinelPath,
    `${JSON.stringify({
      schema: SENTINEL_SCHEMA,
      reason,
      requested_at: now().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  );
  const preservedAfter = preservedBefore.filter(
    relativePath => existsSync(resolveWithin(rootDir, relativePath)),
  );
  if (preservedAfter.length !== preservedBefore.length) {
    throw new Error('Companion teardown removed preserved user data.');
  }
  return Object.freeze({
    schema: 'mnemosyne.companion-teardown-result.v1',
    removed,
    preserved: preservedBefore,
    sentinel: COMPANION_REMOVAL_SENTINEL,
  });
}

export function completePendingCompanionRemoval({
  rootDir,
  codeRoots = COMPANION_EXTENSION_CODE_ROOTS,
}) {
  const sentinelPath = resolveWithin(rootDir, COMPANION_REMOVAL_SENTINEL);
  if (!existsSync(sentinelPath)) {
    return Object.freeze({ status: 'not_pending', removed: false });
  }
  let sentinel;
  try {
    sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'));
  } catch {
    sentinel = null;
  }
  if (sentinel?.schema !== SENTINEL_SCHEMA) {
    return Object.freeze({ status: 'not_pending', removed: false });
  }
  // The extension came back before this ran, so the uninstall was undone by
  // a reinstall and the plugin has to stay.
  if (companionExtensionInstalled({ rootDir, codeRoots })) {
    rmSync(sentinelPath, { force: true });
    return Object.freeze({ status: 'reinstalled', removed: false });
  }
  rmSync(resolveWithin(rootDir, COMPANION_PLUGIN_ROOT), {
    recursive: true,
    force: true,
  });
  return Object.freeze({ status: 'removed', removed: true });
}
