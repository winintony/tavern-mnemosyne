import {
  characterDescriptionEvidenceMode,
} from './static-lore-evidence-zones.js';

const CLAIM_KINDS = new Set([
  'fact',
  'behavior_rule',
  'conditional_rule',
  'voice_pattern',
  'setting_rule',
]);
const PAST_EVENT_MARKERS = [
  /\bonce\b/iu,
  /\bpreviously\b/iu,
  /\balready\b/iu,
  /\u66fe/iu,
  /\u5df2\u7ecf/iu,
];

function normalizedText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function normalizedTypographicQuotes(value) {
  return value.replace(/[‘’“”]/gu, character => (
    character === '‘' || character === '’' ? "'" : '"'
  ));
}

function unitText(unit) {
  if (typeof unit?.data === 'string') return unit.data;
  if (typeof unit?.data?.content === 'string') return unit.data.content;
  return JSON.stringify(unit?.data ?? null);
}

function matchingOffsets(text, quote) {
  const offsets = [];
  let offset = text.indexOf(quote);
  while (offset >= 0) {
    offsets.push(offset);
    offset = text.indexOf(quote, offset + 1);
  }
  return offsets;
}

function leadingWhitespaceMatches(text, quote) {
  if (quote.startsWith('\n') || quote.endsWith('\n')) return [];
  const textLines = text.split('\n');
  const quoteLines = quote.split('\n');
  if (quoteLines.length > textLines.length) return [];
  const withoutLeadingWhitespace = line => line.replace(/^[\t ]*/u, '');
  if (quoteLines.every(line => !withoutLeadingWhitespace(line))) return [];

  const lineOffsets = [];
  let nextOffset = 0;
  for (const line of textLines) {
    lineOffsets.push(nextOffset);
    nextOffset += line.length + 1;
  }

  const matches = [];
  for (
    let lineIndex = 0;
    lineIndex <= textLines.length - quoteLines.length;
    lineIndex += 1
  ) {
    const sourceLines = textLines.slice(
      lineIndex,
      lineIndex + quoteLines.length,
    );
    if (!sourceLines.every((line, index) => (
      withoutLeadingWhitespace(line)
      === withoutLeadingWhitespace(quoteLines[index])
    ))) {
      continue;
    }
    if (sourceLines.every((line, index) => line === quoteLines[index])) {
      continue;
    }
    matches.push({
      offset: lineOffsets[lineIndex],
      quote: sourceLines.join('\n'),
    });
  }
  return matches;
}

function permutedFullLineMatches(text, quote) {
  if (quote.startsWith('\n') || quote.endsWith('\n')) return [];
  const textLines = text.split('\n');
  const quoteLines = quote.split('\n');
  if (
    quoteLines.length < 2
    || quoteLines.some(line => line.length === 0)
  ) {
    return [];
  }

  const lineOffsets = [];
  const indexesByLine = new Map();
  let nextOffset = 0;
  for (const [index, line] of textLines.entries()) {
    lineOffsets.push(nextOffset);
    nextOffset += line.length + 1;
    const indexes = indexesByLine.get(line) ?? [];
    indexes.push(index);
    indexesByLine.set(line, indexes);
  }

  const sourceIndexes = [];
  for (const line of quoteLines) {
    const indexes = indexesByLine.get(line) ?? [];
    if (indexes.length !== 1) return [];
    sourceIndexes.push(indexes[0]);
  }
  if (new Set(sourceIndexes).size !== sourceIndexes.length) return [];

  const sortedIndexes = [...sourceIndexes].sort((left, right) => left - right);
  if (!sortedIndexes.every((index, position) => (
    position === 0 || index === sortedIndexes[position - 1] + 1
  ))) {
    return [];
  }
  if (sourceIndexes.every((index, position) => index === sortedIndexes[position])) {
    return [];
  }

  return [{
    offset: lineOffsets[sortedIndexes[0]],
    quote: sortedIndexes.map(index => textLines[index]).join('\n'),
  }];
}

