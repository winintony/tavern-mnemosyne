import { canonicalJson, sha256 } from '../contracts/hash.js';
import { STORY_COVERAGE_FACETS } from '../memory/story-coverage.js';

const MANIFEST_SCHEMA = 'mnemosyne.turn-capture-manifest.v1';
const REPORT_SCHEMA = 'mnemosyne.turn-capture-report.v1';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LIFECYCLES = new Set(['new', 'update', 'supersede']);

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isObject(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every(key => expected.includes(key));
}

function compactStrings(value, maximum = 32) {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every(item => typeof item === 'string' && item.trim())
    && new Set(value).size === value.length;
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'TURN_CAPTURE_MANIFEST_INVALID';
  return error;
}

function assertSemantic(value, field) {
  if (!isObject(value)) throw invalid(`${field} must be an object.`);
  try {
    canonicalJson(value);
  } catch {
    throw invalid(`${field} must be canonical JSON.`);
  }
}

function assertManifest(manifest) {
  if (
    !exactKeys(manifest, [
      'schema',
      'manifest_id',
      'coordinate',
      'expectations',
      'abstentions',
      'continuation',
    ])
    || manifest.schema !== MANIFEST_SCHEMA
    || !SAFE_ID_PATTERN.test(manifest.manifest_id ?? '')
    || !exactKeys(manifest.coordinate, [
      'chat_id',
      'branch_id',
      'branch_epoch',
      'turn_index',
      'candidate_id',
    ])
    || typeof manifest.coordinate.chat_id !== 'string'
    || !manifest.coordinate.chat_id
    || typeof manifest.coordinate.branch_id !== 'string'
    || !manifest.coordinate.branch_id
    || !Number.isSafeInteger(manifest.coordinate.branch_epoch)
    || manifest.coordinate.branch_epoch < 0
    || !Number.isSafeInteger(manifest.coordinate.turn_index)
    || manifest.coordinate.turn_index < 0
    || typeof manifest.coordinate.candidate_id !== 'string'
    || !manifest.coordinate.candidate_id
    || !Array.isArray(manifest.expectations)
    || !Array.isArray(manifest.abstentions)
  ) {
    throw invalid('Turn capture manifest envelope is invalid.');
  }
  const ids = new Set();
  for (const expectation of manifest.expectations) {
    if (
      !exactKeys(expectation, [
        'expectation_id',
        'facet',
        'expected_semantic',
        'source_quote',
        'lifecycle',
      ])
      || !SAFE_ID_PATTERN.test(expectation.expectation_id ?? '')
      || !STORY_COVERAGE_FACETS.includes(expectation.facet)
      || typeof expectation.source_quote !== 'string'
      || !expectation.source_quote
      || !LIFECYCLES.has(expectation.lifecycle)
      || ids.has(expectation.expectation_id)
    ) {
      throw invalid('Turn capture expectation is invalid.');
    }
    assertSemantic(
      expectation.expected_semantic,
      'expectation.expected_semantic',
    );
    ids.add(expectation.expectation_id);
  }
  for (const abstention of manifest.abstentions) {
    if (
      !exactKeys(abstention, [
        'expectation_id',
        'facet',
        'forbidden_semantic',
      ])
      || !SAFE_ID_PATTERN.test(abstention.expectation_id ?? '')
      || !STORY_COVERAGE_FACETS.includes(abstention.facet)
      || ids.has(abstention.expectation_id)
    ) {
      throw invalid('Turn capture abstention is invalid.');
    }
    assertSemantic(
      abstention.forbidden_semantic,
      'abstention.forbidden_semantic',
    );
    ids.add(abstention.expectation_id);
  }
  if (
    manifest.continuation !== null
    && (
      !exactKeys(manifest.continuation, [
        'retrieval_observed',
        'required_anchors',
        'wrong_version_anchors',
        'contradiction_anchors',
      ])
      || typeof manifest.continuation.retrieval_observed !== 'boolean'
      || !compactStrings(manifest.continuation.required_anchors)
      || manifest.continuation.required_anchors.length === 0
      || !compactStrings(manifest.continuation.wrong_version_anchors)
      || !compactStrings(manifest.continuation.contradiction_anchors)
    )
  ) {
    throw invalid('Turn capture continuation case is invalid.');
  }
}

