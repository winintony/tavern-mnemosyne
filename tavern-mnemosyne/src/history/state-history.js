import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  resolveBranchSegments,
  selectActiveTurnMemoryRows,
} from './active-history-resolver.js';
import {
  canonicalDynamicEntityRef,
  compileCanonicalDynamicConcept,
  isCanonicalDynamicRecordKind,
} from './canonical-dynamic-concept.js';
import {
  BEAT_TYPES,
  SCENE_TURN_NULL_SCENE,
  SCENE_TURN_POLARITIES,
  validateCanonicalTypedPayload,
} from './typed-turn-delta.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = (
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
);
const DELTA_MODES = new Set(['changed', 'no_change']);
const STATE_OPERATIONS = new Set(['set', 'unset']);
const SOURCE_MODES = new Set(['narration', 'dialogue', 'mixed']);
const SCENE_EVENT_FIELDS = new Set([
  'what_happened',
  'participants',
  'story_time',
  'location_ref',
  'outcome',
  'causes',
  'consequences',
]);
// Craft field batch: sealed pre-batch scene events keep the legacy key set;
// new events carry both craft keys. A partial craft key set is invalid.
const SCENE_EVENT_CRAFT_FIELDS = ['beat_type', 'scene_turn'];
const SCENE_EVENT_BEAT_TYPES = new Set(BEAT_TYPES);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    fail('turn_identity_invalid', `${field} is invalid.`, { field });
  }
}

function assertOpaqueHostId(value, field) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('turn_identity_invalid', `${field} is invalid.`, { field });
  }
}

function sourceRefComponent(value) {
  return encodeURIComponent(value);
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail('turn_identity_invalid', `${field} must be a non-negative integer.`, {
      field,
    });
  }
}

function assertMessage(message, role, field) {
  if (
    !message
    || message.role !== role
    || typeof message.content !== 'string'
  ) {
    fail(
      'turn_message_invalid',
      `${field} must be an exact ${role} message.`,
      { field },
    );
  }
}

function isCanonicalIsoTimestamp(value) {
  if (
    typeof value !== 'string'
    || !ISO_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
  );
}

function resolveCommittedAt(input, now) {
  const camelCaseValue = input?.committedAt;
  const sourceValue = input?.committed_at;
  if (
    camelCaseValue !== undefined
    && sourceValue !== undefined
    && camelCaseValue !== sourceValue
  ) {
    fail(
      'turn_committed_at_invalid',
      'committedAt and committed_at must identify the same canonical instant.',
    );
  }
  const trustedTimestamp = camelCaseValue ?? sourceValue;
  if (trustedTimestamp === undefined) {
    return now().toISOString();
  }
  if (!isCanonicalIsoTimestamp(trustedTimestamp)) {
    fail(
      'turn_committed_at_invalid',
      'A trusted committed_at must be a canonical UTC ISO timestamp.',
    );
  }
  return trustedTimestamp;
}

function sceneTurnValueValid(value) {
  if (value === null || value === SCENE_TURN_NULL_SCENE) return true;
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 2
    && typeof value.core_state === 'string'
    && value.core_state.trim() !== ''
    && SCENE_TURN_POLARITIES.includes(value.polarity)
  );
}

function normalizeSceneEvent(event, {
  sequenceIndex,
  sourceSpan,
}) {
  const stringArray = value => (
    Array.isArray(value)
    && value.every(item => (
      typeof item === 'string' && item.trim()
    ))
  );
  const invalid = () => fail(
    'turn_delta_event_invalid',
    'scene_event records require complete grounded event fields.',
    { sequence_index: sequenceIndex },
  );
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    invalid();
  }
  const presentCraftKeys = SCENE_EVENT_CRAFT_FIELDS.filter(key => (
    Object.hasOwn(event, key)
  ));
  if (
    presentCraftKeys.length !== 0
    && presentCraftKeys.length !== SCENE_EVENT_CRAFT_FIELDS.length
  ) {
    invalid();
  }
  const hasCraftFields = presentCraftKeys.length > 0;
  const expectedSize = SCENE_EVENT_FIELDS.size
    + (hasCraftFields ? SCENE_EVENT_CRAFT_FIELDS.length : 0);
  if (
    Object.keys(event).length !== expectedSize
    || Object.keys(event).some(key => (
      !SCENE_EVENT_FIELDS.has(key)
      && !SCENE_EVENT_CRAFT_FIELDS.includes(key)
    ))
    || typeof event.what_happened !== 'string'
    || !event.what_happened.trim()
    || !stringArray(event.participants)
    || event.participants.length === 0
    || typeof event.story_time !== 'string'
    || !event.story_time.trim()
    || (
      event.location_ref !== null
      && (
        typeof event.location_ref !== 'string'
        || !event.location_ref.trim()
      )
    )
    || typeof event.outcome !== 'string'
    || !event.outcome.trim()
    || !stringArray(event.causes)
    || !stringArray(event.consequences)
    || (
      hasCraftFields
      && !(
        event.beat_type === null
        || SCENE_EVENT_BEAT_TYPES.has(event.beat_type)
      )
    )
    || (hasCraftFields && !sceneTurnValueValid(event.scene_turn))
    || sourceSpan.source_mode !== 'narration'
    || sourceSpan.support_strength !== 'explicit'
  ) {
    invalid();
  }
  return {
    what_happened: event.what_happened,
    participants: structuredClone(event.participants),
    story_time: event.story_time,
    location_ref: event.location_ref,
    outcome: event.outcome,
    causes: structuredClone(event.causes),
    consequences: structuredClone(event.consequences),
    ...(hasCraftFields
      ? {
          beat_type: event.beat_type,
          scene_turn: structuredClone(event.scene_turn),
        }
      : {}),
  };
}

const CLOSING_PLOT_THREAD_STATUSES = new Set(['resolved', 'failed']);
const OPEN_PLOT_THREAD_STATUSES = new Set([
  'open',
  'blocked',
  'progressing',
]);

// M1 payoff grounding (live-kernel path only; replay paths never set the
// flag). A resolved/failed plot_thread must close a thread that has an
// active open-state setup record — either earlier in this same delta or in
// the active lane strictly before this turn. thread_ref identity is the
// grounding pointer because the model never authors server-owned record ids.
function assertPromisePayoffGrounded(database, {
  chatId,
  branchId,
  branchEpoch,
  turnIndex,
  records,
}) {
  const closing = records
    .map((record, sequenceIndex) => ({ record, sequenceIndex }))
    .filter(({ record }) => (
      record.kind === 'plot_thread'
      && CLOSING_PLOT_THREAD_STATUSES.has(record.payload?.status)
    ));
  if (closing.length === 0) return;

  let priorOpenThreadRefs = null;
  const resolvePriorOpenThreads = () => {
    const branchExists = database.prepare(`
      SELECT 1
      FROM branch_epochs
      WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
    `).get(chatId, branchId, branchEpoch);
    if (!branchExists || turnIndex === 0) return new Set();
    const segments = resolveBranchSegments(database, {
      chatId,
      branchId,
      branchEpoch,
      turnIndex: turnIndex - 1,
    });
    const rows = selectActiveTurnMemoryRows(database, {
      chatId,
      branchId,
      segments,
      order: 'ascending',
    });
    const latestStatus = new Map();
    for (const row of rows) {
      if (
        row.record_kind !== 'plot_thread'
        || row.turn_index >= turnIndex
        || typeof row.record_payload_json !== 'string'
      ) {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(row.record_payload_json);
      } catch {
        continue;
      }
      if (typeof payload?.thread_ref !== 'string') continue;
      latestStatus.set(payload.thread_ref, payload.status);
    }
    return new Set(
      [...latestStatus]
        .filter(([, status]) => OPEN_PLOT_THREAD_STATUSES.has(status))
        .map(([threadRef]) => threadRef),
    );
  };

  for (const { record, sequenceIndex } of closing) {
    const threadRef = record.payload.thread_ref;
    const sameDeltaSetup = records
      .slice(0, sequenceIndex)
      .some(prior => (
        prior.kind === 'plot_thread'
        && prior.payload?.thread_ref === threadRef
        && OPEN_PLOT_THREAD_STATUSES.has(prior.payload?.status)
      ));
    if (sameDeltaSetup) continue;
    priorOpenThreadRefs ??= resolvePriorOpenThreads();
    if (!priorOpenThreadRefs.has(threadRef)) {
      fail(
        'plot_thread_payoff_ungrounded',
        'A resolved or failed plot_thread must reference an active setup record for the same thread.',
        { sequence_index: sequenceIndex, thread_ref: threadRef },
      );
    }
  }
}

