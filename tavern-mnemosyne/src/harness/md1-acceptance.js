import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  verifyRootRunReplayContract,
} from './root-run-replay.js';
import {
  proveHostArtifactOutsideRecentContinuityStrip,
  verifyRecentContinuityStripWitness,
} from '../host/recent-continuity-strip.js';

const CONTRACT_SCHEMA = 'mnemosyne.md1-acceptance-contract.v3';
const MODEL_BINDING_SCHEMA = 'mnemosyne.root-run-model-binding.v1';
const PROMPT_EXCLUSION_WITNESS_SCHEMA =
  'mnemosyne.prompt-exclusion-witness.v1';
const SOURCE_REMOVAL_GRANT_SCHEMA =
  'mnemosyne.source-removal-grant.v3';
const SOURCE_ADMISSION_RECEIPT_SCHEMA =
  'mnemosyne.story-source-coverage-receipt.v2';
const TOOL_RESULT_SCHEMA = 'mnemosyne.tool-result.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTRACT_KEYS = [
  'contract_hash',
  'evidence_hashes',
  'grounding_quote',
  'prerequisite',
  'root_run_contract',
  'schema',
];
const EVIDENCE_HASH_KEYS = [
  'grounding_quote_hash',
  'model_binding_hash',
  'prerequisite_artifact_hash',
  'recent_continuity_strip_witness_hash',
  'root_run_contract_hash',
  'source_admission_receipt_hash',
  'tool_sequence_hash',
];
const MODEL_BINDING_KEYS = [
  'binding_hash',
  'binding_source',
  'dispatched_model',
  'prompt_spine_hash',
  'requested_model',
  'run_id',
  'schema',
];
const PROMPT_EXCLUSION_WITNESS_KEYS = [
  'phrase_codepoint_length',
  'phrase_hash',
  'present_provider_indices',
  'provider_message_set_hash',
  'schema',
  'status',
  'witness_hash',
];
const MODEL_BINDING_SOURCES = new Set([
  'configured_main_host',
  'host_request',
]);
const SOURCE_DECISION_KEYS = [
  'decision',
  'grant_id',
  'identifier',
  'order',
  'prompt_message_hash',
  'reason_code',
  'requested_policy',
  'source_label',
];
const REMOVED_SOURCE_KEYS = [
  'content_hash',
  'end',
  'identifier',
  'index',
  'provider_content_hash',
  'provider_content_utf16_length',
  'scope',
  'source_label',
  'start',
];
const SOURCE_REMOVAL_GRANT_KEYS = [
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
];
const SOURCE_REMOVAL_RUN_SCOPE_KEYS = [
  'branch_epoch',
  'branch_id',
  'chat_id',
  'run_id',
  'turn_index',
];
const SOURCE_ADMISSION_RECEIPT_KEYS = [
  'accepted_targets_hash',
  'certificate_ids',
  'coverage_binding_hash',
  'coverage_mode',
  'dry_run',
  'host_provenance_hash',
  'okf_versions',
  'prepared_prompt_hash',
  'prepared_spine_binding_hash',
  'projection_hash',
  'projection_id',
  'prompt_spine_hash',
  'receipt_hash',
  'receipt_id',
  'run_scope',
  'run_scope_hash',
  'runtime_view_hash',
  'schema',
  'snapshot',
  'source_unit_refs',
];
const MODEL_STEP_EVENT_TYPES = new Set([
  'tool_completed',
  'tool_started',
  'tool_rejected',
]);
const CANONICAL_TOOL_NAMES = Object.freeze({
  memory_search: 'memory.search',
  memory_read: 'memory.read',
  story_commit: 'story.commit',
  memory_write_turn_delta: 'memory.write_turn_delta',
});

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

function assertHash(value, field) {
  if (!HASH_PATTERN.test(value ?? '')) {
    fail(
      'md1_acceptance_contract_invalid',
      `${field} must be a lowercase SHA-256 hash.`,
      { field },
    );
  }
}

function modelBindingPayload(binding) {
  return {
    schema: MODEL_BINDING_SCHEMA,
    run_id: binding.run_id,
    prompt_spine_hash: binding.prompt_spine_hash,
    requested_model: binding.requested_model,
    dispatched_model: binding.dispatched_model,
    binding_source: binding.binding_source,
  };
}

export function sealMd1HostModelBinding({
  runId,
  promptSpineHash,
  requestedModel,
  dispatchedModel,
  bindingSource,
}) {
  const binding = {
    schema: MODEL_BINDING_SCHEMA,
    run_id: runId,
    prompt_spine_hash: promptSpineHash,
    requested_model: requestedModel,
    dispatched_model: dispatchedModel,
    binding_source: bindingSource,
  };
  if (
    typeof runId !== 'string'
    || !runId
    || !HASH_PATTERN.test(promptSpineHash ?? '')
    || typeof requestedModel !== 'string'
    || !requestedModel
    || typeof dispatchedModel !== 'string'
    || !dispatchedModel
    || !MODEL_BINDING_SOURCES.has(bindingSource)
  ) {
    fail(
      'md1_acceptance_model_binding_invalid',
      'A host model binding requires a run, prompt, and dispatched model.',
    );
  }
  return Object.freeze({
    ...binding,
    binding_hash: sha256(canonicalJson(binding)),
  });
}

