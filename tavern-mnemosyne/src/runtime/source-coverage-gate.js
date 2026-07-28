import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  buildStaticLoreSourceUnits,
} from '../intake/static-lore-source-units.js';
import {
  classifyStaticLoreControlUnit,
  classifyStaticLoreListMarkerEvidenceSpan,
  classifyStaticLoreStructuralEvidenceSpan,
  STATIC_LORE_CONTROL_DISPOSITION,
  STATIC_LORE_CONTROL_RECORD_KIND,
  staticLoreControlAcceptanceHash,
  staticLoreControlTarget,
} from '../intake/static-lore-control-units.js';
import {
  acceptedClaimHash,
  acceptedClaimLine,
  acceptedClaimSearchQuery,
  searchQueryUsesOnlyRuntimeIdentity,
  semanticAcceptanceHash,
} from './accepted-target-evidence.js';
import {
  assertRuntimeWorldProjectionIntegrity,
} from './runtime-world-integrity.js';

const CERTIFICATE_SCHEMA = 'mnemosyne.source-coverage-certificate.v3';
const VERIFICATION_SCHEMA = 'mnemosyne.source-coverage-verification.v3';
const REQUIRED_READER_CAPABILITY_VERSION = 'mnemosyne.memory-reader.v2';
const RUNTIME_MEMORY_REF = /^(?:okf:\/\/entity|memory:\/\/turn-record)\/\S+$/;
const OKF_ENTITY_REF = /^okf:\/\/entity\/\S+$/;
const AUTHOR_SOURCE_REF = /^(?:character-card|worldinfo|persona|scenario):\/\//;
const ACCEPTED_CLAIM_FIELD_PATH =
  /^body\.imported_baseline_claims\[(\d+)\]$/;
const ACCEPTED_TARGET_FIELDS = [
  'canonical_claim',
  'claim_hash',
  'claim_kind',
  'entity_ref',
  'field_path',
  'okf_version_hash',
  'semantic_acceptance_hash',
];
const LOCAL_CONTROL_TARGET_FIELDS = [
  'classification_hash',
  'control_kind',
  'local_acceptance_hash',
  'marker_hash',
  'source_kind',
  'unit_id',
];
const SOURCE_SCHEME_BY_KIND = Object.freeze({
  character_card: 'character-card',
  worldbook: 'worldinfo',
  persona: 'persona',
  scenario: 'scenario',
});

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function sourceUnitText(unit) {
  if (typeof unit?.data === 'string') return unit.data;
  if (typeof unit?.data?.content === 'string') return unit.data.content;
  return JSON.stringify(unit?.data ?? null);
}

function currentReaderVersion(memoryReader) {
  const version = memoryReader?.capability_version
    ?? memoryReader?.capabilityVersion;
  if (
    typeof memoryReader?.read !== 'function'
    || typeof memoryReader?.search !== 'function'
    || typeof version !== 'string'
    || !version.trim()
  ) {
    fail(
      'source_coverage_reader_unavailable',
      'A versioned Memory Reader is required for source coverage.',
    );
  }
  if (version !== REQUIRED_READER_CAPABILITY_VERSION) {
    fail(
      'source_coverage_reader_version_stale',
      'Source coverage requires the current Memory Reader contract.',
      {
        expected: REQUIRED_READER_CAPABILITY_VERSION,
        actual: version,
      },
    );
  }
  return version;
}

function assertReadScope(readScope) {
  if (
    typeof readScope?.branch_id !== 'string'
    || !readScope.branch_id.trim()
    || !Number.isInteger(readScope?.branch_epoch)
    || readScope.branch_epoch < 0
    || !Number.isInteger(readScope?.turn_index)
    || readScope.turn_index < 0
  ) {
    fail(
      'source_coverage_read_scope_invalid',
      'Source coverage requires non-negative branch and turn coordinates.',
    );
  }
}

function sourceRefBelongsToUnit(
  sourceRef,
  snapshotId,
  sourceId,
  sourceKind,
) {
  if (typeof sourceRef !== 'string' || !sourceRef) return false;
  const scheme = SOURCE_SCHEME_BY_KIND[sourceKind];
  if (!scheme) return false;
  return sourceRef.startsWith(
    `${scheme}://snapshot/${encodeURIComponent(snapshotId)}/${
      encodeURIComponent(sourceId)
    }/`,
  );
}

function factBearingContent(content, title) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const prose = content
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!prose) return null;
  const normalize = value => String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
  const normalizedProse = normalize(prose);
  const normalizedTitle = normalize(title);
  if (
    !normalizedProse
    || (normalizedTitle && normalizedProse === normalizedTitle)
  ) {
    return null;
  }
  return prose;
}

