import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { inspectStaticBaseline } from './static-baseline-binding.js';
import {
  verifyRootRunReplayContract,
} from './root-run-replay.js';

const CONTRACT_SCHEMA = 'mnemosyne.branch-history-replay-contract.v2';
const APPLY_RESULT_SCHEMA =
  'mnemosyne.branch-history-replay-apply-result.v1';
const ARTIFACT_SCHEMA = 'mnemosyne.turn-artifact.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PATCH_ID_PATTERN = /^patch_[a-f0-9]{24}$/;
const EVENT_TYPES = new Set([
  'commit_candidate',
  'activate_swipe',
  'delete_swipe',
  'delete_candidate',
  'truncate_branch',
]);
const CONTRACT_KEYS = [
  'branch_id',
  'chat_id',
  'contract_hash',
  'evidence_hashes',
  'final_projection',
  'final_governance',
  'final_state',
  'operations',
  'root_branch_epoch',
  'root_run_contract',
  'schema',
  'target_branch_epoch',
  'through_turn_index',
];
const EVIDENCE_HASH_KEYS = [
  'final_projection_hash',
  'final_governance_hash',
  'final_state_hash',
  'operations_hash',
  'root_run_contract_hash',
  'static_baseline_hash',
];
const PROJECTION_HASH_FIELDS = [
  'canonical_active_state_hash',
  'canonical_chronicle_hash',
  'canonical_bundle_hash',
];
const GOVERNANCE_KEYS = [
  'active_set',
  'branch_epochs',
  'patches',
  'schema',
  'turn_candidates',
  'turn_memory_records',
  'turns',
];
const ACTIVE_SET_KEYS = [
  'candidate_ids',
  'patch_ids',
  'record_ids',
  'segments',
  'turn_ids',
];
const OPERATION_KEYS = [
  'branch_epoch',
  'branch_id',
  'chat_id',
  'command_id',
  'created_at',
  'event_id',
  'event_type',
  'payload',
  'result',
  'sequence',
];
const COMMIT_PAYLOAD_KEYS = [
  'branch_epoch',
  'branch_id',
  'candidate_id',
  'swipe_id',
  'turn_id',
  'turn_index',
];
const COMMIT_RESULT_KEYS = [
  'artifact_hash',
  'body_hash',
  'delta_hash',
  'patch_id',
  'schema',
  'status',
];
const ACTIVATE_SWIPE_PAYLOAD_KEYS = [
  'branch_epoch',
  'branch_id',
  'swipe_id',
  'through_turn_index',
  'turn_index',
];
const ACTIVATE_SWIPE_RESULT_KEYS = [
  'candidate_id',
  'event_id',
  'schema',
  'status',
  'swipe_id',
  'turn_id',
];
const DELETE_SWIPE_PAYLOAD_KEYS = [
  'branch_epoch',
  'branch_id',
  'deleted_swipe_id',
  'fallback_swipe_id',
  'through_turn_index',
  'turn_index',
];
const DELETE_SWIPE_RESULT_KEYS = [
  'active_candidate_id',
  'deleted_candidate_id',
  'deleted_swipe_id',
  'event_id',
  'fallback_candidate_id',
  'fallback_swipe_id',
  'reindexed_candidates',
  'schema',
  'status',
  'turn_id',
];
const DELETE_CANDIDATE_PAYLOAD_KEYS = [
  'candidate_id',
  'fallback_candidate_id',
  'turn_id',
];
const DELETE_CANDIDATE_RESULT_KEYS = [
  'active_candidate_id',
  'deleted_candidate_id',
  'event_id',
  'schema',
  'status',
  'turn_id',
];
const TRUNCATE_PAYLOAD_KEYS = [
  'cutoff_turn_index',
  'expected_branch_epoch',
  'reason_code',
];
const TRUNCATE_RESULT_KEYS = [
  'branch_id',
  'inherited_through_turn_index',
  'new_branch_epoch',
  'previous_branch_epoch',
  'schema',
  'status',
];
const BRANCH_EPOCH_ROW_KEYS = [
  'branch_epoch',
  'branch_id',
  'chat_id',
  'created_at',
  'created_by_event_id',
  'head_turn_index',
  'parent_branch_epoch',
  'parent_cutoff_turn_index_exclusive',
  'status',
];
const TURN_ROW_KEYS = [
  'branch_epoch',
  'branch_id',
  'chat_id',
  'created_at',
  'message_hash',
  'run_id',
  'status',
  'turn_id',
  'turn_index',
];
const CANDIDATE_ROW_KEYS = [
  'activated_at',
  'artifact_hash',
  'artifact_path',
  'body_hash',
  'candidate_id',
  'delta_hash',
  'patch_id',
  'prompt_spine_hash',
  'run_id',
  'status',
  'swipe_id',
  'turn_id',
];
const PATCH_ROW_KEYS = [
  'applied_at',
  'candidate_id',
  'chat_id',
  'patch_id',
  'prepared_at',
  'reason_code',
  'rolled_back_at',
  'source_index_end',
  'source_index_start',
  'status',
];
const RECORD_ROW_KEYS = [
  'candidate_id',
  'entity_ref',
  'patch_id',
  'record_id',
  'record_kind',
  'record_payload_json',
  'sequence_index',
  'source_end',
  'source_mode',
  'source_ref',
  'source_start',
  'state_domain',
  'state_key',
  'state_operation',
  'state_value_json',
  'status',
  'summary',
  'support_strength',
];

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function isObject(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  );
}

function exactKeys(value, keys) {
  return (
    isObject(value)
    && Object.keys(value).sort().join('\n')
      === [...keys].sort().join('\n')
  );
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime())
    && timestamp.toISOString() === value
  );
}

function assertHash(value, field) {
  if (!HASH_PATTERN.test(value ?? '')) {
    fail(
      'branch_history_contract_invalid',
      `${field} must be a lowercase SHA-256 hash.`,
      { field },
    );
  }
}

function assertArtifact(artifact, operation) {
  if (
    !isObject(artifact)
    || artifact.schema !== ARTIFACT_SCHEMA
    || artifact.chat_id !== operation.chat_id
    || artifact.branch_id !== operation.branch_id
    || artifact.branch_epoch !== operation.branch_epoch
    || artifact.turn_id !== operation.payload.turn_id
    || artifact.candidate_id !== operation.payload.candidate_id
    || artifact.turn_index !== operation.payload.turn_index
    || artifact.swipe_id !== operation.payload.swipe_id
    || artifact.patch_id !== operation.result.patch_id
    || artifact.body_hash !== operation.result.body_hash
    || artifact.delta_hash !== operation.result.delta_hash
    || artifact.user_message?.role !== 'user'
    || typeof artifact.user_message.content !== 'string'
    || artifact.assistant_message?.role !== 'assistant'
    || typeof artifact.assistant_message.content !== 'string'
    || !isCanonicalIsoTimestamp(artifact.committed_at)
    || artifact.committed_at !== operation.created_at
    || sha256(artifact.assistant_message.content) !== artifact.body_hash
    || sha256(canonicalJson(artifact.delta)) !== artifact.delta_hash
    || sha256(`${JSON.stringify(artifact, null, 2)}\n`)
      !== operation.result.artifact_hash
  ) {
    fail(
      'branch_history_artifact_invalid',
      'A commit operation does not match its sealed turn artifact.',
      { sequence: operation.sequence },
    );
  }
}

