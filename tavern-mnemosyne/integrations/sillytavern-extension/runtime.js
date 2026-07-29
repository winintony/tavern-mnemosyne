import {
  normalizeHostComponentProvenance,
  resolveHostComponentProvenance,
  validateHostComponentProvenance,
} from './host-provenance-adapter.js';
import { censusMark } from './gate-census.js';

const RAW_SOURCE_LABELS = new Map([
  ['worldInfoBefore', 'raw_worldbook'],
  ['worldInfoAfter', 'raw_worldbook'],
  ['charDescription', 'raw_character_card'],
  ['charPersonality', 'raw_character_card'],
  ['scenario', 'raw_scenario'],
  ['personaDescription', 'raw_persona'],
]);
const RAW_AUTHOR_SOURCE_LABELS = new Set(RAW_SOURCE_LABELS.values());

const DIRECT_WORLD_INFO_POSITIONS = new Set([0, 1]);
const WORLD_INFO_AT_DEPTH_POSITION = 4;
const WORLD_INFO_OUTLET_POSITION = 7;
const DEFAULT_WORLD_INFO_DEPTH = 4;
const WORLD_INFO_POSITION_NAMES = new Map([
  [0, 'before'],
  [1, 'after'],
  [2, 'author_note_top'],
  [3, 'author_note_bottom'],
  [4, 'at_depth'],
  [5, 'example_top'],
  [6, 'example_bottom'],
  [7, 'outlet'],
]);
const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:18991';
const EMPTY_SYSTEM_PROMPT_HASH =
  '12319e045826d67c6f13be3888b7cb318c90e5f128502133789cc73303adad7f';
const WORLD_INFO_DEPTH_IDENTIFIER = /^customDepthWI_(\d+)_([012])$/;
const MESSAGE_ROLE_BY_EXTENSION_ROLE = new Map([
  [0, 'system'],
  [1, 'user'],
  [2, 'assistant'],
]);
const EXTENSION_RUNTIME_INSTANCE_KEY = Symbol.for(
  'tavern-mnemosyne.extension-runtime.instance',
);
const STORY_GENERATION_TYPES = new Set([
  'normal',
  'swipe',
  'regenerate',
]);
const GENERATION_HISTORY_ORIGIN_SCHEMA =
  'mnemosyne.generation-history-origin-capture.v1';
const HOST_HISTORY_COORDINATE_BASIS_SCHEMA =
  'mnemosyne.host-history-coordinate-basis.v1';
const FOREIGN_DRY_FRAME_PATTERN =
  /<mnemosyne-foreign-dry-frame data-frame-id="([A-Za-z0-9._:-]+)" data-owner-run-id="([A-Za-z0-9._:-]+)">/g;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const HOST_TRANSFORM_FENCE_SCHEMA =
  'mnemosyne.host-transform-fence-lease.v1';
const HOST_TRANSFORM_OVERRIDE_SCHEMA =
  'mnemosyne.host-transform-span-override.v1';
const HOST_TRANSFORM_MARKER_PREFIX =
  '\uE100MNEMOSYNE-HOST-TRANSFORM:';
const HOST_TRANSFORM_MARKER_SUFFIX = ':\uE101';
const CERTIFICATE_ID_PATTERN = /^coverage_[a-f0-9]{24}$/;
const SOURCE_REMOVAL_GRANT_SCHEMA =
  'mnemosyne.source-removal-grant.v3';
const SOURCE_COVERAGE_BINDING_SCHEMA =
  'mnemosyne.source-removal-coverage-binding.v3';
const SOURCE_REMOVAL_GRANT_KEYS = Object.freeze([
  'certificate_ids',
  'component_hash',
  'coverage_binding_hash',
  'coverage_policy',
  'grant_id',
  'identifier',
  'issued_at',
  'prompt_message_hash',
  'reader_capability_version',
  'run_scope',
  'schema',
  'snapshot_id',
  'source_label',
  'source_snapshot_hash',
  'source_unit_refs',
]);
const SOURCE_REMOVAL_RUN_SCOPE_KEYS = Object.freeze([
  'branch_epoch',
  'branch_id',
  'chat_id',
  'run_id',
  'turn_index',
]);
const SOURCE_COVERAGE_WRAPPER_KEYS = Object.freeze([
  'binding',
  'binding_hash',
]);
const SOURCE_COVERAGE_BINDING_KEYS = Object.freeze([
  'accepted_targets_hash',
  'certificate_ids',
  'coverage_policy',
  'fingerprint_units',
  'okf_versions',
  'projection_hash',
  'projection_id',
  'prompt_fingerprints_hash',
  'read_scope',
  'reader_capability_version',
  'run_scope',
  'runtime_view_hash',
  'schema',
  'snapshot_id',
  'source_set_hash',
  'source_snapshot_hash',
  'source_unit_evidence',
  'source_unit_refs',
]);
const SOURCE_COVERAGE_FINGERPRINT_UNIT_KEYS = Object.freeze([
  'component_hash',
  'identifier',
  'source_unit_refs',
]);
const SOURCE_COVERAGE_OKF_VERSION_KEYS = Object.freeze([
  'entity_ref',
  'version_hash',
]);
const SOURCE_COVERAGE_UNIT_EVIDENCE_KEYS = Object.freeze([
  'certificate_id',
  'manifest_hash',
  'source_unit_ref',
]);
const SOURCE_COVERAGE_READ_SCOPE_KEYS = Object.freeze([
  'branch_epoch',
  'branch_id',
  'turn_index',
]);

