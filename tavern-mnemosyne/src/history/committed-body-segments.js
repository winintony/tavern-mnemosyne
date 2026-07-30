import { canonicalJson, sha256 } from '../contracts/hash.js';

export const COMMITTED_BODY_SEGMENTER_REVISION = 1;
export const COMMITTED_BODY_MAX_SEGMENT_CODE_POINTS = 300;

const COMMITTED_BODY_SEGMENT_REF_PATTERN = (
  /^mnemosyne:\/\/committed-body-segment\/v1\/[a-f0-9]{32}$/
);

function codePointLength(value) {
  return [...value].length;
}

function codePointEnd(text, start, maximum) {
  let cursor = start;
  let count = 0;
  while (cursor < text.length && count < maximum) {
    const codePoint = text.codePointAt(cursor);
    cursor += codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return cursor;
}

function sentenceBoundaries(text) {
  const boundaries = [];
  for (let cursor = 0; cursor < text.length;) {
    const codePoint = text.codePointAt(cursor);
    const character = String.fromCodePoint(codePoint);
    const next = cursor + (codePoint > 0xffff ? 2 : 1);
    const sentenceEnd = (
      /[\n。！？!?；;]/u.test(character)
      || (
        character === '.'
        && (
          next === text.length
          || /\s/u.test(text[next] ?? '')
        )
      )
    );
    if (sentenceEnd) boundaries.push(next);
    cursor = next;
  }
  if (boundaries.at(-1) !== text.length) {
    boundaries.push(text.length);
  }
  return boundaries;
}

function trimWhitespaceRange(text, start, end) {
  let contentStart = start;
  while (contentStart < end) {
    const codePoint = text.codePointAt(contentStart);
    const character = String.fromCodePoint(codePoint);
    if (!/\s/u.test(character)) break;
    contentStart += codePoint > 0xffff ? 2 : 1;
  }
  let contentEnd = end;
  while (contentEnd > contentStart) {
    const previous = text.codePointAt(contentEnd - 1);
    if (previous >= 0xdc00 && previous <= 0xdfff) {
      const pair = text.codePointAt(contentEnd - 2);
      const character = String.fromCodePoint(pair);
      if (!/\s/u.test(character)) break;
      contentEnd -= 2;
      continue;
    }
    const character = String.fromCodePoint(previous);
    if (!/\s/u.test(character)) break;
    contentEnd -= 1;
  }
  return [contentStart, contentEnd];
}

function preferredHardEnd(text, start, hardEnd) {
  let cursor = hardEnd;
  while (cursor > start) {
    const codePoint = text.codePointAt(cursor - 1);
    if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      cursor -= 1;
      continue;
    }
    const character = String.fromCodePoint(codePoint);
    if (/[\s,，、:：]/u.test(character)) return cursor;
    cursor -= 1;
  }
  return hardEnd;
}

function boundedStoryRanges(text) {
  const ranges = [];
  let sentenceStart = 0;
  for (const sentenceEnd of sentenceBoundaries(text)) {
    const [trimmedStart, trimmedEnd] = trimWhitespaceRange(
      text,
      sentenceStart,
      sentenceEnd,
    );
    let partStart = trimmedStart;
    while (
      codePointLength(text.slice(partStart, trimmedEnd))
        > COMMITTED_BODY_MAX_SEGMENT_CODE_POINTS
    ) {
      const hardEnd = codePointEnd(
        text,
        partStart,
        COMMITTED_BODY_MAX_SEGMENT_CODE_POINTS,
      );
      const partEnd = preferredHardEnd(text, partStart, hardEnd);
      const [contentStart, contentEnd] = trimWhitespaceRange(
        text,
        partStart,
        partEnd,
      );
      if (contentEnd > contentStart) {
        ranges.push([contentStart, contentEnd]);
      }
      partStart = partEnd;
      while (partStart < trimmedEnd) {
        const codePoint = text.codePointAt(partStart);
        const character = String.fromCodePoint(codePoint);
        if (!/\s/u.test(character)) break;
        partStart += codePoint > 0xffff ? 2 : 1;
      }
    }
    if (trimmedEnd > partStart) {
      ranges.push([partStart, trimmedEnd]);
    }
    sentenceStart = sentenceEnd;
  }
  return ranges;
}

function assertCommitInput({ commitId, bodyHash, body }) {
  if (
    typeof commitId !== 'string'
    || !commitId
    || typeof body !== 'string'
    || !body.trim()
  ) {
    throw new TypeError(
      'Committed-body segmentation requires one commit and non-empty story prose.',
    );
  }
  if (
    !/^[a-f0-9]{64}$/.test(bodyHash ?? '')
    || sha256(body) !== bodyHash
  ) {
    throw new TypeError(
      'Committed-body segmentation requires the exact locked body hash.',
    );
  }
}

export function createCommittedBodySegmentDirectory({
  commitId,
  bodyHash,
  body,
} = {}) {
  assertCommitInput({ commitId, bodyHash, body });
  const segments = boundedStoryRanges(body).map(
    ([start, end], ordinal) => {
      const text = body.slice(start, end);
      const quoteHash = sha256(text);
      const identity = {
        segmenter_revision: COMMITTED_BODY_SEGMENTER_REVISION,
        commit_id: commitId,
        body_hash: bodyHash,
        ordinal,
        start,
        end,
        quote_hash: quoteHash,
      };
      return {
        ref: (
          'mnemosyne://committed-body-segment/v1/'
          + sha256(canonicalJson(identity)).slice(0, 32)
        ),
        ordinal,
        start,
        end,
        quote_hash: quoteHash,
        text,
      };
    },
  );
  const identity = {
    schema: 'mnemosyne.committed-body-segment-directory.v1',
    segmenter_revision: COMMITTED_BODY_SEGMENTER_REVISION,
    commit_id: commitId,
    body_hash: bodyHash,
    segments,
  };
  return {
    ...identity,
    directory_hash: sha256(canonicalJson(identity)),
  };
}

export function isCommittedBodySegmentRef(value) {
  return (
    typeof value === 'string'
    && COMMITTED_BODY_SEGMENT_REF_PATTERN.test(value)
  );
}

export function resolveCommittedBodySegmentRef({
  directory,
  body,
  ref,
  commitId,
  bodyHash,
} = {}) {
  if (!isCommittedBodySegmentRef(ref)) return null;
  const expected = createCommittedBodySegmentDirectory({
    commitId,
    bodyHash,
    body,
  });
  if (canonicalJson(directory) !== canonicalJson(expected)) {
    throw new TypeError(
      'Committed-body segment directory does not match the locked body.',
    );
  }
  const segment = expected.segments.find(candidate => (
    candidate.ref === ref
  ));
  return segment ? structuredClone(segment) : null;
}
