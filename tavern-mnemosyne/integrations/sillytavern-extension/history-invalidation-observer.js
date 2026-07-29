import {
  classifyGovernedHistorySuffix,
  findGovernedHistoryInvalidationCutoff,
  findHostHistoryInvalidationCutoff,
  inspectCurrentCardGreeting,
  snapshotHostHistory,
} from './runtime.js';
import {
  repairPathologicalHistoryInvalidationGuard,
  requiresFreshChatForUncheckpointedHistory,
} from './history-invalidation-guard.js';

class HistoryInvalidationObservationError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'HistoryInvalidationObservationError';
    this.reasonCode = reasonCode;
  }
}

function hostReleaseLengthForInvalidation(
  cutoffTurnIndex,
  currentChat,
  currentSnapshot,
) {
  if (cutoffTurnIndex >= currentSnapshot.length) {
    return cutoffTurnIndex;
  }
  const message = currentChat[cutoffTurnIndex];
  return message?.is_user || message?.is_system
    ? cutoffTurnIndex + 1
    : cutoffTurnIndex;
}

function assertDependencies({
  readCheckpoint,
  inspectServerHistory,
  recoverCheckpoint,
  ensurePendingInvalidation,
}) {
  if (
    typeof readCheckpoint !== 'function'
    || typeof inspectServerHistory !== 'function'
    || typeof recoverCheckpoint !== 'function'
    || typeof ensurePendingInvalidation !== 'function'
  ) {
    throw new TypeError(
      'History invalidation observation dependencies are invalid.',
    );
  }
}

