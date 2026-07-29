export const HISTORY_INVALIDATION_GUARD_SCHEMA =
  'mnemosyne.history-invalidation-guard.v2';

const GUARD_STATUS = new Set([
  'truncation_pending',
  'tail_regeneration_required',
]);
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function invalidGuard(message) {
  const error = new Error(message);
  error.reasonCode = 'history_edit_guard_invalid';
  return error;
}

function validNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validReasonCode(value) {
  return (
    typeof value === 'string'
    && REASON_CODE_PATTERN.test(value)
  );
}

function validCommand(command) {
  return (
    command
    && typeof command === 'object'
    && !Array.isArray(command)
    && typeof command.command_id === 'string'
    && COMMAND_ID_PATTERN.test(command.command_id)
    && validNonNegativeInteger(command.cutoff_turn_index)
    && validNonNegativeInteger(command.expected_branch_epoch)
    && validReasonCode(command.reason_code)
  );
}

export function assertHistoryInvalidationGuard(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schema !== HISTORY_INVALIDATION_GUARD_SCHEMA
    || !HASH_PATTERN.test(value.chat_id_hash ?? '')
    || !GUARD_STATUS.has(value.status)
    || !validNonNegativeInteger(
      value.desired_cutoff_turn_index,
    )
    || !validReasonCode(value.desired_reason_code)
    || !validNonNegativeInteger(
      value.desired_host_release_length,
    )
    || value.desired_host_release_length
      < value.desired_cutoff_turn_index
    || value.desired_host_release_length
      > value.desired_cutoff_turn_index + 1
    || !validNonNegativeInteger(value.host_history_length)
    || value.host_history_length
      <= value.desired_cutoff_turn_index
    || value.desired_host_release_length
      > value.host_history_length
    || !(
      value.applied_cutoff_turn_index === null
      || (
        validNonNegativeInteger(
          value.applied_cutoff_turn_index,
        )
        && value.applied_cutoff_turn_index
          >= value.desired_cutoff_turn_index
        && value.applied_cutoff_turn_index
          < value.host_history_length
      )
    )
    || !(
      value.branch_epoch === null
      || validNonNegativeInteger(value.branch_epoch)
    )
    || !(
      value.active_command === null
      || validCommand(value.active_command)
    )
  ) {
    throw invalidGuard(
      'The persisted history invalidation guard is invalid.',
    );
  }

  const hasAppliedCutoff =
    value.applied_cutoff_turn_index !== null;
  const hasBranchEpoch = value.branch_epoch !== null;
  const hasActiveCommand = value.active_command !== null;
  if (
    hasAppliedCutoff !== hasBranchEpoch
    || (
      hasActiveCommand
      && (
        value.status !== 'truncation_pending'
        || value.active_command.cutoff_turn_index
          < value.desired_cutoff_turn_index
        || value.active_command.cutoff_turn_index
          >= value.host_history_length
        || (
          hasBranchEpoch
          && value.active_command.expected_branch_epoch
            !== value.branch_epoch
        )
      )
    )
    || (
      !hasActiveCommand
      && (
        value.status !== 'tail_regeneration_required'
        || value.applied_cutoff_turn_index
          !== value.desired_cutoff_turn_index
      )
    )
  ) {
    throw invalidGuard(
      'The persisted history invalidation guard state is inconsistent.',
    );
  }
  return structuredClone(value);
}

function command({
  commandId,
  cutoffTurnIndex,
  expectedBranchEpoch,
  reasonCode,
}) {
  const value = {
    command_id: commandId,
    cutoff_turn_index: cutoffTurnIndex,
    expected_branch_epoch: expectedBranchEpoch,
    reason_code: reasonCode,
  };
  if (!validCommand(value)) {
    throw invalidGuard(
      'History invalidation requires one valid truncation command.',
    );
  }
  return value;
}

export function createHistoryInvalidationGuard({
  cutoffTurnIndex,
  hostReleaseLength,
  hostHistoryLength,
  chatIdHash,
  branchEpoch,
  reasonCode,
  commandId,
} = {}) {
  const guard = {
    schema: HISTORY_INVALIDATION_GUARD_SCHEMA,
    chat_id_hash: chatIdHash,
    status: 'truncation_pending',
    desired_cutoff_turn_index: cutoffTurnIndex,
    desired_reason_code: reasonCode,
    desired_host_release_length: hostReleaseLength,
    host_history_length: hostHistoryLength,
    applied_cutoff_turn_index: null,
    branch_epoch: null,
    active_command: command({
      commandId,
      cutoffTurnIndex,
      expectedBranchEpoch: branchEpoch,
      reasonCode,
    }),
  };
  return assertHistoryInvalidationGuard(guard);
}

