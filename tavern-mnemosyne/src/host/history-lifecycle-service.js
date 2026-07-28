import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';
import {
  createChatWriteCoordinator,
} from '../runtime/chat-write-coordinator.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const HOST_HISTORY_BINDING_KEYS = new Set([
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

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function assertProjectionReady(projection) {
  if (
    projection?.schema
      !== 'mnemosyne.dynamic-story-projection-result.v1'
    || projection.status !== 'ready'
  ) {
    fail(
      'history_lifecycle_projection_not_ready',
      'The active story projection was not rebuilt after the history event.',
    );
  }
  return structuredClone(projection);
}

function buildRecoveryAnchor({
  chatId,
  branchId,
  branchEpoch,
  coordinate,
  journal,
}) {
  const scope = journal?.run_scope;
  const binding =
    journal?.run_evidence?.host_history_binding;
  const rawBody = journal?.result?.final_body;
  const bindingKeys = (
    binding && typeof binding === 'object'
      ? Object.keys(binding)
      : []
  );
  if (
    journal?.schema !== 'mnemosyne.run-journal.v1'
    || journal.chat_id !== chatId
    || journal.run_id !== coordinate.run_id
    || journal.state !== 'completed'
    || journal.committed?.body_hash
      !== coordinate.body_hash
    || typeof rawBody !== 'string'
    || !rawBody
    || sha256(rawBody) !== coordinate.body_hash
    || scope?.chat_id !== chatId
    || scope.run_id !== coordinate.run_id
    || scope.turn_id !== coordinate.turn_id
    || scope.candidate_id !== coordinate.candidate_id
    || scope.turn_index !== coordinate.turn_index
    || scope.branch_id !== branchId
    || !Number.isInteger(scope.branch_epoch)
    || scope.branch_epoch < 0
    || scope.branch_epoch > branchEpoch
    || scope.swipe_id !== coordinate.swipe_id
    || binding?.schema
      !== 'mnemosyne.host-history-binding.v1'
    || bindingKeys.length
      !== HOST_HISTORY_BINDING_KEYS.size
    || bindingKeys.some(
      key => !HOST_HISTORY_BINDING_KEYS.has(key),
    )
    || binding.chat_id_hash !== sha256(chatId)
    || binding.branch_id !== branchId
    || binding.branch_epoch !== scope.branch_epoch
    || binding.target_turn_index
      !== coordinate.turn_index
    || binding.message_count !== coordinate.turn_index
    || binding.last_message_index
      !== coordinate.turn_index - 1
    || binding.last_message_role !== 'user'
  ) {
    fail(
      'history_recovery_anchor_invalid',
      'The latest governed turn is not bound to a recoverable host-history prefix.',
    );
  }
  const {
    binding_hash: bindingHash,
    ...bindingPayload
  } = binding;
  if (
    !HASH_PATTERN.test(bindingHash ?? '')
    || bindingHash
      !== sha256(canonicalJson(bindingPayload))
  ) {
    fail(
      'history_recovery_anchor_invalid',
      'The governed host-history binding no longer matches its journal seal.',
    );
  }
  const rebasedBindingPayload = {
    ...bindingPayload,
    branch_epoch: branchEpoch,
  };
  const rebasedBinding = {
    ...rebasedBindingPayload,
    binding_hash:
      sha256(canonicalJson(rebasedBindingPayload)),
  };
  return {
    schema:
      'mnemosyne.governed-history-recovery-anchor.v1',
    chat_id_hash: binding.chat_id_hash,
    branch_id: branchId,
    branch_epoch: branchEpoch,
    governed_message_count:
      coordinate.turn_index + 1,
    pre_history_binding:
      structuredClone(rebasedBinding),
    committed_assistant: {
      run_id: coordinate.run_id,
      turn_id: coordinate.turn_id,
      candidate_id: coordinate.candidate_id,
      turn_index: coordinate.turn_index,
      swipe_id: coordinate.swipe_id,
      body_hash: coordinate.body_hash,
      raw_body: rawBody,
    },
  };
}

