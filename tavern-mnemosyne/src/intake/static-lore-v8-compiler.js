import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  createStaticLoreAggregate,
  mergeStaticLoreBatch,
} from './static-lore-batch.js';
import {
  normalizeStaticLoreBatchEvidence,
  resolveStaticLoreEvidenceSpans,
} from './static-lore-evidence.js';
import {
  harnessStaticLoreBatchEvidence,
} from './static-lore-evidence-harness.js';
import {
  settleStaticLoreSourceUnits,
} from './static-lore-unit-settlement.js';

const V8_EXTRACTION_SCHEMA = 'mnemosyne.static-lore-extraction.v2';
const V7_EXTRACTION_SCHEMA = 'mnemosyne.static-lore-extraction.v1';

function ticket(value) {
  const body = structuredClone(value);
  return {
    ticket_id: `g${sha256(canonicalJson(body)).slice(0, 30)}`,
    ...body,
  };
}

function emptyExtraction(snapshotHash) {
  return {
    schema: 'mnemosyne.static-lore-extraction.v1',
    snapshot_hash: snapshotHash,
    evidence_spans: [],
    concepts: [],
    attribute_definitions: [],
    progression_tracks: [],
    current_state: [],
    topology: [],
    active_scene: null,
  };
}

function atomIdsOf(record) {
  return Array.isArray(record?.atom_ids)
    ? record.atom_ids
    : [];
}

function recordWithoutEvidence(record) {
  const cloned = structuredClone(record);
  delete cloned.atom_ids;
  delete cloned.evidence_ids;
  delete cloned.evidence;
  delete cloned.source_refs;
  return cloned;
}

function frozenIdentity(label, record) {
  const frozenValue = recordWithoutEvidence(record);
  if (label.startsWith('concept:')) {
    delete frozenValue.baseline_claims;
  }
  return {
    key: label,
    hash: sha256(canonicalJson(frozenValue)),
  };
}

function frozenMap(frozenRecords = []) {
  return new Map((frozenRecords ?? []).map(entry => [
    entry?.key,
    entry?.hash,
  ]));
}

function recordLabel(collection, record, index, conceptKey = null) {
  if (collection === 'concepts') {
    return `concept:${record?.concept_key ?? index}`;
  }
  if (collection === 'baseline_claims') {
    return [
      `concept:${conceptKey ?? 'unknown'}`,
      'claim',
      sha256(canonicalJson([
        record?.claim_kind ?? null,
        record?.claim ?? null,
      ])).slice(0, 16),
    ].join(':');
  }
  const identity = {
    attribute_definitions: record?.attribute_id,
    progression_tracks: record?.track_id,
    current_state: [
      record?.entity_key,
      record?.state_domain,
      record?.state_key,
    ].filter(Boolean).join(':'),
    topology: [
      record?.entity_key,
      record?.parent_key,
      record?.relation,
    ].filter(Boolean).join(':'),
  }[collection];
  return `${collection}:${identity || index}`;
}

function validatedAtomRecord({
  record,
  label,
  atomById,
  frozen,
  tickets,
}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    tickets.push(ticket({
      record: label,
      reason_code: 'record_shape_invalid',
    }));
    return null;
  }
  const atomIds = atomIdsOf(record);
  if (atomIds.length === 0) {
    tickets.push(ticket({
      record: label,
      reason_code: 'atom_ids_required',
    }));
    return null;
  }
  const unknown = atomIds.filter(atomId => !atomById.has(atomId));
  if (unknown.length > 0) {
    tickets.push(ticket({
      record: label,
      reason_code: 'atom_id_unknown',
      atom_ids: [...new Set(unknown)].sort(),
    }));
    return null;
  }
  if (new Set(atomIds).size !== atomIds.length) {
    tickets.push(ticket({
      record: label,
      reason_code: 'atom_id_duplicated',
    }));
    return null;
  }
  const identity = frozenIdentity(label, record);
  const frozenHash = frozen.get(identity.key);
  if (frozenHash && frozenHash !== identity.hash) {
    tickets.push(ticket({
      record: label,
      reason_code: 'accepted_record_rewrite_forbidden',
      accepted_record_hash: frozenHash,
      submitted_record_hash: identity.hash,
    }));
    return null;
  }
  return {
    record: structuredClone(record),
    frozen: identity,
  };
}

