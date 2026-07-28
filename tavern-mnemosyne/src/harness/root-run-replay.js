import { canonicalJson, sha256 } from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  inspectStaticBaseline,
  verifyStaticBaselineBinding,
} from './static-baseline-binding.js';
import {
  createStaticBaselineReplay,
  verifyStaticBaselineReplayPackage,
} from './static-baseline-replay.js';

const CONTRACT_SCHEMA = 'mnemosyne.root-run-replay-contract.v3';
const APPLY_RESULT_SCHEMA = 'mnemosyne.root-run-replay-apply-result.v1';
const JOURNAL_SCHEMA = 'mnemosyne.run-journal.v1';
const ARTIFACT_SCHEMA = 'mnemosyne.turn-artifact.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PATCH_ID_PATTERN = /^patch_[a-f0-9]{24}$/;
const CONTRACT_KEYS = [
  'artifacts',
  'branch_events',
  'contract_hash',
  'evidence_hashes',
  'journal',
  'schema',
  'static_baseline',
  'static_baseline_package',
  'state_snapshot',
];
const PROJECTION_HASH_FIELDS = [
  'canonical_active_state_hash',
  'canonical_chronicle_hash',
  'canonical_bundle_hash',
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

function assertHash(value, field) {
  if (!HASH_PATTERN.test(value ?? '')) {
    fail(
      'root_replay_contract_invalid',
      `${field} must be a lowercase SHA-256 hash.`,
      { field },
    );
  }
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime())
    && timestamp.toISOString() === value
  );
}

function assertProjection(projection, field) {
  if (!isObject(projection) || projection.status !== 'ready') {
    fail(
      'root_replay_contract_invalid',
      `${field} must be a ready dynamic projection result.`,
      { field },
    );
  }
  for (const hashField of PROJECTION_HASH_FIELDS) {
    assertHash(projection[hashField], `${field}.${hashField}`);
  }
}

function toolCall(message) {
  const calls = message?.tool_calls;
  if (
    message?.role !== 'assistant'
    || !Array.isArray(calls)
    || calls.length !== 1
  ) {
    return null;
  }
  const call = calls[0];
  const name = call?.function?.name ?? call?.wire_name;
  const serializedArguments = (
    call?.function?.arguments
    ?? call?.arguments_json
  );
  if (
    typeof call?.id !== 'string'
    || !call.id
    || typeof name !== 'string'
    || typeof serializedArguments !== 'string'
  ) {
    return null;
  }
  let args;
  try {
    args = JSON.parse(serializedArguments);
  } catch {
    return null;
  }
  return {
    id: call.id,
    name,
    args,
  };
}