function verifyModelBinding(binding, journal) {
  if (
    !exactKeys(binding, MODEL_BINDING_KEYS)
    || binding.schema !== MODEL_BINDING_SCHEMA
    || binding.run_id !== journal.run_id
    || binding.prompt_spine_hash !== journal.prompt_spine_hash
    || typeof binding.requested_model !== 'string'
    || !binding.requested_model
    || typeof binding.dispatched_model !== 'string'
    || !binding.dispatched_model
    || !MODEL_BINDING_SOURCES.has(binding.binding_source)
  ) {
    fail(
      'md1_acceptance_model_binding_invalid',
      'The root run has no verifiable host model binding.',
    );
  }
  assertHash(binding.binding_hash, 'model_binding.binding_hash');
  if (
    binding.binding_hash
      !== sha256(canonicalJson(modelBindingPayload(binding)))
  ) {
    fail(
      'md1_acceptance_model_binding_invalid',
      'The host model binding no longer matches its sealed hash.',
    );
  }
  if (
    journal.model !== binding.dispatched_model
    || journal.result?.model !== binding.dispatched_model
  ) {
    fail(
      'md1_acceptance_model_mismatch',
      'The completed run model does not match its host model binding.',
      {
        bound_model: binding.dispatched_model,
        journal_model: journal.model ?? null,
        result_model: journal.result?.model ?? null,
      },
    );
  }
  return binding;
}

function parseToolCall(message, transcriptIndex) {
  const calls = message?.tool_calls;
  if (
    message?.role !== 'assistant'
    || !Array.isArray(calls)
    || calls.length !== 1
  ) {
    fail(
      'md1_acceptance_transcript_invalid',
      'Every model step must contain exactly one tool call.',
      { transcript_index: transcriptIndex },
    );
  }
  const call = calls[0];
  const name = call?.function?.name ?? call?.wire_name;
  const serializedArguments = (
    call?.function?.arguments
    ?? call?.arguments_json
  );
  let args;
  try {
    args = JSON.parse(serializedArguments);
  } catch {
    fail(
      'md1_acceptance_transcript_invalid',
      'A model tool step has invalid serialized arguments.',
      { transcript_index: transcriptIndex },
    );
  }
  if (
    typeof call?.id !== 'string'
    || !call.id
    || !Object.hasOwn(CANONICAL_TOOL_NAMES, name)
    || !isObject(args)
  ) {
    fail(
      'md1_acceptance_transcript_invalid',
      'A model tool step is incomplete or unsupported.',
      { transcript_index: transcriptIndex },
    );
  }
  return {
    callId: call.id,
    name,
    args,
  };
}

function parseToolResult(message, call, transcriptIndex) {
  if (
    message?.role !== 'tool'
    || message.tool_call_id !== call.callId
    || typeof message.content !== 'string'
  ) {
    fail(
      'md1_acceptance_transcript_invalid',
      'A tool call is not immediately followed by its matching result.',
      { transcript_index: transcriptIndex },
    );
  }
  let result;
  try {
    result = JSON.parse(message.content);
  } catch {
    fail(
      'md1_acceptance_transcript_invalid',
      'A tool result is not valid JSON.',
      { transcript_index: transcriptIndex },
    );
  }
  if (
    result?.schema !== TOOL_RESULT_SCHEMA
    || result.call_id !== call.callId
    || result.tool !== CANONICAL_TOOL_NAMES[call.name]
    || typeof result.ok !== 'boolean'
  ) {
    fail(
      'md1_acceptance_transcript_invalid',
      'A tool result does not match its model call.',
      { transcript_index: transcriptIndex },
    );
  }
  return result;
}

function transcriptSteps(journal, binding) {
  const transcript = journal.transcript;
  if (
    !Array.isArray(transcript)
    || transcript.length < 8
    || transcript.length % 2 !== 0
  ) {
    fail(
      'md1_acceptance_transcript_invalid',
      'The M-D1 transcript must contain complete model/tool step pairs.',
    );
  }

  const steps = [];
  const seenCallIds = new Set();
  for (let index = 0; index < transcript.length; index += 2) {
    const call = parseToolCall(transcript[index], index);
    const result = parseToolResult(transcript[index + 1], call, index + 1);
    if (seenCallIds.has(call.callId)) {
      fail(
        'md1_acceptance_transcript_invalid',
        'Tool call ids must be unique within an acceptance run.',
        { call_id: call.callId },
      );
    }
    seenCallIds.add(call.callId);

    const matchingEvents = (journal.events ?? []).filter(event => (
      MODEL_STEP_EVENT_TYPES.has(event?.type)
      && event.call_id === call.callId
    ));
    if (
      matchingEvents.length === 0
      || matchingEvents.some(event => (
        event.tool !== call.name
        || event.model !== binding.dispatched_model
        || canonicalJson(event.arguments) !== canonicalJson(call.args)
      ))
    ) {
      fail(
        'md1_acceptance_model_mismatch',
        'A tool step is not bound to the same host model and arguments.',
        {
          call_id: call.callId,
          bound_model: binding.dispatched_model,
        },
      );
    }
    steps.push({
      index: index / 2,
      call_id: call.callId,
      name: call.name,
      args: call.args,
      ok: result.ok,
      result: result.result,
      result_hash: sha256(canonicalJson(result)),
      model: binding.dispatched_model,
    });
  }

  const toolEvents = (journal.events ?? []).filter(event => (
    MODEL_STEP_EVENT_TYPES.has(event?.type)
    && typeof event?.call_id === 'string'
    && Object.hasOwn(CANONICAL_TOOL_NAMES, event.tool)
  ));
  if (
    toolEvents.some(event => (
      !seenCallIds.has(event.call_id)
      || event.model !== binding.dispatched_model
    ))
  ) {
    fail(
      'md1_acceptance_model_mismatch',
      'Every journaled tool step must use the sealed host model.',
    );
  }
  return steps;
}

function refsFromSearch(step) {
  return new Set(
    Array.isArray(step.result?.results)
      ? step.result.results
        .map(result => result?.ref)
        .filter(ref => typeof ref === 'string' && ref)
      : [],
  );
}