function assertOperation(operation, {
  chatId,
  branchId,
  sequence,
}) {
  const isCommit = operation?.event_type === 'commit_candidate';
  const keys = [...OPERATION_KEYS, ...(isCommit ? ['artifact'] : [])];
  if (
    !exactKeys(operation, keys)
    || operation.sequence !== sequence
    || operation.chat_id !== chatId
    || operation.branch_id !== branchId
    || !Number.isInteger(operation.branch_epoch)
    || operation.branch_epoch < 0
    || typeof operation.event_id !== 'string'
    || !operation.event_id
    || typeof operation.command_id !== 'string'
    || !operation.command_id
    || !EVENT_TYPES.has(operation.event_type)
    || !isCanonicalIsoTimestamp(operation.created_at)
    || !isObject(operation.payload)
    || !isObject(operation.result)
  ) {
    fail(
      'branch_history_operation_invalid',
      'A branch history operation is not a canonical audited event.',
      { sequence },
    );
  }
  const eventIdentity = {
    command_id: operation.command_id,
    chat_id: operation.chat_id,
    ...(operation.event_type === 'truncate_branch'
      ? { branch_id: operation.branch_id }
      : {}),
    payload: operation.payload,
  };
  const expectedEventId =
    `event_${sha256(canonicalJson(eventIdentity)).slice(0, 24)}`;
  if (operation.event_id !== expectedEventId) {
    fail(
      'branch_history_operation_invalid',
      'A history event id is not deterministic from its command and payload.',
      { sequence },
    );
  }

  if (isCommit) {
    if (
      !exactKeys(operation.payload, COMMIT_PAYLOAD_KEYS)
      || !exactKeys(operation.result, COMMIT_RESULT_KEYS)
      || operation.command_id
        !== `commit-${operation.payload.candidate_id}`
      || operation.result.schema
        !== 'mnemosyne.commit-candidate-event-result.v1'
      || operation.result.status !== 'committed'
    ) {
      fail(
        'branch_history_operation_invalid',
        'A commit event has an invalid result.',
        { sequence },
      );
    }
    if (!PATCH_ID_PATTERN.test(operation.result.patch_id ?? '')) {
      fail(
        'branch_history_operation_invalid',
        'A commit event has an invalid patch id.',
        { sequence },
      );
    }
    for (const field of ['body_hash', 'delta_hash', 'artifact_hash']) {
      assertHash(
        operation.result[field],
        `operations[${sequence}].result.${field}`,
      );
    }
    assertArtifact(operation.artifact, operation);
    return;
  }

  if (operation.event_type === 'activate_swipe') {
    if (
      !exactKeys(operation.payload, ACTIVATE_SWIPE_PAYLOAD_KEYS)
      || !exactKeys(operation.result, ACTIVATE_SWIPE_RESULT_KEYS)
      || operation.result.schema !== 'mnemosyne.swipe-activation-result.v1'
      || !['activated', 'existing'].includes(operation.result.status)
      || operation.result.event_id !== operation.event_id
      || operation.result.swipe_id !== operation.payload.swipe_id
      || operation.payload.branch_id !== operation.branch_id
      || operation.payload.branch_epoch !== operation.branch_epoch
    ) {
      fail(
        'branch_history_operation_invalid',
        'A swipe activation event is internally inconsistent.',
        { sequence },
      );
    }
    return;
  }

  if (operation.event_type === 'delete_swipe') {
    if (
      !exactKeys(operation.payload, DELETE_SWIPE_PAYLOAD_KEYS)
      || !exactKeys(operation.result, DELETE_SWIPE_RESULT_KEYS)
      || operation.result.schema !== 'mnemosyne.swipe-deletion-result.v1'
      || operation.result.status !== 'deleted'
      || operation.result.event_id !== operation.event_id
      || operation.result.deleted_swipe_id
        !== operation.payload.deleted_swipe_id
      || operation.payload.branch_id !== operation.branch_id
      || operation.payload.branch_epoch !== operation.branch_epoch
      || !Array.isArray(operation.result.reindexed_candidates)
      || operation.result.reindexed_candidates.some(candidate => (
        !exactKeys(candidate, [
          'candidate_id',
          'new_swipe_id',
          'old_swipe_id',
        ])
      ))
    ) {
      fail(
        'branch_history_operation_invalid',
        'A swipe deletion event is internally inconsistent.',
        { sequence },
      );
    }
    return;
  }

  if (operation.event_type === 'delete_candidate') {
    if (
      !exactKeys(operation.payload, DELETE_CANDIDATE_PAYLOAD_KEYS)
      || !exactKeys(operation.result, DELETE_CANDIDATE_RESULT_KEYS)
      || operation.result.schema
        !== 'mnemosyne.candidate-deletion-result.v1'
      || operation.result.status !== 'deleted'
      || operation.result.event_id !== operation.event_id
      || operation.result.turn_id !== operation.payload.turn_id
      || operation.result.deleted_candidate_id
        !== operation.payload.candidate_id
    ) {
      fail(
        'branch_history_operation_invalid',
        'A candidate deletion event is internally inconsistent.',
        { sequence },
      );
    }
    return;
  }

  if (
    !exactKeys(operation.payload, TRUNCATE_PAYLOAD_KEYS)
    || !exactKeys(operation.result, TRUNCATE_RESULT_KEYS)
    || operation.result.schema !== 'mnemosyne.branch-truncation-result.v1'
    || operation.result.status !== 'truncated'
    || operation.payload.expected_branch_epoch !== operation.branch_epoch
    || operation.result.previous_branch_epoch !== operation.branch_epoch
    || operation.result.new_branch_epoch !== operation.branch_epoch + 1
    || operation.result.inherited_through_turn_index
      !== operation.payload.cutoff_turn_index - 1
  ) {
    fail(
      'branch_history_operation_invalid',
      'A branch truncation event is internally inconsistent.',
      { sequence },
    );
  }
}

function assertFinalState(snapshot, contract) {
  if (
    !isObject(snapshot)
    || snapshot.schema !== 'mnemosyne.state-at-result.v1'
    || snapshot.status !== 'ready'
    || snapshot.chat_id !== contract.chat_id
    || snapshot.branch_id !== contract.branch_id
    || snapshot.branch_epoch !== contract.target_branch_epoch
    || snapshot.turn_index !== contract.through_turn_index
    || !Array.isArray(snapshot.current_state)
  ) {
    fail(
      'branch_history_final_state_invalid',
      'The final state snapshot does not match the target coordinate.',
    );
  }
  assertHash(snapshot.canonical_state_hash, 'final_state.canonical_state_hash');
  if (
    sha256(canonicalJson(snapshot.current_state))
      !== snapshot.canonical_state_hash
  ) {
    fail(
      'branch_history_final_state_invalid',
      'The final state snapshot no longer matches its canonical hash.',
    );
  }
}

function assertFinalProjection(projection, contract) {
  if (
    !isObject(projection)
    || projection.schema
      !== 'mnemosyne.dynamic-story-projection-result.v1'
    || projection.status !== 'ready'
    || projection.chat_id !== contract.chat_id
    || projection.branch_id !== contract.branch_id
    || projection.branch_epoch !== contract.target_branch_epoch
    || projection.through_turn_index !== contract.through_turn_index
    || !Array.isArray(projection.dynamic_concept_paths)
  ) {
    fail(
      'branch_history_final_projection_invalid',
      'The final dynamic projection does not match the target coordinate.',
    );
  }
  for (const field of PROJECTION_HASH_FIELDS) {
    assertHash(projection[field], `final_projection.${field}`);
  }
}

function deriveActiveSet(governance, contract) {
  const branches = new Map(governance.branch_epochs.map(row => (
    [row.branch_epoch, row]
  )));
  const segments = [];
  const visited = new Set();
  function visit(epoch, throughTurnIndex) {
    if (visited.has(epoch)) {
      fail(
        'branch_history_governance_invalid',
        'Final governance branch ancestry contains a cycle.',
      );
    }
    visited.add(epoch);
    const branch = branches.get(epoch);
    if (!branch) {
      fail(
        'branch_history_governance_invalid',
        'Final governance is missing a branch ancestor.',
        { branch_epoch: epoch },
      );
    }
    if (branch.parent_branch_epoch !== null) {
      visit(
        branch.parent_branch_epoch,
        Math.min(
          throughTurnIndex,
          branch.parent_cutoff_turn_index_exclusive - 1,
        ),
      );
    }
    segments.push({
      branch_epoch: epoch,
      through_turn_index: throughTurnIndex,
    });
  }
  visit(contract.target_branch_epoch, contract.through_turn_index);
  const segmentByEpoch = new Map(segments.map(segment => (
    [segment.branch_epoch, segment]
  )));
  const visibleTurns = governance.turns.filter(turn => (
    turn.status === 'committed'
    && segmentByEpoch.has(turn.branch_epoch)
    && turn.turn_index
      <= segmentByEpoch.get(turn.branch_epoch).through_turn_index
  ));
  const visibleTurnIds = new Set(visibleTurns.map(turn => turn.turn_id));
  const patchById = new Map(governance.patches.map(patch => (
    [patch.patch_id, patch]
  )));
  const activeCandidates = governance.turn_candidates.filter(candidate => (
    visibleTurnIds.has(candidate.turn_id)
    && candidate.status === 'active'
    && patchById.get(candidate.patch_id)?.status === 'applied'
  ));
  const activeCandidateIds = new Set(activeCandidates.map(candidate => (
    candidate.candidate_id
  )));
  const activePatchIds = new Set(activeCandidates.map(candidate => (
    candidate.patch_id
  )));
  const activeRecords = governance.turn_memory_records.filter(record => (
    record.status === 'active'
    && activeCandidateIds.has(record.candidate_id)
    && activePatchIds.has(record.patch_id)
  ));
  return {
    segments,
    turn_ids: [...new Set(activeCandidates.map(candidate => (
      candidate.turn_id
    )))].sort(),
    candidate_ids: [...activeCandidateIds].sort(),
    patch_ids: [...activePatchIds].sort(),
    record_ids: activeRecords.map(record => record.record_id).sort(),
  };
}

