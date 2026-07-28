import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  normalizeStaticLoreBatchEvidence,
  resolveStaticLoreEvidenceSpans,
} from './static-lore-evidence.js';
import {
  classifyStaticLoreControlUnit,
  classifyStaticLoreListMarkerEvidenceSpan,
  classifyStaticLoreStructuralEvidenceSpan,
  harnessStaticLoreControlBatch,
} from './static-lore-control-units.js';

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
        : classifyStaticLoreStructuralEvidenceSpan({
          unit,
          quote: span.quote,
          sourceStart,
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
    const markup = new Uint8Array(text.length);
    const expression = /<\/?[a-z_][a-z0-9_-]*\b[^>]*>/giu;
    for (const match of text.matchAll(expression)) {
      markup.fill(1, match.index, match.index + match[0].length);
    }
    const listMarkers = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      if (!/^[-+*]$/u.test(text[index])) continue;
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      if (
        /^[\t ]*$/u.test(text.slice(lineStart, index))
        && /[\t ]/u.test(text[index + 1] ?? '')
      ) {
        listMarkers[index] = 1;
      }
    }
    let ordinal = 0;
    for (let start = 0; start < text.length;) {
      if (
        covered[start]
        || (!markup[start] && !listMarkers[start])
        || /\s/u.test(text[start])
      ) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (
        end < text.length
        && !covered[end]
        && (
          markup[end]
          || listMarkers[end]
        )
      ) {
        end += 1;
      }
      const quote = text.slice(start, end);
      const classification = (
        classifyStaticLoreStructuralEvidenceSpan({
          unit,
          quote,
          sourceStart: start,
        })
        ?? classifyStaticLoreListMarkerEvidenceSpan({
          unit,
          quote,
          sourceStart: start,
        })
      );
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
      warnings.push({
        code: 'local_control_evidence_synthesized',
        record: `evidence_span:${evidenceId}`,
        reason: classification.control_kind
          === 'character_description_markup'
          ? 'uncovered_character_description_markup'
          : 'uncovered_markdown_list_marker',
        evidence_id: evidenceId,
      });
      start = end;
    }
  }
  return {
    evidence: accepted,
    warnings,
  };
}

export function harnessStaticLoreBatchEvidence(input = {}) {
  const normalized = normalizeStaticLoreBatchEvidence(input);
  const controlHarnessed = harnessStaticLoreControlBatch({
    normalizedExtraction: normalized.extraction,
    sourceUnits: input.sourceUnits,
  });
  const exampleHarnessed = harnessUnmappedExampleClaims({
    extraction: input.extraction,
    normalizedExtraction: controlHarnessed.extraction,
    sourceUnits: input.sourceUnits,
    existingConceptKeys: input.existingConceptKeys,
  });
  const nonStory = classifyNonStoryEvidence({
    extraction: input.extraction,
    sourceUnits: input.sourceUnits,
  });
  return {
    extraction: exampleHarnessed.extraction,
    warnings: [
      ...normalized.warnings,
      ...controlHarnessed.warnings,
      ...exampleHarnessed.warnings,
      ...nonStory.warnings,
    ],
    non_story_evidence: nonStory.evidence,
  };
}