async function loadActiveContext({
  store,
  chatId,
  sourceId,
  sourceUnitRef,
}) {
  const opened = await store.openChatForAdmin({ chatId });
  const database = new DatabaseSync(opened.ledger_path, { readOnly: true });
  let snapshot;
  let source;
  let projections;
  try {
    const snapshots = database.prepare(`
      SELECT snapshot_id, aggregate_hash
      FROM static_lore_snapshots
      WHERE chat_id = ? AND status = 'active'
      ORDER BY captured_at DESC, snapshot_id DESC
    `).all(chatId);
    if (snapshots.length !== 1) {
      fail(
        snapshots.length === 0
          ? 'source_coverage_active_snapshot_missing'
          : 'source_coverage_active_snapshot_ambiguous',
        'Source coverage requires exactly one active Static Lore snapshot.',
      );
    }
    [snapshot] = snapshots;
    source = database.prepare(`
      SELECT source_id, source_kind, source_hash
      FROM static_lore_sources
      WHERE snapshot_id = ? AND source_id = ?
    `).get(snapshot.snapshot_id, sourceId);
    if (!source) {
      fail(
        'source_coverage_source_unit_missing',
        'The source unit is not part of the active snapshot.',
        { source_id: sourceId },
      );
    }
    projections = database.prepare(`
      SELECT projection_id, source_version_hash
      FROM derived_state
      WHERE
        chat_id = ?
        AND projection_kind = 'runtime_world'
        AND status = 'ready'
      ORDER BY updated_at DESC, projection_id DESC
    `).all(chatId);
  } finally {
    database.close();
  }

  let runtimeWorld;
  try {
    runtimeWorld = JSON.parse(await readFile(path.join(
      opened.chat_save_path,
      'derived',
      'runtime-world.json',
    ), 'utf8'));
  } catch (error) {
    fail(
      'source_coverage_runtime_view_missing',
      'The active Runtime World view is unavailable.',
      { cause: error.code ?? error.message },
    );
  }
  let runtimeViewHash;
  try {
    const integrity = assertRuntimeWorldProjectionIntegrity({
      runtimeWorld,
      activeSnapshot: {
        snapshot_id: snapshot.snapshot_id,
        snapshot_hash: snapshot.aggregate_hash,
      },
      readyProjectionHashes: projections.map(
        projection => projection.source_version_hash,
      ),
    });
    runtimeViewHash = integrity.runtime_world_hash;
  } catch (error) {
    if (error?.reasonCode === 'runtime_world_projection_missing') {
      fail(
        'source_coverage_projection_missing',
        'A ready Runtime World projection is required for source coverage.',
      );
    }
    if (error?.reasonCode === 'runtime_world_projection_ambiguous') {
      fail(
        'source_coverage_projection_ambiguous',
        'Source coverage requires exactly one ready Runtime World projection.',
      );
    }
    if (error?.reasonCode === 'runtime_world_projection_stale') {
      fail(
        'source_coverage_projection_stale',
        'The ready projection does not match the Runtime World view.',
        error.details,
      );
    }
    fail(
      'source_coverage_runtime_view_stale',
      'The Runtime World view does not match the active snapshot.',
      {
        cause: error?.reasonCode ?? 'runtime_world_integrity_failed',
      },
    );
  }
  const [projection] = projections;
  let trustedSnapshot;
  try {
    trustedSnapshot = await store.readStaticLoreSnapshotForAdmin({
      chatId,
      snapshotId: snapshot.snapshot_id,
    });
  } catch (error) {
    fail(
      'source_coverage_active_snapshot_stale',
      'The active Static Lore snapshot cannot be read.',
      { cause: error.code ?? error.message },
    );
  }
  if (
    trustedSnapshot?.snapshot_id !== snapshot.snapshot_id
    || trustedSnapshot.snapshot_hash !== snapshot.aggregate_hash
    || trustedSnapshot.chat_id !== chatId
  ) {
    fail(
      'source_coverage_active_snapshot_stale',
      'The active Static Lore snapshot does not match the ledger.',
    );
  }
  const trustedSource = trustedSnapshot.sources?.find(candidate => (
    candidate?.source_id === source.source_id
  ));
  if (
    !trustedSource
    || trustedSource.source_kind !== source.source_kind
    || sha256(canonicalJson(trustedSource.data)) !== source.source_hash
  ) {
    fail(
      'source_coverage_source_unit_stale',
      'The active Static Lore source does not match the ledger.',
    );
  }
  const trustedSourceUnit = buildStaticLoreSourceUnits({
    snapshotId: snapshot.snapshot_id,
    sources: trustedSnapshot.sources,
  }).find(unit => unit.ref === sourceUnitRef);
  if (
    trustedSourceUnit
    && (
      trustedSourceUnit.source_id !== source.source_id
      || trustedSourceUnit.source_kind !== source.source_kind
    )
  ) {
    fail(
      'source_coverage_source_unit_stale',
      'The source unit does not match the active snapshot.',
    );
  }
  return {
    opened,
    snapshot: {
      snapshot_id: snapshot.snapshot_id,
      snapshot_hash: snapshot.aggregate_hash,
    },
    source: { ...source },
    projection: {
      projection_id: projection.projection_id,
      projection_hash: projection.source_version_hash,
    },
    runtimeWorld,
    runtimeViewHash,
    trustedSourceUnit,
  };
}

