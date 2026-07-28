import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  measureContinuityPayloadTokens,
  validateContinuityPayload,
} from '../contracts/continuity-payload.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { validateOkfBundle } from '../okf/bundle.js';
import {
  resolveBranchSegments,
  selectActiveTurnMemoryRows,
} from '../history/active-history-resolver.js';
import {
  assertDynamicProjectionReadable,
} from '../storage/dynamic-projection-transaction.js';
import {
  readVerifiedActiveHistory,
} from '../history/dynamic-story-projector.js';
import {
  formatCurrentStateMemoryRef,
} from '../memory/memory-reference.js';
import {
  assertRuntimeWorldProjectionIntegrity,
} from './runtime-world-integrity.js';
import {
  defaultStoryCraftConfig,
  normalizeStoryCraftConfig,
} from '../craft/story-craft-config.js';
import {
  selectDuePromiseRows,
} from '../craft/promise-due-ledger.js';
import {
  computeBeatRhythm,
} from '../craft/beat-rhythm-ledger.js';
import {
  readActiveLaneBodies,
} from '../craft/active-lane-bodies.js';
import {
  applySpotlightRotation,
  collectObligationDormancy,
  collectVerifiedRetrievalActivity,
} from '../craft/obligation-spotlight.js';

const MAX_CONTINUITY_TOKENS = 2400;
const MAX_HARD_CURRENT_STATE_ITEMS = 12;
const MAX_DEFERRED_CURRENT_STATE_REFS = 12;
const MAX_TYPED_LANE_ITEMS = 8;
const UNAVAILABLE_LANES = Object.freeze([
  'lexical',
  'embedding',
  'graph',
  'chronology',
  'cognition',
  'projection',
]);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function normalizeSourceRefs(value) {
  return Array.isArray(value)
    ? value.filter(ref => typeof ref === 'string' && ref.trim())
    : [];
}