export async function detectUnobservedHistoryInvalidation(
  {
    chatId,
    currentChat,
    baselineChatId = null,
    baselineSnapshot = [],
    hasBranchEpochMarker = false,
    currentCard = null,
  } = {},
  dependencies = {},
) {
  assertDependencies(dependencies);
  if (
    typeof chatId !== 'string'
    || !chatId
    || !Array.isArray(currentChat)
    || !Array.isArray(baselineSnapshot)
    || typeof hasBranchEpochMarker !== 'boolean'
  ) {
    throw new TypeError(
      'History invalidation observation coordinates are invalid.',
    );
  }

  const {
    readCheckpoint,
    inspectServerHistory,
    recoverCheckpoint,
    ensurePendingInvalidation,
  } = dependencies;
  const currentSnapshot = snapshotHostHistory(
    currentChat,
    { currentCard },
  );
  const cutoffs = [];
  let referenceHistoryLength = currentSnapshot.length;
  let structuralDeletion = false;
  let checkpoint = await readCheckpoint(chatId);
  let serverHistory = checkpoint === null
    ? await inspectServerHistory(chatId)
    : null;

  if (
    checkpoint === null
    && serverHistory.recovery_anchor
  ) {
    checkpoint = await recoverCheckpoint(serverHistory);
  }
  if (
    checkpoint === null
    && serverHistory.has_governed_history === false
  ) {
    return Object.freeze({
      guard: null,
      currentSnapshot,
      checkpointBranchEpoch: null,
      refreshBaseline: true,
    });
  }
  if (checkpoint) {
    let checkpointCutoff =
      await findGovernedHistoryInvalidationCutoff({
        checkpoint,
        chatId,
        currentHostHistorySnapshot: currentSnapshot,
        currentCard,
      });
    if (checkpointCutoff !== null) {
      serverHistory ??= await inspectServerHistory(chatId);
      if (serverHistory.recovery_anchor) {
        try {
          checkpoint =
            await recoverCheckpoint(serverHistory);
          checkpointCutoff =
            await findGovernedHistoryInvalidationCutoff({
              checkpoint,
              chatId,
              currentHostHistorySnapshot:
                currentSnapshot,
              currentCard,
            });
        } catch (error) {
          const reasonCode = String(
            error?.reasonCode ?? '',
          );
          if (
            reasonCode !== 'history_checkpoint_invalid'
            && !reasonCode.startsWith(
              'history_recovery_',
            )
          ) {
            throw error;
          }
        }
      }
    }
    if (checkpointCutoff !== null) {
      cutoffs.push(checkpointCutoff);
    }
    const suffix = classifyGovernedHistorySuffix({
      governedMessageCount: checkpoint.message_count,
      currentChat,
    });
    if (suffix.status === 'structural_deletion') {
      structuralDeletion = true;
    }
    if (
      suffix.status
      === 'ungoverned_assistant_append'
    ) {
      cutoffs.push(suffix.cutoff_turn_index);
      structuralDeletion = true;
    }
    referenceHistoryLength = Math.max(
      referenceHistoryLength,
      checkpoint.message_count,
    );
  } else if (requiresFreshChatForUncheckpointedHistory({
    currentMessageCount: currentSnapshot.length,
    hasCheckpoint: false,
    hasBranchEpochMarker,
    serverHasGovernedHistory:
      serverHistory.has_governed_history,
  })) {
    throw new HistoryInvalidationObservationError(
      'legacy_governed_chat_requires_new_chat',
      'This chat contains governed history but has no durable history checkpoint, so it cannot be resumed safely. Start a fresh chat with the same character card; automatic legacy migration is not available yet.',
    );
  }

  if (
    baselineChatId === chatId
    && Array.isArray(baselineSnapshot)
  ) {
    const memoryCutoff =
      findHostHistoryInvalidationCutoff(
        baselineSnapshot,
        currentSnapshot,
        { currentCard },
      );
    if (memoryCutoff !== null) {
      cutoffs.push(memoryCutoff);
    }
    if (
      currentSnapshot.length
      < baselineSnapshot.length
    ) {
      structuralDeletion = true;
    }
    referenceHistoryLength = Math.max(
      referenceHistoryLength,
      baselineSnapshot.length,
    );
  }
  if (cutoffs.length === 0) {
    return Object.freeze({
      guard: null,
      currentSnapshot,
      checkpointBranchEpoch:
        checkpoint?.branch_epoch ?? null,
      refreshBaseline: false,
    });
  }

  const cutoffTurnIndex = Math.min(...cutoffs);
  const guard = await ensurePendingInvalidation({
    cutoffTurnIndex,
    hostReleaseLength:
      structuralDeletion
        ? cutoffTurnIndex
        : hostReleaseLengthForInvalidation(
          cutoffTurnIndex,
          currentChat,
          currentSnapshot,
        ),
    hostHistoryLength: Math.max(
      referenceHistoryLength,
      cutoffTurnIndex + 1,
    ),
    reasonCode: structuralDeletion
      || cutoffTurnIndex >= currentSnapshot.length
      ? 'host_message_deleted'
      : 'host_message_edited',
    expectedChatId: chatId,
  });
  return Object.freeze({
    guard,
    currentSnapshot,
    checkpointBranchEpoch:
      checkpoint?.branch_epoch ?? null,
    refreshBaseline: true,
  });
}

export async function repairPathologicalGreetingInvalidation(
  {
    chatId,
    currentChat,
    currentCard,
    pendingGuard,
  } = {},
  {
    inspectServerHistory,
    settleInvalidation,
  } = {},
) {
  if (
    typeof inspectServerHistory !== 'function'
    || typeof settleInvalidation !== 'function'
  ) {
    throw new TypeError(
      'Pathological history invalidation repair dependencies are invalid.',
    );
  }
  if (
    typeof chatId !== 'string'
    || !chatId
    || !Array.isArray(currentChat)
  ) {
    return false;
  }
  const greeting = inspectCurrentCardGreeting(
    currentChat[0],
    currentCard,
  );
  const inspection =
    greeting?.is_macro_expansion
      ? await inspectServerHistory(chatId)
      : null;
  if (
    inspection !== null
    && inspection.chat_id !== chatId
  ) {
    return false;
  }
  return repairPathologicalHistoryInvalidationGuard(
    pendingGuard,
    {
      inspection,
      greetingMacroEquivalent:
        greeting?.is_macro_expansion === true,
      settle: (governedPrefix, branchEpoch) =>
        settleInvalidation(
          governedPrefix,
          branchEpoch,
          chatId,
        ),
    },
  );
}