function matchingRuntimeParts(runtimeWorld, memoryRef, sourceRef) {
  const handle = (runtimeWorld.retrieval_handles ?? []).find(candidate => (
    candidate?.entity_ref === memoryRef
    && Array.isArray(candidate.source_refs)
    && candidate.source_refs.includes(sourceRef)
  ));
  if (!handle) {
    fail(
      'source_coverage_runtime_handle_missing',
      'No Runtime World handle covers the required evidence span.',
      { memory_ref: memoryRef, source_ref: sourceRef },
    );
  }
  const manifest = (runtimeWorld.static_baseline_manifest ?? []).find(
    candidate => candidate?.entity_ref === memoryRef,
  );
  if (!manifest) {
    fail(
      'source_coverage_runtime_lineage_missing',
      'The Runtime World handle has no baseline manifest lineage.',
      { memory_ref: memoryRef },
    );
  }
  return { handle, manifest };
}

function assertAcceptedTarget(span, context) {
  const target = span?.accepted_target;
  if (
    !target
    || typeof target !== 'object'
    || Array.isArray(target)
    || canonicalJson(Object.keys(target).sort())
      !== canonicalJson(ACCEPTED_TARGET_FIELDS)
    || target.entity_ref !== span.memory_ref
    || !OKF_ENTITY_REF.test(target.entity_ref ?? '')
    || !ACCEPTED_CLAIM_FIELD_PATH.test(target.field_path ?? '')
    || typeof target.claim_kind !== 'string'
    || !/^[a-z][a-z0-9_]*$/.test(target.claim_kind)
    || typeof target.canonical_claim !== 'string'
    || !target.canonical_claim.trim()
    || !/^[a-f0-9]{64}$/.test(target.claim_hash ?? '')
    || !/^[a-f0-9]{64}$/.test(target.okf_version_hash ?? '')
    || !/^[a-f0-9]{64}$/.test(target.semantic_acceptance_hash ?? '')
    || span.record_kind !== 'okf_baseline_claim'
    || typeof span.evidence_mode !== 'string'
    || !span.evidence_mode.trim()
    || !/^[a-f0-9]{64}$/.test(span.evidence_quote_hash ?? '')
    || !/^[a-f0-9]{64}$/.test(span.model_artifact_hash ?? '')
  ) {
    fail(
      'source_coverage_accepted_target_invalid',
      'Covered evidence must identify one exact accepted Imported Baseline Claim.',
      { evidence_id: span?.evidence_id ?? null },
    );
  }
  const recomputedClaimHash = acceptedClaimHash({
    claimKind: target.claim_kind,
    canonicalClaim: target.canonical_claim,
  });
  if (recomputedClaimHash !== target.claim_hash) {
    fail(
      'source_coverage_claim_hash_mismatch',
      'The accepted Imported Baseline Claim hash does not match its canonical claim.',
      { evidence_id: span.evidence_id },
    );
  }
  const expectedQuery = acceptedClaimSearchQuery(target.canonical_claim);
  if (
    span.search_query !== expectedQuery
    || !expectedQuery
    || AUTHOR_SOURCE_REF.test(expectedQuery)
  ) {
    fail(
      'source_coverage_search_query_invalid',
      'Coverage search must be derived from the accepted Imported Baseline Claim body.',
      { evidence_id: span.evidence_id },
    );
  }
  const recomputedAcceptanceHash = semanticAcceptanceHash({
    snapshotId: context.snapshot.snapshot_id,
    sourceUnitRef: span.source_ref,
    evidenceId: span.evidence_id,
    evidenceMode: span.evidence_mode,
    evidenceQuoteHash: span.evidence_quote_hash,
    modelArtifactHash: span.model_artifact_hash,
    runtimeViewHash: context.runtimeViewHash,
    acceptedTarget: target,
  });
  if (
    target.semantic_acceptance_hash !== recomputedAcceptanceHash
    || span.evidence_hash !== recomputedAcceptanceHash
  ) {
    fail(
      'source_coverage_semantic_acceptance_mismatch',
      'The accepted Imported Baseline Claim is not bound to this snapshot evidence and artifact.',
      { evidence_id: span.evidence_id },
    );
  }
  return target;
}

