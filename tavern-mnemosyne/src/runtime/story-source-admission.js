import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';

const RECEIPT_SCHEMA =
  'mnemosyne.story-source-coverage-receipt.v2';
const AUTHORIZATION_SCHEMA =
  'mnemosyne.story-source-authorization.v1';
const PREVIEW_SCHEMA =
  'mnemosyne.story-source-admission-preview.v1';
const ADMITTED_SCHEMA =
  'mnemosyne.admitted-story-request.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = Object.freeze([
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
]);
const ADMITTED_SEAL = Symbol('mnemosyne.story-source-admission');
const admittedRequests = new WeakSet();

function fail(reasonCode, message, details = undefined) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (
    !value
    || typeof value !== 'object'
    || seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function hasExactKeys(value, keys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort())
      === canonicalJson([...keys].sort())
  );
}

function sortedUniqueStrings(values) {
  return (
    Array.isArray(values)
    && values.length > 0
    && values.every(value => (
      typeof value === 'string' && value.length > 0
    ))
    && new Set(values).size === values.length
    && canonicalJson(values)
      === canonicalJson([...values].sort())
  );
}

function runKey(runScope) {
  return sha256(canonicalJson({
    chat_id: runScope.chat_id,
    run_id: runScope.run_id,
  }));
}

function normalizeInput(input) {
  const runScope = input?.runScope;
  const preparedPrompt = input?.preparedPrompt;
  const hostProvenance = input?.hostProvenance;
  if (
    !runScope
    || typeof runScope.chat_id !== 'string'
    || !runScope.chat_id
    || typeof runScope.run_id !== 'string'
    || !runScope.run_id
    || typeof runScope.branch_id !== 'string'
    || !runScope.branch_id
    || !Number.isInteger(runScope.branch_epoch)
    || runScope.branch_epoch < 0
    || !Number.isInteger(runScope.turn_index)
    || runScope.turn_index < 0
    || preparedPrompt?.schema
      !== 'mnemosyne.verified-prepared-prompt.v1'
    || preparedPrompt?.promptSpine?.schema
      !== 'mnemosyne.prompt-spine.v1'
    || preparedPrompt.promptSpine.run_id !== runScope.run_id
    || !HASH_PATTERN.test(preparedPrompt.promptSpine.hash ?? '')
    || !preparedPrompt.body
    || typeof preparedPrompt.body !== 'object'
    || Array.isArray(preparedPrompt.body)
    || hostProvenance?.schema
      !== 'mnemosyne.host-source-provenance.v1'
    || !Array.isArray(hostProvenance.source_bindings)
  ) {
    fail(
      'story_source_admission_input_invalid',
      'Story source admission requires a verified prompt, exact run scope, and host provenance.',
    );
  }
  return {
    runScope: structuredClone(runScope),
    preparedPrompt: structuredClone(preparedPrompt),
    hostProvenance: structuredClone(hostProvenance),
    runKey: runKey(runScope),
    runScopeHash: sha256(canonicalJson(runScope)),
    preparedPromptHash: sha256(canonicalJson(preparedPrompt)),
    preparedSpineBindingHash: sha256(canonicalJson(
      preparedPrompt.promptSpine,
    )),
    hostProvenanceHash: sha256(canonicalJson(hostProvenance)),
  };
}

function receiptPayload(receipt) {
  return {
    schema: receipt?.schema,
    receipt_id: receipt?.receipt_id,
    coverage_mode: receipt?.coverage_mode,
    dry_run: receipt?.dry_run,
    run_scope: receipt?.run_scope,
    run_scope_hash: receipt?.run_scope_hash,
    snapshot: receipt?.snapshot,
    prompt_spine_hash: receipt?.prompt_spine_hash,
    prepared_spine_binding_hash:
      receipt?.prepared_spine_binding_hash,
    prepared_prompt_hash: receipt?.prepared_prompt_hash,
    host_provenance_hash: receipt?.host_provenance_hash,
    source_unit_refs: receipt?.source_unit_refs,
    certificate_ids: receipt?.certificate_ids,
    accepted_targets_hash: receipt?.accepted_targets_hash,
    okf_versions: receipt?.okf_versions,
    projection_id: receipt?.projection_id,
    projection_hash: receipt?.projection_hash,
    runtime_view_hash: receipt?.runtime_view_hash,
    coverage_binding_hash: receipt?.coverage_binding_hash,
  };
}

