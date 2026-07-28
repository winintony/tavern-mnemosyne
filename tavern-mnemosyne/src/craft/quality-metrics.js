import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';

// M10 deterministic quality metrics engine. Zero model calls, zero prompt
// tokens: every value is a pure function of the committed body, the
// hash-verified active-lane history, and this sealed engine configuration.
// Results are observability accounting only — they never enter a prompt,
// never claim quality, and their thresholds are first-cycle record-only.

export const QUALITY_METRICS_ENGINE_VERSION =
  'mnemosyne.quality-metrics-engine.v1';

// Language-neutral deterministic tokenizer: CJK codepoints count as single
// tokens; Latin/Greek/Cyrillic words and digit runs count as one token.
// Implemented in-repo (no ICU dependency) so recomputation is stable.
export const TOKENIZER_PROFILE = Object.freeze({
  id: 'mnemosyne.tokenizer.cjk-latin.v1',
  cjk: 'single-codepoint',
  word: '[\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}0-9]+',
});
export const TOKENIZER_CONFIG_HASH = sha256(canonicalJson(TOKENIZER_PROFILE));

const CJK_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const TOKEN_PATTERN =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const SENTENCE_SPLIT_PATTERN = /[。！？!?…\n]+/u;
const MATTR_WINDOW = 50;
const MTLD_THRESHOLD = 0.72;
const SENTENCE_TEMPLATE_TOKENS = 2;
// First-cycle record-only slopes; no consumer reads these flags.
const MATTR_DECLINE_SLOPE = -0.005;
const ECHO_RISE_SLOPE = 0.02;

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

export function tokenize(text) {
  if (typeof text !== 'string') return [];
  return (text.match(TOKEN_PATTERN) ?? []).map(token => (
    CJK_PATTERN.test(token) ? token : token.toLowerCase()
  ));
}

export function movingAverageTtr(tokens, window = MATTR_WINDOW) {
  if (tokens.length === 0) return 0;
  if (tokens.length <= window) {
    return new Set(tokens).size / tokens.length;
  }
  let total = 0;
  let count = 0;
  for (let start = 0; start + window <= tokens.length; start += 1) {
    total += new Set(tokens.slice(start, start + window)).size / window;
    count += 1;
  }
  return total / count;
}

function mtldForward(tokens, threshold) {
  if (tokens.length === 0) return 0;
  let factors = 0;
  let typeSet = new Set();
  let tokenCount = 0;
  for (const token of tokens) {
    tokenCount += 1;
    typeSet.add(token);
    if (typeSet.size / tokenCount <= threshold) {
      factors += 1;
      typeSet = new Set();
      tokenCount = 0;
    }
  }
  if (tokenCount > 0) {
    const ttr = typeSet.size / tokenCount;
    factors += ttr >= 1
      ? 0
      : (1 - ttr) / (1 - threshold);
  }
  return factors === 0 ? tokens.length : tokens.length / factors;
}

export function mtld(tokens, threshold = MTLD_THRESHOLD) {
  if (tokens.length === 0) return 0;
  return (
    mtldForward(tokens, threshold)
    + mtldForward([...tokens].reverse(), threshold)
  ) / 2;
}

export function sentenceStartTemplates(text) {
  return String(text ?? '')
    .split(SENTENCE_SPLIT_PATTERN)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .map(sentence => tokenize(sentence)
      .slice(0, SENTENCE_TEMPLATE_TOKENS)
      .join(' '))
    .filter(Boolean);
}

export function fourGrams(tokens) {
  const grams = new Set();
  for (let index = 0; index + 4 <= tokens.length; index += 1) {
    grams.add(tokens.slice(index, index + 4).join(' '));
  }
  return grams;
}

function ratio(part, whole) {
  return whole === 0 ? 0 : part / whole;
}

export function fourGramEchoRate(bodyTokens, historyGramSets) {
  const grams = fourGrams(bodyTokens);
  if (grams.size === 0) return 0;
  let echoed = 0;
  for (const gram of grams) {
    if (historyGramSets.some(set => set.has(gram))) echoed += 1;
  }
  return ratio(echoed, grams.size);
}

export function sentenceStartEchoRate(body, historyTemplateSets) {
  const templates = sentenceStartTemplates(body);
  if (templates.length === 0) return 0;
  let echoed = 0;
  for (const template of templates) {
    if (historyTemplateSets.some(set => set.has(template))) echoed += 1;
  }
  return ratio(echoed, templates.length);
}

