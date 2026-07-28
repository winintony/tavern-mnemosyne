import {
  canonicalJson,
  hashPromptSpine,
  sha256,
} from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  createStorySourceAdmission,
} from './story-source-admission.js';
import {
  assertStorySourceAdmissionInput,
} from './story-source-host-adapter.js';

const EVIDENCE_SCHEMA =
  'mnemosyne.source-removal-admission-evidence.v1';
const RECEIPT_SCHEMA =
  'mnemosyne.story-source-coverage-receipt.v2';
const INPUT_SCHEMA =
  'mnemosyne.story-source-admission-input.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ENTITY_REF_PATTERN = /^okf:\/\/entity\/\S+$/;
const EVIDENCE_KEYS = Object.freeze([
  'accepted_targets_hash',
  'certificate_ids',
  'coverage_binding_hash',
  'okf_versions',
  'projection_hash',
  'projection_id',
  'run_scope',
  'runtime_view_hash',
  'schema',
  'snapshot',
  'source_unit_refs',
  'status',
]);

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

function coverageModeFor(hostProvenance) {
  const sourceBindings = hostProvenance?.source_bindings;
  const noRawSources = (
    Array.isArray(sourceBindings)
    && sourceBindings.length === 0
    && hostProvenance.source_coverage === null
  );
  if (noRawSources) return 'no_raw_sources';
  const verifiedSources = (
    Array.isArray(sourceBindings)
    && sourceBindings.length > 0
    && hostProvenance.source_coverage
    && typeof hostProvenance.source_coverage === 'object'
    && !Array.isArray(hostProvenance.source_coverage)
  );
  return verifiedSources ? 'verified_sources' : null;
}

function normalizeHostInput(input) {
  const payload = {
    schema: input?.schema,
    runScope: input?.runScope,
    preparedPrompt: input?.preparedPrompt,
    hostProvenance: input?.hostProvenance,
    rawSurvivors: input?.rawSurvivors,
  };
  const messages = input?.preparedPrompt?.body?.messages;
  const promptSpine = input?.preparedPrompt?.promptSpine;
  const coverageMode = coverageModeFor(input?.hostProvenance);
  if (
    input?.input_hash === sha256(canonicalJson(payload))
    && Array.isArray(input.rawSurvivors)
    && input.rawSurvivors.length > 0
  ) {
    fail(
      'story_source_raw_survivor',
      'Host adapter reported an absorbed raw author source survivor.',
    );
  }
  if (
    input?.schema !== INPUT_SCHEMA
    || input.input_hash !== sha256(canonicalJson(payload))
    || !Array.isArray(input.rawSurvivors)
    || input.rawSurvivors.length !== 0
    || !input.runScope
    || typeof input.runScope !== 'object'
    || Array.isArray(input.runScope)
    || input.preparedPrompt?.schema
      !== 'mnemosyne.verified-prepared-prompt.v1'
    || !Array.isArray(messages)
    || promptSpine?.schema !== 'mnemosyne.prompt-spine.v1'
    || promptSpine.run_id !== input.runScope.run_id
    || promptSpine.message_count !== messages.length
    || promptSpine.hash !== hashPromptSpine(messages)
    || !HASH_PATTERN.test(
      input.preparedPrompt.prompt_fidelity_report_hash ?? '',
    )
    || input.hostProvenance?.schema
      !== 'mnemosyne.host-source-provenance.v1'
    || coverageMode === null
  ) {
    fail(
      'story_source_host_adapter_evidence_invalid',
      'Production story admission requires one intact raw-free host adapter result.',
    );
  }
  return {
    runScope: structuredClone(input.runScope),
    preparedPrompt: structuredClone(input.preparedPrompt),
    hostProvenance: structuredClone(input.hostProvenance),
    coverageMode,
  };
}

