import { runCloudPreflight } from './preflight.mjs';

process.env.MNEMOSYNE_UPSTREAM_AUTH_MODE ||= 'passthrough';
process.env.MNEMOSYNE_CONTEXT_MODE ||= 'production';
process.env.MNEMOSYNE_HOST ||= '127.0.0.1';
process.env.MNEMOSYNE_PORT ||= '18991';
process.env.MNEMOSYNE_CHAT_SAVE_ROOT ||=
  `${process.env.MNEMOSYNE_STATE_ROOT}/chat-saves`;
runCloudPreflight();
await import('../../companion-launcher.mjs');
