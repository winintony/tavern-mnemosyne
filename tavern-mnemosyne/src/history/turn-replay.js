import { canonicalJson, sha256 } from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';

const CONTRACT_SCHEMA = 'mnemosyne.turn-replay-contract.v1';
const ARTIFACT_SCHEMA = 'mnemosyne.turn-artifact.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = (
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function contractPayload(artifact) {
  return {
    schema: CONTRACT_SCHEMA,
    artifact,
  };
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

function assertArtifact(artifact, expectedIdentity = null) {
  if (
    !artifact
    || typeof artifact !== 'object'
    || Array.isArray(artifact)
    || artifact.schema !== ARTIFACT_SCHEMA
  ) {
    fail(
      'turn_replay_artifact_invalid',
      'A replay contract requires one sealed turn artifact.',
    );
  }
  if (
    expectedIdentity
    && (
      artifact.chat_id !== expectedIdentity.chatId
      || artifact.turn_id !== expectedIdentity.turnId
      || artifact.candidate_id !== expectedIdentity.candidateId
    )
  ) {
    fail(
      'turn_replay_artifact_identity_mismatch',
      'The exported artifact does not match the selected turn identity.',
    );
  }
  if (
    artifact.user_message?.role !== 'user'
    || typeof artifact.user_message.content !== 'string'
    || artifact.assistant_message?.role !== 'assistant'
    || typeof artifact.assistant_message.content !== 'string'
    || !HASH_PATTERN.test(artifact.body_hash ?? '')
    || !HASH_PATTERN.test(artifact.delta_hash ?? '')
    || !isCanonicalIsoTimestamp(artifact.committed_at)
  ) {
    fail(
      'turn_replay_artifact_invalid',
      'The replay artifact is missing exact messages or content hashes.',
    );
  }
  if (
    sha256(artifact.assistant_message.content) !== artifact.body_hash
    || sha256(canonicalJson(artifact.delta)) !== artifact.delta_hash
  ) {
    fail(
      'turn_replay_artifact_hash_mismatch',
      'The replay artifact body or delta no longer matches its sealed hash.',
    );
  }
}

function verifyContract(contract) {
  if (
    !contract
    || typeof contract !== 'object'
    || Array.isArray(contract)
    || contract.schema !== CONTRACT_SCHEMA
    || !HASH_PATTERN.test(contract.contract_hash ?? '')
  ) {
    fail(
      'turn_replay_contract_invalid',
      `Expected a ${CONTRACT_SCHEMA} contract.`,
    );
  }
  const keys = Object.keys(contract).sort();
  if (
    canonicalJson(keys)
    !== canonicalJson(['artifact', 'contract_hash', 'schema'])
  ) {
    fail(
      'turn_replay_contract_invalid',
      'Replay contracts cannot contain unsealed fields.',
    );
  }
  const expectedHash = sha256(canonicalJson(
    contractPayload(contract.artifact),
  ));
  if (contract.contract_hash !== expectedHash) {
    fail(
      'turn_replay_contract_hash_mismatch',
      'The replay contract no longer matches its canonical hash.',
    );
  }
  assertArtifact(contract.artifact);
  return structuredClone(contract.artifact);
}

export function createTurnReplay({
  sourceStateHistory,
  targetStateHistory,
  projector = null,
} = {}) {
  if (!sourceStateHistory?.readTurn) {
    throw new Error('Turn Replay requires source State History.');
  }
  if (!targetStateHistory?.commitTurn) {
    throw new Error('Turn Replay requires target State History.');
  }
  if (projector !== null && !projector?.rebuild) {
    throw new Error('Turn Replay projector must expose rebuild.');
  }

  return Object.freeze({
    async exportTurn(selection) {
      const artifact = await sourceStateHistory.readTurn(selection);
      assertArtifact(artifact, selection);
      const payload = contractPayload(structuredClone(artifact));
      return {
        ...payload,
        contract_hash: sha256(canonicalJson(payload)),
      };
    },

    async applyTurn({ contract, targetChatId }) {
      if (typeof targetChatId !== 'string' || !targetChatId) {
        fail(
          'turn_replay_target_invalid',
          'A replay target chat id is required.',
        );
      }
      const artifact = verifyContract(contract);
      const committed = await targetStateHistory.commitTurn({
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
        committed_at: artifact.committed_at,
      });
      if (!['committed', 'existing'].includes(committed?.status)) {
        fail(
          'turn_replay_commit_invalid',
          'Target State History returned an invalid replay result.',
        );
      }
      if (
        committed.body_hash !== artifact.body_hash
        || committed.delta_hash !== artifact.delta_hash
      ) {
        fail(
          'turn_replay_commit_hash_mismatch',
          'The replayed turn does not match the source content hashes.',
        );
      }

      let projectionStatus = 'not_requested';
      if (projector) {
        await projector.rebuild({
          chatId: targetChatId,
          branchId: artifact.branch_id,
          branchEpoch: artifact.branch_epoch,
          turnIndex: artifact.turn_index,
        });
        projectionStatus = 'rebuilt';
      }

      return {
        schema: 'mnemosyne.turn-replay-apply-result.v1',
        status: committed.status === 'committed'
          ? 'applied'
          : 'existing',
        contract_hash: contract.contract_hash,
        target_chat_id: targetChatId,
        turn_id: artifact.turn_id,
        candidate_id: artifact.candidate_id,
        body_hash: artifact.body_hash,
        delta_hash: artifact.delta_hash,
        projection_status: projectionStatus,
      };
    },
  });
}
