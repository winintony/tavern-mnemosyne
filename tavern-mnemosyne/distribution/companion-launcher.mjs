import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundleRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = existsSync(path.join(bundleRoot, 'src'))
  ? bundleRoot
  : path.dirname(bundleRoot);
const stateRoot = path.resolve(
  process.env.MNEMOSYNE_STATE_ROOT
  || path.join(bundleRoot, 'data'),
);
const legacyConfigPath = path.join(
  bundleRoot,
  'companion.config.json',
);
const configPath = path.resolve(
  process.env.MNEMOSYNE_CONFIG_PATH
  || (
    existsSync(legacyConfigPath)
      ? legacyConfigPath
      : path.join(stateRoot, 'config', 'runtime.json')
  ),
);
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8'))
  : {};
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('Mnemosyne runtime configuration must be a JSON object.');
}
const environmentMap = Object.freeze({
  host: 'MNEMOSYNE_HOST',
  port: 'MNEMOSYNE_PORT',
  upstreamBaseUrl: 'MNEMOSYNE_UPSTREAM_BASE_URL',
  upstreamApiKey: 'MNEMOSYNE_UPSTREAM_API_KEY',
  upstreamModel: 'MNEMOSYNE_UPSTREAM_MODEL',
  upstreamAuthMode: 'MNEMOSYNE_UPSTREAM_AUTH_MODE',
  upstreamHeaders: 'MNEMOSYNE_UPSTREAM_HEADERS',
  providerContextTokens: 'MNEMOSYNE_PROVIDER_CONTEXT_TOKENS',
  providerOutputReserveTokens:
    'MNEMOSYNE_PROVIDER_OUTPUT_RESERVE_TOKENS',
  proxyToken: 'MNEMOSYNE_PROXY_TOKEN',
  contextMode: 'MNEMOSYNE_CONTEXT_MODE',
  contextAccessToken: 'MNEMOSYNE_CONTEXT_ACCESS_TOKEN',
  chatSaveRoot: 'MNEMOSYNE_CHAT_SAVE_ROOT',
});

for (const [key, environmentName] of Object.entries(environmentMap)) {
  const value = config[key];
  if (value === undefined || value === null || value === '') continue;
  process.env[environmentName] ??= (
    typeof value === 'object' ? JSON.stringify(value) : String(value)
  );
}

process.env.MNEMOSYNE_HOST ||= '127.0.0.1';
process.env.MNEMOSYNE_PORT ||= '18991';
process.env.MNEMOSYNE_CONTEXT_MODE ||= 'production';
process.env.MNEMOSYNE_STATE_ROOT ||= stateRoot;
process.env.MNEMOSYNE_CHAT_SAVE_ROOT ||= path.join(
  stateRoot,
  'chat-saves',
);
mkdirSync(process.env.MNEMOSYNE_CHAT_SAVE_ROOT, { recursive: true });

await import(pathToFileURL(
  path.join(sourceRoot, 'src', 'proxy', 'cli.js'),
));
