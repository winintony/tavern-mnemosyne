import { buildRuntimeContract } from '../contracts/runtime-contract.js';
import { validateContinuityPayload } from '../contracts/continuity-payload.js';
import { censusMark } from '../inspection/gate-census.js';

function contractProbePayload(chatId) {
  return validateContinuityPayload({
    schema: 'mnemosyne.continuity-payload.v1',
    run_scope: {
      chat_id: chatId,
      branch_epoch: 0,
      active_candidate_id: 'contract-probe',
      visible_turn_index: 0,
    },
    active_scene: {
      status: 'unavailable',
      reason_code: 'contract_probe_has_no_okf_state',
      ref: 'mnemosyne://contract-probe/active-scene',
      source_refs: [],
    },
    hard_current_state: [],
    cognition_boundaries: [],
    relationship_state: [],
    active_dossier_deltas: [],
    state_atlas_handles: [],
    latent_obligation_refs: [],
    retrieval_handles: [],
    unknowns: [{
      code: 'contract_probe_only',
      detail: 'No story-memory facts are present in this host-contract probe.',
    }],
    omissions: [],
    budget_report: {
      estimated_tokens: 120,
      hard_cap_tokens: 2400,
      unavailable_lanes: [
        'lexical',
        'embedding',
        'graph',
        'chronology',
        'current-state',
        'cognition',
        'projection',
      ],
    },
  });
}

export async function getContextResponse({
  mode = 'unavailable',
  chatId,
  request = {},
  continuityComposer,
  sourceRemovalGrantService,
  sourceCoverageRegistry: _sourceCoverageRegistry = null,
}) {
  if (mode === 'production') {
    if (!continuityComposer || !sourceRemovalGrantService) {
      censusMark('CONTEXT_RESPONSE_ADMISSION', 'blocked', {
        reasonCode: 'okf_runtime_not_configured',
      });
      return {
        schema: 'mnemosyne.context-response.v1',
        status: 'unavailable',
        reason_code: 'okf_runtime_not_configured',
        retryable: false,
      };
    }
    const continuityPayload = await continuityComposer.compose({
      chatId,
      runScope: request.run_scope,
      availableInputTokens: request.available_input_tokens,
      hardCapTokens: request.hard_cap_tokens,
    });
    const absorption = await sourceRemovalGrantService.getAbsorptionStatus({
      chatId,
    });
    const sourceCoverageRegistration = {
      schema: 'mnemosyne.source-coverage-snapshot-registration.v3',
      status: 'deferred',
      coverage_ready: false,
      reason_code:
        'source_coverage_deferred_to_exact_removal_request',
    };
    // Same contract as continuity-payload.js: run_scope has no run_id, only
    // active_candidate_id (Codex re-audit P1-3). Carry it under its own
    // honest name; id_source documents why run_id itself stays null.
    censusMark('CONTEXT_RESPONSE_ADMISSION', 'passed', {
      stage: 'production',
      runId: null,
      candidateId: request?.run_scope?.active_candidate_id ?? null,
      idSource: 'contract_absent',
    });
    return {
      schema: 'mnemosyne.context-response.v1',
      status: 'ready',
      mode: 'production',
      runtime_contract: buildRuntimeContract(),
      continuity_payload: continuityPayload,
      source_removal_authorizations: [],
      absorbed_source_kinds: absorption.absorbed_source_kinds,
      source_snapshot_id: absorption.snapshot_id,
      source_snapshot_hash: absorption.source_snapshot_hash,
      source_coverage_registration: sourceCoverageRegistration,
    };
  }

  if (mode !== 'contract-probe') {
    censusMark('CONTEXT_RESPONSE_ADMISSION', 'blocked', {
      reasonCode: 'okf_runtime_not_implemented',
    });
    return {
      schema: 'mnemosyne.context-response.v1',
      status: 'unavailable',
      reason_code: 'okf_runtime_not_implemented',
      retryable: false,
    };
  }

  censusMark('CONTEXT_RESPONSE_ADMISSION', 'passed', { stage: 'contract-probe' });
  return {
    schema: 'mnemosyne.context-response.v1',
    status: 'ready',
    mode: 'contract-probe',
    runtime_contract: buildRuntimeContract(),
    continuity_payload: contractProbePayload(chatId),
    source_removal_authorizations: [],
    absorbed_source_kinds: [],
  };
}