function providerHistoryFingerprintSuffix(
  journal,
  binding,
) {
  const fingerprints =
    journal?.run_evidence?.prompt_fidelity
      ?.provider_message_fingerprints;
  if (!Array.isArray(fingerprints)) {
    fail(
      'history_recovery_anchor_invalid',
      'A governed recovery turn has no provider history fingerprints.',
    );
  }
  const windows = [];
  for (let start = 0; start < fingerprints.length; start += 1) {
    if (fingerprints[start]?.role !== 'assistant') continue;
    const candidate = [];
    for (
      let index = start;
      index < fingerprints.length;
      index += 1
    ) {
      const fingerprint = fingerprints[index];
      const expectedRole = candidate.length % 2 === 0
        ? 'assistant'
        : 'user';
      if (
        fingerprint?.provider_index !== index
        || fingerprint.role !== expectedRole
        || !HASH_PATTERN.test(
          fingerprint.content_hash ?? '',
        )
      ) {
        break;
      }
      candidate.push(fingerprint);
    }
    if (
      candidate.length >= 2
      && candidate.length % 2 === 0
      && candidate.length <= binding.message_count
    ) {
      windows.push(candidate);
    }
  }
  const maximumLength = Math.max(
    0,
    ...windows.map(window => window.length),
  );
  const longest = windows.filter(
    window => window.length === maximumLength,
  );
  if (longest.length !== 1) {
    fail(
      'history_recovery_anchor_invalid',
      'The provider history fingerprint chain is missing or ambiguous.',
    );
  }
  return {
    start_message_index:
      binding.message_count - longest[0].length,
    content_hashes: longest[0].map(
      fingerprint => fingerprint.content_hash,
    ),
  };
}

function buildRecoveryChain({
  chatId,
  branchId,
  branchEpoch,
  coordinates,
  journals,
}) {
  if (
    !Array.isArray(coordinates)
    || coordinates.length === 0
    || !Array.isArray(journals)
    || journals.length !== coordinates.length
  ) {
    fail(
      'history_recovery_anchor_invalid',
      'Governed history does not expose a complete recovery chain.',
    );
  }
  const turns = coordinates.map((coordinate, index) => {
    if (coordinate.turn_index !== 2 + (index * 2)) {
      fail(
        'history_recovery_anchor_invalid',
        'Governed history is not a contiguous plain host-turn chain.',
      );
    }
    const anchor = buildRecoveryAnchor({
      chatId,
      branchId,
      branchEpoch,
      coordinate,
      journal: journals[index],
    });
    const model = journals[index]?.model;
    if (typeof model !== 'string' || !model) {
      fail(
        'history_recovery_anchor_invalid',
        'A governed recovery turn has no bound model.',
      );
    }
    const fingerprintSuffix =
      providerHistoryFingerprintSuffix(
        journals[index],
        anchor.pre_history_binding,
      );
    return {
      schema: 'mnemosyne.governed-history-recovery-turn.v2',
      pre_history_binding:
        anchor.pre_history_binding,
      pre_history_fingerprint_start:
        fingerprintSuffix.start_message_index,
      pre_history_content_hashes:
        fingerprintSuffix.content_hashes,
      committed_assistant:
        anchor.committed_assistant,
      model,
    };
  });
  const provenHashes = new Map();
  for (const turn of turns) {
    for (
      let offset = 0;
      offset < turn.pre_history_content_hashes.length;
      offset += 1
    ) {
      const messageIndex =
        turn.pre_history_fingerprint_start + offset;
      const hash =
        turn.pre_history_content_hashes[offset];
      const existing = provenHashes.get(messageIndex);
      if (existing && existing !== hash) {
        fail(
          'history_recovery_anchor_invalid',
          'Provider history fingerprints disagree at one host coordinate.',
        );
      }
      provenHashes.set(messageIndex, hash);
    }
  }
  const lastPreHistoryMessageCount =
    coordinates.at(-1).turn_index;
  if (
    Array.from(
      { length: lastPreHistoryMessageCount },
      (_value, index) => index,
    ).some(index => !provenHashes.has(index))
  ) {
    fail(
      'history_recovery_anchor_invalid',
      'Provider history fingerprint suffixes do not cover the governed host chain.',
    );
  }
  return {
    schema:
      'mnemosyne.governed-history-recovery-anchor.v2',
    chat_id_hash: sha256(chatId),
    branch_id: branchId,
    branch_epoch: branchEpoch,
    governed_message_count:
      coordinates.at(-1).turn_index + 1,
    recovery_policy:
      'plain_alternating_content_chain',
    turns,
  };
}