function normalizeDelta(delta, assistantBody, {
  chatId,
  turnId,
  candidateId,
}) {
  if (
    !delta
    || typeof delta !== 'object'
    || Array.isArray(delta)
    || !DELTA_MODES.has(delta.mode)
    || !Array.isArray(delta.records)
  ) {
    fail(
      'turn_delta_invalid',
      'Turn delta must declare changed or no_change and include records.',
    );
  }
  if (
    delta.reason !== undefined
    && (
      typeof delta.reason !== 'string'
      || !delta.reason.trim()
      || delta.reason.length > 1000
    )
  ) {
    fail(
      'turn_delta_reason_invalid',
      'Turn delta reason must be concise and non-empty when supplied.',
    );
  }
  if (
    (delta.mode === 'changed' && delta.records.length === 0)
    || (delta.mode === 'no_change' && delta.records.length !== 0)
  ) {
    fail(
      'turn_delta_invalid',
      'changed requires records and no_change requires an empty record list.',
    );
  }

  const records = delta.records.map((record, sequenceIndex) => {
    if (
      !record
      || typeof record !== 'object'
      || Array.isArray(record)
      || typeof record.kind !== 'string'
      || !record.kind.trim()
      || typeof record.entity_ref !== 'string'
      || !record.entity_ref.trim()
      || typeof record.summary !== 'string'
      || !record.summary.trim()
    ) {
      fail(
        'turn_delta_record_invalid',
        'Every turn delta record needs kind, entity_ref, and summary.',
        { sequence_index: sequenceIndex },
      );
    }

    const span = record.source_span;
    if (
      !span
      || !Number.isInteger(span.start)
      || !Number.isInteger(span.end)
      || span.start < 0
      || span.end <= span.start
      || span.end > assistantBody.length
      || typeof span.quote !== 'string'
      || assistantBody.slice(span.start, span.end) !== span.quote
      || typeof span.support_strength !== 'string'
      || !span.support_strength.trim()
      || (
        span.source_mode !== undefined
        && !SOURCE_MODES.has(span.source_mode)
      )
    ) {
      fail(
        'source_span_mismatch',
        'A delta record source span must quote the committed assistant body exactly.',
        { sequence_index: sequenceIndex },
      );
    }

    let state;
    if (record.state !== undefined) {
      const operation = record.state?.operation ?? 'set';
      if (
        !record.state
        || typeof record.state.domain !== 'string'
        || !record.state.domain.trim()
        || typeof record.state.key !== 'string'
        || !record.state.key.trim()
        || !STATE_OPERATIONS.has(operation)
        || (operation === 'set' && record.state.value === undefined)
      ) {
        fail(
          'turn_delta_state_invalid',
          'State records require domain, key, a valid operation, and a value for set.',
          { sequence_index: sequenceIndex },
        );
      }
      state = {
        domain: record.state.domain,
        key: record.state.key,
        ...(record.state.value === undefined
          ? {}
          : { value: structuredClone(record.state.value) }),
        ...(record.state.operation === undefined
          ? {}
          : { operation }),
      };
      try {
        canonicalJson(state);
      } catch {
        fail(
          'turn_delta_state_invalid',
          'State values must be JSON serializable.',
          { sequence_index: sequenceIndex },
        );
      }
    } else if (record.kind === 'continuity_state') {
      fail(
        'turn_delta_state_invalid',
        'continuity_state records require a state payload.',
        { sequence_index: sequenceIndex },
      );
    }
    if (record.kind === 'scene_event' && state !== undefined) {
      fail(
        'turn_delta_event_invalid',
        'scene_event records cannot carry a Current State payload.',
        { sequence_index: sequenceIndex },
      );
    }
    let event;
    if (record.event !== undefined || record.kind === 'scene_event') {
      if (record.kind !== 'scene_event') {
        fail(
          'turn_delta_event_invalid',
          'Only scene_event records can carry event fields.',
          { sequence_index: sequenceIndex },
        );
      }
      event = normalizeSceneEvent(record.event, {
        sequenceIndex,
        sourceSpan: span,
      });
    }
    let payload;
    if (
      isCanonicalDynamicRecordKind(record.kind)
      && record.kind !== 'scene_event'
    ) {
      if (state !== undefined || record.event !== undefined) {
        fail(
          'turn_delta_record_invalid',
          'Canonical typed records cannot carry state or event aliases.',
          { sequence_index: sequenceIndex },
        );
      }
      payload = validateCanonicalTypedPayload({
        recordKind: record.kind,
        payload: record.payload,
        sequenceIndex,
      });
    } else if (record.payload !== undefined) {
      fail(
        'turn_delta_record_invalid',
        'Only canonical typed records can carry a typed payload.',
        { sequence_index: sequenceIndex },
      );
    }
    const normalizedEntityRef = isCanonicalDynamicRecordKind(record.kind)
      ? canonicalDynamicEntityRef({
        recordKind: record.kind,
        turnId,
        candidateId,
        sequenceIndex,
      })
      : record.entity_ref;

    return {
      kind: record.kind,
      entity_ref: normalizedEntityRef,
      summary: event?.what_happened ?? record.summary,
      ...(state === undefined ? {} : { state }),
      ...(event === undefined ? {} : { event }),
      ...(payload === undefined ? {} : { payload }),
      source_span: {
        start: span.start,
        end: span.end,
        quote: span.quote,
        ...(span.source_mode === undefined
          ? {}
          : { source_mode: span.source_mode }),
        support_strength: span.support_strength,
      },
      source_ref: [
        `chat://${sourceRefComponent(chatId)}`,
        `/turn/${sourceRefComponent(turnId)}`,
        `/candidate/${sourceRefComponent(candidateId)}`,
        `#chars=${span.start}-${span.end}`,
      ].join(''),
    };
  });

  return {
    exact: {
      mode: delta.mode,
      ...(delta.reason === undefined
        ? {}
        : { reason: delta.reason.trim() }),
      records: records.map(({ source_ref: _sourceRef, ...record }) => record),
    },
    records,
  };
}

function turnArtifactRelativePath(turnId, candidateId) {
  return path.posix.join(
    'turn-artifacts',
    turnId,
    `${candidateId}.json`,
  );
}

function stableArtifactPayload(artifact) {
  const {
    committed_at: _committedAt,
    ...stable
  } = artifact;
  return stable;
}

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function turnMemoryRecordId(patchId, sequenceIndex, record) {
  return `record_${sha256(canonicalJson({
    patch_id: patchId,
    sequence_index: sequenceIndex,
    record,
  })).slice(0, 24)}`;
}

