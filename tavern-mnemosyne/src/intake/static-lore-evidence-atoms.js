import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  characterDescriptionEvidenceMode,
} from './static-lore-evidence-zones.js';
import {
  classifyStaticLoreControlUnit,
  staticLoreStructuralLineSpan,
} from './static-lore-control-units.js';

export const STATIC_LORE_ATOMIZER_REVISION = 1;
export const STATIC_LORE_MAX_ATOM_CODE_POINTS = 300;

function normalizedText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function sourceUnitText(unit) {
  if (typeof unit?.data === 'string') return unit.data;
  if (typeof unit?.data?.content === 'string') {
    return unit.data.content;
  }
  return JSON.stringify(unit?.data ?? null);
}

function evidenceZoneAt(unit, text, offset) {
  const field = String(unit?.unit_id ?? '').split(':part:')[0];
  if (field === 'first_mes') return 'opening_example';
  if (field === 'creator_notes') return 'guidance';
  if (
    unit?.source_kind !== 'character_card'
    || field !== 'description'
  ) {
    return 'authoritative';
  }
  return characterDescriptionEvidenceMode(text, offset, {
    initialTag: unit.data?.evidence_tag_at_start ?? null,
    initialMode:
      unit.data?.evidence_mode_at_start
      ?? 'authoritative',
  });
}

function codePointLength(value) {
  return [...value].length;
}

function codePointEnd(text, start, maxCodePoints) {
  let cursor = start;
  let count = 0;
  while (cursor < text.length && count < maxCodePoints) {
    const codePoint = text.codePointAt(cursor);
    cursor += codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return cursor;
}

function sentenceBoundaries(text, start, end) {
  const boundaries = [];
  for (let cursor = start; cursor < end;) {
    const codePoint = text.codePointAt(cursor);
    const character = String.fromCodePoint(codePoint);
    const next = cursor + (codePoint > 0xffff ? 2 : 1);
    const sentenceEnd = (
      /[\n。！？!?；;]/u.test(character)
      || (
        character === '.'
        && (
          next === end
          || /\s/u.test(text[next] ?? '')
        )
      )
    );
    if (sentenceEnd) boundaries.push(next);
    cursor = next;
  }
  return boundaries;
}

function splitStoryRange(text, start, end) {
  const ranges = [];
  let cursor = start;
  for (const boundary of sentenceBoundaries(text, start, end)) {
    if (boundary > cursor) {
      ranges.push([cursor, boundary]);
      cursor = boundary;
    }
  }
  if (cursor < end) ranges.push([cursor, end]);

  const bounded = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    let partStart = rangeStart;
    while (
      codePointLength(text.slice(partStart, rangeEnd))
      > STATIC_LORE_MAX_ATOM_CODE_POINTS
    ) {
      const hardEnd = codePointEnd(
        text,
        partStart,
        STATIC_LORE_MAX_ATOM_CODE_POINTS,
      );
      let preferredEnd = hardEnd;
      for (let candidate = hardEnd - 1; candidate > partStart; candidate -= 1) {
        if (/[\s,，、:：]/u.test(text[candidate])) {
          preferredEnd = candidate + 1;
          break;
        }
      }
      bounded.push([partStart, preferredEnd]);
      partStart = preferredEnd;
    }
    if (partStart < rangeEnd) bounded.push([partStart, rangeEnd]);
  }
  return bounded;
}

function splitWhitespaceEdges(text, start, end) {
  let contentStart = start;
  while (contentStart < end && /\s/u.test(text[contentStart])) {
    contentStart += 1;
  }
  let contentEnd = end;
  while (contentEnd > contentStart && /\s/u.test(text[contentEnd - 1])) {
    contentEnd -= 1;
  }
  return [
    ...(contentStart > start
      ? [{ start, end: contentStart, control: true }]
      : []),
    ...(contentEnd > contentStart
      ? [{ start: contentStart, end: contentEnd, control: false }]
      : []),
    ...(end > contentEnd
      ? [{ start: contentEnd, end, control: true }]
      : []),
  ];
}