function prerequisiteRefSet(step, prerequisite) {
  return new Set(
    Array.isArray(step.result?.results)
      ? step.result.results
        .filter(result => (
          typeof result?.ref === 'string'
          && result.ref
          && result.lineage?.turn_id === prerequisite.turn_id
          && result.lineage?.candidate_id === prerequisite.candidate_id
        ))
        .map(result => result.ref)
      : [],
  );
}

function assertToolChain(steps, {
  groundingQuote,
  prerequisite,
  rootArtifact,
  journal,
}) {
  const successful = steps.filter(step => step.ok);
  const searchStep = successful.find(step => (
    step.name === 'memory_search'
    && prerequisiteRefSet(step, prerequisite).size > 0
  ));
  if (!searchStep) {
    fail(
      'md1_acceptance_tool_chain_invalid',
      'M-D1 requires a successful search hit from the prerequisite candidate.',
      {
        actual: steps.map(step => ({
          index: step.index,
          name: step.name,
          ok: step.ok,
        })),
      },
    );
  }
  const prerequisiteRefs = prerequisiteRefSet(searchStep, prerequisite);
  const searchedRefs = refsFromSearch(searchStep);
  let firstRead = null;
  let firstPage = null;
  let issuedCursors = null;
  for (const candidate of successful) {
    if (
      candidate.index <= searchStep.index
      || candidate.name !== 'memory_read'
    ) {
      continue;
    }
    const requestedRefs = new Set(candidate.args.refs ?? []);
    const candidateCursors = new Set(
      Array.isArray(candidate.result?.continuation_cursors)
        ? candidate.result.continuation_cursors
        : [],
    );
    const candidatePage = (
      Array.isArray(candidate.result?.entries)
        ? candidate.result.entries
        : []
    ).find(entry => (
      typeof entry?.ref === 'string'
      && prerequisiteRefs.has(entry.ref)
      && searchedRefs.has(entry.ref)
      && requestedRefs.has(entry.ref)
      && entry.lineage?.turn_id === prerequisite.turn_id
      && entry.lineage?.candidate_id === prerequisite.candidate_id
      && typeof entry.content === 'string'
      && !entry.content.includes(groundingQuote)
      && entry.truncated === true
      && typeof entry.continuation_cursor === 'string'
      && candidateCursors.has(entry.continuation_cursor)
      && Number.isInteger(entry.content_range?.start_codepoint)
      && entry.content_range.start_codepoint === 0
      && Number.isInteger(entry.content_range?.end_codepoint)
      && Number.isInteger(entry.content_range?.total_codepoints)
      && entry.content_range.end_codepoint
        < entry.content_range.total_codepoints
    ));
    if (candidatePage) {
      firstRead = candidate;
      firstPage = candidatePage;
      issuedCursors = candidateCursors;
      break;
    }
  }
  if (!firstRead || !firstPage || !issuedCursors) {
    fail(
      'md1_acceptance_continuation_invalid',
      'M-D1 requires a truncated first page from the searched prerequisite fact.',
    );
  }

  const continuationRead = successful.find(candidate => (
    candidate.index > firstRead.index
    && candidate.name === 'memory_read'
    && new Set(candidate.args.refs ?? []).has(
      firstPage.continuation_cursor,
    )
  ));
  if (!continuationRead) {
    fail(
      'md1_acceptance_continuation_invalid',
      'M-D1 requires a later read that consumes the issued continuation cursor.',
    );
  }
  const continuationRequestedRefs = new Set(
    continuationRead.args.refs ?? [],
  );
  const consumedCursors = [...continuationRequestedRefs].filter(
    ref => issuedCursors.has(ref),
  );
  const continuationEntries = Array.isArray(
    continuationRead.result?.entries,
  )
    ? continuationRead.result.entries
    : [];
  const continuationPage = continuationEntries.find(entry => (
    entry?.ref === firstPage.ref
    && entry.lineage?.turn_id === prerequisite.turn_id
    && entry.lineage?.candidate_id === prerequisite.candidate_id
    && typeof entry.content === 'string'
    && entry.content.includes(groundingQuote)
    && Number.isInteger(entry.content_range?.start_codepoint)
    && entry.content_range.start_codepoint
      === firstPage.content_range.end_codepoint
    && Number.isInteger(entry.content_range?.end_codepoint)
    && entry.content_range.end_codepoint
      <= firstPage.content_range.total_codepoints
    && entry.content_range.total_codepoints
      === firstPage.content_range.total_codepoints
  ));
  if (
    continuationRequestedRefs.size === 0
    || consumedCursors.length !== continuationRequestedRefs.size
    || !continuationRequestedRefs.has(firstPage.continuation_cursor)
    || !continuationPage
  ) {
    fail(
      continuationPage
        ? 'md1_acceptance_continuation_invalid'
        : 'md1_acceptance_grounding_invalid',
      'M-D1 requires the signed continuation page to reveal the grounded old fact.',
    );
  }

  const commitStep = successful.find(step => (
    step.index > continuationRead.index
    && step.name === 'story_commit'
  ));
  if (
    !commitStep
    || successful.some(step => (
      step.name === 'story_commit'
      && step.index < continuationRead.index
    ))
    || commitStep.args.body !== journal.committed.body
    || !journal.committed.body.includes(groundingQuote)
  ) {
    fail(
      'md1_acceptance_grounding_invalid',
      'The committed story body must carry forward the grounded old fact.',
    );
  }

  const writeback = successful.find(step => (
    step.index > commitStep.index
    && step.name === 'memory_write_turn_delta'
  ));
  if (
    !writeback
    || writeback.args.commit_id !== journal.committed.commit_id
    || writeback.args.mode !== 'changed'
    || !Array.isArray(writeback.args.records)
    || writeback.args.records.length === 0
    || writeback.result?.status !== 'applied'
    || writeback.result?.patch_id !== rootArtifact.patch_id
    || rootArtifact.delta.mode !== 'changed'
    || rootArtifact.delta.records.length === 0
  ) {
    fail(
      'md1_acceptance_writeback_not_changed',
      'M-D1 requires a successful changed writeback with typed records.',
    );
  }
  return {
    searchIndex: searchStep.index,
    firstReadIndex: firstRead.index,
    continuationReadIndex: continuationRead.index,
    commitIndex: commitStep.index,
    writebackIndex: writeback.index,
    continuationCursorIssuedCount: issuedCursors.size,
    continuationCursorConsumedCount: consumedCursors.length,
  };
}