export function claimExtensionRuntime(registry = globalThis) {
  if (
    (typeof registry !== 'object' && typeof registry !== 'function')
    || registry === null
  ) {
    throw new Error('Extension runtime registry must be an object.');
  }
  if (registry[EXTENSION_RUNTIME_INSTANCE_KEY] === true) {
    const error = new Error(
      'A Tavern Mnemosyne browser extension instance is already active.',
    );
    error.reasonCode = 'duplicate_extension_instance';
    throw error;
  }
  Object.defineProperty(registry, EXTENSION_RUNTIME_INSTANCE_KEY, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return true;
}

function storyRunMarkerMismatch() {
  const error = new Error(
    'The active story generation changed while prompt preparation was running.',
  );
  error.reasonCode = 'story_generation_run_marker_mismatch';
  return error;
}

export function captureStoryRunLease({
  chatId,
  runId,
  activeRunMarker,
  contextResponse,
}) {
  if (
    typeof chatId !== 'string'
    || !chatId
    || typeof runId !== 'string'
    || !runId
    || !activeRunMarker
    || typeof activeRunMarker !== 'object'
    || activeRunMarker.run_id !== runId
    || !contextResponse
    || typeof contextResponse !== 'object'
    || Array.isArray(contextResponse)
  ) {
    throw storyRunMarkerMismatch();
  }
  return Object.freeze({
    schema: 'mnemosyne.story-run-lease.v1',
    chatId,
    runId,
    activeRunMarker,
    contextResponse,
  });
}

export function assertStoryRunLease(
  lease,
  {
    chatId,
    runId,
    activeRunMarker,
    contextResponse,
  },
) {
  if (
    !lease
    || typeof lease !== 'object'
    || lease.schema !== 'mnemosyne.story-run-lease.v1'
    || typeof lease.chatId !== 'string'
    || !lease.chatId
    || typeof lease.runId !== 'string'
    || !lease.runId
    || lease.activeRunMarker?.run_id !== lease.runId
    || lease.chatId !== chatId
    || lease.runId !== runId
    || lease.activeRunMarker !== activeRunMarker
    || lease.contextResponse !== contextResponse
  ) {
    throw storyRunMarkerMismatch();
  }
  return true;
}

export function completeDryRunLifecycle(
  state,
  {
    expectedRunId,
    expectedActiveRunMarker = null,
  } = {},
) {
  const activeRunMarker = state?.activeRunMarker;
  if (
    !state
    || typeof state !== 'object'
    || typeof expectedRunId !== 'string'
    || !expectedRunId
    || !activeRunMarker
    || typeof activeRunMarker !== 'object'
    || activeRunMarker.run_id !== expectedRunId
    || state.runId !== expectedRunId
    || activeRunMarker.dry_run !== true
    || (
      expectedActiveRunMarker !== null
      && activeRunMarker !== expectedActiveRunMarker
    )
  ) {
    return false;
  }

  state.runId = null;
  state.generationType = null;
  state.runScope = null;
  state.activeRunMarker = null;
  state.contextResponse = null;
  state.promptTraceInputs = null;
  state.providerBudget = null;
  state.worldInfoEntries = [];
  state.worldInfoComponentProvenance = [];
  state.hostSourceRoutes = {};
  state.sourceRemovalAuthorizations = [];
  state.preSquashInternalMessages = null;
  state.generationHistoryOriginCapture = null;
  state.suppressedMessageDeletion = null;
  state.dryCheckPending = false;
  return true;
}

export function generationTerminalStatus({
  enabled,
  blockReason,
}) {
  if (!enabled) return 'Disabled';
  if (typeof blockReason === 'string' && blockReason.length > 0) {
    return `Blocked: ${blockReason}`;
  }
  return 'Ready';
}

export function buildGenerationRunScope({
  chatId,
  branchEpoch = 0,
  chatLength,
  generationType = 'normal',
  activeSwipeId = null,
  pendingUserTurn = false,
  nestedGeneration = false,
  lastMessageRole = null,
}) {
  censusMark('PROMPT_HISTORY_RUN_BINDING', 'enter', { runId: null });
  const invalidField = (
    typeof chatId !== 'string' || !chatId
      ? 'chat_id'
      : !Number.isInteger(branchEpoch) || branchEpoch < 0
        ? 'branch_epoch'
        : !Number.isInteger(chatLength) || chatLength < 0
          ? 'chat_length'
          : typeof pendingUserTurn !== 'boolean'
            ? 'pending_user_turn'
            : typeof nestedGeneration !== 'boolean'
              ? 'nested_generation'
              : ![null, 'user', 'assistant', 'system']
                  .includes(lastMessageRole)
                ? 'last_message_role'
                : null
  );
  if (invalidField) {
    const error = new Error(
      `Generation run scope ${invalidField} is invalid.`,
    );
    error.reasonCode =
      `generation_run_scope_${invalidField}_invalid`;
    throw error;
  }
  if (nestedGeneration) {
    const error = new Error(
      'A nested story generation cannot replace the active run.',
    );
    error.reasonCode = 'nested_story_generation_unsupported';
    throw error;
  }
  if (generationType === 'continue') {
    const error = new Error(
      'Continuation generation requires an atomic append transaction and is not supported yet.',
    );
    error.reasonCode = 'history_continue_unsupported';
    throw error;
  }
  if (!STORY_GENERATION_TYPES.has(generationType)) {
    const error = new Error(
      'This generation type does not commit a SillyTavern story reply.',
    );
    error.reasonCode = 'story_generation_type_unsupported';
    throw error;
  }
  if (
    generationType === 'regenerate'
    && (chatLength === 0 || lastMessageRole !== 'assistant')
  ) {
    const error = new Error(
      'Regenerate requires an existing assistant reply.',
    );
    error.reasonCode = 'history_regenerate_target_missing';
    throw error;
  }
  const scopedChatLength = chatLength + (pendingUserTurn ? 1 : 0);
  const replacesLastAssistant = [
    'swipe',
    'regenerate',
  ].includes(generationType);
  const targetTurnIndex = replacesLastAssistant
    ? Math.max(0, scopedChatLength - 1)
    : scopedChatLength;
  const parentTurnIndex = Math.max(0, targetTurnIndex - 1);
  const preservesSwipeCoordinate = [
    'swipe',
  ].includes(generationType);
  censusMark('PROMPT_HISTORY_RUN_BINDING', 'passed', { runId: null });
  return {
    chat_id: chatId,
    branch_epoch: branchEpoch,
    visible_turn_index: parentTurnIndex,
    target_turn_index: targetTurnIndex,
    parent_turn_index: parentTurnIndex,
    active_swipe_id:
      preservesSwipeCoordinate && Number.isInteger(activeSwipeId)
        ? activeSwipeId
        : null,
  };
}

export function shouldReservePendingUserTurn({
  generationType = 'normal',
  automaticTrigger = false,
  dryRun = false,
  textareaText = '',
  hasPendingAttachment = false,
  sendIfEmpty = '',
  mainApi = '',
} = {}) {
  if (
    generationType !== 'normal'
    || automaticTrigger === true
    || dryRun
  ) {
    return false;
  }

  return (
    String(textareaText).length > 0
    || hasPendingAttachment === true
    || (
      mainApi === 'openai'
      && String(sendIfEmpty).trim().length > 0
    )
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizeHostMessageForSnapshot(message) {
  const normalized = (
    message
    && typeof message === 'object'
    && !Array.isArray(message)
  )
    ? structuredClone(message)
    : {};
  if (
    !normalized.extra
    || typeof normalized.extra !== 'object'
    || Array.isArray(normalized.extra)
  ) {
    normalized.extra = {};
  }
  if (!normalized.extra.reasoning) {
    normalized.extra.reasoning = '';
  }
  return normalized;
}

function promptBearingAttachments(extra) {
  return canonicalJson({
    files: Array.isArray(extra.files)
      ? structuredClone(extra.files)
      : [],
    media: Array.isArray(extra.media)
      ? structuredClone(extra.media)
      : [],
    media_index: Number.isInteger(extra.media_index)
      ? extra.media_index
      : null,
    media_display:
      extra.media_display === undefined
        || extra.media_display === null
        ? null
        : String(extra.media_display),
    inline_image: Boolean(extra.inline_image),
    title: extra.title === undefined || extra.title === null
      ? null
      : String(extra.title),
    append_title: Boolean(extra.append_title),
  });
}

function promptBearingExtra(extra) {
  const normalized = (
    extra
    && typeof extra === 'object'
    && !Array.isArray(extra)
  )
    ? extra
    : {};
  return {
    system_type: normalized.type === undefined
      || normalized.type === null
      ? null
      : String(normalized.type),
    prompt_bias: normalized.bias === undefined
      || normalized.bias === null
      ? null
      : String(normalized.bias),
    prompt_attachments: promptBearingAttachments(normalized),
    prompt_reasoning: String(normalized.reasoning ?? ''),
    prompt_reasoning_signature: canonicalJson(
      normalized.reasoning_signature
        ? normalized.reasoning_signature
        : null,
    ),
    prompt_tool_invocations: canonicalJson(
      Array.isArray(normalized.tool_invocations)
        ? normalized.tool_invocations
        : [],
    ),
    prompt_origin_api: normalized.api === undefined
      || normalized.api === null
      ? null
      : String(normalized.api),
    prompt_origin_model: normalized.model === undefined
      || normalized.model === null
      ? null
      : String(normalized.model),
  };
}

function normalizedHostSwipeId(message) {
  if (Number.isInteger(message.swipe_id)) {
    return message.swipe_id;
  }
  return !message.is_user && !message.is_system
    ? 0
    : null;
}

export function inspectCurrentCardGreeting(
  message,
  {
    name,
    greetings,
    expandMacros,
  } = {},
) {
  if (
    !message
    || typeof message !== 'object'
    || Array.isArray(message)
    || message.is_user !== false
    || message.is_system !== false
    || message.force_avatar === true
    || typeof name !== 'string'
    || !name
    || String(message.name ?? '') !== name
    || !Array.isArray(greetings)
    || greetings.length === 0
    || greetings.some(value => typeof value !== 'string')
    || typeof expandMacros !== 'function'
  ) {
    return null;
  }
  const swipeId = normalizedHostSwipeId(message);
  if (
    !Number.isInteger(swipeId)
    || swipeId < 0
    || swipeId >= greetings.length
  ) {
    return null;
  }
  if (
    Array.isArray(message.swipes)
      ? (
        message.swipes.length !== greetings.length
        || message.swipes.some(
          (value, index) => String(value ?? '') !== greetings[index],
        )
      )
      : greetings.length !== 1
  ) {
    return null;
  }
  const rawGreeting = greetings[swipeId];
  const expandedGreeting = String(expandMacros(rawGreeting));
  const currentContent = String(message.mes ?? '');
  if (
    currentContent !== rawGreeting
    && currentContent !== expandedGreeting
  ) {
    return null;
  }
  return Object.freeze({
    swipe_id: swipeId,
    raw_greeting: rawGreeting,
    expanded_greeting: expandedGreeting,
    is_macro_expansion: (
      rawGreeting !== expandedGreeting
      && currentContent === expandedGreeting
    ),
  });
}

function stableAssistantCandidateInventory(message) {
  const swipeId = normalizedHostSwipeId(message);
  if (swipeId === null) return canonicalJson([]);
  // SillyTavern emits MESSAGE_RECEIVED before backfilling the new active
  // swipes/swipe_info slot. Treat the live message fields as authoritative
  // for that slot, while retaining every inactive candidate's prompt identity.
  const swipes = (
    Array.isArray(message.swipes)
    && message.swipes.length > 0
  )
    ? message.swipes
    : [message.mes ?? ''];
  const swipeInfo = Array.isArray(message.swipe_info)
    ? message.swipe_info
    : [];
  const activeCandidateIndex = Math.min(
    Math.max(swipeId, 0),
    swipes.length - 1,
  );
  return canonicalJson(Array.from(
    { length: swipes.length },
    (_, index) => {
      const info = (
        swipeInfo[index]
        && typeof swipeInfo[index] === 'object'
        && !Array.isArray(swipeInfo[index])
      )
        ? swipeInfo[index]
        : {};
      const active = index === activeCandidateIndex;
      return {
        content: String(
          active
            ? message.mes ?? ''
            : swipes[index] ?? '',
        ),
        send_date: (
          active
            ? message.send_date
            : info.send_date
        ) ?? null,
        ...promptBearingExtra(
          active
            ? message.extra
            : info.extra,
        ),
      };
    },
  ));
}

export function snapshotHostHistory(
  chat,
  {
    currentCard = null,
  } = {},
) {
  if (!Array.isArray(chat)) return [];
  return chat.map((message, index) => {
    let normalized = normalizeHostMessageForSnapshot(message);
    if (index === 0 && currentCard !== null) {
      const greeting = inspectCurrentCardGreeting(
        normalized,
        currentCard,
      );
      if (greeting) {
        normalized = {
          ...normalized,
          mes: greeting.raw_greeting,
        };
      }
    }
    const stableExtra = promptBearingExtra(normalized.extra);
    return canonicalJson({
      index,
      is_user: Boolean(normalized.is_user),
      is_system: Boolean(normalized.is_system),
      force_avatar: Boolean(normalized.force_avatar),
      speaker_name: normalized.name === undefined
        || normalized.name === null
        ? null
        : String(normalized.name),
      ...stableExtra,
      send_date: normalized.send_date ?? null,
      swipe_id: normalizedHostSwipeId(normalized),
      content: String(normalized.mes ?? ''),
      message: normalized,
    });
  });
}

export function findTruncationCutoff(previousSnapshot, currentSnapshot) {
  if (
    !Array.isArray(previousSnapshot)
    || !Array.isArray(currentSnapshot)
  ) {
    throw new Error('History snapshots must be arrays.');
  }
  const sharedLength = Math.min(
    previousSnapshot.length,
    currentSnapshot.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    if (previousSnapshot[index] !== currentSnapshot[index]) {
      return index;
    }
  }
  return sharedLength;
}

function stableHostHistoryCoordinate(entry) {
  if (typeof entry !== 'string') return null;
  try {
    const parsed = JSON.parse(entry);
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || !Number.isInteger(parsed.index)
      || typeof parsed.is_user !== 'boolean'
      || typeof parsed.is_system !== 'boolean'
      || typeof parsed.force_avatar !== 'boolean'
      || !(
        parsed.speaker_name === null
        || typeof parsed.speaker_name === 'string'
      )
      || !(
        parsed.system_type === null
        || typeof parsed.system_type === 'string'
      )
      || !(
        parsed.prompt_bias === null
        || typeof parsed.prompt_bias === 'string'
      )
      || typeof parsed.prompt_attachments !== 'string'
      || typeof parsed.prompt_reasoning !== 'string'
      || typeof parsed.prompt_reasoning_signature !== 'string'
      || typeof parsed.prompt_tool_invocations !== 'string'
      || !(
        parsed.prompt_origin_api === null
        || typeof parsed.prompt_origin_api === 'string'
      )
      || !(
        parsed.prompt_origin_model === null
        || typeof parsed.prompt_origin_model === 'string'
      )
      || typeof parsed.content !== 'string'
      || !parsed.message
      || typeof parsed.message !== 'object'
      || Array.isArray(parsed.message)
    ) {
      return null;
    }
    return canonicalJson({
      index: parsed.index,
      is_user: parsed.is_user,
      is_system: parsed.is_system,
      force_avatar: parsed.force_avatar,
      speaker_name: parsed.speaker_name,
      system_type: parsed.system_type,
      prompt_bias: parsed.prompt_bias,
      prompt_attachments: parsed.prompt_attachments,
      prompt_reasoning: parsed.prompt_reasoning,
      prompt_reasoning_signature:
        parsed.prompt_reasoning_signature,
      prompt_tool_invocations:
        parsed.prompt_tool_invocations,
      prompt_origin_api: parsed.prompt_origin_api,
      prompt_origin_model: parsed.prompt_origin_model,
      send_date: parsed.send_date ?? null,
      swipe_id: parsed.swipe_id,
      assistant_candidate_inventory:
        stableAssistantCandidateInventory(parsed.message),
      content: parsed.content,
    });
  } catch {
    return null;
  }
}

function stableHostHistoryCoordinateVariants(
  entry,
  {
    currentCard = null,
  } = {},
) {
  // Legacy checkpoints may have sealed #0 after SillyTavern expanded its
  // greeting macros. Keep raw/expanded as comparison-only coordinates, and
  // expose them only after this entry independently proves the exact current
  // card, role, swipe, and greeting identity.
  const coordinate = stableHostHistoryCoordinate(entry);
  if (!coordinate || currentCard === null) {
    return coordinate ? [coordinate] : null;
  }

  try {
    const parsed = JSON.parse(entry);
    if (
      parsed.index !== 0
      || parsed.is_user !== false
      || parsed.is_system !== false
      || parsed.force_avatar !== false
      || parsed.content
        !== String(parsed.message.mes ?? '')
    ) {
      return [coordinate];
    }
    const greeting = inspectCurrentCardGreeting(
      parsed.message,
      currentCard,
    );
    if (
      !greeting
      || parsed.speaker_name !== currentCard.name
      || parsed.swipe_id !== greeting.swipe_id
    ) {
      return [coordinate];
    }

    const variants = [
      greeting.raw_greeting,
      greeting.expanded_greeting,
    ].map(content => stableHostHistoryCoordinate(
      canonicalJson({
        ...parsed,
        content,
        message: {
          ...parsed.message,
          mes: content,
        },
      }),
    ));
    if (variants.some(value => value === null)) {
      return null;
    }
    return [...new Set(variants)];
  } catch {
    return null;
  }
}

function stableHostHistoryCoordinatesMatch(
  previousEntry,
  currentEntry,
  {
    currentCard = null,
  } = {},
) {
  const previous = stableHostHistoryCoordinateVariants(
    previousEntry,
    { currentCard },
  );
  const current = stableHostHistoryCoordinateVariants(
    currentEntry,
    { currentCard },
  );
  if (!previous || !current) return null;
  const currentCoordinates = new Set(current);
  return previous.some(
    coordinate => currentCoordinates.has(coordinate),
  );
}

export function findMessageEditCutoff(
  previousSnapshot,
  currentSnapshot,
  {
    expectedMessageIndex,
    currentCard = null,
  } = {},
) {
  if (
    !Array.isArray(previousSnapshot)
    || !Array.isArray(currentSnapshot)
    || previousSnapshot.length !== currentSnapshot.length
    || !Number.isInteger(expectedMessageIndex)
    || expectedMessageIndex < 0
    || expectedMessageIndex >= currentSnapshot.length
  ) {
    throw new Error('Message edit history coordinates are invalid.');
  }

  let firstChangedIndex = null;
  for (let index = 0; index < currentSnapshot.length; index += 1) {
    const matches = stableHostHistoryCoordinatesMatch(
      previousSnapshot[index],
      currentSnapshot[index],
      { currentCard },
    );
    if (matches === null) {
      throw new Error('Message edit history coordinates are invalid.');
    }
    if (firstChangedIndex === null && !matches) {
      firstChangedIndex = index;
    }
  }
  if (firstChangedIndex === null) return null;
  return Math.min(firstChangedIndex, expectedMessageIndex);
}

export function findHostHistoryInvalidationCutoff(
  previousSnapshot,
  currentSnapshot,
  {
    currentCard = null,
  } = {},
) {
  if (
    !Array.isArray(previousSnapshot)
    || !Array.isArray(currentSnapshot)
  ) {
    throw new Error('Host history snapshots are invalid.');
  }
  const sharedLength = Math.min(
    previousSnapshot.length,
    currentSnapshot.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    const matches = stableHostHistoryCoordinatesMatch(
      previousSnapshot[index],
      currentSnapshot[index],
      { currentCard },
    );
    if (matches === null) {
      throw new Error('Host history snapshots are invalid.');
    }
    if (!matches) return index;
  }
  return currentSnapshot.length < previousSnapshot.length
    ? currentSnapshot.length
    : null;
}

export function findMessageDeletionCutoff(
  previousSnapshot,
  currentSnapshot,
  {
    expectedRemainingLength,
    currentCard = null,
  } = {},
) {
  if (
    !Array.isArray(previousSnapshot)
    || !Array.isArray(currentSnapshot)
    || !Number.isInteger(expectedRemainingLength)
    || expectedRemainingLength < 0
    || currentSnapshot.length !== expectedRemainingLength
  ) {
    throw new Error('Message deletion history coordinates are invalid.');
  }

  const sharedLength = Math.min(
    previousSnapshot.length,
    currentSnapshot.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    const matches = stableHostHistoryCoordinatesMatch(
      previousSnapshot[index],
      currentSnapshot[index],
      { currentCard },
    );
    if (matches !== true) {
      return index;
    }
  }
  return sharedLength;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function generationHistoryOriginPayload(capture) {
  return {
    schema: GENERATION_HISTORY_ORIGIN_SCHEMA,
    run_id: capture.run_id,
    generation_type: capture.generation_type,
    host_history_messages_hash:
      capture.host_history_messages_hash,
    host_message_indices: capture.host_message_indices,
  };
}

/**
 * Captures the exact host-message coordinates visible at this extension's
 * generation-interceptor seam. Returns null when another host feature has
 * made the raw-to-generation coordinate map ambiguous.
 */
export async function captureGenerationHistoryOrigin({
  runId,
  generationType,
  generationMessages,
  hostHistorySnapshot,
} = {}) {
  if (
    typeof runId !== 'string'
    || !runId
    || !STORY_GENERATION_TYPES.has(generationType)
    || !Array.isArray(generationMessages)
    || !Array.isArray(hostHistorySnapshot)
  ) {
    throw new Error(
      'Generation history origin capture requires one active story run.',
    );
  }
  const hostMessages = parseHostHistorySnapshot(hostHistorySnapshot);
  const ignored = Symbol.for('ignore');
  const ordinaryHostMessageIndices = hostMessages
    .map((message, index) => (
      message.is_system ? null : index
    ))
    .filter(index => index !== null);
  if (
    hostMessages.length === 0
    || generationMessages.length === 0
    || generationMessages.some(message => (
      message?.is_system === true
      || Boolean(message?.extra?.[ignored])
      || !Number.isInteger(message?.index)
      || message.index < 0
      || message.index >= ordinaryHostMessageIndices.length
    ))
  ) {
    return null;
  }
  const hostMessageIndices = generationMessages.map(
    message => ordinaryHostMessageIndices[message.index],
  );
  if (
    new Set(hostMessageIndices).size !== hostMessageIndices.length
    || hostMessageIndices.some((index, offset) => (
      offset > 0 && index <= hostMessageIndices[offset - 1]
    ))
  ) {
    return null;
  }
  const payload = {
    schema: GENERATION_HISTORY_ORIGIN_SCHEMA,
    run_id: runId,
    generation_type: generationType,
    host_history_messages_hash: await sha256(
      canonicalJson(hostHistorySnapshot),
    ),
    host_message_indices: hostMessageIndices,
  };
  return {
    ...payload,
    capture_hash: await sha256(canonicalJson(payload)),
  };
}

export async function sealHostHistoryCoordinateBasis({
  originCapture,
  hostHistoryBinding,
  runId,
  generationType,
} = {}) {
  if (originCapture === null || originCapture === undefined) {
    return null;
  }
  const expectedCapturePayload =
    generationHistoryOriginPayload(originCapture);
  if (
    originCapture.schema !== GENERATION_HISTORY_ORIGIN_SCHEMA
    || originCapture.run_id !== runId
    || originCapture.generation_type !== generationType
    || originCapture.capture_hash
      !== await sha256(canonicalJson(expectedCapturePayload))
    || !hostHistoryBinding
    || originCapture.host_history_messages_hash
      !== hostHistoryBinding.messages_hash
    || !Array.isArray(originCapture.host_message_indices)
    || originCapture.host_message_indices.length === 0
    || originCapture.host_message_indices.some(index => (
      !Number.isInteger(index)
      || index < 0
      || index >= hostHistoryBinding.message_count
    ))
    || originCapture.host_message_indices.some((index, offset) => (
      offset > 0
      && index <= originCapture.host_message_indices[offset - 1]
    ))
    || new Set(originCapture.host_message_indices).size
      !== originCapture.host_message_indices.length
  ) {
    return null;
  }
  const payload = {
    schema: HOST_HISTORY_COORDINATE_BASIS_SCHEMA,
    run_id: runId,
    generation_type: generationType,
    host_history_binding_hash: hostHistoryBinding.binding_hash,
    host_message_indices: [
      ...originCapture.host_message_indices,
    ],
  };
  return {
    ...payload,
    basis_hash: await sha256(canonicalJson(payload)),
  };
}

export async function hashHostChatId(chatId) {
  if (typeof chatId !== 'string' || !chatId) {
    throw historyCheckpointError(
      'Host chat identity is unavailable.',
    );
  }
  return sha256(chatId);
}

function historyCheckpointError(
  message,
  reasonCode = 'history_checkpoint_invalid',
) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

export async function assertGovernedHistoryCheckpoint(
  checkpoint,
  {
    chatId = null,
  } = {},
) {
  if (
    !checkpoint
    || typeof checkpoint !== 'object'
    || Array.isArray(checkpoint)
    || checkpoint.schema
      !== 'mnemosyne.governed-history-checkpoint.v1'
    || !HASH_PATTERN.test(checkpoint.chat_id_hash ?? '')
    || !Number.isInteger(checkpoint.branch_epoch)
    || checkpoint.branch_epoch < 0
    || !Number.isInteger(checkpoint.message_count)
    || checkpoint.message_count < 0
    || !Array.isArray(checkpoint.message_hashes)
    || checkpoint.message_hashes.length
      !== checkpoint.message_count
    || checkpoint.message_hashes.some(
      value => !HASH_PATTERN.test(value),
    )
    || !HASH_PATTERN.test(checkpoint.checkpoint_hash ?? '')
  ) {
    throw historyCheckpointError(
      'The governed host history checkpoint is invalid.',
    );
  }
  const payload = {
    schema: checkpoint.schema,
    chat_id_hash: checkpoint.chat_id_hash,
    branch_epoch: checkpoint.branch_epoch,
    message_count: checkpoint.message_count,
    message_hashes: checkpoint.message_hashes,
  };
  if (
    await sha256(canonicalJson(payload))
      !== checkpoint.checkpoint_hash
  ) {
    throw historyCheckpointError(
      'The governed host history checkpoint hash is invalid.',
    );
  }
  if (
    chatId !== null
    && (
      typeof chatId !== 'string'
      || !chatId
      || checkpoint.chat_id_hash !== await sha256(chatId)
    )
  ) {
    throw historyCheckpointError(
      'The governed history checkpoint belongs to another chat.',
    );
  }
  return structuredClone(checkpoint);
}

async function stableHostHistoryHashes(hostHistorySnapshot) {
  if (!Array.isArray(hostHistorySnapshot)) {
    throw historyCheckpointError(
      'A governed history checkpoint requires a host snapshot.',
    );
  }
  const hashes = [];
  for (const entry of hostHistorySnapshot) {
    const coordinate = stableHostHistoryCoordinate(entry);
    if (!coordinate) {
      throw historyCheckpointError(
        'A governed history checkpoint contains an invalid coordinate.',
      );
    }
    hashes.push(await sha256(coordinate));
  }
  return hashes;
}

export async function createGovernedHistoryCheckpoint({
  chatId,
  hostHistorySnapshot,
  branchEpoch,
} = {}) {
  if (
    typeof chatId !== 'string'
    || !chatId
    || !Number.isInteger(branchEpoch)
    || branchEpoch < 0
  ) {
    throw historyCheckpointError(
      'A governed history checkpoint requires a branch epoch.',
    );
  }
  const messageHashes =
    await stableHostHistoryHashes(hostHistorySnapshot);
  const payload = {
    schema: 'mnemosyne.governed-history-checkpoint.v1',
    chat_id_hash: await sha256(chatId),
    branch_epoch: branchEpoch,
    message_count: messageHashes.length,
    message_hashes: messageHashes,
  };
  return {
    ...payload,
    checkpoint_hash: await sha256(canonicalJson(payload)),
  };
}

export async function recoverGovernedHistoryCheckpoint({
  inspection,
  chatId,
  currentChat,
  cardGreetings = null,
} = {}) {
  const anchor = inspection?.recovery_anchor;
  if (
    anchor?.schema
    === 'mnemosyne.governed-history-recovery-anchor.v2'
  ) {
    const turns = anchor.turns;
    if (
      inspection?.schema
        !== 'mnemosyne.governed-history-inspection.v1'
      || inspection.status !== 'ready'
      || inspection.chat_id !== chatId
      || inspection.branch_id !== 'main'
      || inspection.has_governed_history !== true
      || !Number.isInteger(
        inspection.active_branch_epoch,
      )
      || inspection.active_branch_epoch < 0
      || anchor.chat_id_hash !== await sha256(chatId)
      || anchor.branch_id !== 'main'
      || anchor.branch_epoch
        !== inspection.active_branch_epoch
      || anchor.recovery_policy
        !== 'plain_alternating_content_chain'
      || !Array.isArray(turns)
      || turns.length === 0
      || inspection.committed_turn_count
        !== turns.length
      || inspection.latest_turn_index
        !== turns.at(-1)?.committed_assistant
          ?.turn_index
      || anchor.governed_message_count
        !== turns.at(-1)?.committed_assistant
          ?.turn_index + 1
      || !Array.isArray(currentChat)
      || currentChat.length
        < anchor.governed_message_count
      || !Array.isArray(cardGreetings)
      || cardGreetings.length === 0
      || cardGreetings.some(value => (
        typeof value !== 'string'
      ))
    ) {
      throw historyCheckpointError(
        'The governed history recovery chain is invalid.',
        'history_recovery_chain_invalid',
      );
    }
    const promptExtraIsPlain = (
      message,
      {
        expectedApi = null,
        expectedModel = null,
      } = {},
    ) => {
      const extra = (
        message?.extra
        && typeof message.extra === 'object'
        && !Array.isArray(message.extra)
      )
        ? message.extra
        : {};
      return (
        (extra.type === undefined || extra.type === null)
        && (extra.bias === undefined || extra.bias === null)
        && (!Array.isArray(extra.files) || extra.files.length === 0)
        && (!Array.isArray(extra.media) || extra.media.length === 0)
        && !Number.isInteger(extra.media_index)
        && (
          extra.media_display === undefined
          || extra.media_display === null
        )
        && extra.inline_image !== true
        && (extra.title === undefined || extra.title === null)
        && extra.append_title !== true
        && String(extra.reasoning ?? '') === ''
        && String(extra.reasoning_signature ?? '') === ''
        && (
          !Array.isArray(extra.tool_invocations)
          || extra.tool_invocations.length === 0
        )
        && (extra.api ?? null) === expectedApi
        && (extra.model ?? null) === expectedModel
      );
    };
    const greeting = currentChat[0];
    const greetingSwipeId =
      normalizedHostSwipeId(greeting);
    if (
      !greeting
      || greeting.is_user === true
      || greeting.is_system === true
      || greeting.force_avatar === true
      || !Number.isInteger(greetingSwipeId)
      || greetingSwipeId < 0
      || greetingSwipeId >= cardGreetings.length
    ) {
      throw historyCheckpointError(
        'The current greeting coordinate is invalid.',
        'history_recovery_greeting_coordinate_invalid',
      );
    }
    if (!promptExtraIsPlain(greeting)) {
      throw historyCheckpointError(
        'The current greeting has prompt-bearing metadata.',
        'history_recovery_greeting_metadata_mismatch',
      );
    }
    if (
      !Array.isArray(greeting.swipes)
      || greeting.swipes.length !== cardGreetings.length
      || greeting.swipes.some(
        (value, index) => value !== cardGreetings[index],
      )
      || String(greeting.mes ?? '')
        !== cardGreetings[greetingSwipeId]
    ) {
      throw historyCheckpointError(
        'The current greeting does not match the bound character card.',
        'history_recovery_greeting_mismatch',
      );
    }
    const assistantName = String(greeting.name ?? '');
    let userName = null;
    let assistantTransformSuffix = null;
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const binding = turn?.pre_history_binding;
      const preHistoryContentHashes =
        turn?.pre_history_content_hashes;
      const preHistoryFingerprintStart =
        turn?.pre_history_fingerprint_start;
      const committed = turn?.committed_assistant;
      const expectedTurnIndex = 2 + (index * 2);
      let preHistoryContentMatches = (
        Array.isArray(preHistoryContentHashes)
        && preHistoryContentHashes.length >= 2
        && preHistoryContentHashes.length % 2 === 0
        && Number.isInteger(
          preHistoryFingerprintStart,
        )
        && preHistoryFingerprintStart >= 0
        && preHistoryFingerprintStart
          + preHistoryContentHashes.length
          === expectedTurnIndex
      );
      if (preHistoryContentMatches) {
        for (
          let offset = 0;
          offset < preHistoryContentHashes.length;
          offset += 1
        ) {
          const messageIndex =
            preHistoryFingerprintStart + offset;
          const hash =
            preHistoryContentHashes[offset];
          if (
            !HASH_PATTERN.test(hash ?? '')
            || (
              (
                messageIndex === 0
                || messageIndex % 2 === 1
              )
              && hash !== await sha256(String(
                currentChat[messageIndex]?.mes ?? '',
              ))
            )
          ) {
            preHistoryContentMatches = false;
            break;
          }
        }
      }
      if (
        turn?.schema
          !== 'mnemosyne.governed-history-recovery-turn.v2'
        || typeof turn.model !== 'string'
        || !turn.model
        || committed?.turn_index !== expectedTurnIndex
        || committed.swipe_id !== 0
        || !HASH_PATTERN.test(committed.body_hash ?? '')
        || binding?.message_count !== expectedTurnIndex
        || binding.last_message_index
          !== expectedTurnIndex - 1
        || binding.last_message_role !== 'user'
        || binding.last_message_body_hash
          !== await sha256(String(
            currentChat[expectedTurnIndex - 1]
              ?.mes ?? '',
          ))
        || typeof committed.raw_body !== 'string'
        || !committed.raw_body
        || await sha256(committed.raw_body)
          !== committed.body_hash
      ) {
        throw historyCheckpointError(
          'A governed history recovery turn is invalid.',
          'history_recovery_turn_anchor_invalid',
        );
      }
      if (!preHistoryContentMatches) {
        throw historyCheckpointError(
          'The current host content does not match the sealed provider history.',
          'history_recovery_provider_history_mismatch',
        );
      }
      await normalizeHostHistoryBinding(binding, {
        chat_id: chatId,
        branch_epoch: anchor.branch_epoch,
        visible_turn_index:
          expectedTurnIndex - 1,
        parent_turn_index:
          expectedTurnIndex - 1,
        target_turn_index: expectedTurnIndex,
      });
      const user =
        currentChat[expectedTurnIndex - 1];
      const assistant =
        currentChat[expectedTurnIndex];
      const assistantBody =
        String(assistant?.mes ?? '');
      const transformSuffix =
        assistantBody.startsWith(
          committed.raw_body,
        )
          ? assistantBody.slice(
              committed.raw_body.length,
            )
          : null;
      if (userName === null) {
        userName = String(user?.name ?? '');
      }
      if (
        !user
        || user.is_user !== true
        || user.is_system === true
        || user.force_avatar === true
        || String(user.name ?? '') !== userName
        || !promptExtraIsPlain(user)
        || !assistant
        || assistant.is_user === true
        || assistant.is_system === true
        || assistant.force_avatar === true
        || String(assistant.name ?? '') !== assistantName
        || normalizedHostSwipeId(assistant) !== 0
        || !Array.isArray(assistant.swipes)
        || assistant.swipes.length !== 1
        || assistant.swipes[0]
          !== String(assistant.mes ?? '')
        || !promptExtraIsPlain(assistant, {
          expectedApi: 'custom',
          expectedModel: turn.model,
        })
      ) {
        throw historyCheckpointError(
          'The current plain host turn does not match its governed recovery chain.',
          'history_recovery_host_turn_mismatch',
        );
      }
      if (
        transformSuffix === null
        || (
          assistantTransformSuffix !== null
          && transformSuffix
            !== assistantTransformSuffix
        )
      ) {
        throw historyCheckpointError(
          'The current assistant reply does not preserve the governed output and stable host suffix.',
          'history_recovery_output_transform_mismatch',
        );
      }
      assistantTransformSuffix = transformSuffix;
    }
    if (
      turns.length < 2
      && assistantTransformSuffix !== ''
    ) {
      throw historyCheckpointError(
        'One governed turn cannot establish a non-empty host output suffix.',
        'history_recovery_output_transform_mismatch',
      );
    }
    return createGovernedHistoryCheckpoint({
      chatId,
      hostHistorySnapshot:
        snapshotHostHistory(currentChat).slice(
          0,
          anchor.governed_message_count,
        ),
      branchEpoch: anchor.branch_epoch,
    });
  }
  const binding = anchor?.pre_history_binding;
  const committed = anchor?.committed_assistant;
  if (
    inspection?.schema
      !== 'mnemosyne.governed-history-inspection.v1'
    || inspection.status !== 'ready'
    || inspection.chat_id !== chatId
    || inspection.branch_id !== 'main'
    || inspection.has_governed_history !== true
    || !Number.isInteger(inspection.active_branch_epoch)
    || inspection.active_branch_epoch < 0
    || anchor?.schema
      !== 'mnemosyne.governed-history-recovery-anchor.v1'
    || anchor.chat_id_hash !== await sha256(chatId)
    || anchor.branch_id !== 'main'
    || anchor.branch_epoch
      !== inspection.active_branch_epoch
    || !Number.isInteger(anchor.governed_message_count)
    || anchor.governed_message_count < 1
    || binding?.schema
      !== 'mnemosyne.host-history-binding.v1'
    || binding.chat_id_hash !== anchor.chat_id_hash
    || binding.branch_id !== anchor.branch_id
    || binding.branch_epoch !== anchor.branch_epoch
    || !Number.isInteger(binding.message_count)
    || binding.message_count < 1
    || committed === null
    || typeof committed !== 'object'
    || Array.isArray(committed)
    || typeof committed.run_id !== 'string'
    || !committed.run_id
    || typeof committed.turn_id !== 'string'
    || !committed.turn_id
    || typeof committed.candidate_id !== 'string'
    || !committed.candidate_id
    || !Number.isInteger(committed.turn_index)
    || committed.turn_index < 1
    || !Number.isInteger(committed.swipe_id)
    || committed.swipe_id < 0
    || !HASH_PATTERN.test(committed.body_hash ?? '')
    || binding.target_turn_index
      !== committed.turn_index
    || binding.message_count
      !== committed.turn_index
    || binding.last_message_index
      !== committed.turn_index - 1
    || binding.last_message_role !== 'user'
    || anchor.governed_message_count
      !== committed.turn_index + 1
    || !Array.isArray(currentChat)
    || currentChat.length
      < anchor.governed_message_count
  ) {
    throw historyCheckpointError(
      'The governed history recovery anchor is invalid.',
    );
  }
  const currentSnapshot = snapshotHostHistory(currentChat);
  const recomputedBinding = await createHostHistoryBinding({
    chatId,
    runScope: {
      chat_id: chatId,
      branch_epoch: binding.branch_epoch,
      visible_turn_index:
        binding.visible_turn_index,
      parent_turn_index:
        binding.parent_turn_index,
      target_turn_index:
        binding.target_turn_index,
    },
    hostHistorySnapshot: currentSnapshot.slice(
      0,
      binding.message_count,
    ),
  });
  if (
    canonicalJson(recomputedBinding)
      !== canonicalJson(binding)
  ) {
    throw historyCheckpointError(
      'The current host history does not match the governed recovery prefix.',
    );
  }
  const assistant =
    currentChat[committed.turn_index];
  if (
    !assistant
    || assistant.is_user === true
    || assistant.is_system === true
    || normalizedHostSwipeId(assistant)
      !== committed.swipe_id
    || await sha256(String(assistant.mes ?? ''))
      !== committed.body_hash
  ) {
    throw historyCheckpointError(
      'The current assistant reply does not match the committed recovery anchor.',
    );
  }
  return createGovernedHistoryCheckpoint({
    chatId,
    hostHistorySnapshot: currentSnapshot.slice(
      0,
      anchor.governed_message_count,
    ),
    branchEpoch: anchor.branch_epoch,
  });
}

export async function findGovernedHistoryInvalidationCutoff({
  checkpoint,
  chatId,
  currentHostHistorySnapshot,
  currentCard = null,
} = {}) {
  const governed =
    await assertGovernedHistoryCheckpoint(
      checkpoint,
      { chatId },
    );
  if (!Array.isArray(currentHostHistorySnapshot)) {
    throw historyCheckpointError(
      'A governed history checkpoint requires a host snapshot.',
    );
  }
  const currentHashVariants = [];
  for (const entry of currentHostHistorySnapshot) {
    const variants = stableHostHistoryCoordinateVariants(
      entry,
      { currentCard },
    );
    if (!variants) {
      throw historyCheckpointError(
        'A governed history checkpoint contains an invalid coordinate.',
      );
    }
    currentHashVariants.push(
      await Promise.all(
        variants.map(coordinate => sha256(coordinate)),
      ),
    );
  }
  const sharedLength = Math.min(
    governed.message_count,
    currentHashVariants.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    if (
      !currentHashVariants[index]
        .includes(governed.message_hashes[index])
    ) {
      return index;
    }
  }
  return currentHashVariants.length < governed.message_count
    ? currentHashVariants.length
    : null;
}

export function classifyGovernedHistorySuffix({
  governedMessageCount,
  currentChat,
} = {}) {
  if (
    !Number.isInteger(governedMessageCount)
    || governedMessageCount < 0
    || !Array.isArray(currentChat)
  ) {
    throw historyCheckpointError(
      'Governed history suffix coordinates are invalid.',
    );
  }
  if (currentChat.length < governedMessageCount) {
    return {
      status: 'structural_deletion',
      cutoff_turn_index: currentChat.length,
    };
  }
  const firstAssistantOffset =
    currentChat.slice(governedMessageCount)
      .findIndex(message => (
        !message?.is_user
        && !message?.is_system
      ));
  if (firstAssistantOffset !== -1) {
    return {
      status: 'ungoverned_assistant_append',
      cutoff_turn_index:
        governedMessageCount + firstAssistantOffset,
    };
  }
  return {
    status: 'append_allowed',
    cutoff_turn_index: null,
  };
}

function hostHistoryBindingError(message) {
  const error = new Error(message);
  error.reasonCode = 'host_history_binding_invalid';
  return error;
}

function parseHostHistorySnapshot(hostHistorySnapshot) {
  if (!Array.isArray(hostHistorySnapshot)) {
    throw hostHistoryBindingError(
      'Host history binding requires a complete history snapshot.',
    );
  }
  return hostHistorySnapshot.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw hostHistoryBindingError(
        'Every host history snapshot entry must be canonical JSON.',
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(entry);
    } catch {
      throw hostHistoryBindingError(
        'A host history snapshot entry is not valid JSON.',
      );
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || parsed.index !== index
      || typeof parsed.is_user !== 'boolean'
      || typeof parsed.is_system !== 'boolean'
      || typeof parsed.content !== 'string'
      || !parsed.message
      || typeof parsed.message !== 'object'
      || Array.isArray(parsed.message)
      || canonicalJson(parsed.message)
        !== canonicalJson(
          normalizeHostMessageForSnapshot(parsed.message),
        )
      || parsed.is_user !== Boolean(parsed.message.is_user)
      || parsed.is_system !== Boolean(parsed.message.is_system)
      || parsed.send_date !== (parsed.message.send_date ?? null)
      || parsed.swipe_id
        !== normalizedHostSwipeId(parsed.message)
      || parsed.content !== String(parsed.message.mes ?? '')
      || canonicalJson(parsed) !== entry
    ) {
      throw hostHistoryBindingError(
        'A host history snapshot entry is not canonical or contiguous.',
      );
    }
    return parsed;
  });
}