function reconstructGovernedState(governance, contract) {
  const activeRecordIds = new Set(governance.active_set.record_ids);
  const turns = new Map(governance.turns.map(turn => [turn.turn_id, turn]));
  const candidates = new Map(governance.turn_candidates.map(candidate => (
    [candidate.candidate_id, candidate]
  )));
  const segmentOrder = new Map(
    governance.active_set.segments.map((segment, index) => (
      [segment.branch_epoch, index]
    )),
  );
  const records = governance.turn_memory_records
    .filter(record => (
      activeRecordIds.has(record.record_id)
      && record.state_domain !== null
      && record.state_key !== null
    ))
    .sort((left, right) => {
      const leftTurn = turns.get(candidates.get(left.candidate_id)?.turn_id);
      const rightTurn = turns.get(candidates.get(right.candidate_id)?.turn_id);
      return (
        segmentOrder.get(leftTurn.branch_epoch)
          - segmentOrder.get(rightTurn.branch_epoch)
        || leftTurn.turn_index - rightTurn.turn_index
        || left.sequence_index - right.sequence_index
        || left.record_id.localeCompare(right.record_id)
      );
    });
  const state = new Map();
  for (const record of records) {
    const key = canonicalJson([
      record.entity_ref,
      record.state_domain,
      record.state_key,
    ]);
    if (record.state_operation === 'unset') {
      state.delete(key);
      continue;
    }
    const turn = turns.get(candidates.get(record.candidate_id).turn_id);
    state.set(key, {
      entity_ref: record.entity_ref,
      state_domain: record.state_domain,
      state_key: record.state_key,
      current_value: JSON.parse(record.state_value_json),
      source_refs: [record.source_ref],
      certainty: record.support_strength,
      valid_from_turn: turn.turn_index,
    });
  }
  const currentState = [...state.values()].sort((left, right) => (
    left.entity_ref.localeCompare(right.entity_ref)
    || left.state_domain.localeCompare(right.state_domain)
    || left.state_key.localeCompare(right.state_key)
  ));
  if (
    canonicalJson(currentState)
      !== canonicalJson(contract.final_state.current_state)
  ) {
    fail(
      'branch_history_governance_invalid',
      'Final governance does not reconstruct the sealed final state.',
    );
  }
}

function assertFinalGovernance(governance, contract) {
  if (
    !exactKeys(governance, GOVERNANCE_KEYS)
    || governance.schema !== 'mnemosyne.branch-history-governance.v1'
    || !Array.isArray(governance.branch_epochs)
    || !Array.isArray(governance.turns)
    || !Array.isArray(governance.turn_candidates)
    || !Array.isArray(governance.patches)
    || !Array.isArray(governance.turn_memory_records)
    || !exactKeys(governance.active_set, ACTIVE_SET_KEYS)
  ) {
    fail(
      'branch_history_governance_invalid',
      'The final governance snapshot has an invalid shape.',
    );
  }
  const collections = [
    [governance.branch_epochs, BRANCH_EPOCH_ROW_KEYS, 'branch_epoch'],
    [governance.turns, TURN_ROW_KEYS, 'turn_id'],
    [governance.turn_candidates, CANDIDATE_ROW_KEYS, 'candidate_id'],
    [governance.patches, PATCH_ROW_KEYS, 'patch_id'],
    [governance.turn_memory_records, RECORD_ROW_KEYS, 'record_id'],
  ];
  for (const [rows, keys, identityField] of collections) {
    const identities = new Set();
    for (const row of rows) {
      if (!exactKeys(row, keys) || identities.has(row[identityField])) {
        fail(
          'branch_history_governance_invalid',
          'Final governance contains malformed or duplicate rows.',
          { identity_field: identityField },
        );
      }
      identities.add(row[identityField]);
    }
  }
  if (
    governance.branch_epochs[0]?.branch_epoch
      !== contract.root_branch_epoch
    || governance.branch_epochs.at(-1)?.branch_epoch
      !== contract.target_branch_epoch
    || governance.branch_epochs.at(-1)?.status !== 'active'
    || governance.branch_epochs.at(-1)?.head_turn_index
      !== contract.through_turn_index
    || governance.branch_epochs.some(row => (
      row.chat_id !== contract.chat_id
      || row.branch_id !== contract.branch_id
    ))
    || governance.turns.some(row => (
      row.chat_id !== contract.chat_id
      || row.branch_id !== contract.branch_id
    ))
    || governance.patches.some(row => row.chat_id !== contract.chat_id)
  ) {
    fail(
      'branch_history_governance_invalid',
      'Final governance does not match the sealed branch coordinate.',
    );
  }
  const turnIds = new Set(governance.turns.map(row => row.turn_id));
  const candidateIds = new Set(
    governance.turn_candidates.map(row => row.candidate_id),
  );
  const patchIds = new Set(governance.patches.map(row => row.patch_id));
  if (
    governance.turn_candidates.some(row => (
      !turnIds.has(row.turn_id)
      || !patchIds.has(row.patch_id)
    ))
    || governance.patches.some(row => (
      !candidateIds.has(row.candidate_id)
    ))
    || governance.turn_memory_records.some(row => (
      !candidateIds.has(row.candidate_id)
      || !patchIds.has(row.patch_id)
    ))
  ) {
    fail(
      'branch_history_governance_invalid',
      'Final governance contains broken row relationships.',
    );
  }
  const derivedActiveSet = deriveActiveSet(governance, contract);
  if (
    canonicalJson(derivedActiveSet)
      !== canonicalJson(governance.active_set)
  ) {
    fail(
      'branch_history_governance_invalid',
      'The sealed active set does not follow from the governance rows.',
    );
  }
  reconstructGovernedState(governance, contract);
}

function evidenceHashes({
  rootRunContract,
  operations,
  finalState,
  finalProjection,
  finalGovernance,
  staticBaseline,
}) {
  return {
    root_run_contract_hash: sha256(canonicalJson(rootRunContract)),
    operations_hash: sha256(canonicalJson(operations)),
    final_state_hash: sha256(canonicalJson(finalState)),
    final_projection_hash: sha256(canonicalJson(finalProjection)),
    final_governance_hash: sha256(canonicalJson(finalGovernance)),
    static_baseline_hash: sha256(canonicalJson(staticBaseline)),
  };
}

function contractPayload(contract) {
  return {
    schema: CONTRACT_SCHEMA,
    chat_id: contract.chat_id,
    branch_id: contract.branch_id,
    root_branch_epoch: contract.root_branch_epoch,
    target_branch_epoch: contract.target_branch_epoch,
    through_turn_index: contract.through_turn_index,
    root_run_contract: contract.root_run_contract,
    operations: contract.operations,
    final_state: contract.final_state,
    final_projection: contract.final_projection,
    final_governance: contract.final_governance,
    evidence_hashes: contract.evidence_hashes,
  };
}

function rootBranchEvent(event) {
  return {
    event_id: event.event_id,
    command_id: event.command_id,
    event_type: event.event_type,
    branch_id: event.branch_id,
    branch_epoch: event.branch_epoch,
    payload: event.payload,
    result: event.result,
    created_at: event.created_at,
  };
}