function assertPrerequisite({
  root,
  prerequisite,
  groundingQuote,
}) {
  if (
    !exactKeys(prerequisite, ['candidate_id', 'turn_id'])
    || typeof prerequisite.turn_id !== 'string'
    || !prerequisite.turn_id
    || typeof prerequisite.candidate_id !== 'string'
    || !prerequisite.candidate_id
  ) {
    fail(
      'md1_acceptance_prerequisite_invalid',
      'M-D1 requires one exact prerequisite turn candidate.',
    );
  }
  const artifact = root.artifacts.find(candidate => (
    candidate.turn_id === prerequisite.turn_id
    && candidate.candidate_id === prerequisite.candidate_id
  ));
  if (
    !artifact
    || (
      artifact.turn_id === root.rootArtifact.turn_id
      && artifact.candidate_id === root.rootArtifact.candidate_id
    )
    || !artifact.assistant_message.content.includes(groundingQuote)
  ) {
    fail(
      'md1_acceptance_prerequisite_invalid',
      'The grounding quote is not carried by the selected old artifact.',
    );
  }

  const fingerprints =
    root.journal.run_evidence?.provider_message_fingerprints
    ?? root.journal.run_evidence?.prompt_fidelity
      ?.provider_message_fingerprints;
  if (
    !Array.isArray(fingerprints)
    || fingerprints.length === 0
    || fingerprints.some(fingerprint => (
      !isObject(fingerprint)
      || !Number.isInteger(fingerprint.provider_index)
      || fingerprint.provider_index < 0
      || typeof fingerprint.role !== 'string'
      || (
        fingerprint.name !== null
        && fingerprint.name !== undefined
        && typeof fingerprint.name !== 'string'
      )
      || !HASH_PATTERN.test(fingerprint.content_hash ?? '')
      || !HASH_PATTERN.test(fingerprint.message_hash ?? '')
    ))
  ) {
    fail(
      'md1_acceptance_prompt_evidence_invalid',
      'M-D1 requires sealed initial provider-message fingerprints.',
    );
  }
  if (
    fingerprints.some(fingerprint => (
      fingerprint.content_hash === artifact.body_hash
    ))
  ) {
    fail(
      'md1_acceptance_fact_not_outside_prompt',
      'The selected old artifact body was already present in the initial provider prompt.',
      { prerequisite_body_hash: artifact.body_hash },
    );
  }
  const hostHistoryBinding =
    root.journal.run_evidence?.host_history_binding;
  const hostHistoryCoordinateBasis =
    root.journal.run_evidence?.host_history_coordinate_basis;
  let recentContinuityStrip;
  try {
    recentContinuityStrip = verifyRecentContinuityStripWitness(
      root.journal.run_evidence?.prompt_fidelity
        ?.recent_continuity_strip,
      {
        hostHistoryBinding,
        hostHistoryCoordinateBasis,
        providerMessageFingerprints: fingerprints,
      },
    );
  } catch (error) {
    fail(
      'md1_acceptance_prompt_evidence_invalid',
      'M-D1 lacks a verifiable Recent Continuity Strip.',
      { cause_reason_code: error?.reasonCode ?? null },
    );
  }
  let artifactExclusionProof;
  try {
    artifactExclusionProof =
      proveHostArtifactOutsideRecentContinuityStrip({
        witness: recentContinuityStrip,
        hostHistoryBinding,
        hostHistoryCoordinateBasis,
        providerMessageFingerprints: fingerprints,
        artifactTurnIndex: artifact.turn_index,
      });
  } catch (error) {
    fail(
      'md1_acceptance_fact_not_outside_prompt',
      'The prerequisite turn is not mechanically outside the bounded Recent Continuity Strip.',
      { cause_reason_code: error?.reasonCode ?? null },
    );
  }
  const journalScope = root.journal.run_scope;
  if (
    hostHistoryBinding.chat_id_hash
      !== sha256(journalScope.chat_id)
    || hostHistoryBinding.branch_id !== journalScope.branch_id
    || hostHistoryBinding.branch_epoch
      !== journalScope.branch_epoch
    || hostHistoryBinding.target_turn_index
      !== journalScope.turn_index
    || hostHistoryCoordinateBasis.run_id !== journalScope.run_id
    || hostHistoryCoordinateBasis.generation_type !== 'normal'
    || recentContinuityStrip.status !== 'bounded_tail'
    || artifactExclusionProof?.status !== 'outside'
  ) {
    fail(
      'md1_acceptance_fact_not_outside_prompt',
      'The prerequisite turn is not mechanically outside the bounded Recent Continuity Strip.',
      {
        prerequisite_turn_index: artifact.turn_index ?? null,
        first_retained_assembled_history_identifier:
          recentContinuityStrip
            .first_retained_assembled_history_identifier,
      },
    );
  }

  const witnesses =
    root.journal.run_evidence?.prompt_fidelity
      ?.prompt_exclusion_witnesses;
  const groundingQuoteHash = sha256(groundingQuote);
  const witness = Array.isArray(witnesses)
    ? witnesses.find(candidate => (
      candidate?.phrase_hash === groundingQuoteHash
    ))
    : null;
  const providerMessageSetHash = sha256(canonicalJson(fingerprints));
  if (
    !exactKeys(witness, PROMPT_EXCLUSION_WITNESS_KEYS)
    || witness.schema !== PROMPT_EXCLUSION_WITNESS_SCHEMA
    || witness.phrase_codepoint_length
      !== Array.from(groundingQuote).length
    || witness.provider_message_set_hash !== providerMessageSetHash
    || witness.status !== 'absent'
    || !Array.isArray(witness.present_provider_indices)
    || witness.present_provider_indices.length !== 0
  ) {
    fail(
      'md1_acceptance_fact_not_outside_prompt',
      'The grounding quote lacks a sealed absence witness for the initial provider prompt.',
      { grounding_quote_hash: groundingQuoteHash },
    );
  }
  assertHash(witness.witness_hash, 'prompt_exclusion_witness.witness_hash');
  const {
    witness_hash: _witnessHash,
    ...witnessPayload
  } = witness;
  if (
    witness.witness_hash !== sha256(canonicalJson(witnessPayload))
  ) {
    fail(
      'md1_acceptance_prompt_evidence_invalid',
      'The prompt exclusion witness no longer matches its sealed hash.',
    );
  }
  return {
    artifact,
    recentContinuityStrip,
  };
}