export function mergeHistoryInvalidationGuard(
  currentGuard,
  {
    cutoffTurnIndex,
    hostReleaseLength,
    hostHistoryLength,
    reasonCode,
    commandId,
  } = {},
) {
  const current = assertHistoryInvalidationGuard(currentGuard);
  if (
    !validNonNegativeInteger(cutoffTurnIndex)
    || cutoffTurnIndex >= current.host_history_length
    || !validNonNegativeInteger(hostReleaseLength)
    || hostReleaseLength < cutoffTurnIndex
    || hostReleaseLength > cutoffTurnIndex + 1
    || !validNonNegativeInteger(hostHistoryLength)
    || hostHistoryLength <= cutoffTurnIndex
    || !validReasonCode(reasonCode)
  ) {
    throw invalidGuard(
      'The new history invalidation coordinate is invalid.',
    );
  }
  if (
    cutoffTurnIndex > current.desired_cutoff_turn_index
    || (
      cutoffTurnIndex === current.desired_cutoff_turn_index
      && hostReleaseLength
        >= current.desired_host_release_length
    )
  ) {
    return {
      changed: false,
      guard: current,
    };
  }

  const cutoffLowered =
    cutoffTurnIndex < current.desired_cutoff_turn_index;
  const merged = {
    ...current,
    desired_cutoff_turn_index: cutoffTurnIndex,
    desired_reason_code: reasonCode,
    desired_host_release_length: hostReleaseLength,
    host_history_length: Math.max(
      current.host_history_length,
      hostHistoryLength,
    ),
  };
  if (cutoffLowered && merged.active_command === null) {
    merged.status = 'truncation_pending';
    merged.active_command = command({
      commandId,
      cutoffTurnIndex,
      expectedBranchEpoch: merged.branch_epoch,
      reasonCode,
    });
  }
  return {
    changed: true,
    guard: assertHistoryInvalidationGuard(merged),
  };
}

export async function reconcileHistoryInvalidationGuard(
  currentGuard,
  {
    truncate,
    persist,
    createCommandId,
  } = {},
) {
  if (
    typeof truncate !== 'function'
    || typeof persist !== 'function'
    || typeof createCommandId !== 'function'
  ) {
    throw new TypeError(
      'History invalidation reconciliation requires truncate, persist, and command-id services.',
    );
  }
  let guard = assertHistoryInvalidationGuard(currentGuard);
  for (let attempt = 0; attempt < 128; attempt += 1) {
    if (guard.active_command === null) return guard;
    const activeCommand = structuredClone(guard.active_command);
    const result = await truncate(activeCommand);
    if (!validNonNegativeInteger(result?.new_branch_epoch)) {
      throw invalidGuard(
        'History invalidation reconciliation returned no branch epoch.',
      );
    }

    const hasEarlierDesiredCutoff =
      guard.desired_cutoff_turn_index
        < activeCommand.cutoff_turn_index;
    const next = {
      ...guard,
      status: hasEarlierDesiredCutoff
        ? 'truncation_pending'
        : 'tail_regeneration_required',
      applied_cutoff_turn_index:
        activeCommand.cutoff_turn_index,
      branch_epoch: result.new_branch_epoch,
      active_command: hasEarlierDesiredCutoff
        ? command({
          commandId: createCommandId(
            guard.desired_cutoff_turn_index,
          ),
          cutoffTurnIndex:
            guard.desired_cutoff_turn_index,
          expectedBranchEpoch:
            result.new_branch_epoch,
          reasonCode: guard.desired_reason_code,
        })
        : null,
    };
    guard = assertHistoryInvalidationGuard(next);
    await persist(structuredClone(guard));
  }
  throw invalidGuard(
    'History invalidation reconciliation exceeded its command limit.',
  );
}

export function planHistoryInvalidationResolution(
  currentGuard,
  {
    chatLength,
  } = {},
) {
  const guard = assertHistoryInvalidationGuard(currentGuard);
  if (!validNonNegativeInteger(chatLength)) {
    throw invalidGuard(
      'History invalidation resolution requires a host history length.',
    );
  }
  if (chatLength < guard.desired_host_release_length) {
    return {
      action: 'lower_then_reconcile',
      cutoff_turn_index: chatLength,
      host_release_length: chatLength,
      reason_code: 'host_message_deleted',
    };
  }
  if (guard.active_command !== null) {
    return { action: 'reconcile_then_recheck' };
  }
  if (chatLength === guard.desired_host_release_length) {
    return { action: 'clear' };
  }
  return {
    action: 'block',
    reason_code: 'history_edit_requires_tail_regeneration',
  };
}

