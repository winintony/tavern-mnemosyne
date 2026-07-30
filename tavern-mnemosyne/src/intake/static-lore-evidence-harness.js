import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  normalizeStaticLoreBatchEvidence,
  resolveStaticLoreEvidenceSpans,
} from './static-lore-evidence.js';
import {
  classifyStaticLoreControlUnit,
  classifyStaticLoreListMarkerEvidenceSpan,
  classifyStaticLoreSampleAnnotationEvidenceSpan,
  classifyStaticLoreUncitedTitleEvidenceSpan,
  classifyStaticLoreStructuralEvidenceSpan,
  classifyStaticLoreStructuralLineEvidenceSpan,
  classifyStaticLoreBlockTitleEvidenceSpan,
  classifyStaticLoreIdentityValueEvidenceSpan,
  classifyStaticLoreValueReferenceEvidenceSpan,
  classifyStaticLoreSymbolRunEvidenceSpan,
  harnessStaticLoreControlBatch,
  staticLoreStructuralExemptMask,
  staticLoreLineListMarker,
  staticLoreStructuralLineSpan,
  staticLoreBlockTitleValueKind,
  staticLoreValueLineSpan,
  staticLoreValueReferenceKind,
} from './static-lore-control-units.js';

// Ordered: the narrower classifier wins, so a list marker keeps the
// classification it has always had instead of degrading into a symbol run.
// The sample-annotation classifier is deliberately absent: a note the model
// can still cite must stay the model's to evidence. It is reached only after
// every citing record has been refused.
const CONTROL_CLASSIFIERS = [
  classifyStaticLoreStructuralEvidenceSpan,
  classifyStaticLoreListMarkerEvidenceSpan,
  classifyStaticLoreStructuralLineEvidenceSpan,
  classifyStaticLoreBlockTitleEvidenceSpan,
  classifyStaticLoreIdentityValueEvidenceSpan,
  classifyStaticLoreValueReferenceEvidenceSpan,
  classifyStaticLoreSymbolRunEvidenceSpan,
];
const CONTROL_WARNING_REASONS = new Map([
  [
    'character_description_markup',
    'uncovered_character_description_markup',
  ],
  ['source_markup_tag', 'uncovered_source_markup_tag'],
  ['markdown_list_marker', 'uncovered_markdown_list_marker'],
  ['heading_label_line', 'uncovered_heading_label_line'],
  ['value_label_prefix', 'uncovered_value_label_prefix'],
  ['macro_value', 'uncovered_macro_value'],
  ['concept_reference_value', 'uncovered_concept_reference_value'],
  ['block_title_value', 'uncovered_block_title_value'],
  ['markdown_heading_line', 'uncovered_markdown_heading_line'],
  ['bracketed_label_line', 'uncovered_bracketed_label_line'],
  ['typographic_symbol_run', 'uncovered_typographic_symbol_run'],
]);

function classifyControlSpan({
  unit,
  quote,
  sourceStart,
  knownConceptNames = [],
}) {
  const unitControl = classifyStaticLoreControlUnit(unit);
  const sourceText = normalizedSourceText(sourceUnitText(unit));
  if (
    unitControl
    && Number.isInteger(sourceStart)
    && sourceText.slice(
      sourceStart,
      sourceStart + quote.length,
    ).trim() === sourceText.trim()
  ) {
    return unitControl;
  }
  if (knownConceptNames.includes(quote.trim())) {
    const titleControl = classifyStaticLoreUncitedTitleEvidenceSpan({
      unit,
      quote,
      sourceStart,
    });
    if (titleControl) return titleControl;
  }
  for (const classify of CONTROL_CLASSIFIERS) {
    const classification = classify({
      unit,
      quote,
      sourceStart,
      knownConceptNames,
    });
    if (classification) return classification;
  }
  return null;
}

