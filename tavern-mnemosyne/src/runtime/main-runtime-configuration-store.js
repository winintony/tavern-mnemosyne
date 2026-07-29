import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  createRuntimeConfigurationForProfile,
  runtimeProfileFromConfiguration,
} from './main-runtime-profile-contract.js';

class MainRuntimeConfigurationError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'MainRuntimeConfigurationError';
    this.reasonCode = reasonCode;
  }
}

function invalidConfiguration() {
  return new MainRuntimeConfigurationError(
    'runtime_profile_configuration_invalid',
    'The Mnemosyne runtime configuration is invalid.',
  );
}

function parseConfiguration(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw invalidConfiguration();
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
  ) {
    throw invalidConfiguration();
  }
  return parsed;
}

export function createMainRuntimeConfigurationStore({
  configPath,
  randomId = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (
    typeof configPath !== 'string'
    || !path.isAbsolute(configPath)
    || typeof randomId !== 'function'
  ) {
    throw new TypeError(
      'Main runtime configuration store dependencies are invalid.',
    );
  }
  const directory = path.dirname(configPath);

  function ensureDirectory() {
    mkdirSync(directory, {
      recursive: true,
      mode: 0o700,
    });
  }

  function atomicWrite(source) {
    ensureDirectory();
    const stagedPath = path.join(
      directory,
      `.${path.basename(configPath)}.${randomId()}.tmp`,
    );
    try {
      writeFileSync(stagedPath, source, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(stagedPath, configPath);
    } catch (error) {
      try {
        unlinkSync(stagedPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') {
          error.cleanupError = cleanupError;
        }
      }
      throw error;
    }
  }

  async function snapshotConfiguration() {
    if (!existsSync(configPath)) {
      return Object.freeze({
        schema: 'mnemosyne.runtime-config-snapshot.v1',
        existed: false,
        source: null,
      });
    }
    return Object.freeze({
      schema: 'mnemosyne.runtime-config-snapshot.v1',
      existed: true,
      source: readFileSync(configPath, 'utf8'),
    });
  }

  async function stageProfile(profile) {
    const config = createRuntimeConfigurationForProfile(profile);
    atomicWrite(`${JSON.stringify(config, null, 2)}\n`);
  }

  async function restoreConfiguration(snapshot) {
    if (
      snapshot?.schema
        !== 'mnemosyne.runtime-config-snapshot.v1'
      || typeof snapshot.existed !== 'boolean'
      || (
        snapshot.existed
        && typeof snapshot.source !== 'string'
      )
      || (
        !snapshot.existed
        && snapshot.source !== null
      )
    ) {
      throw new MainRuntimeConfigurationError(
        'runtime_profile_configuration_snapshot_invalid',
        'The runtime configuration snapshot is invalid.',
      );
    }
    if (snapshot.existed) {
      atomicWrite(snapshot.source);
      return;
    }
    try {
      unlinkSync(configPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function readProfile() {
    if (!existsSync(configPath)) return null;
    const parsed = parseConfiguration(
      readFileSync(configPath, 'utf8'),
    );
    if (
      parsed.schema !== 'mnemosyne.runtime-config.v2'
      || !parsed.mainRuntimeProfile
    ) {
      return null;
    }
    return runtimeProfileFromConfiguration(parsed);
  }

  return Object.freeze({
    ensureDirectory,
    exists: () => existsSync(configPath),
    readProfile,
    restoreConfiguration,
    snapshotConfiguration,
    stageProfile,
  });
}
