#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../contracts/hash.js';
import {
  createContinuityEvaluationProgram,
} from '../evaluation/continuity-evaluation-program.js';
import {
  createStaticLoreExtractionService,
  DEFAULT_STATIC_LORE_MAX_INPUT_BYTES,
  DEFAULT_STATIC_LORE_MAX_OUTPUT_TOKENS,
} from '../intake/static-lore-extraction-service.js';
import { createStaticLoreIntake } from '../intake/static-lore-intake.js';
import { createRunJournal } from '../harness/run-journal.js';
import { createRunKernel } from '../harness/run-kernel.js';
import {
  createHistoryLifecycleService,
} from '../host/history-lifecycle-service.js';
import {
  createUserVisibleRunActivity,
} from '../inspection/user-visible-run-activity.js';
import {
  createDormantThreadInspection,
} from '../inspection/dormant-thread-inspection.js';
import {
  createLiveRunActivity,
} from '../inspection/live-run-activity.js';
import {
  normalizeStoryCraftConfig,
} from '../craft/story-craft-config.js';
import { loadPhraseLexicon } from '../craft/phrase-lexicon.js';
import {
  createQualityTelemetryPass,
} from '../craft/quality-telemetry-pass.js';
import { createSlopDetector } from '../craft/slop-detection.js';
import {
  createContinuityRulesPass,
} from '../craft/continuity-rule-auditor.js';
import {
  createDynamicStoryProjector,
} from '../history/dynamic-story-projector.js';
import { createStateHistory } from '../history/state-history.js';
import { createMemoryReader } from '../memory/memory-reader.js';
import {
  DEFAULT_MAX_MEMORY_READ_TOKENS,
} from '../memory/bounded-memory-read.js';
import { createContinuityComposer } from '../runtime/continuity-composer.js';
import {
  createChatWriteCoordinator,
} from '../runtime/chat-write-coordinator.js';
import {
  createProductionSourceCoverageRuntime,
} from '../runtime/source-coverage-runtime.js';
import {
  resolveRuntimeBuildIdentity,
} from '../runtime/runtime-build-identity.js';
import {
  loadFreshIntakeAdmissionGuard,
} from '../runtime/fresh-intake-admission.js';
import { createChatSaveStore } from '../storage/chat-save-store.js';
import {
  probeSqliteWalRuntime,
  sqliteWalRuntimePolicyFromHarness,
} from '../storage/sqlite-wal-runtime-safety.js';
import { createOpenAiToolProvider } from './openai-tool-provider.js';
import {
  adaptOpenAiCompatibleRequest,
} from './provider-request-compatibility.js';
import {
  countOpenAiTokens,
  createProviderBudgetPolicy,
} from './provider-step-budget.js';
import {
  createGrantBackedStorySourceAdmission,
} from './production-story-source-admission.js';
import {
  createMnemosyneProxy,
  createRuntimeBudgetProfile,
} from './server.js';

const DEFAULT_ROOT_MAX_TOOL_STEPS = 8;
const DEFAULT_ROOT_RUN_OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const PACKAGE_VERSION = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)).version;
const PACKAGE_ROOT = fileURLToPath(
  new URL('../../', import.meta.url),
);

function runtimeBuildIdentity() {
  return resolveRuntimeBuildIdentity({
    configuredBuildId:
      process.env.MNEMOSYNE_RUNTIME_BUILD_ID,
    packageVersion: PACKAGE_VERSION,
    packageRoot: PACKAGE_ROOT,
  });
}

function parseInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parseHeaders(value) {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MNEMOSYNE_UPSTREAM_HEADERS must be a JSON object.');
  }
  return parsed;
}

function parseDuration(value) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout duration: ${value}`);
  }
  return parsed;
}

function parseToolStepBudget(value) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2) {
    throw new Error(
      `Invalid root tool-step budget: ${value}; expected a safe integer of at least 2.`,
    );
  }
  return parsed;
}

function parseRequiredSafeTokenCount(value, field) {
  if (value === undefined || value === '') {
    throw new Error(`${field} is required when an upstream is configured.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return parsed;
}

function parseMemoryReadTokenBudget(value) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `Invalid memory read token budget: ${value}; expected a positive safe integer.`,
    );
  }
  return parsed;
}

function parseOptionalSafeTokenCount(value, field) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return parsed;
}