function assertOperationSemantics(contract) {
  const turns = new Map();
  const coordinates = new Map();
  const candidates = new Map();
  const branches = new Map();
  const coordinateKey = (branchEpoch, turnIndex) => (
    `${branchEpoch}:${turnIndex}`
  );
  let activeEpoch = contract.root_branch_epoch;
  branches.set(activeEpoch, {
    chat_id: contract.chat_id,
    branch_id: contract.branch_id,
    branch_epoch: activeEpoch,
    parent_branch_epoch: null,
    parent_cutoff_turn_index_exclusive: null,
    status: 'active',
    head_turn_index: null,
    created_by_event_id: null,
    created_at: contract.operations[0].created_at,
  });

  for (const operation of contract.operations) {
    if (operation.event_type === 'commit_candidate') {
      const artifact = operation.artifact;
      const coordinate = coordinateKey(
        artifact.branch_epoch,
        artifact.turn_index,
      );
      let turn = turns.get(artifact.turn_id);
      if (!turn) {
        if (coordinates.has(coordinate)) {
          fail(
            'branch_history_operation_semantics_invalid',
            'Two turn identities share one branch coordinate.',
          );
        }
        turn = {
          turn_id: artifact.turn_id,
          branch_epoch: artifact.branch_epoch,
          turn_index: artifact.turn_index,
          candidates: [],
          row: {
            turn_id: artifact.turn_id,
            chat_id: artifact.chat_id,
            turn_index: artifact.turn_index,
            branch_id: artifact.branch_id,
            branch_epoch: artifact.branch_epoch,
            message_hash: sha256(canonicalJson(artifact.user_message)),
            status: 'committed',
            created_at: artifact.committed_at,
            run_id: artifact.run_id,
          },
        };
        turns.set(turn.turn_id, turn);
        coordinates.set(coordinate, turn);
      } else if (
        turn.branch_epoch !== artifact.branch_epoch
        || turn.turn_index !== artifact.turn_index
      ) {
        fail(
          'branch_history_operation_semantics_invalid',
          'A committed turn changes branch coordinate.',
        );
      }
      if (candidates.has(artifact.candidate_id)) {
        fail(
          'branch_history_operation_semantics_invalid',
          'A candidate is committed more than once.',
        );
      }
      const candidate = {
        candidate_id: artifact.candidate_id,
        turn,
        swipe_id: artifact.swipe_id,
        status: turn.candidates.length === 0 ? 'active' : 'inactive',
        patch_id: artifact.patch_id,
        patch_status: turn.candidates.length === 0
          ? 'applied'
          : 'prepared',
        record_status: 'active',
        row: {
          candidate_id: artifact.candidate_id,
          turn_id: artifact.turn_id,
          swipe_id: artifact.swipe_id,
          body_hash: artifact.body_hash,
          patch_id: artifact.patch_id,
          status: turn.candidates.length === 0
            ? 'active'
            : 'inactive',
          activated_at: artifact.committed_at,
          artifact_path: path.posix.join(
            'turn-artifacts',
            artifact.turn_id,
            `${artifact.candidate_id}.json`,
          ),
          delta_hash: artifact.delta_hash,
          prompt_spine_hash: artifact.prompt_spine_hash,
          artifact_hash: operation.result.artifact_hash,
          run_id: artifact.run_id,
        },
        patch: {
          patch_id: artifact.patch_id,
          chat_id: artifact.chat_id,
          candidate_id: artifact.candidate_id,
          reason_code: 'turn_commit',
          source_index_start: artifact.turn_index,
          source_index_end: artifact.turn_index,
          status: turn.candidates.length === 0
            ? 'applied'
            : 'prepared',
          prepared_at: artifact.committed_at,
          applied_at: turn.candidates.length === 0
            ? artifact.committed_at
            : null,
          rolled_back_at: null,
        },
        records: artifact.delta.records.map((record, sequenceIndex) => {
          const sourceRef = [
            `chat://${encodeURIComponent(artifact.chat_id)}`,
            `/turn/${encodeURIComponent(artifact.turn_id)}`,
            `/candidate/${encodeURIComponent(artifact.candidate_id)}`,
            `#chars=${record.source_span.start}-${record.source_span.end}`,
          ].join('');
          const normalizedRecord = {
            ...structuredClone(record),
            source_ref: sourceRef,
          };
          return {
            record_id: `record_${sha256(canonicalJson({
              patch_id: artifact.patch_id,
              sequence_index: sequenceIndex,
              record: normalizedRecord,
            })).slice(0, 24)}`,
            patch_id: artifact.patch_id,
            candidate_id: artifact.candidate_id,
            sequence_index: sequenceIndex,
            record_kind: record.kind,
            entity_ref: record.entity_ref,
            summary: record.summary,
            state_domain: record.state?.domain ?? null,
            state_key: record.state?.key ?? null,
            state_value_json: record.state?.value === undefined
              ? null
              : canonicalJson(record.state.value),
            state_operation: record.state?.operation ?? 'set',
            record_payload_json: record.event === undefined
              ? null
              : canonicalJson(record.event),
            source_ref: sourceRef,
            source_start: record.source_span.start,
            source_end: record.source_span.end,
            source_mode: record.source_span.source_mode ?? null,
            support_strength: record.source_span.support_strength,
            status: 'active',
          };
        }),
      };
      if (turn.candidates.some(existing => (
        existing.status !== 'deleted'
        && existing.swipe_id === candidate.swipe_id
      ))) {
        fail(
          'branch_history_operation_semantics_invalid',
          'Two live candidates share one swipe coordinate.',
        );
      }
      turn.candidates.push(candidate);
      candidates.set(candidate.candidate_id, candidate);
      const branch = branches.get(artifact.branch_epoch);
      if (!branch) {
        fail(
          'branch_history_operation_semantics_invalid',
          'A commit targets an epoch not created by the operation stream.',
        );
      }
      branch.head_turn_index = branch.head_turn_index === null
        ? artifact.turn_index
        : Math.max(branch.head_turn_index, artifact.turn_index);
      continue;
    }

    if (operation.event_type === 'activate_swipe') {
      const turn = coordinates.get(coordinateKey(
        operation.payload.branch_epoch,
        operation.payload.turn_index,
      ));
      const candidate = turn?.candidates.find(item => (
        item.status !== 'deleted'
        && item.swipe_id === operation.payload.swipe_id
      ));
      if (
        !candidate
        || operation.result.turn_id !== turn.turn_id
        || operation.result.candidate_id !== candidate.candidate_id
        || operation.result.swipe_id !== candidate.swipe_id
        || operation.result.status !== (
          candidate.status === 'active' ? 'existing' : 'activated'
        )
      ) {
        fail(
          'branch_history_operation_semantics_invalid',
          'A swipe activation result does not follow from prior commits.',
          { sequence: operation.sequence },
        );
      }
      if (candidate.status !== 'active') {
        for (const item of turn.candidates) {
          if (item.status === 'active') {
            item.status = 'inactive';
            item.patch_status = 'rolled_back';
            item.row.status = 'inactive';
            item.patch.status = 'rolled_back';
            item.patch.rolled_back_at = operation.created_at;
          }
        }
        candidate.status = 'active';
        candidate.patch_status = 'applied';
        candidate.row.status = 'active';
        candidate.row.activated_at = operation.created_at;
        candidate.patch.status = 'applied';
        candidate.patch.applied_at = operation.created_at;
        candidate.patch.rolled_back_at = null;
      }
      continue;
    }

    if (operation.event_type === 'delete_swipe') {
      const turn = coordinates.get(coordinateKey(
        operation.payload.branch_epoch,
        operation.payload.turn_index,
      ));
      const target = turn?.candidates.find(item => (
        item.status !== 'deleted'
        && item.swipe_id === operation.payload.deleted_swipe_id
      ));
      const oldFallbackSwipeId = (
        operation.payload.fallback_swipe_id === null
          ? null
          : operation.payload.fallback_swipe_id
            >= operation.payload.deleted_swipe_id
            ? operation.payload.fallback_swipe_id + 1
            : operation.payload.fallback_swipe_id
      );
      const fallback = oldFallbackSwipeId === null
        ? null
        : turn?.candidates.find(item => (
            item.status !== 'deleted'
            && item.swipe_id === oldFallbackSwipeId
          ));
      const shifted = (turn?.candidates ?? [])
        .filter(item => (
          item.status !== 'deleted'
          && item.swipe_id > operation.payload.deleted_swipe_id
        ))
        .sort((left, right) => (
          left.swipe_id - right.swipe_id
          || left.candidate_id.localeCompare(right.candidate_id)
        ))
        .map(item => ({
          candidate_id: item.candidate_id,
          old_swipe_id: item.swipe_id,
          new_swipe_id: item.swipe_id - 1,
        }));
      const currentActive = turn?.candidates.find(
        item => item.status === 'active',
      ) ?? null;
      const expectedActive = target?.status === 'active'
        ? fallback?.candidate_id ?? null
        : currentActive?.candidate_id ?? null;
      if (
        !target
        || (target.status === 'active' && !fallback)
        || (
          target.status !== 'active'
          && fallback
          && fallback.candidate_id !== currentActive?.candidate_id
        )
        || operation.result.turn_id !== turn.turn_id
        || operation.result.deleted_candidate_id !== target.candidate_id
        || operation.result.fallback_candidate_id
          !== (fallback?.candidate_id ?? null)
        || operation.result.fallback_swipe_id
          !== operation.payload.fallback_swipe_id
        || operation.result.active_candidate_id !== expectedActive
        || canonicalJson(operation.result.reindexed_candidates)
          !== canonicalJson(shifted)
      ) {
        fail(
          'branch_history_operation_semantics_invalid',
          'A swipe deletion result does not follow from prior operations.',
          { sequence: operation.sequence },
        );
      }
      target.status = 'deleted';
      target.swipe_id = null;
      target.patch_status = 'rolled_back';
      target.record_status = 'inactive';
      target.row.status = 'deleted';
      target.row.swipe_id = null;
      target.patch.status = 'rolled_back';
      target.patch.rolled_back_at = operation.created_at;
      for (const record of target.records) record.status = 'inactive';
      for (const shiftedCandidate of shifted) {
        const shiftedTarget = candidates.get(
          shiftedCandidate.candidate_id,
        );
        shiftedTarget.swipe_id = shiftedCandidate.new_swipe_id;
        shiftedTarget.row.swipe_id = shiftedCandidate.new_swipe_id;
      }
      if (fallback && expectedActive === fallback.candidate_id) {
        fallback.status = 'active';
        fallback.patch_status = 'applied';
        fallback.row.status = 'active';
        fallback.row.activated_at = operation.created_at;
        fallback.patch.status = 'applied';
        fallback.patch.applied_at = operation.created_at;
        fallback.patch.rolled_back_at = null;
      }
      continue;
    }

    if (operation.event_type === 'delete_candidate') {
      const turn = turns.get(operation.payload.turn_id);
      const target = candidates.get(operation.payload.candidate_id);
      const fallback = operation.payload.fallback_candidate_id === null
        ? null
        : candidates.get(operation.payload.fallback_candidate_id);
      const currentActive = turn?.candidates.find(
        item => item.status === 'active',
      ) ?? null;
      const expectedActive = target?.status === 'active'
        ? fallback?.candidate_id ?? null
        : currentActive?.candidate_id ?? null;
      if (
        !turn
        || !target
        || target.turn !== turn
        || target.status === 'deleted'
        || (
          fallback
          && (
            fallback.turn !== turn
            || fallback.status === 'deleted'
            || fallback === target
          )
        )
        || (target.status === 'active' && !fallback)
        || (
          target.status !== 'active'
          && fallback
          && fallback !== currentActive
        )
        || operation.result.active_candidate_id !== expectedActive
      ) {
        fail(
          'branch_history_operation_semantics_invalid',
          'A candidate deletion result does not follow from prior operations.',
          { sequence: operation.sequence },
        );
      }
      target.status = 'deleted';
      target.patch_status = 'rolled_back';
      target.record_status = 'inactive';
      target.row.status = 'deleted';
      target.patch.status = 'rolled_back';
      target.patch.rolled_back_at = operation.created_at;
      for (const record of target.records) record.status = 'inactive';
      if (fallback && expectedActive === fallback.candidate_id) {
        fallback.status = 'active';
        fallback.patch_status = 'applied';
        fallback.row.status = 'active';
        fallback.row.activated_at = operation.created_at;
        fallback.patch.status = 'applied';
        fallback.patch.applied_at = operation.created_at;
        fallback.patch.rolled_back_at = null;
      }
      continue;
    }

    const previousBranch = branches.get(activeEpoch);
    if (!previousBranch) {
      fail(
        'branch_history_operation_semantics_invalid',
        'A truncation has no active parent branch.',
      );
    }
    previousBranch.status = 'historical';
    activeEpoch = operation.result.new_branch_epoch;
    branches.set(activeEpoch, {
      chat_id: contract.chat_id,
      branch_id: contract.branch_id,
      branch_epoch: activeEpoch,
      parent_branch_epoch: operation.result.previous_branch_epoch,
      parent_cutoff_turn_index_exclusive:
        operation.payload.cutoff_turn_index,
      status: 'active',
      head_turn_index: operation.payload.cutoff_turn_index === 0
        ? null
        : operation.payload.cutoff_turn_index - 1,
      created_by_event_id: operation.event_id,
      created_at: operation.created_at,
    });
  }

  if (activeEpoch !== contract.target_branch_epoch) {
    fail(
      'branch_history_operation_semantics_invalid',
      'The simulated history does not reach the target epoch.',
    );
  }
  const turnRows = [...turns.values()]
    .map(turn => turn.row)
    .sort((left, right) => (
      left.branch_epoch - right.branch_epoch
      || left.turn_index - right.turn_index
      || left.turn_id.localeCompare(right.turn_id)
    ));
  const turnById = new Map(turnRows.map(turn => [turn.turn_id, turn]));
  const candidateRows = [...candidates.values()]
    .map(candidate => candidate.row)
    .sort((left, right) => {
      const leftTurn = turnById.get(left.turn_id);
      const rightTurn = turnById.get(right.turn_id);
      return (
        leftTurn.branch_epoch - rightTurn.branch_epoch
        || leftTurn.turn_index - rightTurn.turn_index
        || left.candidate_id.localeCompare(right.candidate_id)
      );
    });
  const patchRows = [...candidates.values()]
    .map(candidate => candidate.patch)
    .sort((left, right) => left.patch_id.localeCompare(right.patch_id));
  const recordRows = [...candidates.values()]
    .flatMap(candidate => candidate.records)
    .sort((left, right) => {
      const leftTurn = turnById.get(
        candidates.get(left.candidate_id).turn.turn_id,
      );
      const rightTurn = turnById.get(
        candidates.get(right.candidate_id).turn.turn_id,
      );
      return (
        leftTurn.branch_epoch - rightTurn.branch_epoch
        || leftTurn.turn_index - rightTurn.turn_index
        || left.sequence_index - right.sequence_index
        || left.record_id.localeCompare(right.record_id)
      );
    });
  const expectedGovernance = {
    schema: 'mnemosyne.branch-history-governance.v1',
    branch_epochs: [...branches.values()].sort((left, right) => (
      left.branch_epoch - right.branch_epoch
    )),
    turns: turnRows,
    turn_candidates: candidateRows,
    patches: patchRows,
    turn_memory_records: recordRows,
    active_set: null,
  };
  expectedGovernance.active_set = deriveActiveSet(
    expectedGovernance,
    contract,
  );
  if (
    canonicalJson(expectedGovernance)
      !== canonicalJson(contract.final_governance)
  ) {
    fail(
      'branch_history_operation_semantics_invalid',
      'Operations do not derive the complete final governance snapshot.',
    );
  }
}

