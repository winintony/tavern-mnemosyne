import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  createStaticLoreAggregate,
  mergeStaticLoreBatch,
} from '../intake/static-lore-batch.js';
import { resolveStaticLoreEvidenceSpans } from '../intake/static-lore-evidence.js';
import {
  harnessStaticLoreBatchEvidence,
} from '../intake/static-lore-evidence-harness.js';
import {
  buildStaticLoreSourceUnits,
} from '../intake/static-lore-source-units.js';
import {
  STATIC_LORE_CONTROL_DISPOSITION,
  STATIC_LORE_CONTROL_RECORD_KIND,
  staticLoreControlAcceptanceHash,
  staticLoreControlTarget,
} from '../intake/static-lore-control-units.js';
import {
  INTAKE_CONTRACT_REVISION,
  SOURCE_PARTITION_REVISION,
} from '../intake/static-lore-intake-revisions.js';
import {
  parseStaticLoreToolArguments,
} from '../intake/static-lore-model-response.js';
import {
  rebuildStaticLoreSourceUnitLedger,
  settleStaticLoreSourceUnits,
  staticLoreArtifactSettlementTime,
  terminalSourceUnitLedgerEntry,
} from '../intake/static-lore-unit-settlement.js';
import {
  staticLoreSnapshotHash,
} from '../intake/static-lore-source-identity.js';
import {
  acceptedClaimFieldPath,
  acceptedClaimHash,
  acceptedClaimSearchQuery,
  searchQueryUsesOnlyRuntimeIdentity,
  semanticAcceptanceHash,
} from './accepted-target-evidence.js';

const MANIFEST_SCHEMA = 'mnemosyne.source-unit-coverage-manifest.v1';
const SESSION_SCHEMA = 'mnemosyne.static-lore-intake-session.v1';
const ARTIFACT_SCHEMA = 'mnemosyne.static-lore-model-artifact.v1';
const EXTRACTION_SCHEMA = 'mnemosyne.static-lore-extraction.v1';
// A completed session is only interpretable by the revisions that minted it:
// migration invalidates every superseded artifact and rebases the session onto
// the current partition, so anything not pinned to the current revision has
// batch boundaries this gate can no longer verify. Exact match, never a floor.
export const REQUIRED_CONTRACT_REVISION = INTAKE_CONTRACT_REVISION;
export const REQUIRED_PARTITION_REVISION = SOURCE_PARTITION_REVISION;

function fail(reasonCode, message, details = undefined) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function integrityFailure(message, details = undefined) {
  fail(
    'source_coverage_paid_intake_integrity_failed',
    message,
    details,
  );
}

function sourceUnitText(unit) {
  if (typeof unit?.data === 'string') return unit.data;
  if (typeof unit?.data?.content === 'string') return unit.data.content;
  return JSON.stringify(unit?.data ?? null);
}

function normalizedText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function sourcePacket({
  snapshotId,
  snapshotHash,
  sources,
}) {
  return {
    schema: 'mnemosyne.static-lore-source-packet.v1',
    snapshot_id: snapshotId,
    snapshot_hash: snapshotHash,
    units: buildStaticLoreSourceUnits({
      snapshotId,
      sources,
    }),
  };
}

function portableBatchHash(batch) {
  return sha256(canonicalJson((batch?.units ?? []).map(unit => ({
    source_index: unit.source_index,
    source_id: unit.source_id,
    source_kind: unit.source_kind,
    unit_id: unit.unit_id,
    data: unit.data,
  }))));
}

function parseExtraction(modelResponse) {
  if (modelResponse?.choices?.[0]?.finish_reason === 'length') {
    integrityFailure('A paid intake artifact contains truncated output.');
  }
  const toolCalls = modelResponse?.choices?.[0]?.message?.tool_calls;
  if (
    !Array.isArray(toolCalls)
    || toolCalls.length !== 1
    || toolCalls[0]?.function?.name !== 'static_lore_return'
  ) {
    integrityFailure(
      'A paid intake artifact does not contain the required extraction call.',
    );
  }
  let extraction;
  try {
    extraction = parseStaticLoreToolArguments(
      toolCalls[0].function.arguments,
    );
  } catch (error) {
    integrityFailure(
      'A paid intake artifact contains invalid tool arguments.',
      { cause: error.message },
    );
  }
  if (extraction?.schema !== EXTRACTION_SCHEMA) {
    integrityFailure('A paid intake artifact has an unsupported schema.');
  }
  return extraction;
}