function defaultMaxRequestBodyBytes(staticLoreMaxInputBytes) {
  const doubled = staticLoreMaxInputBytes
    > Number.MAX_SAFE_INTEGER / 2
    ? Number.MAX_SAFE_INTEGER
    : staticLoreMaxInputBytes * 2;
  return Math.max(DEFAULT_MAX_REQUEST_BODY_BYTES, doubled);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseSqliteRuntimeContext(value) {
  if (value !== undefined && value !== '') {
    throw new Error(
      'The production CLI does not accept a SQLite runtime safety override.',
    );
  }
  return sqliteWalRuntimePolicyFromHarness().context;
}

function parseAuditExcludedPhrases(value) {
  if (value === undefined || value === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'MNEMOSYNE_AUDIT_EXCLUDED_PHRASES_JSON must be valid JSON.',
    );
  }
  if (
    !Array.isArray(parsed)
    || parsed.length > 16
    || parsed.some(phrase => (
      typeof phrase !== 'string'
      || phrase !== phrase.trim()
      || phrase.length === 0
      || phrase.length > 256
      || /[\r\n]/.test(phrase)
    ))
    || new Set(parsed).size !== parsed.length
  ) {
    throw new Error(
      'MNEMOSYNE_AUDIT_EXCLUDED_PHRASES_JSON must contain unique compact strings.',
    );
  }
  return parsed;
}

function parseRootRunAuditBinding(value) {
  if (value === undefined || value === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'MNEMOSYNE_ROOT_RUN_AUDIT_BINDING_JSON must be valid JSON.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'MNEMOSYNE_ROOT_RUN_AUDIT_BINDING_JSON must be a JSON object.',
    );
  }
  return parsed;
}

function parseRootRunAcceptanceGuard(value) {
  if (value === undefined || value === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'MNEMOSYNE_ROOT_RUN_ACCEPTANCE_GUARD_JSON must be valid JSON.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'MNEMOSYNE_ROOT_RUN_ACCEPTANCE_GUARD_JSON must be a JSON object.',
    );
  }
  return parsed;
}

function parseMainHostBinding() {
  const model = String(process.env.MNEMOSYNE_UPSTREAM_MODEL || '').trim();
  return model ? { model } : null;
}

function memoryCursorSecret() {
  const configured = String(
    process.env.MNEMOSYNE_MEMORY_CURSOR_SECRET
    || process.env.MNEMOSYNE_PROXY_TOKEN
    || process.env.MNEMOSYNE_CONTEXT_ACCESS_TOKEN
    || process.env.MNEMOSYNE_UPSTREAM_API_KEY
    || '',
  ).trim();
  if (!configured) return null;
  return sha256(`mnemosyne.memory-read-cursor.v2:${configured}`);
}

const host = process.env.MNEMOSYNE_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('Tavern Mnemosyne v0 listens on loopback only.');
}

const port = parseInteger(process.env.MNEMOSYNE_PORT, 18991);
const contextMode = process.env.MNEMOSYNE_CONTEXT_MODE || 'unavailable';
parseSqliteRuntimeContext(
  process.env.MNEMOSYNE_SQLITE_RUNTIME_CONTEXT,
);
const sqliteRuntimeHealth = contextMode === 'production'
  ? probeSqliteWalRuntime()
  : null;
const runtimeBuild = runtimeBuildIdentity();
const mainHostBinding = parseMainHostBinding();
const upstreamBaseUrl = String(
  process.env.MNEMOSYNE_UPSTREAM_BASE_URL || '',
).replace(/\/+$/, '');
const upstreamModel = String(
  process.env.MNEMOSYNE_UPSTREAM_MODEL || '',
).trim();
const upstreamAuthMode = (
  process.env.MNEMOSYNE_UPSTREAM_AUTH_MODE || 'configured'
);
const upstreamHeaders = parseHeaders(
  process.env.MNEMOSYNE_UPSTREAM_HEADERS,
);
const providerBudgetPolicy = upstreamBaseUrl
  ? createProviderBudgetPolicy({
      contextTokens: parseRequiredSafeTokenCount(
        process.env.MNEMOSYNE_PROVIDER_CONTEXT_TOKENS,
        'MNEMOSYNE_PROVIDER_CONTEXT_TOKENS',
      ),
      outputReserveTokens: parseRequiredSafeTokenCount(
        process.env.MNEMOSYNE_PROVIDER_OUTPUT_RESERVE_TOKENS,
        'MNEMOSYNE_PROVIDER_OUTPUT_RESERVE_TOKENS',
      ),
    })
  : null;