export function createHistoryLifecycleService({
  stateHistory,
  projector,
  runJournal = null,
  chatWriteCoordinator = createChatWriteCoordinator(),
} = {}) {
  if (
    !stateHistory?.activateCandidateByHostCoordinate
    || !stateHistory?.deleteCandidate
    || !stateHistory?.deleteCandidateByHostCoordinate
    || !stateHistory?.truncateBranch
    || !stateHistory?.restoreBranch
  ) {
    throw new Error(
      'History Lifecycle Service requires candidate and branch State History APIs.',
    );
  }
  if (!projector?.rebuild) {
    throw new Error(
      'History Lifecycle Service requires Dynamic Story Projector.',
    );
  }
  if (runJournal !== null && !runJournal?.read) {
    throw new Error(
      'History Lifecycle Service Run Journal must expose read.',
    );
  }
  if (!chatWriteCoordinator?.run) {
    throw new Error(
      'History Lifecycle Service Chat Write Coordinator must expose run.',
    );
  }

  async function rebuild({
    chatId,
    branchId,
    branchEpoch,
    throughTurnIndex,
  }) {
    return assertProjectionReady(await projector.rebuild({
      chatId,
      branchId,
      branchEpoch,
      turnIndex: throughTurnIndex,
    }));
  }

  return Object.freeze({
    async inspectGovernedHistory({
      chatId,
      branchId = 'main',
    }) {
      if (!stateHistory?.inspectGovernedHistory) {
        fail(
          'history_inspection_unavailable',
          'Governed history inspection is unavailable.',
        );
      }
      return chatWriteCoordinator.run(
        chatId,
        async () => {
          const inspection =
            await stateHistory.inspectGovernedHistory({
              chatId,
              branchId,
            });
          let recoveryAnchor = null;
          if (
            inspection.has_governed_history
            && inspection.active_branch_epoch !== null
            && stateHistory
              .readLatestCommittedHostCoordinate
            && runJournal
          ) {
            if (
              stateHistory
                .readCommittedHostCoordinates
            ) {
              const coordinates =
                await stateHistory
                  .readCommittedHostCoordinates({
                    chatId,
                    branchId,
                    branchEpoch:
                      inspection.active_branch_epoch,
                  });
              if (coordinates.length > 0) {
                const journals = [];
                for (const coordinate of coordinates) {
                  journals.push(await runJournal.read({
                    chatId,
                    runId: coordinate.run_id,
                  }));
                }
                recoveryAnchor = buildRecoveryChain({
                  chatId,
                  branchId,
                  branchEpoch:
                    inspection.active_branch_epoch,
                  coordinates,
                  journals,
                });
              }
            } else {
              const coordinate =
                await stateHistory
                  .readLatestCommittedHostCoordinate({
                    chatId,
                    branchId,
                    branchEpoch:
                      inspection.active_branch_epoch,
                  });
              if (coordinate) {
                const journal = await runJournal.read({
                  chatId,
                  runId: coordinate.run_id,
                });
                recoveryAnchor = buildRecoveryAnchor({
                  chatId,
                  branchId,
                  branchEpoch:
                    inspection.active_branch_epoch,
                  coordinate,
                  journal,
                });
              }
            }
          }
          return (
            stateHistory
              .readLatestCommittedHostCoordinate
            && runJournal
          )
            ? {
                ...inspection,
                recovery_anchor: recoveryAnchor,
              }
            : inspection;
        },
      );
    },

    async activateSwipe({
      commandId,
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
      swipeId,
      throughTurnIndex,
    }) {
      return chatWriteCoordinator.run(chatId, async () => {
        const activated =
          await stateHistory.activateCandidateByHostCoordinate({
            commandId,
            chatId,
            branchId,
            branchEpoch,
            turnIndex,
            swipeId,
            throughTurnIndex,
          });
        const projection = await rebuild({
          chatId,
          branchId,
          branchEpoch,
          throughTurnIndex,
        });
        return {
          ...activated,
          projection,
        };
      });
    },

    async deleteSwipe({
      commandId,
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
      deletedSwipeId,
      fallbackSwipeId = null,
      throughTurnIndex,
    }) {
      return chatWriteCoordinator.run(chatId, async () => {
        const deleted = await stateHistory.deleteCandidateByHostCoordinate({
          commandId,
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
          deletedSwipeId,
          fallbackSwipeId,
          throughTurnIndex,
        });
        const projection = await rebuild({
          chatId,
          branchId,
          branchEpoch,
          throughTurnIndex,
        });
        return {
          ...deleted,
          projection,
        };
      });
    },

    async truncateBranch({
      commandId,
      chatId,
      branchId = 'main',
      expectedBranchEpoch,
      cutoffTurnIndex,
      reasonCode,
    }) {
      return chatWriteCoordinator.run(chatId, async () => {
        const truncated = await stateHistory.truncateBranch({
          commandId,
          chatId,
          branchId,
          expectedBranchEpoch,
          cutoffTurnIndex,
          reasonCode,
        });
        const projection = await rebuild({
          chatId,
          branchId,
          branchEpoch: truncated.new_branch_epoch,
          throughTurnIndex: Math.max(0, cutoffTurnIndex - 1),
        });
        return {
          ...truncated,
          projection,
        };
      });
    },

    async restoreBranch({
      commandId,
      chatId,
      branchId = 'main',
      expectedBranchEpoch,
      sourceBranchEpoch,
      throughTurnIndex,
      reasonCode,
    }) {
      return chatWriteCoordinator.run(chatId, async () => {
        const restored = await stateHistory.restoreBranch({
          commandId,
          chatId,
          branchId,
          expectedBranchEpoch,
          sourceBranchEpoch,
          throughTurnIndex,
          reasonCode,
        });
        const projection = await rebuild({
          chatId,
          branchId,
          branchEpoch: restored.new_branch_epoch,
          throughTurnIndex,
        });
        return {
          ...restored,
          projection,
        };
      });
    },
  });
}