function verifyContract(contract) {
  if (
    !exactKeys(contract, CONTRACT_KEYS)
    || contract.schema !== CONTRACT_SCHEMA
    || typeof contract.chat_id !== 'string'
    || !contract.chat_id
    || typeof contract.branch_id !== 'string'
    || !contract.branch_id
    || !Number.isInteger(contract.root_branch_epoch)
    || contract.root_branch_epoch < 0
    || !Number.isInteger(contract.target_branch_epoch)
    || contract.target_branch_epoch < contract.root_branch_epoch
    || !Number.isInteger(contract.through_turn_index)
    || contract.through_turn_index < 0
    || !Array.isArray(contract.operations)
    || contract.operations.length === 0
    || !exactKeys(contract.evidence_hashes, EVIDENCE_HASH_KEYS)
  ) {
    fail(
      'branch_history_contract_invalid',
      `Expected an exact ${CONTRACT_SCHEMA} contract.`,
    );
  }
  assertHash(contract.contract_hash, 'contract.contract_hash');
  const root = verifyRootRunReplayContract(contract.root_run_contract);
  const rootScope = root.journal.run_scope;
  if (
    rootScope.chat_id !== contract.chat_id
    || rootScope.branch_id !== contract.branch_id
    || root.rootBranchEpoch !== contract.root_branch_epoch
    || rootScope.branch_epoch > contract.target_branch_epoch
  ) {
    fail(
      'branch_history_root_run_mismatch',
      'The sealed root run is outside this branch history.',
    );
  }

  const commandIds = new Set();
  const eventIds = new Set();
  let activeEpoch = contract.root_branch_epoch;
  for (const [sequence, operation] of contract.operations.entries()) {
    assertOperation(operation, {
      chatId: contract.chat_id,
      branchId: contract.branch_id,
      sequence,
    });
    if (
      operation.branch_epoch !== activeEpoch
      || commandIds.has(operation.command_id)
      || eventIds.has(operation.event_id)
    ) {
      fail(
        'branch_history_operation_order_invalid',
        'History operations are duplicated or leave the active epoch.',
        { sequence, active_epoch: activeEpoch },
      );
    }
    commandIds.add(operation.command_id);
    eventIds.add(operation.event_id);
    if (operation.event_type === 'truncate_branch') {
      activeEpoch = operation.result.new_branch_epoch;
    }
  }
  if (activeEpoch !== contract.target_branch_epoch) {
    fail(
      'branch_history_operation_order_invalid',
      'The operation stream does not reach the target branch epoch.',
    );
  }

  const commitOperations = contract.operations.filter(
    operation => operation.event_type === 'commit_candidate',
  );
  for (const artifact of root.artifacts) {
    const operation = commitOperations.find(candidate => (
      candidate.artifact.turn_id === artifact.turn_id
      && candidate.artifact.candidate_id === artifact.candidate_id
    ));
    if (
      !operation
      || canonicalJson(operation.artifact) !== canonicalJson(artifact)
    ) {
      fail(
        'branch_history_root_run_mismatch',
        'The full history does not contain every sealed root-run artifact.',
      );
    }
  }
  const rootTruncations = contract.operations
    .filter(operation => (
      operation.event_type === 'truncate_branch'
      && operation.branch_epoch < rootScope.branch_epoch
    ))
    .map(rootBranchEvent);
  if (
    canonicalJson(rootTruncations)
      !== canonicalJson(root.branchEvents)
  ) {
    fail(
      'branch_history_root_run_mismatch',
      'The full history has a different ancestry before the root run.',
    );
  }

  assertFinalState(contract.final_state, contract);
  assertFinalProjection(contract.final_projection, contract);
  assertFinalGovernance(contract.final_governance, contract);
  if (
    contract.final_state.canonical_state_hash
      !== contract.final_projection.canonical_active_state_hash
  ) {
    fail(
      'branch_history_final_state_projection_mismatch',
      'Final State History and Dynamic World disagree on active state.',
    );
  }
  assertOperationSemantics(contract);
  const expectedEvidenceHashes = evidenceHashes({
    rootRunContract: contract.root_run_contract,
    operations: contract.operations,
    finalState: contract.final_state,
    finalProjection: contract.final_projection,
    finalGovernance: contract.final_governance,
    staticBaseline: root.staticBaseline,
  });
  if (
    canonicalJson(contract.evidence_hashes)
      !== canonicalJson(expectedEvidenceHashes)
  ) {
    fail(
      'branch_history_evidence_hash_mismatch',
      'The branch-history evidence hashes no longer match their contents.',
    );
  }
  if (
    contract.contract_hash
      !== sha256(canonicalJson(contractPayload(contract)))
  ) {
    fail(
      'branch_history_contract_hash_mismatch',
      'The branch-history contract no longer matches its canonical hash.',
    );
  }
  return {
    contract: structuredClone(contract),
    root,
  };
}