function normalizeAdmissionEvidence(evidence, expectedRunScope) {
  const okfVersions = evidence?.okf_versions;
  const okfVersionKeys = Array.isArray(okfVersions)
    ? okfVersions.map(version => canonicalJson([
        version?.entity_ref,
        version?.version_hash,
      ]))
    : [];
  const okfEntityRefs = Array.isArray(okfVersions)
    ? okfVersions.map(version => version?.entity_ref)
    : [];
  if (
    !hasExactKeys(evidence, EVIDENCE_KEYS)
    || evidence.schema !== EVIDENCE_SCHEMA
    || evidence.status !== 'verified'
    || canonicalJson(evidence.run_scope)
      !== canonicalJson(expectedRunScope)
    || !hasExactKeys(
      evidence.snapshot,
      ['snapshot_hash', 'snapshot_id'],
    )
    || typeof evidence.snapshot.snapshot_id !== 'string'
    || !evidence.snapshot.snapshot_id
    || !HASH_PATTERN.test(evidence.snapshot.snapshot_hash ?? '')
    || !sortedUniqueStrings(evidence.source_unit_refs)
    || !Array.isArray(evidence.certificate_ids)
    || evidence.certificate_ids.length
      !== evidence.source_unit_refs.length
    || evidence.certificate_ids.some(certificateId => (
      !/^coverage_[a-f0-9]{24}$/.test(certificateId)
    ))
    || new Set(evidence.certificate_ids).size
      !== evidence.certificate_ids.length
    || !HASH_PATTERN.test(evidence.accepted_targets_hash ?? '')
    || !Array.isArray(okfVersions)
    || okfVersions.length === 0
    || okfVersions.some(version => (
      !hasExactKeys(version, ['entity_ref', 'version_hash'])
      || !ENTITY_REF_PATTERN.test(version.entity_ref ?? '')
      || !HASH_PATTERN.test(version.version_hash ?? '')
    ))
    || new Set(okfVersionKeys).size !== okfVersionKeys.length
    || new Set(okfEntityRefs).size !== okfEntityRefs.length
    || canonicalJson(okfVersionKeys)
      !== canonicalJson([...okfVersionKeys].sort())
    || typeof evidence.projection_id !== 'string'
    || !evidence.projection_id
    || !HASH_PATTERN.test(evidence.projection_hash ?? '')
    || !HASH_PATTERN.test(evidence.runtime_view_hash ?? '')
    || !HASH_PATTERN.test(evidence.coverage_binding_hash ?? '')
  ) {
    fail(
      'story_source_admission_evidence_invalid',
      'Trusted coverage verification did not return complete exact admission evidence.',
    );
  }
  return structuredClone(evidence);
}

function receiptFor({
  runScope,
  preparedPrompt,
  hostProvenance,
  evidence = null,
}) {
  const coverageMode = evidence
    ? 'verified_sources'
    : 'no_raw_sources';
  const binding = {
    schema: 'mnemosyne.story-source-admission-binding.v1',
    coverage_mode: coverageMode,
    dry_run: false,
    run_scope: runScope,
    run_scope_hash: sha256(canonicalJson(runScope)),
    prepared_prompt_hash: sha256(canonicalJson(preparedPrompt)),
    prepared_spine_binding_hash: sha256(canonicalJson(
      preparedPrompt.promptSpine,
    )),
    host_provenance_hash: sha256(canonicalJson(hostProvenance)),
    snapshot: evidence?.snapshot ?? null,
    source_unit_refs: evidence?.source_unit_refs ?? [],
    certificate_ids: evidence?.certificate_ids ?? [],
    accepted_targets_hash: evidence?.accepted_targets_hash ?? null,
    okf_versions: evidence?.okf_versions ?? [],
    projection_id: evidence?.projection_id ?? null,
    projection_hash: evidence?.projection_hash ?? null,
    runtime_view_hash: evidence?.runtime_view_hash ?? null,
    coverage_binding_hash: evidence?.coverage_binding_hash ?? null,
  };
  const admissionBindingHash = sha256(canonicalJson(binding));
  const receipt = {
    schema: RECEIPT_SCHEMA,
    receipt_id: `receipt_${admissionBindingHash}`,
    coverage_mode: coverageMode,
    dry_run: false,
    run_scope: structuredClone(runScope),
    run_scope_hash: binding.run_scope_hash,
    snapshot: structuredClone(binding.snapshot),
    prompt_spine_hash: preparedPrompt.promptSpine.hash,
    prepared_spine_binding_hash:
      binding.prepared_spine_binding_hash,
    prepared_prompt_hash: binding.prepared_prompt_hash,
    host_provenance_hash: binding.host_provenance_hash,
    source_unit_refs: structuredClone(binding.source_unit_refs),
    certificate_ids: structuredClone(binding.certificate_ids),
    accepted_targets_hash: binding.accepted_targets_hash,
    okf_versions: structuredClone(binding.okf_versions),
    projection_id: binding.projection_id,
    projection_hash: binding.projection_hash,
    runtime_view_hash: binding.runtime_view_hash,
    coverage_binding_hash: binding.coverage_binding_hash,
  };
  return {
    ...receipt,
    receipt_hash: sha256(canonicalJson(receipt)),
  };
}

function createProcessReceiptStore() {
  const byRun = new Map();
  const byReceipt = new Map();
  return Object.freeze({
    async findByRun(runKey) {
      return structuredClone(byRun.get(runKey) ?? null);
    },
    async findByReceipt(receiptId) {
      return structuredClone(byReceipt.get(receiptId) ?? null);
    },
    async claim(record) {
      const existing = (
        byRun.get(record.run_key)
        ?? byReceipt.get(record.receipt.receipt_id)
      );
      if (existing) return structuredClone(existing);
      const stored = structuredClone(record);
      byRun.set(record.run_key, stored);
      byReceipt.set(record.receipt.receipt_id, stored);
      return structuredClone(stored);
    },
  });
}