function normalizeReceipt(receipt, normalized) {
  const payload = receiptPayload(receipt);
  const okfVersions = receipt?.okf_versions;
  const okfVersionKeys = Array.isArray(okfVersions)
    ? okfVersions.map(version => canonicalJson([
        version?.entity_ref,
        version?.version_hash,
      ]))
    : [];
  const okfEntityRefs = Array.isArray(okfVersions)
    ? okfVersions.map(version => version?.entity_ref)
    : [];
  const stableOkfVersions = (
    Array.isArray(okfVersions)
    && okfVersions.length > 0
    && okfVersions.every(version => (
      hasExactKeys(version, ['entity_ref', 'version_hash'])
      && /^okf:\/\/entity\/\S+$/.test(version.entity_ref ?? '')
      && HASH_PATTERN.test(version.version_hash ?? '')
    ))
    && new Set(okfVersionKeys).size === okfVersionKeys.length
    && new Set(okfEntityRefs).size === okfEntityRefs.length
    && canonicalJson(okfVersionKeys)
      === canonicalJson([...okfVersionKeys].sort())
  );
  const verifiedSources = (
    receipt?.coverage_mode === 'verified_sources'
    && typeof receipt.snapshot?.snapshot_id === 'string'
    && receipt.snapshot.snapshot_id.length > 0
    && hasExactKeys(
      receipt.snapshot,
      ['snapshot_hash', 'snapshot_id'],
    )
    && HASH_PATTERN.test(receipt.snapshot.snapshot_hash ?? '')
    && sortedUniqueStrings(receipt.source_unit_refs)
    && Array.isArray(receipt.certificate_ids)
    && receipt.certificate_ids.length
      === receipt.source_unit_refs.length
    && receipt.certificate_ids.every(id => (
      /^coverage_[a-f0-9]{24}$/.test(id)
    ))
    && new Set(receipt.certificate_ids).size
      === receipt.certificate_ids.length
    && HASH_PATTERN.test(receipt.accepted_targets_hash ?? '')
    && stableOkfVersions
    && typeof receipt.projection_id === 'string'
    && receipt.projection_id.length > 0
    && HASH_PATTERN.test(receipt.projection_hash ?? '')
    && HASH_PATTERN.test(receipt.runtime_view_hash ?? '')
    && HASH_PATTERN.test(receipt.coverage_binding_hash ?? '')
  );
  const noRawSources = (
    receipt?.coverage_mode === 'no_raw_sources'
    && receipt.snapshot === null
    && Array.isArray(receipt.source_unit_refs)
    && receipt.source_unit_refs.length === 0
    && Array.isArray(receipt.certificate_ids)
    && receipt.certificate_ids.length === 0
    && receipt.accepted_targets_hash === null
    && Array.isArray(okfVersions)
    && okfVersions.length === 0
    && receipt.projection_id === null
    && receipt.projection_hash === null
    && receipt.runtime_view_hash === null
    && receipt.coverage_binding_hash === null
  );
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS)
    || receipt?.schema !== RECEIPT_SCHEMA
    || typeof receipt.receipt_id !== 'string'
    || !receipt.receipt_id
    || typeof receipt.dry_run !== 'boolean'
    || canonicalJson(receipt.run_scope)
      !== canonicalJson(normalized.runScope)
    || receipt.run_scope_hash !== normalized.runScopeHash
    || receipt.prompt_spine_hash
      !== normalized.preparedPrompt.promptSpine.hash
    || receipt.prepared_spine_binding_hash
      !== normalized.preparedSpineBindingHash
    || receipt.prepared_prompt_hash
      !== normalized.preparedPromptHash
    || receipt.host_provenance_hash
      !== normalized.hostProvenanceHash
    || !(verifiedSources || noRawSources)
    || !HASH_PATTERN.test(receipt.receipt_hash ?? '')
    || receipt.receipt_hash !== sha256(canonicalJson(payload))
  ) {
    fail(
      'story_source_receipt_binding_invalid',
      'Coverage receipt does not bind the exact prepared story run.',
    );
  }
  return structuredClone(receipt);
}