export async function createHostHistoryBinding({
  chatId,
  runScope,
  hostHistorySnapshot,
} = {}) {
  const messages = parseHostHistorySnapshot(hostHistorySnapshot);
  if (
    typeof chatId !== 'string'
    || !chatId
    || !runScope
    || typeof runScope !== 'object'
    || Array.isArray(runScope)
    || runScope.chat_id !== chatId
    || !Number.isInteger(runScope.branch_epoch)
    || runScope.branch_epoch < 0
    || !Number.isInteger(runScope.visible_turn_index)
    || runScope.visible_turn_index < 0
    || !Number.isInteger(runScope.parent_turn_index)
    || runScope.parent_turn_index < 0
    || !Number.isInteger(runScope.target_turn_index)
    || runScope.target_turn_index < 0
    || messages.length === 0
  ) {
    throw hostHistoryBindingError(
      'Host history binding requires one valid chat and run scope.',
    );
  }

  const lastMessage = messages.at(-1);
  const payload = {
    schema: 'mnemosyne.host-history-binding.v1',
    chat_id_hash: await sha256(chatId),
    branch_id: 'main',
    branch_epoch: runScope.branch_epoch,
    visible_turn_index: runScope.visible_turn_index,
    parent_turn_index: runScope.parent_turn_index,
    target_turn_index: runScope.target_turn_index,
    message_count: messages.length,
    messages_hash: await sha256(canonicalJson(hostHistorySnapshot)),
    last_message_index: lastMessage.index,
    last_message_role: lastMessage.is_system
      ? 'system'
      : lastMessage.is_user
        ? 'user'
        : 'assistant',
    last_message_body_hash:
      await sha256(lastMessage.content),
  };
  return {
    ...payload,
    binding_hash: await sha256(canonicalJson(payload)),
  };
}

function hostHistoryDriftError(message) {
  const error = new Error(message);
  error.reasonCode = 'host_history_binding_drift';
  return error;
}

export async function createStoryPromptHistoryBinding({
  chatId,
  runScope,
  generationType,
  pendingUserTurn,
  startHostHistorySnapshot,
  currentHostHistorySnapshot,
} = {}) {
  const startMessages = parseHostHistorySnapshot(startHostHistorySnapshot);
  const currentMessages = parseHostHistorySnapshot(currentHostHistorySnapshot);
  const unchanged = canonicalJson(startHostHistorySnapshot)
    === canonicalJson(currentHostHistorySnapshot);
  const oneUserAppended = (
    currentHostHistorySnapshot.length === startHostHistorySnapshot.length + 1
    && startHostHistorySnapshot.every(
      (entry, index) => entry === currentHostHistorySnapshot[index],
    )
    && currentMessages.at(-1)?.is_user === true
    && currentMessages.at(-1)?.is_system === false
  );
  const oneAssistantRemoved = (
    startHostHistorySnapshot.length === currentHostHistorySnapshot.length + 1
    && currentHostHistorySnapshot.every(
      (entry, index) => entry === startHostHistorySnapshot[index],
    )
    && startMessages.at(-1)?.is_user === false
    && startMessages.at(-1)?.is_system === false
  );
  const transitionValid = (
    (
      generationType === 'normal'
      && (
        (pendingUserTurn === false && unchanged)
        || (pendingUserTurn === true && oneUserAppended)
      )
    )
    || (
      generationType === 'regenerate'
      && pendingUserTurn === false
      && oneAssistantRemoved
    )
    || (
      generationType === 'swipe'
      && pendingUserTurn === false
      && unchanged
    )
  );
  if (!transitionValid) {
    throw hostHistoryDriftError(
      'Host history changed outside the active story generation contract.',
    );
  }
  return createHostHistoryBinding({
    chatId,
    runScope,
    hostHistorySnapshot: currentHostHistorySnapshot,
  });
}

const HOST_HISTORY_BINDING_KEYS = Object.freeze([
  'schema',
  'chat_id_hash',
  'branch_id',
  'branch_epoch',
  'visible_turn_index',
  'parent_turn_index',
  'target_turn_index',
  'message_count',
  'messages_hash',
  'last_message_index',
  'last_message_role',
  'last_message_body_hash',
  'binding_hash',
]);

async function normalizeHostHistoryBinding(binding, chatRef) {
  const keys = binding && typeof binding === 'object' && !Array.isArray(binding)
    ? Object.keys(binding)
    : [];
  const isHash = value => /^[a-f0-9]{64}$/.test(String(value ?? ''));
  const integerFields = [
    'branch_epoch',
    'visible_turn_index',
    'parent_turn_index',
    'target_turn_index',
    'message_count',
  ];
  if (
    keys.length !== HOST_HISTORY_BINDING_KEYS.length
    || !HOST_HISTORY_BINDING_KEYS.every(key => keys.includes(key))
    || binding.schema !== 'mnemosyne.host-history-binding.v1'
    || binding.branch_id !== 'main'
    || !isHash(binding.chat_id_hash)
    || !isHash(binding.messages_hash)
    || !isHash(binding.binding_hash)
    || integerFields.some(field => (
      !Number.isInteger(binding[field]) || binding[field] < 0
    ))
    || binding.message_count === 0
    || binding.last_message_index !== binding.message_count - 1
    || !['user', 'assistant', 'system'].includes(
      binding.last_message_role,
    )
    || !isHash(binding.last_message_body_hash)
  ) {
    throw hostHistoryBindingError(
      'Prompt trace host history binding is malformed.',
    );
  }

  const {
    binding_hash: claimedBindingHash,
    ...payload
  } = binding;
  const expectedBindingHash = await sha256(canonicalJson(payload));
  if (claimedBindingHash !== expectedBindingHash) {
    throw hostHistoryBindingError(
      'Prompt trace host history binding hash does not match its payload.',
    );
  }

  if (chatRef && typeof chatRef === 'object' && !Array.isArray(chatRef)) {
    const chatIdHash = typeof chatRef.chat_id === 'string'
      ? await sha256(chatRef.chat_id)
      : null;
    if (
      chatIdHash !== binding.chat_id_hash
      || chatRef.branch_epoch !== binding.branch_epoch
      || chatRef.visible_turn_index !== binding.visible_turn_index
      || chatRef.parent_turn_index !== binding.parent_turn_index
      || chatRef.target_turn_index !== binding.target_turn_index
    ) {
      throw hostHistoryBindingError(
        'Prompt trace host history binding does not match its run scope.',
      );
    }
  }

  return structuredClone(binding);
}

const HOST_HISTORY_COORDINATE_BASIS_KEYS = Object.freeze([
  'schema',
  'run_id',
  'generation_type',
  'host_history_binding_hash',
  'host_message_indices',
  'basis_hash',
]);

async function normalizeHostHistoryCoordinateBasis(
  basis,
  {
    runId,
    hostHistoryBinding,
  },
) {
  if (basis === null || basis === undefined) return null;
  const keys = basis && typeof basis === 'object' && !Array.isArray(basis)
    ? Object.keys(basis)
    : [];
  const {
    basis_hash: claimedBasisHash,
    ...payload
  } = basis ?? {};
  if (
    keys.length !== HOST_HISTORY_COORDINATE_BASIS_KEYS.length
    || !HOST_HISTORY_COORDINATE_BASIS_KEYS.every(
      key => keys.includes(key),
    )
    || basis.schema !== HOST_HISTORY_COORDINATE_BASIS_SCHEMA
    || basis.run_id !== runId
    || !STORY_GENERATION_TYPES.has(basis.generation_type)
    || !hostHistoryBinding
    || basis.host_history_binding_hash
      !== hostHistoryBinding.binding_hash
    || !Array.isArray(basis.host_message_indices)
    || basis.host_message_indices.length === 0
    || basis.host_message_indices.some(index => (
      !Number.isInteger(index)
      || index < 0
      || index >= hostHistoryBinding.message_count
    ))
    || basis.host_message_indices.some((index, offset) => (
      offset > 0
      && index <= basis.host_message_indices[offset - 1]
    ))
    || new Set(basis.host_message_indices).size
      !== basis.host_message_indices.length
    || !HASH_PATTERN.test(claimedBasisHash ?? '')
    || claimedBasisHash
      !== await sha256(canonicalJson(payload))
  ) {
    throw hostHistoryBindingError(
      'Prompt trace host-history coordinate basis is malformed.',
    );
  }
  return structuredClone(basis);
}

export async function verifyHostHistoryBinding({
  expectedBinding,
  chatId,
  runScope,
  hostHistorySnapshot,
} = {}) {
  const normalizedExpected = await normalizeHostHistoryBinding(
    expectedBinding,
    runScope,
  );
  const currentBinding = await createHostHistoryBinding({
    chatId,
    runScope,
    hostHistorySnapshot,
  });
  if (currentBinding.binding_hash !== normalizedExpected.binding_hash) {
    throw hostHistoryDriftError(
      'Host history changed after the prompt history was bound.',
    );
  }
  return currentBinding;
}