function sortedUniqueStrings(values, {
  allowEmpty = false,
  pattern = null,
} = {}) {
  return (
    Array.isArray(values)
    && (allowEmpty || values.length > 0)
    && values.every(value => (
      typeof value === 'string'
      && value.length > 0
      && (!pattern || pattern.test(value))
    ))
    && new Set(values).size === values.length
    && canonicalJson(values)
      === canonicalJson([...values].sort())
  );
}

function uniqueStrings(values, {
  allowEmpty = false,
  pattern = null,
} = {}) {
  return (
    Array.isArray(values)
    && (allowEmpty || values.length > 0)
    && values.every(value => (
      typeof value === 'string'
      && value.length > 0
      && (!pattern || pattern.test(value))
    ))
    && new Set(values).size === values.length
  );
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

function receiptPayload(receipt) {
  const {
    receipt_hash: _receiptHash,
    ...payload
  } = receipt;
  return payload;
}

function receiptAdmissionBinding(receipt) {
  return {
    schema: 'mnemosyne.story-source-admission-binding.v1',
    coverage_mode: receipt.coverage_mode,
    dry_run: receipt.dry_run,
    run_scope: receipt.run_scope,
    run_scope_hash: receipt.run_scope_hash,
    prepared_prompt_hash: receipt.prepared_prompt_hash,
    prepared_spine_binding_hash:
      receipt.prepared_spine_binding_hash,
    host_provenance_hash: receipt.host_provenance_hash,
    snapshot: receipt.snapshot,
    source_unit_refs: receipt.source_unit_refs,
    certificate_ids: receipt.certificate_ids,
    accepted_targets_hash: receipt.accepted_targets_hash,
    okf_versions: receipt.okf_versions,
    projection_id: receipt.projection_id,
    projection_hash: receipt.projection_hash,
    runtime_view_hash: receipt.runtime_view_hash,
    coverage_binding_hash: receipt.coverage_binding_hash,
  };
}

function assertSourceAdmissionReceipt(journal) {
  const receipt =
    journal.run_evidence?.story_source_admission_receipt;
  const okfVersions = receipt?.okf_versions;
  const okfVersionKeys = Array.isArray(okfVersions)
    ? okfVersions.map(version => canonicalJson([
        version?.entity_ref,
        version?.version_hash,
      ]))
    : [];
  const commonValid = (
    exactKeys(receipt, SOURCE_ADMISSION_RECEIPT_KEYS)
    && receipt.schema === SOURCE_ADMISSION_RECEIPT_SCHEMA
    && receipt.dry_run === false
    && canonicalJson(receipt.run_scope)
      === canonicalJson(journal.run_scope)
    && receipt.run_scope_hash
      === sha256(canonicalJson(journal.run_scope))
    && receipt.prompt_spine_hash === journal.prompt_spine_hash
    && HASH_PATTERN.test(receipt.prepared_spine_binding_hash ?? '')
    && HASH_PATTERN.test(receipt.prepared_prompt_hash ?? '')
    && HASH_PATTERN.test(receipt.host_provenance_hash ?? '')
    && HASH_PATTERN.test(receipt.receipt_hash ?? '')
    && receipt.receipt_hash
      === sha256(canonicalJson(receiptPayload(receipt)))
    && receipt.receipt_id
      === `receipt_${sha256(canonicalJson(
        receiptAdmissionBinding(receipt),
      ))}`
  );
  const noRawSources = (
    receipt?.coverage_mode === 'no_raw_sources'
    && receipt.snapshot === null
    && sortedUniqueStrings(receipt.source_unit_refs, {
      allowEmpty: true,
    })
    && receipt.source_unit_refs.length === 0
    && uniqueStrings(receipt.certificate_ids, {
      allowEmpty: true,
    })
    && receipt.certificate_ids.length === 0
    && receipt.accepted_targets_hash === null
    && Array.isArray(okfVersions)
    && okfVersions.length === 0
    && receipt.projection_id === null
    && receipt.projection_hash === null
    && receipt.runtime_view_hash === null
    && receipt.coverage_binding_hash === null
  );
  const verifiedSources = (
    receipt?.coverage_mode === 'verified_sources'
    && exactKeys(receipt.snapshot, [
      'snapshot_hash',
      'snapshot_id',
    ])
    && typeof receipt.snapshot.snapshot_id === 'string'
    && receipt.snapshot.snapshot_id.length > 0
    && HASH_PATTERN.test(receipt.snapshot.snapshot_hash ?? '')
    && sortedUniqueStrings(receipt.source_unit_refs)
    && uniqueStrings(receipt.certificate_ids, {
      pattern: /^coverage_[a-f0-9]{24}$/,
    })
    && receipt.certificate_ids.length
      === receipt.source_unit_refs.length
    && HASH_PATTERN.test(receipt.accepted_targets_hash ?? '')
    && Array.isArray(okfVersions)
    && okfVersions.length > 0
    && okfVersions.every(version => (
      exactKeys(version, ['entity_ref', 'version_hash'])
      && /^okf:\/\/entity\/\S+$/.test(version.entity_ref ?? '')
      && HASH_PATTERN.test(version.version_hash ?? '')
    ))
    && new Set(okfVersionKeys).size === okfVersionKeys.length
    && canonicalJson(okfVersionKeys)
      === canonicalJson([...okfVersionKeys].sort())
    && typeof receipt.projection_id === 'string'
    && receipt.projection_id.length > 0
    && HASH_PATTERN.test(receipt.projection_hash ?? '')
    && HASH_PATTERN.test(receipt.runtime_view_hash ?? '')
    && HASH_PATTERN.test(receipt.coverage_binding_hash ?? '')
  );
  if (!commonValid || !(noRawSources || verifiedSources)) {
    fail(
      'md1_acceptance_source_admission_invalid',
      'M-D1 requires one exact production Story Source Admission receipt.',
    );
  }
  return receipt;
}

function assertSourceRemovalGrant(grant, {
  decision,
  journal,
  receipt,
}) {
  const expectedRunScope = {
    chat_id: journal.run_scope.chat_id,
    run_id: journal.run_scope.run_id,
    branch_id: journal.run_scope.branch_id,
    branch_epoch: journal.run_scope.branch_epoch,
    turn_index: journal.run_scope.turn_index,
  };
  if (
    !exactKeys(grant, SOURCE_REMOVAL_GRANT_KEYS)
    || grant.schema !== SOURCE_REMOVAL_GRANT_SCHEMA
    || !exactKeys(
      grant.run_scope,
      SOURCE_REMOVAL_RUN_SCOPE_KEYS,
    )
    || canonicalJson(grant.run_scope)
      !== canonicalJson(expectedRunScope)
    || grant.identifier !== decision.identifier
    || grant.source_label !== decision.source_label
    || grant.prompt_message_hash
      !== decision.prompt_message_hash
    || grant.grant_id !== decision.grant_id
    || typeof grant.snapshot_id !== 'string'
    || !grant.snapshot_id
    || !HASH_PATTERN.test(grant.source_snapshot_hash ?? '')
    || !HASH_PATTERN.test(grant.prompt_message_hash ?? '')
    || !HASH_PATTERN.test(grant.component_hash ?? '')
    || !sortedUniqueStrings(grant.source_unit_refs)
    || !uniqueStrings(grant.certificate_ids, {
      pattern: /^coverage_[a-f0-9]{24}$/,
    })
    || grant.certificate_ids.length !== grant.source_unit_refs.length
    || grant.coverage_policy !== 'strict'
    || grant.reader_capability_version
      !== 'mnemosyne.memory-reader.v2'
    || grant.coverage_binding_hash
      !== receipt.coverage_binding_hash
    || grant.snapshot_id !== receipt.snapshot.snapshot_id
    || grant.source_snapshot_hash
      !== receipt.snapshot.snapshot_hash
    || typeof grant.issued_at !== 'string'
    || !grant.issued_at
    || grant.grant_id
      !== `grant_${sha256(canonicalJson(
        sourceRemovalGrantIdentity(grant),
      )).slice(0, 24)}`
  ) {
    fail(
      'md1_acceptance_source_decisions_invalid',
      'A removed source lacks one self-sealed grant for this exact run.',
      { identifier: decision.identifier ?? null },
    );
  }
  return grant;
}

function assertSourceDecisions(journal) {
  const promptFidelity = journal.run_evidence?.prompt_fidelity;
  const decisions = promptFidelity?.source_decisions;
  const grants = promptFidelity?.source_removal_grants;
  const removed = promptFidelity?.removed;
  const receipt = assertSourceAdmissionReceipt(journal);
  if (
    promptFidelity?.schema !== 'mnemosyne.prompt-fidelity-report.v2'
    || !Number.isInteger(promptFidelity.verified_message_count)
    || promptFidelity.verified_message_count <= 0
    || !Number.isInteger(promptFidelity.retained_message_count)
    || promptFidelity.retained_message_count <= 0
    || promptFidelity.retained_message_count
      > promptFidelity.verified_message_count
    || !Array.isArray(decisions)
    || !Array.isArray(grants)
    || !Array.isArray(removed)
  ) {
    fail(
      'md1_acceptance_source_decisions_invalid',
      'M-D1 requires complete prompt source decisions and removal evidence.',
    );
  }
  if (decisions.length === 0) {
    if (
      grants.length !== 0
      || removed.length !== 0
      || receipt.coverage_mode !== 'no_raw_sources'
    ) {
      fail(
        'md1_acceptance_source_decisions_invalid',
        'A no-source M-D1 run cannot carry removal evidence.',
      );
    }
    return receipt;
  }
  if (
    receipt.coverage_mode !== 'verified_sources'
    || decisions.length !== grants.length
    || decisions.length !== removed.length
    || decisions.some(decision => (
      !exactKeys(decision, SOURCE_DECISION_KEYS)
      || !Number.isInteger(decision.order)
      || decision.order < 0
      || typeof decision.identifier !== 'string'
      || !decision.identifier
      || typeof decision.source_label !== 'string'
      || !decision.source_label
      || !HASH_PATTERN.test(decision.prompt_message_hash ?? '')
      || decision.requested_policy
        !== 'remove_absorbed_author_source'
      || decision.decision !== 'removed'
      || typeof decision.grant_id !== 'string'
      || !decision.grant_id
      || decision.reason_code
        !== 'trusted_removal_grant_verified'
    ))
  ) {
    fail(
      'md1_acceptance_source_decisions_invalid',
      'M-D1 accepts only independently admitted source removals.',
    );
  }
  const matchedGrantIndices = new Set();
  const matchedRemovedIndices = new Set();
  const verifiedRemovedSpans = [];
  const sourceCertificates = new Map();
  for (const decision of decisions) {
    const matchingGrants = grants
      .map((grant, index) => ({ grant, index }))
      .filter(({ grant }) => grant?.grant_id === decision.grant_id);
    const matchingRemoved = removed
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => (
        entry?.identifier === decision.identifier
        && entry.source_label === decision.source_label
        && entry.content_hash === decision.prompt_message_hash
      ));
    if (
      matchingGrants.length !== 1
      || matchingRemoved.length !== 1
      || matchedGrantIndices.has(matchingGrants[0]?.index)
      || matchedRemovedIndices.has(matchingRemoved[0]?.index)
      || !exactKeys(
        matchingRemoved[0]?.entry,
        REMOVED_SOURCE_KEYS,
      )
      || !Number.isInteger(matchingRemoved[0]?.entry.index)
      || matchingRemoved[0].entry.index < 0
      || matchingRemoved[0].entry.index
        >= promptFidelity.verified_message_count
      || !HASH_PATTERN.test(
        matchingRemoved[0].entry.provider_content_hash ?? '',
      )
      || !Number.isInteger(
        matchingRemoved[0].entry.provider_content_utf16_length,
      )
      || matchingRemoved[0].entry.provider_content_utf16_length <= 0
      || !Number.isInteger(matchingRemoved[0].entry.start)
      || matchingRemoved[0].entry.start < 0
      || !Number.isInteger(matchingRemoved[0].entry.end)
      || matchingRemoved[0].entry.end
        <= matchingRemoved[0].entry.start
      || matchingRemoved[0].entry.end
        > matchingRemoved[0].entry.provider_content_utf16_length
      || !['whole_message', 'content_span'].includes(
        matchingRemoved[0].entry.scope,
      )
      || (
        matchingRemoved[0].entry.scope === 'whole_message'
        && (
          matchingRemoved[0].entry.start !== 0
          || matchingRemoved[0].entry.end
            !== matchingRemoved[0].entry
              .provider_content_utf16_length
        )
      )
      || (
        matchingRemoved[0].entry.scope === 'content_span'
        && matchingRemoved[0].entry.start === 0
        && matchingRemoved[0].entry.end
          === matchingRemoved[0].entry
            .provider_content_utf16_length
      )
    ) {
      fail(
        'md1_acceptance_source_decisions_invalid',
        'A source decision does not map one-to-one onto its grant and removed span.',
        { identifier: decision.identifier },
      );
    }
    const grant = assertSourceRemovalGrant(
      matchingGrants[0].grant,
      { decision, journal, receipt },
    );
    matchedGrantIndices.add(matchingGrants[0].index);
    matchedRemovedIndices.add(matchingRemoved[0].index);
    verifiedRemovedSpans.push(matchingRemoved[0].entry);
    for (
      let sourceIndex = 0;
      sourceIndex < grant.source_unit_refs.length;
      sourceIndex += 1
    ) {
      const ref = grant.source_unit_refs[sourceIndex];
      const certificateId = grant.certificate_ids[sourceIndex];
      const existingCertificateId = sourceCertificates.get(ref);
      if (
        existingCertificateId !== undefined
        && existingCertificateId !== certificateId
      ) {
        fail(
          'md1_acceptance_source_decisions_invalid',
          'One admitted source reference is bound to conflicting coverage certificates.',
          { source_unit_ref: ref },
        );
      }
      sourceCertificates.set(ref, certificateId);
    }
  }
  const admittedSourceCertificates = receipt.source_unit_refs.map(
    (ref, index) => [ref, receipt.certificate_ids[index]],
  );
  if (
    verifiedRemovedSpans.some((span, index) => (
      verifiedRemovedSpans.slice(index + 1).some(candidate => (
        candidate.index === span.index
        && (
          candidate.provider_content_hash
            !== span.provider_content_hash
          || candidate.provider_content_utf16_length
            !== span.provider_content_utf16_length
          || (
            candidate.start < span.end
            && span.start < candidate.end
          )
        )
      ))
    ))
    || canonicalJson(
      [...sourceCertificates.entries()].sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      )),
    ) !== canonicalJson(admittedSourceCertificates)
  ) {
    fail(
      'md1_acceptance_source_decisions_invalid',
      'Removal spans overlap or their grants do not cover the exact admitted source set.',
    );
  }
  return receipt;
}