const chatSaveRoot = path.resolve(
  process.env.MNEMOSYNE_CHAT_SAVE_ROOT
  || path.join(
    os.homedir(),
    '.local',
    'share',
    'tavern-mnemosyne',
    'chat-saves',
  ),
);
const rootMaxToolSteps = parseToolStepBudget(
  process.env.MNEMOSYNE_ROOT_MAX_TOOL_STEPS,
) ?? DEFAULT_ROOT_MAX_TOOL_STEPS;
const memoryReadMaxTokens = parseMemoryReadTokenBudget(
  process.env.MNEMOSYNE_MEMORY_READ_MAX_TOKENS,
) ?? DEFAULT_MAX_MEMORY_READ_TOKENS;
const staticLoreMaxInputBytes = parseOptionalSafeTokenCount(
  process.env.MNEMOSYNE_STATIC_LORE_MAX_INPUT_BYTES,
  'MNEMOSYNE_STATIC_LORE_MAX_INPUT_BYTES',
) ?? DEFAULT_STATIC_LORE_MAX_INPUT_BYTES;
const maxRequestBodyBytes = parseOptionalSafeTokenCount(
  process.env.MNEMOSYNE_MAX_REQUEST_BODY_BYTES,
  'MNEMOSYNE_MAX_REQUEST_BODY_BYTES',
) ?? defaultMaxRequestBodyBytes(staticLoreMaxInputBytes);
if (maxRequestBodyBytes <= staticLoreMaxInputBytes) {
  throw new Error(
    'MNEMOSYNE_MAX_REQUEST_BODY_BYTES must exceed '
    + 'MNEMOSYNE_STATIC_LORE_MAX_INPUT_BYTES.',
  );
}
const staticLoreMaxOutputTokens = parseOptionalSafeTokenCount(
  process.env.MNEMOSYNE_STATIC_LORE_MAX_OUTPUT_TOKENS,
  'MNEMOSYNE_STATIC_LORE_MAX_OUTPUT_TOKENS',
) ?? DEFAULT_STATIC_LORE_MAX_OUTPUT_TOKENS;
const rootRunOverallTimeoutMs = parseDuration(
  process.env.MNEMOSYNE_ROOT_RUN_OVERALL_TIMEOUT_MS,
) ?? DEFAULT_ROOT_RUN_OVERALL_TIMEOUT_MS;
const resolvedMemoryCursorSecret = memoryCursorSecret();
const auditExcludedPhrases = parseAuditExcludedPhrases(
  process.env.MNEMOSYNE_AUDIT_EXCLUDED_PHRASES_JSON,
);
const requireAuditExcludedPhrasesAbsent = parseBoolean(
  process.env.MNEMOSYNE_REQUIRE_AUDIT_EXCLUDED_PHRASES_ABSENT,
);
const rootRunAuditBinding = parseRootRunAuditBinding(
  process.env.MNEMOSYNE_ROOT_RUN_AUDIT_BINDING_JSON,
);
const rootRunAcceptanceGuard = parseRootRunAcceptanceGuard(
  process.env.MNEMOSYNE_ROOT_RUN_ACCEPTANCE_GUARD_JSON,
);
const rootRunAcceptanceGuardStatePath = (
  process.env.MNEMOSYNE_ROOT_RUN_ACCEPTANCE_GUARD_STATE_PATH
  || null
);
const freshIntakeWitnessPath = (
  process.env.MNEMOSYNE_FRESH_INTAKE_WITNESS_PATH
  || null
);
const freshIntakeStatePath = (
  process.env.MNEMOSYNE_FRESH_INTAKE_STATE_PATH
  || null
);
const allowFreshHostChatProgression = parseBoolean(
  process.env.MNEMOSYNE_FRESH_HOST_CHAT_PROGRESSION,
);
if (Boolean(freshIntakeWitnessPath) !== Boolean(freshIntakeStatePath)) {
  throw new Error(
    'MNEMOSYNE_FRESH_INTAKE_WITNESS_PATH and '
    + 'MNEMOSYNE_FRESH_INTAKE_STATE_PATH must be configured together.',
  );
}
if (freshIntakeWitnessPath && contextMode !== 'production') {
  throw new Error(
    'Fresh Intake Admission is available only in production context mode.',
  );
}
const freshIntakeAdmissionGuard = freshIntakeWitnessPath
  ? await loadFreshIntakeAdmissionGuard({
      witnessPath: freshIntakeWitnessPath,
      statePath: freshIntakeStatePath,
      chatSaveRoot,
      allowHostChatProgression: allowFreshHostChatProgression,
    })
  : null;
const chatSaveStore = contextMode === 'production'
  ? createChatSaveStore({
      rootDir: chatSaveRoot,
    })
  : null;
const chatWriteCoordinator = chatSaveStore
  ? createChatWriteCoordinator()
  : null;