function dynamicPresence(database, chatId) {
  return {
    branch_epochs: Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM branch_epochs
      WHERE chat_id = ?
    `).get(chatId).count),
    turns: Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM turns
      WHERE chat_id = ?
    `).get(chatId).count),
    turn_candidates: Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM turn_candidates
      JOIN turns ON turns.turn_id = turn_candidates.turn_id
      WHERE turns.chat_id = ?
    `).get(chatId).count),
    patches: Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM patches
      WHERE chat_id = ? AND candidate_id IS NOT NULL
    `).get(chatId).count),
    turn_memory_records: Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM turn_memory_records
      JOIN turn_candidates
        ON turn_candidates.candidate_id =
          turn_memory_records.candidate_id
      JOIN turns ON turns.turn_id = turn_candidates.turn_id
      WHERE turns.chat_id = ?
    `).get(chatId).count),
    history_events: Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM history_events
      WHERE chat_id = ?
    `).get(chatId).count),
  };
}

async function inspectDynamicPresence({ store, chatId }) {
  const opened = await store.openChatForAdmin({ chatId });
  const database = new DatabaseSync(opened.ledger_path, { readOnly: true });
  try {
    return dynamicPresence(database, chatId);
  } finally {
    database.close();
  }
}

function presenceIsClean(presence) {
  return Object.values(presence).every(count => count === 0);
}

function presenceMatchesContract(presence, contract) {
  return (
    presence.branch_epochs === contract.final_governance.branch_epochs.length
    && presence.turns === contract.final_governance.turns.length
    && presence.turn_candidates
      === contract.final_governance.turn_candidates.length
    && presence.patches === contract.final_governance.patches.length
    && presence.turn_memory_records
      === contract.final_governance.turn_memory_records.length
    && presence.history_events === contract.operations.length
  );
}