function recordFacet(record) {
  if (record?.kind === 'continuity_state') {
    return record.state?.domain === 'attribute'
      ? 'attribute_value'
      : 'current_state';
  }
  return STORY_COVERAGE_FACETS.includes(record?.kind)
    ? record.kind
    : null;
}

function semanticOf(record) {
  return record?.payload ?? record?.event ?? record?.state ?? null;
}

function identityOf(record) {
  const semantic = semanticOf(record);
  switch (recordFacet(record)) {
    case 'current_state':
    case 'attribute_value':
      return canonicalJson([
        record.entity_ref,
        semantic?.domain,
        semantic?.key,
      ]);
    case 'character':
      return canonicalJson([
        semantic?.subject_ref,
        semantic?.change_kind,
      ]);
    case 'character_cognition':
      return canonicalJson([
        semantic?.owner_ref,
        semantic?.about_ref,
        semantic?.record_kind,
      ]);
    case 'relationship':
      return canonicalJson([semantic?.relationship_ref]);
    case 'world_lore':
      return canonicalJson([
        semantic?.subject_ref,
        semantic?.lore_kind,
      ]);
    case 'plot_thread':
      return canonicalJson([semantic?.thread_ref]);
    case 'scene_state':
      return canonicalJson([semantic?.scene_ref]);
    case 'scene_event':
      return canonicalJson([record.entity_ref]);
    default:
      return null;
  }
}

function sourceCorrect(record, body, sourceQuote) {
  const span = record?.source_span;
  return (
    isObject(span)
    && Number.isSafeInteger(span.start)
    && Number.isSafeInteger(span.end)
    && span.start >= 0
    && span.end > span.start
    && span.end <= body.length
    && span.quote === sourceQuote
    && body.slice(span.start, span.end) === sourceQuote
    && body.indexOf(sourceQuote) === span.start
    && body.indexOf(sourceQuote, span.end) === -1
  );
}

function ratio(passed, total) {
  return total === 0 ? null : passed / total;
}

function continuationOutcome(specification, body) {
  if (specification === null) return 'not_evaluated';
  const correct = specification.required_anchors.every(anchor => (
    body.includes(anchor)
  ));
  const wrong = specification.wrong_version_anchors.some(anchor => (
    body.includes(anchor)
  ));
  const contradiction = specification.contradiction_anchors.some(anchor => (
    body.includes(anchor)
  ));
  if (!specification.retrieval_observed || !correct) {
    return 'retrieved_but_unused';
  }
  if (wrong) return 'used_wrong_version';
  if (contradiction) return 'correct_use_with_contradiction';
  return 'correct_use';
}

