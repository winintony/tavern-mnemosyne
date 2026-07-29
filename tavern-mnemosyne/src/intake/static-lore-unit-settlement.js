import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  resolveStaticLoreEvidenceSpans,
} from './static-lore-evidence.js';

const TERMINAL_STATES = new Set([
  'owned',
  'context_only',
  'unresolved',
]);

function sourceUnitText(unit) {
  if (typeof unit?.data === 'string') return unit.data;
  if (typeof unit?.data?.content === 'string') return unit.data.content;
  return JSON.stringify(unit?.data ?? null);
}

function normalizedSourceText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function evidenceKey(sourceRef, quote) {
  return JSON.stringify([sourceRef, quote]);
}

function acceptedClaimEvidence(extraction) {
  const accepted = new Set();
  for (const concept of extraction.concepts ?? []) {
    for (const claim of concept.baseline_claims ?? []) {
      for (const evidence of claim.evidence ?? []) {
        accepted.add(evidenceKey(
          evidence.source_ref,
          evidence.quote,
        ));
      }
    }
  }
  return accepted;
}

function rawRecordEntries(extraction) {
  const entries = [];
  for (const concept of extraction.concepts ?? []) {
    const conceptLabel = `concept:${concept?.concept_key ?? 'unknown'}`;
    entries.push([conceptLabel, concept]);
    for (const [index, claim] of (
      concept.baseline_claims ?? []
    ).entries()) {
      entries.push([`${conceptLabel}:claim:${index}`, claim]);
    }
  }
  for (const collection of [
    'attribute_definitions',
    'progression_tracks',
    'current_state',
    'topology',
  ]) {
    for (const [index, record] of (
      extraction[collection] ?? []
    ).entries()) {
      entries.push([`${collection}:${index}`, record]);
    }
  }
  if (
    extraction.active_scene !== null
    && extraction.active_scene !== undefined
  ) {
    entries.push(['active_scene', extraction.active_scene]);
  }
  return entries;
}

function recordEvidenceIds(record) {
  return Array.isArray(record?.evidence_ids)
    ? record.evidence_ids.filter(id => typeof id === 'string')
    : [];
}

function filterUnmappedRecords(
  normalizedExtraction,
  acceptedEvidenceKeys,
) {
  const retained = structuredClone(normalizedExtraction);
  const keep = record => {
    const evidence = record?.evidence ?? [];
    return (
      evidence.length > 0
      && evidence.every(item => acceptedEvidenceKeys.has(
        evidenceKey(item.source_ref, item.quote),
      ))
    );
  };
  for (const collection of [
    'attribute_definitions',
    'progression_tracks',
    'current_state',
    'topology',
  ]) {
    retained[collection] = (retained[collection] ?? []).filter(
      record => keep(record),
    );
  }
  if (
    retained.active_scene !== null
    && retained.active_scene !== undefined
    && !keep(retained.active_scene)
  ) {
    retained.active_scene = null;
  }
  return retained;
}

function evidenceStart(text, evidence) {
  const start = Number.isInteger(evidence.source_start)
    ? evidence.source_start
    : text.indexOf(evidence.quote);
  if (
    start < 0
    || text.slice(start, start + evidence.quote.length)
      !== evidence.quote
    || (
      !Number.isInteger(evidence.source_start)
      && text.indexOf(evidence.quote, start + 1) >= 0
    )
  ) {
    throw new MnemosyneRequestError(
      'static_lore_intake_local_control_evidence_invalid',
      `Static Lore local control evidence is invalid in ${evidence.source_ref}.`,
    );
  }
  return start;
}

export function openStaticLoreSourceUnitLedger(batches = []) {
  return batches.flatMap((batch, batchIndex) => (
    (batch.units ?? []).map(unit => ({
      source_unit_ref: unit.ref,
      batch_index: batchIndex,
      state: 'open',
      accepted_evidence_count: 0,
      uncovered_non_whitespace_count: null,
      rejected_records: [],
      settled_at: null,
    }))
  ));
}

function sourceUnitLedgerEntryKey(entry) {
  return JSON.stringify([
    entry?.batch_index,
    entry?.source_unit_ref,
  ]);
}