async function inspectReplaySurface({
  store,
  chatId,
  branchId,
  targetBranchEpoch,
  throughTurnIndex,
}) {
  const opened = await store.openChatForAdmin({ chatId });
  const database = new DatabaseSync(opened.ledger_path, { readOnly: true });
  let rows;
  let rootBranchEpoch;
  let governance;
  let presence;
  try {
    database.exec('BEGIN');
    const ancestry = [];
    const visited = new Set();
    let epoch = targetBranchEpoch;
    while (epoch !== null) {
      if (visited.has(epoch)) {
        fail(
          'branch_history_ancestry_invalid',
          'The target branch ancestry contains a cycle.',
        );
      }
      visited.add(epoch);
      const row = database.prepare(`
        SELECT
          chat_id,
          branch_id,
          branch_epoch,
          parent_branch_epoch,
          parent_cutoff_turn_index_exclusive,
          status,
          head_turn_index,
          created_by_event_id,
          created_at
        FROM branch_epochs
        WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
      `).get(chatId, branchId, epoch);
      if (!row) {
        fail(
          'branch_history_ancestry_invalid',
          'The target branch epoch does not exist.',
          { branch_epoch: epoch },
        );
      }
      ancestry.push(row);
      epoch = row.parent_branch_epoch;
    }
    ancestry.reverse();
    rootBranchEpoch = ancestry[0].branch_epoch;
    const target = ancestry.at(-1);
    if (
      target.status !== 'active'
      || target.head_turn_index !== throughTurnIndex
    ) {
      fail(
        'branch_history_export_not_at_head',
        'Exact history export must target the active branch head.',
        {
          expected_head_turn_index: target.head_turn_index,
          requested_through_turn_index: throughTurnIndex,
        },
      );
    }
    const epochs = ancestry.map(row => row.branch_epoch);
    const placeholders = epochs.map(() => '?').join(', ');
    rows = database.prepare(`
      SELECT
        history_events.rowid AS source_sequence,
        history_events.event_id,
        history_events.command_id,
        history_events.chat_id,
        history_events.branch_id,
        history_events.branch_epoch,
        history_events.event_type,
        history_events.payload_json,
        history_events.result_json,
        history_events.created_at,
        turn_candidates.artifact_path
      FROM history_events
      LEFT JOIN turn_candidates
        ON turn_candidates.candidate_id = json_extract(
          history_events.payload_json,
          '$.candidate_id'
        )
      WHERE
        history_events.chat_id = ?
        AND history_events.branch_id = ?
        AND history_events.branch_epoch IN (${placeholders})
      ORDER BY history_events.rowid
    `).all(chatId, branchId, ...epochs);
    const turns = database.prepare(`
      SELECT
        turn_id,
        chat_id,
        turn_index,
        branch_id,
        branch_epoch,
        message_hash,
        status,
        created_at,
        run_id
      FROM turns
      WHERE
        chat_id = ?
        AND branch_id = ?
        AND branch_epoch IN (${placeholders})
      ORDER BY branch_epoch, turn_index, turn_id
    `).all(chatId, branchId, ...epochs);
    const turnCandidates = database.prepare(`
      SELECT
        turn_candidates.candidate_id,
        turn_candidates.turn_id,
        turn_candidates.swipe_id,
        turn_candidates.body_hash,
        turn_candidates.patch_id,
        turn_candidates.status,
        turn_candidates.activated_at,
        turn_candidates.artifact_path,
        turn_candidates.delta_hash,
        turn_candidates.prompt_spine_hash,
        turn_candidates.artifact_hash,
        turn_candidates.run_id
      FROM turn_candidates
      JOIN turns ON turns.turn_id = turn_candidates.turn_id
      WHERE
        turns.chat_id = ?
        AND turns.branch_id = ?
        AND turns.branch_epoch IN (${placeholders})
      ORDER BY
        turns.branch_epoch,
        turns.turn_index,
        turn_candidates.candidate_id
    `).all(chatId, branchId, ...epochs);
    const patches = database.prepare(`
      SELECT
        patches.patch_id,
        patches.chat_id,
        patches.candidate_id,
        patches.reason_code,
        patches.source_index_start,
        patches.source_index_end,
        patches.status,
        patches.prepared_at,
        patches.applied_at,
        patches.rolled_back_at
      FROM patches
      JOIN turn_candidates
        ON turn_candidates.candidate_id = patches.candidate_id
      JOIN turns ON turns.turn_id = turn_candidates.turn_id
      WHERE
        turns.chat_id = ?
        AND turns.branch_id = ?
        AND turns.branch_epoch IN (${placeholders})
      ORDER BY patches.patch_id
    `).all(chatId, branchId, ...epochs);
    const records = database.prepare(`
      SELECT
        turn_memory_records.record_id,
        turn_memory_records.patch_id,
        turn_memory_records.candidate_id,
        turn_memory_records.sequence_index,
        turn_memory_records.record_kind,
        turn_memory_records.entity_ref,
        turn_memory_records.summary,
        turn_memory_records.state_domain,
        turn_memory_records.state_key,
        turn_memory_records.state_value_json,
        turn_memory_records.state_operation,
        turn_memory_records.record_payload_json,
        turn_memory_records.source_ref,
        turn_memory_records.source_start,
        turn_memory_records.source_end,
        turn_memory_records.source_mode,
        turn_memory_records.support_strength,
        turn_memory_records.status
      FROM turn_memory_records
      JOIN turn_candidates
        ON turn_candidates.candidate_id =
          turn_memory_records.candidate_id
      JOIN turns ON turns.turn_id = turn_candidates.turn_id
      WHERE
        turns.chat_id = ?
        AND turns.branch_id = ?
        AND turns.branch_epoch IN (${placeholders})
      ORDER BY
        turns.branch_epoch,
        turns.turn_index,
        turn_memory_records.sequence_index,
        turn_memory_records.record_id
    `).all(chatId, branchId, ...epochs);
    governance = {
      schema: 'mnemosyne.branch-history-governance.v1',
      branch_epochs: ancestry,
      turns,
      turn_candidates: turnCandidates,
      patches,
      turn_memory_records: records,
      active_set: null,
    };
    presence = dynamicPresence(database, chatId);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The read transaction may already have closed.
    }
    throw error;
  } finally {
    database.close();
  }

  const operations = [];
  for (const [sequence, row] of rows.entries()) {
    if (!EVENT_TYPES.has(row.event_type)) {
      fail(
        'branch_history_event_unsupported',
        'The branch contains a history event with no mechanical replay rule.',
        {
          event_type: row.event_type,
          source_sequence: row.source_sequence,
        },
      );
    }
    const operation = {
      sequence,
      event_id: row.event_id,
      command_id: row.command_id,
      chat_id: row.chat_id,
      branch_id: row.branch_id,
      branch_epoch: row.branch_epoch,
      event_type: row.event_type,
      payload: JSON.parse(row.payload_json),
      result: JSON.parse(row.result_json),
      created_at: row.created_at,
    };
    if (row.event_type === 'commit_candidate') {
      if (typeof row.artifact_path !== 'string' || !row.artifact_path) {
        fail(
          'branch_history_artifact_unavailable',
          'A committed candidate has no replayable sealed artifact.',
          { sequence },
        );
      }
      operation.artifact = JSON.parse(await readFile(
        path.join(opened.chat_save_path, row.artifact_path),
        'utf8',
      ));
    }
    operations.push(operation);
  }
  governance.active_set = deriveActiveSet(governance, {
    target_branch_epoch: targetBranchEpoch,
    through_turn_index: throughTurnIndex,
  });
  return {
    rootBranchEpoch,
    operations,
    governance,
    presence,
  };
}

async function applyOperation({
  operation,
  targetChatId,
  targetStateHistory,
}) {
  if (operation.event_type === 'commit_candidate') {
    const artifact = operation.artifact;
    return targetStateHistory.commitTurn({
      chatId: targetChatId,
      runId: artifact.run_id,
      turnId: artifact.turn_id,
      candidateId: artifact.candidate_id,
      turnIndex: artifact.turn_index,
      branchId: artifact.branch_id,
      branchEpoch: artifact.branch_epoch,
      swipeId: artifact.swipe_id,
      userMessage: structuredClone(artifact.user_message),
      assistantMessage: structuredClone(artifact.assistant_message),
      promptSpineHash: artifact.prompt_spine_hash,
      delta: structuredClone(artifact.delta),
      committedAt: artifact.committed_at,
    });
  }
  if (operation.event_type === 'activate_swipe') {
    return targetStateHistory.activateCandidateByHostCoordinate({
      commandId: operation.command_id,
      chatId: targetChatId,
      branchId: operation.payload.branch_id,
      branchEpoch: operation.payload.branch_epoch,
      turnIndex: operation.payload.turn_index,
      swipeId: operation.payload.swipe_id,
      throughTurnIndex: operation.payload.through_turn_index,
      trustedReplayCreatedAt: operation.created_at,
    });
  }
  if (operation.event_type === 'delete_swipe') {
    return targetStateHistory.deleteCandidateByHostCoordinate({
      commandId: operation.command_id,
      chatId: targetChatId,
      branchId: operation.payload.branch_id,
      branchEpoch: operation.payload.branch_epoch,
      turnIndex: operation.payload.turn_index,
      deletedSwipeId: operation.payload.deleted_swipe_id,
      fallbackSwipeId: operation.payload.fallback_swipe_id,
      throughTurnIndex: operation.payload.through_turn_index,
      trustedReplayCreatedAt: operation.created_at,
    });
  }
  if (operation.event_type === 'delete_candidate') {
    return targetStateHistory.deleteCandidate({
      commandId: operation.command_id,
      chatId: targetChatId,
      turnId: operation.payload.turn_id,
      candidateId: operation.payload.candidate_id,
      fallbackCandidateId: operation.payload.fallback_candidate_id,
      trustedReplayCreatedAt: operation.created_at,
    });
  }
  return targetStateHistory.truncateBranch({
    commandId: operation.command_id,
    chatId: targetChatId,
    branchId: operation.branch_id,
    expectedBranchEpoch: operation.payload.expected_branch_epoch,
    cutoffTurnIndex: operation.payload.cutoff_turn_index,
    reasonCode: operation.payload.reason_code,
    createdAt: operation.created_at,
  });
}

