export const GUIDANCE_MARKUP_TAGS = new Set([
  'sample_guide',
  'sample_flaws',
  'sample_independence',
  'sample_hobbies',
]);

// The zone changes at the first character of a tag, not after it, so a tag's
// own characters all sit in the zone it switches to: an opening tag belongs to
// the block it opens, a closing tag to the block it returns to. Switching
// after the tag left `<` in one zone and the rest of the tag in another, which
// made a tag impossible to quote in one span — a model that cited
// `<sample_dialogue>` could only ever fail the zone check.
export function activeMarkupTag(text, offset, initialTag = null) {
  const stack = initialTag ? [initialTag] : [];
  const expression = /<\/?([a-z_][a-z0-9_-]*)\b[^>]*>/gi;
  for (const match of text.matchAll(expression)) {
    if (match.index > offset) break;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      const index = stack.lastIndexOf(tag);
      if (index >= 0) stack.splice(index, 1);
    } else {
      stack.push(tag);
    }
  }
  return stack.at(-1) ?? null;
}

// A line that opens with one of these inside a sample block is the author
// telling the model how to use the samples, not a sample. Left as example
// evidence it is unquotable in practice: quoting it with the surrounding
// samples crosses two zones, and example-only evidence may carry nothing but
// a voice_pattern claim, which is the wrong thing to call a usage rule.
// Guidance is the zone that already accepts behavior_rule/conditional_rule.
export const STATIC_LORE_SAMPLE_ANNOTATION_LINE =
  /^(?:说明|注意|注释|备注|提示|注)\s*[:：]/u;
const EXAMPLE_ANNOTATION_LINE = STATIC_LORE_SAMPLE_ANNOTATION_LINE;

export function characterDescriptionEvidenceLine(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const lineBreak = text.indexOf('\n', offset);
  return text.slice(start, lineBreak < 0 ? text.length : lineBreak);
}

export function characterDescriptionEvidenceMode(text, offset, options = {}) {
  const mode = sampleZoneEvidenceMode(text, offset, options);
  if (mode !== 'example') return mode;
  return EXAMPLE_ANNOTATION_LINE.test(
    characterDescriptionEvidenceLine(text, offset).trim(),
  )
    ? 'guidance'
    : 'example';
}

function sampleZoneEvidenceMode(text, offset, {
  initialTag = null,
  initialMode = 'authoritative',
} = {}) {
  const activeTag = activeMarkupTag(text, offset, initialTag);
  if (activeTag === 'sample_dialogue') return 'example';
  if (GUIDANCE_MARKUP_TAGS.has(activeTag)) return 'guidance';

  const dialogueMarker = '对话示例：';
  const dialogueStart = text.lastIndexOf(dialogueMarker, offset);
  if (dialogueStart >= 0) {
    if (offset < dialogueStart + dialogueMarker.length) {
      return 'example';
    }
    const dialogueEnd = text.indexOf('基本态度或语气：', dialogueStart);
    if (offset > dialogueStart && (dialogueEnd < 0 || offset < dialogueEnd)) {
      return 'example';
    }
  }
  if (!initialTag && initialMode === 'example') {
    const dialogueEnd = text.indexOf('基本态度或语气：');
    if (dialogueEnd < 0 || offset < dialogueEnd) return 'example';
  }
  if (!initialTag && initialMode === 'guidance') return 'guidance';
  return 'authoritative';
}

export function characterDescriptionEvidenceContext(text, offset) {
  const activeTag = activeMarkupTag(text, offset);
  const evidenceTagAtStart = (
    activeTag === 'sample_dialogue'
    || GUIDANCE_MARKUP_TAGS.has(activeTag)
  )
    ? activeTag
    : null;
  return {
    evidence_mode_at_start: characterDescriptionEvidenceMode(text, offset),
    ...(evidenceTagAtStart
      ? { evidence_tag_at_start: evidenceTagAtStart }
      : {}),
  };
}