const runJournal = chatSaveStore
  ? createRunJournal({ store: chatSaveStore })
  : null;
function parseStoryCraftConfig(serialized) {
  if (serialized === undefined || serialized === '') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('MNEMOSYNE_STORY_CRAFT_JSON must be valid JSON.');
  }
  return normalizeStoryCraftConfig(parsed);
}
const storyCraftConfig = parseStoryCraftConfig(
  process.env.MNEMOSYNE_STORY_CRAFT_JSON,
);
const continuityComposer = chatSaveStore
  ? createContinuityComposer({
      store: chatSaveStore,
      measureTokens: countOpenAiTokens,
      runJournal,
      ...(storyCraftConfig === undefined
        ? {}
        : { storyCraft: storyCraftConfig }),
    })
  : null;
const memoryReader = chatSaveStore
  ? createMemoryReader({ store: chatSaveStore })
  : null;
const sourceCoverageRuntime = chatSaveStore && memoryReader
  ? createProductionSourceCoverageRuntime({
      store: chatSaveStore,
      memoryReader,
    })
  : null;
const sourceRemovalGrantService =
  sourceCoverageRuntime?.sourceRemovalGrantService ?? null;
const sourceCoverageRegistry =
  sourceCoverageRuntime?.coverageRegistry ?? null;
const storySourceAdmission = sourceRemovalGrantService
  ? createGrantBackedStorySourceAdmission({
      sourceRemovalGrantService,
    })
  : null;
const staticLoreIntake = chatSaveStore
  ? createStaticLoreIntake({ store: chatSaveStore })
  : null;
const staticLoreExtractionService = staticLoreIntake && mainHostBinding
  ? createStaticLoreExtractionService({
    store: chatSaveStore,
    intake: staticLoreIntake,
    mainHostBinding,
    freshIntakeAdmissionGuard,
    maxInputBytes: staticLoreMaxInputBytes,
    maxOutputTokens: staticLoreMaxOutputTokens,
    adaptModelRequest: request => adaptOpenAiCompatibleRequest({
      requestBody: request,
      endpoint: upstreamBaseUrl,
      requestKind: 'structured_extraction',
    }),
  })
  : null;
const stateHistory = chatSaveStore
  ? createStateHistory({ store: chatSaveStore })
  : null;
const userVisibleRunActivity = runJournal
  ? createUserVisibleRunActivity({ runJournal })
  : null;
const dormantThreadInspection = chatSaveStore
  ? createDormantThreadInspection({
      store: chatSaveStore,
      runJournal,
    })
  : null;
const continuityEvaluationProgram = (
  chatSaveStore
  && runJournal
)
  ? createContinuityEvaluationProgram({
      store: chatSaveStore,
      runJournal,
      ...runtimeBuild,
    })
  : null;
const dynamicStoryProjector = chatSaveStore
  ? createDynamicStoryProjector({ store: chatSaveStore })
  : null;
const historyLifecycleService = (
  stateHistory
  && dynamicStoryProjector
)
  ? createHistoryLifecycleService({
      stateHistory,
      projector: dynamicStoryProjector,
      runJournal,
      chatWriteCoordinator,
    })
  : null;
const toolProvider = (
  stateHistory
  && upstreamBaseUrl
  && upstreamModel
)
  ? createOpenAiToolProvider({
      endpoint: `${upstreamBaseUrl}/chat/completions`,
      model: upstreamModel,
      headers: upstreamHeaders,
      adaptRequest: request => adaptOpenAiCompatibleRequest({
        requestBody: request,
        endpoint: upstreamBaseUrl,
        requestKind: 'story_tool_step',
      }),
      auth: upstreamAuthMode === 'passthrough'
        ? { mode: 'passthrough' }
        : {
            mode: 'configured',
            apiKey: process.env.MNEMOSYNE_UPSTREAM_API_KEY,
          },
    })
  : null;
const qualityTelemetryEnabled = Boolean(
  chatSaveStore && storyCraftConfig?.quality_telemetry.enabled,
);
const positivityLexicon = (
  qualityTelemetryEnabled
  && storyCraftConfig.quality_telemetry.positivity_lexicon_path
)
  ? await loadPhraseLexicon(
      storyCraftConfig.quality_telemetry.positivity_lexicon_path,
    )
  : null;
const slopDetector = (
  qualityTelemetryEnabled
  && storyCraftConfig.slop_detection.enabled
)
  ? await createSlopDetector({
      lexiconPath: storyCraftConfig.slop_detection.lexicon_path,
      historyWindowTurns:
        storyCraftConfig.quality_telemetry.history_window_turns,
    })
  : null;