function preprocessPatch({
  patch,
  atomById,
  frozen,
}) {
  const tickets = [];
  const acceptedFrozen = [];
  const prepared = emptyExtraction(patch.snapshot_hash);
  const usedAtomIds = new Set();
  const accept = validated => {
    if (!validated) return null;
    acceptedFrozen.push(validated.frozen);
    for (const atomId of atomIdsOf(validated.record)) {
      usedAtomIds.add(atomId);
    }
    return validated.record;
  };

  for (const [index, concept] of (patch.concepts ?? []).entries()) {
    const label = recordLabel('concepts', concept, index);
    const validated = validatedAtomRecord({
      record: concept,
      label,
      atomById,
      frozen,
      tickets,
    });
    if (!validated) continue;
    const claims = [];
    for (const [claimIndex, claim] of (
      concept.baseline_claims ?? []
    ).entries()) {
      const claimLabel = recordLabel(
        'baseline_claims',
        claim,
        claimIndex,
        concept.concept_key,
      );
      const acceptedClaim = accept(validatedAtomRecord({
        record: claim,
        label: claimLabel,
        atomById,
        frozen,
        tickets,
      }));
      if (acceptedClaim) claims.push(acceptedClaim);
    }
    const acceptedConcept = accept(validated);
    if (acceptedConcept) {
      acceptedConcept.baseline_claims = claims;
      prepared.concepts.push(acceptedConcept);
    }
  }

  for (const collection of [
    'attribute_definitions',
    'progression_tracks',
    'current_state',
    'topology',
  ]) {
    for (const [index, record] of (
      patch[collection] ?? []
    ).entries()) {
      const accepted = accept(validatedAtomRecord({
        record,
        label: recordLabel(collection, record, index),
        atomById,
        frozen,
        tickets,
      }));
      if (accepted) prepared[collection].push(accepted);
    }
  }
  if (patch.active_scene !== null && patch.active_scene !== undefined) {
    prepared.active_scene = accept(validatedAtomRecord({
      record: patch.active_scene,
      label: 'active_scene',
      atomById,
      frozen,
      tickets,
    }));
  }

  const evidenceSpans = [...usedAtomIds].sort().map(atomId => {
    const atom = atomById.get(atomId);
    return {
      evidence_id: atomId,
      source_index: atom.source_index,
      quote: atom.text,
      source_start: atom.start,
      source_end: atom.end,
    };
  });
  const replaceAtomIds = value => {
    if (Array.isArray(value)) return value.map(replaceAtomIds);
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'atom_ids') {
        output.evidence_ids = structuredClone(item);
      } else {
        output[key] = replaceAtomIds(item);
      }
    }
    return output;
  };
  return {
    extraction: {
      ...replaceAtomIds(prepared),
      evidence_spans: evidenceSpans,
    },
    tickets,
    acceptedFrozen,
  };
}

function collectionRecords(extraction) {
  return [
    ['attribute_definitions', extraction.attribute_definitions ?? []],
    ['progression_tracks', extraction.progression_tracks ?? []],
    ['current_state', extraction.current_state ?? []],
    ['topology', extraction.topology ?? []],
  ];
}