function evidenceMatch(
  unit,
  quote,
  sourceStart = null,
  sourceEnd = null,
) {
  const text = normalizedText(unitText(unit));
  const normalizedQuote = normalizedText(quote);
  if (!normalizedQuote.trim()) {
    throw new Error('Static Lore evidence quote must not be empty.');
  }
  const hasServerCoordinates = (
    Number.isInteger(sourceStart)
    && Number.isInteger(sourceEnd)
  );
  if (
    hasServerCoordinates
    && (
      sourceStart < 0
      || sourceEnd <= sourceStart
      || sourceEnd > text.length
      || text.slice(sourceStart, sourceEnd) !== normalizedQuote
    )
  ) {
    throw new TypeError(
      `Static Lore evidence coordinates are invalid in ${unit.ref}.`,
    );
  }
  let offsets = hasServerCoordinates
    ? [sourceStart]
    : matchingOffsets(text, normalizedQuote);
  let resolvedQuote = normalizedQuote;
  let typographicQuoteNormalized = false;
  let leadingWhitespaceNormalized = false;
  let permutedFullLinesNormalized = false;
  if (!hasServerCoordinates && offsets.length > 1) {
    throw new Error(
      `Static Lore evidence quote is ambiguous in ${unit.ref}.`,
    );
  }
  if (!hasServerCoordinates && offsets.length === 0) {
    offsets = matchingOffsets(
      normalizedTypographicQuotes(text),
      normalizedTypographicQuotes(normalizedQuote),
    );
    if (offsets.length === 0) {
      const whitespaceMatches = leadingWhitespaceMatches(
        text,
        normalizedQuote,
      );
      if (whitespaceMatches.length === 0) {
        const permutedMatches = permutedFullLineMatches(
          text,
          normalizedQuote,
        );
        if (permutedMatches.length === 0) {
          throw new Error(`Static Lore evidence quote was not found in ${unit.ref}.`);
        }
        offsets = [permutedMatches[0].offset];
        resolvedQuote = permutedMatches[0].quote;
        permutedFullLinesNormalized = true;
      } else {
        if (whitespaceMatches.length !== 1) {
          throw new Error(
            `Static Lore evidence quote is ambiguous after leading-whitespace normalization in ${unit.ref}.`,
          );
        }
        offsets = [whitespaceMatches[0].offset];
        resolvedQuote = whitespaceMatches[0].quote;
        leadingWhitespaceNormalized = true;
      }
    } else {
      if (offsets.length !== 1) {
        throw new Error(
          `Static Lore evidence quote is ambiguous after typographic quote normalization in ${unit.ref}.`,
        );
      }
      resolvedQuote = text.slice(
        offsets[0],
        offsets[0] + normalizedQuote.length,
      );
      typographicQuoteNormalized = true;
    }
  }

  const field = String(unit.unit_id ?? '').split(':part:')[0];
  const modes = new Set();
  for (const offset of offsets) {
    if (field === 'first_mes') {
      modes.add('opening_example');
      continue;
    }
    if (field === 'creator_notes') {
      modes.add('guidance');
      continue;
    }
    if (
      unit.source_kind !== 'character_card'
      || field !== 'description'
    ) {
      modes.add('authoritative');
      continue;
    }
    const end = Math.min(text.length, offset + resolvedQuote.length);
    for (let cursor = offset; cursor < end; cursor += 1) {
      if (/\s/u.test(text[cursor])) continue;
      modes.add(characterDescriptionEvidenceMode(text, cursor, {
        initialTag: unit.data?.evidence_tag_at_start ?? null,
        initialMode:
          unit.data?.evidence_mode_at_start
          ?? 'authoritative',
      }));
      if (modes.size > 1) break;
    }
  }
  if (modes.size !== 1) {
    throw new Error(
      `Static Lore evidence quote is ambiguous across evidence zones in ${unit.ref}.`,
    );
  }
  return {
    mode: [...modes][0],
    quote: resolvedQuote,
    sourceStart: offsets[0],
    sourceEnd: offsets[0] + resolvedQuote.length,
    typographicQuoteNormalized,
    leadingWhitespaceNormalized,
    permutedFullLinesNormalized,
  };
}