export function inspectPromptRunMarkers(messages, runId) {
  if (!Array.isArray(messages) || typeof runId !== 'string' || !runId) {
    return {
      status: 'invalid',
      runtime_marker_count: 0,
      continuity_marker_count: 0,
    };
  }
  const text = messages.flatMap(message => (
    typeof message?.content === 'string'
      ? [message.content]
      : Array.isArray(message?.content)
        ? message.content
          .filter(part => part?.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
        : []
  )).join('\n');
  const occurrenceCount = needle => text.split(needle).length - 1;
  const runtimeMarkerCount = occurrenceCount(
    '<mnemosyne-runtime-contract',
  );
  const continuityMarkerCount = occurrenceCount(
    '<mnemosyne-continuity-payload',
  );
  const expectedRuntimeMarker = text.includes(
    `<mnemosyne-runtime-contract data-run-id="${runId}"`,
  );
  const expectedContinuityMarker = text.includes(
    `<mnemosyne-continuity-payload data-run-id="${runId}"`,
  );
  const status = expectedRuntimeMarker && expectedContinuityMarker
    ? 'pass'
    : runtimeMarkerCount === 0
      ? 'runtime_marker_missing'
      : continuityMarkerCount === 0
        ? 'continuity_marker_missing'
        : 'run_identity_mismatch';
  return {
    status,
    runtime_marker_count: runtimeMarkerCount,
    continuity_marker_count: continuityMarkerCount,
  };
}

export function classifyPromptReadyOwnership(
  activeRunMarker,
  eventData,
  {
    foreignDryFrameIds = [],
  } = {},
) {
  if (
    typeof activeRunMarker?.run_id !== 'string'
    || !activeRunMarker.run_id
    || typeof activeRunMarker?.dry_run !== 'boolean'
    || typeof eventData?.dryRun !== 'boolean'
  ) {
    return 'invalid';
  }
  if (Array.isArray(eventData?.chat)) {
    const foreignFrame = inspectForeignDryPromptFrame(eventData.chat);
    if (foreignFrame.status === 'pass') {
      return (
        eventData.dryRun === true
        && foreignDryFrameIds.includes(foreignFrame.frame_id)
        && foreignFrame.owner_run_id === activeRunMarker.run_id
      )
        ? 'foreign_dry'
        : 'invalid';
    }
    if (foreignFrame.status !== 'none') return 'invalid';

    const markerInspection = inspectPromptRunMarkers(
      eventData.chat,
      activeRunMarker.run_id,
    );
    if (markerInspection.status === 'pass') {
      return activeRunMarker.dry_run === eventData.dryRun
        ? 'owned'
        : 'conflict';
    }
    if (
      activeRunMarker.dry_run === false
      && eventData.dryRun === true
      && markerInspection.runtime_marker_count === 0
      && markerInspection.continuity_marker_count === 0
    ) {
      return 'foreign_dry';
    }
    return activeRunMarker.dry_run === eventData.dryRun
      ? 'invalid'
      : 'conflict';
  }
  if (activeRunMarker.dry_run === eventData.dryRun) {
    return 'owned';
  }
  if (activeRunMarker.dry_run === false && eventData.dryRun === true) {
    return 'foreign_dry';
  }
  return 'conflict';
}

export function createForeignDryPromptFrame({
  frameId,
  ownerRunId,
} = {}) {
  const safeIdentity = value => (
    typeof value === 'string'
    && /^[A-Za-z0-9._:-]+$/.test(value)
  );
  if (!safeIdentity(frameId) || !safeIdentity(ownerRunId)) {
    throw new Error('Foreign dry frame identity is invalid.');
  }
  return [
    `<mnemosyne-foreign-dry-frame data-frame-id="${frameId}" data-owner-run-id="${ownerRunId}">`,
    'This is an extension-owned dry assembly frame. Do not use it as story context.',
    '</mnemosyne-foreign-dry-frame>',
  ].join('\n');
}

export function inspectForeignDryPromptFrame(messages) {
  if (!Array.isArray(messages)) {
    return {
      status: 'invalid',
      frame_id: null,
      owner_run_id: null,
    };
  }
  const text = messages.flatMap(message => (
    typeof message?.content === 'string'
      ? [message.content]
      : Array.isArray(message?.content)
        ? message.content
          .filter(part => (
            part?.type === 'text'
            && typeof part.text === 'string'
          ))
          .map(part => part.text)
        : []
  )).join('\n');
  const matches = [...text.matchAll(FOREIGN_DRY_FRAME_PATTERN)];
  if (matches.length === 0) {
    return {
      status: 'none',
      frame_id: null,
      owner_run_id: null,
    };
  }
  if (
    matches.length !== 1
    || text.split('<mnemosyne-foreign-dry-frame').length - 1 !== 1
  ) {
    return {
      status: 'ambiguous',
      frame_id: null,
      owner_run_id: null,
    };
  }
  return {
    status: 'pass',
    frame_id: matches[0][1],
    owner_run_id: matches[0][2],
  };
}

export function createForeignDryFrameCoordinator({
  readPromptSlots,
  writePromptSlots,
  createFrameId = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (
    typeof readPromptSlots !== 'function'
    || typeof writePromptSlots !== 'function'
    || typeof createFrameId !== 'function'
  ) {
    throw new Error('Foreign dry frame coordinator adapters are invalid.');
  }

  let base = null;
  const frames = [];
  const slotsEqual = (left, right) => (
    left?.runtime === right?.runtime
    && left?.payload === right?.payload
  );
  const currentFrameOwnsSlots = frame => (
    slotsEqual(readPromptSlots(), frame.slots)
  );
  const restoreBaseIfOwned = () => {
    if (
      base
      && frames.some(currentFrameOwnsSlots)
    ) {
      writePromptSlots(structuredClone(base.slots));
      return true;
    }
    return false;
  };

  return Object.freeze({
    begin(activeRunMarker) {
      if (
        typeof activeRunMarker?.run_id !== 'string'
        || !activeRunMarker.run_id
      ) {
        throw new Error('Foreign dry frame owner is invalid.');
      }
      if (frames.length === 0) {
        base = {
          activeRunMarker,
          slots: structuredClone(readPromptSlots()),
        };
      } else if (base?.activeRunMarker !== activeRunMarker) {
        throw new Error('Foreign dry frame owner changed.');
      }
      const frameId = createFrameId();
      const frame = {
        schema: 'mnemosyne.foreign-dry-frame.v1',
        frameId,
        ownerRunId: activeRunMarker.run_id,
        activeRunMarker,
        slots: {
          runtime: createForeignDryPromptFrame({
            frameId,
            ownerRunId: activeRunMarker.run_id,
          }),
          payload: '',
        },
      };
      frames.push(frame);
      writePromptSlots(structuredClone(frame.slots));
      return Object.freeze({ ...frame });
    },

    find(frameIdentity, activeRunMarker) {
      if (frameIdentity?.status !== 'pass') return null;
      return frames.find(frame => (
        frame.frameId === frameIdentity.frame_id
        && frame.ownerRunId === frameIdentity.owner_run_id
        && frame.activeRunMarker === activeRunMarker
      )) ?? null;
    },

    settle(frameId, activeRunMarker) {
      const frameIndex = frames.findIndex(frame => (
        frame.frameId === frameId
        && frame.activeRunMarker === activeRunMarker
      ));
      if (frameIndex < 0) return false;
      const frame = frames[frameIndex];
      const ownsCurrentSlots = currentFrameOwnsSlots(frame);
      frames.splice(frameIndex, 1);
      if (ownsCurrentSlots && base) {
        // Older pending frames have already assembled their own marker.
        // Reinstalling one here would leak a stale identity when callbacks
        // arrive out of order.
        writePromptSlots(structuredClone(base.slots));
      }
      if (frames.length === 0) base = null;
      return true;
    },

    settleAll(activeRunMarker) {
      if (base?.activeRunMarker !== activeRunMarker) return false;
      restoreBaseIfOwned();
      frames.splice(0, frames.length);
      base = null;
      return true;
    },

    reset({ restore = false } = {}) {
      if (restore) restoreBaseIfOwned();
      frames.splice(0, frames.length);
      base = null;
    },

    ownsPromptSlots() {
      return frames.some(currentFrameOwnsSlots);
    },

    frameIds() {
      return frames.map(frame => frame.frameId);
    },

    pendingCount() {
      return frames.length;
    },
  });
}

export function promptMarkerFailureReason({
  markerInspection,
  runtimeSlotPopulated,
  continuitySlotPopulated,
} = {}) {
  if (markerInspection?.status === 'pass') return null;
  if (
    runtimeSlotPopulated === true
    && continuitySlotPopulated === true
    && markerInspection?.runtime_marker_count === 0
    && markerInspection?.continuity_marker_count === 0
  ) {
    return 'host_prompt_assembly_incomplete';
  }
  const safeStatuses = new Set([
    'runtime_marker_missing',
    'continuity_marker_missing',
    'run_identity_mismatch',
    'invalid',
  ]);
  const status = safeStatuses.has(markerInspection?.status)
    ? markerInspection.status
    : 'invalid';
  return `prompt_run_markers_${status}`;
}

function hostPromptBudgetError(message) {
  const error = new Error(message);
  error.reasonCode = 'host_prompt_budget_invalid';
  return error;
}

export function providerInputBudgetFromContext({
  contextTokens,
  outputReserveTokens,
} = {}) {
  if (
    !Number.isSafeInteger(contextTokens)
    || contextTokens <= 0
    || !Number.isSafeInteger(outputReserveTokens)
    || outputReserveTokens < 0
    || outputReserveTokens >= contextTokens
  ) {
    throw hostPromptBudgetError(
      'The configured provider context budget is invalid.',
    );
  }
  return contextTokens - outputReserveTokens;
}

function providerBudgetBindingError(message) {
  const error = new Error(message);
  error.reasonCode = 'provider_budget_binding_invalid';
  return error;
}

function providerBudgetPolicyError(message) {
  const error = new Error(message);
  error.reasonCode = 'provider_budget_policy_invalid';
  return error;
}

export async function normalizeProviderBudgetPolicyHealth(value) {
  const keys = [
    'configured_context_tokens',
    'output_reserve_tokens',
    'policy_hash',
    'provider_input_tokens',
    'request_safety_tokens',
    'schema',
    'status',
    'tokenizer_profile',
  ];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.join(',')
    || value.status !== 'ready'
    || value.schema !== 'mnemosyne.provider-budget-policy.v1'
    || !Number.isSafeInteger(value.configured_context_tokens)
    || value.configured_context_tokens <= 0
    || !Number.isSafeInteger(value.output_reserve_tokens)
    || value.output_reserve_tokens <= 0
    || value.output_reserve_tokens >= value.configured_context_tokens
    || value.provider_input_tokens
      !== value.configured_context_tokens - value.output_reserve_tokens
    || value.tokenizer_profile !== 'openai:o200k_base.v1'
    || value.request_safety_tokens !== 64
    || !/^[a-f0-9]{64}$/.test(value.policy_hash ?? '')
  ) {
    throw providerBudgetPolicyError(
      'Proxy health requires an exact ready provider budget policy.',
    );
  }
  const payload = {
    schema: value.schema,
    configured_context_tokens: value.configured_context_tokens,
    output_reserve_tokens: value.output_reserve_tokens,
    provider_input_tokens: value.provider_input_tokens,
    tokenizer_profile: value.tokenizer_profile,
    request_safety_tokens: value.request_safety_tokens,
  };
  if (await sha256(canonicalJson(payload)) !== value.policy_hash) {
    throw providerBudgetPolicyError(
      'Proxy provider budget policy seal does not match its fields.',
    );
  }
  return Object.freeze({
    ...payload,
    policy_hash: value.policy_hash,
  });
}

export async function createProviderBudgetBinding({
  runId,
  configuredContextTokens,
  outputReserveTokens,
} = {}) {
  if (
    typeof runId !== 'string'
    || !runId
    || !Number.isSafeInteger(configuredContextTokens)
    || configuredContextTokens <= 0
    || !Number.isSafeInteger(outputReserveTokens)
    || outputReserveTokens <= 0
    || outputReserveTokens >= configuredContextTokens
  ) {
    throw providerBudgetBindingError(
      'The configured provider budget fields are invalid.',
    );
  }
  const payload = {
    schema: 'mnemosyne.provider-budget.v1',
    run_id: runId,
    configured_context_tokens: configuredContextTokens,
    output_reserve_tokens: outputReserveTokens,
    provider_input_tokens:
      configuredContextTokens - outputReserveTokens,
  };
  return Object.freeze({
    ...payload,
    binding_hash: await sha256(canonicalJson(payload)),
  });
}

async function normalizeProviderBudgetBinding(value, runId) {
  const keys = [
    'binding_hash',
    'configured_context_tokens',
    'output_reserve_tokens',
    'provider_input_tokens',
    'run_id',
    'schema',
  ];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.join(',')
  ) {
    throw providerBudgetBindingError(
      'Prompt trace requires an exact provider budget binding.',
    );
  }
  let expected;
  try {
    expected = await createProviderBudgetBinding({
      runId: value.run_id,
      configuredContextTokens: value.configured_context_tokens,
      outputReserveTokens: value.output_reserve_tokens,
    });
  } catch {
    throw providerBudgetBindingError(
      'Prompt trace provider budget fields are invalid.',
    );
  }
  if (
    value.run_id !== runId
    || value.provider_input_tokens !== expected.provider_input_tokens
    || value.binding_hash !== expected.binding_hash
  ) {
    throw providerBudgetBindingError(
      'Prompt trace provider budget no longer matches its run or seal.',
    );
  }
  return expected;
}

export function buildHostAssemblySourceCandidates({
  absorbedSourceKinds = [],
  worldInfoEntries = [],
  skipWIAN = false,
  characterFields = {},
  personaPosition = null,
  directPersonaPositions = [0],
  formatWorldInfoValue = value => value,
  preparePrompt = prompt => prompt,
} = {}) {
  if (
    typeof formatWorldInfoValue !== 'function'
    || typeof preparePrompt !== 'function'
  ) {
    throw hostPromptBudgetError(
      'Host assembly prompt adapters are invalid.',
    );
  }
  const absorbed = new Set(absorbedSourceKinds);
  const candidates = [];
  const appendSource = (
    sourceKind,
    identifier,
    role,
    content,
  ) => {
    const sourceContent = String(content ?? '');
    if (sourceContent === '') return;
    const prepared = preparePrompt({
      identifier,
      role,
      content: sourceContent,
    });
    if (
      !prepared
      || typeof prepared !== 'object'
      || Array.isArray(prepared)
    ) {
      throw hostPromptBudgetError(
        'PromptManager returned an invalid prepared source prompt.',
      );
    }
    const preparedContent = String(prepared.content ?? '');
    if (preparedContent === '') return;
    if (
      prepared.role !== 'system'
      && prepared.role !== 'user'
      && prepared.role !== 'assistant'
    ) {
      throw hostPromptBudgetError(
        'PromptManager returned an invalid source prompt role.',
      );
    }
    candidates.push({
      role: prepared.role,
      content: preparedContent,
      source_kind: sourceKind,
    });
  };
  const appendSystemSource = (
    sourceKind,
    identifier,
    content,
  ) => {
    appendSource(sourceKind, identifier, 'system', content);
  };

  if (absorbed.has('raw_worldbook')) {
    const contentByPosition = new Map();
    const contentByDepthAndRole = new Map();
    const contentByOutlet = new Map();
    const sortedEntries = worldInfoEntries
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        const orderDelta =
          Number(right.entry?.order) - Number(left.entry?.order);
        return Number.isFinite(orderDelta) && orderDelta !== 0
          ? orderDelta
          : left.index - right.index;
      });
    for (const { entry } of sortedEntries) {
      const position = Number(entry?.position);
      const content = String(entry?.content ?? '');
      if (content === '') continue;
      if (DIRECT_WORLD_INFO_POSITIONS.has(position)) {
        const grouped = contentByPosition.get(position) ?? [];
        grouped.unshift(content);
        contentByPosition.set(position, grouped);
        continue;
      }
      if (
        skipWIAN !== true
        && position === WORLD_INFO_AT_DEPTH_POSITION
      ) {
        const rawDepth = Number(entry?.depth);
        const depth = Number.isSafeInteger(rawDepth) && rawDepth >= 0
          ? rawDepth
          : DEFAULT_WORLD_INFO_DEPTH;
        const rawRole = Number(entry?.role);
        const roleCode = MESSAGE_ROLE_BY_EXTENSION_ROLE.has(rawRole)
          ? rawRole
          : 0;
        const key = `${depth}:${roleCode}`;
        const grouped = contentByDepthAndRole.get(key) ?? {
          depth,
          roleCode,
          contents: [],
        };
        grouped.contents.unshift(content);
        contentByDepthAndRole.set(key, grouped);
        continue;
      }
      if (
        skipWIAN !== true
        && position === WORLD_INFO_OUTLET_POSITION
        && String(entry?.outletName ?? '') !== ''
      ) {
        const outletName = String(entry.outletName);
        const grouped = contentByOutlet.get(outletName) ?? [];
        grouped.push(content);
        contentByOutlet.set(outletName, grouped);
      }
    }
    for (const position of [0, 1]) {
      const grouped = contentByPosition.get(position);
      if (!grouped) continue;
      appendSystemSource(
        'raw_worldbook',
        position === 0 ? 'worldInfoBefore' : 'worldInfoAfter',
        formatWorldInfoValue(grouped.join('\n')),
      );
    }
    for (
      const group of [...contentByDepthAndRole.values()].sort((
        left,
        right,
      ) => (
        left.depth - right.depth
        || left.roleCode - right.roleCode
      ))
    ) {
      appendSource(
        'raw_worldbook',
        `customDepthWI_${group.depth}_${group.roleCode}`,
        MESSAGE_ROLE_BY_EXTENSION_ROLE.get(group.roleCode),
        group.contents.join('\n'),
      );
    }
    for (const [outletName, contents] of contentByOutlet) {
      appendSystemSource(
        'raw_worldbook',
        `customWIOutlet_${outletName}`,
        contents.join('\n'),
      );
    }
  }
  if (absorbed.has('raw_character_card')) {
    appendSystemSource(
      'raw_character_card',
      'charDescription',
      characterFields?.description,
    );
    appendSystemSource(
      'raw_character_card',
      'charPersonality',
      characterFields?.personality,
    );
  }
  if (absorbed.has('raw_scenario')) {
    appendSystemSource(
      'raw_scenario',
      'scenario',
      characterFields?.scenario,
    );
  }
  if (
    absorbed.has('raw_persona')
    && directPersonaPositions.map(Number).includes(Number(personaPosition))
  ) {
    appendSystemSource(
      'raw_persona',
      'personaDescription',
      characterFields?.persona,
    );
  }

  return candidates;
}

export async function createHostAssemblyBaseSourceSeal({
  absorbedSourceKinds = [],
  characterFields = {},
  personaPosition = null,
  directPersonaPositions = [0],
  worldInfoFormat = '',
  personalityFormat = '',
  scenarioFormat = '',
} = {}) {
  const absorbed = new Set(absorbedSourceKinds);
  const payload = {
    schema: 'mnemosyne.host-assembly-base-source.v1',
    absorbed_source_kinds: [...absorbed].sort(),
  };
  if (absorbed.has('raw_worldbook')) {
    payload.world_info_format = String(worldInfoFormat ?? '');
  }
  if (absorbed.has('raw_character_card')) {
    payload.character_description =
      String(characterFields?.description ?? '');
    payload.character_personality =
      String(characterFields?.personality ?? '');
    payload.personality_format = String(personalityFormat ?? '');
  }
  if (absorbed.has('raw_scenario')) {
    payload.scenario = String(characterFields?.scenario ?? '');
    payload.scenario_format = String(scenarioFormat ?? '');
  }
  if (absorbed.has('raw_persona')) {
    payload.persona = String(characterFields?.persona ?? '');
    payload.persona_position = Number(personaPosition);
    payload.direct_persona_positions =
      directPersonaPositions.map(Number);
  }
  return Object.freeze({
    schema: 'mnemosyne.host-assembly-base-source-seal.v1',
    source_hash: await sha256(canonicalJson(payload)),
  });
}

export function createHostAssemblyBudgetPlan({
  configuredContextTokens,
  outputReserveTokens,
  removableSourceTokens,
  safetyReserveTokens = 1_024,
} = {}) {
  const providerInputTokens = providerInputBudgetFromContext({
    contextTokens: configuredContextTokens,
    outputReserveTokens,
  });
  if (
    !Number.isSafeInteger(removableSourceTokens)
    || removableSourceTokens < 0
    || !Number.isSafeInteger(safetyReserveTokens)
    || safetyReserveTokens < 0
    || safetyReserveTokens >= providerInputTokens
  ) {
    throw hostPromptBudgetError(
      'The removable-source assembly budget is invalid.',
    );
  }
  const sourceSurchargeTokens = Math.max(
    0,
    removableSourceTokens - safetyReserveTokens,
  );
  const hostContextTokens =
    configuredContextTokens + sourceSurchargeTokens;
  if (!Number.isSafeInteger(hostContextTokens)) {
    throw hostPromptBudgetError(
      'The host assembly context exceeds the safe numeric range.',
    );
  }
  return {
    schema: 'mnemosyne.host-assembly-budget.v1',
    configured_context_tokens: configuredContextTokens,
    output_reserve_tokens: outputReserveTokens,
    provider_input_tokens: providerInputTokens,
    removable_source_tokens: removableSourceTokens,
    safety_reserve_tokens: safetyReserveTokens,
    source_surcharge_tokens: sourceSurchargeTokens,
    host_context_tokens: hostContextTokens,
    maximum_retained_input_tokens:
      hostContextTokens
      - outputReserveTokens
      - removableSourceTokens,
  };
}

export function promptMessagesBelongToRun(messages, runId) {
  return inspectPromptRunMarkers(messages, runId).status === 'pass';
}

function sourceLabel(identifier, presetPromptIdentifiers) {
  if (identifier === 'tavern_mnemosyne_runtime_contract') {
    return 'mnemosyne_runtime_contract';
  }
  if (identifier === 'tavern_mnemosyne_continuity_payload') {
    return 'mnemosyne_continuity_payload';
  }
  if (RAW_SOURCE_LABELS.has(identifier)) {
    return RAW_SOURCE_LABELS.get(identifier);
  }
  if (WORLD_INFO_DEPTH_IDENTIFIER.test(String(identifier ?? ''))) {
    return 'raw_worldbook';
  }
  if (/^chatHistory-\d+$/.test(String(identifier ?? ''))) {
    return 'host_recent_chat';
  }
  if (presetPromptIdentifiers.has(identifier)) {
    return 'host_preset';
  }
  return identifier ? 'host_prompt_unknown' : 'host_recent_chat';
}

async function sourceRouteOverrideMap(
  sourceRouteOverrides,
  messageCount,
  componentProvenance = new Map(),
) {
  const byIndex = new Map();
  const identifiers = new Set();
  for (const override of sourceRouteOverrides ?? []) {
    if (
      !Number.isInteger(override?.internal_index)
      || override.internal_index < 0
      || override.internal_index >= messageCount
      || !WORLD_INFO_DEPTH_IDENTIFIER.test(String(override.identifier ?? ''))
      || override.source_label !== 'raw_worldbook'
      || byIndex.has(override.internal_index)
      || identifiers.has(override.identifier)
    ) {
      throw new Error('World Info depth source-route override is invalid or ambiguous.');
    }
    const component = override.component_provenance
      ? await validateHostComponentProvenance(
        override.component_provenance,
        { identifier: override.identifier },
      )
      : await resolveHostComponentProvenance({
        identifier: override.identifier,
        components: componentProvenance,
      });
    const expectedComponent = componentProvenance.get(
      override.identifier,
    );
    if (
      expectedComponent
      && expectedComponent.component_hash !== component.component_hash
    ) {
      const error = new Error(
        'World Info depth source-route provenance no longer matches.',
      );
      error.reasonCode = 'host_component_provenance_drift';
      throw error;
    }
    byIndex.set(override.internal_index, {
      ...structuredClone(override),
      component_provenance: component,
    });
    identifiers.add(override.identifier);
  }
  return byIndex;
}