function isolatedSemanticPatch({
  extraction,
  sourceUnits,
  aggregate,
}) {
  const existingConcepts = aggregate?.concepts ?? [];
  const existingConceptKeys = existingConcepts.map(
    concept => concept.concept_key,
  );
  const normalize = candidate => normalizeStaticLoreBatchEvidence({
    extraction: candidate,
    sourceUnits,
    existingConceptKeys,
    existingConcepts,
  });
  try {
    return {
      raw: extraction,
      normalized: normalize(extraction),
      tickets: [],
    };
  } catch {
    // A semantic defect in one record must not erase independent records.
    // Validate record-shaped leaves independently, then normalize the
    // salvaged patch once more as a whole so links and entity references are
    // judged against only the concepts that actually survived.
  }

  const salvaged = emptyExtraction(extraction.snapshot_hash);
  salvaged.evidence_spans = structuredClone(
    extraction.evidence_spans ?? [],
  );
  const tickets = [];
  const reject = (label, record, error) => {
    tickets.push(ticket({
      record: label,
      reason_code: 'semantic_record_invalid',
      atom_ids: atomIdsOf(record),
      detail_code: sha256(String(error?.message ?? '')).slice(0, 16),
    }));
  };
  const canNormalize = candidate => {
    try {
      normalize(candidate);
      return true;
    } catch {
      return false;
    }
  };
  const candidateWith = overrides => ({
    ...emptyExtraction(extraction.snapshot_hash),
    evidence_spans: structuredClone(extraction.evidence_spans ?? []),
    ...overrides,
  });

  for (const [conceptIndex, concept] of (
    extraction.concepts ?? []
  ).entries()) {
    const conceptLabel = recordLabel(
      'concepts',
      concept,
      conceptIndex,
    );
    if (canNormalize(candidateWith({
      concepts: [structuredClone(concept)],
    }))) {
      salvaged.concepts.push(structuredClone(concept));
      continue;
    }
    const conceptWithoutClaims = {
      ...structuredClone(concept),
      baseline_claims: [],
    };
    if (!canNormalize(candidateWith({
      concepts: [conceptWithoutClaims],
    }))) {
      try {
        normalize(candidateWith({ concepts: [conceptWithoutClaims] }));
      } catch (error) {
        reject(conceptLabel, concept, error);
      }
      continue;
    }
    const acceptedClaims = [];
    for (const [claimIndex, claim] of (
      concept.baseline_claims ?? []
    ).entries()) {
      const oneClaimConcept = {
        ...conceptWithoutClaims,
        baseline_claims: [structuredClone(claim)],
      };
      if (canNormalize(candidateWith({
        concepts: [oneClaimConcept],
      }))) {
        acceptedClaims.push(structuredClone(claim));
      } else {
        try {
          normalize(candidateWith({ concepts: [oneClaimConcept] }));
        } catch (error) {
          reject(
            recordLabel(
              'baseline_claims',
              claim,
              claimIndex,
              concept.concept_key,
            ),
            claim,
            error,
          );
        }
      }
    }
    salvaged.concepts.push({
      ...conceptWithoutClaims,
      baseline_claims: acceptedClaims,
    });
  }

  const acceptedConceptKeys = [
    ...existingConceptKeys,
    ...salvaged.concepts.map(concept => concept.concept_key),
  ];
  const normalizeStructural = candidate => (
    normalizeStaticLoreBatchEvidence({
      extraction: candidate,
      sourceUnits,
      existingConceptKeys: acceptedConceptKeys,
      existingConcepts: [
        ...existingConcepts,
        ...salvaged.concepts,
      ],
    })
  );
  for (const [collection, records] of collectionRecords(extraction)) {
    for (const [index, record] of records.entries()) {
      const candidate = candidateWith({
        concepts: structuredClone(salvaged.concepts),
        [collection]: [structuredClone(record)],
      });
      try {
        normalizeStructural(candidate);
        salvaged[collection].push(structuredClone(record));
      } catch (error) {
        reject(recordLabel(collection, record, index), record, error);
      }
    }
  }
  if (
    extraction.active_scene !== null
    && extraction.active_scene !== undefined
  ) {
    const candidate = candidateWith({
      concepts: structuredClone(salvaged.concepts),
      active_scene: structuredClone(extraction.active_scene),
    });
    try {
      normalizeStructural(candidate);
      salvaged.active_scene = structuredClone(extraction.active_scene);
    } catch (error) {
      reject('active_scene', extraction.active_scene, error);
    }
  }

  try {
    return {
      raw: salvaged,
      normalized: normalizeStaticLoreBatchEvidence({
        extraction: salvaged,
        sourceUnits,
        existingConceptKeys,
        existingConcepts,
      }),
      tickets,
    };
  } catch (error) {
    return {
      raw: emptyExtraction(extraction.snapshot_hash),
      normalized: {
        extraction: emptyExtraction(extraction.snapshot_hash),
        warnings: [],
      },
      tickets: [
        ...tickets,
        ticket({
          record: 'patch',
          reason_code: 'patch_semantic_validation_failed',
          detail_code: sha256(String(error?.message ?? '')).slice(0, 16),
        }),
      ],
    };
  }
}

