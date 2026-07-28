export const GUIDANCE_MARKUP_TAGS = new Set([
  'sample_guide',
  'sample_flaws',
  'sample_independence',
  'sample_hobbies',
]);

export function activeMarkupTag(text, offset, initialTag = null) {
  const stack = initialTag ? [initialTag] : [];
  const expression = /<\/?([a-z_][a-z0-9_-]*)\b[^>]*>/gi;
  for (const match of text.matchAll(expression)) {
    if (match.index >= offset) break;
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

export function characterDescriptionEvidenceMode(text, offset, {
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