export async function buildWorldInfoDepthRouteOverrides({
  internalMessages = [],
  extensionPrompts = {},
  componentProvenance = [],
} = {}) {
  const normalizedComponentProvenance =
    await normalizeHostComponentProvenance(componentProvenance);
  const candidates = [];
  const unresolved = [];

  for (const [identifier, prompt] of Object.entries(extensionPrompts)) {
    const routeMatch = identifier.match(WORLD_INFO_DEPTH_IDENTIFIER);
    if (!routeMatch) continue;
    const role = Number(routeMatch[2]);
    const expectedRole = MESSAGE_ROLE_BY_EXTENSION_ROLE.get(role);
    const content = String(prompt?.value ?? '').trim();
    if (!content) continue;
    const matches = [];
    for (let index = 0; index < internalMessages.length; index += 1) {
      const message = internalMessages[index];
      if (
        message?.role === expectedRole
        && String(message?.content ?? '') === content
      ) {
        matches.push(index);
      }
    }
    if (matches.length !== 1) {
      unresolved.push({
        identifier,
        source_label: 'raw_worldbook',
        reason_code: matches.length === 0
          ? 'prompt_source_mapping_missing'
          : 'prompt_source_mapping_ambiguous',
        route: 'at_depth',
      });
      continue;
    }
    const component = await resolveHostComponentProvenance({
      identifier,
      components: normalizedComponentProvenance,
    });
    candidates.push({
      identifier,
      source_label: 'raw_worldbook',
      internal_index: matches[0],
      prompt_message_hash: await matchingHash(internalMessages[matches[0]]),
      component_provenance: component,
    });
  }

  const countsByIndex = new Map();
  for (const candidate of candidates) {
    countsByIndex.set(
      candidate.internal_index,
      (countsByIndex.get(candidate.internal_index) ?? 0) + 1,
    );
  }
  const overrides = [];
  for (const candidate of candidates) {
    if (countsByIndex.get(candidate.internal_index) !== 1) {
      unresolved.push({
        identifier: candidate.identifier,
        source_label: candidate.source_label,
        reason_code: 'prompt_source_mapping_ambiguous',
        route: 'at_depth',
      });
      continue;
    }
    overrides.push(candidate);
  }

  return {
    overrides: overrides.sort((left, right) => (
      left.identifier.localeCompare(right.identifier)
    )),
    unresolved: unresolved.sort((left, right) => (
      left.identifier.localeCompare(right.identifier)
    )),
  };
}

function matchingShape(message) {
  return {
    role: message?.role ?? null,
    name: message?.name ?? null,
    content: message?.content ?? null,
  };
}

function hasContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.length > 0;
  return content !== undefined && content !== null;
}

async function matchingHash(message) {
  return sha256(canonicalJson(matchingShape(message)));
}

export async function hashPromptMessageShape(message) {
  return matchingHash(message);
}

class HostTransformFenceError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'HostTransformFenceError';
    this.reasonCode = reasonCode;
  }
}

function hostTransformFenceError(reasonCode, message) {
  return new HostTransformFenceError(reasonCode, message);
}

function messageTextOccurrences(messages, text) {
  const occurrences = [];
  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const content = messages[messageIndex]?.content;
    if (typeof content !== 'string') continue;
    let start = content.indexOf(text);
    while (start >= 0) {
      occurrences.push({ messageIndex, start });
      start = content.indexOf(text, start + 1);
    }
  }
  return occurrences;
}

function safeFenceId(randomUUID) {
  const value = String(randomUUID?.() ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '');
  if (!value) {
    throw hostTransformFenceError(
      'host_transform_fence_nonce_invalid',
      'Host transform fencing requires a non-empty random lease id.',
    );
  }
  return value;
}

function assertNonOverlappingFenceSpans(entries, {
  startKey,
  endKey,
  messageKey,
  reasonCode,
}) {
  const byMessage = new Map();
  for (const entry of entries) {
    const messageIndex = entry[messageKey];
    const spans = byMessage.get(messageIndex) ?? [];
    spans.push(entry);
    byMessage.set(messageIndex, spans);
  }
  for (const spans of byMessage.values()) {
    spans.sort((left, right) => (
      left[startKey] - right[startKey]
      || left[endKey] - right[endKey]
    ));
    for (let index = 1; index < spans.length; index += 1) {
      if (spans[index][startKey] < spans[index - 1][endKey]) {
        throw hostTransformFenceError(
          reasonCode,
          'Host transform source fences overlap or nest.',
        );
      }
    }
  }
}

export async function createHostTransformFenceLease({
  workingMessages,
  internalMessages,
  promptTrace,
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (
    !Array.isArray(workingMessages)
    || !Array.isArray(internalMessages)
    || !Array.isArray(promptTrace?.prompt_manager?.entries)
    || typeof promptTrace?.run_id !== 'string'
    || !promptTrace.run_id
  ) {
    throw hostTransformFenceError(
      'host_transform_fence_input_invalid',
      'Host transform fencing requires one exact prompt trace.',
    );
  }
  const candidates = promptTrace.prompt_manager.entries.filter(entry => (
    entry?.retention_policy === 'retain'
    && RAW_AUTHOR_SOURCE_LABELS.has(entry?.source_label)
    && entry?.component_provenance
    && Number.isInteger(entry.provider_index)
    && Number.isInteger(entry.provider_content_start)
    && Number.isInteger(entry.provider_content_end)
  ));
  if (candidates.length === 0) {
    return {
      messages: structuredClone(workingMessages),
      lease: null,
    };
  }

  const leaseId = safeFenceId(randomUUID);
  const entries = [];
  for (const candidate of candidates) {
    const internal = internalMessages[candidate.order];
    const internalContent = internal?.content;
    const providerContent =
      workingMessages[candidate.provider_index]?.content;
    const start = candidate.provider_content_start;
    const end = candidate.provider_content_end;
    if (
      typeof internalContent !== 'string'
      || internalContent.length === 0
      || typeof providerContent !== 'string'
      || start < 0
      || end <= start
      || end > providerContent.length
      || providerContent.slice(start, end) !== internalContent
      || await matchingHash(internal)
        !== candidate.prompt_message_hash
    ) {
      throw hostTransformFenceError(
        'host_transform_fence_source_drift',
        'A retained author source lost its exact pre-transform span.',
      );
    }
    const markerBase = (
      `${HOST_TRANSFORM_MARKER_PREFIX}${leaseId}:`
      + `${candidate.order}`
    );
    const startMarker = `${markerBase}:START${HOST_TRANSFORM_MARKER_SUFFIX}`;
    const endMarker = `${markerBase}:END${HOST_TRANSFORM_MARKER_SUFFIX}`;
    if (
      workingMessages.some(message => (
        typeof message?.content === 'string'
        && (
          message.content.includes(startMarker)
          || message.content.includes(endMarker)
        )
      ))
    ) {
      throw hostTransformFenceError(
        'host_transform_fence_marker_collision',
        'A host transform fence marker already exists in the prompt.',
      );
    }
    entries.push({
      identifier: candidate.identifier,
      source_label: candidate.source_label,
      internal_order: candidate.order,
      role: candidate.role,
      name: candidate.name ?? null,
      original_prompt_message_hash:
        candidate.prompt_message_hash,
      message_index: candidate.provider_index,
      start,
      end,
      start_marker: startMarker,
      end_marker: endMarker,
    });
  }
  assertNonOverlappingFenceSpans(entries, {
    startKey: 'start',
    endKey: 'end',
    messageKey: 'message_index',
    reasonCode: 'host_transform_fence_span_overlap',
  });

  const messages = structuredClone(workingMessages);
  const byMessage = new Map();
  for (const entry of entries) {
    const spans = byMessage.get(entry.message_index) ?? [];
    spans.push(entry);
    byMessage.set(entry.message_index, spans);
  }
  for (const [messageIndex, spans] of byMessage) {
    spans.sort((left, right) => right.start - left.start);
    let content = messages[messageIndex].content;
    for (const span of spans) {
      if (content.slice(span.start, span.end)
        !== internalMessages[span.internal_order].content) {
        throw hostTransformFenceError(
          'host_transform_fence_source_drift',
          'A retained author source changed while fences were installed.',
        );
      }
      content = (
        content.slice(0, span.start)
        + span.start_marker
        + content.slice(span.start, span.end)
        + span.end_marker
        + content.slice(span.end)
      );
    }
    messages[messageIndex].content = content;
  }

  return {
    messages,
    lease: Object.freeze({
      schema: HOST_TRANSFORM_FENCE_SCHEMA,
      run_id: promptTrace.run_id,
      lease_id: leaseId,
      entries: Object.freeze(
        entries.map(entry => Object.freeze({ ...entry })),
      ),
    }),
  };
}

export async function restoreHostTransformFenceLease({
  workingMessages,
  lease,
} = {}) {
  if (
    !Array.isArray(workingMessages)
    || lease?.schema !== HOST_TRANSFORM_FENCE_SCHEMA
    || typeof lease.run_id !== 'string'
    || !lease.run_id
    || !Array.isArray(lease.entries)
    || lease.entries.length === 0
  ) {
    throw hostTransformFenceError(
      'host_transform_fence_lease_invalid',
      'Host transform restoration requires one active fence lease.',
    );
  }

  const observed = [];
  for (const entry of lease.entries) {
    const startMatches = messageTextOccurrences(
      workingMessages,
      entry.start_marker,
    );
    const endMatches = messageTextOccurrences(
      workingMessages,
      entry.end_marker,
    );
    if (startMatches.length !== 1 || endMatches.length !== 1) {
      throw hostTransformFenceError(
        startMatches.length === 0 || endMatches.length === 0
          ? 'host_transform_fence_marker_missing'
          : 'host_transform_fence_marker_ambiguous',
        'A host transform fence was not preserved exactly once.',
      );
    }
    const startMatch = startMatches[0];
    const endMatch = endMatches[0];
    const message = workingMessages[startMatch.messageIndex];
    const bodyStart =
      startMatch.start + entry.start_marker.length;
    const bodyEnd = endMatch.start;
    if (
      startMatch.messageIndex !== endMatch.messageIndex
      || bodyEnd <= bodyStart
      || message?.role !== entry.role
      || (message?.name ?? null) !== entry.name
    ) {
      throw hostTransformFenceError(
        'host_transform_fence_coordinate_drift',
        'A host transform fence changed role, order, or message boundary.',
      );
    }
    observed.push({
      ...entry,
      message_index: startMatch.messageIndex,
      marker_start: startMatch.start,
      body_start: bodyStart,
      body_end: bodyEnd,
      marker_end:
        endMatch.start + entry.end_marker.length,
    });
  }
  assertNonOverlappingFenceSpans(observed, {
    startKey: 'marker_start',
    endKey: 'marker_end',
    messageKey: 'message_index',
    reasonCode: 'host_transform_fence_coordinate_drift',
  });

  const markersByMessage = new Map();
  for (const entry of observed) {
    const markers = markersByMessage.get(entry.message_index) ?? [];
    markers.push(
      {
        position: entry.marker_start,
        text: entry.start_marker,
      },
      {
        position: entry.body_end,
        text: entry.end_marker,
      },
    );
    markersByMessage.set(entry.message_index, markers);
  }
  const messages = structuredClone(workingMessages);
  for (const [messageIndex, markers] of markersByMessage) {
    markers.sort((left, right) => right.position - left.position);
    let content = messages[messageIndex].content;
    for (const marker of markers) {
      if (
        content.slice(
          marker.position,
          marker.position + marker.text.length,
        ) !== marker.text
      ) {
        throw hostTransformFenceError(
          'host_transform_fence_marker_drift',
          'A host transform fence changed during restoration.',
        );
      }
      content = (
        content.slice(0, marker.position)
        + content.slice(marker.position + marker.text.length)
      );
    }
    messages[messageIndex].content = content;
  }

  const overrides = [];
  for (const entry of observed) {
    const markers = markersByMessage.get(entry.message_index);
    const removedBeforeStart = markers
      .filter(marker => marker.position < entry.body_start)
      .reduce((total, marker) => total + marker.text.length, 0);
    const removedBeforeEnd = markers
      .filter(marker => marker.position < entry.body_end)
      .reduce((total, marker) => total + marker.text.length, 0);
    const start = entry.body_start - removedBeforeStart;
    const end = entry.body_end - removedBeforeEnd;
    const message = messages[entry.message_index];
    const content = message?.content;
    if (
      typeof content !== 'string'
      || start < 0
      || end <= start
      || end > content.length
      || content.includes(entry.start_marker)
      || content.includes(entry.end_marker)
    ) {
      throw hostTransformFenceError(
        'host_transform_fence_output_invalid',
        'A host transform produced an invalid retained source span.',
      );
    }
    overrides.push({
      schema: HOST_TRANSFORM_OVERRIDE_SCHEMA,
      run_id: lease.run_id,
      identifier: entry.identifier,
      source_label: entry.source_label,
      internal_order: entry.internal_order,
      original_prompt_message_hash:
        entry.original_prompt_message_hash,
      provider_index: entry.message_index,
      provider_content_start: start,
      provider_content_end: end,
      transformed_prompt_message_hash:
        await matchingHash({
          role: entry.role,
          name: entry.name,
          content: content.slice(start, end),
        }),
    });
  }
  const byInternalOrder = [...overrides].sort((
    left,
    right,
  ) => left.internal_order - right.internal_order);
  const byProviderCoordinate = [...overrides].sort((
    left,
    right,
  ) => (
    left.provider_index - right.provider_index
    || left.provider_content_start - right.provider_content_start
  ));
  if (
    canonicalJson(byInternalOrder.map(entry => entry.internal_order))
      !== canonicalJson(
        byProviderCoordinate.map(entry => entry.internal_order),
      )
  ) {
    throw hostTransformFenceError(
      'host_transform_fence_coordinate_drift',
      'Host transform source fences changed their stable order.',
    );
  }

  return {
    messages,
    overrides,
  };
}

export async function hashProviderMessage(message) {
  return sha256(canonicalJson(message));
}

const PROMPT_POST_PROCESSING_OPTIONS = new Map([
  ['claude', {
    strict: false,
    placeholders: false,
    single: false,
    tools: false,
  }],
  ['merge', {
    strict: false,
    placeholders: false,
    single: false,
    tools: false,
  }],
  ['merge_tools', {
    strict: false,
    placeholders: false,
    single: false,
    tools: true,
  }],
  ['semi', {
    strict: true,
    placeholders: false,
    single: false,
    tools: false,
  }],
  ['semi_tools', {
    strict: true,
    placeholders: false,
    single: false,
    tools: true,
  }],
  ['strict', {
    strict: true,
    placeholders: true,
    single: false,
    tools: false,
  }],
  ['strict_tools', {
    strict: true,
    placeholders: true,
    single: false,
    tools: true,
  }],
  ['single', {
    strict: true,
    placeholders: false,
    single: true,
    tools: false,
  }],
]);

function normalizedPromptNames({
  charName = '',
  userName = '',
  groupNames = [],
} = {}) {
  const normalizedGroups = Array.isArray(groupNames)
    ? groupNames.map(String)
    : [];
  return {
    charName: String(charName || ''),
    userName: String(userName || ''),
    groupNames: normalizedGroups,
    startsWithGroupName(message) {
      return normalizedGroups.some(name => (
        String(message).startsWith(`${name}: `)
      ));
    },
  };
}

function squashSystemMessageCopies(messages) {
  const excludedIdentifiers = new Set([
    'newMainChat',
    'newChat',
    'groupNudge',
  ]);
  const squashed = [];
  let previous = null;
  const shouldSquash = message => (
    !excludedIdentifiers.has(message?.identifier)
    && message?.role === 'system'
    && !message?.name
  );

  for (const original of structuredClone(messages)) {
    if (original?.role === 'system' && !original?.content) continue;
    if (shouldSquash(original) && previous && shouldSquash(previous)) {
      previous.content += `\n${original.content}`;
      continue;
    }
    squashed.push(original);
    previous = original;
  }

  return squashed;
}

function mergePromptMessageCopies(messages, names, {
  strict = false,
  placeholders = false,
  single = false,
  tools = false,
  promptPlaceholder = 'Let\'s get started.',
} = {}) {
  const working = structuredClone(messages);
  const mediaTokens = new Map();
  let mediaIndex = 0;

  for (const message of working) {
    if (!message.content) message.content = '';
    if (Array.isArray(message.content)) {
      message.content = message.content.map(part => {
        if (part?.type === 'text') return String(part.text ?? '');
        if (['image_url', 'video_url', 'audio_url'].includes(part?.type)) {
          const token = `__MNEMOSYNE_MEDIA_${mediaIndex}__`;
          mediaIndex += 1;
          mediaTokens.set(token, part);
          return token;
        }
        return '';
      }).join('\n\n');
    }
    if (
      message.role === 'system'
      && message.name === 'example_assistant'
      && names.charName
      && !message.content.startsWith(`${names.charName}: `)
      && !names.startsWithGroupName(message.content)
    ) {
      message.content = `${names.charName}: ${message.content}`;
    }
    if (
      message.role === 'system'
      && message.name === 'example_user'
      && names.userName
      && !message.content.startsWith(`${names.userName}: `)
    ) {
      message.content = `${names.userName}: ${message.content}`;
    }
    if (
      message.name
      && message.role !== 'system'
      && !message.content.startsWith(`${message.name}: `)
    ) {
      message.content = `${message.name}: ${message.content}`;
    }
    if (message.role === 'tool' && !tools) message.role = 'user';
    if (single) {
      if (
        message.role === 'assistant'
        && names.charName
        && !message.content.startsWith(`${names.charName}: `)
        && !names.startsWithGroupName(message.content)
      ) {
        message.content = `${names.charName}: ${message.content}`;
      }
      if (
        message.role === 'user'
        && names.userName
        && !message.content.startsWith(`${names.userName}: `)
      ) {
        message.content = `${names.userName}: ${message.content}`;
      }
      message.role = 'user';
    }
    delete message.name;
    if (!tools) {
      delete message.tool_calls;
      delete message.tool_call_id;
    }
  }

  const merged = [];
  for (const message of working) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.role === message.role
      && message.content
      && message.role !== 'tool'
    ) {
      previous.content += `\n\n${message.content}`;
    } else {
      merged.push(message);
    }
  }

  if (merged.length === 0) {
    merged.push({ role: 'user', content: promptPlaceholder });
  }

  if (mediaTokens.size > 0) {
    for (const message of merged) {
      if (
        typeof message.content !== 'string'
        || ![...mediaTokens.keys()].some(token => message.content.includes(token))
      ) {
        continue;
      }
      const restored = [];
      for (const content of message.content.split('\n\n')) {
        if (mediaTokens.has(content)) {
          restored.push(mediaTokens.get(content));
        } else if (restored.at(-1)?.type === 'text') {
          restored.at(-1).text += `\n\n${content}`;
        } else {
          restored.push({ type: 'text', text: content });
        }
      }
      message.content = restored;
    }
  }

  if (!strict) return merged;

  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index].role === 'system') merged[index].role = 'user';
  }
  if (placeholders) {
    if (
      merged[0]?.role === 'system'
      && (merged.length === 1 || merged[1]?.role !== 'user')
    ) {
      merged.splice(1, 0, { role: 'user', content: promptPlaceholder });
    } else if (
      merged[0]?.role !== 'system'
      && merged[0]?.role !== 'user'
    ) {
      merged.unshift({ role: 'user', content: promptPlaceholder });
    }
  }
  return mergePromptMessageCopies(merged, names, {
    strict: false,
    placeholders,
    single: false,
    tools,
    promptPlaceholder,
  });
}

export function applyHostMessageTransforms(messages, {
  squashSystemMessages = false,
  squashAlreadyApplied = false,
  customPromptPostProcessing = '',
  promptNames = {},
  promptPlaceholder = 'Let\'s get started.',
} = {}) {
  if (!Array.isArray(messages)) {
    throw new Error('Host message transforms require a message array.');
  }

  let transformed = structuredClone(messages);
  if (squashSystemMessages && !squashAlreadyApplied) {
    transformed = squashSystemMessageCopies(transformed);
  }

  const postProcessing = String(customPromptPostProcessing || '');
  const options = PROMPT_POST_PROCESSING_OPTIONS.get(postProcessing);
  if (options) {
    transformed = mergePromptMessageCopies(
      transformed,
      normalizedPromptNames(promptNames),
      { ...options, promptPlaceholder },
    );
  }

  return transformed;
}

export function isLegacyTavernDbWorldbookEntry(entry) {
  const values = [
    entry?.comment,
    ...(Array.isArray(entry?.key) ? entry.key : [entry?.key]),
    ...(Array.isArray(entry?.keysecondary)
      ? entry.keysecondary
      : [entry?.keysecondary]),
  ];
  return values.some(value => (
    /^taverndb-acu-/iu.test(
      String(value ?? '').replace(/^[\s\u200b-\u200d\ufeff]+/u, ''),
    )
  ));
}

export function partitionLegacyTavernDbWorldInfoEntries(entries = []) {
  if (
    entries === null
    || entries === undefined
    || typeof entries[Symbol.iterator] !== 'function'
  ) {
    throw new Error(
      'Activated World Info entries must be iterable.',
    );
  }
  const retainedEntries = [];
  const suppressedLegacyEntries = [];
  for (const entry of entries) {
    (
      isLegacyTavernDbWorldbookEntry(entry)
        ? suppressedLegacyEntries
        : retainedEntries
    ).push(entry);
  }
  return {
    retainedEntries,
    suppressedLegacyEntries,
  };
}