function acceptedFrozenEntries(extraction, entries) {
  const acceptedLabels = new Set();
  for (const concept of extraction.concepts ?? []) {
    acceptedLabels.add(`concept:${concept.concept_key}`);
    for (const [claimIndex, claim] of (
      concept.baseline_claims ?? []
    ).entries()) {
      acceptedLabels.add(recordLabel(
        'baseline_claims',
        claim,
        claimIndex,
        concept.concept_key,
      ));
    }
  }
  for (const [collection, records] of collectionRecords(extraction)) {
    for (const [index, record] of records.entries()) {
      acceptedLabels.add(recordLabel(collection, record, index));
    }
  }
  if (extraction.active_scene !== null) {
    acceptedLabels.add('active_scene');
  }
  return entries.filter(entry => acceptedLabels.has(entry.key));
}

function collectAcceptedEvidence(value, accepted = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectAcceptedEvidence(item, accepted);
    return accepted;
  }
  if (!value || typeof value !== 'object') return accepted;
  if (Array.isArray(value.evidence)) {
    accepted.push(...value.evidence);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'evidence') collectAcceptedEvidence(item, accepted);
  }
  return accepted;
}

function acceptedAtomIdsFor(extraction, atomIndex) {
  const byCoordinate = new Map(atomIndex.atoms.map(atom => [
    canonicalJson([
      atom.source_unit_ref,
      atom.start,
      atom.end,
      atom.quote_hash,
    ]),
    atom.atom_id,
  ]));
  const accepted = new Set();
  for (const evidence of collectAcceptedEvidence(extraction)) {
    if (
      !Number.isInteger(evidence?.source_start)
      || !Number.isInteger(evidence?.source_end)
    ) {
      continue;
    }
    const atomId = byCoordinate.get(canonicalJson([
      evidence.source_ref,
      evidence.source_start,
      evidence.source_end,
      sha256(evidence.quote ?? ''),
    ]));
    if (atomId) accepted.add(atomId);
  }
  return [...accepted].sort();
}

function atomIdsForDerivedEvidence(evidence, atomIndex) {
  const byCoordinate = new Map(atomIndex.atoms.map(atom => [
    canonicalJson([
      atom.source_unit_ref,
      atom.start,
      atom.end,
      atom.quote_hash,
    ]),
    atom.atom_id,
  ]));
  const accepted = new Set();
  for (const item of evidence ?? []) {
    if (
      !Number.isInteger(item?.source_start)
      || !Number.isInteger(item?.source_end)
    ) {
      continue;
    }
    const atomId = byCoordinate.get(canonicalJson([
      item.source_ref,
      item.source_start,
      item.source_end,
      sha256(item.quote ?? ''),
    ]));
    if (atomId) accepted.add(atomId);
  }
  return [...accepted].sort();
}