function salience(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rankBySalience(items, refOf) {
  return [...items].sort((left, right) => (
    salience(right.salience) - salience(left.salience)
    || refOf(left).localeCompare(refOf(right))
  ));
}

function mapCurrentState(item) {
  const entityRef = String(item.entity_ref || '');
  return {
    ref: formatCurrentStateMemoryRef({
      entityRef,
      stateDomain: item.state_domain,
      stateKey: item.state_key,
    }),
    entity_ref: entityRef,
    state_domain: item.state_domain,
    state_key: item.state_key,
    current_value: structuredClone(item.current_value),
    source_refs: normalizeSourceRefs(item.source_refs),
    certainty: item.certainty ?? 'unknown',
  };
}

function stateCoordinate(item) {
  return canonicalJson([
    String(item.entity_ref || ''),
    String(item.state_domain || ''),
    String(item.state_key || ''),
  ]);
}

function currentStateRef(item) {
  return formatCurrentStateMemoryRef({
    entityRef: item.entity_ref,
    stateDomain: item.state_domain,
    stateKey: item.state_key,
  });
}

function activeSceneLensRefs(runtimeWorld) {
  const scene = runtimeWorld.active_scene;
  return new Set([
    scene?.ref,
    scene?.scene_ref,
    ...(Array.isArray(scene?.location_refs)
      ? scene.location_refs
      : []),
    ...(Array.isArray(scene?.participant_refs)
      ? scene.participant_refs
      : []),
  ].filter(ref => typeof ref === 'string' && ref));
}

function selectCurrentStateSlice(items, runtimeWorld) {
  const lensRefs = activeSceneLensRefs(runtimeWorld);
  const ranked = [...items].sort((left, right) => (
    Number(lensRefs.has(String(right.entity_ref || '')))
      - Number(lensRefs.has(String(left.entity_ref || '')))
    || salience(right.salience) - salience(left.salience)
    || stateCoordinate(left).localeCompare(stateCoordinate(right))
  ));
  return {
    selected: ranked.slice(0, MAX_HARD_CURRENT_STATE_ITEMS),
    deferred: ranked.slice(MAX_HARD_CURRENT_STATE_ITEMS),
  };
}

function reconstructDynamicState(rows) {
  const state = new Map();
  const removedCoordinates = new Set();
  for (const row of rows) {
    if (row.state_domain === null || row.state_key === null) continue;
    const coordinate = stateCoordinate(row);
    if (row.state_operation === 'unset') {
      state.delete(coordinate);
      removedCoordinates.add(coordinate);
      continue;
    }
    removedCoordinates.delete(coordinate);
    state.set(coordinate, {
      entity_ref: row.entity_ref,
      state_domain: row.state_domain,
      state_key: row.state_key,
      current_value: JSON.parse(row.state_value_json),
      source_refs: [row.source_ref],
      certainty: row.support_strength,
      valid_from_turn: row.turn_index,
    });
  }
  return {
    currentState: [...state.values()].sort((left, right) => (
      stateCoordinate(left).localeCompare(stateCoordinate(right))
    )),
    removedCoordinates,
  };
}

function overlayCurrentState(staticState, dynamicState, removedCoordinates) {
  const overlaid = new Map();
  for (const item of staticState) {
    overlaid.set(stateCoordinate(item), structuredClone(item));
  }
  for (const coordinate of removedCoordinates) {
    overlaid.delete(coordinate);
  }
  for (const item of dynamicState) {
    const coordinate = stateCoordinate(item);
    const baseline = overlaid.get(coordinate) ?? {};
    overlaid.set(coordinate, {
      ...baseline,
      ...structuredClone(item),
      source_refs: normalizeSourceRefs(item.source_refs),
    });
  }
  return [...overlaid.values()];
}

function canonicalBundle(bundle) {
  return bundle.concepts
    .map(concept => ({
      path: concept.path,
      frontmatter: concept.frontmatter,
      body: concept.body,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseDynamicWorld(serialized) {
  let dynamicWorld;
  try {
    dynamicWorld = JSON.parse(serialized);
  } catch {
    fail(
      'dynamic_world_invalid',
      'The chat Dynamic World projection is not valid JSON.',
    );
  }
  if (
    dynamicWorld?.schema !== 'mnemosyne.dynamic-world.v1'
    || !Array.isArray(dynamicWorld.current_state)
    || !Array.isArray(dynamicWorld.chronicle)
    || !Array.isArray(dynamicWorld.active_record_ids)
  ) {
    fail(
      'dynamic_world_invalid',
      'The chat does not have a valid Dynamic World projection.',
    );
  }
  return dynamicWorld;
}

async function loadDynamicWorld({
  opened,
  chatId,
  branchId,
  branchEpoch,
  visibleTurnIndex,
}) {
  let serialized;
  try {
    serialized = await readFile(
      path.join(opened.chat_save_path, 'derived', 'dynamic-world.json'),
      'utf8',
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const dynamicWorld = parseDynamicWorld(serialized);
  if (
    dynamicWorld.chat_id !== chatId
    || dynamicWorld.branch_id !== branchId
    || dynamicWorld.branch_epoch !== branchEpoch
  ) {
    fail(
      'dynamic_world_scope_mismatch',
      'The Dynamic World projection does not match the requested branch.',
    );
  }
  if (
    !Number.isInteger(dynamicWorld.through_turn_index)
    || dynamicWorld.through_turn_index < 0
    || dynamicWorld.through_turn_index > visibleTurnIndex
  ) {
    fail(
      'dynamic_world_outside_visible_boundary',
      'The Dynamic World projection is outside the visible turn boundary.',
      {
        through_turn_index: dynamicWorld.through_turn_index ?? null,
        visible_turn_index: visibleTurnIndex,
      },
    );
  }
  if (
    dynamicWorld.canonical_active_state_hash
      !== sha256(canonicalJson(dynamicWorld.current_state))
    || dynamicWorld.canonical_chronicle_hash
      !== sha256(canonicalJson(dynamicWorld.chronicle))
  ) {
    fail(
      'dynamic_world_hash_mismatch',
      'The Dynamic World projection does not match its canonical hashes.',
    );
  }

  const { rows } = await readVerifiedActiveHistory({
    ledgerPath: opened.ledger_path,
    chatSavePath: opened.chat_save_path,
    chatId,
    branchId,
    branchEpoch,
    turnIndex: dynamicWorld.through_turn_index,
  });
  const expectedRecordIds = rows
    .map(row => row.record_id)
    .sort((left, right) => left.localeCompare(right));
  const projectedRecordIds = [...dynamicWorld.active_record_ids]
    .sort((left, right) => String(left).localeCompare(String(right)));
  const reconstructed = reconstructDynamicState(rows);
  if (
    canonicalJson(projectedRecordIds) !== canonicalJson(expectedRecordIds)
    || canonicalJson(dynamicWorld.current_state)
      !== canonicalJson(reconstructed.currentState)
  ) {
    fail(
      'dynamic_world_ledger_mismatch',
      'The Dynamic World projection does not match active history.',
    );
  }

  const bundle = await validateOkfBundle({
    chatSavePath: opened.chat_save_path,
  });
  if (
    dynamicWorld.canonical_bundle_hash
      !== sha256(canonicalJson(canonicalBundle(bundle)))
  ) {
    fail(
      'dynamic_world_hash_mismatch',
      'The Dynamic World projection does not match its OKF bundle hash.',
    );
  }
  return {
    world: dynamicWorld,
    removedCoordinates: reconstructed.removedCoordinates,
    rows,
  };
}

function latestVisibleDynamicTurn({
  ledgerPath,
  chatId,
  branchId,
  branchEpoch,
  visibleTurnIndex,
}) {
  const database = new DatabaseSync(ledgerPath, {
    readOnly: true,
  });
  try {
    const branchExists = database.prepare(`
      SELECT 1
      FROM branch_epochs
      WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
    `).get(chatId, branchId, branchEpoch);
    if (!branchExists) return null;
    const segments = resolveBranchSegments(database, {
      chatId,
      branchId,
      branchEpoch,
      turnIndex: visibleTurnIndex,
    });
    const latestInSegment = database.prepare(`
      SELECT MAX(turns.turn_index) AS latest_turn_index
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
    `);
    let latest = null;
    for (const segment of segments) {
      const value = latestInSegment.get(
        chatId,
        branchId,
        segment.branch_epoch,
        segment.through_turn_index,
      )?.latest_turn_index;
      if (value !== null && value !== undefined) {
        latest = latest === null ? value : Math.max(latest, value);
      }
    }
    return latest;
  } finally {
    database.close();
  }
}

function mapTopology(item) {
  return {
    ref: String(item.entity_ref || ''),
    label: String(item.entity_path || item.entity_ref || ''),
    kind: item.relation ?? 'topology',
    parent_ref: String(item.parent_ref || ''),
    status: item.status ?? 'initialized',
    source_refs: normalizeSourceRefs(item.source_refs),
  };
}

function mapRetrievalHandle(item) {
  return {
    ref: String(item.entity_ref || ''),
    kind: item.type ?? 'concept',
    label: String(item.title || item.path || item.entity_ref || ''),
    status: item.status ?? 'baseline',
    source_refs: normalizeSourceRefs(item.source_refs).slice(0, 1),
  };
}

function activeScene(runtimeWorld, chatId, dynamicScene = null) {
  const scene = dynamicScene ?? runtimeWorld.active_scene;
  if (!scene) {
    return {
      status: 'unavailable',
      reason_code: 'active_scene_not_initialized',
      ref: `mnemosyne://chat/${encodeURIComponent(chatId)}/active-scene`,
      source_refs: [],
    };
  }
  return {
    status: scene.status ?? 'active',
    ref: scene.ref ?? scene.scene_ref,
    scene_ref: scene.scene_ref ?? scene.ref,
    label: scene.label,
    time_ref: scene.time_ref,
    location_refs: Array.isArray(scene.location_refs) ? scene.location_refs : [],
    participant_refs: Array.isArray(scene.participant_refs)
      ? scene.participant_refs
      : [],
    source_refs: normalizeSourceRefs(scene.source_refs),
  };
}

function parseTypedRecordPayload(row) {
  if (typeof row.record_payload_json !== 'string') return null;
  try {
    return JSON.parse(row.record_payload_json);
  } catch {
    fail(
      'dynamic_world_ledger_mismatch',
      'A typed dynamic record payload is not valid JSON.',
      { record_id: row.record_id },
    );
  }
}

function latestTypedRows(rows, {
  kind,
  keyOf,
}) {
  const latest = new Map();
  for (const row of rows) {
    if (row.record_kind !== kind) continue;
    const payload = parseTypedRecordPayload(row);
    if (!payload) continue;
    latest.set(keyOf(payload), { row, payload });
  }
  return [...latest.values()].sort((left, right) => (
    right.row.turn_index - left.row.turn_index
    || left.row.record_id.localeCompare(right.row.record_id)
  ));
}

function cognitionBoundary({ row, payload }) {
  const aboutRefs = typeof payload.about_ref === 'string'
    ? [payload.about_ref]
    : [];
  return {
    ref: row.entity_ref,
    character_ref: payload.owner_ref,
    knows_refs: payload.knowledge_state === 'knows' ? aboutRefs : [],
    believes_refs: payload.knowledge_state === 'believes' ? aboutRefs : [],
    suspects_refs: payload.knowledge_state === 'suspects' ? aboutRefs : [],
    does_not_know_refs:
      payload.knowledge_state === 'does_not_know' ? aboutRefs : [],
    source_refs: [row.source_ref],
    certainty: row.support_strength,
  };
}

function relationshipState({ row, payload }) {
  return {
    ref: row.entity_ref,
    relationship_ref: payload.relationship_ref,
    subject_ref: payload.endpoints[0],
    object_ref: payload.endpoints[1],
    state_key: 'typed_snapshot',
    value: {
      relation_kind: payload.relation_kind,
      public_status: payload.public_status,
      private_status: payload.private_status,
      trust: payload.trust,
      intimacy: payload.intimacy,
      tension: payload.tension,
      debt: payload.debt,
      hidden_feelings: payload.hidden_feelings,
      current_direction: payload.current_direction,
    },
    source_refs: [row.source_ref],
    certainty: row.support_strength,
  };
}

function dossierDelta({ row, payload }) {
  return {
    ref: row.entity_ref,
    dossier_ref: payload.subject_ref,
    entity_ref: row.entity_ref,
    field: payload.change_kind,
    value: payload.value,
    status: 'active',
    source_refs: [row.source_ref],
  };
}

function latentObligation({ row, payload }) {
  return {
    ref: row.entity_ref,
    kind: payload.thread_kind,
    status: payload.status,
    due_ref: null,
    actor_refs: structuredClone(payload.setup_refs),
    target_refs: [],
    salience: payload.current_pressure,
    source_refs: [row.source_ref],
  };
}

function dynamicSceneState(rows) {
  const latest = latestTypedRows(rows, {
    kind: 'scene_state',
    keyOf: payload => payload.scene_ref,
  })[0];
  if (!latest) return null;
  const { row, payload } = latest;
  return {
    status: 'active',
    ref: payload.scene_ref,
    scene_ref: payload.scene_ref,
    label: payload.mood,
    time_ref: payload.time,
    location_refs: payload.location_ref === null
      ? []
      : [payload.location_ref],
    participant_refs: structuredClone(payload.participants),
    source_refs: [row.source_ref],
  };
}

// M1 due surfacing: overdue promise rows keep their normal obligation shape
// and gain a data-only `due` object; most-overdue items move to the lane
// head. This states due facts only — what to write with them stays with the
// active preset and main model.
function applyDueSurfacing(obligations, {
  rows,
  visibleTurnIndex,
  topK,
}) {
  const dueRows = selectDuePromiseRows({
    rows,
    visibleTurnIndex,
    topK,
  });
  if (dueRows.length === 0) return obligations;
  const dueByRef = new Map(dueRows.map((dueRow, dueIndex) => [
    dueRow.record_entity_ref,
    { dueRow, dueIndex },
  ]));
  const surfaced = [];
  const remaining = [];
  for (const item of obligations) {
    const match = dueByRef.get(item.ref);
    if (!match) {
      remaining.push(item);
      continue;
    }
    surfaced.push({
      order: match.dueIndex,
      item: {
        ...item,
        due: {
          due_by_turn: match.dueRow.due_by_turn,
          overdue_turns: match.dueRow.overdue_turns,
          declared_salience: match.dueRow.salience,
          setup_turn_index: match.dueRow.setup_turn_index,
        },
      },
    });
  }
  surfaced.sort((left, right) => left.order - right.order);
  return [...surfaced.map(({ item }) => item), ...remaining];
}

function typedContinuityLanes(rows, {
  dueSurfacing = null,
  spotlight = null,
} = {}) {
  const cognition = latestTypedRows(rows, {
    kind: 'character_cognition',
    keyOf: payload => canonicalJson([
      payload.owner_ref,
      payload.about_ref,
      payload.record_kind,
    ]),
  }).slice(0, MAX_TYPED_LANE_ITEMS).map(cognitionBoundary);
  const relationships = latestTypedRows(rows, {
    kind: 'relationship',
    keyOf: payload => payload.relationship_ref,
  }).slice(0, MAX_TYPED_LANE_ITEMS).map(relationshipState);
  const dossier = latestTypedRows(rows, {
    kind: 'character',
    keyOf: payload => canonicalJson([
      payload.subject_ref,
      payload.change_kind,
    ]),
  }).slice(0, MAX_TYPED_LANE_ITEMS).map(dossierDelta);
  let obligations = latestTypedRows(rows, {
    kind: 'plot_thread',
    keyOf: payload => payload.thread_ref,
  }).filter(({ payload }) => (
    !['resolved', 'failed'].includes(payload.status)
  )).map(latentObligation);
  if (dueSurfacing) {
    obligations = applyDueSurfacing(obligations, dueSurfacing);
  }
  if (spotlight) {
    const scene = dynamicSceneState(rows);
    const sceneRefs = [
      scene?.scene_ref,
      ...(scene?.location_refs ?? []),
      ...(scene?.participant_refs ?? []),
    ].filter(ref => typeof ref === 'string' && ref);
    obligations = applySpotlightRotation({
      obligations,
      dormancy: spotlight.dormancy,
      laneCapacity: MAX_TYPED_LANE_ITEMS,
      quotaSeats: spotlight.quotaSeats,
      sceneRefs,
    }).lane;
  } else {
    obligations = obligations.slice(0, MAX_TYPED_LANE_ITEMS);
  }
  return {
    activeScene: dynamicSceneState(rows),
    cognition,
    relationships,
    dossier,
    obligations,
  };
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function effectiveHardCap({ hardCapTokens, availableInputTokens }) {
  const requested = Number.isInteger(hardCapTokens) && hardCapTokens > 0
    ? hardCapTokens
    : MAX_CONTINUITY_TOKENS;
  const availableCap = Number.isFinite(availableInputTokens)
    ? Math.floor(availableInputTokens * 0.15)
    : MAX_CONTINUITY_TOKENS;
  const cap = Math.min(MAX_CONTINUITY_TOKENS, requested, availableCap);
  if (cap <= 0) {
    fail(
      'continuity_payload_budget_unavailable',
      'No input budget is available for the Continuity Payload.',
    );
  }
  return cap;
}

function trimToBudget(payload, {
  hardCapTokens,
  measureTokens,
}) {
  const initialOmissions = structuredClone(payload.omissions);
  const removed = {
    beat_rhythm: 0,
    retrieval_handles: 0,
    state_atlas_handles: 0,
    cognition_boundaries: 0,
    relationship_state: 0,
    active_dossier_deltas: 0,
    latent_obligation_refs: 0,
    hard_current_state: 0,
  };

  function updateOmission() {
    const detail = Object.entries(removed)
      .filter(([, count]) => count > 0)
      .map(([lane, count]) => `${lane}:${count}`)
      .join(', ');
    payload.omissions = [
      ...initialOmissions,
      ...(detail
        ? [{
            code: 'continuity_budget_trimmed',
            detail,
            reason: 'hard_token_cap',
            refs: [],
            source_refs: [],
          }]
        : []),
    ];
  }

  function measured() {
    payload.budget_report.estimated_tokens = 0;
    return measureContinuityPayloadTokens(payload, { measureTokens });
  }

  updateOmission();
  while (measured() > hardCapTokens) {
    if (payload.beat_rhythm !== undefined) {
      delete payload.beat_rhythm;
      removed.beat_rhythm = 1;
    } else if (payload.retrieval_handles.length > 0) {
      payload.retrieval_handles.pop();
      removed.retrieval_handles += 1;
    } else if (payload.state_atlas_handles.length > 0) {
      payload.state_atlas_handles.pop();
      removed.state_atlas_handles += 1;
    } else if (payload.cognition_boundaries.length > 0) {
      payload.cognition_boundaries.pop();
      removed.cognition_boundaries += 1;
    } else if (payload.relationship_state.length > 0) {
      payload.relationship_state.pop();
      removed.relationship_state += 1;
    } else if (payload.active_dossier_deltas.length > 0) {
      payload.active_dossier_deltas.pop();
      removed.active_dossier_deltas += 1;
    } else if (payload.latent_obligation_refs.length > 0) {
      payload.latent_obligation_refs.pop();
      removed.latent_obligation_refs += 1;
    } else if (payload.hard_current_state.length > 0) {
      fail(
        'continuity_payload_hard_state_budget_exceeded',
        'Hard current state cannot be removed to satisfy the Continuity Payload budget.',
        {
          hard_cap_tokens: hardCapTokens,
          hard_state_count: payload.hard_current_state.length,
        },
      );
    } else {
      fail(
        'continuity_payload_budget_too_small',
        'The Continuity Payload envelope cannot fit the configured hard cap.',
        { hard_cap_tokens: hardCapTokens },
      );
    }
    updateOmission();
  }
}

export function createContinuityComposer({
  store,
  measureTokens,
  storyCraft,
  runJournal = null,
} = {}) {
  if (
    !store?.openChatForAdmin
    || !store?.getActiveStaticLoreSnapshotForAdmin
  ) {
    throw new Error('Continuity Composer requires a trusted chat-save store.');
  }
  const craftConfig = storyCraft === undefined
    ? defaultStoryCraftConfig()
    : normalizeStoryCraftConfig(storyCraft);

  return Object.freeze({
    async compose({
      chatId,
      runScope,
      availableInputTokens,
      hardCapTokens = MAX_CONTINUITY_TOKENS,
      onCraftDegrade = null,
    }) {
      if (runScope?.chat_id !== chatId) {
        fail(
          'continuity_payload_scope_mismatch',
          'Continuity Payload run scope does not match the requested chat.',
        );
      }
      const branchId = runScope.branch_id ?? 'main';
      const {
        branch_id: _branchId,
        ...payloadRunScope
      } = structuredClone(runScope);
      const opened = await store.openChatForAdmin({ chatId });
      await assertDynamicProjectionReadable({
        chatSavePath: opened.chat_save_path,
      });
      const runtimeWorldPath = path.join(
        opened.chat_save_path,
        'derived',
        'runtime-world.json',
      );
      let serializedRuntimeWorld;
      try {
        serializedRuntimeWorld = await readFile(runtimeWorldPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          fail(
            'runtime_world_unavailable',
            'The chat has not completed Static Lore initialization.',
          );
        }
        throw error;
      }
      let runtimeWorld;
      try {
        runtimeWorld = JSON.parse(serializedRuntimeWorld);
      } catch {
        fail(
          'runtime_world_invalid',
          'The chat Runtime World projection is not valid JSON.',
        );
      }
      if (
        runtimeWorld.schema !== 'mnemosyne.runtime-world.v1'
        || runtimeWorld.status !== 'ready'
      ) {
        fail(
          'runtime_world_unavailable',
          'The chat does not have a ready Runtime World projection.',
        );
      }
      const activeSnapshot = await store.getActiveStaticLoreSnapshotForAdmin({
        chatId,
      });
      const projectionDatabase = new DatabaseSync(
        opened.ledger_path,
        { readOnly: true },
      );
      let readyProjectionHashes;
      try {
        readyProjectionHashes = projectionDatabase.prepare(`
          SELECT source_version_hash
          FROM derived_state
          WHERE
            chat_id = ?
            AND projection_kind = 'runtime_world'
            AND status = 'ready'
          ORDER BY updated_at DESC, projection_id DESC
        `).all(chatId).map(row => row.source_version_hash);
      } finally {
        projectionDatabase.close();
      }
      try {
        assertRuntimeWorldProjectionIntegrity({
          runtimeWorld,
          activeSnapshot,
          readyProjectionHashes,
        });
      } catch (error) {
        if (
          error?.reasonCode
            === 'runtime_world_snapshot_not_active'
        ) {
          fail(
            'runtime_world_snapshot_not_active',
            'The Runtime World does not match the active compiled Static Lore Snapshot.',
          );
        }
        if (error?.reasonCode === 'runtime_world_view_invalid') {
          fail(
            'runtime_world_unavailable',
            'The chat does not have a ready Runtime World projection.',
          );
        }
        fail(
          'runtime_world_projection_not_governed',
          'The Runtime World file does not match its sole ready projection record.',
          {
            cause:
              error?.reasonCode
              ?? 'runtime_world_integrity_failed',
          },
        );
      }

      const latestDynamicTurn = latestVisibleDynamicTurn({
        ledgerPath: opened.ledger_path,
        chatId,
        branchId,
        branchEpoch: runScope.branch_epoch,
        visibleTurnIndex: runScope.visible_turn_index,
      });
      const dynamicProjection = await loadDynamicWorld({
        opened,
        chatId,
        branchId,
        branchEpoch: runScope.branch_epoch,
        visibleTurnIndex: runScope.visible_turn_index,
      });
      if (latestDynamicTurn !== null && !dynamicProjection) {
        fail(
          'dynamic_world_required',
          'Visible committed history requires a Dynamic World projection.',
          { latest_visible_dynamic_turn_index: latestDynamicTurn },
        );
      }
      if (
        dynamicProjection
        && latestDynamicTurn !== null
        && dynamicProjection.world.through_turn_index < latestDynamicTurn
      ) {
        fail(
          'dynamic_world_stale',
          'The Dynamic World projection trails visible committed history.',
          {
            projected_through_turn_index:
              dynamicProjection.world.through_turn_index,
            latest_visible_dynamic_turn_index: latestDynamicTurn,
          },
        );
      }

      const hardCap = effectiveHardCap({
        hardCapTokens,
        availableInputTokens,
      });
      const currentState = dynamicProjection
        ? overlayCurrentState(
          runtimeWorld.current_state ?? [],
          dynamicProjection.world.current_state,
          dynamicProjection.removedCoordinates,
        )
        : runtimeWorld.current_state ?? [];
      // M5 spotlight rotation: statistics failures fail closed to the
      // existing deterministic obligations ordering and are reported through
      // the degrade callback, never by blocking the payload.
      let spotlight = null;
      if (
        craftConfig.obligation_spotlight.enabled
        && dynamicProjection
      ) {
        try {
          const bodies = await readActiveLaneBodies({
            chatSavePath: opened.chat_save_path,
            ledgerPath: opened.ledger_path,
            chatId,
            branchId,
            branchEpoch: runScope.branch_epoch,
            throughTurnIndex:
              dynamicProjection.world.through_turn_index,
          });
          const baseDormancy = collectObligationDormancy({
            rows: dynamicProjection.rows,
            bodies,
            visibleTurnIndex: runScope.visible_turn_index,
          });
          let retrievalActivity = {};
          if (runJournal?.list) {
            const journals = (await runJournal.list({
              chatId,
              limit: 50,
            })).journals;
            retrievalActivity = collectVerifiedRetrievalActivity({
              journals,
              dormancy: baseDormancy,
              activeCandidates: new Map(bodies.map(body => [
                body.turn_index,
                body.candidate_id,
              ])),
              chatId,
              branchId,
              branchEpoch: runScope.branch_epoch,
              throughTurnIndex: runScope.visible_turn_index,
            });
          }
          spotlight = {
            dormancy: collectObligationDormancy({
              rows: dynamicProjection.rows,
              bodies,
              retrievalActivity,
              visibleTurnIndex: runScope.visible_turn_index,
            }),
            quotaSeats: craftConfig.obligation_spotlight.quota_seats,
          };
        } catch (error) {
          spotlight = null;
          if (typeof onCraftDegrade === 'function') {
            try {
              onCraftDegrade({
                mechanism: 'obligation_spotlight',
                reason_code:
                  error?.reasonCode ?? 'obligation_spotlight_failed',
              });
            } catch {
              // The degrade observer must never block composition.
            }
          }
        }
      }
      const typedLanes = dynamicProjection
        ? typedContinuityLanes(dynamicProjection.rows, {
            dueSurfacing: craftConfig.promise_due_surfacing.enabled
              ? {
                  rows: dynamicProjection.rows,
                  visibleTurnIndex: runScope.visible_turn_index,
                  topK: craftConfig.promise_due_surfacing.top_k,
                }
              : null,
            spotlight,
          })
        : {
            activeScene: null,
            cognition: [],
            relationships: [],
            dossier: [],
            obligations: [],
          };
      const effectiveRuntimeWorld = typedLanes.activeScene
        ? {
            ...runtimeWorld,
            active_scene: typedLanes.activeScene,
          }
        : runtimeWorld;
      const currentStateSlice = selectCurrentStateSlice(
        currentState,
        effectiveRuntimeWorld,
      );
      // M2 beat rhythm: data-only distribution facts, injected only when
      // the trigger gate fires so quiet stretches cost zero tokens.
      const beatRhythm = craftConfig.beat_rhythm.enabled && dynamicProjection
        ? computeBeatRhythm({
            rows: dynamicProjection.rows,
            windowScenes: craftConfig.beat_rhythm.window_scenes,
            sequenceLength: craftConfig.beat_rhythm.sequence_length,
            triggerSameTypeRun:
              craftConfig.beat_rhythm.trigger_same_type_run,
            triggerPositiveRun:
              craftConfig.beat_rhythm.trigger_positive_run,
          })
        : null;
      const rankedTopology = rankBySalience(
        runtimeWorld.topology ?? [],
        item => String(item.entity_ref || ''),
      );
      const rankedRetrievalHandles = rankBySalience(
        runtimeWorld.retrieval_handles ?? [],
        item => String(item.entity_ref || ''),
      );
      const payload = {
        schema: 'mnemosyne.continuity-payload.v1',
        run_scope: payloadRunScope,
        active_scene: removeUndefined(activeScene(
          runtimeWorld,
          chatId,
          typedLanes.activeScene,
        )),
        hard_current_state:
          currentStateSlice.selected.map(mapCurrentState),
        cognition_boundaries: typedLanes.cognition,
        relationship_state: typedLanes.relationships,
        active_dossier_deltas: typedLanes.dossier,
        state_atlas_handles: rankedTopology.map(mapTopology),
        latent_obligation_refs: typedLanes.obligations,
        retrieval_handles: rankedRetrievalHandles.map(mapRetrievalHandle),
        ...(beatRhythm?.triggered
          ? {
              beat_rhythm: {
                ...beatRhythm.statistics,
                trigger: beatRhythm.trigger,
              },
            }
          : {}),
        unknowns: [],
        omissions: currentStateSlice.deferred.length > 0
          ? [{
              code: 'current_state_deferred_to_retrieval',
              detail: `deferred:${currentStateSlice.deferred.length}`,
              reason: 'progressive_disclosure',
              refs: currentStateSlice.deferred
                .slice(0, MAX_DEFERRED_CURRENT_STATE_REFS)
                .map(currentStateRef),
              source_refs: [],
            }]
          : [],
        budget_report: {
          estimated_tokens: 0,
          hard_cap_tokens: hardCap,
          measurement: measureTokens
            ? 'host_tokenizer'
            : 'utf8_byte_upper_bound',
          unavailable_lanes: dynamicProjection
            ? UNAVAILABLE_LANES.filter(lane => (
                lane !== 'projection'
                && !(
                  lane === 'cognition'
                  && typedLanes.cognition.length > 0
                )
              ))
            : [...UNAVAILABLE_LANES],
        },
      };

      trimToBudget(payload, {
        hardCapTokens: hardCap,
        measureTokens,
      });
      return validateContinuityPayload(payload, {
        availableInputTokens,
        measureTokens,
      });
    },
  });
}