export function terminalSourceUnitLedgerEntry(entry) {
  return (
    entry
    && typeof entry.source_unit_ref === 'string'
    && Number.isInteger(entry.batch_index)
    && TERMINAL_STATES.has(entry.state)
    && Number.isInteger(entry.accepted_evidence_count)
    && entry.accepted_evidence_count >= 0
    && Number.isInteger(entry.uncovered_non_whitespace_count)
    && entry.uncovered_non_whitespace_count >= 0
    && Array.isArray(entry.rejected_records)
    && typeof entry.settled_at === 'string'
    && entry.settled_at.length > 0
  );
}

export function rebuildStaticLoreSourceUnitLedger({
  batches = [],
  settledBatches = [],
} = {}) {
  const ledger = openStaticLoreSourceUnitLedger(batches);
  const entriesByKey = new Map(
    ledger.map(entry => [sourceUnitLedgerEntryKey(entry), entry]),
  );
  const settledBatchIndexes = new Set();
  for (const settledBatch of settledBatches) {
    const batchIndex = settledBatch?.batch_index;
    const batch = batches[batchIndex];
    const settlements = settledBatch?.settlements;
    const settledAt = settledBatch?.settled_at;
    const expectedRefs = batch?.units?.map(unit => unit.ref);
    if (
      !Number.isInteger(batchIndex)
      || settledBatchIndexes.has(batchIndex)
      || !Array.isArray(expectedRefs)
      || !Array.isArray(settlements)
      || settlements.length !== expectedRefs.length
      || settlements.some(
        (settlement, index) => (
          settlement?.source_unit_ref !== expectedRefs[index]
        ),
      )
      || typeof settledAt !== 'string'
      || settledAt.length === 0
    ) {
      throw new MnemosyneRequestError(
        'static_lore_intake_unit_ledger_invalid',
        'Static Lore source-unit settlements cannot rebuild their batch.',
        { batch_index: batchIndex },
      );
    }
    settledBatchIndexes.add(batchIndex);
    for (const settlement of settlements) {
      const rebuilt = {
        ...structuredClone(settlement),
        batch_index: batchIndex,
        settled_at: settledAt,
      };
      const entry = entriesByKey.get(sourceUnitLedgerEntryKey(rebuilt));
      if (!entry || !terminalSourceUnitLedgerEntry(rebuilt)) {
        throw new MnemosyneRequestError(
          'static_lore_intake_unit_ledger_invalid',
          'Static Lore source-unit settlement is not terminal.',
          {
            batch_index: batchIndex,
            source_unit_ref: settlement?.source_unit_ref,
          },
        );
      }
      Object.assign(entry, rebuilt);
    }
  }
  return ledger;
}

export function completeStaticLoreSourceUnitLedger({
  batches = [],
  ledger,
} = {}) {
  if (!Array.isArray(ledger)) return false;
  const expected = openStaticLoreSourceUnitLedger(batches);
  if (ledger.length !== expected.length) return false;
  const actualByKey = new Map(
    ledger.map(entry => [sourceUnitLedgerEntryKey(entry), entry]),
  );
  if (actualByKey.size !== ledger.length) return false;
  return expected.every(entry => terminalSourceUnitLedgerEntry(
    actualByKey.get(sourceUnitLedgerEntryKey(entry)),
  ));
}

export function staticLoreArtifactSettlementTime(session, record) {
  return (
    record?.committed_at
    ?? session?.completed_at
    ?? session?.created_at
  );
}