function isolateMergeablePatch({
  extraction,
  aggregate,
  allowedSourceRefs,
  atomIndex,
}) {
  const merge = candidate => mergeStaticLoreBatch({
    aggregate,
    extraction: candidate,
    allowedSourceRefs,
  });
  try {
    const merged = merge(extraction);
    return {
      extraction,
      aggregate: merged.aggregate,
      warnings: merged.warnings,
      tickets: [],
    };
  } catch {
    // Fall through to record-level merge isolation. Semantic validation and
    // aggregate merge enforce different invariants, so both have to isolate
    // siblings for the v8 "valid work survives" guarantee to be true.
  }

  const accepted = emptyExtraction(extraction.snapshot_hash);
  const tickets = [];
  const reject = (label, record, error) => {
    tickets.push(ticket({
      record: label,
      reason_code: 'aggregate_merge_record_invalid',
      atom_ids: atomIndex
        ? acceptedAtomIdsFor(record, atomIndex)
        : [],
      detail_code: sha256(String(error?.message ?? '')).slice(0, 16),
    }));
  };
  const canMerge = candidate => {
    try {
      merge(candidate);
      return true;
    } catch {
      return false;
    }
  };
  const withRecord = (collection, record) => ({
    ...structuredClone(accepted),
    [collection]: [
      ...structuredClone(accepted[collection]),
      structuredClone(record),
    ],
  });

  let deferredConcepts = (extraction.concepts ?? []).map(
    (record, index) => ({ record, index }),
  );
  let acceptedOne = true;
  while (deferredConcepts.length > 0 && acceptedOne) {
    acceptedOne = false;
    const next = [];
    for (const item of deferredConcepts) {
      const candidate = withRecord('concepts', item.record);
      if (canMerge(candidate)) {
        accepted.concepts.push(structuredClone(item.record));
        acceptedOne = true;
      } else {
        next.push(item);
      }
    }
    deferredConcepts = next;
  }
  for (const { record, index } of deferredConcepts) {
    try {
      merge(withRecord('concepts', record));
    } catch (error) {
      reject(recordLabel('concepts', record, index), record, error);
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
      const candidate = withRecord(collection, record);
      try {
        merge(candidate);
        accepted[collection].push(structuredClone(record));
      } catch (error) {
        reject(recordLabel(collection, record, index), record, error);
      }
    }
  }
  if (
    extraction.active_scene !== null
    && extraction.active_scene !== undefined
  ) {
    const candidate = {
      ...structuredClone(accepted),
      active_scene: structuredClone(extraction.active_scene),
    };
    try {
      merge(candidate);
      accepted.active_scene = structuredClone(extraction.active_scene);
    } catch (error) {
      reject('active_scene', extraction.active_scene, error);
    }
  }
  const merged = merge(accepted);
  return {
    extraction: accepted,
    aggregate: merged.aggregate,
    warnings: merged.warnings,
    tickets,
  };
}

function uncoveredCount(atoms) {
  return atoms.reduce((total, atom) => (
    total + [...atom.text].filter(character => !/\s/u.test(character)).length
  ), 0);
}

function unitSettlements({
  sourceUnits,
  atomIndex,
  accepted,
  terminal,
  rejectionTickets,
}) {
  return sourceUnits.map(unit => {
    const atoms = atomIndex.atoms.filter(atom => (
      atom.source_unit_ref === unit.ref
    ));
    const storyAtoms = atoms.filter(atom => !atom.control);
    const acceptedStory = storyAtoms.filter(atom => accepted.has(atom.atom_id));
    const missingStory = storyAtoms.filter(atom => !accepted.has(atom.atom_id));
    const state = missingStory.length === 0
      ? 'owned'
      : (
        terminal
          ? (acceptedStory.length > 0 ? 'context_only' : 'unresolved')
          : 'open'
      );
    return {
      source_unit_ref: unit.ref,
      state,
      accepted_evidence_count: acceptedStory.length,
      uncovered_non_whitespace_count: uncoveredCount(missingStory),
      rejected_records: rejectionTickets.map(item => ({
        record: item.record,
        reason_code: item.reason_code,
        ...(item.atom_ids ? { atom_ids: item.atom_ids } : {}),
      })),
      missing_atom_ids: missingStory.map(atom => atom.atom_id),
    };
  });
}

function mergedFrozenRecords(frozenRecords, added) {
  const byKey = new Map((frozenRecords ?? []).map(entry => [
    entry.key,
    structuredClone(entry),
  ]));
  for (const entry of added) {
    byKey.set(entry.key, structuredClone(entry));
  }
  return [...byKey.values()].sort((left, right) => (
    left.key.localeCompare(right.key)
  ));
}