function evidenceSpanIndex(extraction, units) {
  if (!Array.isArray(extraction?.evidence_spans)) {
    throw new Error('Static Lore extraction requires evidence_spans.');
  }
  const sourceUnitsByIndex = new Map(
    [...units.values()].map((unit, index) => [
      Number(unit.source_index ?? index),
      unit,
    ]),
  );
  const spans = new Map();
  const warnings = [];
  for (const [index, item] of extraction.evidence_spans.entries()) {
    const label = `evidence_spans[${index}]`;
    if (
      typeof item?.evidence_id !== 'string'
      || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.evidence_id)
    ) {
      throw new Error(`${label} has an invalid evidence_id.`);
    }
    if (spans.has(item.evidence_id)) {
      throw new Error(`Static Lore evidence_id is duplicated: ${item.evidence_id}`);
    }
    if (
      !Number.isInteger(item.source_index)
      || item.source_index < 0
    ) {
      throw new Error(`${label} has an invalid source_index.`);
    }
    const unit = sourceUnitsByIndex.get(item.source_index);
    if (!unit) {
      throw new Error(`${label} references another batch.`);
    }
    let match;
    try {
      match = evidenceMatch(
        unit,
        item.quote,
        item.source_start ?? null,
        item.source_end ?? null,
      );
    } catch (error) {
      throw new Error(`${label}: ${error.message}`, {
        cause: error,
      });
    }
    spans.set(item.evidence_id, {
      evidence: {
        source_ref: unit.ref,
        quote: match.quote,
        ...(Number.isInteger(item.source_start)
          ? {
            source_start: match.sourceStart,
            source_end: match.sourceEnd,
          }
          : {}),
      },
      mode: match.mode,
    });
    if (match.typographicQuoteNormalized) {
      warnings.push(warning(
        'evidence_quote_normalized',
        `evidence_span:${item.evidence_id}`,
        'typographic_quote_normalized_to_source',
      ));
    }
    if (match.leadingWhitespaceNormalized) {
      warnings.push(warning(
        'evidence_quote_normalized',
        `evidence_span:${item.evidence_id}`,
        'leading_whitespace_normalized_to_source',
      ));
    }
    if (match.permutedFullLinesNormalized) {
      warnings.push(warning(
        'evidence_quote_normalized',
        `evidence_span:${item.evidence_id}`,
        'permuted_full_lines_normalized_to_source',
      ));
    }
  }
  return { spans, warnings };
}

export function resolveStaticLoreEvidenceSpans({
  extraction,
  sourceUnits,
} = {}) {
  const units = new Map(
    (sourceUnits ?? []).map(unit => [unit.ref, unit]),
  );
  const resolved = evidenceSpanIndex(extraction, units);
  return {
    spans: [...resolved.spans].map(([evidenceId, span]) => ({
      evidence_id: evidenceId,
      source_ref: span.evidence.source_ref,
      quote: span.evidence.quote,
      ...(Number.isInteger(span.evidence.source_start)
        ? {
          source_start: span.evidence.source_start,
          source_end: span.evidence.source_end,
        }
        : {}),
      evidence_mode: span.mode,
    })),
    warnings: structuredClone(resolved.warnings),
  };
}

function recordEvidence(record, spans, label) {
  if (!Array.isArray(record.evidence_ids) || record.evidence_ids.length === 0) {
    throw new Error(`${label} requires evidence_ids.`);
  }
  const seen = new Set();
  const modes = [];
  const evidence = [];
  const sourceRefs = [];
  for (const [index, evidenceId] of record.evidence_ids.entries()) {
    if (
      typeof evidenceId !== 'string'
      || seen.has(evidenceId)
    ) {
      throw new Error(`${label}.evidence_ids[${index}] is invalid or duplicated.`);
    }
    seen.add(evidenceId);
    const span = spans.get(evidenceId);
    if (!span) {
      throw new Error(`${label}.evidence_ids[${index}] is not defined.`);
    }
    modes.push(span.mode);
    evidence.push(structuredClone(span.evidence));
    sourceRefs.push(span.evidence.source_ref);
  }
  const resolved = structuredClone(record);
  delete resolved.evidence_ids;
  resolved.evidence = evidence;
  resolved.source_refs = [...new Set(sourceRefs)];
  return { modes, record: resolved };
}

function hasAuthoritativeEvidence(modes) {
  return modes.includes('authoritative');
}

// Guidance-zone material is exactly what behavior_rule exists for, but models
// keep filing it as a fact and the whole span goes down with the refused
// claim. The zone is server-derived and the demotion is deterministic, so the
// server does what the retry correction asks the model to do instead of
// charging for another attempt. Only fact is coerced, and only where guidance
// evidence is present without any authoritative evidence to justify a fact.
function coercedClaimKind(claim, modes) {
  if (
    claim?.claim_kind !== 'fact'
    || hasAuthoritativeEvidence(modes)
    || !modes.includes('guidance')
  ) {
    return null;
  }
  return 'behavior_rule';
}

function claimIsEligible(claim, modes) {
  if (!CLAIM_KINDS.has(claim?.claim_kind)) {
    throw new Error(`Unsupported Static Lore claim_kind: ${claim?.claim_kind}`);
  }
  if (hasAuthoritativeEvidence(modes)) return true;
  if (modes.every(mode => mode === 'example')) {
    return claim.claim_kind === 'voice_pattern';
  }
  return ['behavior_rule', 'conditional_rule', 'voice_pattern']
    .includes(claim.claim_kind);
}