// Every non-whitespace character has to belong to someone. These classes are
// the server's own account of the characters that carry no story: emphasis
// and rule glyphs, list bullets, and bare section labels. Model evidence owns
// the rest, and anything unclassified still fails the batch.
function controlClassMap(text, knownConceptNames = []) {
  const controlClass = new Array(text.length).fill(null);
  const markup = /<\/?[a-z_][a-z0-9_-]*\b[^>]*>/giu;
  for (const match of text.matchAll(markup)) {
    controlClass.fill('markup', match.index, match.index + match[0].length);
  }
  for (let lineStart = 0; lineStart <= text.length;) {
    const lineBreak = text.indexOf('\n', lineStart);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    const marker = staticLoreLineListMarker(text.slice(lineStart, lineEnd));
    if (marker) {
      for (
        let index = lineStart + marker.start;
        index < lineStart + marker.end;
        index += 1
      ) {
        controlClass[index] ??= 'list_marker';
      }
    }
    if (lineBreak < 0) break;
    lineStart = lineBreak + 1;
  }
  for (let lineStart = 0; lineStart <= text.length;) {
    const lineBreak = text.indexOf('\n', lineStart);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    const line = text.slice(lineStart, lineEnd);
    const structural = staticLoreStructuralLineSpan(line);
    if (structural) {
      for (
        let index = lineStart + structural.start;
        index < lineStart + structural.end;
        index += 1
      ) {
        controlClass[index] ??= 'structural_line';
      }
    }
    const valueSpan = staticLoreValueLineSpan(line);
    if (
      valueSpan
      && (
        staticLoreValueReferenceKind(valueSpan.value, knownConceptNames)
        || staticLoreBlockTitleValueKind(text, lineStart)
      )
    ) {
      for (
        let index = lineStart + valueSpan.start;
        index < lineStart + valueSpan.end;
        index += 1
      ) {
        controlClass[index] ??= 'reference_value';
      }
    }
    if (lineBreak < 0) break;
    lineStart = lineBreak + 1;
  }
  const exempt = staticLoreStructuralExemptMask(text);
  for (let index = 0; index < text.length; index += 1) {
    if (
      controlClass[index] !== null
      || exempt[index]
      || /\s/u.test(text[index])
    ) {
      continue;
    }
    controlClass[index] = 'symbol_run';
  }
  return controlClass;
}

export function staticLoreEvidenceKey(sourceRef, quote) {
  return canonicalJson([sourceRef, quote]);
}

function sourceUnitText(unit) {
  if (typeof unit?.data === 'string') return unit.data;
  if (typeof unit?.data?.content === 'string') return unit.data.content;
  return JSON.stringify(unit?.data ?? null);
}

function normalizedSourceText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function acceptedClaimEvidence(extraction) {
  const accepted = new Set();
  for (const concept of extraction.concepts ?? []) {
    for (const claim of concept.baseline_claims ?? []) {
      for (const evidence of claim.evidence ?? []) {
        accepted.add(staticLoreEvidenceKey(
          evidence.source_ref,
          evidence.quote,
        ));
      }
    }
  }
  return accepted;
}

// A concept may cite its own identity quote instead of hanging it on a claim,
// and both spellings are legal output. Only claims become retrievable memory,
// though, so a quote left at concept level would pass intake and then have
// nothing for the publish gate to verify against. Preserving it verbatim as a
// claim on the concept that already cited it keeps both gates looking at the
// same record, and the warning keeps the synthesis auditable.
function harnessConceptCitedClaims({
  extraction,
  normalizedExtraction,
  sourceUnits,
  nonStoryEvidence,
}) {
  const result = structuredClone(normalizedExtraction);
  const claimed = acceptedClaimEvidence(result);
  const structural = new Set(nonStoryEvidence.map(evidence => (
    staticLoreEvidenceKey(evidence.source_ref, evidence.quote)
  )));
  const evidenceIds = new Map(
    resolveStaticLoreEvidenceSpans({ extraction, sourceUnits }).spans.map(
      span => [
        staticLoreEvidenceKey(span.source_ref, span.quote),
        span.evidence_id,
      ],
    ),
  );
  const warnings = [];
  for (const concept of result.concepts ?? []) {
    for (const evidence of concept.evidence ?? []) {
      const key = staticLoreEvidenceKey(
        evidence.source_ref,
        evidence.quote,
      );
      if (claimed.has(key) || structural.has(key)) continue;
      concept.baseline_claims = [
        ...(concept.baseline_claims ?? []),
        {
          claim: evidence.quote,
          claim_kind: 'fact',
          evidence: [structuredClone(evidence)],
          source_refs: [evidence.source_ref],
        },
      ];
      claimed.add(key);
      warnings.push({
        code: 'evidence_claim_synthesized',
        record: `concept:${concept.concept_key}:claim:harness`,
        reason: 'concept_evidence_preserved_verbatim',
        evidence_id: evidenceIds.get(key) ?? null,
        target_key: concept.concept_key,
      });
    }
  }
  return {
    extraction: result,
    warnings,
  };
}

