import { MnemosyneRequestError } from '../contracts/errors.js';
import { loadPhraseLexicon } from './phrase-lexicon.js';
import {
  fourGrams,
  sentenceStartTemplates,
  tokenize,
} from './quality-metrics.js';

// M11 detection lane (batch A): a deterministic, zero-model-call detector
// over the committed body. Inputs are the versioned global slop lexicon and
// the per-chat dynamic echo table derived from recent active-lane bodies
// (already branch/epoch/candidate filtered by the caller). Results only mark
// spans and matched phrases — they never say what to write.
//
// Language neutrality: with no configured or verifiable lexicon the lane
// reports an explicit disabled state instead of borrowing another locale's
// phrase list. zh-CN ships as an optional first asset, not a default.

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function phraseHits(body, lexicon) {
  const hits = [];
  for (const { phrase, severity } of lexicon.phrases) {
    let cursor = 0;
    while (cursor <= body.length - phrase.length) {
      const start = body.indexOf(phrase, cursor);
      if (start === -1) break;
      hits.push({
        phrase,
        severity,
        start,
        end: start + phrase.length,
      });
      cursor = start + phrase.length;
    }
  }
  hits.sort((left, right) => (
    left.start - right.start
    || left.phrase.localeCompare(right.phrase)
  ));
  return hits;
}

// Dynamic echo table: 4-grams and sentence-start templates that already
// recur across the recent active lane (in at least two prior bodies, or
// twice within one prior body).
function buildEchoTable(historyBodies) {
  const gramBodies = new Map();
  const templateBodies = new Map();
  for (const [bodyIndex, entry] of historyBodies.entries()) {
    const tokens = tokenize(entry.body);
    const gramCounts = new Map();
    for (let index = 0; index + 4 <= tokens.length; index += 1) {
      const gram = tokens.slice(index, index + 4).join(' ');
      gramCounts.set(gram, (gramCounts.get(gram) ?? 0) + 1);
    }
    for (const [gram, count] of gramCounts) {
      const existing = gramBodies.get(gram) ?? { bodies: new Set(), repeated: false };
      existing.bodies.add(bodyIndex);
      if (count >= 2) existing.repeated = true;
      gramBodies.set(gram, existing);
    }
    for (const template of new Set(sentenceStartTemplates(entry.body))) {
      const existing = templateBodies.get(template) ?? new Set();
      existing.add(bodyIndex);
      templateBodies.set(template, existing);
    }
  }
  return {
    grams: new Set([...gramBodies]
      .filter(([, info]) => info.bodies.size >= 2 || info.repeated)
      .map(([gram]) => gram)),
    templates: new Set([...templateBodies]
      .filter(([, bodies]) => bodies.size >= 2)
      .map(([template]) => template)),
  };
}

export function detectSlop({ body, historyBodies, lexicon } = {}) {
  if (
    typeof body !== 'string'
    || !Array.isArray(historyBodies)
    || !lexicon
  ) {
    fail(
      'slop_detection_input_invalid',
      'Slop detection needs the body, history, and a verified lexicon.',
    );
  }
  const hits = phraseHits(body, lexicon);
  const table = buildEchoTable(historyBodies);
  const bodyTokens = tokenize(body);
  const bodyGrams = fourGrams(bodyTokens);
  let echoedGrams = 0;
  for (const gram of bodyGrams) {
    if (table.grams.has(gram)) echoedGrams += 1;
  }
  const templates = sentenceStartTemplates(body);
  let echoedTemplates = 0;
  for (const template of templates) {
    if (table.templates.has(template)) echoedTemplates += 1;
  }
  const denominator = bodyGrams.size + templates.length;
  const echoed = echoedGrams + echoedTemplates;
  return {
    hit_count: hits.length,
    high_severity_hit_count: hits
      .filter(hit => hit.severity === 'high').length,
    echo_rate: denominator === 0
      ? 0
      : Math.round((echoed / denominator) * 1e6) / 1e6,
    hits,
  };
}

export async function createSlopDetector({
  lexiconPath,
  historyWindowTurns,
} = {}) {
  if (!Number.isInteger(historyWindowTurns) || historyWindowTurns < 1) {
    fail(
      'slop_detection_input_invalid',
      'Slop detection needs a positive history window.',
    );
  }
  if (typeof lexiconPath !== 'string' || !lexiconPath) {
    return disabledSlopDetector('slop_lexicon_not_configured');
  }
  let lexicon;
  try {
    lexicon = await loadPhraseLexicon(lexiconPath);
  } catch (error) {
    return disabledSlopDetector(
      error?.reasonCode ?? 'slop_lexicon_unavailable',
    );
  }
  return Object.freeze({
    status: 'active',
    detect({ body, historyBodies }) {
      return detectSlop({
        body,
        historyBodies: historyBodies.slice(-historyWindowTurns),
        lexicon,
      });
    },
    seal() {
      return {
        status: 'active',
        lexicon_id: lexicon.lexicon_id,
        version: lexicon.version,
        content_hash: lexicon.content_hash,
      };
    },
  });
}

// The disabled lane still participates in accounting: every quality event
// seals the explicit disabled reason instead of silently omitting the lane.
function disabledSlopDetector(reasonCode) {
  return Object.freeze({
    status: 'disabled',
    reason_code: reasonCode,
    detect() {
      return null;
    },
    seal() {
      return {
        status: 'disabled',
        reason_code: reasonCode,
      };
    },
  });
}
