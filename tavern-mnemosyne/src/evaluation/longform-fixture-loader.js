// Loads a longform fixture directory
// (tests/fixtures/longform/<fixture_id>/) from disk and validates it with
// longform-fixture-schema.js. Filesystem-only: no provider, no network.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  validateLongformFixtureBundle,
} from './longform-fixture-schema.js';

function invalid(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

async function readJson(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw invalid(
      'LONGFORM_FIXTURE_FILE_MISSING',
      `Unable to read fixture document: ${filePath} (${error.message})`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw invalid(
      'LONGFORM_FIXTURE_FILE_INVALID_JSON',
      `Fixture document is not valid JSON: ${filePath} (${error.message})`,
    );
  }
}

function sequenceFromFileName(fileName) {
  const match = /^step-(\d{3,})\.json$/u.exec(fileName);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function readStepDocuments(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw invalid(
      'LONGFORM_FIXTURE_DIR_MISSING',
      `Unable to list fixture directory: ${dir} (${error.message})`,
    );
  }
  const documents = new Map();
  for (const fileName of entries.sort()) {
    const sequence = sequenceFromFileName(fileName);
    if (sequence === null) continue;
    documents.set(sequence, await readJson(path.join(dir, fileName)));
  }
  return documents;
}

// Loads and validates a single fixture bundle.
//
// Returns { fixture, scripts: Map<sequence, script>,
// oracles: Map<sequence, oracle> } with the three candidate schemas
// (mnemosyne.longform-fixture.v1 / longform-turn-script.v1 /
// longform-oracle.v1) already cross-checked by
// validateLongformFixtureBundle. `sequence` is the global step order
// (script/step-NNN.json, oracle/step-NNN.json) -- a purely linear fixture
// has sequence === turn_index, but swipe/branch_fork/truncate steps add
// steps without adding new turn numbers, so the two diverge once a
// fixture uses them.
export async function loadLongformFixture(fixtureDir) {
  const fixture = await readJson(path.join(fixtureDir, 'fixture.json'));
  const scripts = await readStepDocuments(path.join(fixtureDir, 'script'));
  const oracles = await readStepDocuments(path.join(fixtureDir, 'oracle'));
  validateLongformFixtureBundle({ fixture, scripts, oracles });
  return Object.freeze({ fixture, scripts, oracles });
}