function assertLocalControlTarget(span, context) {
  const target = span?.local_control_target;
  const text = String(
    sourceUnitText(context.trustedSourceUnit),
  ).replace(/\r\n?/g, '\n');
  const hasSourceRange = (
    Number.isInteger(span?.source_start)
    && Number.isInteger(span?.source_end)
    && span.source_start >= 0
    && span.source_end > span.source_start
    && span.source_end <= text.length
  );
  const localQuote = hasSourceRange
    ? text.slice(span.source_start, span.source_end)
    : null;
  const classification = target?.control_kind === 'display_control_marker'
    ? classifyStaticLoreControlUnit(context.trustedSourceUnit)
    : (
      hasSourceRange
        ? (
          classifyStaticLoreStructuralEvidenceSpan({
            unit: context.trustedSourceUnit,
            quote: localQuote,
            sourceStart: span.source_start,
          })
          ?? classifyStaticLoreListMarkerEvidenceSpan({
            unit: context.trustedSourceUnit,
            quote: localQuote,
            sourceStart: span.source_start,
          })
        )
        : null
    );
  if (
    span?.record_kind !== STATIC_LORE_CONTROL_RECORD_KIND
    || span.disposition !== STATIC_LORE_CONTROL_DISPOSITION
    || !target
    || typeof target !== 'object'
    || Array.isArray(target)
    || canonicalJson(Object.keys(target).sort())
      !== canonicalJson(LOCAL_CONTROL_TARGET_FIELDS)
    || !classification
    || typeof span.evidence_mode !== 'string'
    || !span.evidence_mode.trim()
    || !/^[a-f0-9]{64}$/.test(span.evidence_quote_hash ?? '')
    || !/^[a-f0-9]{64}$/.test(span.model_artifact_hash ?? '')
    || (
      target?.control_kind === 'display_control_marker'
        ? span.evidence_quote_hash !== classification?.marker_hash
        : sha256(localQuote ?? '') !== span.evidence_quote_hash
    )
  ) {
    fail(
      'source_coverage_local_control_invalid',
      'Locally classified control evidence does not match the active source unit.',
      { evidence_id: span?.evidence_id ?? null },
    );
  }
  const expectedTarget = staticLoreControlTarget(classification);
  const targetWithoutAcceptance = {
    control_kind: target.control_kind,
    source_kind: target.source_kind,
    unit_id: target.unit_id,
    marker_hash: target.marker_hash,
    classification_hash: target.classification_hash,
  };
  if (
    canonicalJson(targetWithoutAcceptance)
      !== canonicalJson(expectedTarget)
  ) {
    fail(
      'source_coverage_local_control_invalid',
      'The local control classification no longer matches the active source.',
      { evidence_id: span.evidence_id },
    );
  }
  const localAcceptanceHash = staticLoreControlAcceptanceHash({
    snapshotId: context.snapshot.snapshot_id,
    sourceUnitRef: span.source_ref,
    evidenceId: span.evidence_id,
    evidenceMode: span.evidence_mode,
    evidenceQuoteHash: span.evidence_quote_hash,
    modelArtifactHash: span.model_artifact_hash,
    runtimeViewHash: context.runtimeViewHash,
    controlTarget: expectedTarget,
  });
  if (
    target.local_acceptance_hash !== localAcceptanceHash
    || span.evidence_hash !== localAcceptanceHash
  ) {
    fail(
      'source_coverage_local_control_acceptance_mismatch',
      'The local control classification is not bound to this snapshot and artifact.',
      { evidence_id: span.evidence_id },
    );
  }
  return {
    evidence_id: span.evidence_id,
    source_ref: span.source_ref,
    evidence_hash: span.evidence_hash,
    record_kind: span.record_kind,
    disposition: STATIC_LORE_CONTROL_DISPOSITION,
    evidence_mode: span.evidence_mode,
    evidence_quote_hash: span.evidence_quote_hash,
    model_artifact_hash: span.model_artifact_hash,
    ...(hasSourceRange
      ? {
        source_start: span.source_start,
        source_end: span.source_end,
      }
      : {}),
    local_control_target: structuredClone(target),
  };
}

function importedBaselineClaimLines(content) {
  if (typeof content !== 'string') return [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const headerIndex = lines.findIndex(
    line => line.trim() === '# Imported Baseline Claims',
  );
  if (headerIndex < 0) return [];
  const claims = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*#{1,6}\s+/u.test(lines[index])) break;
    if (lines[index].startsWith('- `')) claims.push(lines[index]);
  }
  return claims;
}