function acceptanceEvidence({
  rootRunContract,
  prerequisiteArtifact,
  groundingQuote,
  modelBinding,
  recentContinuityStrip,
  sourceAdmissionReceipt,
  steps,
}) {
  return {
    root_run_contract_hash: sha256(canonicalJson(rootRunContract)),
    prerequisite_artifact_hash: sha256(
      canonicalJson(prerequisiteArtifact),
    ),
    grounding_quote_hash: sha256(groundingQuote),
    recent_continuity_strip_witness_hash:
      recentContinuityStrip.witness_hash,
    source_admission_receipt_hash:
      sourceAdmissionReceipt.receipt_hash,
    tool_sequence_hash: sha256(canonicalJson(steps.map(step => ({
      index: step.index,
      call_id: step.call_id,
      name: step.name,
      ok: step.ok,
      result_hash: step.result_hash,
      model: step.model,
    })))),
    model_binding_hash: modelBinding.binding_hash,
  };
}

function contractPayload(contract) {
  return {
    schema: CONTRACT_SCHEMA,
    root_run_contract: contract.root_run_contract,
    prerequisite: contract.prerequisite,
    grounding_quote: contract.grounding_quote,
    evidence_hashes: contract.evidence_hashes,
  };
}

function inspectAcceptance({
  rootRunContract,
  prerequisite,
  groundingQuote,
}) {
  if (
    typeof groundingQuote !== 'string'
    || groundingQuote !== groundingQuote.trim()
    || groundingQuote.length === 0
    || groundingQuote.length > 256
    || /[\r\n]/.test(groundingQuote)
  ) {
    fail(
      'md1_acceptance_grounding_invalid',
      'grounding_quote must be one compact non-empty fact phrase.',
    );
  }
  const root = verifyRootRunReplayContract(rootRunContract);
  if (
    root.staticBaseline?.schema
      !== 'mnemosyne.static-baseline-binding.v2'
    || root.staticBaseline.status !== 'ready'
  ) {
    fail(
      'md1_acceptance_static_baseline_not_ready',
      'M-D1 requires one active, fully bound Static Lore baseline.',
    );
  }
  const sourceAdmissionReceipt =
    assertSourceDecisions(root.journal);
  const modelBinding = verifyModelBinding(
    root.journal.run_evidence?.model_binding,
    root.journal,
  );
  const prerequisiteEvidence = assertPrerequisite({
    root,
    prerequisite,
    groundingQuote,
  });
  const prerequisiteArtifact = prerequisiteEvidence.artifact;
  const steps = transcriptSteps(root.journal, modelBinding);
  const chain = assertToolChain(steps, {
    groundingQuote,
    prerequisite,
    rootArtifact: root.rootArtifact,
    journal: root.journal,
  });
  return {
    root,
    prerequisiteArtifact,
    modelBinding,
    recentContinuityStrip:
      prerequisiteEvidence.recentContinuityStrip,
    sourceAdmissionReceipt,
    steps,
    chain,
  };
}