function harnessUnmappedExampleClaims({
  extraction,
  normalizedExtraction,
  sourceUnits,
  existingConceptKeys = [],
}) {
  const result = structuredClone(normalizedExtraction);
  const acceptedEvidence = acceptedClaimEvidence(result);
  const establishedKeys = new Set(existingConceptKeys);
  const warnings = [];
  const resolved = resolveStaticLoreEvidenceSpans({
    extraction,
    sourceUnits,
  });
  for (const span of resolved.spans) {
    const key = staticLoreEvidenceKey(span.source_ref, span.quote);
    if (acceptedEvidence.has(key)) continue;
    if (
      span.evidence_mode !== 'example'
      && span.evidence_mode !== 'opening_example'
    ) {
      continue;
    }
    const targets = (result.concepts ?? []).filter(concept => (
      concept.type === 'character'
      && concept.merge_mode === 'claims_only'
      && establishedKeys.has(concept.concept_key)
      && concept.source_refs?.includes(span.source_ref)
      && (concept.baseline_claims?.length ?? 0) > 0
    ));
    if (targets.length !== 1) continue;
    const [target] = targets;
    target.baseline_claims.push({
      claim: span.quote,
      claim_kind: 'voice_pattern',
      evidence: [{
        source_ref: span.source_ref,
        quote: span.quote,
        ...(Number.isInteger(span.source_start)
          ? {
              source_start: span.source_start,
              source_end: span.source_end,
            }
          : {}),
      }],
      source_refs: [span.source_ref],
    });
    acceptedEvidence.add(key);
    warnings.push({
      code: 'evidence_claim_synthesized',
      record: `concept:${target.concept_key}:claim:harness`,
      reason: 'unmapped_example_span_preserved_verbatim',
      evidence_id: span.evidence_id,
      target_key: target.concept_key,
    });
  }
  return {
    extraction: result,
    warnings,
  };
}