function controlRanges(unit, text) {
  const ranges = [];
  const add = (start, end) => {
    if (Number.isInteger(start) && end > start) {
      ranges.push([start, end]);
    }
  };
  const addMatches = expression => {
    for (const match of text.matchAll(expression)) {
      add(match.index, match.index + match[0].length);
    }
  };
  addMatches(/<[^>\n]+>/gu);
  addMatches(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gmu);
  addMatches(/^(?:-{3,}|\*{3,}|_{3,})$/gmu);
  addMatches(/(?:\*{2,}|_{2,}|~{2,}|`{2,})/gu);
  for (let lineStart = 0; lineStart <= text.length;) {
    const lineBreak = text.indexOf('\n', lineStart);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    const structural = staticLoreStructuralLineSpan(
      text.slice(lineStart, lineEnd),
    );
    if (structural) {
      add(
        lineStart + structural.start,
        lineStart + structural.end,
      );
    }
    if (lineBreak < 0) break;
    lineStart = lineBreak + 1;
  }
  if (classifyStaticLoreControlUnit(unit)) {
    const start = text.length - text.trimStart().length;
    add(start, text.trimEnd().length);
  }
  return ranges;
}

function partitionBoundaries(unit, text) {
  const boundaries = new Set([0, text.length]);
  for (const [start, end] of controlRanges(unit, text)) {
    boundaries.add(start);
    boundaries.add(end);
  }
  let previousZone = text.length > 0
    ? evidenceZoneAt(unit, text, 0)
    : 'authoritative';
  for (let offset = 1; offset < text.length; offset += 1) {
    const zone = evidenceZoneAt(unit, text, offset);
    if (zone !== previousZone) {
      boundaries.add(offset);
      previousZone = zone;
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

function isDeclaredControl(start, end, declared) {
  return declared.some(([controlStart, controlEnd]) => (
    start >= controlStart && end <= controlEnd
  ));
}

function sourceAtoms({
  snapshotHash,
  unit,
  sourceIndex,
}) {
  const text = normalizedText(sourceUnitText(unit));
  const declaredControls = controlRanges(unit, text);
  const boundaries = partitionBoundaries(unit, text);
  const ranges = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === end) continue;
    const control = (
      isDeclaredControl(start, end, declaredControls)
      || !text.slice(start, end).trim()
    );
    const parts = control
      ? [{ start, end, control: true }]
      : splitStoryRange(text, start, end).flatMap(part => (
        splitWhitespaceEdges(text, part[0], part[1])
      ));
    for (const part of parts) {
      ranges.push(part);
    }
  }

  return ranges.map(({ start, end, control }) => {
    const quote = text.slice(start, end);
    const firstStoryOffset = (() => {
      for (let offset = start; offset < end; offset += 1) {
        if (!/\s/u.test(text[offset])) return offset;
      }
      return start;
    })();
    const evidenceZone = evidenceZoneAt(
      unit,
      text,
      firstStoryOffset,
    );
    const quoteHash = sha256(quote);
    const identity = {
      atomizer_revision: STATIC_LORE_ATOMIZER_REVISION,
      snapshot_hash: snapshotHash,
      source_unit_ref: unit.ref,
      start,
      end,
      quote_hash: quoteHash,
      evidence_zone: evidenceZone,
      control,
    };
    return {
      atom_id: `a${sha256(canonicalJson(identity)).slice(0, 30)}`,
      source_index: sourceIndex,
      source_unit_ref: unit.ref,
      start,
      end,
      quote_hash: quoteHash,
      evidence_zone: evidenceZone,
      control,
      text: quote,
    };
  });
}

export function atomizeStaticLoreSourceUnits({
  snapshotId,
  snapshotHash,
  sourceUnits = [],
} = {}) {
  if (
    typeof snapshotId !== 'string'
    || !snapshotId
    || !/^[a-f0-9]{64}$/u.test(snapshotHash ?? '')
  ) {
    throw new TypeError(
      'Static Lore atomization requires a snapshot id and hash.',
    );
  }
  const atoms = sourceUnits.flatMap((unit, sourceIndex) => sourceAtoms({
    snapshotHash,
    unit,
    sourceIndex,
  }));
  const seen = new Set();
  for (const atom of atoms) {
    if (seen.has(atom.atom_id)) {
      throw new TypeError('Static Lore atom identity collided.');
    }
    seen.add(atom.atom_id);
  }
  const identity = {
    schema: 'mnemosyne.static-lore-atom-index.v1',
    atomizer_revision: STATIC_LORE_ATOMIZER_REVISION,
    snapshot_id: snapshotId,
    snapshot_hash: snapshotHash,
    atoms,
  };
  return {
    ...identity,
    atom_index_hash: sha256(canonicalJson(identity)),
  };
}
