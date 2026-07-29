import {
  characterDescriptionEvidenceContext,
} from './static-lore-evidence-zones.js';

export const DEFAULT_STATIC_LORE_TEXT_UNIT_BYTES = 1_200;

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function preferredTextBoundary(value) {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (/[\n。！？!?；;]/u.test(value[index])) {
      return index + 1;
    }
  }
  return 0;
}

function splitOversizedText(value, maxBytes) {
  const characters = [...value];
  const chunks = [];
  let current = '';
  for (const character of characters) {
    while (current && utf8Bytes(current + character) > maxBytes) {
      const boundary = preferredTextBoundary(current);
      if (boundary > 0) {
        chunks.push(current.slice(0, boundary));
        current = current.slice(boundary);
      } else {
        chunks.push(current);
        current = '';
      }
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitStaticLoreText(value, {
  maxBytes = DEFAULT_STATIC_LORE_TEXT_UNIT_BYTES,
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive integer.');
  }
  const text = String(value);
  if (utf8Bytes(text) <= maxBytes) return [text];

  const paragraphs = text.split(/(\n{2,})/);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if (utf8Bytes(paragraph) > maxBytes) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitOversizedText(paragraph, maxBytes));
      continue;
    }
    if (current && utf8Bytes(current + paragraph) > maxBytes) {
      chunks.push(current);
      current = paragraph;
    } else {
      current += paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

function sourceUnit({
  scheme,
  snapshotId,
  source,
  unitId,
  data,
}) {
  return {
    ref: `${scheme}://snapshot/${snapshotId}/${encodeURIComponent(source.source_id)}/${encodeURIComponent(unitId)}`,
    source_id: source.source_id,
    source_kind: source.source_kind,
    unit_id: String(unitId),
    data: structuredClone(data),
  };
}

function hasMeaningfulValue(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null;
}

function textUnits({
  scheme,
  snapshotId,
  source,
  unitId,
  value,
  wrap,
  maxTextUnitBytes,
  partContext,
}) {
  const parts = splitStaticLoreText(value, { maxBytes: maxTextUnitBytes });
  if (parts.length === 1) {
    return [sourceUnit({
      scheme,
      snapshotId,
      source,
      unitId,
      data: wrap(parts[0], null),
    })];
  }
  let offset = 0;
  return parts.map((part, index) => {
    const context = partContext?.(offset) ?? {};
    offset += part.length;
    return sourceUnit({
      scheme,
      snapshotId,
      source,
      unitId: `${unitId}:part:${index + 1}`,
      data: {
        ...wrap(part, {
          part_index: index + 1,
          part_count: parts.length,
          source_unit: String(unitId),
        }),
        ...context,
      },
    });
  });
}

export function buildStaticLoreSourceUnits({
  snapshotId,
  sources,
  maxTextUnitBytes = DEFAULT_STATIC_LORE_TEXT_UNIT_BYTES,
} = {}) {
  const units = [];
  for (const source of sources ?? []) {
    if (source.source_kind === 'worldbook') {
      for (const [entryKey, entry] of Object.entries(source.data?.entries ?? {})) {
        if (entry?.disable) continue;
        if (!String(entry?.content ?? '').trim()) continue;
        const unitId = entry?.uid ?? entryKey;
        const base = {
          uid: unitId,
          key: structuredClone(entry?.key ?? []),
          keysecondary: structuredClone(entry?.keysecondary ?? []),
          comment: entry?.comment ?? '',
          constant: Boolean(entry?.constant),
          selective: Boolean(entry?.selective),
          selectiveLogic: entry?.selectiveLogic ?? 0,
          position: entry?.position ?? 0,
        };
        units.push(...textUnits({
          scheme: 'worldinfo',
          snapshotId,
          source,
          unitId,
          value: entry?.content ?? '',
          maxTextUnitBytes,
          wrap: (content, part) => ({
            ...base,
            content,
            ...(part ?? {}),
          }),
        }));
      }
      continue;
    }

    const scheme = {
      character_card: 'character-card',
      persona: 'persona',
      scenario: 'scenario',
    }[source.source_kind];
    if (!scheme) continue;
    if (source.data && typeof source.data === 'object') {
      for (const [field, value] of Object.entries(source.data)) {
        if (
          source.source_kind === 'character_card'
          && ![
            'name',
            'description',
            'personality',
            'first_mes',
            'creator_notes',
            'tags',
          ].includes(field)
        ) {
          continue;
        }
        if (!hasMeaningfulValue(value)) continue;
        if (typeof value === 'string') {
          units.push(...textUnits({
            scheme,
            snapshotId,
            source,
            unitId: field,
            value,
            maxTextUnitBytes,
            partContext: (
              source.source_kind === 'character_card'
              && field === 'description'
            )
              ? offset => characterDescriptionEvidenceContext(value, offset)
              : undefined,
            wrap: (content, part) => (
              part ? { content, ...part } : content
            ),
          }));
        } else {
          units.push(sourceUnit({
            scheme,
            snapshotId,
            source,
            unitId: field,
            data: value,
          }));
        }
      }
    } else if (typeof source.data === 'string' && source.data.trim()) {
      units.push(...textUnits({
        scheme,
        snapshotId,
        source,
        unitId: 'content',
        value: source.data,
        maxTextUnitBytes,
        wrap: (content, part) => (
          part ? { content, ...part } : content
        ),
      }));
    }
  }
  return units;
}