function withoutLegacyWorldbookEntries(worldbook) {
  if (!worldbook || typeof worldbook !== 'object') {
    return structuredClone(worldbook);
  }
  const { entries, ...metadata } = worldbook;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return structuredClone(worldbook);
  }
  const retainedEntries = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (isLegacyTavernDbWorldbookEntry(entry)) continue;
    retainedEntries[key] = structuredClone(entry);
  }
  return {
    ...structuredClone(metadata),
    entries: retainedEntries,
  };
}

export function normalizeWorldbookMemoryData(worldbook) {
  const normalized = withoutLegacyWorldbookEntries(worldbook);
  for (const entry of Object.values(normalized?.entries ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    delete entry.order;
    delete entry.displayIndex;
    delete entry.display_index;
  }
  return normalized;
}

export function parseSavedCharacterCard(characterResponse) {
  const rawCard = characterResponse?.json_data;
  if (typeof rawCard !== 'string' || !rawCard.trim()) {
    throw new Error('The saved character card does not contain its source JSON.');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawCard);
  } catch {
    throw new Error('The saved character card source JSON is invalid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The saved character card source must be an object.');
  }
  return parsed;
}

function normalizedCharacterCardSource(characterCard) {
  const isVersionedCard = (
    /^chara_card_v\d+$/i.test(String(characterCard?.spec ?? ''))
    && characterCard.data
    && typeof characterCard.data === 'object'
    && !Array.isArray(characterCard.data)
  );
  return {
    data: structuredClone(
      isVersionedCard ? characterCard.data : characterCard,
    ),
    ...(isVersionedCard
      ? { raw_data: structuredClone(characterCard) }
      : {}),
  };
}

export function buildStaticLoreSources({
  characterCard,
  worldbooks = [],
  persona,
  scenario,
} = {}) {
  if (!characterCard || typeof characterCard !== 'object') {
    throw new Error('An active character card is required for Static Lore Intake.');
  }
  const sources = [{
    source_id: 'character-card:active',
    source_kind: 'character_card',
    host_ref: 'sillytavern://character/active',
    ...normalizedCharacterCardSource(characterCard),
  }];

  for (const worldbook of [...worldbooks].sort(
    (left, right) => String(left.name).localeCompare(String(right.name)),
  )) {
    if (!String(worldbook?.name || '').trim() || !worldbook.data) {
      throw new Error('Every active worldbook requires a name and lossless data.');
    }
    const filteredWorldbook = withoutLegacyWorldbookEntries(worldbook.data);
    sources.push({
      source_id: `worldbook:${worldbook.name}`,
      source_kind: 'worldbook',
      host_ref: `sillytavern://world/${encodeURIComponent(worldbook.name)}`,
      data: normalizeWorldbookMemoryData(filteredWorldbook),
      raw_data: filteredWorldbook,
    });
  }
  if (String(persona?.description || '').trim()) {
    sources.push({
      source_id: 'persona:active',
      source_kind: 'persona',
      host_ref: 'sillytavern://persona/active',
      data: structuredClone(persona),
    });
  }
  if (String(scenario?.content || '').trim()) {
    sources.push({
      source_id: 'scenario:active',
      source_kind: 'scenario',
      host_ref: 'sillytavern://scenario/active',
      data: structuredClone(scenario),
    });
  }
  return sources;
}

export async function buildSourcePromptFingerprints({
  internalMessages,
  absorbedSourceKinds,
  sourceRouteOverrides = [],
  componentProvenance = [],
} = {}) {
  const absorbed = new Set(absorbedSourceKinds ?? []);
  const normalizedComponentProvenance =
    await normalizeHostComponentProvenance(componentProvenance);
  const overrides = await sourceRouteOverrideMap(
    sourceRouteOverrides,
    internalMessages?.length ?? 0,
    normalizedComponentProvenance,
  );
  const fingerprints = [];
  const identifiers = new Set();
  for (let index = 0; index < (internalMessages ?? []).length; index += 1) {
    const message = internalMessages[index];
    const override = overrides.get(index);
    const identifier = override?.identifier ?? message?.identifier;
    const label = override?.source_label ?? RAW_SOURCE_LABELS.get(identifier);
    if (
      !label
      || !absorbed.has(label)
      || !hasContent(message)
      || identifiers.has(identifier)
    ) {
      continue;
    }
    const promptMessageHash = await matchingHash(message);
    if (
      override?.prompt_message_hash
      && override.prompt_message_hash !== promptMessageHash
    ) {
      throw new Error('World Info depth source-route hash no longer matches.');
    }
    identifiers.add(identifier);
    const component = override?.component_provenance
      ?? await resolveHostComponentProvenance({
        identifier,
        components: normalizedComponentProvenance,
      });
    fingerprints.push({
      identifier,
      source_label: label,
      prompt_message_hash: promptMessageHash,
      component_provenance: structuredClone(component),
    });
  }
  return fingerprints.sort((left, right) => (
    left.identifier.localeCompare(right.identifier)
  ));
}

export function normalizeLoopbackProxyBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_PROXY_BASE_URL).trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Agent Proxy must use HTTP or HTTPS.');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Agent Proxy must use a loopback host.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Agent Proxy URL cannot contain credentials, query, or fragment data.');
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export function inspectHostProfile({
  mainApi,
  chatCompletionSource,
  customUrl,
  proxyBaseUrl,
  squashSystemMessages,
  customPromptPostProcessing,
  connectionProfileName,
  presetName,
  model,
  expectedHostBinding,
} = {}) {
  let normalizedProxyBaseUrl;
  try {
    normalizedProxyBaseUrl = normalizeLoopbackProxyBaseUrl(proxyBaseUrl);
  } catch {
    return {
      status: 'blocked',
      reason_code: 'proxy_url_invalid',
    };
  }

  const expectedCustomUrl = `${normalizedProxyBaseUrl}/v1`;
  const normalizedCustomUrl = String(customUrl || '').trim().replace(/\/+$/, '');
  let reasonCode = null;

  if (mainApi !== 'openai') {
    reasonCode = 'transport_not_chat_completion';
  } else if (chatCompletionSource !== 'custom') {
    reasonCode = 'chat_completion_source_not_custom';
  } else if (normalizedCustomUrl !== expectedCustomUrl) {
    reasonCode = 'custom_url_not_agent_proxy';
  } else if (!expectedHostBinding) {
    reasonCode = 'main_host_binding_unavailable';
  } else if (
    String(model || '')
    !== String(expectedHostBinding.model || '')
  ) {
    reasonCode = 'main_model_mismatch';
  }

  censusMark('HOST_PROFILE_BUDGET_BINDING', reasonCode ? 'blocked' : 'passed', {
    reasonCode,
    runId: null,
  });
  return {
    status: reasonCode ? 'blocked' : 'ready',
    reason_code: reasonCode,
    proxy_base_url: normalizedProxyBaseUrl,
    expected_custom_url: expectedCustomUrl,
    active_host_binding: {
      connection_profile_name:
        String(connectionProfileName || '').trim() || '<manual>',
      preset_name: String(presetName || '').trim() || '<unnamed>',
      model: String(model || ''),
    },
    host_transforms: {
      squash_system_messages: Boolean(squashSystemMessages),
      custom_prompt_post_processing:
        String(customPromptPostProcessing || ''),
    },
  };
}

export function findUntraceableAbsorbedSources({
  absorbedSourceKinds = [],
  worldInfoEntries = [],
  hostSourceRoutes = {},
  traceableWorldInfoDepthRoutes = [],
} = {}) {
  const absorbed = new Set(absorbedSourceKinds);
  const traceableDepthRoutes = new Set(traceableWorldInfoDepthRoutes);
  const unresolved = [];
  const unresolvedWorldRoutes = new Set();

  if (absorbed.has('raw_worldbook')) {
    for (const entry of worldInfoEntries) {
      const position = Number.isInteger(entry?.position) ? entry.position : Number.NaN;
      if (DIRECT_WORLD_INFO_POSITIONS.has(position)) continue;
      const depthIdentifier = position === 4
        && Number.isInteger(entry?.depth)
        && [0, 1, 2].includes(Number(entry?.role ?? 0))
        ? `customDepthWI_${entry.depth}_${Number(entry?.role ?? 0)}`
        : null;
      if (
        depthIdentifier
        && traceableDepthRoutes.has(depthIdentifier)
      ) {
        continue;
      }
      const unresolvedIdentifier =
        depthIdentifier
        ?? `worldInfo:${entry?.uid ?? 'unknown'}`;
      if (unresolvedWorldRoutes.has(unresolvedIdentifier)) continue;
      unresolvedWorldRoutes.add(unresolvedIdentifier);

      unresolved.push({
        identifier: unresolvedIdentifier,
        source_label: 'raw_worldbook',
        reason_code: 'source_route_not_traceable',
        route: WORLD_INFO_POSITION_NAMES.get(position) ?? `position_${position}`,
      });
    }
  }

  if (absorbed.has('raw_character_card')) {
    const characterRoutes = [
      ['system_prompt_override', hostSourceRoutes.characterSystemOverride],
      ['post_history_instruction_override', hostSourceRoutes.characterJailbreakOverride],
      ['character_depth_prompt', hostSourceRoutes.characterDepthPrompt],
      ['character_dialogue_examples', hostSourceRoutes.characterDialogueExamples],
    ];

    for (const [route, active] of characterRoutes) {
      if (!active) continue;
      unresolved.push({
        identifier: `characterCard:${route}`,
        source_label: 'raw_character_card',
        reason_code: 'source_route_not_traceable',
        route,
      });
    }
  }

  if (
    absorbed.has('raw_persona')
    && hostSourceRoutes.personaPresent
    && ![0, 9].includes(Number(hostSourceRoutes.personaPosition))
  ) {
    unresolved.push({
      identifier: 'personaDescription:indirect',
      source_label: 'raw_persona',
      reason_code: 'source_route_not_traceable',
      route: `persona_position_${hostSourceRoutes.personaPosition}`,
    });
  }

  return unresolved;
}

export function mergeCustomIncludeBody(value, promptTrace) {
  let existing = {};

  if (value !== undefined && value !== null && String(value).trim() !== '') {
    existing = JSON.parse(String(value));
  }

  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('Custom OpenAI include body must be a JSON object.');
  }

  return JSON.stringify({
    ...existing,
    mnemosyne_prompt_trace: promptTrace,
  });
}

function mappedCoordinate(entry) {
  if (!Number.isInteger(entry?.provider_index)) return null;
  return [
    entry.provider_index,
    Number.isInteger(entry.provider_content_start)
      ? entry.provider_content_start
      : 0,
  ];
}

function compareCoordinates(left, right) {
  if (!left || !right) return null;
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] - right[1];
}

export function inspectPromptTrace(trace) {
  const providerEntries = trace?.provider_messages ?? [];
  const internalEntries = trace?.prompt_manager?.entries ?? [];
  const presetIdentifiers = new Set(
    trace?.prompt_manager?.preset_identifiers ?? [],
  );
  const promptSourceLabelsValid = internalEntries.every(entry => (
    sourceLabel(entry.identifier, presetIdentifiers) === entry.source_label
  ));
  const internalIdentifiers = internalEntries.map(entry => entry.identifier);
  const internalRuntimeIndex = internalIdentifiers.indexOf(
    'tavern_mnemosyne_runtime_contract',
  );
  const internalMainIndex = internalIdentifiers.indexOf('main');
  const internalPayloadIndex = internalIdentifiers.indexOf(
    'tavern_mnemosyne_continuity_payload',
  );
  const runtimeBeforeMain =
    internalRuntimeIndex >= 0
    && internalMainIndex >= 0
    && internalRuntimeIndex < internalMainIndex;
  const continuityAfterMain =
    internalPayloadIndex >= 0
    && internalMainIndex >= 0
    && internalPayloadIndex > internalMainIndex;
  const internalRuntime = internalEntries[internalRuntimeIndex];
  const internalMain = internalEntries[internalMainIndex];
  const internalPayload = internalEntries[internalPayloadIndex];
  const runtimeCoordinate = mappedCoordinate(internalRuntime);
  const mainCoordinate = mappedCoordinate(internalMain);
  const payloadCoordinate = mappedCoordinate(internalPayload);
  const mappedMainValid = mainCoordinate
    ? (
      compareCoordinates(runtimeCoordinate, mainCoordinate) < 0
      && compareCoordinates(mainCoordinate, payloadCoordinate) < 0
    )
    : (
      internalMain?.role === 'system'
      && (internalMain?.name ?? null) === null
      && internalMain?.content_hash === EMPTY_SYSTEM_PROMPT_HASH
      && internalMain?.provider_index === null
    );
  const providerNamedOrderValid = Boolean(
    runtimeCoordinate
    && payloadCoordinate
    && compareCoordinates(runtimeCoordinate, payloadCoordinate) < 0
    && mappedMainValid
  );
  const presetEnvelopeValid = internalEntries.some(entry => (
    Number.isInteger(entry.provider_index)
    && presetIdentifiers.has(entry.identifier)
    && entry.source_label === 'host_preset'
    && entry.retention_policy === 'retain'
  ));
  const providerTraceComplete = providerEntries.every((entry, index) => (
    entry.index === index
    && typeof entry.content_hash === 'string'
    && /^[a-f0-9]{64}$/.test(entry.content_hash)
    && Array.isArray(entry.segments)
    && entry.segments.every(segment => (
      Number.isInteger(segment.internal_order)
      && Number.isInteger(segment.start)
      && Number.isInteger(segment.end)
      && segment.start >= 0
      && segment.end >= segment.start
    ))
  ));
  const unresolvedCount = trace?.unresolved_absorbed_sources?.length ?? 0;
  const providerBudget = trace?.provider_budget;
  const providerBudgetValid = Boolean(
    providerBudget
    && providerBudget.schema === 'mnemosyne.provider-budget.v1'
    && providerBudget.run_id === trace?.run_id
    && Number.isSafeInteger(providerBudget.configured_context_tokens)
    && providerBudget.configured_context_tokens > 0
    && Number.isSafeInteger(providerBudget.output_reserve_tokens)
    && providerBudget.output_reserve_tokens > 0
    && providerBudget.output_reserve_tokens
      < providerBudget.configured_context_tokens
    && providerBudget.provider_input_tokens
      === providerBudget.configured_context_tokens
        - providerBudget.output_reserve_tokens
    && /^[a-f0-9]{64}$/.test(providerBudget.binding_hash ?? '')
  );

  return {
    status:
      runtimeBeforeMain
      && continuityAfterMain
      && providerNamedOrderValid
      && promptSourceLabelsValid
      && presetEnvelopeValid
      && providerTraceComplete
      && providerBudgetValid
      && unresolvedCount === 0
        ? 'pass'
        : 'blocked',
    runtime_before_main: runtimeBeforeMain,
    continuity_after_main: continuityAfterMain,
    provider_named_order_valid: providerNamedOrderValid,
    prompt_source_labels_valid: promptSourceLabelsValid,
    preset_envelope_valid: presetEnvelopeValid,
    provider_trace_complete: providerTraceComplete,
    provider_budget_valid: providerBudgetValid,
    unresolved_absorbed_source_count: unresolvedCount,
  };
}

export function createForwardingProbeRequest({
  proxyBaseUrl,
  trace,
  messages,
}) {
  const baseUrl = normalizeLoopbackProxyBaseUrl(proxyBaseUrl);
  return {
    chat_completion_source: 'custom',
    custom_url:
      `${baseUrl}/v1/mnemosyne/prompt-prepare-probe`,
    custom_include_body: JSON.stringify({
      mnemosyne_prompt_trace: trace,
    }),
    custom_exclude_body: '',
    custom_include_headers: '',
    custom_prompt_post_processing: '',
    model: 'mnemosyne-host-contract-probe',
    messages: structuredClone(messages),
    max_tokens: 1,
    stream: false,
    tools: [{
      type: 'function',
      function: {
        name: 'memory_search',
        description: 'Host-contract probe declaration. No memory operation is executed.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: 'auto',
  };
}

function forwardingProbeError(message) {
  const error = new Error(message);
  error.reasonCode = 'forwarding_probe_lease_mismatch';
  return error;
}

function sourceRemovalEvidenceError(message) {
  const error = new Error(message);
  error.reasonCode = 'source_removal_evidence_invalid';
  return error;
}

function hasExactKeys(value, expectedKeys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\u0000')
      === [...expectedKeys].sort().join('\u0000')
  );
}

function sortedUniqueStrings(value) {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every(item => typeof item === 'string' && item)
    && new Set(value).size === value.length
    && canonicalJson(value) === canonicalJson([...value].sort())
  );
}

function sourceRemovalRunScopeFromTrace(trace) {
  const scope = {
    chat_id: trace?.chat_ref?.chat_id,
    run_id: trace?.run_id,
    branch_id: 'main',
    branch_epoch: trace?.chat_ref?.branch_epoch,
    turn_index: trace?.chat_ref?.target_turn_index,
  };
  if (
    typeof scope.chat_id !== 'string'
    || !scope.chat_id
    || typeof scope.run_id !== 'string'
    || !scope.run_id
    || !Number.isInteger(scope.branch_epoch)
    || scope.branch_epoch < 0
    || !Number.isInteger(scope.turn_index)
    || scope.turn_index < 0
  ) {
    throw sourceRemovalEvidenceError(
      'Source removal requires the exact target story run scope.',
    );
  }
  return scope;
}

function sourceRemovalGrantIdentity(grant) {
  return {
    schema: SOURCE_REMOVAL_GRANT_SCHEMA,
    run_scope: grant.run_scope,
    snapshot_id: grant.snapshot_id,
    source_snapshot_hash: grant.source_snapshot_hash,
    identifier: grant.identifier,
    source_label: grant.source_label,
    prompt_message_hash: grant.prompt_message_hash,
    component_hash: grant.component_hash,
    source_unit_refs: grant.source_unit_refs,
    certificate_ids: grant.certificate_ids,
    coverage_policy: grant.coverage_policy,
    reader_capability_version: grant.reader_capability_version,
    coverage_binding_hash: grant.coverage_binding_hash,
  };
}

async function validSourceRemovalGrant(
  grant,
  expectedRunScope,
  entry = null,
) {
  if (
    !hasExactKeys(grant, SOURCE_REMOVAL_GRANT_KEYS)
    || grant.schema !== SOURCE_REMOVAL_GRANT_SCHEMA
    || !hasExactKeys(
      grant.run_scope,
      SOURCE_REMOVAL_RUN_SCOPE_KEYS,
    )
    || canonicalJson(grant.run_scope)
      !== canonicalJson(expectedRunScope)
    || typeof grant.snapshot_id !== 'string'
    || !grant.snapshot_id
    || !HASH_PATTERN.test(grant.source_snapshot_hash ?? '')
    || typeof grant.identifier !== 'string'
    || !grant.identifier
    || typeof grant.source_label !== 'string'
    || !RAW_AUTHOR_SOURCE_LABELS.has(grant.source_label)
    || !HASH_PATTERN.test(grant.prompt_message_hash ?? '')
    || !HASH_PATTERN.test(grant.component_hash ?? '')
    || !sortedUniqueStrings(grant.source_unit_refs)
    || !Array.isArray(grant.certificate_ids)
    || grant.certificate_ids.length
      !== grant.source_unit_refs.length
    || grant.certificate_ids.some(id => (
      !CERTIFICATE_ID_PATTERN.test(id)
    ))
    || new Set(grant.certificate_ids).size
      !== grant.certificate_ids.length
    || grant.coverage_policy !== 'strict'
    || grant.reader_capability_version
      !== 'mnemosyne.memory-reader.v2'
    || !HASH_PATTERN.test(grant.coverage_binding_hash ?? '')
    || typeof grant.issued_at !== 'string'
    || !grant.issued_at
    || (
      entry
      && (
        grant.identifier !== entry.identifier
        || grant.source_label !== entry.source_label
        || grant.prompt_message_hash
          !== entry.prompt_message_hash
        || grant.component_hash
          !== entry.component_provenance?.component_hash
      )
    )
  ) {
    return false;
  }
  return grant.grant_id
    === `grant_${(await sha256(canonicalJson(
      sourceRemovalGrantIdentity(grant),
    ))).slice(0, 24)}`;
}

function sourceCoverageReadScope(runScope) {
  return {
    branch_id: runScope.branch_id,
    branch_epoch: runScope.branch_epoch,
    turn_index: runScope.turn_index,
  };
}

function validCoverageOkfVersions(value) {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every(item => (
      hasExactKeys(item, SOURCE_COVERAGE_OKF_VERSION_KEYS)
      && typeof item.entity_ref === 'string'
      && item.entity_ref.startsWith('okf://entity/')
      && HASH_PATTERN.test(item.version_hash ?? '')
    ))
    && new Set(value.map(canonicalJson)).size === value.length
    && canonicalJson(value) === canonicalJson(
      [...value].sort((left, right) => (
        canonicalJson(left).localeCompare(canonicalJson(right))
      )),
    )
  );
}

