import { createHash } from 'node:crypto';
import {
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const COMPATIBILITY_FILES = Object.freeze([
  Object.freeze({
    relativePath:
      'public/scripts/autocomplete/MacroAutoCompleteHelper.js',
    originalSha256:
      '1290d8362e21cee619eb8b70a01b44896dfbae7f7994b2642c047d888247a89c',
    patchedSha256:
      'aa5f782312c836193ac46660e4c61c03dd8f9ca0afeb732331be2706706d307f',
    replacements: Object.freeze([
      Object.freeze({
        before:
          "import { onboardingExperimentalMacroEngine } from '../macros/engine/MacroDiagnostics.js';\n"
          + "import { chat_metadata } from '/script.js';\n"
          + "import { extension_settings } from '../extensions.js';",
        after:
          "import { onboardingExperimentalMacroEngine } from '../macros/engine/MacroDiagnostics.js';",
      }),
      Object.freeze({
        before:
          '        // Import chat_metadata and extension_settings dynamically to avoid circular deps\n'
          + '        // These are the same sources used by commonEnumProviders.variables\n'
          + "        if (scope === 'local') {\n"
          + '            // Local variables are in chat_metadata.variables\n'
          + '            return Object.keys(chat_metadata?.variables ?? {});\n'
          + '        } else {\n'
          + '            // Global variables are in extension_settings.variables.global\n'
          + '            return Object.keys(extension_settings?.variables?.global ?? {});\n'
          + '        }',
        after:
          '        // Resolve initialized application state lazily to avoid importing the\n'
          + '        // script.js -> extensions.js -> st-context.js cycle into this module.\n'
          + '        const context = globalThis.SillyTavern?.getContext?.();\n'
          + "        if (scope === 'local') {\n"
          + '            return Object.keys(context?.chatMetadata?.variables ?? {});\n'
          + '        } else {\n'
          + '            return Object.keys(\n'
          + '                context?.extensionSettings?.variables?.global ?? {},\n'
          + '            );\n'
          + '        }',
      }),
    ]),
  }),
  Object.freeze({
    relativePath: 'public/scripts/i18n.js',
    originalSha256:
      'ba05c8722f1a67e611f3864398f42ad7791deddf95af41756f6341238023762b',
    patchedSha256:
      'd5c12af3744845957b6767838c96669444f9097b628277bc22fb1b12dce9fbc0',
    replacements: Object.freeze([
      Object.freeze({
        before:
          "import { registerDebugFunction } from './power-user.js';\n"
          + "import { updateSecretDisplay } from './secrets.js';",
        after: "import { updateSecretDisplay } from './secrets.js';",
      }),
      Object.freeze({
        before: 'export async function initLocales() {\n'
          + "    langs = await fetch('/locales/lang.json').then(response => response.json());",
        after: 'export async function initLocales() {\n'
          + "    const { registerDebugFunction } = await import('./power-user.js');\n"
          + "    langs = await fetch('/locales/lang.json').then(response => response.json());",
      }),
    ]),
  }),
  Object.freeze({
    relativePath: 'public/scripts/power-user.js',
    originalSha256:
      '2e082dc9c67f802072e7c42eed0a48b98d273f39b32749c774fab862115481e0',
    patchedSha256:
      'ded3b7d1ca6175b38edcf09c8b03afcb591256d0e805be41a71c3a4588406b25',
    replacements: Object.freeze([
      Object.freeze({
        before:
          "const defaultToastPosition = 'toast-top-center';\n\n"
          + 'const avatar_styles = {',
        after:
          "const defaultToastPosition = 'toast-top-center';\n"
          + 'const defaultStoryStringPosition = 0;\n'
          + 'const defaultStoryStringRole = 0;\n\n'
          + 'const avatar_styles = {',
      }),
      Object.freeze({
        before:
          '        story_string_position: extension_prompt_types.IN_PROMPT,\n'
          + '        story_string_role: extension_prompt_roles.SYSTEM,',
        after:
          '        story_string_position: defaultStoryStringPosition,\n'
          + '        story_string_role: defaultStoryStringRole,',
      }),
      Object.freeze({
        before:
          "    { id: 'context_story_string_position', property: 'story_string_position', isCheckbox: false, isGlobalSetting: false, defaultValue: extension_prompt_types.IN_PROMPT, trigger: true },",
        after:
          "    { id: 'context_story_string_position', property: 'story_string_position', isCheckbox: false, isGlobalSetting: false, defaultValue: defaultStoryStringPosition, trigger: true },",
      }),
      Object.freeze({
        before:
          "    { id: 'context_story_string_role', property: 'story_string_role', isCheckbox: false, isGlobalSetting: false, defaultValue: extension_prompt_roles.SYSTEM },",
        after:
          "    { id: 'context_story_string_role', property: 'story_string_role', isCheckbox: false, isGlobalSetting: false, defaultValue: defaultStoryStringRole },",
      }),
    ]),
  }),
]);

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function replaceExactlyOnce(source, { before, after }, relativePath) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(
      `${relativePath}: compatibility replacement must match exactly once`,
    );
  }
  return `${source.slice(0, first)}${after}${source.slice(
    first + before.length,
  )}`;
}

export async function applySillyTavern118Compatibility({
  appRoot,
  files = COMPATIBILITY_FILES,
} = {}) {
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) {
    throw new Error('appRoot must be an absolute SillyTavern directory');
  }
  const results = [];
  for (const entry of files) {
    const absolutePath = path.join(appRoot, entry.relativePath);
    const source = await readFile(absolutePath, 'utf8');
    const currentHash = sha256(source);
    if (currentHash === entry.patchedSha256) {
      results.push({
        path: entry.relativePath,
        status: 'already_patched',
        sha256: currentHash,
      });
      continue;
    }
    if (currentHash !== entry.originalSha256) {
      throw new Error(
        `${entry.relativePath}: expected SillyTavern 1.18.0 hash `
        + `${entry.originalSha256}, received ${currentHash}`,
      );
    }
    const patched = entry.replacements.reduce(
      (value, replacement) => replaceExactlyOnce(
        value,
        replacement,
        entry.relativePath,
      ),
      source,
    );
    const patchedHash = sha256(patched);
    if (patchedHash !== entry.patchedSha256) {
      throw new Error(
        `${entry.relativePath}: patched hash ${patchedHash} does not match `
        + entry.patchedSha256,
      );
    }
    const temporaryPath = `${absolutePath}.mnemosyne-compat`;
    await writeFile(temporaryPath, patched, 'utf8');
    await rename(temporaryPath, absolutePath);
    results.push({
      path: entry.relativePath,
      status: 'patched',
      sha256: patchedHash,
    });
  }
  return Object.freeze({
    schema: 'mnemosyne.sillytavern-compatibility.v1',
    sillytavern_version: '1.18.0',
    results: Object.freeze(results),
  });
}

async function main() {
  const result = await applySillyTavern118Compatibility({
    appRoot: process.argv[2],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