export function evaluateTurnCaptureManifest({
  manifest,
  artifact,
  activeBefore = [],
  activeAfter = [],
  continuationBody = '',
} = {}) {
  assertManifest(manifest);
  if (
    !isObject(artifact)
    || artifact.chat_id !== manifest.coordinate.chat_id
    || artifact.branch_id !== manifest.coordinate.branch_id
    || artifact.branch_epoch !== manifest.coordinate.branch_epoch
    || artifact.turn_index !== manifest.coordinate.turn_index
    || artifact.candidate_id !== manifest.coordinate.candidate_id
    || typeof artifact.assistant_message?.content !== 'string'
    || !Array.isArray(artifact.delta?.records)
    || !Array.isArray(activeBefore)
    || !Array.isArray(activeAfter)
    || typeof continuationBody !== 'string'
  ) {
    throw invalid('Turn capture evidence does not bind to the manifest.');
  }
  const records = artifact.delta.records;
  const used = new Set();
  const facets = Object.fromEntries(STORY_COVERAGE_FACETS.map(facet => [
    facet,
    { expected: 0, captured: 0, recall: null },
  ]));
  let sourcesCorrect = 0;
  let lifecycleVerified = 0;
  const checks = manifest.expectations.map(expectation => {
    const candidates = records
      .map((record, index) => ({ record, index }))
      .filter(({ record, index }) => (
        !used.has(index)
        && recordFacet(record) === expectation.facet
        && canonicalJson(semanticOf(record))
          === canonicalJson(expectation.expected_semantic)
      ));
    const match = candidates.length === 1 ? candidates[0] : null;
    if (match) used.add(match.index);
    const sourcePassed = match
      ? sourceCorrect(
          match.record,
          artifact.assistant_message.content,
          expectation.source_quote,
        )
      : false;
    const identity = match ? identityOf(match.record) : null;
    const beforeHasIdentity = identity !== null && activeBefore.some(
      record => identityOf(record) === identity,
    );
    const effectiveAfter = identity === null
      ? null
      : [...activeAfter].reverse().find(
          record => identityOf(record) === identity,
        ) ?? null;
    const afterMatches = match !== null
      && effectiveAfter !== null
      && canonicalJson(effectiveAfter) === canonicalJson(match.record);
    const lifecyclePassed = match !== null && (
      expectation.lifecycle === 'new'
        ? !beforeHasIdentity
        : beforeHasIdentity && afterMatches
    );
    const passed = match !== null && sourcePassed && lifecyclePassed;
    facets[expectation.facet].expected += 1;
    if (match) facets[expectation.facet].captured += 1;
    if (sourcePassed) sourcesCorrect += 1;
    if (lifecyclePassed) lifecycleVerified += 1;
    return {
      expectation_id: expectation.expectation_id,
      facet: expectation.facet,
      status: passed ? 'passed' : 'failed',
      observed: {
        capture_status: match
          ? 'captured'
          : candidates.length > 1
            ? 'ambiguous'
            : 'missing',
        source_correct: sourcePassed,
        lifecycle_correct: lifecyclePassed,
        record_hash: match
          ? sha256(canonicalJson(match.record))
          : null,
      },
    };
  });
  for (const value of Object.values(facets)) {
    value.recall = ratio(value.captured, value.expected);
  }
  const abstentions = manifest.abstentions.map(expectation => {
    const forbidden = records.some(record => (
      recordFacet(record) === expectation.facet
      && canonicalJson(semanticOf(record))
        === canonicalJson(expectation.forbidden_semantic)
    ));
    return {
      expectation_id: expectation.expectation_id,
      facet: expectation.facet,
      status: forbidden ? 'failed' : 'passed',
    };
  });
  const abstentionPassed = abstentions.filter(
    check => check.status === 'passed',
  ).length;
  const captured = Object.values(facets).reduce(
    (sum, value) => sum + value.captured,
    0,
  );
  const continuationUse = continuationOutcome(
    manifest.continuation,
    continuationBody,
  );
  const report = {
    schema: REPORT_SCHEMA,
    manifest_id: manifest.manifest_id,
    manifest_hash: sha256(canonicalJson(manifest)),
    coordinate: structuredClone(manifest.coordinate),
    capture: {
      facets,
      expected: manifest.expectations.length,
      captured,
      recall: ratio(captured, manifest.expectations.length),
    },
    source_correctness: {
      expected: manifest.expectations.length,
      correct: sourcesCorrect,
      rate: ratio(sourcesCorrect, manifest.expectations.length),
    },
    abstention: {
      expected: abstentions.length,
      correct: abstentionPassed,
      rate: ratio(abstentionPassed, abstentions.length),
    },
    update_supersede: {
      expected: manifest.expectations.length,
      correct: lifecycleVerified,
      rate: ratio(lifecycleVerified, manifest.expectations.length),
    },
    continuation_use: {
      outcome: continuationUse,
      passed: ['not_evaluated', 'correct_use'].includes(continuationUse),
    },
    checks,
    abstention_checks: abstentions,
  };
  return Object.freeze({
    ...report,
    report_hash: sha256(canonicalJson(report)),
  });
}