function extractionForTarget({
  artifact,
  extraction,
  session,
  batch,
}) {
  const rebased = artifact.request_metadata?.rebased_from;
  if (!rebased) {
    if (extraction.snapshot_hash !== session.snapshot_hash) {
      integrityFailure(
        'A paid intake artifact belongs to another snapshot.',
      );
    }
    return extraction;
  }
  if (
    rebased.schema !== 'mnemosyne.static-lore-artifact-rebase.v1'
    || rebased.target_snapshot_hash !== session.snapshot_hash
    || rebased.source_response_hash !== artifact.response_hash
    || rebased.model_snapshot_hash !== extraction.snapshot_hash
    || rebased.portable_batch_hash !== portableBatchHash(batch)
    || typeof rebased.source_request_id !== 'string'
    || !rebased.source_request_id
    || typeof rebased.source_snapshot_id !== 'string'
    || !rebased.source_snapshot_id
    || !/^[a-f0-9]{64}$/.test(rebased.source_snapshot_hash ?? '')
  ) {
    integrityFailure(
      'A rebased paid intake artifact has invalid provenance.',
    );
  }
  return {
    ...structuredClone(extraction),
    snapshot_hash: session.snapshot_hash,
  };
}

async function assertRebaseOrigin({
  store,
  chatId,
  artifact,
}) {
  const rebased = artifact.request_metadata?.rebased_from;
  if (!rebased) return;
  let sourceSession;
  try {
    sourceSession = await store.readIntakeSessionForAdmin({
      chatId,
      snapshotId: rebased.source_snapshot_id,
    });
  } catch (error) {
    integrityFailure(
      'A rebased paid artifact origin session is unavailable.',
      { cause: error.code ?? error.message },
    );
  }
  const sourceRecord = sourceSession?.artifacts?.find(record => (
    record.request_id === rebased.source_request_id
  ));
  const sourceBatch = sourceSession?.batches?.[
    sourceRecord?.batch_index
  ];
  if (
    sourceSession?.schema !== SESSION_SCHEMA
    || sourceSession.snapshot_id !== rebased.source_snapshot_id
    || sourceSession.snapshot_hash !== rebased.source_snapshot_hash
    || !sourceRecord
    || !sourceBatch
    || sourceRecord.response_hash !== rebased.source_response_hash
    || portableBatchHash(sourceBatch) !== rebased.portable_batch_hash
  ) {
    integrityFailure(
      'A rebased paid artifact has no valid persisted origin.',
    );
  }
  let sourceArtifact;
  try {
    sourceArtifact = await store.readIntakeArtifactForAdmin({
      chatId,
      requestId: rebased.source_request_id,
    });
  } catch (error) {
    integrityFailure(
      'A rebased paid artifact origin is unavailable.',
      { cause: error.code ?? error.message },
    );
  }
  if (
    sourceArtifact?.schema !== ARTIFACT_SCHEMA
    || sourceArtifact.request_id !== rebased.source_request_id
    || sourceArtifact.response_hash !== rebased.source_response_hash
    || sha256(canonicalJson(sourceArtifact.model_response))
      !== rebased.source_response_hash
    || canonicalJson(sourceArtifact.model_response)
      !== canonicalJson(artifact.model_response)
    || sourceArtifact.request_metadata?.chat_id !== chatId
    || sourceArtifact.request_metadata?.snapshot_id
      !== rebased.source_snapshot_id
    || sourceArtifact.request_metadata?.snapshot_hash
      !== rebased.source_snapshot_hash
    || sourceArtifact.request_metadata?.session_id
      !== sourceSession.session_id
    || sourceArtifact.request_metadata?.batch_index
      !== sourceRecord.batch_index
  ) {
    integrityFailure(
      'A rebased paid artifact origin failed integrity validation.',
    );
  }
}

function batchUnitsWithoutIndexes(batch) {
  return (batch?.units ?? []).map(unit => {
    const {
      source_index: _sourceIndex,
      ...sourceUnit
    } = unit;
    return sourceUnit;
  });
}