function previewFor(receipt) {
  return Object.freeze({
    schema: PREVIEW_SCHEMA,
    status: 'preview',
    receipt: Object.freeze({
      receipt_id: receipt.receipt_id,
      receipt_hash: receipt.receipt_hash,
    }),
    coverage_mode: receipt.coverage_mode,
    run_scope: Object.freeze(structuredClone(receipt.run_scope)),
    snapshot: Object.freeze(structuredClone(receipt.snapshot)),
    prompt_spine_hash: receipt.prompt_spine_hash,
    prepared_spine_binding_hash:
      receipt.prepared_spine_binding_hash,
    prepared_prompt_hash: receipt.prepared_prompt_hash,
    host_provenance_hash: receipt.host_provenance_hash,
    source_unit_refs: Object.freeze(structuredClone(
      receipt.source_unit_refs,
    )),
    certificate_ids: Object.freeze(structuredClone(
      receipt.certificate_ids,
    )),
    accepted_targets_hash: receipt.accepted_targets_hash,
    okf_versions: Object.freeze(structuredClone(receipt.okf_versions)),
    projection_id: receipt.projection_id,
    projection_hash: receipt.projection_hash,
    runtime_view_hash: receipt.runtime_view_hash,
    coverage_binding_hash: receipt.coverage_binding_hash,
  });
}

function assertReceiptHandle(handle, receipt) {
  if (
    handle?.receipt_id !== receipt.receipt_id
    || handle?.receipt_hash !== receipt.receipt_hash
  ) {
    fail(
      'story_source_receipt_mismatch',
      'Story admission receipt does not match its prepare-only preview.',
    );
  }
}

function compatibleStoredReceipt(record, normalized) {
  const conflictFields = [
    canonicalJson(record?.receipt?.run_scope)
      === canonicalJson(normalized.runScope)
      ? null
      : 'run_scope',
    record?.receipt?.prompt_spine_hash
      === normalized.preparedPrompt.promptSpine.hash
      ? null
      : 'prompt_spine_hash',
    record?.receipt?.run_scope_hash === normalized.runScopeHash
      ? null
      : 'run_scope_hash',
    record?.receipt?.prepared_spine_binding_hash
      === normalized.preparedSpineBindingHash
      ? null
      : 'prepared_spine_binding_hash',
    record?.receipt?.prepared_prompt_hash
      === normalized.preparedPromptHash
      ? null
      : 'prepared_prompt_hash',
    record?.receipt?.host_provenance_hash
      === normalized.hostProvenanceHash
      ? null
      : 'host_provenance_hash',
  ].filter(Boolean);
  if (conflictFields.length > 0) {
    fail(
      'story_source_same_run_conflict',
      'A run id cannot be reused with different story source bindings.',
      { fields: conflictFields },
    );
  }
  return normalizeReceipt(record.receipt, normalized);
}

function normalizeAuthorization(authorization, receipt) {
  if (
    authorization?.schema !== AUTHORIZATION_SCHEMA
    || authorization.status !== 'authorized'
    || authorization.dry_run !== false
    || canonicalJson(authorization.receipt) !== canonicalJson(receipt)
  ) {
    fail(
      'story_source_authorization_rejected',
      'Coverage authority did not authorize the exact previewed run.',
    );
  }
  return structuredClone(authorization);
}

function normalizeReleasedPrompt(released, normalized, receipt) {
  if (
    Array.isArray(released?.rawSurvivors)
    && released.rawSurvivors.length > 0
  ) {
    fail(
      'story_source_raw_survivor',
      'An absorbed raw author source survived prompt release.',
      { survivors: structuredClone(released.rawSurvivors) },
    );
  }
  if (
    !released?.body
    || typeof released.body !== 'object'
    || Array.isArray(released.body)
    || released.finalPromptSpine?.schema
      !== 'mnemosyne.prompt-spine.v1'
    || released.finalPromptSpine.run_id !== normalized.runScope.run_id
    || released.finalPromptSpine.hash !== receipt.prompt_spine_hash
    || !Array.isArray(released.rawSurvivors)
    || released.rawSurvivors.length !== 0
  ) {
    fail(
      'story_source_release_invalid',
      'Released story prompt is not a raw-free prompt for the previewed spine.',
    );
  }
  return {
    body: structuredClone(released.body),
    promptSpine: structuredClone(released.finalPromptSpine),
  };
}