export function createBranchHistoryReplay({
  sourceStateHistory,
  targetStateHistory,
  sourceStore,
  targetStore,
  sourceProjector,
  targetProjector,
  chatWriteCoordinator = null,
} = {}) {
  if (
    !sourceStateHistory?.stateAt
    || !targetStateHistory?.stateAt
    || !targetStateHistory?.commitTurn
    || !targetStateHistory?.activateCandidateByHostCoordinate
    || !targetStateHistory?.deleteCandidateByHostCoordinate
    || !targetStateHistory?.deleteCandidate
    || !targetStateHistory?.truncateBranch
    || !targetStateHistory?.ensureReplayRootBranch
  ) {
    throw new Error(
      'Branch History Replay requires source and target State History.',
    );
  }
  if (!sourceStore || !targetStore) {
    throw new Error(
      'Branch History Replay requires source and target chat-save stores.',
    );
  }
  if (!sourceProjector?.rebuild || !targetProjector?.rebuild) {
    throw new Error(
      'Branch History Replay requires source and target projectors.',
    );
  }
  if (
    chatWriteCoordinator !== null
    && !chatWriteCoordinator?.run
  ) {
    throw new Error(
      'Branch History Replay coordinator must expose run.',
    );
  }
  const runCoordinated = (chatId, operation) => (
    chatWriteCoordinator
      ? chatWriteCoordinator.run(chatId, operation)
      : operation()
  );

  return Object.freeze({
    async exportHistory({
      rootRunContract,
      chatId,
      branchId = 'main',
      targetBranchEpoch,
      throughTurnIndex,
    } = {}) {
      return runCoordinated(chatId, async () => {
      const root = verifyRootRunReplayContract(rootRunContract);
      const before = await inspectReplaySurface({
        store: sourceStore,
        chatId,
        branchId,
        targetBranchEpoch,
        throughTurnIndex,
      });
      const finalState = await sourceStateHistory.stateAt({
        chatId,
        branchId,
        branchEpoch: targetBranchEpoch,
        turnIndex: throughTurnIndex,
      });
      const finalProjection = await sourceProjector.rebuild({
        chatId,
        branchId,
        branchEpoch: targetBranchEpoch,
        turnIndex: throughTurnIndex,
      });
      const after = await inspectReplaySurface({
        store: sourceStore,
        chatId,
        branchId,
        targetBranchEpoch,
        throughTurnIndex,
      });
      if (
        canonicalJson({
          root_branch_epoch: before.rootBranchEpoch,
          operations: before.operations,
          governance: before.governance,
          presence: before.presence,
        }) !== canonicalJson({
          root_branch_epoch: after.rootBranchEpoch,
          operations: after.operations,
          governance: after.governance,
          presence: after.presence,
        })
      ) {
        fail(
          'branch_history_export_raced',
          'History changed while the replay contract was being exported.',
        );
      }
      if (
        !presenceMatchesContract(after.presence, {
          operations: after.operations,
          final_governance: after.governance,
        })
      ) {
        fail(
          'branch_history_export_scope_dirty',
          'The chat contains dynamic governance outside this replay lineage.',
        );
      }
      if (
        finalState.canonical_state_hash
          !== finalProjection.canonical_active_state_hash
      ) {
        fail(
          'branch_history_final_state_projection_mismatch',
          'Final State History and Dynamic World disagree on active state.',
        );
      }
      const sourceBaseline = await inspectStaticBaseline({
        store: sourceStore,
        chatId,
      });
      if (canonicalJson(sourceBaseline) !== canonicalJson(root.staticBaseline)) {
        fail(
          'branch_history_static_baseline_changed',
          'Static Lore changed after the sealed root run.',
        );
      }
      const draft = {
        schema: CONTRACT_SCHEMA,
        chat_id: chatId,
        branch_id: branchId,
        root_branch_epoch: after.rootBranchEpoch,
        target_branch_epoch: targetBranchEpoch,
        through_turn_index: throughTurnIndex,
        root_run_contract: structuredClone(rootRunContract),
        operations: structuredClone(after.operations),
        final_state: structuredClone(finalState),
        final_projection: structuredClone(finalProjection),
        final_governance: structuredClone(after.governance),
      };
      draft.evidence_hashes = evidenceHashes({
        rootRunContract: draft.root_run_contract,
        operations: draft.operations,
        finalState: draft.final_state,
        finalProjection: draft.final_projection,
        finalGovernance: draft.final_governance,
        staticBaseline: root.staticBaseline,
      });
      const contract = {
        ...draft,
        contract_hash: sha256(canonicalJson({
          ...draft,
          evidence_hashes: draft.evidence_hashes,
        })),
      };
      verifyContract(contract);
      return contract;
      });
    },

    async applyHistory({ contract, targetChatId } = {}) {
      return runCoordinated(targetChatId, async () => {
      const verified = verifyContract(contract);
      if (
        typeof targetChatId !== 'string'
        || !targetChatId
        || targetChatId !== contract.chat_id
      ) {
        fail(
          'branch_history_target_invalid',
          'Exact history replay requires the same logical chat id.',
        );
      }
      const targetBaseline = await inspectStaticBaseline({
        store: targetStore,
        chatId: targetChatId,
      });
      if (
        canonicalJson(targetBaseline)
          !== canonicalJson(verified.root.staticBaseline)
      ) {
        fail(
          'branch_history_static_baseline_mismatch',
          'Exact replay requires the same sealed Static Lore baseline.',
        );
      }

      const initialPresence = await inspectDynamicPresence({
        store: targetStore,
        chatId: targetChatId,
      });
      let targetTimeline = null;
      let alreadyExact = false;
      if (!presenceIsClean(initialPresence)) {
        if (!presenceMatchesContract(initialPresence, contract)) {
          fail(
            'branch_history_target_dirty',
            'Replay requires a clean target or the exact final governance.',
          );
        }
        try {
          targetTimeline = await inspectReplaySurface({
            store: targetStore,
            chatId: targetChatId,
            branchId: contract.branch_id,
            targetBranchEpoch: contract.target_branch_epoch,
            throughTurnIndex: contract.through_turn_index,
          });
        } catch (error) {
          fail(
            'branch_history_target_dirty',
            'Replay target governance is only partially populated.',
            { cause: error.reasonCode ?? error.name },
          );
        }
        if (
          targetTimeline.rootBranchEpoch !== contract.root_branch_epoch
          || canonicalJson(targetTimeline.operations)
            !== canonicalJson(contract.operations)
          || canonicalJson(targetTimeline.governance)
            !== canonicalJson(contract.final_governance)
        ) {
          fail(
            'branch_history_target_dirty',
            'Replay target governance differs from the sealed final state.',
          );
        }
        alreadyExact = true;
      }

      if (!alreadyExact) {
        const rootBranch = await targetStateHistory.ensureReplayRootBranch({
          chatId: targetChatId,
          branchId: contract.branch_id,
          branchEpoch: contract.root_branch_epoch,
          createdAt: contract.operations[0].created_at,
        });
        if (!['created', 'existing'].includes(rootBranch?.status)) {
          fail(
            'branch_history_apply_invalid',
            'The replay root branch could not be created.',
          );
        }
        for (const operation of contract.operations) {
          const result = await applyOperation({
            operation,
            targetChatId,
            targetStateHistory,
          });
          if (
            ![
              'committed',
              'activated',
              'deleted',
              'truncated',
              'existing',
            ].includes(result?.status)
          ) {
            fail(
              'branch_history_apply_invalid',
              'A target history operation returned an invalid status.',
              { sequence: operation.sequence },
            );
          }
        }
        targetTimeline = await inspectReplaySurface({
          store: targetStore,
          chatId: targetChatId,
          branchId: contract.branch_id,
          targetBranchEpoch: contract.target_branch_epoch,
          throughTurnIndex: contract.through_turn_index,
        });
      }
      if (
        targetTimeline.rootBranchEpoch !== contract.root_branch_epoch
        || canonicalJson(targetTimeline.operations)
          !== canonicalJson(contract.operations)
        || canonicalJson(targetTimeline.governance)
          !== canonicalJson(contract.final_governance)
        || !presenceMatchesContract(targetTimeline.presence, contract)
      ) {
        fail(
          'branch_history_apply_governance_mismatch',
          'The target event stream or governance does not match the source.',
        );
      }

      const targetState = await targetStateHistory.stateAt({
        chatId: targetChatId,
        branchId: contract.branch_id,
        branchEpoch: contract.target_branch_epoch,
        turnIndex: contract.through_turn_index,
      });
      if (
        canonicalJson(targetState) !== canonicalJson(contract.final_state)
      ) {
        fail(
          'branch_history_apply_state_mismatch',
          'The mechanically replayed final state does not match the source.',
        );
      }
      const targetProjection = await targetProjector.rebuild({
        chatId: targetChatId,
        branchId: contract.branch_id,
        branchEpoch: contract.target_branch_epoch,
        turnIndex: contract.through_turn_index,
      });
      if (
        canonicalJson(targetProjection)
          !== canonicalJson(contract.final_projection)
      ) {
        fail(
          'branch_history_apply_projection_mismatch',
          'The mechanically rebuilt projection does not match the source.',
        );
      }

      return {
        schema: APPLY_RESULT_SCHEMA,
        status: alreadyExact ? 'existing' : 'applied',
        contract_hash: contract.contract_hash,
        target_chat_id: targetChatId,
        operation_count: contract.operations.length,
        canonical_state_hash: targetState.canonical_state_hash,
        projection: structuredClone(targetProjection),
      };
      });
    },
  });
}