export function compileStaticLoreV8Patch({
  patch,
  sourceUnits = [],
  atomIndex,
  aggregate,
  acceptedAtomIds = [],
  frozenRecords = [],
  externalTickets = [],
  round = 1,
  maxRounds = 3,
} = {}) {
  if (
    patch?.schema !== V8_EXTRACTION_SCHEMA
    || patch.snapshot_hash !== atomIndex?.snapshot_hash
    || !Number.isSafeInteger(round)
    || round < 1
    || !Number.isSafeInteger(maxRounds)
    || maxRounds < 1
    || round > maxRounds
  ) {
    throw new TypeError('Static Lore v8 patch contract is invalid.');
  }
  const atomById = new Map(
    atomIndex.atoms.map(atom => [atom.atom_id, atom]),
  );
  const prepared = preprocessPatch({
    patch,
    atomById,
    frozen: frozenMap(frozenRecords),
  });
  let normalized;
  const compilerTickets = [
    ...prepared.tickets,
    ...externalTickets.map(item => ticket(item)),
  ];
  const isolated = isolatedSemanticPatch({
    extraction: prepared.extraction,
    sourceUnits,
    aggregate,
  });
  try {
    const harnessed = harnessStaticLoreBatchEvidence({
      extraction: isolated.raw,
      sourceUnits,
      existingConceptKeys: aggregate?.concepts?.map(
        concept => concept.concept_key,
      ) ?? [],
      existingConcepts: aggregate?.concepts ?? [],
    });
    normalized = {
      ...harnessed,
      // Structural settlement is an expected v8 compiler result recorded in
      // accepted_non_story_evidence. The legacy harness called the same
      // server-derived event a warning because v7 used it to explain why a
      // quote-coverage retry was avoided.
      warnings: harnessed.warnings.filter(
        warning => warning.code
          !== 'local_control_evidence_synthesized',
      ),
    };
  } catch (error) {
    normalized = isolated.normalized;
    compilerTickets.push(ticket({
      record: 'patch',
      reason_code: 'evidence_harness_failed',
      detail_code: sha256(String(error?.message ?? '')).slice(0, 16),
    }));
  }
  compilerTickets.push(...isolated.tickets);
  const mergeIsolated = isolateMergeablePatch({
    extraction: normalized.extraction,
    aggregate: aggregate
      ? structuredClone(aggregate)
      : createStaticLoreAggregate(patch.snapshot_hash),
    allowedSourceRefs: sourceUnits.map(unit => unit.ref),
    atomIndex,
  });
  compilerTickets.push(...mergeIsolated.tickets);
  const acceptedDelta = mergeIsolated.extraction;
  const newlyAccepted = acceptedAtomIdsFor(
    acceptedDelta,
    atomIndex,
  );
  const derivedControlAtoms = atomIdsForDerivedEvidence(
    normalized.non_story_evidence,
    atomIndex,
  );
  const accepted = new Set([
    ...acceptedAtomIds,
    ...newlyAccepted,
    ...derivedControlAtoms,
    ...atomIndex.atoms
      .filter(atom => atom.control)
      .map(atom => atom.atom_id),
  ]);
  const provisional = unitSettlements({
    sourceUnits,
    atomIndex,
    accepted,
    terminal: false,
    rejectionTickets: compilerTickets,
  });
  const allOwned = provisional.every(entry => entry.state === 'owned');
  const terminal = allOwned || round >= maxRounds;
  const settlements = terminal
    ? unitSettlements({
      sourceUnits,
      atomIndex,
      accepted,
      terminal: true,
      rejectionTickets: compilerTickets,
    })
    : provisional;
  const coverageTickets = settlements.flatMap(entry => (
    entry.state === 'owned'
      ? []
      : [ticket({
        source_unit_ref: entry.source_unit_ref,
        reason_code: 'atom_coverage_open',
        atom_ids: entry.missing_atom_ids,
      })]
  ));
  const openTickets = [...compilerTickets, ...coverageTickets];
  const frozen = mergedFrozenRecords(
    frozenRecords,
    acceptedFrozenEntries(
      acceptedDelta,
      prepared.acceptedFrozen,
    ),
  );
  const mergedAggregate = mergeIsolated.aggregate;
  const cumulativeAccepted = [...accepted]
    .filter(atomId => !atomById.get(atomId)?.control)
    .sort();
  const offlineTickets = terminal
    ? openTickets.map(item => ({
      ...structuredClone(item),
      disposition: 'unresolved_offline',
    }))
    : [];
  const activeTickets = terminal ? [] : openTickets;
  const ledgerBody = {
    schema: 'mnemosyne.static-lore-gap-ledger.v1',
    atom_index_hash: atomIndex.atom_index_hash,
    round,
    max_rounds: maxRounds,
    accepted_atom_ids: cumulativeAccepted,
    frozen_records: frozen,
    settlements: settlements.map(entry => ({
      source_unit_ref: entry.source_unit_ref,
      state: entry.state,
      accepted_evidence_count: entry.accepted_evidence_count,
      uncovered_non_whitespace_count:
        entry.uncovered_non_whitespace_count,
    })),
    gap_tickets: activeTickets,
    offline_tickets: offlineTickets,
  };
  return {
    schema: 'mnemosyne.static-lore-compile-result.v1',
    accepted_delta: acceptedDelta,
    accepted_non_story_evidence:
      structuredClone(normalized.non_story_evidence ?? []),
    aggregate: mergedAggregate,
    accepted_atom_ids: cumulativeAccepted,
    frozen_records: frozen,
    gap_tickets: activeTickets,
    offline_tickets: offlineTickets,
    settlements,
    warnings: [
      ...normalized.warnings,
      ...mergeIsolated.warnings,
    ],
    round_terminal: terminal,
    ledger_hash: sha256(canonicalJson(ledgerBody)),
  };
}

