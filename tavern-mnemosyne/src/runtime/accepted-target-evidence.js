import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  acceptedBaselineClaimLine,
} from '../contracts/accepted-baseline-claim.js';

const SEMANTIC_ACCEPTANCE_SCHEMA =
  'mnemosyne.semantic-acceptance-binding.v1';

function normalizedIdentity(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function acceptedClaimHash({
  claimKind,
  canonicalClaim,
}) {
  return sha256(canonicalJson({
    claim_kind: claimKind,
    claim: canonicalClaim,
  }));
}

export function acceptedClaimFieldPath(claimIndex) {
  return `body.imported_baseline_claims[${claimIndex}]`;
}

export function acceptedClaimLine({
  claimKind,
  canonicalClaim,
}) {
  return acceptedBaselineClaimLine({
    claimKind,
    canonicalClaim,
  });
}

export function acceptedClaimSearchQuery(canonicalClaim) {
  return String(canonicalClaim ?? '').replace(/\s+/gu, ' ').trim();
}

export function searchQueryUsesOnlyRuntimeIdentity({
  query,
  title,
  entityRef,
}) {
  const normalizedQuery = normalizedIdentity(query);
  const normalizedTitle = normalizedIdentity(title);
  const entityId = String(entityRef ?? '').replace(/^okf:\/\/entity\//, '');
  return (
    !normalizedQuery
    || (normalizedTitle && normalizedQuery === normalizedTitle)
    || String(query ?? '').includes(String(entityRef ?? ''))
    || (
      entityId
      && normalizedQuery === normalizedIdentity(entityId)
    )
  );
}

// This is an integrity binding over the extractor-accepted mapping, not an
// independent judgment that the claim preserves every meaning in the quote.
export function semanticAcceptanceHash({
  snapshotId,
  sourceUnitRef,
  evidenceId,
  evidenceMode,
  evidenceQuoteHash,
  modelArtifactHash,
  runtimeViewHash,
  acceptedTarget,
}) {
  return sha256(canonicalJson({
    schema: SEMANTIC_ACCEPTANCE_SCHEMA,
    snapshot_id: snapshotId,
    source_unit_ref: sourceUnitRef,
    evidence_id: evidenceId,
    evidence_mode: evidenceMode,
    evidence_quote_hash: evidenceQuoteHash,
    model_artifact_hash: modelArtifactHash,
    runtime_view_hash: runtimeViewHash,
    accepted_target: {
      entity_ref: acceptedTarget.entity_ref,
      field_path: acceptedTarget.field_path,
      claim_kind: acceptedTarget.claim_kind,
      canonical_claim: acceptedTarget.canonical_claim,
      claim_hash: acceptedTarget.claim_hash,
      okf_version_hash: acceptedTarget.okf_version_hash,
    },
  }));
}