async function normalizeSourceCoverageEvidence({
  sourceCoverage,
  grants,
  expectedRunScope,
}) {
  if (grants.length === 0) {
    if (sourceCoverage === null || sourceCoverage === undefined) {
      return null;
    }
    throw sourceRemovalEvidenceError(
      'Source coverage cannot exist without removal grants.',
    );
  }
  const binding = sourceCoverage?.binding;
  const bindingHash = sourceCoverage?.binding_hash;
  const sourceUnitRefs = binding?.source_unit_refs;
  const certificateIds = binding?.certificate_ids;
  const sortedGrants = [...grants].sort((left, right) => (
    left.identifier.localeCompare(right.identifier)
  ));
  if (
    !hasExactKeys(
      sourceCoverage,
      SOURCE_COVERAGE_WRAPPER_KEYS,
    )
    || !hasExactKeys(
      binding,
      SOURCE_COVERAGE_BINDING_KEYS,
    )
    || binding.schema !== SOURCE_COVERAGE_BINDING_SCHEMA
    || binding.coverage_policy !== 'strict'
    || canonicalJson(binding.run_scope)
      !== canonicalJson(expectedRunScope)
    || !hasExactKeys(
      binding.read_scope,
      SOURCE_COVERAGE_READ_SCOPE_KEYS,
    )
    || canonicalJson(binding.read_scope)
      !== canonicalJson(
        sourceCoverageReadScope(expectedRunScope),
      )
    || typeof binding.snapshot_id !== 'string'
    || !binding.snapshot_id
    || !HASH_PATTERN.test(binding.source_snapshot_hash ?? '')
    || !HASH_PATTERN.test(binding.source_set_hash ?? '')
    || !HASH_PATTERN.test(binding.prompt_fingerprints_hash ?? '')
    || !sortedUniqueStrings(sourceUnitRefs)
    || !Array.isArray(certificateIds)
    || certificateIds.length !== sourceUnitRefs.length
    || certificateIds.some(id => (
      !CERTIFICATE_ID_PATTERN.test(id)
    ))
    || new Set(certificateIds).size !== certificateIds.length
    || !HASH_PATTERN.test(binding.accepted_targets_hash ?? '')
    || !validCoverageOkfVersions(binding.okf_versions)
    || typeof binding.projection_id !== 'string'
    || !binding.projection_id
    || !HASH_PATTERN.test(binding.projection_hash ?? '')
    || !HASH_PATTERN.test(binding.runtime_view_hash ?? '')
    || binding.reader_capability_version
      !== 'mnemosyne.memory-reader.v2'
    || !HASH_PATTERN.test(bindingHash ?? '')
    || bindingHash !== await sha256(canonicalJson(binding))
    || !Array.isArray(binding.fingerprint_units)
    || binding.fingerprint_units.length !== sortedGrants.length
    || !Array.isArray(binding.source_unit_evidence)
    || binding.source_unit_evidence.length !== sourceUnitRefs.length
  ) {
    throw sourceRemovalEvidenceError(
      'Source coverage evidence has an invalid strict v3 shape.',
    );
  }
  for (let index = 0; index < sourceUnitRefs.length; index += 1) {
    const evidence = binding.source_unit_evidence[index];
    if (
      !hasExactKeys(
        evidence,
        SOURCE_COVERAGE_UNIT_EVIDENCE_KEYS,
      )
      || evidence.source_unit_ref !== sourceUnitRefs[index]
      || evidence.certificate_id !== certificateIds[index]
      || !HASH_PATTERN.test(evidence.manifest_hash ?? '')
    ) {
      throw sourceRemovalEvidenceError(
        'Source coverage unit evidence is not one-to-one.',
      );
    }
  }
  const coveredRefs = new Set();
  for (let index = 0; index < sortedGrants.length; index += 1) {
    const grant = sortedGrants[index];
    const fingerprint = binding.fingerprint_units[index];
    const expectedCertificates = grant.source_unit_refs.map(ref => (
      certificateIds[sourceUnitRefs.indexOf(ref)]
    ));
    if (
      !hasExactKeys(
        fingerprint,
        SOURCE_COVERAGE_FINGERPRINT_UNIT_KEYS,
      )
      || fingerprint.identifier !== grant.identifier
      || fingerprint.component_hash !== grant.component_hash
      || !sortedUniqueStrings(fingerprint.source_unit_refs)
      || canonicalJson(fingerprint.source_unit_refs)
        !== canonicalJson(grant.source_unit_refs)
      || canonicalJson(grant.certificate_ids)
        !== canonicalJson(expectedCertificates)
      || grant.coverage_binding_hash !== bindingHash
      || grant.snapshot_id !== binding.snapshot_id
      || grant.source_snapshot_hash
        !== binding.source_snapshot_hash
    ) {
      throw sourceRemovalEvidenceError(
        'Source coverage evidence does not bind every v3 grant.',
      );
    }
    for (const ref of grant.source_unit_refs) {
      coveredRefs.add(ref);
    }
  }
  if (
    canonicalJson(binding.fingerprint_units)
      !== canonicalJson(
        [...binding.fingerprint_units].sort((left, right) => (
          left.identifier.localeCompare(right.identifier)
        )),
      )
    || canonicalJson([...coveredRefs].sort())
      !== canonicalJson(sourceUnitRefs)
  ) {
    throw sourceRemovalEvidenceError(
      'Source coverage evidence contains an incomplete grant union.',
    );
  }
  return structuredClone(sourceCoverage);
}

async function expectedForwardingMessages(trace, messages) {
  if (
    !trace
    || typeof trace !== 'object'
    || Array.isArray(trace)
    || trace.schema !== 'mnemosyne.prompt-trace.v1'
    || typeof trace.run_id !== 'string'
    || !trace.run_id
    || !Array.isArray(trace.prompt_manager?.entries)
    || !Array.isArray(messages)
    || messages.length === 0
    || !promptMessagesBelongToRun(messages, trace.run_id)
  ) {
    throw forwardingProbeError(
      'Forwarding probe trace and messages are not a sealed prompt.',
    );
  }

  const hasSourceRemovals = trace.prompt_manager.entries.some(
    entry => (
      entry?.retention_policy
        === 'remove_absorbed_author_source'
    ),
  );
  const expectedRunScope = hasSourceRemovals
    ? sourceRemovalRunScopeFromTrace(trace)
    : null;
  const removalsByProvider = new Map();
  const grants = [];
  for (const entry of trace.prompt_manager.entries) {
    if (entry?.retention_policy !== 'remove_absorbed_author_source') {
      continue;
    }
    if (!await validSourceRemovalGrant(
      entry.removal_authorization,
      expectedRunScope,
      entry,
    )) {
      throw sourceRemovalEvidenceError(
        'Forwarding probe requires one exact v3 source-removal grant.',
      );
    }
    if (
      !Number.isInteger(entry.provider_index)
      || entry.provider_index < 0
      || entry.provider_index >= messages.length
      || !Number.isInteger(entry.provider_content_start)
      || !Number.isInteger(entry.provider_content_end)
    ) {
      throw forwardingProbeError(
        'Forwarding probe source removal cannot be predicted exactly.',
      );
    }
    grants.push(entry.removal_authorization);
    const content = messages[entry.provider_index]?.content;
    if (
      typeof content !== 'string'
      || entry.provider_content_start < 0
      || entry.provider_content_end <= entry.provider_content_start
      || entry.provider_content_end > content.length
    ) {
      throw forwardingProbeError(
        'Forwarding probe source removal span is invalid.',
      );
    }
    const spans = removalsByProvider.get(entry.provider_index) ?? [];
    spans.push({
      start: entry.provider_content_start,
      end: entry.provider_content_end,
    });
    removalsByProvider.set(entry.provider_index, spans);
  }
  await normalizeSourceCoverageEvidence({
    sourceCoverage: trace.source_coverage,
    grants,
    expectedRunScope,
  });

  const retained = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = structuredClone(messages[index]);
    const spans = (removalsByProvider.get(index) ?? [])
      .sort((left, right) => right.start - left.start);
    let previousStart = Number.POSITIVE_INFINITY;
    for (const span of spans) {
      if (span.end > previousStart) {
        throw forwardingProbeError(
          'Forwarding probe source removal spans overlap.',
        );
      }
      previousStart = span.start;
      message.content = (
        message.content.slice(0, span.start)
        + message.content.slice(span.end)
      );
    }
    if (spans.length > 0 && String(message.content).trim() === '') {
      continue;
    }
    retained.push(message);
  }
  return retained;
}

export async function createForwardingProbeLease({
  trace,
  messages,
  hostProfile,
  providerBudgetPolicy,
  chatId,
  hostHistorySnapshot,
} = {}) {
  const retainedMessages =
    await expectedForwardingMessages(trace, messages);
  if (
    hostProfile?.status !== 'ready'
    || typeof providerBudgetPolicy?.policy_hash !== 'string'
    || !HASH_PATTERN.test(providerBudgetPolicy.policy_hash)
    || typeof chatId !== 'string'
    || !chatId
    || !Array.isArray(hostHistorySnapshot)
  ) {
    throw forwardingProbeError(
      'Forwarding probe host and provider bindings are invalid.',
    );
  }
  return Object.freeze({
    schema: 'mnemosyne.forwarding-probe-lease.v1',
    run_id: trace.run_id,
    trace,
    messages,
    chat_id: chatId,
    trace_hash: await sha256(canonicalJson(trace)),
    messages_hash: await sha256(canonicalJson(messages)),
    host_profile_hash: await sha256(canonicalJson(hostProfile)),
    host_history_hash:
      await sha256(canonicalJson(hostHistorySnapshot)),
    provider_budget_policy_hash:
      providerBudgetPolicy.policy_hash,
    verified_message_count: messages.length,
    retained_message_count: retainedMessages.length,
    prompt_spine_hash:
      await sha256(canonicalJson(retainedMessages)),
  });
}

export async function assertForwardingProbeLease(
  lease,
  {
    trace,
    messages,
    hostProfile,
    providerBudgetPolicy,
    chatId,
    hostHistorySnapshot,
    activeRunMarker,
    runId,
    expectedActiveRunMarker = null,
  } = {},
) {
  const runStateMatches = expectedActiveRunMarker === null
    ? activeRunMarker === null && runId === null
    : (
      activeRunMarker === expectedActiveRunMarker
      && activeRunMarker?.run_id === lease?.run_id
      && activeRunMarker?.dry_run === true
      && runId === lease?.run_id
    );
  if (
    !lease
    || typeof lease !== 'object'
    || lease.schema !== 'mnemosyne.forwarding-probe-lease.v1'
    || lease.trace !== trace
    || lease.messages !== messages
    || lease.run_id !== trace?.run_id
    || lease.chat_id !== chatId
    || !runStateMatches
    || hostProfile?.status !== 'ready'
    || providerBudgetPolicy?.policy_hash
      !== lease.provider_budget_policy_hash
    || await sha256(canonicalJson(trace)) !== lease.trace_hash
    || await sha256(canonicalJson(messages)) !== lease.messages_hash
    || await sha256(canonicalJson(hostProfile))
      !== lease.host_profile_hash
    || await sha256(canonicalJson(hostHistorySnapshot))
      !== lease.host_history_hash
  ) {
    throw forwardingProbeError(
      'Forwarding probe inputs changed after the dry prompt was sealed.',
    );
  }
  const retainedMessages =
    await expectedForwardingMessages(trace, messages);
  if (
    retainedMessages.length !== lease.retained_message_count
    || await sha256(canonicalJson(retainedMessages))
      !== lease.prompt_spine_hash
  ) {
    throw forwardingProbeError(
      'Forwarding probe prompt spine changed after sealing.',
    );
  }
  return true;
}

export function forwardingProbeResponsePassed({
  responseOk,
  body,
  expectedRunId,
  expectedVerifiedMessageCount,
  expectedRetainedMessageCount,
  expectedProviderBudgetPolicyHash,
  expectedPromptSpineHash,
} = {}) {
  const result = body?.mnemosyne_prompt_prepare;
  const exactKeys = (value, keys) => (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\u0000')
      === [...keys].sort().join('\u0000')
  );
  return (
    responseOk === true
    && typeof expectedRunId === 'string'
    && expectedRunId.length > 0
    && Number.isSafeInteger(expectedVerifiedMessageCount)
    && expectedVerifiedMessageCount > 0
    && Number.isSafeInteger(expectedRetainedMessageCount)
    && expectedRetainedMessageCount > 0
    && HASH_PATTERN.test(expectedProviderBudgetPolicyHash ?? '')
    && HASH_PATTERN.test(expectedPromptSpineHash ?? '')
    && exactKeys(body, [
      'id',
      'object',
      'model',
      'choices',
      'mnemosyne_prompt_prepare',
    ])
    && body.id === `mnemosyne-prepare-probe-${expectedRunId}`
    && body.object === 'chat.completion'
    && body.model === 'mnemosyne-host-contract-probe'
    && Array.isArray(body.choices)
    && body.choices.length === 1
    && exactKeys(body.choices[0], [
      'index',
      'finish_reason',
      'message',
    ])
    && body.choices[0].index === 0
    && body.choices[0].finish_reason === 'stop'
    && exactKeys(body.choices[0].message, ['role', 'content'])
    && body.choices[0].message.role === 'assistant'
    && body.choices[0].message.content === 'PROMPT_FORWARDING_OK'
    && exactKeys(result, [
      'schema',
      'status',
      'run_id',
      'verified_message_count',
      'retained_message_count',
      'prompt_spine_hash',
      'provider_budget_policy_hash',
    ])
    && result.schema
      === 'mnemosyne.prompt-prepare-probe-result.v1'
    && result.status === 'pass'
    && result.run_id === expectedRunId
    && result.verified_message_count
      === expectedVerifiedMessageCount
    && result.retained_message_count
      === expectedRetainedMessageCount
    && result.provider_budget_policy_hash
      === expectedProviderBudgetPolicyHash
    && result.prompt_spine_hash === expectedPromptSpineHash
  );
}