function sealAdmitted({
  normalized,
  receipt,
  released,
}) {
  const payload = {
    schema: ADMITTED_SCHEMA,
    run_scope: structuredClone(normalized.runScope),
    receipt_id: receipt.receipt_id,
    snapshot: structuredClone(receipt.snapshot),
    prompt_spine: structuredClone(released.promptSpine),
    body: structuredClone(released.body),
  };
  const admitted = {
    ...payload,
    admission_hash: sha256(canonicalJson(payload)),
  };
  Object.defineProperty(admitted, ADMITTED_SEAL, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: ADMITTED_SEAL,
  });
  admittedRequests.add(admitted);
  return deepFreeze(admitted);
}

export function assertAdmittedStoryRequest(value) {
  if (
    !value
    || typeof value !== 'object'
    || value[ADMITTED_SEAL] !== ADMITTED_SEAL
    || !admittedRequests.has(value)
  ) {
    fail(
      'story_source_admission_seal_invalid',
      'Dispatcher requires a story request sealed by this process.',
    );
  }
  return value;
}

export function createStorySourceAdmission({
  coverageAuthority,
  releasePrompt,
  receiptStore,
} = {}) {
  if (
    typeof coverageAuthority?.issueReceipt !== 'function'
    || typeof coverageAuthority?.authorize !== 'function'
    || typeof releasePrompt !== 'function'
    || typeof receiptStore?.findByRun !== 'function'
    || typeof receiptStore?.findByReceipt !== 'function'
    || typeof receiptStore?.claim !== 'function'
  ) {
    throw new Error(
      'Story Source Admission requires coverage, release, and receipt adapters.',
    );
  }

  return Object.freeze({
    async prepareOnly(input) {
      const normalized = normalizeInput(input);
      const existing = await receiptStore.findByRun(normalized.runKey);
      if (existing) {
        const existingReceipt = compatibleStoredReceipt(
          existing,
          normalized,
        );
        return previewFor(existingReceipt);
      }
      const receipt = normalizeReceipt(
        await coverageAuthority.issueReceipt({
          preparedPrompt: normalized.preparedPrompt,
          runScope: normalized.runScope,
          hostProvenance: normalized.hostProvenance,
        }),
        normalized,
      );
      const claimed = await receiptStore.claim({
        schema: 'mnemosyne.story-source-admission-record.v1',
        run_key: normalized.runKey,
        receipt,
      });
      const claimedReceipt = compatibleStoredReceipt(
        claimed,
        normalized,
      );
      const proposedBinding = receiptPayload(receipt);
      const claimedBinding = receiptPayload(claimedReceipt);
      delete proposedBinding.receipt_id;
      delete claimedBinding.receipt_id;
      if (
        canonicalJson(proposedBinding)
          !== canonicalJson(claimedBinding)
      ) {
        fail(
          'story_source_same_run_conflict',
          'A run id cannot claim two different coverage receipts.',
          { fields: ['coverage_receipt'] },
        );
      }
      return previewFor(claimedReceipt);
    },

    async admitStory(input) {
      const normalized = normalizeInput(input);
      const receiptId = input?.receipt?.receipt_id;
      const record = typeof receiptId === 'string'
        ? await receiptStore.findByReceipt(receiptId)
        : null;
      if (!record) {
        fail(
          'story_source_prepare_required',
          'A prepare-only preview is required before story admission.',
        );
      }
      assertReceiptHandle(input.receipt, record.receipt);
      if (
        canonicalJson(record.receipt.run_scope)
          !== canonicalJson(normalized.runScope)
      ) {
        fail(
          'story_source_scope_drift',
          'Story run scope changed after its prepare-only preview.',
        );
      }
      const receipt = normalizeReceipt(record.receipt, normalized);
      if (receipt.dry_run) {
        fail(
          'story_source_dry_receipt_rejected',
          'A dry-run coverage receipt cannot admit a real story request.',
        );
      }
      const authorization = normalizeAuthorization(
        await coverageAuthority.authorize({
          preparedPrompt: normalized.preparedPrompt,
          runScope: normalized.runScope,
          hostProvenance: normalized.hostProvenance,
          receipt: structuredClone(receipt),
        }),
        receipt,
      );
      const released = normalizeReleasedPrompt(
        await releasePrompt({
          preparedPrompt: normalized.preparedPrompt,
          runScope: normalized.runScope,
          hostProvenance: normalized.hostProvenance,
          authorization,
        }),
        normalized,
        receipt,
      );
      return sealAdmitted({ normalized, receipt, released });
    },
  });
}