function classifyNonStoryEvidence({
  extraction,
  sourceUnits,
  knownConceptNames = [],
  declaredLinks = new Map(),
  conceptKeysByTitle = new Map(),
}) {
  const unitsByRef = new Map(
    (sourceUnits ?? []).map(unit => [unit.ref, unit]),
  );
  const resolved = resolveStaticLoreEvidenceSpans({
    extraction,
    sourceUnits,
  });
  const accepted = resolved.spans.flatMap(span => {
    const unit = unitsByRef.get(span.source_ref);
    const text = normalizedSourceText(sourceUnitText(unit));
    const sourceStart = text.indexOf(span.quote);
    const unitControl = classifyStaticLoreControlUnit(unit);
    const classification = (
      (
        unitControl
        && sha256(span.quote) === unitControl.marker_hash
      )
        ? unitControl
        : classifyControlSpan({
          unit,
          quote: span.quote,
          sourceStart,
          knownConceptNames,
        })
    );
    return classification
      ? [{
        evidence_id: span.evidence_id,
        source_ref: span.source_ref,
        quote: span.quote,
        evidence_mode: span.evidence_mode,
        classification,
        source_start: sourceStart,
        source_end: sourceStart + span.quote.length,
        synthesized: false,
      }]
      : [];
  });
  const warnings = [];
  const rawIds = new Set(resolved.spans.map(span => span.evidence_id));
  for (const [sourceIndex, unit] of (sourceUnits ?? []).entries()) {
    const text = normalizedSourceText(sourceUnitText(unit));
    const covered = new Uint8Array(text.length);
    for (const span of resolved.spans.filter(candidate => (
      candidate.source_ref === unit.ref
    ))) {
      const start = text.indexOf(span.quote);
      covered.fill(1, start, start + span.quote.length);
    }
    const controlClass = controlClassMap(text, knownConceptNames);
    let ordinal = 0;
    for (let start = 0; start < text.length;) {
      if (
        covered[start]
        || controlClass[start] === null
        || /\s/u.test(text[start])
      ) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (
        end < text.length
        && !covered[end]
        && controlClass[end] === controlClass[start]
      ) {
        end += 1;
      }
      const quote = text.slice(start, end);
      const classification = classifyControlSpan({
        unit,
        quote,
        sourceStart: start,
        knownConceptNames,
      });
      if (!classification) {
        start = end;
        continue;
      }
      ordinal += 1;
      let evidenceId = `local_markup_${sourceIndex + 1}_${ordinal}`;
      while (rawIds.has(evidenceId)) {
        ordinal += 1;
        evidenceId = `local_markup_${sourceIndex + 1}_${ordinal}`;
      }
      rawIds.add(evidenceId);
      accepted.push({
        evidence_id: evidenceId,
        source_ref: unit.ref,
        quote,
        evidence_mode: 'structural',
        classification,
        source_start: start,
        source_end: end,
        synthesized: true,
      });
      const referencedKey = (
        classification.control_kind === 'concept_reference_value'
          ? conceptKeysByTitle.get(quote.trim()) ?? null
          : null
      );
      warnings.push({
        code: 'local_control_evidence_synthesized',
        record: `evidence_span:${evidenceId}`,
        reason: CONTROL_WARNING_REASONS.get(classification.control_kind),
        evidence_id: evidenceId,
        // A declared link is not required for the reference to be accounted
        // for, but whether one exists is worth keeping in the record.
        ...(referencedKey
          ? {
            referenced_concept_key: referencedKey,
            link_relation: declaredLinks.get(referencedKey) ?? null,
          }
          : {}),
      });
      start = end;
    }
  }
  return {
    evidence: accepted,
    warnings,
  };
}