/**
 * Production grant-service seam (kept outside this module).
 *
 * `verifyAdmissionEvidence({ runScope, hostProvenance, preparedPrompt })`
 * must revalidate every host provenance grant and provider fingerprint
 * against the ledger, active snapshot, exact source units, accepted
 * targets, current OKF versions, projection, runtime view, and full run
 * scope. It returns exactly
 * `mnemosyne.source-removal-admission-evidence.v1` (the keys enforced by
 * `EVIDENCE_KEYS`) or returns null/throws. It must derive the returned
 * evidence from trusted storage; `hostProvenance.source_coverage` is
 * only verification input and is never authoritative by itself.
 *
 * The seam is called independently during receipt issue and formal
 * authorization. Callers must not cache a positive result across them.
 * `createGrantBackedStorySourceAdmission` is the production adapter:
 * it projects the full run scope to the grant ledger's five-field
 * removal scope and calls
 * `sourceRemovalGrantService.verifyCoverageBinding` with the exact
 * coverage binding/hash, grants, and provider fingerprints preserved
 * by the sealed host adapter. The adapter must then bind trusted
 * evidence back to the full story run scope.
 *
 * `no_raw_sources` is the sole exception: the original sealed host
 * result must contain no source bindings, null source coverage, and no
 * survivors. No coverage verifier call is made for that mode.
 *
 * Public composition is deliberately two-step:
 * `prepareOnly(originalSealedHostInput)`, followed by
 * `admitStory({ hostInput: originalSealedHostInput, receipt })`.
 * Both steps reassert the process-local host-adapter seal.
 */
export function createProductionStorySourceAdmissionRuntime({
  verifyAdmissionEvidence,
  releasePreparedPrompt = async ({ preparedPrompt }) => ({
    body: structuredClone(preparedPrompt.body),
    finalPromptSpine: structuredClone(preparedPrompt.promptSpine),
    rawSurvivors: [],
  }),
} = {}) {
  if (
    typeof verifyAdmissionEvidence !== 'function'
    || typeof releasePreparedPrompt !== 'function'
  ) {
    throw new Error(
      'Production Story Source Admission requires trusted coverage and release adapters.',
    );
  }
  const receiptStore = createProcessReceiptStore();

  async function authoritativeReceipt(input) {
    if (
      coverageModeFor(input.hostProvenance)
        === 'no_raw_sources'
    ) {
      return receiptFor(input);
    }
    let evidence;
    try {
      evidence = await verifyAdmissionEvidence({
        runScope: structuredClone(input.runScope),
        hostProvenance: structuredClone(input.hostProvenance),
        preparedPrompt: structuredClone(input.preparedPrompt),
      });
    } catch (error) {
      if (
        error instanceof MnemosyneRequestError
        && error.reasonCode
          === 'story_source_admission_evidence_invalid'
      ) {
        throw error;
      }
      fail(
        'story_source_admission_evidence_invalid',
        'Trusted coverage verification failed closed.',
      );
    }
    return receiptFor({
      ...input,
      evidence: normalizeAdmissionEvidence(
        evidence,
        input.runScope,
      ),
    });
  }

  const admission = createStorySourceAdmission({
    receiptStore,
    coverageAuthority: {
      async issueReceipt(input) {
        return authoritativeReceipt(input);
      },
      async authorize(input) {
        const reverified = await authoritativeReceipt(input);
        if (
          canonicalJson(reverified)
            !== canonicalJson(input.receipt)
        ) {
          fail(
            'story_source_authorization_rejected',
            'Trusted admission evidence drifted after preview.',
          );
        }
        return {
          schema: 'mnemosyne.story-source-authorization.v1',
          status: 'authorized',
          dry_run: false,
          receipt: structuredClone(reverified),
        };
      },
    },
    releasePrompt: async input => {
      const released = await releasePreparedPrompt({
        runScope: structuredClone(input.runScope),
        hostProvenance: structuredClone(input.hostProvenance),
        preparedPrompt: structuredClone(input.preparedPrompt),
      });
      if (
        Array.isArray(released?.rawSurvivors)
        && released.rawSurvivors.length > 0
      ) {
        fail(
          'story_source_raw_survivor',
          'Production release reported an absorbed raw author source survivor.',
        );
      }
      if (
        canonicalJson(released?.body)
          !== canonicalJson(input.preparedPrompt.body)
        || canonicalJson(released?.finalPromptSpine)
          !== canonicalJson(input.preparedPrompt.promptSpine)
        || !Array.isArray(released?.rawSurvivors)
        || released.rawSurvivors.length !== 0
      ) {
        fail(
          'story_source_release_invalid',
          'Production release must return the exact prepared raw-free prompt.',
        );
      }
      return structuredClone(released);
    },
  });

  return Object.freeze({
    async prepareOnly(hostInput) {
      assertStorySourceAdmissionInput(hostInput);
      normalizeHostInput(hostInput);
      const preview = await admission.prepareOnly(hostInput);
      const record = await receiptStore.findByReceipt(
        preview.receipt.receipt_id,
      );
      if (!record) {
        fail(
          'story_source_prepare_required',
          'Prepared coverage receipt was not retained in this process.',
        );
      }
      return deepFreeze({
        ...structuredClone(preview),
        receipt: structuredClone(record.receipt),
      });
    },

    async admitStory({ hostInput, receipt } = {}) {
      assertStorySourceAdmissionInput(hostInput);
      normalizeHostInput(hostInput);
      return admission.admitStory({
        ...hostInput,
        receipt,
      });
    },
  });
}