const qualityTelemetry = qualityTelemetryEnabled
  ? createQualityTelemetryPass({
      store: chatSaveStore,
      config: storyCraftConfig.quality_telemetry,
      positivityLexicon,
      slopDetector,
    })
  : null;
const continuityRules = (
  chatSaveStore
  && storyCraftConfig?.continuity_rules.enabled
)
  ? createContinuityRulesPass({ store: chatSaveStore })
  : null;
// Live run progress: an in-memory, de-identified projection of kernel
// progress events, polled by the extension's run status float. Independent
// of onAudit — that stream stays an audit record and is not sanitized.
const liveRunActivity = createLiveRunActivity();
const runKernel = toolProvider
  ? createRunKernel({
      provider: toolProvider,
      stateHistory,
      memoryReader,
      runJournal,
      projector: dynamicStoryProjector,
      chatWriteCoordinator,
      maxToolSteps: rootMaxToolSteps,
      memoryCursorSecret: resolvedMemoryCursorSecret,
      maxMemoryReadTokens: memoryReadMaxTokens,
      qualityTelemetry,
      continuityRules,
      onProgress(event) {
        liveRunActivity.emit(event);
      },
  })
  : null;
const runtimeBudgetProfile = (
  providerBudgetPolicy
  && runKernel
  && staticLoreExtractionService
)
  ? createRuntimeBudgetProfile({
      providerContextTokens:
        providerBudgetPolicy.configured_context_tokens,
      providerOutputReserveTokens:
        providerBudgetPolicy.output_reserve_tokens,
      rootMaxToolSteps: runKernel.max_tool_steps,
      memoryReadMaxTokens: runKernel.max_memory_read_tokens,
      maxRequestBodyBytes,
      staticLoreMaxInputBytes,
      staticLoreMaxOutputTokens,
      rootOverallTimeoutMs: rootRunOverallTimeoutMs,
    })
  : null;
const proxy = createMnemosyneProxy({
  upstreamBaseUrl,
  upstreamApiKey: process.env.MNEMOSYNE_UPSTREAM_API_KEY,
  upstreamAuthMode,
  upstreamModel,
  upstreamHeaders,
  proxyToken: process.env.MNEMOSYNE_PROXY_TOKEN,
  contextAccessToken: process.env.MNEMOSYNE_CONTEXT_ACCESS_TOKEN,
  mainHostBinding,
  contextMode,
  continuityComposer,
  sourceRemovalGrantService,
  sourceCoverageRegistry,
  storySourceAdmission,
  staticLoreExtractionService,
  freshIntakeAdmissionGuard,
  historyLifecycleService,
  continuityEvaluationProgram,
  userVisibleRunActivity,
  dormantThreadInspection,
  liveRunActivity,
  runKernel,
  providerBudgetPolicy,
  runtimeBudgetProfile,
  rootRunAuditBinding,
  rootRunAcceptanceGuard,
  rootRunAcceptanceGuardStatePath,
  runtimeBuildIdentity: runtimeBuild,
  sqliteRuntimeHealth,
  rootRunOverallTimeoutMs,
  maxBodyBytes: maxRequestBodyBytes,
  auditExcludedPhrases,
  requireAuditExcludedPhrasesAbsent,
  intakeBodyTimeoutMs: parseDuration(
    process.env.MNEMOSYNE_INTAKE_BODY_TIMEOUT_MS,
  ),
  intakeHeadersTimeoutMs: parseDuration(
    process.env.MNEMOSYNE_INTAKE_HEADERS_TIMEOUT_MS,
  ),
  intakeOverallTimeoutMs: parseDuration(
    process.env.MNEMOSYNE_INTAKE_OVERALL_TIMEOUT_MS,
  ),
  intakeStreamTerminalGraceMs: parseDuration(
    process.env.MNEMOSYNE_INTAKE_STREAM_TERMINAL_GRACE_MS,
  ),
  intakeReasoningEffort:
    process.env.MNEMOSYNE_INTAKE_REASONING_EFFORT,
  onAudit(event) {
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`);
  },
});

const url = await proxy.listen({ host, port });
process.send?.({
  schema: 'mnemosyne.runtime-ready.v1',
  url,
});

async function shutdown() {
  await proxy.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.stdout.write(`${JSON.stringify({
  event: 'proxy_ready',
  url,
  upstream_configured: Boolean(process.env.MNEMOSYNE_UPSTREAM_BASE_URL),
  context_mode: contextMode,
  chat_save_root_configured: contextMode === 'production',
})}\n`);