function rewritesIllustrationAsPastEvent(claim) {
  const evidenceText = (claim.evidence ?? [])
    .map(item => normalizedText(item?.quote))
    .join('\n');
  if (
    !/(?:\bfor example\b|\be\.g\.|\u4f8b\u5982|\u6bd4\u5982)/iu
      .test(evidenceText)
  ) {
    return false;
  }
  const claimText = normalizedText(claim.claim);
  return PAST_EVENT_MARKERS.some(marker => (
    marker.test(claimText) && !marker.test(evidenceText)
  ));
}

function restoreEvidenceTemplatePlaceholders(claim) {
  const evidenceText = (claim.evidence ?? [])
    .map(item => normalizedText(item?.quote))
    .join('\n');
  let claimText = normalizedText(claim.claim);
  const restored = [];
  for (const {
    placeholder,
    barePattern,
    replacePattern,
  } of [
    {
      placeholder: '{{user}}',
      barePattern: /\buser\b/iu,
      replacePattern: /\buser\b/giu,
    },
    {
      placeholder: '{{char}}',
      barePattern: /\bchar\b/iu,
      replacePattern: /\bchar\b/giu,
    },
  ]) {
    if (
      evidenceText.includes(placeholder)
      && !claimText.includes(placeholder)
      && barePattern.test(claimText)
    ) {
      claimText = claimText.replace(replacePattern, placeholder);
      restored.push(placeholder);
    }
  }
  return {
    record: {
      ...claim,
      claim: claimText,
    },
    restored,
  };
}

function structuralEvidenceIsEligible(modes) {
  return modes.every(mode => mode === 'authoritative');
}

function definitionEvidenceIsEligible(modes) {
  return modes.every(mode => (
    mode === 'authoritative'
    || mode === 'guidance'
  ));
}

function warning(code, label, reason) {
  return { code, record: label, reason };
}