function assertSessionBatches(session, packet) {
  if (
    session.source_packet_hash !== sha256(canonicalJson(packet))
    || session.source_unit_count !== packet.units.length
    || !Array.isArray(session.batches)
    || session.batches.length === 0
  ) {
    integrityFailure(
      'The completed intake session no longer matches its source packet.',
    );
  }
  const flattened = [];
  for (const [batchIndex, batch] of session.batches.entries()) {
    if (
      batch?.schema !== 'mnemosyne.static-lore-source-batch.v1'
      || batch.snapshot_id !== session.snapshot_id
      || batch.snapshot_hash !== session.snapshot_hash
      || batch.batch_index !== batchIndex
      || batch.batch_count !== session.batches.length
      || !Array.isArray(batch.units)
      || batch.units.length === 0
      || batch.units.some((unit, sourceIndex) => (
        unit.source_index !== sourceIndex
      ))
    ) {
      integrityFailure(
        'The completed intake session has an invalid batch partition.',
        { batch_index: batchIndex },
      );
    }
    flattened.push(...batchUnitsWithoutIndexes(batch));
  }
  const expectedByRef = new Map(
    packet.units.map(unit => [unit.ref, unit]),
  );
  const actualByRef = new Map(
    flattened.map(unit => [unit.ref, unit]),
  );
  if (
    actualByRef.size !== flattened.length
    || actualByRef.size !== expectedByRef.size
  ) {
    integrityFailure(
      'The completed intake session does not cover each source unit once.',
    );
  }
  for (const [ref, expected] of expectedByRef) {
    if (canonicalJson(actualByRef.get(ref)) !== canonicalJson(expected)) {
      integrityFailure(
        'A persisted intake source unit no longer matches the snapshot.',
        { source_unit_ref: ref },
      );
    }
  }
}

function assertSessionReady(session, {
  chatId,
  snapshot,
}) {
  if (
    session?.schema !== SESSION_SCHEMA
    || session.status !== 'completed'
    || session.chat_id !== chatId
    || session.snapshot_id !== snapshot.snapshot_id
    || session.snapshot_hash !== snapshot.snapshot_hash
    || session.contract_revision !== REQUIRED_CONTRACT_REVISION
    || session.partition_revision !== REQUIRED_PARTITION_REVISION
    || session.next_batch_index !== session.batches?.length
    || session.artifacts?.length !== session.batches?.length
    || session.result?.status !== 'ready'
    || session.result.snapshot_id !== snapshot.snapshot_id
  ) {
    return false;
  }
  return true;
}

function validatedSourceUnitLedger(session, expectedEntries) {
  if (session.source_unit_ledger === undefined) {
    return expectedEntries;
  }
  if (
    !Array.isArray(session.source_unit_ledger)
    || session.source_unit_ledger.length !== expectedEntries.length
  ) {
    integrityFailure(
      'The completed intake session is missing its source-unit ledger.',
    );
  }
  const actualByRef = new Map(
    session.source_unit_ledger.map(entry => [
      entry.source_unit_ref,
      entry,
    ]),
  );
  if (actualByRef.size !== session.source_unit_ledger.length) {
    integrityFailure(
      'The completed intake session has duplicate source-unit ledger entries.',
    );
  }
  for (const expected of expectedEntries) {
    const actual = actualByRef.get(expected.source_unit_ref);
    if (
      !terminalSourceUnitLedgerEntry(actual)
      || canonicalJson({
        ...actual,
        settled_at: undefined,
      }) !== canonicalJson({
        ...expected,
        settled_at: undefined,
      })
    ) {
      integrityFailure(
        'The completed intake source-unit ledger failed revalidation.',
        { source_unit_ref: expected.source_unit_ref },
      );
    }
  }
  return session.source_unit_ledger;
}

function artifactRecordByBatch(session) {
  const records = new Map();
  for (const record of session.artifacts ?? []) {
    if (
      !Number.isInteger(record?.batch_index)
      || records.has(record.batch_index)
      || typeof record.request_id !== 'string'
      || !record.request_id
      || !/^[a-f0-9]{64}$/.test(record.response_hash ?? '')
    ) {
      integrityFailure(
        'The completed intake session has an invalid artifact sequence.',
      );
    }
    records.set(record.batch_index, record);
  }
  return records;
}