function assertExactAcceptedClaim(content, target, evidenceId) {
  const match = ACCEPTED_CLAIM_FIELD_PATH.exec(target.field_path);
  const claimIndex = Number(match?.[1]);
  const expectedLine = acceptedClaimLine({
    claimKind: target.claim_kind,
    canonicalClaim: target.canonical_claim,
  });
  if (
    !Number.isSafeInteger(claimIndex)
    || importedBaselineClaimLines(content)[claimIndex] !== expectedLine
  ) {
    fail(
      'source_coverage_accepted_claim_missing',
      'Runtime memory does not contain the exact accepted Imported Baseline Claim line.',
      { evidence_id: evidenceId, field_path: target.field_path },
    );
  }
}

async function smokeRuntimeMemory({
  memoryReader,
  chatId,
  readScope,
  context,
  span,
}) {
  const target = assertAcceptedTarget(span, context);
  if (!RUNTIME_MEMORY_REF.test(span.memory_ref ?? '')) {
    fail(
      'source_coverage_memory_ref_invalid',
      'Coverage reads may target only runtime memory references.',
      { memory_ref: span.memory_ref ?? null },
    );
  }
  if (
    typeof span.search_query !== 'string'
    || !span.search_query.trim()
    || AUTHOR_SOURCE_REF.test(span.search_query.trim())
  ) {
    fail(
      'source_coverage_search_query_invalid',
      'Coverage search smoke requires a semantic query, not an author-source ref.',
      { evidence_id: span.evidence_id },
    );
  }
  const { handle, manifest } = matchingRuntimeParts(
    context.runtimeWorld,
    span.memory_ref,
    span.source_ref,
  );
  if (searchQueryUsesOnlyRuntimeIdentity({
    query: span.search_query,
    title: handle.title,
    entityRef: handle.entity_ref,
  })) {
    fail(
      'source_coverage_search_query_invalid',
      'Coverage search cannot be satisfied by a title or runtime identity alone.',
      { evidence_id: span.evidence_id },
    );
  }
  if (
    manifest.version_hash !== target.okf_version_hash
    || !Array.isArray(manifest.claim_hashes)
    || !manifest.claim_hashes.includes(target.claim_hash)
  ) {
    fail(
      'source_coverage_runtime_claim_missing',
      'The Runtime World manifest does not contain the accepted Imported Baseline Claim hash.',
      {
        memory_ref: span.memory_ref,
        claim_hash: target.claim_hash,
      },
    );
  }
  let search;
  try {
    search = await memoryReader.search({
      chatId,
      query: span.search_query,
      branchId: readScope.branch_id,
      branchEpoch: readScope.branch_epoch,
      turnIndex: readScope.turn_index,
      limit: 8,
    });
  } catch (error) {
    fail(
      'source_coverage_memory_search_failed',
      'The runtime memory search smoke test failed.',
      { evidence_id: span.evidence_id, cause: error.reasonCode ?? error.message },
    );
  }
  const searchHit = search?.schema === 'mnemosyne.memory-search-result.v2'
    && search.status === 'ready'
    && Array.isArray(search.results)
    ? search.results.find(result => result?.ref === span.memory_ref)
    : null;
  if (!searchHit) {
    fail(
      'source_coverage_memory_search_miss',
      'Memory search could not rediscover the covered runtime record.',
      { memory_ref: span.memory_ref },
    );
  }
  let read;
  try {
    read = await memoryReader.read({
      chatId,
      ref: span.memory_ref,
      branchId: readScope.branch_id,
      branchEpoch: readScope.branch_epoch,
      turnIndex: readScope.turn_index,
    });
  } catch (error) {
    fail(
      'source_coverage_memory_read_failed',
      'The runtime memory read smoke test failed.',
      { memory_ref: span.memory_ref, cause: error.reasonCode ?? error.message },
    );
  }
  if (
    read?.schema !== 'mnemosyne.memory-read-result.v2'
    || read.status !== 'ready'
    || read.ref !== span.memory_ref
    || read.memory?.ref !== span.memory_ref
  ) {
    fail(
      'source_coverage_memory_unavailable',
      'The required runtime memory is not readable.',
      { memory_ref: span.memory_ref },
    );
  }
  const memory = read.memory;
  assertExactAcceptedClaim(
    memory.content,
    target,
    span.evidence_id,
  );
  const content = factBearingContent(memory.content, memory.title ?? handle.title);
  if (!content) {
    fail(
      'source_coverage_runtime_content_not_fact_bearing',
      'A title-only runtime handle cannot replace author-source facts.',
      { memory_ref: span.memory_ref },
    );
  }
  if (
    !Array.isArray(memory.source_refs)
    || !memory.source_refs.includes(span.source_ref)
  ) {
    fail(
      'source_coverage_source_lineage_mismatch',
      'The runtime memory does not cite the required evidence span.',
      { memory_ref: span.memory_ref, source_ref: span.source_ref },
    );
  }
  if (
    typeof searchHit.snippet !== 'string'
    || !searchHit.snippet.trim()
    || ![
      'directory_summary',
      'content_excerpt',
      'turn_summary',
    ].includes(searchHit.snippet_kind)
    || Object.hasOwn(searchHit, 'content')
    || Object.hasOwn(searchHit, 'source_refs')
    || searchHit.source_count !== memory.source_refs.length
    || canonicalJson(searchHit.lineage) !== canonicalJson(memory.lineage)
  ) {
    fail(
      'source_coverage_search_read_mismatch',
      'Memory search and read do not expose the same active runtime record.',
      { memory_ref: span.memory_ref },
    );
  }
  if (
    memory.lineage?.status !== 'active'
    || memory.lineage.snapshot_id !== context.snapshot.snapshot_id
    || memory.lineage.version_hash !== manifest.version_hash
    || memory.lineage.relative_path !== String(manifest.path ?? '').replace(/^\//, '')
    || String(handle.path ?? '').replace(/^\//, '')
      !== String(manifest.path ?? '').replace(/^\//, '')
  ) {
    fail(
      'source_coverage_runtime_lineage_stale',
      'The runtime memory lineage does not match the active projection.',
      { memory_ref: span.memory_ref },
    );
  }
  const runtimeContent = {
    ref: memory.ref,
    content: memory.content,
    source_refs: [...memory.source_refs].sort(),
  };
  const searchResult = {
    ref: searchHit.ref,
    snippet: searchHit.snippet,
    snippet_kind: searchHit.snippet_kind,
    source_count: searchHit.source_count,
    lineage: searchHit.lineage,
  };
  return {
    evidence_id: span.evidence_id,
    source_ref: span.source_ref,
    evidence_hash: span.evidence_hash,
    record_kind: span.record_kind,
    disposition: 'covered',
    memory_ref: span.memory_ref,
    search_query: span.search_query,
    evidence_mode: span.evidence_mode,
    evidence_quote_hash: span.evidence_quote_hash,
    model_artifact_hash: span.model_artifact_hash,
    accepted_target: structuredClone(target),
    search_result_hash: sha256(canonicalJson(searchResult)),
    runtime_content_hash: sha256(canonicalJson(runtimeContent)),
    lineage_hash: sha256(canonicalJson(memory.lineage)),
  };
}

function validateSpans(sourceUnit, context) {
  const spans = sourceUnit?.required_evidence_spans;
  if (
    !sourceRefBelongsToUnit(
      sourceUnit?.source_unit_ref,
      context.snapshot.snapshot_id,
      context.source.source_id,
      context.source.source_kind,
    )
  ) {
    fail(
      'source_coverage_source_unit_ref_invalid',
      'The source-unit ref does not belong to the active source snapshot.',
    );
  }
  if (!Array.isArray(spans) || spans.length === 0) {
    fail(
      'source_coverage_evidence_missing',
      'A source unit requires at least one evidence span disposition.',
    );
  }
  const evidenceIds = new Set();
  for (const span of spans) {
    if (
      typeof span?.evidence_id !== 'string'
      || !span.evidence_id.trim()
      || evidenceIds.has(span.evidence_id)
    ) {
      fail(
        'source_coverage_evidence_id_invalid',
        'Evidence span ids must be non-empty and unique.',
      );
    }
    evidenceIds.add(span.evidence_id);
    if (
      !/^[a-f0-9]{64}$/.test(span.evidence_hash ?? '')
      || typeof span.record_kind !== 'string'
      || !span.record_kind.trim()
    ) {
      fail(
        'source_coverage_evidence_identity_invalid',
        'Every evidence span requires a stable hash and runtime record kind.',
        { evidence_id: span.evidence_id },
      );
    }
    if (!sourceRefBelongsToUnit(
      span.source_ref,
      context.snapshot.snapshot_id,
      context.source.source_id,
      context.source.source_kind,
    ) || span.source_ref !== sourceUnit.source_unit_ref) {
      fail(
        'source_coverage_evidence_source_mismatch',
        'An evidence span does not belong to the active source unit.',
        { evidence_id: span.evidence_id },
      );
    }
    if (span.disposition === 'unresolved' || span.disposition === 'omitted') {
      fail(
        `source_coverage_${span.disposition}_span`,
        'Unresolved or omitted evidence cannot be certified for removal.',
        { evidence_id: span.evidence_id },
      );
    }
    if (![
      'covered',
      'retained_non_runtime',
      STATIC_LORE_CONTROL_DISPOSITION,
    ].includes(span.disposition)) {
      fail(
        'source_coverage_disposition_invalid',
        'Every evidence span requires a runtime or retained disposition.',
        { evidence_id: span.evidence_id },
      );
    }
    if (
      span.disposition === 'retained_non_runtime'
      && (
        typeof span.retention_reason !== 'string'
        || !span.retention_reason.trim()
      )
    ) {
      fail(
        'source_coverage_retention_reason_missing',
        'Retained non-runtime evidence requires an explicit reason.',
        { evidence_id: span.evidence_id },
      );
    }
    if (span.disposition === 'covered') {
      assertAcceptedTarget(span, context);
    }
    if (span.disposition === STATIC_LORE_CONTROL_DISPOSITION) {
      assertLocalControlTarget(span, context);
    }
  }
  return spans;
}

function certificateId(certificateWithoutId) {
  return `coverage_${sha256(canonicalJson(certificateWithoutId)).slice(0, 24)}`;
}

function rejected(certificate, reasonCode) {
  return {
    schema: VERIFICATION_SCHEMA,
    status: 'rejected',
    certificate_id: certificate?.certificate_id ?? null,
    reason_code: reasonCode,
  };
}

export function createSourceCoverageGate({
  store,
  memoryReader = null,
  now = () => new Date(),
} = {}) {
  if (!store?.openChatForAdmin) {
    throw new Error('Source Coverage Gate requires a trusted chat-save store.');
  }

  async function createCertificate({
    chatId,
    sourceUnit,
    readScope,
  } = {}) {
    const readerCapabilityVersion = currentReaderVersion(memoryReader);
    assertReadScope(readScope);
    if (typeof sourceUnit?.source_id !== 'string' || !sourceUnit.source_id) {
      fail(
        'source_coverage_source_unit_invalid',
        'A source unit id is required.',
      );
    }
    const context = await loadActiveContext({
      store,
      chatId,
      sourceId: sourceUnit.source_id,
      sourceUnitRef: sourceUnit.source_unit_ref,
    });
    if (!context.trustedSourceUnit) {
      fail(
        'source_coverage_source_unit_missing',
        'The source unit is not part of the active snapshot.',
      );
    }
    const spans = validateSpans(sourceUnit, context);
    const coverage = [];
    for (const span of spans) {
      if (span.disposition === 'retained_non_runtime') {
        coverage.push({
          evidence_id: span.evidence_id,
          source_ref: span.source_ref,
          evidence_hash: span.evidence_hash,
          record_kind: span.record_kind,
          disposition: 'retained_non_runtime',
          retention_reason: span.retention_reason.trim(),
        });
        continue;
      }
      if (span.disposition === STATIC_LORE_CONTROL_DISPOSITION) {
        coverage.push(assertLocalControlTarget(span, context));
        continue;
      }
      coverage.push(await smokeRuntimeMemory({
        memoryReader,
        chatId,
        readScope,
        context,
        span,
      }));
    }
    const runtimeContentHash = sha256(canonicalJson(
      coverage
        .filter(item => item.disposition === 'covered')
        .map(item => ({
          evidence_id: item.evidence_id,
          search_result_hash: item.search_result_hash,
          runtime_content_hash: item.runtime_content_hash,
          lineage_hash: item.lineage_hash,
          semantic_acceptance_hash:
            item.accepted_target?.semantic_acceptance_hash,
        })),
    ));
    const coveredSpanCount = coverage.filter(
      item => item.disposition === 'covered',
    ).length;
    const classifiedNonStorySpanCount = coverage.filter(
      item => item.disposition === STATIC_LORE_CONTROL_DISPOSITION,
    ).length;
    const retainedSpanCount =
      coverage.length
      - coveredSpanCount
      - classifiedNonStorySpanCount;
    const certificate = {
      schema: CERTIFICATE_SCHEMA,
      status: 'ready',
      chat_id: chatId,
      source_unit: {
        source_id: context.source.source_id,
        source_kind: context.source.source_kind,
        source_hash: context.source.source_hash,
        source_unit_ref: sourceUnit.source_unit_ref,
        source_unit_hash: sha256(canonicalJson({
          source_id: context.source.source_id,
          source_hash: context.source.source_hash,
          source_unit_ref: sourceUnit.source_unit_ref,
        })),
      },
      snapshot_id: context.snapshot.snapshot_id,
      snapshot_hash: context.snapshot.snapshot_hash,
      projection_id: context.projection.projection_id,
      projection_hash: context.projection.projection_hash,
      runtime_view_hash: context.runtimeViewHash,
      reader_capability_version: readerCapabilityVersion,
      runtime_content_hash: runtimeContentHash,
      coverage_ready: retainedSpanCount === 0,
      structural_coverage: {
        status: 'passed',
        required_span_count: spans.length,
        dispositioned_span_count: coverage.length,
        covered_span_count: coveredSpanCount,
        classified_non_story_span_count:
          classifiedNonStorySpanCount,
        retained_non_runtime_span_count: retainedSpanCount,
      },
      semantic_coverage: {
        status: 'passed',
        search_smoke_count: coveredSpanCount,
        read_smoke_count: coveredSpanCount,
        local_classification_count: classifiedNonStorySpanCount,
      },
      read_scope: structuredClone(readScope),
      coverage,
      issued_at: now().toISOString(),
    };
    return Object.freeze({
      ...certificate,
      certificate_id: certificateId(certificate),
    });
  }

  async function verifyCertificate(certificate) {
    try {
      if (
        certificate?.schema !== CERTIFICATE_SCHEMA
        || certificate.status !== 'ready'
        || certificate.certificate_id !== certificateId(
          Object.fromEntries(
            Object.entries(certificate)
              .filter(([key]) => key !== 'certificate_id'),
          ),
        )
      ) {
        return rejected(
          certificate,
          'source_coverage_certificate_integrity_mismatch',
        );
      }
      const readerCapabilityVersion = currentReaderVersion(memoryReader);
      if (readerCapabilityVersion !== certificate.reader_capability_version) {
        return rejected(
          certificate,
          'source_coverage_reader_version_stale',
        );
      }
      assertReadScope(certificate.read_scope);
      const context = await loadActiveContext({
        store,
        chatId: certificate.chat_id,
        sourceId: certificate.source_unit?.source_id,
        sourceUnitRef: certificate.source_unit?.source_unit_ref,
      });
      if (
        context.snapshot.snapshot_id !== certificate.snapshot_id
        || context.snapshot.snapshot_hash !== certificate.snapshot_hash
      ) {
        return rejected(certificate, 'source_coverage_snapshot_stale');
      }
      if (
        context.source.source_kind !== certificate.source_unit.source_kind
        || context.source.source_hash !== certificate.source_unit.source_hash
      ) {
        return rejected(certificate, 'source_coverage_source_unit_stale');
      }
      if (
        context.projection.projection_id !== certificate.projection_id
        || context.projection.projection_hash !== certificate.projection_hash
        || context.runtimeViewHash !== certificate.runtime_view_hash
      ) {
        return rejected(certificate, 'source_coverage_projection_stale');
      }
      if (!context.trustedSourceUnit) {
        return rejected(certificate, 'source_coverage_source_unit_stale');
      }
      const runtimeCoverage = [];
      for (const item of certificate.coverage) {
        if (item.disposition === 'retained_non_runtime') continue;
        if (item.disposition === STATIC_LORE_CONTROL_DISPOSITION) {
          assertLocalControlTarget(item, context);
          continue;
        }
        const current = await smokeRuntimeMemory({
          memoryReader,
          chatId: certificate.chat_id,
          readScope: certificate.read_scope,
          context,
          span: item,
        });
        if (
          current.search_result_hash !== item.search_result_hash
          || current.runtime_content_hash !== item.runtime_content_hash
          || current.lineage_hash !== item.lineage_hash
        ) {
          return rejected(certificate, 'source_coverage_runtime_content_stale');
        }
        runtimeCoverage.push(current);
      }
      const runtimeContentHash = sha256(canonicalJson(
        runtimeCoverage.map(item => ({
          evidence_id: item.evidence_id,
          search_result_hash: item.search_result_hash,
          runtime_content_hash: item.runtime_content_hash,
          lineage_hash: item.lineage_hash,
          semantic_acceptance_hash:
            item.accepted_target?.semantic_acceptance_hash,
        })),
      ));
      if (runtimeContentHash !== certificate.runtime_content_hash) {
        return rejected(certificate, 'source_coverage_runtime_content_stale');
      }
      return {
        schema: VERIFICATION_SCHEMA,
        status: 'verified',
        certificate_id: certificate.certificate_id,
        reason_code: null,
      };
    } catch (error) {
      if (error instanceof MnemosyneRequestError) {
        return rejected(certificate, error.reasonCode);
      }
      return rejected(certificate, 'source_coverage_verification_failed');
    }
  }

  return Object.freeze({
    createCertificate,
    verifyCertificate,
  });
}