function v7EvidenceReason(error) {
  const message = String(error?.message ?? '');
  if (message.includes('ambiguous')) return 'v7_evidence_ambiguous';
  if (message.includes('not found')) return 'v7_evidence_not_found';
  if (message.includes('evidence zones')) {
    return 'v7_evidence_crosses_zone';
  }
  return 'v7_evidence_invalid';
}

function validV7EvidenceSpans(extraction, sourceUnits) {
  const spans = [];
  const tickets = [];
  const seen = new Set();
  for (const [index, span] of (
    extraction.evidence_spans ?? []
  ).entries()) {
    const label = `evidence_spans[${index}]`;
    if (
      typeof span?.evidence_id !== 'string'
      || seen.has(span.evidence_id)
    ) {
      tickets.push(ticket({
        record: label,
        reason_code: 'v7_evidence_id_invalid',
      }));
      continue;
    }
    seen.add(span.evidence_id);
    try {
      resolveStaticLoreEvidenceSpans({
        extraction: {
          ...emptyExtraction(extraction.snapshot_hash),
          evidence_spans: [span],
        },
        sourceUnits,
      });
      spans.push(structuredClone(span));
    } catch (error) {
      tickets.push(ticket({
        record: label,
        reason_code: v7EvidenceReason(error),
        evidence_ids: [span.evidence_id],
        detail_code: sha256(String(error?.message ?? '')).slice(0, 16),
      }));
    }
  }
  return { spans, tickets };
}

function filterV7RecordsByEvidence(extraction, validIds) {
  const tickets = [];
  const valid = record => (
    Array.isArray(record?.evidence_ids)
    && record.evidence_ids.length > 0
    && record.evidence_ids.every(id => validIds.has(id))
  );
  const reject = (label, record) => {
    tickets.push(ticket({
      record: label,
      reason_code: 'v7_record_evidence_unavailable',
      evidence_ids: Array.isArray(record?.evidence_ids)
        ? [...new Set(record.evidence_ids)].sort()
        : [],
    }));
  };
  const filtered = emptyExtraction(extraction.snapshot_hash);
  filtered.evidence_spans = structuredClone(extraction.evidence_spans);
  for (const [index, concept] of (
    extraction.concepts ?? []
  ).entries()) {
    const label = recordLabel('concepts', concept, index);
    if (!valid(concept)) {
      reject(label, concept);
      continue;
    }
    const claims = [];
    for (const [claimIndex, claim] of (
      concept.baseline_claims ?? []
    ).entries()) {
      if (valid(claim)) {
        claims.push(structuredClone(claim));
      } else {
        reject(
          recordLabel(
            'baseline_claims',
            claim,
            claimIndex,
            concept.concept_key,
          ),
          claim,
        );
      }
    }
    filtered.concepts.push({
      ...structuredClone(concept),
      baseline_claims: claims,
    });
  }
  for (const [collection, records] of collectionRecords(extraction)) {
    for (const [index, record] of records.entries()) {
      if (valid(record)) {
        filtered[collection].push(structuredClone(record));
      } else {
        reject(recordLabel(collection, record, index), record);
      }
    }
  }
  if (
    extraction.active_scene !== null
    && extraction.active_scene !== undefined
  ) {
    if (valid(extraction.active_scene)) {
      filtered.active_scene = structuredClone(extraction.active_scene);
    } else {
      reject('active_scene', extraction.active_scene);
    }
  }
  return { extraction: filtered, tickets };
}