function assertArtifact({
  artifact,
  record,
  session,
  batch,
  batchIndex,
}) {
  const allowedSourceRefs = batch.units.map(unit => unit.ref);
  if (
    artifact?.schema !== ARTIFACT_SCHEMA
    || artifact.request_id !== record.request_id
    || artifact.response_hash !== record.response_hash
    || sha256(canonicalJson(artifact.model_response))
      !== record.response_hash
    || artifact.request_metadata?.chat_id !== session.chat_id
    || artifact.request_metadata?.snapshot_id !== session.snapshot_id
    || artifact.request_metadata?.snapshot_hash !== session.snapshot_hash
    || artifact.request_metadata?.session_id !== session.session_id
    || artifact.request_metadata?.batch_index !== batchIndex
    || artifact.request_metadata?.contract_revision
      !== session.contract_revision
    || artifact.request_metadata?.partition_revision
      !== session.partition_revision
    || canonicalJson(artifact.request_metadata?.allowed_source_refs)
      !== canonicalJson(allowedSourceRefs)
  ) {
    integrityFailure(
      'A paid intake artifact no longer matches its completed session.',
      { batch_index: batchIndex },
    );
  }
}

function evidenceKey(sourceRef, quote) {
  return canonicalJson([sourceRef, quote]);
}

function batchEvidenceKey(batchIndex, sourceRef, evidenceId) {
  return canonicalJson([batchIndex, sourceRef, evidenceId]);
}

function collectEvidenceKeys(record, target) {
  for (const item of record?.evidence ?? []) {
    if (
      typeof item?.source_ref === 'string'
      && typeof item?.quote === 'string'
    ) {
      target.add(evidenceKey(item.source_ref, item.quote));
    }
  }
}

function collectBatchMappings(extraction) {
  const acceptedClaimsByEvidence = new Map();
  const addClaim = (claim, conceptKey) => {
    const keys = new Set();
    collectEvidenceKeys(claim, keys);
    for (const key of keys) {
      const mappings = acceptedClaimsByEvidence.get(key) ?? new Map();
      const mapping = {
        concept_key: conceptKey,
        claim: structuredClone(claim),
      };
      mappings.set(canonicalJson(mapping), mapping);
      acceptedClaimsByEvidence.set(key, mappings);
    }
  };

  for (const concept of extraction.concepts ?? []) {
    for (const claim of concept.baseline_claims ?? []) {
      addClaim(claim, concept.concept_key);
    }
  }
  return acceptedClaimsByEvidence;
}

function incompleteManifest({
  request,
  reasonCode,
  details = undefined,
}) {
  return {
    schema: MANIFEST_SCHEMA,
    status: 'incomplete',
    snapshot_id: request.snapshot_id,
    snapshot_hash: request.snapshot_hash,
    source_id: request.source_unit?.source_id ?? null,
    source_kind: request.source_unit?.source_kind ?? null,
    source_unit_ref: request.source_unit?.ref ?? null,
    required_evidence_spans: [],
    reason_code: reasonCode,
    ...(details === undefined ? {} : { details }),
  };
}

function assertRuntimeBinding({
  database,
  runtimeWorld,
  runtimeViewHash,
  session,
}) {
  const projections = database.prepare(`
    SELECT projection_id, source_version_hash
    FROM derived_state
    WHERE
      chat_id = ?
      AND projection_kind = 'runtime_world'
      AND status = 'ready'
    ORDER BY projection_id
  `).all(session.chat_id);
  if (
    projections.length !== 1
    || projections[0].source_version_hash !== runtimeViewHash
    || runtimeWorld?.schema !== 'mnemosyne.runtime-world.v1'
    || runtimeWorld.status !== 'ready'
    || runtimeWorld.snapshot_id !== session.snapshot_id
    || runtimeWorld.snapshot_hash !== session.snapshot_hash
    || runtimeWorld.extraction_hash
      !== sha256(canonicalJson(session.aggregate))
    || session.result.runtime_projection_hash !== runtimeViewHash
  ) {
    integrityFailure(
      'The active Runtime World is not the compiled paid-intake projection.',
    );
  }
}

function assertFullTextEvidence(unit, evidenceSpans) {
  const text = normalizedText(sourceUnitText(unit));
  const covered = new Uint8Array(text.length);
  for (const span of evidenceSpans) {
    const start = Number.isInteger(span.source_start)
      ? span.source_start
      : text.indexOf(span.quote);
    if (
      start < 0
      || text.slice(start, start + span.quote.length) !== span.quote
      || (
        !Number.isInteger(span.source_start)
        && text.indexOf(span.quote, start + 1) >= 0
      )
    ) {
      integrityFailure(
        'A normalized paid-intake evidence span is no longer recoverable.',
        { evidence_id: span.evidence_id },
      );
    }
    covered.fill(1, start, start + span.quote.length);
  }
  for (let index = 0; index < text.length; index += 1) {
    if (!covered[index] && !/\s/u.test(text[index])) {
      return false;
    }
  }
  return true;
}