export async function repairPathologicalHistoryInvalidationGuard(
  currentGuard,
  {
    inspection,
    greetingMacroEquivalent,
    settle,
  } = {},
) {
  if (
    typeof greetingMacroEquivalent !== 'boolean'
    || typeof settle !== 'function'
  ) {
    throw new TypeError(
      'Pathological history invalidation repair inputs are invalid.',
    );
  }
  const guard =
    assertHistoryInvalidationGuard(
      currentGuard,
    );
  if (
    guard.status
      !== 'tail_regeneration_required'
    || guard.desired_cutoff_turn_index !== 0
    || guard.desired_host_release_length !== 0
    || guard.applied_cutoff_turn_index !== 0
    || guard.active_command !== null
    || !Number.isInteger(guard.branch_epoch)
    || greetingMacroEquivalent !== true
    || inspection?.schema
      !== 'mnemosyne.governed-history-inspection.v1'
    || inspection.status !== 'ready'
    || inspection.chat_id === ''
    || typeof inspection.chat_id !== 'string'
    || inspection.branch_id !== 'main'
    || inspection.has_governed_history !== true
    || inspection.committed_turn_count !== 0
    || inspection.active_branch_epoch
      !== guard.branch_epoch
    || inspection.latest_turn_index !== null
    || inspection.recovery_anchor != null
  ) {
    return false;
  }
  await settle([], guard.branch_epoch);
  return true;
}

export function consumeGenerationAbortReason(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('Generation state must be an object.');
  }
  const reasonCode =
    typeof state.generationAbortReason === 'string'
    && state.generationAbortReason
      ? state.generationAbortReason
      : null;
  state.generationAbortReason = null;
  return reasonCode;
}

export function requiresFreshChatForUncheckpointedHistory({
  currentMessageCount,
  hasCheckpoint,
  hasBranchEpochMarker,
  serverHasGovernedHistory,
} = {}) {
  if (
    !Number.isInteger(currentMessageCount)
    || currentMessageCount < 0
    || typeof hasCheckpoint !== 'boolean'
    || typeof hasBranchEpochMarker !== 'boolean'
    || typeof serverHasGovernedHistory !== 'boolean'
  ) {
    throw new TypeError(
      'Legacy governed-history classification requires explicit inputs.',
    );
  }
  return (
    !hasCheckpoint
    && (
      serverHasGovernedHistory
      || (
        currentMessageCount > 0
        && hasBranchEpochMarker
      )
    )
  );
}

export function createHistoryInvalidationCoordinator({
  lockManager = null,
} = {}) {
  if (
    lockManager !== null
    && typeof lockManager?.request !== 'function'
  ) {
    throw new TypeError(
      'History invalidation lock manager must implement request().',
    );
  }
  let tail = Promise.resolve();
  return Object.freeze({
    run(operation, {
      chatId = null,
    } = {}) {
      if (typeof operation !== 'function') {
        throw new TypeError(
          'History invalidation coordination requires an operation.',
        );
      }
      if (
        chatId !== null
        && (typeof chatId !== 'string' || !chatId)
      ) {
        throw new TypeError(
          'History invalidation coordination requires a valid chat identity.',
        );
      }
      const coordinatedOperation = (
        lockManager === null
        || chatId === null
      )
        ? operation
        : () => lockManager.request(
          `tavern-mnemosyne:history:${encodeURIComponent(chatId)}`,
          { mode: 'exclusive' },
          operation,
        );
      const result = tail.then(
        coordinatedOperation,
        coordinatedOperation,
      );
      tail = result.catch(() => undefined);
      return result;
    },
  });
}

export function createHistoryLifecycleLease(chatId) {
  if (typeof chatId !== 'string' || !chatId) {
    throw invalidGuard(
      'History lifecycle coordination requires a chat identity.',
    );
  }
  return Object.freeze({
    schema: 'mnemosyne.history-lifecycle-lease.v1',
    chat_id: chatId,
  });
}

export function assertHistoryLifecycleLease(
  lease,
  currentChatId,
) {
  if (
    lease?.schema
      !== 'mnemosyne.history-lifecycle-lease.v1'
    || typeof lease.chat_id !== 'string'
    || !lease.chat_id
    || currentChatId !== lease.chat_id
  ) {
    const error = new Error(
      'The active chat changed during history reconciliation.',
    );
    error.reasonCode = 'history_lifecycle_chat_changed';
    throw error;
  }
  return true;
}