function parsedToolResult(message) {
  if (
    message?.role !== 'tool'
    || typeof message.content !== 'string'
  ) {
    return null;
  }
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

function assertArtifact(artifact) {
  if (
    !isObject(artifact)
    || artifact.schema !== ARTIFACT_SCHEMA
    || typeof artifact.chat_id !== 'string'
    || !artifact.chat_id
    || typeof artifact.run_id !== 'string'
    || !artifact.run_id
    || typeof artifact.turn_id !== 'string'
    || !artifact.turn_id
    || typeof artifact.candidate_id !== 'string'
    || !artifact.candidate_id
    || typeof artifact.branch_id !== 'string'
    || !artifact.branch_id
    || !Number.isInteger(artifact.turn_index)
    || artifact.turn_index < 0
    || !Number.isInteger(artifact.branch_epoch)
    || artifact.branch_epoch < 0
    || !Number.isInteger(artifact.swipe_id)
    || artifact.swipe_id < 0
    || artifact.user_message?.role !== 'user'
    || typeof artifact.user_message.content !== 'string'
    || artifact.assistant_message?.role !== 'assistant'
    || typeof artifact.assistant_message.content !== 'string'
    || !isObject(artifact.delta)
    || !['changed', 'no_change'].includes(artifact.delta.mode)
    || !Array.isArray(artifact.delta.records)
    || !isCanonicalIsoTimestamp(artifact.committed_at)
    || !PATCH_ID_PATTERN.test(artifact.patch_id ?? '')
    || (
      artifact.delta.mode === 'changed'
      && artifact.delta.records.length === 0
    )
    || (
      artifact.delta.mode === 'no_change'
      && artifact.delta.records.length !== 0
    )
  ) {
    fail(
      'root_replay_artifact_invalid',
      'A root-run replay contract contains an invalid turn artifact.',
    );
  }
  assertHash(artifact.prompt_spine_hash, 'artifact.prompt_spine_hash');
  assertHash(artifact.body_hash, 'artifact.body_hash');
  assertHash(artifact.delta_hash, 'artifact.delta_hash');
  if (
    sha256(artifact.assistant_message.content) !== artifact.body_hash
    || sha256(canonicalJson(artifact.delta)) !== artifact.delta_hash
  ) {
    fail(
      'root_replay_artifact_hash_mismatch',
      'A replay artifact body or delta no longer matches its sealed hash.',
      { candidate_id: artifact.candidate_id },
    );
  }
}

function rootArtifactFor(journal, artifacts) {
  return artifacts.find(artifact => (
    artifact.chat_id === journal.run_scope.chat_id
    && artifact.run_id === journal.run_scope.run_id
    && artifact.turn_id === journal.run_scope.turn_id
    && artifact.candidate_id === journal.run_scope.candidate_id
  ));
}

function assertFinalTranscript(journal, rootArtifact) {
  const transcript = journal.transcript;
  if (!Array.isArray(transcript) || transcript.length < 4) {
    fail(
      'root_replay_journal_invalid',
      'A completed root run requires its exact tool transcript.',
    );
  }

  const storyCommit = transcript
    .map(toolCall)
    .find(call => (
      call?.name === 'story_commit'
      && call.args?.body === journal.committed.body
    ));
  if (!storyCommit) {
    fail(
      'root_replay_journal_invalid',
      'The journal transcript does not contain the sealed story commit.',
    );
  }

  const writebackCall = toolCall(transcript.at(-2));
  const writebackResult = parsedToolResult(transcript.at(-1));
  if (
    writebackCall?.name !== 'memory_write_turn_delta'
    || writebackCall.id !== writebackResult?.call_id
    || writebackCall.args?.commit_id !== journal.committed.commit_id
    || writebackCall.args?.mode !== rootArtifact.delta.mode
    || writebackResult?.schema !== 'mnemosyne.tool-result.v1'
    || writebackResult.ok !== true
    || writebackResult.tool !== 'memory.write_turn_delta'
    || writebackResult.result?.status !== 'applied'
    || writebackResult.result.patch_id !== rootArtifact.patch_id
    || writebackResult.result.body_hash !== rootArtifact.body_hash
    || writebackResult.result.delta_hash !== rootArtifact.delta_hash
  ) {
    fail(
      'root_replay_journal_invalid',
      'The final transcript step does not match the sealed turn writeback.',
    );
  }
  assertProjection(
    writebackResult.result.projection,
    'journal.transcript.writeback.projection',
  );
  if (
    canonicalJson(writebackResult.result.projection)
    !== canonicalJson(journal.result.projection)
  ) {
    fail(
      'root_replay_journal_invalid',
      'The transcript and root result disagree about projection hashes.',
    );
  }
}

function assertJournal(journal, artifacts) {
  if (
    !isObject(journal)
    || journal.schema !== JOURNAL_SCHEMA
    || journal.state !== 'completed'
    || journal.pending_writeback !== null
    || !isObject(journal.run_scope)
    || !isObject(journal.committed)
    || !isObject(journal.result)
    || journal.result.schema !== 'mnemosyne.root-turn-result.v1'
    || journal.result.status !== 'completed'
  ) {
    fail(
      'root_replay_journal_invalid',
      'Only a completed root-run journal can be exported or replayed.',
    );
  }
  assertHash(journal.request_hash, 'journal.request_hash');
  assertHash(journal.prompt_spine_hash, 'journal.prompt_spine_hash');
  assertHash(journal.committed.body_hash, 'journal.committed.body_hash');
  assertHash(journal.result.body_hash, 'journal.result.body_hash');
  assertProjection(journal.result.projection, 'journal.result.projection');
  const hostEvidence = journal.run_evidence;
  const promptFidelity = hostEvidence?.prompt_fidelity;
  const legacyPromptFidelity = (
    promptFidelity?.schema
      === 'mnemosyne.prompt-fidelity-report.v1'
  );
  const currentPromptFidelity = (
    promptFidelity?.schema
      === 'mnemosyne.prompt-fidelity-report.v2'
    && Array.isArray(promptFidelity.source_removal_grants)
    && Object.hasOwn(
      promptFidelity,
      'recent_continuity_strip',
    )
  );
  if (
    !isObject(hostEvidence)
    || hostEvidence.schema !== 'mnemosyne.root-run-host-evidence.v1'
    || hostEvidence.prompt_spine_hash !== journal.prompt_spine_hash
    || !isObject(promptFidelity)
    || !(legacyPromptFidelity || currentPromptFidelity)
    || promptFidelity.run_id !== journal.run_id
    || !Array.isArray(promptFidelity.source_decisions)
    || promptFidelity.source_decisions.some(decision => (
      !isObject(decision)
      || !['retained', 'removed'].includes(decision.decision)
      || typeof decision.source_label !== 'string'
      || !HASH_PATTERN.test(decision.prompt_message_hash ?? '')
      || (
        decision.decision === 'removed'
        && (
          typeof decision.grant_id !== 'string'
          || !decision.grant_id
        )
      )
    ))
  ) {
    fail(
      'root_replay_host_evidence_invalid',
      'The root run has no sealed prompt-fidelity and source-retention evidence.',
    );
  }

  const rootArtifact = rootArtifactFor(journal, artifacts);
  const scope = journal.run_scope;
  if (
    !rootArtifact
    || journal.chat_id !== scope.chat_id
    || journal.run_id !== scope.run_id
    || rootArtifact.turn_index !== scope.turn_index
    || rootArtifact.branch_id !== scope.branch_id
    || rootArtifact.branch_epoch !== scope.branch_epoch
    || rootArtifact.swipe_id !== scope.swipe_id
    || rootArtifact.prompt_spine_hash !== journal.prompt_spine_hash
    || rootArtifact.assistant_message.content !== journal.committed.body
    || rootArtifact.body_hash !== journal.committed.body_hash
    || journal.result.run_id !== journal.run_id
    || journal.result.final_body !== journal.committed.body
    || journal.result.body_hash !== journal.committed.body_hash
    || journal.result.writeback?.patch_id !== rootArtifact.patch_id
    || journal.result.writeback?.mode !== rootArtifact.delta.mode
  ) {
    fail(
      'root_replay_journal_invalid',
      'The completed journal does not match its sealed root turn artifact.',
    );
  }
  assertFinalTranscript(journal, rootArtifact);
  return rootArtifact;
}

function assertStateSnapshot(snapshot, journal) {
  const scope = journal.run_scope;
  if (
    !isObject(snapshot)
    || snapshot.schema !== 'mnemosyne.state-at-result.v1'
    || snapshot.status !== 'ready'
    || snapshot.chat_id !== scope.chat_id
    || snapshot.branch_id !== scope.branch_id
    || snapshot.branch_epoch !== scope.branch_epoch
    || snapshot.turn_index !== scope.turn_index
    || !Array.isArray(snapshot.current_state)
  ) {
    fail(
      'root_replay_state_snapshot_invalid',
      'The replay state snapshot does not match the root-run coordinate.',
    );
  }
  assertHash(snapshot.canonical_state_hash, 'state_snapshot.canonical_state_hash');
  if (
    sha256(canonicalJson(snapshot.current_state))
    !== snapshot.canonical_state_hash
  ) {
    fail(
      'root_replay_state_snapshot_invalid',
      'The replay state snapshot no longer matches its canonical hash.',
    );
  }
}

function assertBranchEvents(events, journal) {
  if (!Array.isArray(events)) {
    fail(
      'root_replay_branch_events_invalid',
      'Replay branch events must be an array.',
    );
  }
  const scope = journal.run_scope;
  let expectedEpoch = events.length > 0
    ? events[0]?.payload?.expected_branch_epoch
    : scope.branch_epoch;
  if (!Number.isInteger(expectedEpoch) || expectedEpoch < 0) {
    fail(
      'root_replay_branch_events_invalid',
      'Replay branch ancestry has no valid root epoch.',
    );
  }
  const rootEpoch = expectedEpoch;
  for (const event of events) {
    if (
      !isObject(event)
      || event.event_type !== 'truncate_branch'
      || typeof event.event_id !== 'string'
      || !event.event_id
      || typeof event.command_id !== 'string'
      || !event.command_id
      || event.branch_id !== scope.branch_id
      || event.branch_epoch !== expectedEpoch
      || !isCanonicalIsoTimestamp(event.created_at)
      || !isObject(event.payload)
      || !isObject(event.result)
      || event.payload.expected_branch_epoch !== expectedEpoch
      || !Number.isInteger(event.payload.cutoff_turn_index)
      || event.payload.cutoff_turn_index < 0
      || typeof event.payload.reason_code !== 'string'
      || !event.payload.reason_code
      || event.result.previous_branch_epoch !== expectedEpoch
      || event.result.new_branch_epoch !== expectedEpoch + 1
      || event.result.inherited_through_turn_index
        !== event.payload.cutoff_turn_index - 1
    ) {
      fail(
        'root_replay_branch_events_invalid',
        'A replay truncation event does not form one canonical branch edge.',
      );
    }
    expectedEpoch = event.result.new_branch_epoch;
  }
  if (expectedEpoch !== scope.branch_epoch) {
    fail(
      'root_replay_branch_events_invalid',
      'Replay branch ancestry does not reach the root-run epoch.',
    );
  }
  return rootEpoch;
}

function evidenceHashes({
  journal,
  artifacts,
  branchEvents,
  staticBaseline,
  staticBaselinePackage,
  stateSnapshot,
}) {
  return {
    transcript_hash: sha256(canonicalJson(journal.transcript)),
    run_scope_hash: sha256(canonicalJson(journal.run_scope)),
    committed_hash: sha256(canonicalJson(journal.committed)),
    result_hash: sha256(canonicalJson(journal.result)),
    artifacts_hash: sha256(canonicalJson(artifacts)),
    branch_events_hash: sha256(canonicalJson(branchEvents)),
    static_baseline_hash: sha256(canonicalJson(staticBaseline)),
    static_baseline_package_hash: sha256(canonicalJson(
      staticBaselinePackage,
    )),
    state_snapshot_hash: sha256(canonicalJson(stateSnapshot)),
    projection_hash: sha256(canonicalJson(journal.result.projection)),
  };
}

function contractPayload({
  journal,
  artifacts,
  branchEvents,
  staticBaseline,
  staticBaselinePackage,
  stateSnapshot,
  hashes,
}) {
  return {
    schema: CONTRACT_SCHEMA,
    journal,
    artifacts,
    branch_events: branchEvents,
    static_baseline: staticBaseline,
    static_baseline_package: staticBaselinePackage,
    state_snapshot: stateSnapshot,
    evidence_hashes: hashes,
  };
}

export function verifyRootRunReplayContract(contract) {
  if (
    !isObject(contract)
    || contract.schema !== CONTRACT_SCHEMA
    || !Array.isArray(contract.artifacts)
    || contract.artifacts.length === 0
    || !Array.isArray(contract.branch_events)
    || !isObject(contract.static_baseline)
    || !isObject(contract.static_baseline_package)
    || !isObject(contract.evidence_hashes)
    || Object.keys(contract).sort().join('\n')
      !== [...CONTRACT_KEYS].sort().join('\n')
  ) {
    fail(
      'root_replay_contract_invalid',
      `Expected an exact ${CONTRACT_SCHEMA} contract.`,
      {
        actual_schema: contract?.schema ?? null,
        actual_keys: isObject(contract)
          ? Object.keys(contract).sort()
          : [],
        artifact_count: Array.isArray(contract?.artifacts)
          ? contract.artifacts.length
          : null,
        branch_events_is_array: Array.isArray(contract?.branch_events),
        static_baseline_is_object: isObject(contract?.static_baseline),
        static_baseline_package_is_object:
          isObject(contract?.static_baseline_package),
        evidence_hashes_is_object: isObject(contract?.evidence_hashes),
      },
    );
  }
  assertHash(contract.contract_hash, 'contract.contract_hash');
  try {
    verifyStaticBaselineBinding(contract.static_baseline);
  } catch (error) {
    fail(
      'root_replay_static_baseline_invalid',
      error.message,
    );
  }
  try {
    const verifiedPackage = verifyStaticBaselineReplayPackage(
      contract.static_baseline_package,
    );
    if (
      canonicalJson(verifiedPackage.baseline)
      !== canonicalJson(contract.static_baseline)
    ) {
      fail(
        'root_replay_static_baseline_package_invalid',
        'The portable Static Baseline does not match its root-run binding.',
      );
    }
  } catch (error) {
    if (
      error instanceof MnemosyneRequestError
      && error.reasonCode === 'root_replay_static_baseline_package_invalid'
    ) {
      throw error;
    }
    fail(
      'root_replay_static_baseline_package_invalid',
      error.message,
    );
  }

  const identities = new Set();
  for (const artifact of contract.artifacts) {
    assertArtifact(artifact);
    const identity = canonicalJson([
      artifact.chat_id,
      artifact.turn_id,
      artifact.candidate_id,
    ]);
    if (identities.has(identity)) {
      fail(
        'root_replay_contract_invalid',
        'Replay contracts cannot contain duplicate turn artifacts.',
      );
    }
    identities.add(identity);
  }
  const rootArtifact = assertJournal(contract.journal, contract.artifacts);
  assertStateSnapshot(contract.state_snapshot, contract.journal);
  const rootBranchEpoch = assertBranchEvents(
    contract.branch_events,
    contract.journal,
  );
  const allowedEpochs = new Set([
    rootBranchEpoch,
    ...contract.branch_events.map(event => event.result.new_branch_epoch),
  ]);
  for (const artifact of contract.artifacts) {
    if (
      artifact.branch_id !== contract.journal.run_scope.branch_id
      || !allowedEpochs.has(artifact.branch_epoch)
    ) {
      fail(
        'root_replay_branch_events_invalid',
        'A replay artifact lies outside the sealed branch ancestry.',
      );
    }
  }

  const expectedEvidenceHashes = evidenceHashes({
    journal: contract.journal,
    artifacts: contract.artifacts,
    branchEvents: contract.branch_events,
    staticBaseline: contract.static_baseline,
    staticBaselinePackage: contract.static_baseline_package,
    stateSnapshot: contract.state_snapshot,
  });
  if (
    canonicalJson(contract.evidence_hashes)
    !== canonicalJson(expectedEvidenceHashes)
  ) {
    fail(
      'root_replay_evidence_hash_mismatch',
      'The root-run replay evidence hashes no longer match their contents.',
    );
  }
  const payload = contractPayload({
    journal: contract.journal,
    artifacts: contract.artifacts,
    branchEvents: contract.branch_events,
    staticBaseline: contract.static_baseline,
    staticBaselinePackage: contract.static_baseline_package,
    stateSnapshot: contract.state_snapshot,
    hashes: contract.evidence_hashes,
  });
  if (contract.contract_hash !== sha256(canonicalJson(payload))) {
    fail(
      'root_replay_contract_hash_mismatch',
      'The root-run replay contract no longer matches its canonical hash.',
    );
  }

  return {
    journal: structuredClone(contract.journal),
    artifacts: structuredClone(contract.artifacts),
    branchEvents: structuredClone(contract.branch_events),
    rootBranchEpoch,
    staticBaseline: structuredClone(contract.static_baseline),
    staticBaselinePackage: structuredClone(
      contract.static_baseline_package,
    ),
    stateSnapshot: structuredClone(contract.state_snapshot),
    evidenceHashes: structuredClone(contract.evidence_hashes),
    rootArtifact: structuredClone(rootArtifact),
  };
}

function compareProjection(actual, expected) {
  for (const field of PROJECTION_HASH_FIELDS) {
    if (actual[field] !== expected[field]) {
      fail(
        'root_replay_projection_mismatch',
        'The rebuilt projection does not match the source root run.',
        {
          field,
          expected: expected[field],
          actual: actual[field],
        },
      );
    }
  }
}

function artifactOrder(left, right) {
  return (
    left.branch_epoch - right.branch_epoch
    || left.turn_index - right.turn_index
    || left.swipe_id - right.swipe_id
    || left.candidate_id.localeCompare(right.candidate_id)
  );
}

export function createRootRunReplay({
  sourceRunJournal,
  sourceStateHistory,
  targetStateHistory,
  sourceStore,
  targetStore,
  projector,
} = {}) {
  if (!sourceRunJournal?.read) {
    throw new Error('Root Run Replay requires a source Run Journal.');
  }
  if (
    !sourceStateHistory?.readTurn
    || !sourceStateHistory?.stateAt
    || !sourceStateHistory?.getActiveCandidate
    || !sourceStateHistory?.listActiveCandidatesAt
    || !sourceStateHistory?.listBranchReplayEvents
  ) {
    throw new Error('Root Run Replay requires source State History.');
  }
  if (
    !targetStateHistory?.commitTurn
    || !targetStateHistory?.activateCandidate
    || !targetStateHistory?.getActiveCandidate
    || !targetStateHistory?.readTurn
    || !targetStateHistory?.stateAt
    || !targetStateHistory?.ensureReplayRootBranch
    || !targetStateHistory?.truncateBranch
    || !targetStateHistory?.listBranchReplayEvents
  ) {
    throw new Error('Root Run Replay requires target State History.');
  }
  if (!projector?.rebuild) {
    throw new Error('Root Run Replay requires a target projector.');
  }
  if (!sourceStore || !targetStore) {
    throw new Error(
      'Root Run Replay requires source and target chat-save stores.',
    );
  }

  return Object.freeze({
    async exportRun(options = {}) {
      if (
        !isObject(options)
        || Object.keys(options).some(key => (
          !['chatId', 'runId'].includes(key)
        ))
      ) {
        fail(
          'root_replay_export_invalid',
          'Root replay export accepts only chatId and runId; ancestry is derived from governed history.',
        );
      }
      const { chatId, runId } = options;
      const journal = await sourceRunJournal.read({ chatId, runId });
      if (
        journal.state !== 'completed'
        || journal.chat_id !== chatId
        || journal.run_id !== runId
      ) {
        fail(
          'root_replay_journal_invalid',
          'Only the selected completed root run can be exported.',
        );
      }

      const scope = journal.run_scope;
      const completeActiveHistory = (
        await sourceStateHistory.listActiveCandidatesAt({
          chatId,
          branchId: scope.branch_id,
          branchEpoch: scope.branch_epoch,
          turnIndex: scope.turn_index,
        })
      ).candidates.map(candidate => ({
        turnId: candidate.turn_id,
        candidateId: candidate.candidate_id,
      }));
      const selections = [
        ...completeActiveHistory,
        {
          turnId: journal.run_scope?.turn_id,
          candidateId: journal.run_scope?.candidate_id,
        },
      ];
      const artifacts = [];
      const identities = new Set();
      for (const selection of selections) {
        const identity = canonicalJson([
          selection?.turnId ?? null,
          selection?.candidateId ?? null,
        ]);
        if (identities.has(identity)) continue;
        identities.add(identity);
        const artifact = await sourceStateHistory.readTurn({
          chatId,
          turnId: selection?.turnId,
          candidateId: selection?.candidateId,
        });
        const active = await sourceStateHistory.getActiveCandidate({
          chatId,
          turnId: artifact.turn_id,
        });
        if (
          active.status !== 'ready'
          || active.candidate_id !== artifact.candidate_id
        ) {
          fail(
            'root_replay_prerequisite_inactive',
            'Every exported prerequisite must be the active candidate.',
            {
              turn_id: artifact.turn_id,
              candidate_id: artifact.candidate_id,
            },
          );
        }
        artifacts.push(artifact);
      }
      artifacts.sort(artifactOrder);

      const stateSnapshot = await sourceStateHistory.stateAt({
        chatId,
        branchId: scope.branch_id,
        branchEpoch: scope.branch_epoch,
        turnIndex: scope.turn_index,
      });
      const branchReplay = await sourceStateHistory.listBranchReplayEvents({
        chatId,
        branchId: scope.branch_id,
        branchEpoch: scope.branch_epoch,
      });
      const branchEvents = branchReplay.events;
      const staticBaseline = await inspectStaticBaseline({
        store: sourceStore,
        chatId,
      });
      const staticBaselinePackage = await createStaticBaselineReplay({
        sourceStore,
      }).exportBaseline({ chatId });
      if (
        canonicalJson(staticBaselinePackage.baseline)
        !== canonicalJson(staticBaseline)
      ) {
        fail(
          'root_replay_static_baseline_package_invalid',
          'The exported portable baseline does not match the root-run binding.',
        );
      }
      for (const artifact of artifacts) assertArtifact(artifact);
      assertJournal(journal, artifacts);
      assertStateSnapshot(stateSnapshot, journal);
      assertBranchEvents(branchEvents, journal);

      const hashes = evidenceHashes({
        journal,
        artifacts,
        branchEvents,
        staticBaseline,
        staticBaselinePackage,
        stateSnapshot,
      });
      const payload = contractPayload({
        journal: structuredClone(journal),
        artifacts: structuredClone(artifacts),
        branchEvents: structuredClone(branchEvents),
        staticBaseline: structuredClone(staticBaseline),
        staticBaselinePackage: structuredClone(staticBaselinePackage),
        stateSnapshot: structuredClone(stateSnapshot),
        hashes,
      });
      return {
        ...payload,
        contract_hash: sha256(canonicalJson(payload)),
      };
    },

    async applyRun({ contract, targetChatId } = {}) {
      const verified = verifyRootRunReplayContract(contract);
      const {
        journal,
        artifacts,
        branchEvents,
        rootBranchEpoch,
        staticBaseline,
        staticBaselinePackage,
        stateSnapshot,
        evidenceHashes: hashes,
        rootArtifact,
      } = verified;
      if (
        typeof targetChatId !== 'string'
        || !targetChatId
        || targetChatId !== journal.chat_id
      ) {
        fail(
          'root_replay_target_invalid',
          'Exact root-run replay requires the same logical chat id.',
        );
      }

      await createStaticBaselineReplay({
        targetStore,
      }).applyBaseline({
        replayPackage: staticBaselinePackage,
        targetChatId,
      });
      const targetStaticBaseline = await inspectStaticBaseline({
        store: targetStore,
        chatId: targetChatId,
      });
      if (
        canonicalJson(targetStaticBaseline)
        !== canonicalJson(staticBaseline)
      ) {
        fail(
          'root_replay_static_baseline_mismatch',
          'Exact replay requires the same sealed Static Lore baseline.',
          {
            expected: staticBaseline.binding_hash,
            actual: targetStaticBaseline.binding_hash,
          },
        );
      }

      const rootCreatedAt = (
        artifacts.find(artifact => artifact.branch_epoch === rootBranchEpoch)
          ?.committed_at
        ?? branchEvents[0]?.created_at
        ?? rootArtifact.committed_at
      );
      const rootBranch = await targetStateHistory.ensureReplayRootBranch({
        chatId: targetChatId,
        branchId: journal.run_scope.branch_id,
        branchEpoch: rootBranchEpoch,
        createdAt: rootCreatedAt,
      });
      if (!['created', 'existing'].includes(rootBranch?.status)) {
        fail(
          'root_replay_branch_mismatch',
          'The target store did not reproduce the sealed root branch.',
        );
      }

      const commitStatuses = [];
      const branchStatuses = [rootBranch.status];
      const epochs = [
        rootBranchEpoch,
        ...branchEvents.map(event => event.result.new_branch_epoch),
      ];
      for (const branchEpoch of epochs) {
        const epochArtifacts = artifacts.filter(
          artifact => artifact.branch_epoch === branchEpoch,
        );
        for (const artifact of epochArtifacts) {
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
            committedAt: artifact.committed_at,
          });
          if (
            !['committed', 'existing'].includes(committed?.status)
            || committed.body_hash !== artifact.body_hash
            || committed.delta_hash !== artifact.delta_hash
            || committed.patch_id !== artifact.patch_id
          ) {
            fail(
              'root_replay_commit_mismatch',
              'The target store did not reproduce a sealed turn artifact.',
              { candidate_id: artifact.candidate_id },
            );
          }
          const active = await targetStateHistory.getActiveCandidate({
            chatId: targetChatId,
            turnId: artifact.turn_id,
          });
          if (
            active.status !== 'ready'
            || active.candidate_id !== artifact.candidate_id
          ) {
            const activated = await targetStateHistory.activateCandidate({
              chatId: targetChatId,
              turnId: artifact.turn_id,
              candidateId: artifact.candidate_id,
            });
            if (!['activated', 'existing'].includes(activated?.status)) {
              fail(
                'root_replay_commit_mismatch',
                'The target store did not activate a replayed candidate.',
                { candidate_id: artifact.candidate_id },
              );
            }
          }
          const targetArtifact = await targetStateHistory.readTurn({
            chatId: targetChatId,
            turnId: artifact.turn_id,
            candidateId: artifact.candidate_id,
          });
          if (canonicalJson(targetArtifact) !== canonicalJson(artifact)) {
            fail(
              'root_replay_artifact_mismatch',
              'The target artifact is not byte-logically equal to its source.',
              { candidate_id: artifact.candidate_id },
            );
          }
          commitStatuses.push(committed.status);
        }

        const branchEvent = branchEvents.find(
          event => event.branch_epoch === branchEpoch,
        );
        if (branchEvent) {
          const truncated = await targetStateHistory.truncateBranch({
            commandId: branchEvent.command_id,
            chatId: targetChatId,
            branchId: branchEvent.branch_id,
            expectedBranchEpoch:
              branchEvent.payload.expected_branch_epoch,
            cutoffTurnIndex: branchEvent.payload.cutoff_turn_index,
            reasonCode: branchEvent.payload.reason_code,
            createdAt: branchEvent.created_at,
          });
          const expectedResult = branchEvent.result;
          if (
            !['truncated', 'existing'].includes(truncated?.status)
            || truncated.branch_id !== expectedResult.branch_id
            || truncated.previous_branch_epoch
              !== expectedResult.previous_branch_epoch
            || truncated.new_branch_epoch
              !== expectedResult.new_branch_epoch
            || truncated.inherited_through_turn_index
              !== expectedResult.inherited_through_turn_index
          ) {
            fail(
              'root_replay_branch_mismatch',
              'The target store did not reproduce a sealed branch edge.',
              { command_id: branchEvent.command_id },
            );
          }
          branchStatuses.push(truncated.status);
        }
      }

      const scope = journal.run_scope;
      const targetBranchReplay =
        await targetStateHistory.listBranchReplayEvents({
          chatId: targetChatId,
          branchId: scope.branch_id,
          branchEpoch: scope.branch_epoch,
        });
      if (
        canonicalJson(targetBranchReplay.events)
        !== canonicalJson(branchEvents)
      ) {
        fail(
          'root_replay_branch_mismatch',
          'The target branch ancestry is not exact after replay.',
        );
      }
      const rebuilt = await projector.rebuild({
        chatId: targetChatId,
        branchId: scope.branch_id,
        branchEpoch: scope.branch_epoch,
        turnIndex: scope.turn_index,
      });
      assertProjection(rebuilt, 'target_projection');
      compareProjection(rebuilt, journal.result.projection);

      const targetState = await targetStateHistory.stateAt({
        chatId: targetChatId,
        branchId: scope.branch_id,
        branchEpoch: scope.branch_epoch,
        turnIndex: scope.turn_index,
      });
      if (
        targetState.canonical_state_hash
          !== stateSnapshot.canonical_state_hash
        || canonicalJson(targetState.current_state)
          !== canonicalJson(stateSnapshot.current_state)
      ) {
        fail(
          'root_replay_state_mismatch',
          'The replayed current state does not match the source root run.',
          {
            expected: stateSnapshot.canonical_state_hash,
            actual: targetState.canonical_state_hash,
          },
        );
      }

      return {
        schema: APPLY_RESULT_SCHEMA,
        status: (
          commitStatuses.every(status => status === 'existing')
          && branchStatuses.every(status => status === 'existing')
        )
          ? 'existing'
          : 'applied',
        contract_hash: contract.contract_hash,
        run_id: journal.run_id,
        target_chat_id: targetChatId,
        artifact_count: artifacts.length,
        branch_event_count: branchEvents.length,
        final_body: rootArtifact.assistant_message.content,
        body_hash: rootArtifact.body_hash,
        delta_hash: rootArtifact.delta_hash,
        transcript: structuredClone(journal.transcript),
        transcript_hash: hashes.transcript_hash,
        canonical_state_hash: targetState.canonical_state_hash,
        projection: {
          status: 'ready',
          canonical_active_state_hash:
            rebuilt.canonical_active_state_hash,
          canonical_chronicle_hash:
            rebuilt.canonical_chronicle_hash,
          canonical_bundle_hash:
            rebuilt.canonical_bundle_hash,
        },
      };
    },
  });
}