async function loadTrustedSnapshot({
  store,
  chatId,
  snapshotId,
  snapshotHash,
}) {
  const active = await store.getActiveStaticLoreSnapshotForAdmin({ chatId });
  if (
    active?.snapshot_id !== snapshotId
    || active.snapshot_hash !== snapshotHash
  ) {
    integrityFailure(
      'The requested paid-intake snapshot is not active.',
    );
  }
  const snapshot = await store.readStaticLoreSnapshotForAdmin({
    chatId,
    snapshotId,
  });
  if (
    snapshot?.schema !== 'mnemosyne.static-lore-snapshot.v1'
    || snapshot.chat_id !== chatId
    || snapshot.snapshot_id !== snapshotId
    || snapshot.snapshot_hash !== snapshotHash
    || staticLoreSnapshotHash(snapshot.sources) !== snapshotHash
  ) {
    integrityFailure(
      'The active Static Lore snapshot failed integrity validation.',
    );
  }
  return snapshot;
}

export function createPaidIntakeSourceUnitManifestProvider({
  store,
} = {}) {
  if (
    !store?.openChatForAdmin
    || !store?.getActiveStaticLoreSnapshotForAdmin
    || !store?.readStaticLoreSnapshotForAdmin
    || !store?.readIntakeSessionForAdmin
    || !store?.readIntakeArtifactForAdmin
  ) {
    throw new Error(
      'Paid-intake manifest provider requires a trusted chat-save store.',
    );
  }

  return async function provideSourceUnitManifest(request = {}) {
    if (
      request.schema !== 'mnemosyne.source-unit-manifest-request.v1'
      || typeof request.chat_id !== 'string'
      || !request.chat_id
      || typeof request.snapshot_id !== 'string'
      || !/^[a-f0-9]{64}$/.test(request.snapshot_hash ?? '')
    ) {
      integrityFailure('The source-unit manifest request is invalid.');
    }
    const snapshot = await loadTrustedSnapshot({
      store,
      chatId: request.chat_id,
      snapshotId: request.snapshot_id,
      snapshotHash: request.snapshot_hash,
    });
    const packet = sourcePacket({
      snapshotId: snapshot.snapshot_id,
      snapshotHash: snapshot.snapshot_hash,
      sources: snapshot.sources,
    });
    const requestedUnit = packet.units.find(
      unit => unit.ref === request.source_unit?.ref,
    );
    if (
      !requestedUnit
      || canonicalJson(requestedUnit)
        !== canonicalJson(request.source_unit)
    ) {
      integrityFailure(
        'The requested source unit is not part of the active snapshot.',
      );
    }

    const session = await store.readIntakeSessionForAdmin({
      chatId: request.chat_id,
      snapshotId: snapshot.snapshot_id,
    });
    if (!assertSessionReady(session, {
      chatId: request.chat_id,
      snapshot,
    })) {
      return incompleteManifest({
        request,
        reasonCode: 'source_coverage_paid_intake_not_complete',
      });
    }
    assertSessionBatches(session, packet);

    const artifactRecords = artifactRecordByBatch(session);
    let aggregate = createStaticLoreAggregate(session.snapshot_hash);
    const warnings = [];
    const evidenceSpans = [];
    const acceptedClaimsByEvidence = new Map();
    const acceptedNonStoryByEvidence = new Map();
    const settledBatches = [];
    for (
      let batchIndex = 0;
      batchIndex < session.batches.length;
      batchIndex += 1
    ) {
      const batch = session.batches[batchIndex];
      const record = artifactRecords.get(batchIndex);
      if (!record) {
        integrityFailure(
          'The completed intake session is missing a paid artifact.',
          { batch_index: batchIndex },
        );
      }
      const artifact = await store.readIntakeArtifactForAdmin({
        chatId: request.chat_id,
        requestId: record.request_id,
      });
      assertArtifact({
        artifact,
        record,
        session,
        batch,
        batchIndex,
      });
      await assertRebaseOrigin({
        store,
        chatId: request.chat_id,
        artifact,
      });
      const extraction = extractionForTarget({
        artifact,
        extraction: parseExtraction(artifact.model_response),
        session,
        batch,
      });
      let normalized;
      let resolved;
      try {
        resolved = resolveStaticLoreEvidenceSpans({
          extraction,
          sourceUnits: batch.units,
        });
        normalized = harnessStaticLoreBatchEvidence({
          extraction,
          sourceUnits: batch.units,
          existingConceptKeys: aggregate.concepts.map(
            concept => concept.concept_key,
          ),
          existingConcepts: aggregate.concepts,
        });
      } catch (error) {
        integrityFailure(
          'A paid intake artifact no longer passes evidence validation.',
          { batch_index: batchIndex, cause: error.message },
        );
      }
      const settled = settleStaticLoreSourceUnits({
        extraction,
        normalizedExtraction: normalized.extraction,
        sourceUnits: batch.units,
        nonStoryEvidence: normalized.non_story_evidence,
      });
      const batchMappings = collectBatchMappings(settled.extraction);
      for (const [key, mappings] of batchMappings) {
        const existing = acceptedClaimsByEvidence.get(key) ?? new Map();
        for (const [mappingKey, mapping] of mappings) {
          existing.set(mappingKey, mapping);
        }
        acceptedClaimsByEvidence.set(key, existing);
      }
      for (const evidence of normalized.non_story_evidence) {
        const key = batchEvidenceKey(
          batchIndex,
          evidence.source_ref,
          evidence.evidence_id,
        );
        const existing = acceptedNonStoryByEvidence.get(key);
        if (
          existing
          && canonicalJson(existing) !== canonicalJson(
            evidence.classification,
          )
        ) {
          integrityFailure(
            'A paid intake artifact has conflicting non-story evidence.',
            { batch_index: batchIndex },
          );
        }
        acceptedNonStoryByEvidence.set(key, evidence.classification);
      }
      const acceptedSpanIds = new Set(
        settled.accepted_evidence_span_ids,
      );
      for (const span of resolved.spans.filter(
        item => acceptedSpanIds.has(item.evidence_id),
      )) {
        const localControl = normalized.non_story_evidence.find(
          evidence => (
            evidence.evidence_id === span.evidence_id
            && evidence.source_ref === span.source_ref
          ),
        );
        evidenceSpans.push({
          ...span,
          ...(localControl
            ? {
              source_start: localControl.source_start,
              source_end: localControl.source_end,
            }
            : {}),
          batch_index: batchIndex,
          artifact_response_hash: artifact.response_hash,
        });
      }
      for (const evidence of normalized.non_story_evidence.filter(
        item => item.synthesized,
      )) {
        evidenceSpans.push({
          evidence_id: evidence.evidence_id,
          source_ref: evidence.source_ref,
          quote: evidence.quote,
          evidence_mode: evidence.evidence_mode,
          source_start: evidence.source_start,
          source_end: evidence.source_end,
          batch_index: batchIndex,
          artifact_response_hash: artifact.response_hash,
        });
      }
      const merged = mergeStaticLoreBatch({
        aggregate,
        extraction: settled.extraction,
        allowedSourceRefs: batch.units.map(unit => unit.ref),
      });
      aggregate = merged.aggregate;
      warnings.push(
        ...normalized.warnings,
        ...settled.warnings,
        ...merged.warnings,
      );
      settledBatches.push({
        batch_index: batchIndex,
        settlements: settled.settlements,
        settled_at: staticLoreArtifactSettlementTime(session, record),
      });
    }
    if (
      canonicalJson(aggregate) !== canonicalJson(session.aggregate)
      || canonicalJson(warnings) !== canonicalJson(session.merge_warnings)
    ) {
      integrityFailure(
        'The paid artifacts no longer rebuild the completed intake aggregate.',
      );
    }
    const sourceUnitLedger = validatedSourceUnitLedger(
      session,
      rebuildStaticLoreSourceUnitLedger({
        batches: session.batches,
        settledBatches,
      }),
    );

    const opened = await store.openChatForAdmin({
      chatId: request.chat_id,
    });
    let runtimeWorld;
    try {
      runtimeWorld = JSON.parse(await readFile(path.join(
        opened.chat_save_path,
        'derived',
        'runtime-world.json',
      ), 'utf8'));
    } catch (error) {
      integrityFailure(
        'The compiled Runtime World is unavailable.',
        { cause: error.code ?? error.message },
      );
    }
    const runtimeViewHash = sha256(canonicalJson(runtimeWorld));
    const database = new DatabaseSync(
      opened.ledger_path,
      { readOnly: true },
    );
    try {
      assertRuntimeBinding({
        database,
        runtimeWorld,
        runtimeViewHash,
        session,
      });
    } finally {
      database.close();
    }

    const unitEvidence = evidenceSpans.filter(
      span => span.source_ref === requestedUnit.ref,
    );
    const requestedLedgerEntry = sourceUnitLedger.find(
      entry => entry.source_unit_ref === requestedUnit.ref,
    );
    if (requestedLedgerEntry?.state === 'unresolved') {
      return incompleteManifest({
        request,
        reasonCode: 'source_coverage_source_unit_evidence_missing',
      });
    }
    if (requestedLedgerEntry?.state !== 'owned') {
      return incompleteManifest({
        request,
        reasonCode: 'source_coverage_source_unit_not_fully_evidenced',
      });
    }
    if (unitEvidence.length === 0) {
      return incompleteManifest({
        request,
        reasonCode: 'source_coverage_source_unit_evidence_missing',
      });
    }
    if (!assertFullTextEvidence(requestedUnit, unitEvidence)) {
      return incompleteManifest({
        request,
        reasonCode: 'source_coverage_source_unit_not_fully_evidenced',
      });
    }
    const handlesByConceptKey = new Map(
      (runtimeWorld.retrieval_handles ?? []).map(handle => [
        handle.concept_key,
        handle,
      ]),
    );
    const baselineByEntityRef = new Map(
      (runtimeWorld.static_baseline_manifest ?? []).map(item => [
        item.entity_ref,
        item,
      ]),
    );
    const requiredEvidenceSpans = [];
    for (const span of unitEvidence) {
      const key = evidenceKey(span.source_ref, span.quote);
      const claimMappings = [
        ...(acceptedClaimsByEvidence.get(key)?.values() ?? []),
      ].sort((left, right) => (
        left.concept_key.localeCompare(right.concept_key)
        || canonicalJson(left.claim).localeCompare(canonicalJson(right.claim))
      ));
      if (claimMappings.length === 0) {
        const controlClassification =
          acceptedNonStoryByEvidence.get(batchEvidenceKey(
            span.batch_index,
            span.source_ref,
            span.evidence_id,
          ));
        if (controlClassification) {
          const evidenceId =
            `batch-${span.batch_index + 1}:${span.evidence_id}:control-1`;
          const controlTarget =
            staticLoreControlTarget(controlClassification);
          const localAcceptanceHash =
            staticLoreControlAcceptanceHash({
              snapshotId: snapshot.snapshot_id,
              sourceUnitRef: span.source_ref,
              evidenceId,
              evidenceMode: span.evidence_mode,
              evidenceQuoteHash: sha256(span.quote),
              modelArtifactHash: span.artifact_response_hash,
              runtimeViewHash,
              controlTarget,
            });
          requiredEvidenceSpans.push({
            evidence_id: evidenceId,
            source_ref: span.source_ref,
            evidence_hash: localAcceptanceHash,
            evidence_mode: span.evidence_mode,
            evidence_quote_hash: sha256(span.quote),
            model_artifact_hash: span.artifact_response_hash,
            record_kind: STATIC_LORE_CONTROL_RECORD_KIND,
            disposition: STATIC_LORE_CONTROL_DISPOSITION,
            ...(Number.isInteger(span.source_start)
              ? {
                source_start: span.source_start,
                source_end: span.source_end,
              }
              : {}),
            local_control_target: {
              ...controlTarget,
              local_acceptance_hash: localAcceptanceHash,
            },
          });
          continue;
        }
        return incompleteManifest({
          request,
          reasonCode: 'source_coverage_paid_evidence_unmapped',
          details: { evidence_id: span.evidence_id },
        });
      }
      const seenTargets = new Set();
      for (const mapping of claimMappings) {
        const concept = aggregate.concepts.find(candidate => (
          candidate.concept_key === mapping.concept_key
        ));
        const claimIndex = concept?.baseline_claims?.findIndex(
          claim => canonicalJson(claim) === canonicalJson(mapping.claim),
        ) ?? -1;
        if (claimIndex < 0) {
          return incompleteManifest({
            request,
            reasonCode: 'source_coverage_accepted_claim_missing',
            details: {
              evidence_id: span.evidence_id,
              concept_key: mapping.concept_key,
            },
          });
        }
        const claim = concept.baseline_claims[claimIndex];
        const claimKind = claim.claim_kind ?? 'fact';
        const canonicalClaim = claim.claim;
        const claimHash = acceptedClaimHash({
          claimKind,
          canonicalClaim,
        });
        const handle = handlesByConceptKey.get(mapping.concept_key);
        const baseline = baselineByEntityRef.get(handle?.entity_ref);
        if (
          !handle
          || typeof handle.entity_ref !== 'string'
          || !handle.entity_ref.startsWith('okf://entity/')
          || !Array.isArray(handle.source_refs)
          || !handle.source_refs.includes(span.source_ref)
          || !baseline
          || !/^[a-f0-9]{64}$/.test(baseline.version_hash ?? '')
          || !Array.isArray(baseline.claim_hashes)
          || !baseline.claim_hashes.includes(claimHash)
        ) {
          return incompleteManifest({
            request,
            reasonCode: 'source_coverage_runtime_mapping_missing',
            details: {
              evidence_id: span.evidence_id,
              concept_key: mapping.concept_key,
            },
          });
        }
        const targetIdentity = canonicalJson({
          entity_ref: handle.entity_ref,
          claim_index: claimIndex,
          claim_hash: claimHash,
        });
        if (seenTargets.has(targetIdentity)) continue;
        seenTargets.add(targetIdentity);
        const targetOrdinal = seenTargets.size;
        const evidenceId =
          `batch-${span.batch_index + 1}:${span.evidence_id}:`
          + `claim-${targetOrdinal}`;
        const acceptedTarget = {
          entity_ref: handle.entity_ref,
          field_path: acceptedClaimFieldPath(claimIndex),
          claim_kind: claimKind,
          canonical_claim: canonicalClaim,
          claim_hash: claimHash,
          okf_version_hash: baseline.version_hash,
        };
        const searchQuery = acceptedClaimSearchQuery(canonicalClaim);
        if (searchQueryUsesOnlyRuntimeIdentity({
          query: searchQuery,
          title: handle.title,
          entityRef: handle.entity_ref,
        })) {
          return incompleteManifest({
            request,
            reasonCode: 'source_coverage_accepted_claim_unsearchable',
            details: {
              evidence_id: span.evidence_id,
              concept_key: mapping.concept_key,
            },
          });
        }
        acceptedTarget.semantic_acceptance_hash = semanticAcceptanceHash({
          snapshotId: snapshot.snapshot_id,
          sourceUnitRef: span.source_ref,
          evidenceId,
          evidenceMode: span.evidence_mode,
          evidenceQuoteHash: sha256(span.quote),
          modelArtifactHash: span.artifact_response_hash,
          runtimeViewHash,
          acceptedTarget,
        });
        requiredEvidenceSpans.push({
          evidence_id: evidenceId,
          source_ref: span.source_ref,
          evidence_hash: acceptedTarget.semantic_acceptance_hash,
          evidence_mode: span.evidence_mode,
          evidence_quote_hash: sha256(span.quote),
          model_artifact_hash: span.artifact_response_hash,
          record_kind: 'okf_baseline_claim',
          disposition: 'covered',
          memory_ref: handle.entity_ref,
          search_query: searchQuery,
          accepted_target: acceptedTarget,
        });
      }
    }
    requiredEvidenceSpans.sort((left, right) => (
      left.evidence_id.localeCompare(right.evidence_id)
      || String(left.memory_ref ?? '').localeCompare(
        String(right.memory_ref ?? ''),
      )
    ));
    return {
      schema: MANIFEST_SCHEMA,
      status: 'complete',
      snapshot_id: snapshot.snapshot_id,
      snapshot_hash: snapshot.snapshot_hash,
      source_id: requestedUnit.source_id,
      source_kind: requestedUnit.source_kind,
      source_unit_ref: requestedUnit.ref,
      required_evidence_spans: requiredEvidenceSpans,
      paid_intake_binding: {
        schema: 'mnemosyne.paid-intake-manifest-binding.v1',
        session_id: session.session_id,
        contract_revision: session.contract_revision,
        partition_revision: session.partition_revision,
        runtime_view_hash: runtimeViewHash,
        aggregate_hash: sha256(canonicalJson(session.aggregate)),
        artifact_response_hashes: [...artifactRecords.values()]
          .sort((left, right) => left.batch_index - right.batch_index)
          .map(record => record.response_hash),
      },
    };
  };
}
