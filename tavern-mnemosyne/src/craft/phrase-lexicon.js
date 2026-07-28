import { readFile } from 'node:fs/promises';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';

const LEXICON_SCHEMA = 'mnemosyne.phrase-lexicon.v1';
const SEVERITIES = new Set(['low', 'medium', 'high']);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

// Versioned, content-hashed phrase asset shared by the M11 slop lane and the
// M10 experimental positivity detector. Assets are built offline per
// locale_profile + genre_profile; a missing or hash-drifted asset fails
// closed as a disabled lane, never as a silently borrowed language pack.
export function lexiconContentHash(lexicon) {
  return sha256(canonicalJson({
    schema: lexicon.schema,
    lexicon_id: lexicon.lexicon_id,
    locale_profile: lexicon.locale_profile,
    genre_profile: lexicon.genre_profile,
    version: lexicon.version,
    phrases: lexicon.phrases,
  }));
}

export function validatePhraseLexicon(lexicon) {
  if (
    !lexicon
    || typeof lexicon !== 'object'
    || Array.isArray(lexicon)
    || lexicon.schema !== LEXICON_SCHEMA
    || typeof lexicon.lexicon_id !== 'string'
    || !lexicon.lexicon_id
    || typeof lexicon.locale_profile !== 'string'
    || !lexicon.locale_profile
    || typeof lexicon.genre_profile !== 'string'
    || !lexicon.genre_profile
    || typeof lexicon.version !== 'string'
    || !lexicon.version
    || !Array.isArray(lexicon.phrases)
    || lexicon.phrases.length === 0
    || typeof lexicon.content_hash !== 'string'
  ) {
    fail(
      'phrase_lexicon_invalid',
      'A phrase lexicon asset must carry identity, phrases, and a hash.',
    );
  }
  for (const [index, entry] of lexicon.phrases.entries()) {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || typeof entry.phrase !== 'string'
      || !entry.phrase.trim()
      || !SEVERITIES.has(entry.severity)
      || Object.keys(entry).length !== 2
    ) {
      fail(
        'phrase_lexicon_invalid',
        'A phrase lexicon entry must be {phrase, severity}.',
        { index },
      );
    }
  }
  const expectedHash = lexiconContentHash(lexicon);
  if (lexicon.content_hash !== expectedHash) {
    fail(
      'phrase_lexicon_hash_mismatch',
      'The phrase lexicon content does not match its sealed hash.',
      { expected_hash: expectedHash },
    );
  }
  return lexicon;
}

export async function loadPhraseLexicon(lexiconPath) {
  let serialized;
  try {
    serialized = await readFile(lexiconPath, 'utf8');
  } catch {
    fail(
      'phrase_lexicon_missing',
      'The configured phrase lexicon asset cannot be read.',
      { lexicon_path: String(lexiconPath) },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail(
      'phrase_lexicon_invalid',
      'The configured phrase lexicon asset is not valid JSON.',
    );
  }
  return validatePhraseLexicon(parsed);
}