export async function buildPromptTrace({
  runId,
  internalMessages,
  providerMessages,
  presetPromptIdentifiers = [],
  sourceRemovalAuthorizations = [],
  sourceCoverage = null,
  sourceRouteOverrides = [],
  sourceTransformOverrides = [],
  componentProvenance = [],
  unresolvedAbsorbedSources = [],
  hostTransforms = {},
  chatRef,
  hostHistoryBinding = null,
  hostHistoryCoordinateBasis = null,
  providerBudget,
}) {
  if (
    !Array.isArray(internalMessages)
    || !Array.isArray(providerMessages)
    || !Array.isArray(sourceRemovalAuthorizations)
    || !Array.isArray(sourceTransformOverrides)
  ) {
    throw new Error('Prompt trace requires internal and provider message arrays.');
  }
  const normalizedHostHistoryBinding = hostHistoryBinding === null
    ? null
    : await normalizeHostHistoryBinding(hostHistoryBinding, chatRef);
  const normalizedHostHistoryCoordinateBasis =
    await normalizeHostHistoryCoordinateBasis(
      hostHistoryCoordinateBasis,
      {
        runId,
        hostHistoryBinding: normalizedHostHistoryBinding,
      },
    );
  const normalizedProviderBudget =
    await normalizeProviderBudgetBinding(providerBudget, runId);

  const internalEntries = [];
  const matchQueues = new Map();
  const presetIdentifiers = new Set(
    presetPromptIdentifiers.filter(identifier => (
      typeof identifier === 'string' && identifier
    )),
  );
  const normalizedComponentProvenance =
    await normalizeHostComponentProvenance(componentProvenance);
  const overrides = await sourceRouteOverrideMap(
    sourceRouteOverrides,
    internalMessages.length,
    normalizedComponentProvenance,
  );

  for (let index = 0; index < internalMessages.length; index += 1) {
    const message = internalMessages[index];
    const override = overrides.get(index);
    const identifier = override?.identifier ?? message?.identifier ?? null;
    const matchHash = await matchingHash(message);
    if (
      override?.prompt_message_hash
      && override.prompt_message_hash !== matchHash
    ) {
      throw new Error('World Info depth source-route hash no longer matches.');
    }
    const key = `${message?.role ?? ''}\u0000${message?.name ?? ''}\u0000${matchHash}`;
    const effectiveSourceLabel =
      override?.source_label
      ?? sourceLabel(identifier, presetIdentifiers);
    const component = (
      RAW_AUTHOR_SOURCE_LABELS.has(effectiveSourceLabel)
      && hasContent(message)
    )
      ? (
        override?.component_provenance
        ?? await resolveHostComponentProvenance({
          identifier,
          components: normalizedComponentProvenance,
        })
      )
      : null;
    const identifierAuthorizations = sourceRemovalAuthorizations.filter(authorization => (
      authorization?.identifier === identifier
      && authorization?.source_label === effectiveSourceLabel
    ));
    const matchingAuthorizations = identifierAuthorizations.filter(
      authorization => authorization?.prompt_message_hash === matchHash,
    );
    const removalAuthorization = (
      identifierAuthorizations.length === 1
      && matchingAuthorizations.length === 1
    )
      ? structuredClone(matchingAuthorizations[0])
      : null;
    const removalAuthorizationIssue = identifierAuthorizations.length > 1
      ? 'source_removal_grant_ambiguous'
      : identifierAuthorizations.length === 1 && matchingAuthorizations.length === 0
        ? 'source_removal_prompt_hash_mismatch'
        : null;
    const entry = {
      order: index,
      identifier,
      role: message?.role ?? null,
      name: message?.name ?? null,
      content_hash: matchHash,
      prompt_message_hash: matchHash,
      source_label: effectiveSourceLabel,
      retention_policy:
        removalAuthorization
        && RAW_AUTHOR_SOURCE_LABELS.has(effectiveSourceLabel)
        ? 'remove_absorbed_author_source'
        : 'retain',
      removal_authorization: removalAuthorization,
      removal_authorization_issue: removalAuthorizationIssue,
      component_provenance:
        component === null ? null : structuredClone(component),
      provider_index: null,
      provider_content_start: null,
      provider_content_end: null,
      mapping_kind: null,
      mapping_issue: null,
    };
    internalEntries.push(entry);

    const queue = matchQueues.get(key) ?? [];
    queue.push(index);
    matchQueues.set(key, queue);
  }

  const ambiguousKeys = new Set();
  for (const [key, queue] of matchQueues) {
    const identities = new Set(queue.map(index => {
      const entry = internalEntries[index];
      return JSON.stringify([
        entry.identifier,
        entry.source_label,
        entry.retention_policy,
        entry.removal_authorization?.grant_id ?? null,
        entry.removal_authorization_issue,
        entry.component_provenance?.component_hash ?? null,
      ]);
    }));
    if (identities.size > 1) ambiguousKeys.add(key);
  }

  const providerEntries = [];
  for (let index = 0; index < providerMessages.length; index += 1) {
    const message = providerMessages[index];
    const matchHash = await matchingHash(message);
    const key = `${message?.role ?? ''}\u0000${message?.name ?? ''}\u0000${matchHash}`;
    const internalIndex = ambiguousKeys.has(key)
      ? undefined
      : matchQueues.get(key)?.shift();
    const internal = Number.isInteger(internalIndex)
      ? internalEntries[internalIndex]
      : null;

    if (internal) {
      internal.provider_index = index;
      internal.mapping_kind = 'exact_message';
      if (typeof message?.content === 'string') {
        internal.provider_content_start = 0;
        internal.provider_content_end = message.content.length;
      }
    }

    providerEntries.push({
      index,
      role: message?.role ?? null,
      name: message?.name ?? null,
      content_hash: await hashProviderMessage(message),
      prompt_message_hash: matchHash,
      identifier: internal?.identifier ?? null,
      source_label: internal?.source_label ?? 'host_recent_chat',
      retention_policy: internal?.retention_policy ?? 'retain',
      removal_authorization: internal?.removal_authorization ?? null,
      component_provenance:
        internal?.component_provenance ?? null,
      segments: [],
    });
  }

  const candidateKeys = new Map();
  const candidatesByInternal = new Map();
  for (const entry of internalEntries) {
    if (Number.isInteger(entry.provider_index)) continue;
    const content = internalMessages[entry.order]?.content;
    if (typeof content !== 'string' || content.length === 0) continue;

    const candidates = [];
    for (let providerIndex = 0; providerIndex < providerMessages.length; providerIndex += 1) {
      const providerContent = providerMessages[providerIndex]?.content;
      if (typeof providerContent !== 'string') continue;
      let start = providerContent.indexOf(content);
      while (start >= 0) {
        candidates.push({
          providerIndex,
          start,
          end: start + content.length,
        });
        start = providerContent.indexOf(content, start + 1);
      }
    }
    candidatesByInternal.set(entry.order, candidates);
    if (candidates.length === 1) {
      const candidate = candidates[0];
      const key = `${candidate.providerIndex}:${candidate.start}:${candidate.end}`;
      const orders = candidateKeys.get(key) ?? [];
      orders.push(entry.order);
      candidateKeys.set(key, orders);
    }
  }

  for (const entry of internalEntries) {
    if (Number.isInteger(entry.provider_index)) continue;
    const candidates = candidatesByInternal.get(entry.order) ?? [];
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        entry.mapping_issue = 'prompt_source_mapping_ambiguous';
      }
      continue;
    }
    const candidate = candidates[0];
    const key = `${candidate.providerIndex}:${candidate.start}:${candidate.end}`;
    if ((candidateKeys.get(key) ?? []).length !== 1) {
      entry.mapping_issue = 'prompt_source_mapping_ambiguous';
      continue;
    }
    const overlapsMappedSegment = internalEntries.some(other => (
      other.order !== entry.order
      && other.provider_index === candidate.providerIndex
      && Number.isInteger(other.provider_content_start)
      && Number.isInteger(other.provider_content_end)
      && candidate.start < other.provider_content_end
      && candidate.end > other.provider_content_start
    ));
    if (overlapsMappedSegment) {
      entry.mapping_issue = 'prompt_source_mapping_ambiguous';
      continue;
    }
    entry.provider_index = candidate.providerIndex;
    entry.provider_content_start = candidate.start;
    entry.provider_content_end = candidate.end;
    entry.mapping_kind = 'content_span';
  }

  const stableHistoryCoordinateEntries = internalEntries
    .map(entry => ({
      entry,
      match: String(entry.identifier ?? '').match(
        /^chatHistory-([1-9]\d*)$/,
      ),
    }))
    .filter(({ entry, match }) => (
      match
      && entry.source_label === 'host_recent_chat'
      && entry.retention_policy === 'retain'
    ))
    .map(({ entry, match }) => ({
      entry,
      ordinal: Number(match[1]),
    }))
    .sort((left, right) => left.ordinal - right.ordinal);
  const firstMappedHistoryOffset =
    stableHistoryCoordinateEntries.findIndex(
      ({ entry }) => Number.isInteger(entry.provider_index),
    );
  const firstUnmappedHistoryOffset =
    stableHistoryCoordinateEntries.findIndex(
      ({ entry }, index) => (
        index > firstMappedHistoryOffset
        && !Number.isInteger(entry.provider_index)
      ),
    );
  const stableHistoryAnchor = (
    firstUnmappedHistoryOffset > 0
      ? stableHistoryCoordinateEntries[
          firstUnmappedHistoryOffset - 1
        ]
      : stableHistoryCoordinateEntries
        .filter(({ entry }) => (
          Number.isInteger(entry.provider_index)
        ))
        .at(-1)
  );
  const stableHistorySequenceIsContiguous = (
    normalizedHostHistoryBinding
    && normalizedHostHistoryCoordinateBasis
    && stableHistoryCoordinateEntries.length > 0
    && stableHistoryCoordinateEntries.every((candidate, index) => (
      index === 0
      || candidate.ordinal
        === stableHistoryCoordinateEntries[index - 1].ordinal + 1
    ))
    && stableHistoryCoordinateEntries.at(-1).ordinal
      >= normalizedHostHistoryCoordinateBasis
        .host_message_indices.at(-1)
  );
  if (stableHistoryAnchor && stableHistorySequenceIsContiguous) {
    const coordinateSuffix = stableHistoryCoordinateEntries.filter(
      candidate => candidate.ordinal >= stableHistoryAnchor.ordinal,
    );
    const coordinateProviderMatches = new Map();
    const providerMatch = (candidate, providerIndex) => {
      const providerMessage = providerMessages[providerIndex];
      const internalMessage = internalMessages[candidate.entry.order];
      const internalContent = internalMessage?.content;
      const providerContent = providerMessage?.content;
      const mappedCollision = internalEntries.some(other => (
        other.order !== candidate.entry.order
        && other.provider_index === providerIndex
      ));
      const exactMessage = (
        providerEntries[providerIndex]?.prompt_message_hash
          === candidate.entry.prompt_message_hash
      );
      const oneInternalSpan = (
        typeof internalContent === 'string'
        && internalContent.length > 0
        && typeof providerContent === 'string'
        && providerContent.indexOf(internalContent) >= 0
        && providerContent.indexOf(
          internalContent,
          providerContent.indexOf(internalContent) + 1,
        ) === -1
      );
      const stableAssistantPrefix = (
        candidate.entry.role === 'assistant'
        && typeof internalContent === 'string'
        && typeof providerContent === 'string'
        && providerContent.length > 0
        && internalContent.startsWith(providerContent)
      );
      if (
        providerIndex >= 0
        && providerIndex < providerMessages.length
        && providerMessage?.role === candidate.entry.role
        && (providerMessage?.name ?? null)
          === (candidate.entry.name ?? null)
        && (
          !Number.isInteger(candidate.entry.provider_index)
          || candidate.entry.provider_index === providerIndex
        )
        && !mappedCollision
        && (
          exactMessage
          || oneInternalSpan
          || stableAssistantPrefix
        )
      ) {
        return {
          providerIndex,
          start: exactMessage || stableAssistantPrefix
            ? 0
            : providerContent.indexOf(internalContent),
          end: exactMessage || stableAssistantPrefix
            ? providerContent.length
            : providerContent.indexOf(internalContent)
              + internalContent.length,
          mappingKind: exactMessage
            ? 'stable_history_coordinate'
            : stableAssistantPrefix
              ? 'stable_history_coordinate_assistant_prefix'
              : 'stable_history_coordinate_span',
        };
      }
      return null;
    };
    let previousProviderIndex =
      stableHistoryAnchor.entry.provider_index - 1;
    let coordinateSuffixIsBound = true;
    for (const candidate of coordinateSuffix) {
      let match = null;
      if (Number.isInteger(candidate.entry.provider_index)) {
        if (candidate.entry.provider_index > previousProviderIndex) {
          match = providerMatch(
            candidate,
            candidate.entry.provider_index,
          );
        }
      } else {
        for (
          let providerIndex = previousProviderIndex + 1;
          providerIndex < providerMessages.length;
          providerIndex += 1
        ) {
          match = providerMatch(candidate, providerIndex);
          if (match) break;
        }
      }
      if (!match) {
        coordinateSuffixIsBound = false;
        break;
      }
      coordinateProviderMatches.set(
        candidate.entry.order,
        match,
      );
      previousProviderIndex = match.providerIndex;
    }
    if (coordinateSuffixIsBound) {
      let nextProviderIndex =
        stableHistoryAnchor.entry.provider_index;
      const coordinatePrefix = stableHistoryCoordinateEntries
        .filter(candidate => (
          candidate.ordinal < stableHistoryAnchor.ordinal
        ))
        .reverse();
      for (const candidate of coordinatePrefix) {
        let match = null;
        if (Number.isInteger(candidate.entry.provider_index)) {
          if (candidate.entry.provider_index < nextProviderIndex) {
            match = providerMatch(
              candidate,
              candidate.entry.provider_index,
            );
          }
        } else {
          for (
            let providerIndex = nextProviderIndex - 1;
            providerIndex >= 0;
            providerIndex -= 1
          ) {
            match = providerMatch(candidate, providerIndex);
            if (match) break;
          }
        }
        if (!match) break;
        coordinateProviderMatches.set(
          candidate.entry.order,
          match,
        );
        nextProviderIndex = match.providerIndex;
      }
      for (const candidate of stableHistoryCoordinateEntries) {
        if (Number.isInteger(candidate.entry.provider_index)) continue;
        const match = coordinateProviderMatches.get(
          candidate.entry.order,
        );
        if (!match) continue;
        candidate.entry.provider_index =
          match.providerIndex;
        candidate.entry.provider_content_start =
          match.start;
        candidate.entry.provider_content_end =
          match.end;
        candidate.entry.mapping_kind =
          match.mappingKind;
        candidate.entry.mapping_issue = null;
      }
    }
  }

  const internalHistoryByIdentifier = new Map(
    internalEntries
      .filter(entry => (
        /^chatHistory-[1-9]\d*$/.test(
          String(entry.identifier ?? ''),
        )
      ))
      .map(entry => [entry.identifier, entry]),
  );
  const stableAssistantSuffixCandidates = internalEntries
    .filter(entry => (
      !Number.isInteger(entry.provider_index)
      && entry.source_label === 'host_recent_chat'
      && entry.role === 'assistant'
      && /^chatHistory-([1-9]\d*)$/.test(
        String(entry.identifier ?? ''),
      )
    ))
    .map(entry => {
      const ordinal = Number(
        entry.identifier.match(
          /^chatHistory-([1-9]\d*)$/,
        )[1],
      );
      const nextUser =
        internalHistoryByIdentifier.get(
          `chatHistory-${ordinal + 1}`,
        );
      const previousUser =
        internalHistoryByIdentifier.get(
          `chatHistory-${ordinal - 1}`,
        );
      const providerIndex =
        nextUser?.provider_index - 1;
      const internalContent =
        internalMessages[entry.order]?.content;
      const providerMessage =
        providerMessages[providerIndex];
      const providerContent =
        providerMessage?.content;
      const suffix = (
        Number.isInteger(providerIndex)
        && providerIndex >= 0
        && nextUser?.role === 'user'
        && Number.isInteger(
          nextUser.provider_index,
        )
        && (
          !previousUser
          || (
            previousUser.role === 'user'
            && previousUser.provider_index
              === providerIndex - 1
          )
        )
        && providerMessage?.role === 'assistant'
        && (providerMessage?.name ?? null)
          === (entry.name ?? null)
        && typeof internalContent === 'string'
        && typeof providerContent === 'string'
        && providerContent.length > 0
        && internalContent.startsWith(
          providerContent,
        )
      )
        ? internalContent.slice(providerContent.length)
        : null;
      if (
        typeof suffix !== 'string'
        || suffix.length === 0
        || suffix.length > 1_024
        || suffix.includes('\u0000')
      ) {
        return null;
      }
      return {
        entry,
        providerIndex,
        providerContent,
        suffix,
      };
    })
    .filter(Boolean);
  const stableSuffixes = new Set(
    stableAssistantSuffixCandidates.map(
      candidate => candidate.suffix,
    ),
  );
  if (
    stableAssistantSuffixCandidates.length >= 2
    && stableSuffixes.size === 1
    && new Set(
      stableAssistantSuffixCandidates.map(
        candidate => candidate.providerIndex,
      ),
    ).size === stableAssistantSuffixCandidates.length
  ) {
    for (const candidate of stableAssistantSuffixCandidates) {
      const collides = internalEntries.some(other => (
        other.order !== candidate.entry.order
        && other.provider_index === candidate.providerIndex
      ));
      if (collides) continue;
      candidate.entry.provider_index =
        candidate.providerIndex;
      candidate.entry.provider_content_start = 0;
      candidate.entry.provider_content_end =
        candidate.providerContent.length;
      candidate.entry.mapping_kind =
        'stable_assistant_suffix';
    }
  }

  const transformedOrders = new Set();
  const transformedSpans = [];
  for (const override of sourceTransformOverrides) {
    const entry = internalEntries[override?.internal_order];
    const providerContent =
      providerMessages[override?.provider_index]?.content;
    const start = override?.provider_content_start;
    const end = override?.provider_content_end;
    if (
      override?.schema !== HOST_TRANSFORM_OVERRIDE_SCHEMA
      || override.run_id !== runId
      || !entry
      || transformedOrders.has(override.internal_order)
      || override.identifier !== entry.identifier
      || override.source_label !== entry.source_label
      || override.original_prompt_message_hash
        !== entry.prompt_message_hash
      || entry.retention_policy !== 'retain'
      || !RAW_AUTHOR_SOURCE_LABELS.has(entry.source_label)
      || !entry.component_provenance
      || !Number.isInteger(override.provider_index)
      || override.provider_index < 0
      || override.provider_index >= providerMessages.length
      || !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end <= start
      || typeof providerContent !== 'string'
      || end > providerContent.length
      || !HASH_PATTERN.test(
        override.transformed_prompt_message_hash ?? '',
      )
      || providerMessages[override.provider_index]?.role
        !== entry.role
      || (
        providerMessages[override.provider_index]?.name
        ?? null
      ) !== (entry.name ?? null)
      || await matchingHash({
        role: entry.role,
        name: entry.name ?? null,
        content: providerContent.slice(start, end),
      }) !== override.transformed_prompt_message_hash
    ) {
      throw hostTransformFenceError(
        'host_transform_override_invalid',
        'A fenced host transform override no longer matches its source.',
      );
    }
    const collides = internalEntries.some(other => (
      other.order !== entry.order
      && other.provider_index === override.provider_index
      && Number.isInteger(other.provider_content_start)
      && Number.isInteger(other.provider_content_end)
      && start < other.provider_content_end
      && end > other.provider_content_start
    )) || transformedSpans.some(other => (
      other.provider_index === override.provider_index
      && start < other.end
      && end > other.start
    ));
    if (
      collides
      || (
        Number.isInteger(entry.provider_index)
        && (
          entry.provider_index !== override.provider_index
          || entry.provider_content_start !== start
          || entry.provider_content_end !== end
        )
      )
    ) {
      throw hostTransformFenceError(
        'host_transform_override_ambiguous',
        'A fenced host transform override overlaps another source.',
      );
    }
    transformedOrders.add(override.internal_order);
    transformedSpans.push({
      provider_index: override.provider_index,
      start,
      end,
    });
    entry.content_hash =
      override.transformed_prompt_message_hash;
    entry.prompt_message_hash =
      override.transformed_prompt_message_hash;
    entry.provider_index = override.provider_index;
    entry.provider_content_start = start;
    entry.provider_content_end = end;
    entry.mapping_kind = 'fenced_host_transform';
    entry.mapping_issue = null;
  }

  for (const entry of internalEntries) {
    if (
      !Number.isInteger(entry.provider_index)
      || !Number.isInteger(entry.provider_content_start)
      || !Number.isInteger(entry.provider_content_end)
    ) {
      continue;
    }
    providerEntries[entry.provider_index].segments.push({
      internal_order: entry.order,
      identifier: entry.identifier,
      source_label: entry.source_label,
      retention_policy: entry.retention_policy,
      prompt_message_hash: entry.prompt_message_hash,
      start: entry.provider_content_start,
      end: entry.provider_content_end,
      mapping_kind: entry.mapping_kind,
      removal_authorization: entry.removal_authorization,
      component_provenance: entry.component_provenance,
    });
  }

  for (const providerEntry of providerEntries) {
    providerEntry.segments.sort((left, right) => (
      left.start - right.start
      || left.end - right.end
      || left.internal_order - right.internal_order
    ));
    const providerContent = providerMessages[providerEntry.index]?.content;
    const onlySegment = providerEntry.segments.length === 1
      ? providerEntry.segments[0]
      : null;
    if (
      onlySegment
      && typeof providerContent === 'string'
      && onlySegment.start === 0
      && onlySegment.end === providerContent.length
    ) {
      providerEntry.identifier = onlySegment.identifier;
      providerEntry.source_label = onlySegment.source_label;
      providerEntry.retention_policy = onlySegment.retention_policy;
      providerEntry.removal_authorization =
        onlySegment.removal_authorization;
      providerEntry.component_provenance =
        onlySegment.component_provenance;
    } else if (providerEntry.segments.length > 0) {
      providerEntry.identifier = null;
      providerEntry.source_label = 'host_composite';
      providerEntry.retention_policy = 'retain';
      providerEntry.removal_authorization = null;
      providerEntry.component_provenance = null;
    }
  }

  const unresolvedMappedSources = internalEntries
    .filter(entry => (
      (
        entry.retention_policy === 'remove_absorbed_author_source'
        && entry.provider_index === null
      )
      || entry.removal_authorization_issue
    ))
    .filter(entry => hasContent(internalMessages[entry.order]))
    .map(entry => ({
      identifier: entry.identifier,
      source_label: entry.source_label,
      content_hash: entry.content_hash,
      reason_code:
        entry.removal_authorization_issue
        ?? entry.mapping_issue
        ?? (
          ambiguousKeys.has(
            `${entry.role ?? ''}\u0000${entry.name ?? ''}\u0000${entry.content_hash}`,
          )
            ? 'prompt_source_mapping_ambiguous'
            : 'prompt_source_mapping_missing'
        ),
    }));

  const removalEntries = internalEntries.filter(entry => (
    entry.retention_policy
      === 'remove_absorbed_author_source'
  ));
  if (
    removalEntries.length !== sourceRemovalAuthorizations.length
    || new Set(sourceRemovalAuthorizations.map(
      grant => grant?.grant_id,
    )).size !== sourceRemovalAuthorizations.length
  ) {
    throw sourceRemovalEvidenceError(
      'Every source-removal authorization must map one-to-one onto the prompt trace.',
    );
  }
  const expectedRemovalRunScope =
    sourceRemovalAuthorizations.length > 0
      ? sourceRemovalRunScopeFromTrace({
        run_id: runId,
        chat_ref: chatRef,
      })
      : null;
  for (const grant of sourceRemovalAuthorizations) {
    const matchingEntries = removalEntries.filter(entry => (
      entry.removal_authorization?.grant_id === grant.grant_id
    ));
    if (
      matchingEntries.length !== 1
      || !await validSourceRemovalGrant(
        grant,
        expectedRemovalRunScope,
        matchingEntries[0],
      )
    ) {
      throw sourceRemovalEvidenceError(
        'Prompt trace source removal grant is not exact v3 evidence.',
      );
    }
  }
  const normalizedSourceCoverage =
    await normalizeSourceCoverageEvidence({
      sourceCoverage,
      grants: sourceRemovalAuthorizations,
      expectedRunScope: expectedRemovalRunScope,
    });

  return {
    schema: 'mnemosyne.prompt-trace.v1',
    run_id: runId,
    captured_at: new Date().toISOString(),
    chat_ref: structuredClone(chatRef),
    host_history_binding: normalizedHostHistoryBinding,
    host_history_coordinate_basis:
      normalizedHostHistoryCoordinateBasis,
    provider_budget: normalizedProviderBudget,
    source_coverage: normalizedSourceCoverage,
    host_transforms: {
      squash_system_messages:
        Boolean(hostTransforms.squash_system_messages),
      custom_prompt_post_processing:
        String(hostTransforms.custom_prompt_post_processing || ''),
    },
    provider_messages: providerEntries,
    prompt_manager: {
      preset_identifiers: [...presetIdentifiers],
      entries: internalEntries,
    },
    unresolved_absorbed_sources: [
      ...unresolvedMappedSources,
      ...structuredClone(unresolvedAbsorbedSources),
    ],
  };
}

export async function finalizePromptTrace({
  promptTraceInputs,
  providerMessages,
}) {
  if (
    !promptTraceInputs
    || typeof promptTraceInputs !== 'object'
    || Array.isArray(promptTraceInputs)
    || !Array.isArray(providerMessages)
  ) {
    throw new Error(
      'Final prompt trace requires cached provenance inputs and provider messages.',
    );
  }
  const trace = await buildPromptTrace({
    ...promptTraceInputs,
    providerMessages,
  });
  const inspection = inspectPromptTrace(trace);
  if (inspection.status !== 'pass') {
    let failedCheck = [
      ['runtime_before_main', inspection.runtime_before_main],
      ['continuity_after_main', inspection.continuity_after_main],
      ['provider_named_order', inspection.provider_named_order_valid],
      ['prompt_source_labels', inspection.prompt_source_labels_valid],
      ['preset_envelope', inspection.preset_envelope_valid],
      ['provider_trace', inspection.provider_trace_complete],
      ['provider_budget', inspection.provider_budget_valid],
      [
        'absorbed_source_resolution',
        inspection.unresolved_absorbed_source_count === 0,
      ],
    ].find(([, passed]) => passed !== true)?.[0]
      ?? 'unknown';
    if (
      failedCheck === 'absorbed_source_resolution'
      && trace.unresolved_absorbed_sources.length > 0
    ) {
      const unresolved = trace.unresolved_absorbed_sources[0];
      const fragment = value => String(value ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32)
        || 'unknown';
      failedCheck = [
        'absorbed',
        fragment(unresolved.identifier),
        fragment(unresolved.reason_code),
      ].join('_');
    }
    const error = new Error(
      'Final provider messages do not retain verifiable active-preset provenance.',
    );
    error.reasonCode =
      `prompt_trace_contract_${failedCheck}`.slice(0, 95);
    error.inspection = inspection;
    throw error;
  }
  return {
    trace,
    inspection,
    providerMessages: structuredClone(providerMessages),
  };
}
