import { canonicalJson, sha256 } from '../contracts/hash.js';

export const STATIC_LORE_CONTROL_RECORD_KIND =
  'static_source_control_marker';
export const STATIC_LORE_CONTROL_DISPOSITION =
  'classified_non_story';

const CONTROL_CLASSIFICATION_SCHEMA =
  'mnemosyne.static-lore-control-classification.v1';
const CONTROL_ACCEPTANCE_SCHEMA =
  'mnemosyne.static-lore-control-acceptance.v1';
const DISPLAY_CONTROL_MARKER = /^【[^\n【】]{1,32}】$/u;
const CONTROL_TARGETS = new Map([
  [
    'display_control_marker',
    {
      source_kind: 'character_card',
      unit_id: 'first_mes',
    },
  ],
  [
    'character_description_markup',
    {
      source_kind: 'character_card',
      unit_id: 'description',
    },
  ],
]);
const MARKDOWN_SOURCE_KINDS = new Set([
  'character_card',
  'world_info',
  'worldbook',
]);

function sourceUnitText(unit) {
  if (typeof unit?.data === 'string') return unit.data;
  if (typeof unit?.data?.content === 'string') return unit.data.content;
  return null;
}

function controlClassification({
  controlKind,
  sourceKind,
  unitId,
  markerHash,
}) {
  const classification = {
    schema: CONTROL_CLASSIFICATION_SCHEMA,
    control_kind: controlKind,
    source_kind: sourceKind,
    unit_id: unitId,
    marker_hash: markerHash,
  };
  return Object.freeze({
    ...classification,
    classification_hash: sha256(canonicalJson(classification)),
  });
}

export function classifyStaticLoreControlUnit(unit) {
  const unitId = String(unit?.unit_id ?? '').split(':part:')[0];
  const text = sourceUnitText(unit);
  if (
    unit?.source_kind !== 'character_card'
    || unitId !== 'first_mes'
    || typeof text !== 'string'
  ) {
    return null;
  }
  const marker = text.replace(/\r\n?/g, '\n').trim();
  if (!DISPLAY_CONTROL_MARKER.test(marker)) return null;

  return controlClassification({
    controlKind: 'display_control_marker',
    sourceKind: 'character_card',
    unitId: 'first_mes',
    markerHash: sha256(marker),
  });
}

export function classifyStaticLoreStructuralEvidenceSpan({
  unit,
  quote,
  sourceStart = null,
} = {}) {
  const unitId = String(unit?.unit_id ?? '').split(':part:')[0];
  const sourceText = sourceUnitText(unit);
  if (
    unit?.source_kind !== 'character_card'
    || unitId !== 'description'
    || typeof sourceText !== 'string'
    || typeof quote !== 'string'
  ) {
    return null;
  }
  const text = sourceText.replace(/\r\n?/g, '\n');
  const marker = quote.replace(/\r\n?/g, '\n');
  if (!marker.trim()) return null;
  const start = Number.isInteger(sourceStart)
    ? sourceStart
    : text.indexOf(marker);
  if (
    start < 0
    || text.slice(start, start + marker.length) !== marker
    || (
      sourceStart === null
      && text.indexOf(marker, start + 1) >= 0
    )
  ) {
    return null;
  }
  const markup = new Uint8Array(text.length);
  const expression = /<\/?[a-z_][a-z0-9_-]*\b[^>]*>/giu;
  for (const match of text.matchAll(expression)) {
    markup.fill(1, match.index, match.index + match[0].length);
  }
  let containsMarkup = false;
  for (let index = start; index < start + marker.length; index += 1) {
    if (/\s/u.test(text[index])) continue;
    if (!markup[index]) return null;
    containsMarkup = true;
  }
  if (!containsMarkup) return null;
  return controlClassification({
    controlKind: 'character_description_markup',
    sourceKind: 'character_card',
    unitId: 'description',
    markerHash: sha256(canonicalJson({
      source_ref: unit.ref,
      source_start: start,
      source_end: start + marker.length,
      quote_hash: sha256(marker),
    })),
  });
}

export function classifyStaticLoreListMarkerEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const sourceText = sourceUnitText(unit);
  if (
    !MARKDOWN_SOURCE_KINDS.has(unit?.source_kind)
    || typeof sourceText !== 'string'
    || !Number.isInteger(sourceStart)
    || !/^[-+*]$/u.test(quote ?? '')
  ) {
    return null;
  }
  const text = sourceText.replace(/\r\n?/g, '\n');
  if (text[sourceStart] !== quote) return null;
  const lineStart = text.lastIndexOf('\n', sourceStart - 1) + 1;
  if (
    !/^[\t ]*$/u.test(text.slice(lineStart, sourceStart))
    || !/[\t ]/u.test(text[sourceStart + 1] ?? '')
  ) {
    return null;
  }
  const unitId = String(unit.unit_id ?? '').split(':part:')[0];
  return controlClassification({
    controlKind: 'markdown_list_marker',
    sourceKind: unit.source_kind,
    unitId,
    markerHash: sha256(canonicalJson({
      source_ref: unit.ref,
      source_start: sourceStart,
      source_end: sourceStart + quote.length,
      quote_hash: sha256(quote),
    })),
  });
}

export function staticLoreControlTarget(classification) {
  const expected = CONTROL_TARGETS.get(classification?.control_kind);
  const dynamicMarkdownTarget = (
    classification?.control_kind === 'markdown_list_marker'
    && MARKDOWN_SOURCE_KINDS.has(classification.source_kind)
    && typeof classification.unit_id === 'string'
    && classification.unit_id.length > 0
  );
  if (
    classification?.schema !== CONTROL_CLASSIFICATION_SCHEMA
    || (
      !dynamicMarkdownTarget
      && (
        !expected
        || classification.source_kind !== expected.source_kind
        || classification.unit_id !== expected.unit_id
      )
    )
    || !/^[a-f0-9]{64}$/.test(classification.marker_hash ?? '')
    || classification.classification_hash
      !== sha256(canonicalJson({
        schema: classification.schema,
        control_kind: classification.control_kind,
        source_kind: classification.source_kind,
        unit_id: classification.unit_id,
        marker_hash: classification.marker_hash,
      }))
  ) {
    throw new Error('Static Lore control classification is invalid.');
  }
  return {
    control_kind: classification.control_kind,
    source_kind: classification.source_kind,
    unit_id: classification.unit_id,
    marker_hash: classification.marker_hash,
    classification_hash: classification.classification_hash,
  };
}

export function staticLoreControlAcceptanceHash({
  snapshotId,
  sourceUnitRef,
  evidenceId,
  evidenceMode,
  evidenceQuoteHash,
  modelArtifactHash,
  runtimeViewHash,
  controlTarget,
}) {
  return sha256(canonicalJson({
    schema: CONTROL_ACCEPTANCE_SCHEMA,
    snapshot_id: snapshotId,
    source_unit_ref: sourceUnitRef,
    evidence_id: evidenceId,
    evidence_mode: evidenceMode,
    evidence_quote_hash: evidenceQuoteHash,
    model_artifact_hash: modelArtifactHash,
    runtime_view_hash: runtimeViewHash,
    control_target: controlTarget,
  }));
}

export function harnessStaticLoreControlBatch({
  normalizedExtraction,
  sourceUnits,
} = {}) {
  const classifications = (sourceUnits ?? []).map(
    classifyStaticLoreControlUnit,
  );
  if (classifications.every(classification => classification === null)) {
    return {
      extraction: normalizedExtraction,
      classifications: [],
      warnings: [],
    };
  }
  if (classifications.some(classification => classification === null)) {
    throw new Error(
      'Static Lore control units cannot share a model batch with story units.',
    );
  }

  const semanticRecordCount = [
    'concepts',
    'attribute_definitions',
    'progression_tracks',
    'current_state',
    'topology',
  ].reduce(
    (count, key) => count + (normalizedExtraction?.[key]?.length ?? 0),
    normalizedExtraction?.active_scene === null
      || normalizedExtraction?.active_scene === undefined
      ? 0
      : 1,
  );
  return {
    extraction: {
      ...structuredClone(normalizedExtraction),
      concepts: [],
      attribute_definitions: [],
      progression_tracks: [],
      current_state: [],
      topology: [],
      active_scene: null,
    },
    classifications,
    warnings: semanticRecordCount === 0
      ? []
      : [{
        code: 'local_control_unit_semantics_discarded',
        record: 'batch',
        reason: 'deterministic_non_story_control_classification',
      }],
  };
}