function paragraphSignature(body) {
  return String(body ?? '')
    .split(/\n{2,}|\n/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => {
      const length = tokenize(paragraph).length;
      if (length <= 10) return 's';
      if (length <= 40) return 'm';
      return 'l';
    })
    .join('');
}

function leastSquaresSlope(series) {
  if (series.length < 2) return 0;
  const count = series.length;
  const meanX = (count - 1) / 2;
  const meanY = series.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    numerator += (index - meanX) * (series[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function detectPositiveEnding({ body, lexicon }) {
  const sentences = String(body ?? '')
    .split(SENTENCE_SPLIT_PATTERN)
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const tail = sentences.slice(-2).join('');
  if (!tail) return 0;
  return lexicon.phrases.some(entry => tail.includes(entry.phrase)) ? 1 : 0;
}

// historyBodies: ascending [{turn_index, body}] strictly before the current
// turn. deltaMode/recordCount come from the just-committed typed delta.
export function computeQualityMetrics({
  body,
  historyBodies,
  deltaMode,
  recordCount,
  trendWindowTurns,
  positivityLexicon = null,
  slopResult = null,
} = {}) {
  if (
    typeof body !== 'string'
    || !Array.isArray(historyBodies)
    || !['changed', 'no_change'].includes(deltaMode)
    || !Number.isInteger(recordCount) || recordCount < 0
    || !Number.isInteger(trendWindowTurns) || trendWindowTurns < 2
  ) {
    fail(
      'quality_metrics_input_invalid',
      'Quality metrics need the committed body, history, and delta facts.',
    );
  }
  const bodyTokens = tokenize(body);
  const historyTokenLists = historyBodies.map(entry => tokenize(entry.body));
  const historyGramSets = historyTokenLists.map(fourGrams);
  const historyTemplateSets = historyBodies.map(entry => (
    new Set(sentenceStartTemplates(entry.body))
  ));
  const currentSignature = paragraphSignature(body);
  const paragraphRepetition = ratio(
    historyBodies.filter(entry => (
      paragraphSignature(entry.body) === currentSignature
      && currentSignature !== ''
    )).length,
    historyBodies.length,
  );

  const metric = (value, experimental = false) => ({
    value: round(value),
    experimental,
  });
  const metrics = {
    mattr: metric(movingAverageTtr(bodyTokens)),
    mtld: metric(mtld(bodyTokens)),
    sentence_start_echo_rate: metric(
      sentenceStartEchoRate(body, historyTemplateSets),
    ),
    paragraph_structure_repetition: metric(paragraphRepetition),
    four_gram_echo_rate: metric(
      fourGramEchoRate(bodyTokens, historyGramSets),
    ),
    substantive_change_count: metric(recordCount),
    no_change_turn: metric(deltaMode === 'no_change' ? 1 : 0),
  };
  const disabledMetrics = [];
  if (positivityLexicon) {
    metrics.positive_ending = metric(
      detectPositiveEnding({ body, lexicon: positivityLexicon }),
      true,
    );
  } else {
    disabledMetrics.push({
      id: 'positive_ending',
      reason_code: 'lexicon_not_configured',
    });
  }
  if (slopResult) {
    metrics.slop_hit_count = metric(slopResult.hit_count);
    metrics.slop_high_severity_hit_count = metric(
      slopResult.high_severity_hit_count,
    );
    metrics.echo_rate = metric(slopResult.echo_rate);
  }

  // Trend series over the trailing trend window, current turn included.
  const trendEntries = [
    ...historyBodies.map((entry, index) => ({
      tokens: historyTokenLists[index],
      body: entry.body,
      historyIndex: index,
    })),
    { tokens: bodyTokens, body, historyIndex: historyBodies.length },
  ].slice(-trendWindowTurns);
  const mattrSeries = trendEntries.map(entry => (
    movingAverageTtr(entry.tokens)
  ));
  const echoSeries = trendEntries.map(entry => fourGramEchoRate(
    entry.tokens,
    historyGramSets.slice(0, entry.historyIndex),
  ));
  const mattrSlope = leastSquaresSlope(mattrSeries);
  const echoSlope = leastSquaresSlope(echoSeries);
  const degradation = {
    consumers: 'none',
    slopes: {
      mattr: round(mattrSlope),
      four_gram_echo_rate: round(echoSlope),
    },
    flags: {
      lexical_diversity_declining: mattrSlope < MATTR_DECLINE_SLOPE,
      echo_rising: echoSlope > ECHO_RISE_SLOPE,
    },
  };
  return { metrics, disabledMetrics, degradation };
}