async function ensureCanonicalConceptFile(filePath, document) {
  try {
    const existing = await readFile(filePath, 'utf8');
    if (existing !== document) {
      fail(
        'dynamic_okf_path_conflict',
        'A canonical Dynamic Story path contains different content.',
        { path: filePath },
      );
    }
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeAtomic(filePath, document);
  return true;
}

function selectCommittedHostCoordinates(database, {
  chatId,
  branchId,
  branchEpoch,
}) {
  const segments = resolveBranchSegments(database, {
    chatId,
    branchId,
    branchEpoch,
    turnIndex: Number.MAX_SAFE_INTEGER,
  });
  const statement = database.prepare(`
    SELECT
      turns.run_id,
      turns.turn_id,
      turns.turn_index,
      turns.branch_epoch,
      turn_candidates.candidate_id,
      turn_candidates.swipe_id,
      turn_candidates.body_hash
    FROM turns
    JOIN turn_candidates
      ON turn_candidates.turn_id = turns.turn_id
    JOIN patches
      ON patches.patch_id = turn_candidates.patch_id
    WHERE
      turns.chat_id = ?
      AND turns.branch_id = ?
      AND turns.branch_epoch = ?
      AND turns.turn_index <= ?
      AND turns.status = 'committed'
      AND turn_candidates.status = 'active'
      AND patches.status = 'applied'
    ORDER BY turns.turn_index, turns.turn_id
  `);
  const candidates = segments.flatMap(segment => (
    statement.all(
      chatId,
      branchId,
      segment.branch_epoch,
      segment.through_turn_index,
    )
  ));
  const seenTurns = new Set();
  return candidates.map(candidate => {
    if (
      seenTurns.has(candidate.turn_index)
      || typeof candidate.run_id !== 'string'
      || !SAFE_ID_PATTERN.test(candidate.run_id)
      || typeof candidate.turn_id !== 'string'
      || !SAFE_ID_PATTERN.test(candidate.turn_id)
      || typeof candidate.candidate_id !== 'string'
      || !SAFE_ID_PATTERN.test(candidate.candidate_id)
      || !Number.isInteger(candidate.turn_index)
      || candidate.turn_index < 0
      || !Number.isInteger(candidate.branch_epoch)
      || candidate.branch_epoch < 0
      || candidate.branch_epoch > branchEpoch
      || !Number.isInteger(candidate.swipe_id)
      || candidate.swipe_id < 0
      || !HASH_PATTERN.test(
        candidate.body_hash ?? '',
      )
    ) {
      fail(
        'history_recovery_coordinate_invalid',
        'The governed host-coordinate chain is incomplete or ambiguous.',
      );
    }
    seenTurns.add(candidate.turn_index);
    return {
      schema:
        'mnemosyne.latest-committed-host-coordinate.v1',
      chat_id: chatId,
      branch_id: branchId,
      branch_epoch: candidate.branch_epoch,
      run_id: candidate.run_id,
      turn_id: candidate.turn_id,
      candidate_id: candidate.candidate_id,
      turn_index: candidate.turn_index,
      swipe_id: candidate.swipe_id,
      body_hash: candidate.body_hash,
    };
  });
}

export function createStateHistory({
  store,
  now = () => new Date(),
} = {}) {
  if (!store?.openChatForAdmin) {
    throw new Error('State History requires a trusted chat-save store.');
  }

  return Object.freeze({
    async inspectGovernedHistory({
      chatId,
      branchId = 'main',
    } = {}) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      const opened = store.openChatForAdminIfInitialized
        ? await store.openChatForAdminIfInitialized({ chatId })
        : await store.openChatForAdmin({ chatId });
      if (!opened) {
        return {
          schema: 'mnemosyne.governed-history-inspection.v1',
          status: 'ready',
          chat_id: chatId,
          branch_id: branchId,
          has_governed_history: false,
          committed_turn_count: 0,
          active_branch_epoch: null,
          latest_turn_index: null,
        };
      }
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      try {
        const summary = database.prepare(`
          SELECT
            COUNT(*) AS committed_turn_count,
            MAX(turn_index) AS latest_turn_index
          FROM turns
          WHERE
            chat_id = ?
            AND branch_id = ?
            AND status = 'committed'
        `).get(chatId, branchId);
        const activeEpochs = database.prepare(`
          SELECT branch_epoch
          FROM branch_epochs
          WHERE
            chat_id = ?
            AND branch_id = ?
            AND status = 'active'
          ORDER BY branch_epoch
        `).all(chatId, branchId);
        if (activeEpochs.length > 1) {
          fail(
            'history_branch_active_ambiguous',
            'Governed history inspection found multiple active branch epochs.',
          );
        }
        const activeBranchEpoch =
          activeEpochs[0]?.branch_epoch
          ?? null;
        const activeCoordinates = (
          activeBranchEpoch === null
            ? null
            : selectCommittedHostCoordinates(database, {
              chatId,
              branchId,
              branchEpoch: activeBranchEpoch,
            })
        );
        const committedTurnCount = activeCoordinates
          ? activeCoordinates.length
          : Number(summary.committed_turn_count);
        return {
          schema: 'mnemosyne.governed-history-inspection.v1',
          status: 'ready',
          chat_id: chatId,
          branch_id: branchId,
          has_governed_history: (
            committedTurnCount > 0
            || activeBranchEpoch !== null
          ),
          committed_turn_count: committedTurnCount,
          active_branch_epoch: activeBranchEpoch,
          latest_turn_index:
            activeCoordinates
              ? activeCoordinates.at(-1)?.turn_index
                ?? null
              : summary.latest_turn_index
                ?? null,
        };
      } finally {
        database.close();
      }
    },

    async readLatestCommittedHostCoordinate({
      chatId,
      branchId = 'main',
      branchEpoch,
    } = {}) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      try {
        return selectCommittedHostCoordinates(database, {
          chatId,
          branchId,
          branchEpoch,
        }).at(-1) ?? null;
      } finally {
        database.close();
      }
    },

    async readCommittedHostCoordinates({
      chatId,
      branchId = 'main',
      branchEpoch,
    } = {}) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      try {
        return selectCommittedHostCoordinates(database, {
          chatId,
          branchId,
          branchEpoch,
        });
      } finally {
        database.close();
      }
    },

    async commitTurn(input) {
      const {
        chatId,
        runId,
        turnId,
        candidateId,
        turnIndex,
        branchId,
        branchEpoch,
        swipeId,
        userMessage,
        assistantMessage,
        promptSpineHash,
      } = input ?? {};
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        runId,
        turnId,
        candidateId,
        branchId,
      })) {
        assertSafeId(value, field);
      }
      assertNonNegativeInteger(turnIndex, 'turnIndex');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      assertNonNegativeInteger(swipeId, 'swipeId');
      assertMessage(userMessage, 'user', 'userMessage');
      assertMessage(assistantMessage, 'assistant', 'assistantMessage');
      if (!HASH_PATTERN.test(promptSpineHash ?? '')) {
        fail(
          'prompt_spine_hash_invalid',
          'promptSpineHash must be a lowercase SHA-256 hash.',
        );
      }

      const normalizedDelta = normalizeDelta(
        input.delta,
        assistantMessage.content,
        { chatId, turnId, candidateId },
      );
      const committedAt = resolveCommittedAt(input, now);
      const bodyHash = sha256(assistantMessage.content);
      const deltaHash = sha256(canonicalJson(normalizedDelta.exact));
      const patchId = `patch_${sha256(canonicalJson({
        chat_id: chatId,
        turn_id: turnId,
        candidate_id: candidateId,
        body_hash: bodyHash,
        delta_hash: deltaHash,
      })).slice(0, 24)}`;
      const recordEntries = normalizedDelta.records.map(
        (record, sequenceIndex) => ({
          record,
          sequenceIndex,
          recordId: turnMemoryRecordId(
            patchId,
            sequenceIndex,
            record,
          ),
        }),
      );
      const canonicalConcepts = recordEntries
        .filter(({ record }) => (
          isCanonicalDynamicRecordKind(record.kind)
        ))
        .map(({ record, sequenceIndex, recordId }) => (
          compileCanonicalDynamicConcept({
            recordId,
            record,
            patchId,
            turnIndex,
            turnId,
            candidateId,
            committedAt,
            sequenceIndex,
          })
        ));
      const artifactRelativePath = turnArtifactRelativePath(
        turnId,
        candidateId,
      );
      const artifact = {
        schema: 'mnemosyne.turn-artifact.v1',
        chat_id: chatId,
        run_id: runId,
        turn_id: turnId,
        candidate_id: candidateId,
        turn_index: turnIndex,
        branch_id: branchId,
        branch_epoch: branchEpoch,
        swipe_id: swipeId,
        prompt_spine_hash: promptSpineHash,
        committed_at: committedAt,
        user_message: structuredClone(userMessage),
        assistant_message: structuredClone(assistantMessage),
        delta: normalizedDelta.exact,
        body_hash: bodyHash,
        delta_hash: deltaHash,
        patch_id: patchId,
      };
      const serializedArtifact = `${JSON.stringify(artifact, null, 2)}\n`;
      const artifactHash = sha256(serializedArtifact);
      const commitCommandId = `commit-${candidateId}`;
      const commitEventPayload = {
        branch_id: branchId,
        branch_epoch: branchEpoch,
        turn_index: turnIndex,
        turn_id: turnId,
        candidate_id: candidateId,
        swipe_id: swipeId,
      };
      const commitEventId = `event_${sha256(canonicalJson({
        command_id: commitCommandId,
        chat_id: chatId,
        payload: commitEventPayload,
      })).slice(0, 24)}`;
      const commitEventResult = {
        schema: 'mnemosyne.commit-candidate-event-result.v1',
        status: 'committed',
        patch_id: patchId,
        body_hash: bodyHash,
        delta_hash: deltaHash,
        artifact_hash: artifactHash,
      };

      const opened = await store.openChatForAdmin({ chatId });
      const artifactPath = path.join(
        opened.chat_save_path,
        artifactRelativePath,
      );
      const preflightDatabase = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let existingCandidate;
      let existingTurn;
      try {
        existingCandidate = preflightDatabase.prepare(`
          SELECT
            turns.chat_id,
            turns.turn_id,
            turn_candidates.candidate_id,
            turn_candidates.artifact_path
          FROM turn_candidates
          JOIN turns ON turns.turn_id = turn_candidates.turn_id
          WHERE turn_candidates.candidate_id = ?
        `).get(candidateId);
        existingTurn = preflightDatabase.prepare(`
          SELECT
            turn_id,
            chat_id,
            turn_index,
            branch_id,
            branch_epoch,
            message_hash,
            run_id
          FROM turns
          WHERE turn_id = ?
             OR (
               chat_id = ?
               AND branch_id = ?
               AND turn_index = ?
               AND branch_epoch = ?
             )
          ORDER BY CASE WHEN turn_id = ? THEN 0 ELSE 1 END
          LIMIT 1
        `).get(
          turnId,
          chatId,
          branchId,
          turnIndex,
          branchEpoch,
          turnId,
        );
      } finally {
        preflightDatabase.close();
      }

      if (existingCandidate) {
        let existingArtifact = null;
        try {
          existingArtifact = JSON.parse(await readFile(
            path.join(
              opened.chat_save_path,
              existingCandidate.artifact_path,
            ),
            'utf8',
          ));
        } catch {
          fail(
            'turn_artifact_unavailable',
            'An existing turn identity has no readable source artifact.',
          );
        }
        if (
          canonicalJson(stableArtifactPayload(existingArtifact))
          !== canonicalJson(stableArtifactPayload(artifact))
        ) {
          fail(
            'turn_identity_conflict',
            'The candidate identity is already bound to different turn content.',
          );
        }
        return {
          schema: 'mnemosyne.turn-commit-result.v1',
          status: 'existing',
          patch_id: existingArtifact.patch_id,
          body_hash: existingArtifact.body_hash,
          delta_hash: existingArtifact.delta_hash,
        };
      }

      const userMessageHash = sha256(canonicalJson(userMessage));
      if (
        existingTurn
        && (
          existingTurn.turn_id !== turnId
          || existingTurn.chat_id !== chatId
          || existingTurn.turn_index !== turnIndex
          || existingTurn.branch_id !== branchId
          || existingTurn.branch_epoch !== branchEpoch
          || existingTurn.message_hash !== userMessageHash
        )
      ) {
        fail(
          'turn_identity_conflict',
          'The turn identity or branch coordinate is already bound differently.',
        );
      }

      await writeAtomic(
        artifactPath,
        serializedArtifact,
      );
      const createdCanonicalPaths = [];
      try {
        for (const concept of canonicalConcepts) {
          const conceptPath = path.join(
            opened.chat_save_path,
            concept.relativePath,
          );
          if (await ensureCanonicalConceptFile(
            conceptPath,
            concept.document,
          )) {
            createdCanonicalPaths.push(conceptPath);
          }
        }
      } catch (error) {
        await rm(artifactPath, { force: true });
        await Promise.all(createdCanonicalPaths.map(filePath => (
          rm(filePath, { force: true })
        )));
        throw error;
      }

      const database = new DatabaseSync(opened.ledger_path);
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');
        const conflictingEvent = database.prepare(`
          SELECT event_type, chat_id, payload_json
          FROM history_events
          WHERE command_id = ?
        `).get(commitCommandId);
        if (conflictingEvent) {
          fail(
            'history_command_conflict',
            'The commit candidate command identity is already bound.',
            {
              event_type: conflictingEvent.event_type,
              chat_id: conflictingEvent.chat_id,
            },
          );
        }
        const branch = database.prepare(`
          SELECT branch_epoch, status
          FROM branch_epochs
          WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
        `).get(chatId, branchId, branchEpoch);
        if (branch && branch.status !== 'active') {
          const activeBranch = database.prepare(`
            SELECT branch_epoch
            FROM branch_epochs
            WHERE chat_id = ? AND branch_id = ? AND status = 'active'
            ORDER BY branch_epoch DESC
            LIMIT 1
          `).get(chatId, branchId);
          fail(
            'branch_epoch_stale',
            'A turn candidate cannot be committed into a historical branch epoch.',
            {
              requested_branch_epoch: branchEpoch,
              active_branch_epoch: activeBranch?.branch_epoch ?? null,
            },
          );
        }
        if (!branch) {
          const branchEpochCount = Number(database.prepare(`
            SELECT COUNT(*) AS count
            FROM branch_epochs
            WHERE chat_id = ? AND branch_id = ?
          `).get(chatId, branchId)?.count ?? 0);
          if (branchEpochCount !== 0 || existingTurn) {
            fail(
              'branch_epoch_not_found',
              'A later branch epoch must be created by truncation.',
            );
          }
          database.prepare(`
            INSERT INTO branch_epochs (
              chat_id,
              branch_id,
              branch_epoch,
              parent_branch_epoch,
              parent_cutoff_turn_index_exclusive,
              status,
              head_turn_index,
              created_by_event_id,
              created_at
            ) VALUES (?, ?, ?, NULL, NULL, 'active', NULL, NULL, ?)
          `).run(chatId, branchId, branchEpoch, committedAt);
        }
        if (input.enforcePromisePayoffGrounding === true) {
          assertPromisePayoffGrounded(database, {
            chatId,
            branchId,
            branchEpoch,
            turnIndex,
            records: normalizedDelta.records,
          });
        }
        const candidateStatus = existingTurn ? 'inactive' : 'active';
        const patchStatus = existingTurn ? 'prepared' : 'applied';
        if (!existingTurn) {
          database.prepare(`
            INSERT INTO turns (
              turn_id,
              chat_id,
              turn_index,
              branch_id,
              branch_epoch,
              message_hash,
              status,
              created_at,
              run_id
            ) VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?)
          `).run(
            turnId,
            chatId,
            turnIndex,
            branchId,
            branchEpoch,
            userMessageHash,
            committedAt,
            runId,
          );
          database.prepare(`
            UPDATE branch_epochs
            SET head_turn_index = CASE
              WHEN head_turn_index IS NULL OR head_turn_index < ?
                THEN ?
              ELSE head_turn_index
            END
            WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
          `).run(
            turnIndex,
            turnIndex,
            chatId,
            branchId,
            branchEpoch,
          );
        }
        database.prepare(`
          INSERT INTO patches (
            patch_id,
            chat_id,
            candidate_id,
            reason_code,
            source_index_start,
            source_index_end,
            status,
            prepared_at,
            applied_at
          ) VALUES (?, ?, ?, 'turn_commit', ?, ?, ?, ?, ?)
        `).run(
          patchId,
          chatId,
          candidateId,
          turnIndex,
          turnIndex,
          patchStatus,
          committedAt,
          existingTurn ? null : committedAt,
        );
        database.prepare(`
          INSERT INTO turn_candidates (
            candidate_id,
            turn_id,
            swipe_id,
            body_hash,
            patch_id,
            status,
            activated_at,
            artifact_path,
            delta_hash,
            prompt_spine_hash,
            artifact_hash,
            run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          candidateId,
          turnId,
          swipeId,
          bodyHash,
          patchId,
          candidateStatus,
          committedAt,
          artifactRelativePath,
          deltaHash,
          promptSpineHash,
          artifactHash,
          runId,
        );
        const insertRecord = database.prepare(`
          INSERT INTO turn_memory_records (
            record_id,
            patch_id,
            candidate_id,
            sequence_index,
            record_kind,
            entity_ref,
            summary,
            state_domain,
            state_key,
            state_value_json,
            state_operation,
            record_payload_json,
            source_ref,
            source_start,
            source_end,
            source_mode,
            support_strength,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `);
        for (const {
          sequenceIndex,
          record,
          recordId,
        } of recordEntries) {
          const stateOperation = record.state?.operation ?? 'set';
          insertRecord.run(
            recordId,
            patchId,
            candidateId,
            sequenceIndex,
            record.kind,
            record.entity_ref,
            record.summary,
            record.state?.domain ?? null,
            record.state?.key ?? null,
            record.state?.value === undefined
              ? null
              : canonicalJson(record.state.value),
            stateOperation,
            record.payload === undefined && record.event === undefined
              ? null
              : canonicalJson(record.payload ?? record.event),
            record.source_ref,
            record.source_span.start,
            record.source_span.end,
            record.source_span.source_mode ?? null,
            record.source_span.support_strength,
          );
        }
        const insertConceptVersion = database.prepare(`
          INSERT INTO concept_versions (
            entity_id,
            version_hash,
            relative_path,
            patch_id,
            status,
            created_at
          ) VALUES (?, ?, ?, ?, 'active', ?)
        `);
        for (const concept of canonicalConcepts) {
          insertConceptVersion.run(
            concept.entityId,
            concept.versionHash,
            concept.conceptRelativePath,
            patchId,
            committedAt,
          );
        }
        database.prepare(`
          INSERT OR IGNORE INTO patch_sources (
            patch_id,
            source_turn_id
          ) VALUES (?, ?)
        `).run(patchId, turnId);
        database.prepare(`
          INSERT INTO history_events (
            event_id,
            command_id,
            chat_id,
            branch_id,
            branch_epoch,
            event_type,
            payload_json,
            result_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'commit_candidate', ?, ?, ?)
        `).run(
          commitEventId,
          commitCommandId,
          chatId,
          branchId,
          branchEpoch,
          canonicalJson(commitEventPayload),
          canonicalJson(commitEventResult),
          committedAt,
        );
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        await rm(artifactPath, { force: true });
        await Promise.all(createdCanonicalPaths.map(filePath => (
          rm(filePath, { force: true })
        )));
        throw error;
      } finally {
        database.close();
      }

      return {
        schema: 'mnemosyne.turn-commit-result.v1',
        status: 'committed',
        patch_id: patchId,
        body_hash: bodyHash,
        delta_hash: deltaHash,
      };
    },

    async findCandidate({
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
      swipeId,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      assertNonNegativeInteger(turnIndex, 'turnIndex');
      assertNonNegativeInteger(swipeId, 'swipeId');
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let matches;
      try {
        matches = database.prepare(`
          SELECT
            turns.turn_id,
            turns.branch_id,
            turns.branch_epoch,
            turns.turn_index,
            turn_candidates.candidate_id,
            turn_candidates.swipe_id,
            turn_candidates.status
          FROM turns
          JOIN turn_candidates
            ON turn_candidates.turn_id = turns.turn_id
          WHERE
            turns.chat_id = ?
            AND turns.branch_id = ?
            AND turns.branch_epoch = ?
            AND turns.turn_index = ?
            AND turns.status = 'committed'
            AND turn_candidates.swipe_id = ?
          ORDER BY turn_candidates.candidate_id
        `).all(
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
          swipeId,
        );
      } finally {
        database.close();
      }
      if (matches.length === 0) {
        fail(
          'turn_candidate_lookup_not_found',
          'No committed reply candidate matches the exact host coordinate.',
          {
            branch_id: branchId,
            branch_epoch: branchEpoch,
            turn_index: turnIndex,
            swipe_id: swipeId,
          },
        );
      }
      if (matches.length > 1) {
        fail(
          'turn_candidate_lookup_ambiguous',
          'More than one reply candidate matches the exact host coordinate.',
          {
            branch_id: branchId,
            branch_epoch: branchEpoch,
            turn_index: turnIndex,
            swipe_id: swipeId,
            match_count: matches.length,
          },
        );
      }
      const match = matches[0];
      return {
        schema: 'mnemosyne.candidate-lookup-result.v1',
        chat_id: chatId,
        branch_id: match.branch_id,
        branch_epoch: match.branch_epoch,
        turn_index: match.turn_index,
        swipe_id: match.swipe_id,
        turn_id: match.turn_id,
        candidate_id: match.candidate_id,
        status: match.status,
      };
    },

    async listActiveCandidatesAt({
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      assertNonNegativeInteger(turnIndex, 'turnIndex');
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      try {
        const segments = resolveBranchSegments(database, {
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
        });
        const statement = database.prepare(`
          SELECT
            turns.turn_id,
            turns.turn_index,
            turns.branch_id,
            turns.branch_epoch,
            turn_candidates.candidate_id,
            turn_candidates.swipe_id,
            turn_candidates.status
          FROM turns
          JOIN turn_candidates
            ON turn_candidates.turn_id = turns.turn_id
          JOIN patches
            ON patches.patch_id = turn_candidates.patch_id
          WHERE
            turns.chat_id = ?
            AND turns.branch_id = ?
            AND turns.branch_epoch = ?
            AND turns.turn_index <= ?
            AND turns.status = 'committed'
            AND turn_candidates.status = 'active'
            AND patches.status = 'applied'
          ORDER BY turns.turn_index, turn_candidates.candidate_id
        `);
        const selections = segments.flatMap((segment, segmentIndex) => (
          statement.all(
            chatId,
            branchId,
            segment.branch_epoch,
            segment.through_turn_index,
          ).map(row => ({
            segment_index: segmentIndex,
            ...row,
          }))
        ));
        const turnIds = new Set();
        for (const selection of selections) {
          if (turnIds.has(selection.turn_id)) {
            fail(
              'turn_active_candidate_conflict',
              'A turn cannot have more than one active reply candidate.',
            );
          }
          turnIds.add(selection.turn_id);
        }
        return {
          schema: 'mnemosyne.active-candidate-list.v1',
          status: 'ready',
          chat_id: chatId,
          branch_id: branchId,
          branch_epoch: branchEpoch,
          turn_index: turnIndex,
          candidates: selections.map(({
            segment_index: _segmentIndex,
            ...selection
          }) => selection),
        };
      } finally {
        database.close();
      }
    },

    async listBranchReplayEvents({
      chatId,
      branchId = 'main',
      branchEpoch,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      try {
        const ancestry = [];
        const visited = new Set();
        let epoch = branchEpoch;
        while (epoch !== null) {
          if (visited.has(epoch)) {
            fail(
              'branch_epoch_cycle',
              'Branch epoch ancestry contains a cycle.',
            );
          }
          visited.add(epoch);
          const row = database.prepare(`
            SELECT
              branch_epoch,
              parent_branch_epoch,
              parent_cutoff_turn_index_exclusive,
              created_by_event_id
            FROM branch_epochs
            WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
          `).get(chatId, branchId, epoch);
          if (!row) {
            fail(
              'branch_epoch_not_found',
              'The requested branch epoch does not exist.',
            );
          }
          ancestry.push(row);
          epoch = row.parent_branch_epoch;
        }
        ancestry.reverse();

        const events = [];
        for (const child of ancestry.slice(1)) {
          const event = database.prepare(`
            SELECT
              event_id,
              command_id,
              event_type,
              branch_id,
              branch_epoch,
              payload_json,
              result_json,
              created_at
            FROM history_events
            WHERE event_id = ?
          `).get(child.created_by_event_id);
          if (!event || event.event_type !== 'truncate_branch') {
            fail(
              'branch_replay_event_missing',
              'A branch epoch has no replayable truncation event.',
              { branch_epoch: child.branch_epoch },
            );
          }
          const payload = JSON.parse(event.payload_json);
          const result = JSON.parse(event.result_json);
          if (
            event.branch_id !== branchId
            || event.branch_epoch !== child.parent_branch_epoch
            || payload.expected_branch_epoch !== child.parent_branch_epoch
            || payload.cutoff_turn_index
              !== child.parent_cutoff_turn_index_exclusive
            || result.new_branch_epoch !== child.branch_epoch
          ) {
            fail(
              'branch_replay_event_mismatch',
              'A branch truncation event does not match its epoch edge.',
              { branch_epoch: child.branch_epoch },
            );
          }
          events.push({
            event_id: event.event_id,
            command_id: event.command_id,
            event_type: event.event_type,
            branch_id: event.branch_id,
            branch_epoch: event.branch_epoch,
            payload,
            result,
            created_at: event.created_at,
          });
        }
        return {
          schema: 'mnemosyne.branch-replay-event-list.v1',
          status: 'ready',
          chat_id: chatId,
          branch_id: branchId,
          target_branch_epoch: branchEpoch,
          root_branch_epoch: ancestry[0].branch_epoch,
          events,
        };
      } finally {
        database.close();
      }
    },

    async ensureReplayRootBranch({
      chatId,
      branchId = 'main',
      branchEpoch,
      createdAt,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      const canonicalCreatedAt = resolveCommittedAt(
        { committedAt: createdAt },
        now,
      );
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');
        const rows = database.prepare(`
          SELECT
            branch_epoch,
            parent_branch_epoch,
            parent_cutoff_turn_index_exclusive,
            status
          FROM branch_epochs
          WHERE chat_id = ? AND branch_id = ?
          ORDER BY branch_epoch
        `).all(chatId, branchId);
        if (rows.length > 0) {
          const root = rows.find(row => (
            row.branch_epoch === branchEpoch
            && row.parent_branch_epoch === null
            && row.parent_cutoff_turn_index_exclusive === null
          ));
          if (!root) {
            fail(
              'root_replay_branch_conflict',
              'The target store has a different branch root.',
            );
          }
          database.exec('COMMIT');
          return {
            schema: 'mnemosyne.replay-root-branch-result.v1',
            status: 'existing',
            branch_id: branchId,
            branch_epoch: branchEpoch,
          };
        }
        database.prepare(`
          INSERT INTO branch_epochs (
            chat_id,
            branch_id,
            branch_epoch,
            parent_branch_epoch,
            parent_cutoff_turn_index_exclusive,
            status,
            head_turn_index,
            created_by_event_id,
            created_at
          ) VALUES (?, ?, ?, NULL, NULL, 'active', NULL, NULL, ?)
        `).run(
          chatId,
          branchId,
          branchEpoch,
          canonicalCreatedAt,
        );
        database.exec('COMMIT');
        return {
          schema: 'mnemosyne.replay-root-branch-result.v1',
          status: 'created',
          branch_id: branchId,
          branch_epoch: branchEpoch,
        };
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }
    },

    async getActiveCandidate({ chatId, turnId }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(turnId, 'turnId');
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let turn;
      let candidates;
      try {
        turn = database.prepare(`
          SELECT
            turn_id,
            turn_index,
            branch_id,
            branch_epoch
          FROM turns
          WHERE chat_id = ? AND turn_id = ?
        `).get(chatId, turnId);
        candidates = database.prepare(`
          SELECT candidate_id, swipe_id
          FROM turn_candidates
          WHERE turn_id = ? AND status = 'active'
          ORDER BY candidate_id
        `).all(turnId);
      } finally {
        database.close();
      }
      if (!turn) {
        fail(
          'turn_not_found',
          'The requested committed turn does not exist.',
        );
      }
      if (candidates.length > 1) {
        fail(
          'turn_active_candidate_conflict',
          'A turn cannot have more than one active reply candidate.',
        );
      }
      if (candidates.length === 0) {
        return {
          schema: 'mnemosyne.active-candidate-result.v1',
          status: 'none',
          chat_id: chatId,
          turn_id: turnId,
          turn_index: turn.turn_index,
          branch_id: turn.branch_id,
          branch_epoch: turn.branch_epoch,
          candidate_id: null,
          swipe_id: null,
        };
      }
      return {
        schema: 'mnemosyne.active-candidate-result.v1',
        status: 'ready',
        chat_id: chatId,
        turn_id: turnId,
        turn_index: turn.turn_index,
        branch_id: turn.branch_id,
        branch_epoch: turn.branch_epoch,
        candidate_id: candidates[0].candidate_id,
        swipe_id: candidates[0].swipe_id,
      };
    },

    async activateCandidate({ chatId, turnId, candidateId }) {
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        turnId,
        candidateId,
      })) {
        assertSafeId(value, field);
      }
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      const activatedAt = now().toISOString();
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');
        const target = database.prepare(`
          SELECT
            turn_candidates.candidate_id,
            turn_candidates.patch_id,
            turn_candidates.status,
            turns.turn_id,
            turns.branch_epoch,
            branch_epochs.status AS branch_status
          FROM turn_candidates
          JOIN turns ON turns.turn_id = turn_candidates.turn_id
          JOIN branch_epochs
            ON branch_epochs.chat_id = turns.chat_id
            AND branch_epochs.branch_id = turns.branch_id
            AND branch_epochs.branch_epoch = turns.branch_epoch
          WHERE
            turns.chat_id = ?
            AND turns.turn_id = ?
            AND turn_candidates.candidate_id = ?
        `).get(chatId, turnId, candidateId);
        if (!target || target.status === 'deleted') {
          fail(
            'turn_candidate_unavailable',
            'The requested reply candidate cannot be activated.',
          );
        }
        if (target.branch_status !== 'active') {
          const activeBranch = database.prepare(`
            SELECT branch_epoch
            FROM branch_epochs
            WHERE
              chat_id = ?
              AND branch_id = (
                SELECT branch_id FROM turns WHERE turn_id = ?
              )
              AND status = 'active'
            ORDER BY branch_epoch DESC
            LIMIT 1
          `).get(chatId, turnId);
          fail(
            'branch_epoch_stale',
            'A reply candidate in a historical branch epoch cannot be activated.',
            {
              requested_branch_epoch: target.branch_epoch,
              active_branch_epoch: activeBranch?.branch_epoch ?? null,
            },
          );
        }
        if (target.status === 'active') {
          database.exec('COMMIT');
          return {
            schema: 'mnemosyne.candidate-activation-result.v1',
            status: 'existing',
            candidate_id: candidateId,
          };
        }

        database.prepare(`
          UPDATE patches
          SET status = 'rolled_back', rolled_back_at = ?
          WHERE patch_id IN (
            SELECT patch_id
            FROM turn_candidates
            WHERE turn_id = ? AND status = 'active'
          )
        `).run(activatedAt, turnId);
        database.prepare(`
          UPDATE turn_candidates
          SET status = 'inactive'
          WHERE turn_id = ? AND status = 'active'
        `).run(turnId);
        database.prepare(`
          UPDATE patches
          SET
            status = 'applied',
            applied_at = ?,
            rolled_back_at = NULL
          WHERE patch_id = ?
        `).run(activatedAt, target.patch_id);
        database.prepare(`
          UPDATE turn_candidates
          SET status = 'active', activated_at = ?
          WHERE candidate_id = ?
        `).run(activatedAt, candidateId);
        database.exec('COMMIT');
        return {
          schema: 'mnemosyne.candidate-activation-result.v1',
          status: 'activated',
          candidate_id: candidateId,
        };
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }
    },

    async activateCandidateByHostCoordinate({
      commandId,
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
      swipeId,
      throughTurnIndex,
      trustedReplayCreatedAt,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        commandId,
        branchId,
      })) {
        assertSafeId(value, field);
      }
      for (const [field, value] of Object.entries({
        branchEpoch,
        turnIndex,
        swipeId,
        throughTurnIndex,
      })) {
        assertNonNegativeInteger(value, field);
      }

      const payload = {
        branch_id: branchId,
        branch_epoch: branchEpoch,
        turn_index: turnIndex,
        swipe_id: swipeId,
        through_turn_index: throughTurnIndex,
      };
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      const activatedAt = resolveCommittedAt(
        { committedAt: trustedReplayCreatedAt },
        now,
      );
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');

        const existingEvent = database.prepare(`
          SELECT
            event_type,
            chat_id,
            payload_json,
            result_json
          FROM history_events
          WHERE command_id = ?
        `).get(commandId);
        if (existingEvent) {
          if (
            existingEvent.event_type !== 'activate_swipe'
            || existingEvent.chat_id !== chatId
            || existingEvent.payload_json !== canonicalJson(payload)
          ) {
            fail(
              'history_command_conflict',
              'The history command identity is already bound differently.',
            );
          }
          const existingResult = JSON.parse(existingEvent.result_json);
          database.exec('COMMIT');
          return {
            ...existingResult,
            status: 'existing',
          };
        }

        const branch = database.prepare(`
          SELECT status
          FROM branch_epochs
          WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
        `).get(chatId, branchId, branchEpoch);
        if (branch?.status !== 'active') {
          const activeBranch = database.prepare(`
            SELECT branch_epoch
            FROM branch_epochs
            WHERE chat_id = ? AND branch_id = ? AND status = 'active'
            ORDER BY branch_epoch DESC
            LIMIT 1
          `).get(chatId, branchId);
          fail(
            branch ? 'branch_epoch_stale' : 'branch_epoch_not_found',
            branch
              ? 'A reply candidate in a historical branch epoch cannot be activated.'
              : 'The requested branch epoch does not exist.',
            {
              requested_branch_epoch: branchEpoch,
              active_branch_epoch: activeBranch?.branch_epoch ?? null,
            },
          );
        }

        const duplicateCoordinate = database.prepare(`
          SELECT
            turn_candidates.swipe_id,
            COUNT(*) AS match_count
          FROM turns
          JOIN turn_candidates
            ON turn_candidates.turn_id = turns.turn_id
          WHERE
            turns.chat_id = ?
            AND turns.branch_id = ?
            AND turns.branch_epoch = ?
            AND turns.turn_index = ?
            AND turns.status = 'committed'
            AND turn_candidates.status <> 'deleted'
            AND turn_candidates.swipe_id IS NOT NULL
          GROUP BY turn_candidates.swipe_id
          HAVING COUNT(*) > 1
          ORDER BY turn_candidates.swipe_id
          LIMIT 1
        `).get(
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
        );
        if (duplicateCoordinate) {
          fail(
            'turn_candidate_lookup_ambiguous',
            'More than one live reply candidate shares a host coordinate.',
            {
              branch_id: branchId,
              branch_epoch: branchEpoch,
              turn_index: turnIndex,
              swipe_id: duplicateCoordinate.swipe_id,
              match_count: duplicateCoordinate.match_count,
            },
          );
        }

        const target = database.prepare(`
          SELECT
            turns.turn_id,
            turn_candidates.candidate_id,
            turn_candidates.patch_id,
            turn_candidates.status,
            turn_candidates.swipe_id
          FROM turns
          JOIN turn_candidates
            ON turn_candidates.turn_id = turns.turn_id
          WHERE
            turns.chat_id = ?
            AND turns.branch_id = ?
            AND turns.branch_epoch = ?
            AND turns.turn_index = ?
            AND turns.status = 'committed'
            AND turn_candidates.status <> 'deleted'
            AND turn_candidates.swipe_id = ?
        `).get(
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
          swipeId,
        );
        if (!target) {
          fail(
            'turn_candidate_lookup_not_found',
            'No live reply candidate matches the exact host coordinate.',
            {
              branch_id: branchId,
              branch_epoch: branchEpoch,
              turn_index: turnIndex,
              swipe_id: swipeId,
            },
          );
        }

        const activeCandidates = database.prepare(`
          SELECT candidate_id
          FROM turn_candidates
          WHERE turn_id = ? AND status = 'active'
          ORDER BY candidate_id
        `).all(target.turn_id);
        if (activeCandidates.length > 1) {
          fail(
            'turn_active_candidate_conflict',
            'A turn cannot have more than one active reply candidate.',
          );
        }

        const activationStatus = (
          target.status === 'active' ? 'existing' : 'activated'
        );
        if (target.status !== 'active') {
          database.prepare(`
            UPDATE patches
            SET status = 'rolled_back', rolled_back_at = ?
            WHERE patch_id IN (
              SELECT patch_id
              FROM turn_candidates
              WHERE turn_id = ? AND status = 'active'
            )
          `).run(activatedAt, target.turn_id);
          database.prepare(`
            UPDATE turn_candidates
            SET status = 'inactive'
            WHERE turn_id = ? AND status = 'active'
          `).run(target.turn_id);
          database.prepare(`
            UPDATE patches
            SET
              status = 'applied',
              applied_at = ?,
              rolled_back_at = NULL
            WHERE patch_id = ?
          `).run(activatedAt, target.patch_id);
          database.prepare(`
            UPDATE turn_candidates
            SET status = 'active', activated_at = ?
            WHERE candidate_id = ?
          `).run(activatedAt, target.candidate_id);
        }

        const eventId = `event_${sha256(canonicalJson({
          command_id: commandId,
          chat_id: chatId,
          payload,
        })).slice(0, 24)}`;
        const result = {
          schema: 'mnemosyne.swipe-activation-result.v1',
          status: activationStatus,
          event_id: eventId,
          turn_id: target.turn_id,
          candidate_id: target.candidate_id,
          swipe_id: target.swipe_id,
        };
        database.prepare(`
          INSERT INTO history_events (
            event_id,
            command_id,
            chat_id,
            branch_id,
            branch_epoch,
            event_type,
            payload_json,
            result_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'activate_swipe', ?, ?, ?)
        `).run(
          eventId,
          commandId,
          chatId,
          branchId,
          branchEpoch,
          canonicalJson(payload),
          canonicalJson(result),
          activatedAt,
        );
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }
    },

    async deleteCandidate({
      commandId,
      chatId,
      turnId,
      candidateId,
      fallbackCandidateId = null,
      trustedReplayCreatedAt,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        commandId,
        turnId,
        candidateId,
      })) {
        assertSafeId(value, field);
      }
      if (fallbackCandidateId !== null) {
        assertSafeId(fallbackCandidateId, 'fallbackCandidateId');
      }
      const payload = {
        turn_id: turnId,
        candidate_id: candidateId,
        fallback_candidate_id: fallbackCandidateId,
      };
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      const deletedAt = resolveCommittedAt(
        { committedAt: trustedReplayCreatedAt },
        now,
      );
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');
        const existingEvent = database.prepare(`
          SELECT
            event_type,
            chat_id,
            payload_json,
            result_json
          FROM history_events
          WHERE command_id = ?
        `).get(commandId);
        if (existingEvent) {
          if (
            existingEvent.event_type !== 'delete_candidate'
            || existingEvent.chat_id !== chatId
            || existingEvent.payload_json !== canonicalJson(payload)
          ) {
            fail(
              'history_command_conflict',
              'The history command identity is already bound differently.',
            );
          }
          const existingResult = JSON.parse(existingEvent.result_json);
          database.exec('COMMIT');
          return {
            ...existingResult,
            status: 'existing',
          };
        }

        const target = database.prepare(`
          SELECT
            turn_candidates.candidate_id,
            turn_candidates.patch_id,
            turn_candidates.status,
            turns.turn_id,
            turns.branch_id,
            turns.branch_epoch,
            branch_epochs.status AS branch_status
          FROM turn_candidates
          JOIN turns ON turns.turn_id = turn_candidates.turn_id
          JOIN branch_epochs
            ON branch_epochs.chat_id = turns.chat_id
            AND branch_epochs.branch_id = turns.branch_id
            AND branch_epochs.branch_epoch = turns.branch_epoch
          WHERE
            turns.chat_id = ?
            AND turns.turn_id = ?
            AND turn_candidates.candidate_id = ?
        `).get(chatId, turnId, candidateId);
        if (!target || target.status === 'deleted') {
          fail(
            'turn_candidate_unavailable',
            'The requested reply candidate cannot be deleted.',
          );
        }
        if (target.branch_status !== 'active') {
          const activeBranch = database.prepare(`
            SELECT branch_epoch
            FROM branch_epochs
            WHERE chat_id = ? AND branch_id = ? AND status = 'active'
            ORDER BY branch_epoch DESC
            LIMIT 1
          `).get(chatId, target.branch_id);
          fail(
            'branch_epoch_stale',
            'A reply candidate in a historical branch epoch cannot be deleted.',
            {
              requested_branch_epoch: target.branch_epoch,
              active_branch_epoch: activeBranch?.branch_epoch ?? null,
            },
          );
        }

        const activeCandidates = database.prepare(`
          SELECT candidate_id
          FROM turn_candidates
          WHERE turn_id = ? AND status = 'active'
          ORDER BY candidate_id
        `).all(turnId);
        if (activeCandidates.length > 1) {
          fail(
            'turn_active_candidate_conflict',
            'A turn cannot have more than one active reply candidate.',
          );
        }
        const currentActiveCandidateId = (
          activeCandidates[0]?.candidate_id ?? null
        );

        let fallback = null;
        if (fallbackCandidateId !== null) {
          fallback = database.prepare(`
            SELECT
              turn_candidates.candidate_id,
              turn_candidates.patch_id,
              turn_candidates.status
            FROM turn_candidates
            JOIN turns ON turns.turn_id = turn_candidates.turn_id
            WHERE
              turns.chat_id = ?
              AND turns.turn_id = ?
              AND turn_candidates.candidate_id = ?
          `).get(chatId, turnId, fallbackCandidateId);
          if (
            !fallback
            || fallback.status === 'deleted'
            || fallback.candidate_id === candidateId
          ) {
            fail(
              'candidate_delete_fallback_invalid',
              'The fallback must be a different non-deleted candidate on the same turn.',
            );
          }
        }

        if (target.status === 'active' && !fallback) {
          fail(
            'candidate_delete_fallback_required',
            'Deleting the active candidate requires an explicit fallback.',
          );
        }
        if (
          target.status !== 'active'
          && fallback
          && fallback.candidate_id !== currentActiveCandidateId
        ) {
          fail(
            'candidate_delete_fallback_invalid',
            'Deleting an inactive candidate cannot change the active candidate.',
          );
        }

        database.prepare(`
          UPDATE patches
          SET status = 'rolled_back', rolled_back_at = ?
          WHERE patch_id = ?
        `).run(deletedAt, target.patch_id);
        database.prepare(`
          UPDATE turn_memory_records
          SET status = 'inactive'
          WHERE candidate_id = ?
        `).run(candidateId);
        database.prepare(`
          UPDATE turn_candidates
          SET status = 'deleted'
          WHERE candidate_id = ?
        `).run(candidateId);

        let activeCandidateId = currentActiveCandidateId;
        if (target.status === 'active') {
          database.prepare(`
            UPDATE patches
            SET
              status = 'applied',
              applied_at = ?,
              rolled_back_at = NULL
            WHERE patch_id = ?
          `).run(deletedAt, fallback.patch_id);
          database.prepare(`
            UPDATE turn_candidates
            SET status = 'active', activated_at = ?
            WHERE candidate_id = ?
          `).run(deletedAt, fallback.candidate_id);
          activeCandidateId = fallback.candidate_id;
        }

        const eventId = `event_${sha256(canonicalJson({
          command_id: commandId,
          chat_id: chatId,
          payload,
        })).slice(0, 24)}`;
        const result = {
          schema: 'mnemosyne.candidate-deletion-result.v1',
          status: 'deleted',
          event_id: eventId,
          turn_id: turnId,
          deleted_candidate_id: candidateId,
          active_candidate_id: activeCandidateId,
        };
        database.prepare(`
          INSERT INTO history_events (
            event_id,
            command_id,
            chat_id,
            branch_id,
            branch_epoch,
            event_type,
            payload_json,
            result_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'delete_candidate', ?, ?, ?)
        `).run(
          eventId,
          commandId,
          chatId,
          target.branch_id,
          target.branch_epoch,
          canonicalJson(payload),
          canonicalJson(result),
          deletedAt,
        );
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }
    },

    async deleteCandidateByHostCoordinate({
      commandId,
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
      deletedSwipeId,
      fallbackSwipeId = null,
      throughTurnIndex,
      trustedReplayCreatedAt,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        commandId,
        branchId,
      })) {
        assertSafeId(value, field);
      }
      for (const [field, value] of Object.entries({
        branchEpoch,
        turnIndex,
        deletedSwipeId,
        throughTurnIndex,
      })) {
        assertNonNegativeInteger(value, field);
      }
      if (fallbackSwipeId !== null) {
        assertNonNegativeInteger(fallbackSwipeId, 'fallbackSwipeId');
      }

      const payload = {
        branch_id: branchId,
        branch_epoch: branchEpoch,
        turn_index: turnIndex,
        deleted_swipe_id: deletedSwipeId,
        fallback_swipe_id: fallbackSwipeId,
        through_turn_index: throughTurnIndex,
      };
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      const deletedAt = resolveCommittedAt(
        { committedAt: trustedReplayCreatedAt },
        now,
      );
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');

        // Command identity must win over the mutable host coordinate. After a
        // successful deletion, later swipes have been renumbered and resolving
        // deletedSwipeId again could otherwise select a different candidate.
        const existingEvent = database.prepare(`
          SELECT
            event_type,
            chat_id,
            payload_json,
            result_json
          FROM history_events
          WHERE command_id = ?
        `).get(commandId);
        if (existingEvent) {
          if (
            existingEvent.event_type !== 'delete_swipe'
            || existingEvent.chat_id !== chatId
            || existingEvent.payload_json !== canonicalJson(payload)
          ) {
            fail(
              'history_command_conflict',
              'The history command identity is already bound differently.',
            );
          }
          const existingResult = JSON.parse(existingEvent.result_json);
          database.exec('COMMIT');
          return {
            ...existingResult,
            status: 'existing',
          };
        }

        const branch = database.prepare(`
          SELECT status
          FROM branch_epochs
          WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
        `).get(chatId, branchId, branchEpoch);
        if (branch?.status !== 'active') {
          const activeBranch = database.prepare(`
            SELECT branch_epoch
            FROM branch_epochs
            WHERE chat_id = ? AND branch_id = ? AND status = 'active'
            ORDER BY branch_epoch DESC
            LIMIT 1
          `).get(chatId, branchId);
          fail(
            branch ? 'branch_epoch_stale' : 'branch_epoch_not_found',
            branch
              ? 'A reply candidate in a historical branch epoch cannot be deleted.'
              : 'The requested branch epoch does not exist.',
            {
              requested_branch_epoch: branchEpoch,
              active_branch_epoch: activeBranch?.branch_epoch ?? null,
            },
          );
        }

        const duplicateCoordinate = database.prepare(`
          SELECT
            turn_candidates.swipe_id,
            COUNT(*) AS match_count
          FROM turns
          JOIN turn_candidates
            ON turn_candidates.turn_id = turns.turn_id
          WHERE
            turns.chat_id = ?
            AND turns.branch_id = ?
            AND turns.branch_epoch = ?
            AND turns.turn_index = ?
            AND turns.status = 'committed'
            AND turn_candidates.status <> 'deleted'
            AND turn_candidates.swipe_id IS NOT NULL
          GROUP BY turn_candidates.swipe_id
          HAVING COUNT(*) > 1
          ORDER BY turn_candidates.swipe_id
          LIMIT 1
        `).get(
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
        );
        if (duplicateCoordinate) {
          fail(
            'turn_candidate_lookup_ambiguous',
            'More than one live reply candidate shares a host coordinate.',
            {
              branch_id: branchId,
              branch_epoch: branchEpoch,
              turn_index: turnIndex,
              swipe_id: duplicateCoordinate.swipe_id,
              match_count: duplicateCoordinate.match_count,
            },
          );
        }

        const target = database.prepare(`
          SELECT
            turns.turn_id,
            turns.branch_id,
            turns.branch_epoch,
            turn_candidates.candidate_id,
            turn_candidates.patch_id,
            turn_candidates.status,
            turn_candidates.swipe_id
          FROM turns
          JOIN turn_candidates
            ON turn_candidates.turn_id = turns.turn_id
          WHERE
            turns.chat_id = ?
            AND turns.branch_id = ?
            AND turns.branch_epoch = ?
            AND turns.turn_index = ?
            AND turns.status = 'committed'
            AND turn_candidates.status <> 'deleted'
            AND turn_candidates.swipe_id = ?
        `).get(
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
          deletedSwipeId,
        );
        if (!target) {
          fail(
            'turn_candidate_lookup_not_found',
            'No live reply candidate matches the exact old host coordinate.',
            {
              branch_id: branchId,
              branch_epoch: branchEpoch,
              turn_index: turnIndex,
              swipe_id: deletedSwipeId,
            },
          );
        }

        const activeCandidates = database.prepare(`
          SELECT candidate_id
          FROM turn_candidates
          WHERE turn_id = ? AND status = 'active'
          ORDER BY candidate_id
        `).all(target.turn_id);
        if (activeCandidates.length > 1) {
          fail(
            'turn_active_candidate_conflict',
            'A turn cannot have more than one active reply candidate.',
          );
        }
        const currentActiveCandidateId = (
          activeCandidates[0]?.candidate_id ?? null
        );

        let fallback = null;
        let oldFallbackSwipeId = null;
        if (fallbackSwipeId !== null) {
          // SillyTavern reports the fallback after splice(), while our rows
          // still have their pre-deletion coordinates inside this transaction.
          oldFallbackSwipeId = (
            fallbackSwipeId >= deletedSwipeId
              ? fallbackSwipeId + 1
              : fallbackSwipeId
          );
          fallback = database.prepare(`
            SELECT
              turn_candidates.candidate_id,
              turn_candidates.patch_id,
              turn_candidates.status,
              turn_candidates.swipe_id
            FROM turn_candidates
            WHERE
              turn_candidates.turn_id = ?
              AND turn_candidates.status <> 'deleted'
              AND turn_candidates.swipe_id = ?
          `).get(target.turn_id, oldFallbackSwipeId);
          if (!fallback || fallback.candidate_id === target.candidate_id) {
            fail(
              'candidate_delete_fallback_invalid',
              'The post-deletion fallback coordinate must identify a different live candidate.',
            );
          }
        }

        if (target.status === 'active' && !fallback) {
          fail(
            'candidate_delete_fallback_required',
            'Deleting the active candidate requires an explicit fallback.',
          );
        }
        if (
          target.status !== 'active'
          && fallback
          && fallback.candidate_id !== currentActiveCandidateId
        ) {
          fail(
            'candidate_delete_fallback_invalid',
            'Deleting an inactive candidate cannot change the active candidate.',
          );
        }

        const shiftedCandidates = database.prepare(`
          SELECT
            candidate_id,
            swipe_id AS old_swipe_id
          FROM turn_candidates
          WHERE
            turn_id = ?
            AND status <> 'deleted'
            AND swipe_id > ?
          ORDER BY swipe_id, candidate_id
        `).all(target.turn_id, deletedSwipeId).map(row => ({
          candidate_id: row.candidate_id,
          old_swipe_id: row.old_swipe_id,
          new_swipe_id: row.old_swipe_id - 1,
        }));

        database.prepare(`
          UPDATE patches
          SET status = 'rolled_back', rolled_back_at = ?
          WHERE patch_id = ?
        `).run(deletedAt, target.patch_id);
        database.prepare(`
          UPDATE turn_memory_records
          SET status = 'inactive'
          WHERE candidate_id = ?
        `).run(target.candidate_id);
        database.prepare(`
          UPDATE turn_candidates
          SET status = 'deleted', swipe_id = NULL
          WHERE candidate_id = ?
        `).run(target.candidate_id);
        database.prepare(`
          UPDATE turn_candidates
          SET swipe_id = swipe_id - 1
          WHERE
            turn_id = ?
            AND status <> 'deleted'
            AND swipe_id > ?
        `).run(target.turn_id, deletedSwipeId);

        let activeCandidateId = currentActiveCandidateId;
        if (target.status === 'active') {
          database.prepare(`
            UPDATE patches
            SET
              status = 'applied',
              applied_at = ?,
              rolled_back_at = NULL
            WHERE patch_id = ?
          `).run(deletedAt, fallback.patch_id);
          database.prepare(`
            UPDATE turn_candidates
            SET status = 'active', activated_at = ?
            WHERE candidate_id = ?
          `).run(deletedAt, fallback.candidate_id);
          activeCandidateId = fallback.candidate_id;
        }

        const eventId = `event_${sha256(canonicalJson({
          command_id: commandId,
          chat_id: chatId,
          payload,
        })).slice(0, 24)}`;
        const result = {
          schema: 'mnemosyne.swipe-deletion-result.v1',
          status: 'deleted',
          event_id: eventId,
          turn_id: target.turn_id,
          deleted_candidate_id: target.candidate_id,
          deleted_swipe_id: deletedSwipeId,
          fallback_candidate_id: fallback?.candidate_id ?? null,
          fallback_swipe_id: fallbackSwipeId,
          active_candidate_id: activeCandidateId,
          reindexed_candidates: shiftedCandidates,
        };
        database.prepare(`
          INSERT INTO history_events (
            event_id,
            command_id,
            chat_id,
            branch_id,
            branch_epoch,
            event_type,
            payload_json,
            result_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'delete_swipe', ?, ?, ?)
        `).run(
          eventId,
          commandId,
          chatId,
          branchId,
          branchEpoch,
          canonicalJson(payload),
          canonicalJson(result),
          deletedAt,
        );
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }
    },

    async truncateBranch({
      commandId,
      chatId,
      branchId,
      expectedBranchEpoch,
      cutoffTurnIndex,
      reasonCode,
      createdAt: trustedCreatedAt,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        commandId,
        branchId,
        reasonCode,
      })) {
        assertSafeId(value, field);
      }
      assertNonNegativeInteger(expectedBranchEpoch, 'expectedBranchEpoch');
      assertNonNegativeInteger(cutoffTurnIndex, 'cutoffTurnIndex');
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      const createdAt = resolveCommittedAt(
        { committedAt: trustedCreatedAt },
        now,
      );
      const payload = {
        expected_branch_epoch: expectedBranchEpoch,
        cutoff_turn_index: cutoffTurnIndex,
        reason_code: reasonCode,
      };
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');
        const existingEvent = database.prepare(`
          SELECT payload_json, result_json
          FROM history_events
          WHERE command_id = ?
        `).get(commandId);
        if (existingEvent) {
          if (existingEvent.payload_json !== canonicalJson(payload)) {
            fail(
              'history_command_conflict',
              'The history command identity is already bound differently.',
            );
          }
          const existingResult = JSON.parse(existingEvent.result_json);
          database.exec('COMMIT');
          return {
            ...existingResult,
            status: 'existing',
          };
        }

        let current = database.prepare(`
          SELECT branch_epoch
          FROM branch_epochs
          WHERE chat_id = ? AND branch_id = ? AND status = 'active'
          ORDER BY branch_epoch DESC
          LIMIT 1
        `).get(chatId, branchId);
        if (!current && expectedBranchEpoch === 0) {
          const branchCount = Number(database.prepare(`
            SELECT COUNT(*) AS count
            FROM branch_epochs
            WHERE chat_id = ? AND branch_id = ?
          `).get(chatId, branchId)?.count ?? 0);
          if (branchCount === 0) {
            database.prepare(`
              INSERT INTO branch_epochs (
                chat_id,
                branch_id,
                branch_epoch,
                parent_branch_epoch,
                parent_cutoff_turn_index_exclusive,
                status,
                head_turn_index,
                created_by_event_id,
                created_at
              ) VALUES (?, ?, 0, NULL, NULL, 'active', NULL, NULL, ?)
            `).run(chatId, branchId, createdAt);
            current = { branch_epoch: 0 };
          }
        }
        if (!current || current.branch_epoch !== expectedBranchEpoch) {
          fail(
            'branch_epoch_conflict',
            'The active branch epoch changed before truncation.',
            {
              expected_branch_epoch: expectedBranchEpoch,
              actual_branch_epoch: current?.branch_epoch ?? null,
            },
          );
        }
        const newBranchEpoch = expectedBranchEpoch + 1;
        const eventId = `event_${sha256(canonicalJson({
          command_id: commandId,
          chat_id: chatId,
          branch_id: branchId,
          payload,
        })).slice(0, 24)}`;
        const result = {
          schema: 'mnemosyne.branch-truncation-result.v1',
          status: 'truncated',
          branch_id: branchId,
          previous_branch_epoch: expectedBranchEpoch,
          new_branch_epoch: newBranchEpoch,
          inherited_through_turn_index: cutoffTurnIndex - 1,
        };
        database.prepare(`
          UPDATE branch_epochs
          SET status = 'historical'
          WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
        `).run(chatId, branchId, expectedBranchEpoch);
        database.prepare(`
          INSERT INTO branch_epochs (
            chat_id,
            branch_id,
            branch_epoch,
            parent_branch_epoch,
            parent_cutoff_turn_index_exclusive,
            status,
            head_turn_index,
            created_by_event_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(
          chatId,
          branchId,
          newBranchEpoch,
          expectedBranchEpoch,
          cutoffTurnIndex,
          cutoffTurnIndex === 0 ? null : cutoffTurnIndex - 1,
          eventId,
          createdAt,
        );
        database.prepare(`
          INSERT INTO history_events (
            event_id,
            command_id,
            chat_id,
            branch_id,
            branch_epoch,
            event_type,
            payload_json,
            result_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'truncate_branch', ?, ?, ?)
        `).run(
          eventId,
          commandId,
          chatId,
          branchId,
          expectedBranchEpoch,
          canonicalJson(payload),
          JSON.stringify(result),
          createdAt,
        );
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }
    },

    async restoreBranch({
      commandId,
      chatId,
      branchId,
      expectedBranchEpoch,
      sourceBranchEpoch,
      throughTurnIndex,
      reasonCode,
      createdAt: trustedCreatedAt,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        commandId,
        branchId,
        reasonCode,
      })) {
        assertSafeId(value, field);
      }
      assertNonNegativeInteger(expectedBranchEpoch, 'expectedBranchEpoch');
      assertNonNegativeInteger(sourceBranchEpoch, 'sourceBranchEpoch');
      assertNonNegativeInteger(throughTurnIndex, 'throughTurnIndex');
      if (sourceBranchEpoch === expectedBranchEpoch) {
        fail(
          'branch_restore_source_invalid',
          'Branch restoration requires a different historical source epoch.',
        );
      }

      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      const createdAt = resolveCommittedAt(
        { committedAt: trustedCreatedAt },
        now,
      );
      const payload = {
        expected_branch_epoch: expectedBranchEpoch,
        source_branch_epoch: sourceBranchEpoch,
        through_turn_index: throughTurnIndex,
        reason_code: reasonCode,
      };
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');
        const existingEvent = database.prepare(`
          SELECT payload_json, result_json
          FROM history_events
          WHERE command_id = ?
        `).get(commandId);
        if (existingEvent) {
          if (existingEvent.payload_json !== canonicalJson(payload)) {
            fail(
              'history_command_conflict',
              'The history command identity is already bound differently.',
            );
          }
          const existingResult = JSON.parse(existingEvent.result_json);
          database.exec('COMMIT');
          return {
            ...existingResult,
            status: 'existing',
          };
        }

        const current = database.prepare(`
          SELECT branch_epoch
          FROM branch_epochs
          WHERE chat_id = ? AND branch_id = ? AND status = 'active'
          ORDER BY branch_epoch DESC
          LIMIT 1
        `).get(chatId, branchId);
        if (!current || current.branch_epoch !== expectedBranchEpoch) {
          fail(
            'branch_epoch_conflict',
            'The active branch epoch changed before restoration.',
            {
              expected_branch_epoch: expectedBranchEpoch,
              actual_branch_epoch: current?.branch_epoch ?? null,
            },
          );
        }

        const source = database.prepare(`
          SELECT status, head_turn_index
          FROM branch_epochs
          WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
        `).get(chatId, branchId, sourceBranchEpoch);
        if (
          !source
          || source.status !== 'historical'
          || !Number.isInteger(source.head_turn_index)
          || throughTurnIndex > source.head_turn_index
        ) {
          fail(
            'branch_restore_source_invalid',
            'The requested historical branch restoration source is invalid.',
            {
              source_branch_epoch: sourceBranchEpoch,
              source_status: source?.status ?? null,
              source_head_turn_index: source?.head_turn_index ?? null,
              through_turn_index: throughTurnIndex,
            },
          );
        }

        const newBranchEpoch = expectedBranchEpoch + 1;
        const eventId = `event_${sha256(canonicalJson({
          command_id: commandId,
          chat_id: chatId,
          branch_id: branchId,
          payload,
        })).slice(0, 24)}`;
        const result = {
          schema: 'mnemosyne.branch-restoration-result.v1',
          status: 'restored',
          branch_id: branchId,
          previous_branch_epoch: expectedBranchEpoch,
          source_branch_epoch: sourceBranchEpoch,
          new_branch_epoch: newBranchEpoch,
          inherited_through_turn_index: throughTurnIndex,
        };
        database.prepare(`
          UPDATE branch_epochs
          SET status = 'historical'
          WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
        `).run(chatId, branchId, expectedBranchEpoch);
        database.prepare(`
          INSERT INTO branch_epochs (
            chat_id,
            branch_id,
            branch_epoch,
            parent_branch_epoch,
            parent_cutoff_turn_index_exclusive,
            status,
            head_turn_index,
            created_by_event_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(
          chatId,
          branchId,
          newBranchEpoch,
          sourceBranchEpoch,
          throughTurnIndex + 1,
          throughTurnIndex,
          eventId,
          createdAt,
        );
        database.prepare(`
          INSERT INTO history_events (
            event_id,
            command_id,
            chat_id,
            branch_id,
            branch_epoch,
            event_type,
            payload_json,
            result_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'restore_branch', ?, ?, ?)
        `).run(
          eventId,
          commandId,
          chatId,
          branchId,
          expectedBranchEpoch,
          canonicalJson(payload),
          canonicalJson(result),
          createdAt,
        );
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }
    },

    async readTurn({ chatId, turnId, candidateId }) {
      assertOpaqueHostId(chatId, 'chatId');
      for (const [field, value] of Object.entries({
        turnId,
        candidateId,
      })) {
        assertSafeId(value, field);
      }
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let candidate;
      try {
        candidate = database.prepare(`
          SELECT
            turn_candidates.artifact_path,
            turn_candidates.artifact_hash,
            turn_candidates.body_hash,
            turn_candidates.delta_hash,
            turns.chat_id,
            turns.turn_id,
            turn_candidates.candidate_id
          FROM turn_candidates
          JOIN turns ON turns.turn_id = turn_candidates.turn_id
          WHERE
            turns.chat_id = ?
            AND turns.turn_id = ?
            AND turn_candidates.candidate_id = ?
        `).get(chatId, turnId, candidateId);
      } finally {
        database.close();
      }
      if (!candidate?.artifact_path) {
        fail('turn_not_found', 'The requested committed turn does not exist.');
      }
      const serializedArtifact = await readFile(
        path.join(opened.chat_save_path, candidate.artifact_path),
        'utf8',
      );
      if (
        !candidate.artifact_hash
        || sha256(serializedArtifact) !== candidate.artifact_hash
      ) {
        fail(
          'turn_artifact_hash_mismatch',
          'Turn artifact content no longer matches its sealed hash.',
        );
      }
      const artifact = JSON.parse(serializedArtifact);
      if (
        artifact.chat_id !== chatId
        || artifact.turn_id !== turnId
        || artifact.candidate_id !== candidateId
      ) {
        fail('turn_artifact_identity_mismatch', 'Turn artifact identity mismatch.');
      }
      if (
        sha256(artifact.assistant_message?.content ?? '')
          !== candidate.body_hash
        || sha256(canonicalJson(artifact.delta)) !== candidate.delta_hash
      ) {
        fail(
          'turn_artifact_hash_mismatch',
          'Turn artifact body or delta hash does not match the ledger.',
        );
      }
      return artifact;
    },

    async stateAt({
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
      candidateSelector = null,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      assertNonNegativeInteger(turnIndex, 'turnIndex');
      if (
        candidateSelector !== null
        && (
          typeof candidateSelector !== 'object'
          || Array.isArray(candidateSelector)
          || candidateSelector === null
          || Object.keys(candidateSelector).some(key => (
            !['turnId', 'candidateId'].includes(key)
          ))
          || !Object.hasOwn(candidateSelector, 'turnId')
        )
      ) {
        fail(
          'state_candidate_selector_invalid',
          'candidateSelector must identify one turn and may identify one candidate.',
        );
      }
      if (candidateSelector !== null) {
        assertSafeId(candidateSelector.turnId, 'candidateSelector.turnId');
        if (Object.hasOwn(candidateSelector, 'candidateId')) {
          assertSafeId(
            candidateSelector.candidateId,
            'candidateSelector.candidateId',
          );
        }
      }
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let rows;
      let selectedCandidate = null;
      try {
        const segments = resolveBranchSegments(database, {
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
        });
        rows = selectActiveTurnMemoryRows(database, {
          chatId,
          branchId,
          segments,
          stateOnly: true,
          order: 'ascending',
        });
        if (candidateSelector !== null) {
          const candidateSelectionSql = `
            SELECT
              turns.turn_id,
              turns.turn_index,
              turns.branch_id,
              turns.branch_epoch,
              turns.status AS turn_status,
              turn_candidates.candidate_id,
              turn_candidates.status AS candidate_status
            FROM turn_candidates
            JOIN turns
              ON turns.turn_id = turn_candidates.turn_id
            WHERE
              turns.chat_id = ?
          `;
          if (Object.hasOwn(candidateSelector, 'candidateId')) {
            selectedCandidate = database.prepare(`
              ${candidateSelectionSql}
                AND turn_candidates.candidate_id = ?
            `).get(chatId, candidateSelector.candidateId);
          } else {
            const recoverableCandidates = database.prepare(`
              ${candidateSelectionSql}
                AND turns.turn_id = ?
                AND turn_candidates.status IN ('active', 'inactive')
              ORDER BY turn_candidates.candidate_id
            `).all(chatId, candidateSelector.turnId);
            if (recoverableCandidates.length > 1) {
              fail(
                'state_candidate_selector_ambiguous',
                'More than one recoverable candidate belongs to the selected turn.',
                {
                  turn_id: candidateSelector.turnId,
                  match_count: recoverableCandidates.length,
                  candidate_ids: recoverableCandidates.map(
                    candidate => candidate.candidate_id,
                  ),
                },
              );
            }
            [selectedCandidate = null] = recoverableCandidates;
            if (!selectedCandidate) {
              const deletedCandidates = database.prepare(`
                ${candidateSelectionSql}
                  AND turns.turn_id = ?
                  AND turn_candidates.status = 'deleted'
                ORDER BY turn_candidates.candidate_id
              `).all(chatId, candidateSelector.turnId);
              if (deletedCandidates.length > 0) {
                fail(
                  'state_candidate_unrecoverable',
                  'The selected turn has no recoverable reply candidate.',
                  {
                    candidate_status: 'deleted',
                    candidate_ids: deletedCandidates.map(
                      candidate => candidate.candidate_id,
                    ),
                  },
                );
              }
            }
          }
          if (!selectedCandidate) {
            fail(
              'state_candidate_not_found',
              'The selected reply candidate does not exist in this chat.',
            );
          }
          if (selectedCandidate.turn_id !== candidateSelector.turnId) {
            fail(
              'state_candidate_coordinate_mismatch',
              'The selected reply candidate does not belong to the requested turn.',
              {
                requested_turn_id: candidateSelector.turnId,
                actual_turn_id: selectedCandidate.turn_id,
              },
            );
          }
          const selectedSegment = segments.find(segment => (
            segment.branch_epoch === selectedCandidate.branch_epoch
            && selectedCandidate.turn_index <= segment.through_turn_index
          ));
          if (
            selectedCandidate.branch_id !== branchId
            || !selectedSegment
          ) {
            fail(
              'state_candidate_outside_boundary',
              'The selected reply candidate is outside the requested state boundary.',
              {
                turn_id: selectedCandidate.turn_id,
                candidate_id: selectedCandidate.candidate_id,
                candidate_branch_id: selectedCandidate.branch_id,
                candidate_branch_epoch: selectedCandidate.branch_epoch,
                candidate_turn_index: selectedCandidate.turn_index,
              },
            );
          }
          if (
            selectedCandidate.turn_status !== 'committed'
            || !['active', 'inactive'].includes(
              selectedCandidate.candidate_status,
            )
          ) {
            fail(
              'state_candidate_unrecoverable',
              'The selected reply candidate cannot reconstruct state.',
              {
                turn_status: selectedCandidate.turn_status,
                candidate_status: selectedCandidate.candidate_status,
              },
            );
          }

          const selectedRows = database.prepare(`
            SELECT
              turns.turn_index,
              turns.branch_id,
              turns.branch_epoch,
              turns.turn_id,
              turn_candidates.candidate_id,
              patches.patch_id,
              turn_memory_records.sequence_index,
              turn_memory_records.record_id,
              turn_memory_records.record_kind,
              turn_memory_records.entity_ref,
              turn_memory_records.summary,
              turn_memory_records.state_domain,
              turn_memory_records.state_key,
              turn_memory_records.state_value_json,
              turn_memory_records.state_operation,
              turn_memory_records.source_ref,
              turn_memory_records.source_start,
              turn_memory_records.source_end,
              turn_memory_records.source_mode,
              turn_memory_records.support_strength
            FROM turn_memory_records
            JOIN patches
              ON patches.patch_id = turn_memory_records.patch_id
            JOIN turn_candidates
              ON turn_candidates.candidate_id =
                turn_memory_records.candidate_id
            JOIN turns
              ON turns.turn_id = turn_candidates.turn_id
            WHERE
              turns.chat_id = ?
              AND turns.turn_id = ?
              AND turn_candidates.candidate_id = ?
              AND turn_memory_records.status = 'active'
              AND turn_memory_records.state_domain IS NOT NULL
              AND turn_memory_records.state_key IS NOT NULL
            ORDER BY
              turn_memory_records.sequence_index,
              turn_memory_records.record_id
          `).all(
            chatId,
            selectedCandidate.turn_id,
            selectedCandidate.candidate_id,
          );
          const segmentOrder = new Map(segments.map((segment, index) => (
            [segment.branch_epoch, index]
          )));
          rows = rows
            .filter(row => row.turn_id !== selectedCandidate.turn_id)
            .concat(selectedRows)
            .sort((left, right) => (
              segmentOrder.get(left.branch_epoch)
                - segmentOrder.get(right.branch_epoch)
              || left.turn_index - right.turn_index
              || left.sequence_index - right.sequence_index
              || left.record_id.localeCompare(right.record_id)
            ));
        }
      } finally {
        database.close();
      }

      const state = new Map();
      for (const row of rows) {
        const key = canonicalJson([
          row.entity_ref,
          row.state_domain,
          row.state_key,
        ]);
        if (row.state_operation === 'unset') {
          state.delete(key);
          continue;
        }
        state.set(key, {
          entity_ref: row.entity_ref,
          state_domain: row.state_domain,
          state_key: row.state_key,
          current_value: JSON.parse(row.state_value_json),
          source_refs: [row.source_ref],
          certainty: row.support_strength,
          valid_from_turn: row.turn_index,
        });
      }
      const currentState = [...state.values()].sort((left, right) => (
        left.entity_ref.localeCompare(right.entity_ref)
        || left.state_domain.localeCompare(right.state_domain)
        || left.state_key.localeCompare(right.state_key)
      ));
      return {
        schema: 'mnemosyne.state-at-result.v1',
        status: 'ready',
        chat_id: chatId,
        branch_id: branchId,
        branch_epoch: branchEpoch,
        turn_index: turnIndex,
        current_state: currentState,
        canonical_state_hash: sha256(canonicalJson(currentState)),
        ...(selectedCandidate ? {
          candidate_selection: {
            turn_id: selectedCandidate.turn_id,
            candidate_id: selectedCandidate.candidate_id,
            ledger_status: selectedCandidate.candidate_status,
          },
        } : {}),
      };
    },
  });
}