export function normalizeStaticLoreBatchEvidence({
  extraction,
  sourceUnits,
  existingConceptKeys = [],
  existingConcepts = [],
} = {}) {
  const units = new Map((sourceUnits ?? []).map(unit => [unit.ref, unit]));
  const evidenceIndex = evidenceSpanIndex(extraction, units);
  const { spans } = evidenceIndex;
  const existingByKey = new Map(
    existingConcepts.map(concept => [concept.concept_key, concept]),
  );
  const existing = new Set([
    ...existingConceptKeys,
    ...existingByKey.keys(),
  ]);
  const warnings = [...evidenceIndex.warnings];
  const concepts = [];

  for (const concept of extraction.concepts ?? []) {
    const label = `concept:${concept?.concept_key ?? 'unknown'}`;
    const resolvedConcept = recordEvidence(concept, spans, label);
    const { modes } = resolvedConcept;
    const hasAuthoritative = hasAuthoritativeEvidence(modes);
    const links = concept.links ?? [];
    const aboutTarget = (
      !existing.has(concept.concept_key)
      && !hasAuthoritative
      && concept.type === 'character_cognition'
      && links.length === 1
      && links[0]?.relation === 'about'
    )
      ? existingByKey.get(links[0].target_key)
      : null;
    const reparentTarget = aboutTarget?.type === 'character'
      ? aboutTarget
      : null;
    if (
      !existing.has(concept.concept_key)
      && !hasAuthoritative
      && !reparentTarget
    ) {
      warnings.push(warning(
        'evidence_record_quarantined',
        label,
        'new_concept_requires_authoritative_evidence',
      ));
      continue;
    }
    const claims = [];
    for (const [index, claim] of (concept.baseline_claims ?? []).entries()) {
      const claimLabel = `${label}:claim:${index}`;
      const resolvedClaim = recordEvidence(claim, spans, claimLabel);
      const claimModes = resolvedClaim.modes;
      const coercedKind = coercedClaimKind(claim, claimModes);
      const effectiveClaim = coercedKind
        ? { ...claim, claim_kind: coercedKind }
        : claim;
      if (coercedKind) {
        resolvedClaim.record.claim_kind = coercedKind;
        warnings.push({
          ...warning(
            'claim_kind_coerced_for_evidence_zone',
            claimLabel,
            'guidance_evidence_cannot_carry_a_fact',
          ),
          previous_claim_kind: claim.claim_kind,
          claim_kind: coercedKind,
        });
      }
      if (!claimIsEligible(effectiveClaim, claimModes)) {
        warnings.push(warning(
          'evidence_record_quarantined',
          claimLabel,
          'claim_kind_not_allowed_for_evidence_zone',
        ));
        continue;
      }
      const restoredClaim = restoreEvidenceTemplatePlaceholders(
        resolvedClaim.record,
      );
      if (restoredClaim.restored.length > 0) {
        warnings.push({
          ...warning(
            'evidence_template_placeholder_restored',
            claimLabel,
            'template_placeholder_restored_from_evidence',
          ),
          placeholders: restoredClaim.restored,
        });
      }
      if (rewritesIllustrationAsPastEvent(restoredClaim.record)) {
        warnings.push(warning(
          'evidence_record_quarantined',
          claimLabel,
          'illustration_rewritten_as_past_event',
        ));
        continue;
      }
      claims.push(restoredClaim.record);
    }
    if (!hasAuthoritative && claims.length === 0) {
      continue;
    }
    if (reparentTarget) {
      warnings.push({
        ...warning(
          'evidence_claims_reparented',
          label,
          'guidance_character_cognition_reparented_to_about_target',
        ),
        target_key: reparentTarget.concept_key,
      });
    } else if (!hasAuthoritative) {
      warnings.push(warning(
        'evidence_concept_metadata_quarantined',
        label,
        'non_authoritative_concept_metadata',
      ));
    }
    const conceptRecord = reparentTarget
      ? {
        ...resolvedConcept.record,
        concept_key: reparentTarget.concept_key,
        type: reparentTarget.type,
        title: reparentTarget.title,
        slug: reparentTarget.slug,
        description: reparentTarget.description,
      }
      : resolvedConcept.record;
    concepts.push({
      ...conceptRecord,
      ...(!hasAuthoritative
        ? {
          merge_mode: 'claims_only',
          aliases: [],
          tags: [],
          links: [],
          facets: {},
        }
        : {}),
      baseline_claims: claims,
    });
  }

  const acceptedKeys = new Set([
    ...existing,
    ...concepts.map(concept => concept.concept_key),
  ]);
  for (const concept of concepts) {
    concept.links = (concept.links ?? []).filter(link => {
      if (acceptedKeys.has(link.target_key)) return true;
      warnings.push(warning(
        'evidence_link_quarantined',
        `concept:${concept.concept_key}`,
        'target_concept_was_quarantined',
      ));
      return false;
    });
  }

  const filterRecords = (records, collection, eligible) => (
    (records ?? []).flatMap((record, index) => {
      const label = `${collection}:${index}`;
      const resolved = recordEvidence(record, spans, label);
      if (eligible(resolved.modes)) return [resolved.record];
      warnings.push(warning(
        'evidence_record_quarantined',
        label,
        'evidence_zone_not_allowed_for_record_type',
      ));
      return [];
    })
  );
  const currentState = filterRecords(
    extraction.current_state,
    'current_state',
    structuralEvidenceIsEligible,
  ).filter((record, index) => {
    if (acceptedKeys.has(record.entity_key)) return true;
    warnings.push(warning(
      'evidence_record_quarantined',
      `current_state:${index}`,
      'entity_concept_was_quarantined',
    ));
    return false;
  });
  const topology = filterRecords(
    extraction.topology,
    'topology',
    structuralEvidenceIsEligible,
  ).filter((record, index) => {
    if (
      acceptedKeys.has(record.entity_key)
      && acceptedKeys.has(record.parent_key)
    ) {
      return true;
    }
    warnings.push(warning(
      'evidence_record_quarantined',
      `topology:${index}`,
      'topology_concept_was_quarantined',
    ));
    return false;
  });

  let activeScene = extraction.active_scene ?? null;
  if (activeScene !== null) {
    const resolved = recordEvidence(activeScene, spans, 'active_scene');
    if (!structuralEvidenceIsEligible(resolved.modes)) {
      warnings.push(warning(
        'evidence_record_quarantined',
        'active_scene',
        'active_scene_requires_authoritative_evidence',
      ));
      activeScene = null;
    } else {
      activeScene = resolved.record;
    }
  }

  const normalizedExtraction = structuredClone(extraction);
  delete normalizedExtraction.evidence_spans;
  return {
    extraction: {
      ...normalizedExtraction,
      concepts,
      attribute_definitions: filterRecords(
        extraction.attribute_definitions,
        'attribute_definitions',
        definitionEvidenceIsEligible,
      ),
      progression_tracks: filterRecords(
        extraction.progression_tracks,
        'progression_tracks',
        definitionEvidenceIsEligible,
      ),
      current_state: currentState,
      topology,
      active_scene: activeScene,
    },
    warnings,
  };
}