// A span whose every citing record was refused has no accepted owner left. If
// the source line is a sample-block annotation, that is control text rather
// than story, so it is accounted for here instead of failing the paid batch
// over a modelling choice the correction text now steers away from. Spans in
// authoritative or example zones are deliberately excluded: real story content
// left without an owner must still fail.
function absorbOrphanedGuidanceSpans({
  extraction,
  normalizedExtraction,
  sourceUnits,
  nonStoryEvidence,
}) {
  const cited = new Set();
  const cite = record => {
    for (const evidence of record?.evidence ?? []) {
      cited.add(staticLoreEvidenceKey(evidence.source_ref, evidence.quote));
    }
  };
  for (const concept of normalizedExtraction.concepts ?? []) {
    cite(concept);
    for (const claim of concept.baseline_claims ?? []) cite(claim);
  }
  for (const collection of [
    'attribute_definitions',
    'progression_tracks',
    'current_state',
    'topology',
  ]) {
    for (const record of normalizedExtraction[collection] ?? []) cite(record);
  }
  cite(normalizedExtraction.active_scene);
  const accounted = new Set(nonStoryEvidence.map(evidence => (
    staticLoreEvidenceKey(evidence.source_ref, evidence.quote)
  )));
  const citedByModel = new Set();
  const walk = record => {
    if (!record || typeof record !== 'object') return;
    if (Array.isArray(record.evidence_ids)) {
      for (const id of record.evidence_ids) citedByModel.add(id);
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(extraction);

  const unitsByRef = new Map((sourceUnits ?? []).map(unit => [unit.ref, unit]));
  const evidence = [];
  const warnings = [];
  const resolved = resolveStaticLoreEvidenceSpans({ extraction, sourceUnits });
  for (const span of resolved.spans) {
    const key = staticLoreEvidenceKey(span.source_ref, span.quote);
    if (cited.has(key) || accounted.has(key)) continue;
    const unit = unitsByRef.get(span.source_ref);
    const text = normalizedSourceText(sourceUnitText(unit));
    const sourceStart = text.indexOf(span.quote);
    // Two ways a span ends up with no owner, kept apart in the record: every
    // record that claimed it was refused, or nothing ever claimed it.
    const orphanedByQuarantine = citedByModel.has(span.evidence_id);
    const classification = orphanedByQuarantine
      ? classifyStaticLoreSampleAnnotationEvidenceSpan({
        unit,
        quote: span.quote,
        sourceStart,
      })
      : classifyStaticLoreUncitedTitleEvidenceSpan({
        unit,
        quote: span.quote,
        sourceStart,
      });
    if (!classification) continue;
    accounted.add(key);
    evidence.push({
      evidence_id: span.evidence_id,
      source_ref: span.source_ref,
      quote: span.quote,
      evidence_mode: span.evidence_mode,
      classification,
      source_start: sourceStart,
      source_end: sourceStart + span.quote.length,
      synthesized: false,
    });
    warnings.push({
      code: 'local_control_evidence_synthesized',
      record: `evidence_span:${span.evidence_id}`,
      reason: orphanedByQuarantine
        ? 'guidance_span_orphaned_by_quarantine'
        : 'uncited_title_span_accounted',
      evidence_id: span.evidence_id,
    });
  }
  return { evidence, warnings };
}

export function harnessStaticLoreBatchEvidence(input = {}) {
  const normalized = normalizeStaticLoreBatchEvidence(input);
  const controlHarnessed = harnessStaticLoreControlBatch({
    normalizedExtraction: normalized.extraction,
    sourceUnits: input.sourceUnits,
  });
  const knownConcepts = [
    ...(input.existingConcepts ?? []),
    ...(normalized.extraction.concepts ?? []),
  ];
  const conceptKeysByTitle = new Map(
    knownConcepts
      .filter(concept => typeof concept?.title === 'string' && concept.title)
      .map(concept => [concept.title, concept.concept_key]),
  );
  const declaredLinks = new Map(
    (normalized.extraction.concepts ?? []).flatMap(concept => (
      (concept.links ?? []).map(link => [link.target_key, link.relation])
    )),
  );
  const nonStory = classifyNonStoryEvidence({
    extraction: input.extraction,
    sourceUnits: input.sourceUnits,
    knownConceptNames: [...conceptKeysByTitle.keys()],
    declaredLinks,
    conceptKeysByTitle,
  });
  const conceptHarnessed = harnessConceptCitedClaims({
    extraction: input.extraction,
    normalizedExtraction: controlHarnessed.extraction,
    sourceUnits: input.sourceUnits,
    nonStoryEvidence: nonStory.evidence,
  });
  const exampleHarnessed = harnessUnmappedExampleClaims({
    extraction: input.extraction,
    normalizedExtraction: conceptHarnessed.extraction,
    sourceUnits: input.sourceUnits,
    existingConceptKeys: input.existingConceptKeys,
  });
  const orphaned = absorbOrphanedGuidanceSpans({
    extraction: input.extraction,
    normalizedExtraction: exampleHarnessed.extraction,
    sourceUnits: input.sourceUnits,
    nonStoryEvidence: nonStory.evidence,
  });
  return {
    extraction: exampleHarnessed.extraction,
    warnings: [
      ...normalized.warnings,
      ...controlHarnessed.warnings,
      ...conceptHarnessed.warnings,
      ...exampleHarnessed.warnings,
      ...nonStory.warnings,
      ...orphaned.warnings,
    ],
    non_story_evidence: [
      ...nonStory.evidence,
      ...orphaned.evidence,
    ],
  };
}
