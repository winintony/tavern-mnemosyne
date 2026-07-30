import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  characterDescriptionEvidenceLine,
  characterDescriptionEvidenceMode,
  STATIC_LORE_SAMPLE_ANNOTATION_LINE,
} from './static-lore-evidence-zones.js';

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
// Typographic control is a property of the glyphs, not of the host source, so
// these kinds stay open: a persona unit wraps emphasis exactly like a card
// does, and whitelisting kinds here would only reintroduce paid failures for
// the kinds nobody remembered to list.
const TYPOGRAPHIC_CONTROL_KINDS = new Set([
  'markdown_list_marker',
  'sample_annotation_line',
  'source_markup_tag',
  'typographic_symbol_run',
  'heading_label_line',
  'markdown_heading_line',
  'bracketed_label_line',
  'value_label_prefix',
  'macro_value',
  'concept_reference_value',
  'uncited_title_span',
  'block_title_value',
]);
// A line that is only a printed section name carries nothing the model can
// attest to, and every one it skips halts a paid run until a human retriggers
// it. The cap is what separates a label from a sentence that happens to end in
// a colon: the live corpus puts every real label at or under 36 code points
// and the nearest prose line at 58.
const STRUCTURAL_LINE_MAX_CODE_POINTS = 40;
const STRUCTURAL_LINE_PATTERNS = [
  // Label line: no value after the colon, and no second colon that would mean
  // this line already carries one.
  ['heading_label_line', /^[^\s：:][^：:]*[：:]$/u],
  ['markdown_heading_line', /^#{1,6}[\t ]+\S.*$/u],
  [
    'bracketed_label_line',
    /^(?:【[^【】]*】|《[^《》]*》|\[[^[\]]*\])$/u,
  ],
];
// Bare `©`, `™`, `▪` and the other text-presentation dingbats stay structure:
// they are bullets and rules in practice, and failing a paid batch over one
// would trade the emoji hole for a worse halt. What must never pass silently
// is an emoji used as content, which is what emoji presentation identifies.
const STRUCTURAL_EXEMPT_CHARACTER =
  /[\p{L}\p{N}\p{Emoji_Presentation}]|\p{Extended_Pictographic}️/u;

// `道德准则：守序善良。` is a label and a value on one line. The value is the
// model's to evidence; the label in front of the colon is the same printed
// section name a bare label line carries, and leaving it out cost two paid
// attempts on the same worldbook unit. A speaker attribution — `蓝珂说：` —
// looks identical in shape but names who is talking, which is story, so a
// prefix ending in a speech verb is never absorbed.
const VALUE_LABEL_PREFIX = /^([^：:<>"]{1,40})[：:](?=.*\S)/u;
const SENTENCE_PUNCTUATION = /[，。！？；、,.!?;…—]/u;
const SPEECH_ATTRIBUTION = new RegExp(
  '(?:说|道|问|答|喊|叫|吼|笑|骂|哭|念|唱|喃|嘀咕|回应|开口|低语|应道|反问)$',
  'u',
);
// Bullets and ordinals are the same typesetting: `1.` numbers an item exactly
// as `-` bullets one. The ordinal has to sit in the marker slot at the head of
// the line and be followed by content, so a digit inside prose or a quoted
// date is never in scope.
// `1.` must be followed by a space so a decimal like `1.5` is never mistaken
// for a marker. `1、`, `1)` and `(1)` are unambiguous on their own.
const LIST_MARKER =
  /^(?:(?:[-+*]|\d{1,3}\.)(?=[\t ])|\(\d{1,3}\)|\d{1,3}[)、])/u;
const LIST_MARKER_PREFIX =
  /^(?:(?:[-+*]|\d{1,3}\.)[\t ]+|(?:\(\d{1,3}\)|\d{1,3}[)、])[\t ]*)/u;

export function staticLoreLineListMarker(line) {
  const leading = line.length - line.trimStart().length;
  const body = line.slice(leading);
  const marker = LIST_MARKER.exec(body)?.[0];
  if (!marker || !body.slice(marker.length).trim()) return null;
  return { start: leading, end: leading + marker.length, marker };
}

// Returns the span of a line that the server accounts for on its own, in
// offsets relative to the line, or null when the whole line is the model's.
export function staticLoreStructuralLineSpan(line) {
  const leading = line.length - line.trimStart().length;
  const trimmed = line.trim();
  if (!trimmed) return null;
  if ([...trimmed].length <= STRUCTURAL_LINE_MAX_CODE_POINTS) {
    const matched = STRUCTURAL_LINE_PATTERNS.find(
      ([, pattern]) => pattern.test(trimmed),
    );
    if (matched) {
      return {
        kind: matched[0],
        start: leading,
        end: leading + trimmed.length,
      };
    }
  }
  const marker = LIST_MARKER_PREFIX.exec(trimmed)?.[0] ?? '';
  const body = trimmed.slice(marker.length);
  const prefix = VALUE_LABEL_PREFIX.exec(body)?.[1];
  if (
    prefix === undefined
    || !prefix.trim()
    || SENTENCE_PUNCTUATION.test(prefix)
    || SPEECH_ATTRIBUTION.test(prefix.trim())
  ) {
    return null;
  }
  const start = leading + marker.length;
  return {
    kind: 'value_label_prefix',
    start,
    // The colon belongs to the label, the value after it does not.
    end: start + prefix.length + 1,
  };
}

// `- 人物：{{user}}` and `- 人物：蓝珂` are cross references, not prose: one is
// a placeholder the runtime substitutes, the other names an entity that
// already exists in memory. Four paid attempts skipped both, so the server
// accounts for them. Everything else on the value side stays the model's —
// `性别：男` and `年龄：18` are data the model has always been willing to quote.
const MACRO_VALUE = /^(?:\{\{[^{}]+\}\})+$/u;

export function staticLoreValueLineSpan(line) {
  const structural = staticLoreStructuralLineSpan(line);
  if (structural?.kind !== 'value_label_prefix') return null;
  const end = line.trimEnd().length;
  const raw = line.slice(structural.end, end);
  const value = raw.trim();
  if (!value) return null;
  return {
    start: structural.end + (raw.length - raw.trimStart().length),
    end,
    value,
  };
}

export function staticLoreValueReferenceKind(value, knownConceptNames = []) {
  if (MACRO_VALUE.test(value)) return 'macro_value';
  if (
    [...value].length > STRUCTURAL_LINE_MAX_CODE_POINTS
    || SENTENCE_PUNCTUATION.test(value)
    || !knownConceptNames.includes(value)
  ) {
    return null;
  }
  return 'concept_reference_value';
}

// A heading the model transcribed but attached to nothing. Three paid attempts
// swung between omitting the line and quoting it without a home, so a span
// that no record claims is accounted for when the text itself is a heading:
// one short line, no sentence punctuation. Narrative cannot qualify — it is
// longer, punctuated, or only part of a line — so a model cannot dump an
// unowned paragraph through here.
// `- point: 情感羁绊与双向感应` names the description block under it, exactly
// as a markdown heading names the prose under it, and the model skips it just
// as reliably. The anchor is what keeps ordinary data rows out: either the
// block below carries a description key, or the line sits directly under the
// tag that opened the block. `年龄: 18` has neither.
const BLOCK_TITLE_KEY = /^[\t ]*(?:[-+*][\t ]+)?([\p{L}_][\p{L}\p{N}_]{0,15})[:：]/u;
const BLOCK_DESCRIPTION_KEY =
  /^[\t ]*(?:[-+*][\t ]+)?(?:description|detail|details|content|描述|说明|正文)[:：]/iu;
const BLOCK_OPENING_TAG = /^[\t ]*<[a-z_][a-z0-9_-]*\b[^>]*>[\t ]*$/iu;

export function staticLoreBlockTitleValueKind(text, lineStart) {
  const lines = text.split('\n');
  let offset = 0;
  let index = -1;
  for (const [position, line] of lines.entries()) {
    if (offset === lineStart) { index = position; break; }
    offset += line.length + 1;
    if (offset > lineStart) break;
  }
  if (index < 0) return null;
  const line = lines[index];
  const key = BLOCK_TITLE_KEY.exec(line)?.[1];
  const valueSpan = staticLoreValueLineSpan(line);
  if (
    !key
    || !valueSpan
    || [...valueSpan.value].length > STRUCTURAL_LINE_MAX_CODE_POINTS
    || SENTENCE_PUNCTUATION.test(valueSpan.value)
  ) {
    return null;
  }
  const indent = line.length - line.trimStart().length;
  for (let next = index + 1; next < lines.length; next += 1) {
    const candidate = lines[next];
    if (!candidate.trim()) continue;
    if (candidate.length - candidate.trimStart().length <= indent) break;
    if (BLOCK_DESCRIPTION_KEY.test(candidate)) return 'block_title_value';
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (!lines[previous].trim()) continue;
    return BLOCK_OPENING_TAG.test(lines[previous])
      ? 'block_title_value'
      : null;
  }
  return null;
}

export function classifyStaticLoreBlockTitleEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const span = typographicSpanText({ unit, quote, sourceStart });
  if (!span || quote.includes('\n') || !quote.trim()) return null;
  const { text } = span;
  const lineStart = text.lastIndexOf('\n', sourceStart - 1) + 1;
  const line = characterDescriptionEvidenceLine(text, sourceStart);
  const valueSpan = staticLoreValueLineSpan(line);
  if (
    !valueSpan
    || sourceStart < lineStart + valueSpan.start
    || sourceStart + quote.length > lineStart + valueSpan.end
    || !staticLoreBlockTitleValueKind(text, lineStart)
  ) {
    return null;
  }
  return controlClassification({
    controlKind: 'block_title_value',
    sourceKind: unit.source_kind,
    unitId: span.unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

export function classifyStaticLoreUncitedTitleEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const span = typographicSpanText({ unit, quote, sourceStart });
  if (
    !span
    || quote.includes('\n')
    || !quote.trim()
    || [...quote.trim()].length > STRUCTURAL_LINE_MAX_CODE_POINTS
    || SENTENCE_PUNCTUATION.test(quote)
  ) {
    return null;
  }
  const line = characterDescriptionEvidenceLine(span.text, sourceStart);
  if (line.trim() !== quote.trim()) return null;
  return controlClassification({
    controlKind: 'uncited_title_span',
    sourceKind: unit.source_kind,
    unitId: span.unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

export function classifyStaticLoreValueReferenceEvidenceSpan({
  unit,
  quote,
  sourceStart,
  knownConceptNames = [],
} = {}) {
  const span = typographicSpanText({ unit, quote, sourceStart });
  if (!span || quote.includes('\n') || !quote.trim()) return null;
  const { text } = span;
  const lineStart = text.lastIndexOf('\n', sourceStart - 1) + 1;
  const line = characterDescriptionEvidenceLine(text, sourceStart);
  const valueSpan = staticLoreValueLineSpan(line);
  if (
    !valueSpan
    || sourceStart < lineStart + valueSpan.start
    || sourceStart + quote.length > lineStart + valueSpan.end
  ) {
    return null;
  }
  const controlKind = staticLoreValueReferenceKind(
    valueSpan.value,
    knownConceptNames,
  );
  if (!controlKind) return null;
  return controlClassification({
    controlKind,
    sourceKind: unit.source_kind,
    unitId: span.unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

const IDENTITY_VALUE_LABEL =
  /^(?:name|title|display[ _-]?name|名称|名字|姓名|称呼)[：:]$/iu;

export function classifyStaticLoreIdentityValueEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const span = typographicSpanText({ unit, quote, sourceStart });
  if (!span || quote.includes('\n') || !quote.trim()) return null;
  const { text } = span;
  const lineStart = text.lastIndexOf('\n', sourceStart - 1) + 1;
  const line = characterDescriptionEvidenceLine(text, sourceStart);
  const valueSpan = staticLoreValueLineSpan(line);
  if (
    !valueSpan
    || sourceStart < lineStart + valueSpan.start
    || sourceStart + quote.length > lineStart + valueSpan.end
    || !IDENTITY_VALUE_LABEL.test(
      line.slice(0, valueSpan.start).trim(),
    )
  ) {
    return null;
  }
  return controlClassification({
    controlKind: 'uncited_title_span',
    sourceKind: unit.source_kind,
    unitId: span.unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

export function staticLoreStructuralLineKind(line) {
  return staticLoreStructuralLineSpan(line)?.kind ?? null;
}

// Marks every code unit of a character the structural rules may not absorb.
// Indexing by code unit alone would read a surrogate half as "no letter here"
// and hand a rare-plane name, or an emoji, to the symbol-run rule.
export function staticLoreStructuralExemptMask(text) {
  const mask = new Uint8Array(text.length);
  const expression = new RegExp(STRUCTURAL_EXEMPT_CHARACTER, 'gu');
  for (const match of text.matchAll(expression)) {
    mask.fill(1, match.index, match.index + match[0].length);
  }
  return mask;
}

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

function rangeMarkerHash({ unit, quote, sourceStart }) {
  return sha256(canonicalJson({
    source_ref: unit.ref,
    source_start: sourceStart,
    source_end: sourceStart + quote.length,
    quote_hash: sha256(quote),
  }));
}

function typographicSpanText({ unit, quote, sourceStart }) {
  const sourceText = sourceUnitText(unit);
  const unitId = String(unit?.unit_id ?? '').split(':part:')[0];
  if (
    typeof unit?.source_kind !== 'string'
    || !unit.source_kind
    || !unitId
    || typeof sourceText !== 'string'
    || typeof quote !== 'string'
    || quote.length === 0
    || !Number.isInteger(sourceStart)
    || sourceStart < 0
  ) {
    return null;
  }
  const text = sourceText.replace(/\r\n?/g, '\n');
  if (text.slice(sourceStart, sourceStart + quote.length) !== quote) {
    return null;
  }
  return { text, unitId };
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
    typeof unit?.source_kind !== 'string'
    || !unit.source_kind
    || !unitId
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
  // The card description keeps the classification it has always had, so every
  // record already minted under it re-derives byte for byte. Markup anywhere
  // else — worldbook `<q>` pairs, status-bar templates, persona wrappers — is
  // the same kind of thing and gets its own dynamic kind rather than being
  // filed under a character-card name.
  const isCardDescription = (
    unit.source_kind === 'character_card'
    && unitId === 'description'
  );
  return controlClassification({
    controlKind: isCardDescription
      ? 'character_description_markup'
      : 'source_markup_tag',
    sourceKind: unit.source_kind,
    unitId,
    markerHash: rangeMarkerHash({
      unit,
      quote: marker,
      sourceStart: start,
    }),
  });
}

export function classifyStaticLoreListMarkerEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const sourceText = sourceUnitText(unit);
  if (
    typeof unit?.source_kind !== 'string'
    || !unit.source_kind
    || typeof sourceText !== 'string'
    || !Number.isInteger(sourceStart)
    || typeof quote !== 'string'
  ) {
    return null;
  }
  const text = sourceText.replace(/\r\n?/g, '\n');
  const lineStart = text.lastIndexOf('\n', sourceStart - 1) + 1;
  const lineBreak = text.indexOf('\n', sourceStart);
  const marker = staticLoreLineListMarker(
    text.slice(lineStart, lineBreak < 0 ? text.length : lineBreak),
  );
  if (
    !marker
    || marker.marker !== quote
    || lineStart + marker.start !== sourceStart
  ) {
    return null;
  }
  const unitId = String(unit.unit_id ?? '').split(':part:')[0];
  return controlClassification({
    controlKind: 'markdown_list_marker',
    sourceKind: unit.source_kind,
    unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

// A run of glyphs with no letter or digit in it — `**`, `---`, `>`, a box
// rule, a stranded bracket — is typesetting, not narration. Requiring the
// model to quote it back turned zero-information punctuation into a paid
// failure, so the server accounts for it deterministically instead.
export function classifyStaticLoreSymbolRunEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const span = typographicSpanText({ unit, quote, sourceStart });
  if (
    !span
    || /\s/u.test(quote)
    || STRUCTURAL_EXEMPT_CHARACTER.test(quote)
  ) {
    return null;
  }
  return controlClassification({
    controlKind: 'typographic_symbol_run',
    sourceKind: unit.source_kind,
    unitId: span.unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

// A sample block's annotation line is guidance the model is meant to hang a
// behavior_rule on. When it instead mints a concept for the note, both the
// concept (new, guidance-only) and the claim (fact in a guidance zone) are
// refused — correctly — and the line is left with no accepted citer at all.
// The line is still the author's instruction, not story, so it can be
// accounted for as control. This stays derivable from the source text alone,
// which is what lets the publish gate re-derive it: the quarantine decides
// whether the record is emitted, never whether it is valid.
export function classifyStaticLoreSampleAnnotationEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const span = typographicSpanText({ unit, quote, sourceStart });
  if (
    !span
    || unit.source_kind !== 'character_card'
    || span.unitId !== 'description'
    || quote.includes('\n')
    || !quote.trim()
  ) {
    return null;
  }
  const { text } = span;
  const line = characterDescriptionEvidenceLine(text, sourceStart);
  if (!STATIC_LORE_SAMPLE_ANNOTATION_LINE.test(line.trim())) return null;
  const zone = {
    initialTag: unit.data?.evidence_tag_at_start ?? null,
    initialMode: unit.data?.evidence_mode_at_start ?? 'authoritative',
  };
  for (let index = sourceStart; index < sourceStart + quote.length; index += 1) {
    if (/\s/u.test(text[index])) continue;
    if (characterDescriptionEvidenceMode(text, index, zone) !== 'guidance') {
      return null;
    }
  }
  return controlClassification({
    controlKind: 'sample_annotation_line',
    sourceKind: unit.source_kind,
    unitId: span.unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

export function classifyStaticLoreStructuralLineEvidenceSpan({
  unit,
  quote,
  sourceStart,
} = {}) {
  const span = typographicSpanText({ unit, quote, sourceStart });
  if (!span || quote.includes('\n') || !quote.trim()) return null;
  const { text } = span;
  const lineStart = text.lastIndexOf('\n', sourceStart - 1) + 1;
  const lineBreak = text.indexOf('\n', sourceStart);
  const lineEnd = lineBreak < 0 ? text.length : lineBreak;
  const line = text.slice(lineStart, lineEnd);
  const structural = staticLoreStructuralLineSpan(line);
  if (
    !structural
    || sourceStart < lineStart + structural.start
    || sourceStart + quote.length > lineStart + structural.end
  ) {
    return null;
  }
  return controlClassification({
    controlKind: structural.kind,
    sourceKind: unit.source_kind,
    unitId: span.unitId,
    markerHash: rangeMarkerHash({ unit, quote, sourceStart }),
  });
}

export function staticLoreControlTarget(classification) {
  const expected = CONTROL_TARGETS.get(classification?.control_kind);
  const dynamicTypographicTarget = (
    TYPOGRAPHIC_CONTROL_KINDS.has(classification?.control_kind)
    && typeof classification.source_kind === 'string'
    && classification.source_kind.length > 0
    && typeof classification.unit_id === 'string'
    && classification.unit_id.length > 0
  );
  if (
    classification?.schema !== CONTROL_CLASSIFICATION_SCHEMA
    || (
      !dynamicTypographicTarget
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