export function compileStaticLoreV7Artifact({
  extraction,
  sourceUnits = [],
  aggregate,
} = {}) {
  if (
    extraction?.schema !== V7_EXTRACTION_SCHEMA
    || extraction.snapshot_hash !== aggregate?.snapshot_hash
  ) {
    throw new TypeError('Static Lore v7 artifact contract is invalid.');
  }
  const evidence = validV7EvidenceSpans(extraction, sourceUnits);
  const records = filterV7RecordsByEvidence(
    {
      ...structuredClone(extraction),
      evidence_spans: evidence.spans,
    },
    new Set(evidence.spans.map(span => span.evidence_id)),
  );
  const isolated = isolatedSemanticPatch({
    extraction: records.extraction,
    sourceUnits,
    aggregate,
  });
  let harnessed;
  try {
    harnessed = harnessStaticLoreBatchEvidence({
      extraction: isolated.raw,
      sourceUnits,
      existingConceptKeys: aggregate.concepts.map(
        concept => concept.concept_key,
      ),
      existingConcepts: aggregate.concepts,
    });
  } catch (error) {
    harnessed = {
      extraction: isolated.normalized.extraction,
      warnings: isolated.normalized.warnings,
      non_story_evidence: [],
    };
  }
  const provisionalSettlement = settleStaticLoreSourceUnits({
    extraction: isolated.raw,
    normalizedExtraction: harnessed.extraction,
    sourceUnits,
    nonStoryEvidence: harnessed.non_story_evidence,
  });
  const mergeIsolated = isolateMergeablePatch({
    extraction: provisionalSettlement.extraction,
    aggregate,
    allowedSourceRefs: sourceUnits.map(unit => unit.ref),
    atomIndex: null,
  });
  const settled = settleStaticLoreSourceUnits({
    extraction: isolated.raw,
    normalizedExtraction: mergeIsolated.extraction,
    sourceUnits,
    nonStoryEvidence: harnessed.non_story_evidence,
  });
  const compilerTickets = [
    ...evidence.tickets,
    ...records.tickets,
    ...isolated.tickets,
    ...mergeIsolated.tickets,
  ];
  const coverageTickets = settled.settlements.flatMap(entry => (
    entry.state === 'owned'
      ? []
      : [ticket({
          source_unit_ref: entry.source_unit_ref,
          reason_code: 'v7_source_unit_incomplete',
          uncovered_non_whitespace_count:
            entry.uncovered_non_whitespace_count,
        })]
  ));
  const offlineTickets = [
    ...compilerTickets,
    ...coverageTickets,
  ].map(item => ({
    ...structuredClone(item),
    disposition: 'unresolved_offline',
  }));
  const ledgerBody = {
    schema: 'mnemosyne.static-lore-v7-adapter-ledger.v1',
    settlements: settled.settlements,
    offline_tickets: offlineTickets,
  };
  return {
    schema: 'mnemosyne.static-lore-compile-result.v1',
    accepted_delta: mergeIsolated.extraction,
    accepted_non_story_evidence:
      structuredClone(harnessed.non_story_evidence ?? []),
    aggregate: mergeIsolated.aggregate,
    gap_tickets: [],
    offline_tickets: offlineTickets,
    settlements: settled.settlements,
    warnings: [
      ...harnessed.warnings,
      ...settled.warnings,
      ...mergeIsolated.warnings,
    ],
    round_terminal: true,
    ledger_hash: sha256(canonicalJson(ledgerBody)),
  };
}