export function settleStaticLoreSourceUnits({
  extraction,
  normalizedExtraction,
  sourceUnits,
  nonStoryEvidence = [],
} = {}) {
  const resolved = resolveStaticLoreEvidenceSpans({
    extraction,
    sourceUnits,
  });
  const acceptedEvidenceKeys = acceptedClaimEvidence(
    normalizedExtraction,
  );
  for (const evidence of nonStoryEvidence) {
    acceptedEvidenceKeys.add(evidenceKey(
      evidence.source_ref,
      evidence.quote,
    ));
  }
  const acceptedSpans = resolved.spans.filter(span => (
    acceptedEvidenceKeys.has(evidenceKey(span.source_ref, span.quote))
  ));
  const acceptedSpanIds = new Set(
    acceptedSpans.map(span => span.evidence_id),
  );
  const rejectedSpanIds = new Set(
    resolved.spans
      .filter(span => !acceptedSpanIds.has(span.evidence_id))
      .map(span => span.evidence_id),
  );
  const spanById = new Map(
    resolved.spans.map(span => [span.evidence_id, span]),
  );
  const rejectionByUnit = new Map(
    sourceUnits.map(unit => [unit.ref, new Map()]),
  );
  const ownedRejectedSpans = new Set();
  for (const [label, record] of rawRecordEntries(extraction)) {
    const rejectedIds = recordEvidenceIds(record).filter(
      evidenceId => rejectedSpanIds.has(evidenceId),
    );
    if (rejectedIds.length === 0) continue;
    for (const evidenceId of rejectedIds) {
      ownedRejectedSpans.add(evidenceId);
      const sourceRef = spanById.get(evidenceId)?.source_ref;
      const records = rejectionByUnit.get(sourceRef);
      if (!records) continue;
      const existing = records.get(label) ?? new Set();
      existing.add(evidenceId);
      records.set(label, existing);
    }
  }
  for (const evidenceId of rejectedSpanIds) {
    if (ownedRejectedSpans.has(evidenceId)) continue;
    const span = spanById.get(evidenceId);
    const records = rejectionByUnit.get(span?.source_ref);
    if (!records) continue;
    records.set(
      `evidence_span:${evidenceId}`,
      new Set([evidenceId]),
    );
  }

  const filteredExtraction = filterUnmappedRecords(
    normalizedExtraction,
    acceptedEvidenceKeys,
  );
  const warnings = [];
  const settlements = [];
  for (const unit of sourceUnits) {
    const text = normalizedSourceText(sourceUnitText(unit));
    const covered = new Uint8Array(text.length);
    const acceptedForUnit = [
      ...acceptedSpans.filter(span => span.source_ref === unit.ref),
      ...nonStoryEvidence.filter(
        evidence => evidence.source_ref === unit.ref,
      ),
    ];
    const seenEvidence = new Set();
    for (const evidence of acceptedForUnit) {
      const identity = JSON.stringify([
        evidence.source_ref,
        evidence.evidence_id,
        evidence.source_start ?? null,
        evidence.source_end ?? null,
        evidence.quote,
      ]);
      if (seenEvidence.has(identity)) continue;
      seenEvidence.add(identity);
      const start = evidenceStart(text, evidence);
      covered.fill(1, start, start + evidence.quote.length);
    }
    let uncoveredNonWhitespaceCount = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (!covered[index] && !/\s/u.test(text[index])) {
        uncoveredNonWhitespaceCount += 1;
      }
    }
    const rejectedRecords = [
      ...(rejectionByUnit.get(unit.ref) ?? new Map()),
    ].map(([record, evidenceIds]) => ({
      record,
      reason_code: 'evidence_span_unmapped',
      evidence_ids: [...evidenceIds].sort(),
    })).sort((left, right) => left.record.localeCompare(right.record));
    const state = uncoveredNonWhitespaceCount === 0
      ? 'owned'
      : (seenEvidence.size > 0 ? 'context_only' : 'unresolved');
    settlements.push({
      source_unit_ref: unit.ref,
      state,
      accepted_evidence_count: seenEvidence.size,
      uncovered_non_whitespace_count: uncoveredNonWhitespaceCount,
      rejected_records: rejectedRecords,
    });
    for (const rejection of rejectedRecords) {
      warnings.push({
        code: 'evidence_record_rejected',
        record: rejection.record,
        reason: rejection.reason_code,
        evidence_ids: rejection.evidence_ids,
        source_unit_ref: unit.ref,
      });
    }
    if (state !== 'owned') {
      warnings.push({
        code: 'source_unit_coverage_incomplete',
        record: `source_unit:${unit.ref}`,
        reason: 'removal_authorization_withheld',
        source_unit_ref: unit.ref,
        state,
        uncovered_non_whitespace_count: uncoveredNonWhitespaceCount,
      });
    }
  }
  return {
    extraction: filteredExtraction,
    warnings,
    settlements,
    accepted_evidence_span_ids: [...acceptedSpanIds].sort(),
  };
}