export function createMd1AcceptanceContract({
  rootRunContract,
  prerequisite,
  groundingQuote,
}) {
  const inspected = inspectAcceptance({
    rootRunContract,
    prerequisite,
    groundingQuote,
  });
  const evidence = acceptanceEvidence({
    rootRunContract,
    prerequisiteArtifact: inspected.prerequisiteArtifact,
    groundingQuote,
    modelBinding: inspected.modelBinding,
    recentContinuityStrip: inspected.recentContinuityStrip,
    sourceAdmissionReceipt: inspected.sourceAdmissionReceipt,
    steps: inspected.steps,
  });
  const payload = {
    schema: CONTRACT_SCHEMA,
    root_run_contract: structuredClone(rootRunContract),
    prerequisite: structuredClone(prerequisite),
    grounding_quote: groundingQuote,
    evidence_hashes: evidence,
  };
  return {
    ...payload,
    contract_hash: sha256(canonicalJson(payload)),
  };
}

export function verifyMd1AcceptanceContract(contract) {
  if (
    !exactKeys(contract, CONTRACT_KEYS)
    || contract.schema !== CONTRACT_SCHEMA
    || !exactKeys(contract.evidence_hashes, EVIDENCE_HASH_KEYS)
  ) {
    fail(
      'md1_acceptance_contract_invalid',
      `Expected an exact ${CONTRACT_SCHEMA} contract.`,
    );
  }
  assertHash(contract.contract_hash, 'contract.contract_hash');
  for (const key of EVIDENCE_HASH_KEYS) {
    assertHash(
      contract.evidence_hashes[key],
      `contract.evidence_hashes.${key}`,
    );
  }
  const inspected = inspectAcceptance({
    rootRunContract: contract.root_run_contract,
    prerequisite: contract.prerequisite,
    groundingQuote: contract.grounding_quote,
  });
  const expectedEvidence = acceptanceEvidence({
    rootRunContract: contract.root_run_contract,
    prerequisiteArtifact: inspected.prerequisiteArtifact,
    groundingQuote: contract.grounding_quote,
    modelBinding: inspected.modelBinding,
    recentContinuityStrip: inspected.recentContinuityStrip,
    sourceAdmissionReceipt: inspected.sourceAdmissionReceipt,
    steps: inspected.steps,
  });
  if (
    canonicalJson(contract.evidence_hashes)
      !== canonicalJson(expectedEvidence)
  ) {
    fail(
      'md1_acceptance_evidence_hash_mismatch',
      'The M-D1 evidence hashes no longer match their contents.',
    );
  }
  if (
    contract.contract_hash
      !== sha256(canonicalJson(contractPayload(contract)))
  ) {
    fail(
      'md1_acceptance_contract_hash_mismatch',
      'The M-D1 acceptance contract no longer matches its canonical hash.',
    );
  }
  return {
    contract: structuredClone(contract),
    root: inspected.root,
    prerequisiteArtifact: structuredClone(
      inspected.prerequisiteArtifact,
    ),
    modelBinding: structuredClone(inspected.modelBinding),
    recentContinuityStrip: structuredClone(
      inspected.recentContinuityStrip,
    ),
    sourceAdmissionReceipt: structuredClone(
      inspected.sourceAdmissionReceipt,
    ),
    toolSteps: structuredClone(inspected.steps),
    chain: structuredClone(inspected.chain),
  };
}
