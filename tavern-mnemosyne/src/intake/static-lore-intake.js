import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';

import {
  acceptedBaselineClaimLine,
} from '../contracts/accepted-baseline-claim.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  serializeOkfConcept,
  validateOkfBundle,
} from '../okf/bundle.js';
import {
  OKF_ENTITY_PREFIXES,
  OKF_TYPE_DIRECTORIES,
} from '../okf/schema.js';
import {
  recoverStagedFileTransaction,
  runStagedFileTransaction,
} from '../storage/staged-file-transaction.js';
import { buildStaticLoreSourceUnits } from './static-lore-source-units.js';

const EXTRACTION_SCHEMA = 'mnemosyne.static-lore-extraction.v1';
const SOURCE_REF_FIELDS = new Set([
  'source_refs',
]);
const RESERVED_FACET_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertPlainData(value, label) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertPlainData(item, `${label}[${index}]`);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must contain JSON-compatible data.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_FACET_KEYS.has(key)) {
      throw new Error(`${label} contains a reserved key.`);
    }
    assertPlainData(item, `${label}.${key}`);
  }
}

function sourceUnitRefs(snapshot) {
  return new Set(buildStaticLoreSourceUnits({
    snapshotId: snapshot.snapshot_id,
    sources: snapshot.sources,
  }).map(unit => unit.ref));
}

function collectSourceRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  for (const [key, item] of Object.entries(value)) {
    if (SOURCE_REF_FIELDS.has(key)) {
      if (!Array.isArray(item)) {
        throw new Error(`${key} must be an array.`);
      }
      refs.push(...item);
    } else {
      collectSourceRefs(item, refs);
    }
  }
  return refs;
}

function assertSourceRefs(extraction, snapshotRefs, allowedRefs = snapshotRefs) {
  const refs = collectSourceRefs(extraction);
  for (const ref of refs) {
    if (
      typeof ref !== 'string'
      || !snapshotRefs.has(ref)
      || !allowedRefs.has(ref)
    ) {
      throw new Error(`Extraction contains an unrecognized source ref: ${ref}`);
    }
  }
}

function assertExtraction(extraction, snapshot) {
  if (extraction?.schema !== EXTRACTION_SCHEMA) {
    throw new Error(`Unsupported Static Lore extraction schema: ${extraction?.schema}`);
  }
  if (extraction.snapshot_hash !== snapshot.snapshot_hash) {
    throw new Error('Static Lore extraction does not match the captured snapshot.');
  }
  if (!Array.isArray(extraction.concepts)) {
    throw new Error('Static Lore extraction concepts must be an array.');
  }

  const keys = new Set();
  const conceptsByKey = new Map();
  const slugsByDirectory = new Set();
  for (const concept of extraction.concepts) {
    assertNonEmptyString(concept?.concept_key, 'concept_key');
    if (keys.has(concept.concept_key)) {
      throw new Error(`Duplicate concept_key: ${concept.concept_key}`);
    }
    keys.add(concept.concept_key);
    conceptsByKey.set(concept.concept_key, concept);
    const directory = OKF_TYPE_DIRECTORIES[concept.type];
    if (!directory) {
      throw new Error(`Unsupported OKF concept type: ${concept.type}`);
    }
    assertNonEmptyString(concept.title, `${concept.concept_key}.title`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(concept.slug ?? '')) {
      throw new Error(`Invalid concept slug: ${concept.slug}`);
    }
    const slugKey = `${directory}/${concept.slug}`;
    if (slugsByDirectory.has(slugKey)) {
      throw new Error(`Duplicate concept path: ${slugKey}`);
    }
    slugsByDirectory.add(slugKey);
    assertNonEmptyString(concept.description, `${concept.concept_key}.description`);
    if (!Array.isArray(concept.aliases) || !Array.isArray(concept.tags)) {
      throw new Error(`${concept.concept_key} aliases and tags must be arrays.`);
    }
    if (!Array.isArray(concept.source_refs) || concept.source_refs.length === 0) {
      throw new Error(`${concept.concept_key} requires source_refs.`);
    }
    if (!Array.isArray(concept.links)) {
      throw new Error(`${concept.concept_key}.links must be an array.`);
    }
    for (const link of concept.links) {
      if (!keys.has(link.target_key)) {
        // Forward links are checked after all keys are known.
        assertNonEmptyString(link.target_key, `${concept.concept_key}.link.target_key`);
      }
      assertNonEmptyString(link.relation, `${concept.concept_key}.link.relation`);
    }
    assertPlainData(concept.facets ?? {}, `${concept.concept_key}.facets`);
    if (!Array.isArray(concept.baseline_claims)) {
      throw new Error(`${concept.concept_key}.baseline_claims must be an array.`);
    }
    for (const claim of concept.baseline_claims) {
      assertNonEmptyString(claim?.claim, `${concept.concept_key}.baseline_claim`);
    }
  }

  for (const concept of extraction.concepts) {
    for (const link of concept.links) {
      if (!keys.has(link.target_key)) {
        throw new Error(`Unknown concept link target: ${link.target_key}`);
      }
      if (
        link.relation === 'located_at'
        && !conceptsByKey.get(link.target_key)?.tags?.includes('location')
      ) {
        throw new Error('located_at links must target a location concept.');
      }
    }
  }
  for (const collection of [
    extraction.attribute_definitions ?? [],
    extraction.progression_tracks ?? [],
    extraction.current_state ?? [],
    extraction.topology ?? [],
  ]) {
    if (!Array.isArray(collection)) {
      throw new Error('Static Lore extraction collections must be arrays.');
    }
  }
  for (const state of extraction.current_state ?? []) {
    if (!keys.has(state.entity_key)) {
      throw new Error(`Unknown current_state entity: ${state.entity_key}`);
    }
  }
  for (const edge of extraction.topology ?? []) {
    if (!keys.has(edge.entity_key) || !keys.has(edge.parent_key)) {
      throw new Error('Topology edges must reference extracted concepts.');
    }
    if (
      edge.relation !== 'located_at'
      || edge.status !== 'baseline'
      || !conceptsByKey.get(edge.parent_key)?.tags?.includes('location')
      || edge.entity_key === edge.parent_key
    ) {
      throw new Error('Topology edges must be baseline spatial containment.');
    }
  }
}

function defaultEntityId(type) {
  return `${OKF_ENTITY_PREFIXES[type]}_${randomUUID().replaceAll('-', '')}`;
}

function conceptBody(concept, conceptByKey) {
  const claimLines = concept.baseline_claims.map(claim => (
    acceptedBaselineClaimLine({
      claimKind: claim.claim_kind ?? 'fact',
      canonicalClaim: claim.claim,
    })
  ));
  const sections = [
    '# Summary',
    concept.description,
  ];
  if (claimLines.length > 0) {
    sections.push('# Imported Baseline Claims', ...claimLines);
  }
  if (Object.keys(concept.facets ?? {}).length > 0) {
    sections.push(
      '# Structured Facets',
      '```yaml',
      stringify(concept.facets).trimEnd(),
      '```',
    );
  }
  if (concept.links.length > 0) {
    sections.push(
      '# Related Concepts',
      ...concept.links.map(link => {
        const target = conceptByKey.get(link.target_key);
        return `- [${target.title}](${target.path}) (${link.relation})`;
      }),
    );
  }
  return sections.join('\n\n');
}

function storyMemoryIndex(concepts) {
  return [
    '# Story Memory',
    '',
    '## Concepts',
    '',
    ...concepts
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(concept => (
        `- [${concept.title}](${concept.path}) `
        + `(\`${concept.type}\`, \`${concept.entity_id}\`)`
      )),
    '',
  ].join('\n');
}

function intakeLogEntry({
  previous,
  timestamp,
  snapshotId,
  intakeId,
  concepts,
  mode,
}) {
  const base = previous.endsWith('\n') ? previous : `${previous}\n`;
  const label = mode === 'reconcile'
    ? 'Static Lore Reconcile'
    : 'Static Lore Intake';
  return [
    base.trimEnd(),
    '',
    `## ${timestamp} - ${label}`,
    '',
    `- Snapshot: \`${snapshotId}\``,
    `- Intake: \`${intakeId}\``,
    `- Concepts initialized: ${concepts.length}`,
    ...concepts
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(concept => `- [${concept.title}](${concept.path})`),
    '',
  ].join('\n');
}

function safeExtractor(extractor) {
  return {
    id: String(extractor?.id || 'unknown'),
    input_tokens: Number(extractor?.input_tokens ?? 0),
    output_tokens: Number(extractor?.output_tokens ?? 0),
  };
}

function stableRecordId(prefix, value) {
  return `${prefix}_${sha256(canonicalJson(value)).slice(0, 24)}`;
}

function mapEntityReference(item, conceptByKey) {
  const concept = conceptByKey.get(item.entity_key);
  return {
    ...structuredClone(item),
    entity_ref: `okf://entity/${concept.entity_id}`,
    entity_path: concept.path,
    entity_key: undefined,
  };
}

function desiredConceptPath(concept) {
  return `/${OKF_TYPE_DIRECTORIES[concept.type]}/${concept.slug}.md`;
}

function normalizeIdentityText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase();
}

function normalizedConceptNames(concept) {
  return new Set([
    concept.title,
    ...(concept.aliases ?? []),
  ].map(normalizeIdentityText).filter(Boolean));
}

function normalizedSourceRefs(concept) {
  return [...new Set((concept.source_refs ?? []).map(ref => (
    String(ref).replace(
      /\/snapshot_[a-f0-9]{24}\//g,
      '/snapshot_*/',
    )
  )))].sort();
}

function setsIntersect(left, right) {
  return [...left].some(value => right.has(value));
}

function longestSharedSubstringLength(left, right) {
  const leftPoints = [...left];
  const rightPoints = [...right];
  let previous = new Array(rightPoints.length + 1).fill(0);
  let longest = 0;
  for (const leftPoint of leftPoints) {
    const current = new Array(rightPoints.length + 1).fill(0);
    for (let index = 1; index <= rightPoints.length; index += 1) {
      if (leftPoint === rightPoints[index - 1]) {
        current[index] = previous[index - 1] + 1;
        longest = Math.max(longest, current[index]);
      }
    }
    previous = current;
  }
  return longest;
}

function hasStableNameAnchor(left, right) {
  for (const leftName of normalizedConceptNames(left)) {
    for (const rightName of normalizedConceptNames(right)) {
      const shorterLength = Math.min(
        [...leftName].length,
        [...rightName].length,
      );
      if (shorterLength < 4) continue;
      const requiredLength = Math.max(
        4,
        Math.min(8, Math.ceil(shorterLength * 0.45)),
      );
      if (
        longestSharedSubstringLength(leftName, rightName)
        >= requiredLength
      ) {
        return true;
      }
    }
  }
  return false;
}

function sameStringArray(left, right) {
  return (
    left.length === right.length
    && left.every((value, index) => value === right[index])
  );
}

function sourceRefsIntersect(left, right) {
  return setsIntersect(
    new Set(normalizedSourceRefs(left)),
    new Set(normalizedSourceRefs(right)),
  );
}

function entityIdFromRef(ref) {
  const prefix = 'okf://entity/';
  return typeof ref === 'string' && ref.startsWith(prefix)
    ? ref.slice(prefix.length)
    : null;
}

function matchExistingConcepts({
  extraction,
  existingBundle,
  previousRuntime,
  previousClaimHashesByEntity = new Map(),
  entityIdFactory,
}) {
  const managedByPath = new Map();
  for (const handle of previousRuntime?.retrieval_handles ?? []) {
    const existing = existingBundle.indexes.byPath.get(handle.path);
    const entityId = entityIdFromRef(handle.entity_ref);
    if (
      !existing
      || !entityId
      || entityId !== existing.frontmatter.entity_id
      || handle.type !== existing.frontmatter.type
      || managedByPath.has(handle.path)
    ) {
      throw new Error(
        'Active Runtime World does not match its managed OKF concepts.',
      );
    }
    managedByPath.set(handle.path, {
      entity_id: entityId,
      path: handle.path,
      slug: existing.frontmatter.slug,
      concept_key: handle.concept_key ?? null,
      title: existing.frontmatter.title,
      aliases: structuredClone(existing.frontmatter.aliases),
      type: existing.frontmatter.type,
      source_refs: structuredClone(existing.frontmatter.source_refs),
      claim_hashes: structuredClone(
        previousClaimHashesByEntity.get(entityId) ?? [],
      ),
    });
  }

  const unmatchedConcepts = new Set(extraction.concepts);
  const unmatchedExisting = new Set(managedByPath.values());
  const identityByKey = new Map();
  const matchModes = new Map();
  const bind = (concept, existing, matchMode) => {
    identityByKey.set(concept.concept_key, {
      entity_id: existing.entity_id,
      path: existing.path,
      slug: existing.slug,
      title: concept.title,
      type: concept.type,
      description: concept.description,
      tags: structuredClone(concept.tags),
      source_refs: structuredClone(concept.source_refs),
      concept_key: concept.concept_key,
      desired_path: desiredConceptPath(concept),
      match_mode: matchMode,
    });
    matchModes.set(concept.concept_key, matchMode);
    unmatchedConcepts.delete(concept);
    unmatchedExisting.delete(existing);
  };

  const bindMutuallyUnique = predicate => {
    const pairs = [];
    for (const concept of unmatchedConcepts) {
      const matches = [...unmatchedExisting].filter(existing => (
        existing.type === concept.type
        && predicate(concept, existing)
      ));
      if (matches.length !== 1) continue;
      const [existing] = matches;
      const reverseMatches = [...unmatchedConcepts].filter(candidate => (
        candidate.type === existing.type
        && predicate(candidate, existing)
      ));
      if (reverseMatches.length === 1) {
        pairs.push([concept, existing]);
      }
    }
    for (const [concept, existing] of pairs) {
      if (
        unmatchedConcepts.has(concept)
        && unmatchedExisting.has(existing)
      ) {
        bind(concept, existing, predicate.matchMode);
      }
    }
  };

  const sameExplicitKey = (concept, existing) => (
    existing.concept_key
    && existing.concept_key === concept.concept_key
  );
  sameExplicitKey.matchMode = 'explicit_key';
  bindMutuallyUnique(sameExplicitKey);

  const sameSourcedName = (concept, existing) => (
    sourceRefsIntersect(concept, existing)
    && setsIntersect(
      normalizedConceptNames(concept),
      normalizedConceptNames(existing),
    )
  );
  sameSourcedName.matchMode = 'sourced_name';
  bindMutuallyUnique(sameSourcedName);

  const sameEvidence = (concept, existing) => (
    hasStableNameAnchor(concept, existing)
    && sameStringArray(
      normalizedSourceRefs(concept),
      normalizedSourceRefs(existing),
    )
  );
  sameEvidence.matchMode = 'evidence';
  bindMutuallyUnique(sameEvidence);

  const reservedManagedPaths = new Set(managedByPath.keys());
  const identityConflicts = [];
  for (const [index, concept] of [...unmatchedConcepts].entries()) {
    const conceptPath = desiredConceptPath(concept);
    if (
      reservedManagedPaths.has(conceptPath)
      || existingBundle.indexes.byPath.has(conceptPath)
    ) {
      identityConflicts.push({
        code: 'existing_path_requires_identity_resolution',
        concept_key: concept.concept_key,
        desired_path: conceptPath,
      });
      continue;
    }
    const entityId = entityIdFactory(concept.type, index);
    assertNonEmptyString(entityId, `${concept.concept_key}.entity_id`);
    identityByKey.set(concept.concept_key, {
      entity_id: entityId,
      path: conceptPath,
      slug: concept.slug,
      title: concept.title,
      type: concept.type,
      description: concept.description,
      tags: structuredClone(concept.tags),
      source_refs: structuredClone(concept.source_refs),
      concept_key: concept.concept_key,
      desired_path: conceptPath,
      match_mode: 'new',
    });
    matchModes.set(concept.concept_key, 'new');
  }

  const unmanagedConcepts = existingBundle.concepts
    .filter(concept => !managedByPath.has(concept.path))
    .map(concept => ({
      entity_id: concept.frontmatter.entity_id,
      path: concept.path,
      title: concept.frontmatter.title,
      type: concept.frontmatter.type,
    }));
  const retired = [...unmatchedExisting];
  const preserved = [...identityByKey.values()].filter(identity => (
    matchModes.get(identity.concept_key) !== 'new'
  ));
  return {
    identityByKey,
    identityConflicts,
    unmanagedConcepts,
    retired,
    previousEntityIds: [...managedByPath.values()].map(
      concept => concept.entity_id,
    ),
    reconcileCounts: {
      preserved: preserved.length,
      added: extraction.concepts.length - preserved.length,
      retired: retired.length,
      ignoredPathSuggestions: preserved.filter(
        identity => identity.path !== identity.desired_path,
      ).length,
    },
  };
}

function baselineClaimHash(claim) {
  return sha256(canonicalJson({
    claim_kind: claim.claim_kind ?? 'fact',
    claim: claim.claim,
  }));
}

function previousClaimHashes({
  previousRuntime,
  previousExtraction,
}) {
  const hashesByEntity = new Map();
  for (const entry of previousRuntime?.static_baseline_manifest ?? []) {
    const entityId = entityIdFromRef(entry.entity_ref);
    if (entityId && Array.isArray(entry.claim_hashes)) {
      hashesByEntity.set(entityId, [...new Set(entry.claim_hashes)].sort());
    }
  }
  if (!previousExtraction?.concepts?.length) return hashesByEntity;

  const extractionByKey = new Map(previousExtraction.concepts.map(
    concept => [concept.concept_key, concept],
  ));
  const extractionByPath = new Map(previousExtraction.concepts.map(
    concept => [desiredConceptPath(concept), concept],
  ));
  for (const handle of previousRuntime?.retrieval_handles ?? []) {
    const entityId = entityIdFromRef(handle.entity_ref);
    if (!entityId || hashesByEntity.has(entityId)) continue;
    const concept = extractionByKey.get(handle.concept_key)
      ?? extractionByPath.get(handle.path);
    if (!concept) continue;
    hashesByEntity.set(
      entityId,
      [...new Set(concept.baseline_claims.map(baselineClaimHash))].sort(),
    );
  }
  return hashesByEntity;
}

function claimDifferenceReport({
  extraction,
  matching,
  previousClaimHashesByEntity,
}) {
  if (previousClaimHashesByEntity.size === 0) {
    return {
      status: 'unavailable',
      added: null,
      removed: null,
      unchanged: null,
    };
  }
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const concept of extraction.concepts) {
    const identity = matching.identityByKey.get(concept.concept_key);
    if (!identity) continue;
    const nextHashes = new Set(concept.baseline_claims.map(baselineClaimHash));
    const previousHashes = new Set(
      identity.match_mode === 'new'
        ? []
        : previousClaimHashesByEntity.get(identity.entity_id) ?? [],
    );
    for (const hash of nextHashes) {
      if (previousHashes.has(hash)) unchanged += 1;
      else added += 1;
    }
    for (const hash of previousHashes) {
      if (!nextHashes.has(hash)) removed += 1;
    }
  }
  for (const retired of matching.retired) {
    removed += previousClaimHashesByEntity.get(retired.entity_id)?.length ?? 0;
  }
  return {
    status: 'available',
    added,
    removed,
    unchanged,
  };
}

function buildReconcileReport({
  activeSnapshot,
  matching,
  claimDiff,
  dynamicConflicts = [],
}) {
  return {
    schema: 'mnemosyne.static-lore-reconcile-report.v1',
    previous_snapshot_id: activeSnapshot.snapshot_id,
    preserved_entity_count: matching.reconcileCounts.preserved,
    added_entity_count: matching.reconcileCounts.added,
    retired_entity_count: matching.reconcileCounts.retired,
    ignored_path_suggestion_count:
      matching.reconcileCounts.ignoredPathSuggestions,
    identity_conflict_count: matching.identityConflicts.length,
    dynamic_conflict_count: dynamicConflicts.length,
    claim_diff: claimDiff,
    requires_confirmation: (
      matching.identityConflicts.length === 0
      && dynamicConflicts.length === 0
    ),
  };
}

function serializeReconcilePlan({
  chatId,
  snapshot,
  extractionHash,
  activeSnapshot,
  matching,
  report,
  dynamicConflicts,
  timestamp,
}) {
  const content = {
    schema: 'mnemosyne.static-lore-reconcile-plan.v1',
    status: report.requires_confirmation
      ? 'approval_required'
      : 'blocked',
    chat_id: chatId,
    snapshot_id: snapshot.snapshot_id,
    snapshot_hash: snapshot.snapshot_hash,
    extraction_hash: extractionHash,
    previous_snapshot_id: activeSnapshot.snapshot_id,
    previous_snapshot_hash: activeSnapshot.snapshot_hash,
    identities: [...matching.identityByKey].map(([conceptKey, identity]) => ({
      concept_key: conceptKey,
      entity_id: identity.entity_id,
      path: identity.path,
      slug: identity.slug,
      desired_path: identity.desired_path,
      match_mode: identity.match_mode,
    })),
    retired: matching.retired.map(concept => ({
      entity_id: concept.entity_id,
      path: concept.path,
    })),
    previous_entity_ids: structuredClone(matching.previousEntityIds),
    unmanaged_concepts: structuredClone(matching.unmanagedConcepts),
    identity_conflicts: structuredClone(matching.identityConflicts),
    dynamic_conflicts: structuredClone(dynamicConflicts),
    report: structuredClone(report),
  };
  return {
    ...content,
    plan_id: `reconcile_${sha256(canonicalJson(content)).slice(0, 32)}`,
    created_at: timestamp,
    applied_at: null,
  };
}

function matchingFromApprovedPlan({
  plan,
  extraction,
  snapshot,
  extractionHash,
  activeSnapshot,
}) {
  if (
    plan?.schema !== 'mnemosyne.static-lore-reconcile-plan.v1'
    || plan.status !== 'approval_required'
    || plan.chat_id !== snapshot.chat_id
    || plan.snapshot_id !== snapshot.snapshot_id
    || plan.snapshot_hash !== snapshot.snapshot_hash
    || plan.extraction_hash !== extractionHash
    || plan.previous_snapshot_id !== activeSnapshot?.snapshot_id
    || plan.previous_snapshot_hash !== activeSnapshot?.snapshot_hash
  ) {
    throw new Error(
      'Static Lore reconcile approval does not match the pending plan.',
    );
  }
  const conceptsByKey = new Map(extraction.concepts.map(
    concept => [concept.concept_key, concept],
  ));
  const identityByKey = new Map();
  for (const identity of plan.identities ?? []) {
    const concept = conceptsByKey.get(identity.concept_key);
    if (!concept || identityByKey.has(identity.concept_key)) {
      throw new Error('Static Lore reconcile plan contains an invalid identity.');
    }
    identityByKey.set(identity.concept_key, {
      ...structuredClone(identity),
      title: concept.title,
      type: concept.type,
      description: concept.description,
      tags: structuredClone(concept.tags),
      source_refs: structuredClone(concept.source_refs),
    });
  }
  if (identityByKey.size !== extraction.concepts.length) {
    throw new Error('Static Lore reconcile plan is missing concept identities.');
  }
  return {
    identityByKey,
    identityConflicts: [],
    unmanagedConcepts: structuredClone(plan.unmanaged_concepts ?? []),
    retired: structuredClone(plan.retired ?? []),
    previousEntityIds: structuredClone(plan.previous_entity_ids ?? []),
    reconcileCounts: {
      preserved: plan.report.preserved_entity_count,
      added: plan.report.added_entity_count,
      retired: plan.report.retired_entity_count,
      ignoredPathSuggestions: plan.report.ignored_path_suggestion_count,
    },
  };
}

async function inspectReconcileSafety({
  store,
  chatId,
  opened,
  existingBundle,
  previousRuntime,
}) {
  const inspection = await store.inspectStaticLoreStateForAdmin({ chatId });
  const conflicts = [];
  for (const indicator of inspection.dynamic_state?.indicators ?? []) {
    conflicts.push({
      code: 'dynamic_state_present',
      indicator,
    });
  }
  if (
    inspection.dynamic_state?.has_dynamic_state
    && conflicts.length === 0
  ) {
    conflicts.push({ code: 'dynamic_state_present' });
  }

  const baselineConcepts = inspection.baseline_concepts ?? [];
  const runtimeHandles = previousRuntime.retrieval_handles ?? [];
  if (baselineConcepts.length !== runtimeHandles.length) {
    conflicts.push({ code: 'baseline_ledger_handle_count_mismatch' });
  }
  for (const baseline of baselineConcepts) {
    const concept = existingBundle.indexes.byEntityId.get(baseline.entity_id);
    if (
      !concept
      || concept.relativePath !== baseline.relative_path
    ) {
      conflicts.push({
        code: 'baseline_concept_identity_mismatch',
        entity_id: baseline.entity_id,
      });
      continue;
    }
    const source = await readFile(path.join(
      opened.chat_save_path,
      'story-memory',
      baseline.relative_path,
    ));
    if (sha256(source) !== baseline.version_hash) {
      conflicts.push({
        code: 'managed_concept_changed_after_intake',
        entity_id: baseline.entity_id,
      });
    }
  }

  const runtimeProjectionHash = sha256(canonicalJson(previousRuntime));
  if (
    !(inspection.ready_runtime_projection_hashes ?? [])
      .includes(runtimeProjectionHash)
  ) {
    conflicts.push({ code: 'runtime_projection_changed_after_intake' });
  }

  const registry = parse(await readFile(
    path.join(
      opened.chat_save_path,
      'story-memory',
      'attribute-registry.yaml',
    ),
    'utf8',
  ));
  const actualRegistry = new Map([
    ...(registry?.attributes ?? []).map(definition => [
      definition.attribute_id,
      sha256(canonicalJson(definition)),
    ]),
    ...(registry?.progression_tracks ?? []).map(track => [
      `track:${track.track_id}`,
      sha256(canonicalJson(track)),
    ]),
  ]);
  const expectedRegistry = new Map(
    (inspection.active_static_registry_definitions ?? []).map(
      definition => [definition.attribute_id, definition.definition_hash],
    ),
  );
  if (
    actualRegistry.size !== expectedRegistry.size
    || [...expectedRegistry].some(
      ([attributeId, hash]) => actualRegistry.get(attributeId) !== hash,
    )
  ) {
    conflicts.push({ code: 'attribute_registry_changed_after_intake' });
  }
  return {
    inspection,
    conflicts,
  };
}

export function createStaticLoreIntake({
  store,
  now = () => new Date(),
  entityIdFactory = defaultEntityId,
} = {}) {
  if (
    !store?.readStaticLoreSnapshotForAdmin
    || !store?.openChatForAdmin
    || !store?.getActiveStaticLoreSnapshotForAdmin
    || !store?.readIntakeSessionForAdmin
    || !store?.inspectStaticLoreStateForAdmin
    || !store?.writeStaticLoreReconcilePlanForAdmin
    || !store?.readStaticLoreReconcilePlanForAdmin
    || !store?.prepareStaticLoreIntakeForAdmin
    || !store?.commitStaticLoreIntake
  ) {
    throw new Error('Static Lore Intake requires a trusted chat-save store.');
  }

  return Object.freeze({
    async applyExtraction({
      chatId,
      snapshotId,
      extraction,
      extractor,
      allowedSourceRefs,
      reconcileApproval = null,
    }) {
      const snapshot = await store.readStaticLoreSnapshotForAdmin({
        chatId,
        snapshotId,
      });
      assertExtraction(extraction, snapshot);
      const snapshotRefs = sourceUnitRefs(snapshot);
      assertSourceRefs(
        extraction,
        snapshotRefs,
        allowedSourceRefs
          ? new Set(allowedSourceRefs)
          : snapshotRefs,
      );
      const opened = await store.openChatForAdmin({ chatId });
      await recoverStagedFileTransaction({
        chatSavePath: opened.chat_save_path,
        getActiveSnapshotId: async () => (
          await store.getActiveStaticLoreSnapshotForAdmin({ chatId })
        )?.snapshot_id ?? null,
        validateFiles: async () => validateOkfBundle({
          chatSavePath: opened.chat_save_path,
        }),
      });
      const storyMemoryPath = path.join(opened.chat_save_path, 'story-memory');
      const timestamp = now().toISOString();
      const conceptByKey = new Map();
      const extractionHash = sha256(canonicalJson(extraction));
      const activeSnapshot = await store.getActiveStaticLoreSnapshotForAdmin({
        chatId,
      });
      const runtimePath = path.join(
        opened.chat_save_path,
        'derived',
        'runtime-world.json',
      );
      let previousRuntime = null;
      try {
        previousRuntime = JSON.parse(await readFile(runtimePath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (activeSnapshot?.snapshot_id === snapshot.snapshot_id) {
        const runtimeWorld = previousRuntime;
        const runtimeProjectionHash = sha256(canonicalJson(runtimeWorld));
        const existingBundle = await validateOkfBundle({
          chatSavePath: opened.chat_save_path,
        });
        const inspection = await store.inspectStaticLoreStateForAdmin({ chatId });
        if (
          runtimeWorld?.schema !== 'mnemosyne.runtime-world.v1'
          || runtimeWorld.status !== 'ready'
          || runtimeWorld.snapshot_id !== activeSnapshot.snapshot_id
          || runtimeWorld.snapshot_hash !== activeSnapshot.snapshot_hash
          || runtimeWorld.extraction_hash !== extractionHash
          || !(inspection.ready_runtime_projection_hashes ?? [])
            .includes(runtimeProjectionHash)
        ) {
          throw new Error(
            'Completed Static Lore Intake does not match its Runtime World projection.',
          );
        }
        for (const handle of runtimeWorld.retrieval_handles ?? []) {
          const concept = existingBundle.indexes.byPath.get(handle.path);
          if (
            !concept
            || concept.frontmatter.entity_id !== entityIdFromRef(handle.entity_ref)
          ) {
            throw new Error(
              'Completed Static Lore Intake has a mismatched retrieval handle.',
            );
          }
        }
        return {
          schema: 'mnemosyne.static-lore-intake-result.v1',
          status: 'ready',
          snapshot_id: snapshot.snapshot_id,
          concept_count: extraction.concepts.length,
          runtime_projection_hash: runtimeProjectionHash,
          mode: runtimeWorld.mode ?? 'initial',
          ...(runtimeWorld.reconcile_report
            ? { reconcile_report: runtimeWorld.reconcile_report }
            : {}),
        };
      }

      const mode = activeSnapshot ? 'reconcile' : 'initial';
      if (activeSnapshot) {
        if (
          previousRuntime?.schema !== 'mnemosyne.runtime-world.v1'
          || previousRuntime.status !== 'ready'
          || previousRuntime.snapshot_id !== activeSnapshot.snapshot_id
          || previousRuntime.snapshot_hash !== activeSnapshot.snapshot_hash
        ) {
          throw new Error(
            'Active Static Lore Snapshot does not match its Runtime World.',
          );
        }
      } else if (previousRuntime) {
        throw new Error(
          'A Runtime World exists without an active Static Lore Snapshot.',
        );
      }

      const existingBundle = await validateOkfBundle({
        chatSavePath: opened.chat_save_path,
      });
      const previousSession = activeSnapshot
        ? await store.readIntakeSessionForAdmin({
            chatId,
            snapshotId: activeSnapshot.snapshot_id,
          })
        : null;
      const previousClaimHashesByEntity = previousClaimHashes({
        previousRuntime,
        previousExtraction: previousSession?.aggregate ?? null,
      });
      let matching = null;
      let reconcileReport = null;
      let reconcilePlan = null;
      let intakeId = `intake_${extractionHash.slice(0, 24)}`;
      if (mode === 'reconcile') {
        const safety = await inspectReconcileSafety({
          store,
          chatId,
          opened,
          existingBundle,
          previousRuntime,
        });
        if (!reconcileApproval) {
          matching = matchExistingConcepts({
            extraction,
            existingBundle,
            previousRuntime,
            previousClaimHashesByEntity,
            entityIdFactory,
          });
          const claimDiff = claimDifferenceReport({
            extraction,
            matching,
            previousClaimHashesByEntity,
          });
          reconcileReport = buildReconcileReport({
            activeSnapshot,
            matching,
            claimDiff,
            dynamicConflicts: safety.conflicts,
          });
          reconcilePlan = serializeReconcilePlan({
            chatId,
            snapshot,
            extractionHash,
            activeSnapshot,
            matching,
            report: reconcileReport,
            dynamicConflicts: safety.conflicts,
            timestamp,
          });
          await store.writeStaticLoreReconcilePlanForAdmin({
            chatId,
            snapshotId: snapshot.snapshot_id,
            plan: reconcilePlan,
          });
          return {
            schema: 'mnemosyne.static-lore-intake-result.v1',
            status: reconcilePlan.status === 'approval_required'
              ? 'approval_required'
              : 'reconcile_blocked',
            snapshot_id: snapshot.snapshot_id,
            concept_count: extraction.concepts.length,
            mode,
            reconcile_plan_id: reconcilePlan.plan_id,
            reconcile_report: reconcileReport,
            reconcile_conflicts: {
              identity: structuredClone(matching.identityConflicts),
              dynamic: structuredClone(safety.conflicts),
            },
            ...(reconcilePlan.status === 'blocked'
              ? {
                  reason_code: safety.conflicts.length > 0
                    ? 'static_lore_reconcile_dynamic_conflict'
                    : 'static_lore_reconcile_identity_conflict',
                }
              : {}),
          };
        }
        reconcilePlan = await store.readStaticLoreReconcilePlanForAdmin({
          chatId,
          snapshotId: snapshot.snapshot_id,
        });
        if (
          !reconcilePlan
          || reconcileApproval.plan_id !== reconcilePlan.plan_id
        ) {
          throw new Error(
            'Static Lore reconcile approval is stale or no longer safe.',
          );
        }
        if (safety.conflicts.length > 0) {
          const blockedReport = {
            ...structuredClone(reconcilePlan.report),
            dynamic_conflict_count: safety.conflicts.length,
            requires_confirmation: false,
          };
          const blockedPlan = {
            ...reconcilePlan,
            status: 'blocked',
            dynamic_conflicts: structuredClone(safety.conflicts),
            report: blockedReport,
          };
          await store.writeStaticLoreReconcilePlanForAdmin({
            chatId,
            snapshotId: snapshot.snapshot_id,
            plan: blockedPlan,
          });
          return {
            schema: 'mnemosyne.static-lore-intake-result.v1',
            status: 'reconcile_blocked',
            snapshot_id: snapshot.snapshot_id,
            concept_count: extraction.concepts.length,
            mode,
            reconcile_plan_id: blockedPlan.plan_id,
            reconcile_report: blockedReport,
            reconcile_conflicts: {
              identity: structuredClone(
                blockedPlan.identity_conflicts ?? [],
              ),
              dynamic: structuredClone(safety.conflicts),
            },
            reason_code: 'static_lore_reconcile_dynamic_conflict',
          };
        }
        matching = matchingFromApprovedPlan({
          plan: reconcilePlan,
          extraction,
          snapshot,
          extractionHash,
          activeSnapshot,
        });
        reconcileReport = structuredClone(reconcilePlan.report);
        intakeId = `intake_${sha256(reconcilePlan.plan_id).slice(0, 24)}`;
      } else {
        matching = matchExistingConcepts({
          extraction,
          existingBundle,
          previousRuntime,
          previousClaimHashesByEntity,
          entityIdFactory,
        });
        if (matching.identityConflicts.length > 0) {
          throw new Error(
            'Initial Static Lore Intake has a concept path collision.',
          );
        }
      }

      for (const [conceptKey, identity] of matching.identityByKey) {
        conceptByKey.set(conceptKey, identity);
      }
      const writes = new Map();
      const removals = new Set(matching.retired.map(concept => path.join(
        'story-memory',
        concept.path.slice(1),
      )));
      try {
        const conceptRecords = [];
        for (const concept of extraction.concepts) {
          const identity = conceptByKey.get(concept.concept_key);
          const links = concept.links.map(link => ({
            target: conceptByKey.get(link.target_key).path,
            relation: link.relation,
          }));
          const frontmatter = {
            type: concept.type,
            title: concept.title,
            description: concept.description,
            tags: structuredClone(concept.tags),
            timestamp,
            entity_id: identity.entity_id,
            slug: identity.slug,
            aliases: structuredClone(concept.aliases),
            status: 'active',
            source_refs: structuredClone(concept.source_refs),
            links,
            facets: structuredClone(concept.facets ?? {}),
          };
          if (links.length === 0) {
            frontmatter.no_links_reason = 'No relationship was present in the captured baseline.';
          }
          const document = serializeOkfConcept({
            frontmatter,
            body: conceptBody(concept, conceptByKey),
          });
          writes.set(
            path.join('story-memory', identity.path.slice(1)),
            document,
          );
          conceptRecords.push({
            concept_key: concept.concept_key,
            entity_id: identity.entity_id,
            version_hash: sha256(document),
            relative_path: identity.path.slice(1),
            claims: concept.baseline_claims.map((claim, claimIndex) => ({
              claim_id: stableRecordId('claim', {
                intake_id: intakeId,
                entity_id: identity.entity_id,
                claim_index: claimIndex,
                claim_kind: claim.claim_kind ?? 'fact',
                claim: claim.claim,
              }),
              section_ref:
                `Imported Baseline Claims/${claim.claim_kind ?? 'fact'}`,
              claim_hash: sha256(canonicalJson({
                claim_kind: claim.claim_kind ?? 'fact',
                claim: claim.claim,
              })),
              source_refs: structuredClone(claim.source_refs),
            })),
            links: concept.links.map((link, linkIndex) => ({
              link_change_id: stableRecordId('link', {
                intake_id: intakeId,
                entity_id: identity.entity_id,
                link_index: linkIndex,
                target_entity_id: conceptByKey.get(link.target_key).entity_id,
                relation: link.relation,
              }),
              target_entity_id: conceptByKey.get(link.target_key).entity_id,
              relation_id: link.relation,
              source_ref: concept.source_refs[0],
            })),
          });
        }

        const attributeRegistryPath = path.join(
          storyMemoryPath,
          'attribute-registry.yaml',
        );
        const attributeRegistryDocument = stringify({
          schema: 'mnemosyne.attribute-registry.v1',
          attributes: structuredClone(extraction.attribute_definitions ?? []),
          progression_tracks: structuredClone(extraction.progression_tracks ?? []),
        });
        writes.set(path.relative(
          opened.chat_save_path,
          attributeRegistryPath,
        ), attributeRegistryDocument);

        const concepts = [...conceptByKey.values()];
        const indexPath = path.join(storyMemoryPath, 'index.md');
        writes.set(path.relative(
          opened.chat_save_path,
          indexPath,
        ), storyMemoryIndex([
          ...concepts,
          ...matching.unmanagedConcepts,
        ]));

        const logPath = path.join(storyMemoryPath, 'log.md');
        const previousLog = await readFile(logPath, 'utf8');
        writes.set(path.relative(
          opened.chat_save_path,
          logPath,
        ), intakeLogEntry({
          previous: previousLog,
          timestamp,
          snapshotId: snapshot.snapshot_id,
          intakeId,
          concepts,
          mode,
        }));

        const retrievalHandles = [...conceptByKey.values()].map(concept => ({
          entity_ref: `okf://entity/${concept.entity_id}`,
          path: concept.path,
          title: concept.title,
          type: concept.type,
          description: concept.description,
          tags: concept.tags,
          source_refs: concept.source_refs,
          concept_key: concept.concept_key,
        }));
        const runtimeWorld = {
          schema: 'mnemosyne.runtime-world.v1',
          status: 'ready',
          mode,
          snapshot_id: snapshot.snapshot_id,
          snapshot_hash: snapshot.snapshot_hash,
          previous_snapshot_id: activeSnapshot?.snapshot_id ?? null,
          extraction_hash: extractionHash,
          extractor: safeExtractor(extractor),
          current_state: (extraction.current_state ?? []).map(
            item => mapEntityReference(item, conceptByKey),
          ),
          topology: (extraction.topology ?? []).map(item => ({
            ...mapEntityReference(item, conceptByKey),
            parent_ref: `okf://entity/${conceptByKey.get(item.parent_key).entity_id}`,
            parent_path: conceptByKey.get(item.parent_key).path,
            parent_key: undefined,
          })),
          active_scene: extraction.active_scene ?? null,
          retrieval_handles: retrievalHandles,
          static_baseline_manifest: conceptRecords.map(record => ({
            concept_key: record.concept_key,
            entity_ref: `okf://entity/${record.entity_id}`,
            path: `/${record.relative_path}`,
            version_hash: record.version_hash,
            claim_hashes: record.claims.map(claim => claim.claim_hash).sort(),
          })),
          attribute_registry_hash: sha256(attributeRegistryDocument),
          ...(reconcileReport
            ? { reconcile_report: reconcileReport }
            : {}),
        };
        writes.set(
          path.relative(opened.chat_save_path, runtimePath),
          `${JSON.stringify(runtimeWorld, null, 2)}\n`,
        );
        if (reconcilePlan) {
          writes.set(
            path.join(
              'derived',
              'reconcile-plans',
              `${snapshot.snapshot_id}.json`,
            ),
            `${JSON.stringify({
              ...reconcilePlan,
              status: 'applied',
              applied_at: timestamp,
            }, null, 2)}\n`,
          );
        }

        const runtimeProjectionHash = sha256(canonicalJson(runtimeWorld));
        const normalizedExtractor = safeExtractor(extractor);
        const registryDefinitions = [
          ...(extraction.attribute_definitions ?? []).map(definition => ({
            attribute_id: definition.attribute_id,
            definition_hash: sha256(canonicalJson(definition)),
          })),
          ...(extraction.progression_tracks ?? []).map(track => ({
            attribute_id: `track:${track.track_id}`,
            definition_hash: sha256(canonicalJson(track)),
          })),
        ];
        await runStagedFileTransaction({
          chatSavePath: opened.chat_save_path,
          transactionId: intakeId,
          targetSnapshotId: snapshot.snapshot_id,
          previousSnapshotId: activeSnapshot?.snapshot_id ?? null,
          writes,
          removals,
          getActiveSnapshotId: async () => (
            await store.getActiveStaticLoreSnapshotForAdmin({ chatId })
          )?.snapshot_id ?? null,
          validateFiles: async () => validateOkfBundle({
            chatSavePath: opened.chat_save_path,
          }),
          prepareLedger: async () => (
            store.prepareStaticLoreIntakeForAdmin({
              chatId,
              snapshotId: snapshot.snapshot_id,
              intakeId,
              extractor: normalizedExtractor,
              previousSnapshotId: activeSnapshot?.snapshot_id ?? null,
              timestamp,
            })
          ),
          commitLedger: async () => store.commitStaticLoreIntake({
            chatId,
            snapshotId: snapshot.snapshot_id,
            intakeId,
            extractor: normalizedExtractor,
            concepts: conceptRecords,
            registryDefinitions,
            projection: {
              projection_id: `projection_${runtimeProjectionHash.slice(0, 24)}`,
              projection_kind: 'runtime_world',
              source_version_hash: runtimeProjectionHash,
            },
            previousSnapshotId: activeSnapshot?.snapshot_id ?? null,
            supersededEntityIds: matching.previousEntityIds,
            timestamp,
          }),
        });
        return {
          schema: 'mnemosyne.static-lore-intake-result.v1',
          status: 'ready',
          snapshot_id: snapshot.snapshot_id,
          concept_count: extraction.concepts.length,
          runtime_projection_hash: runtimeProjectionHash,
          mode,
          ...(reconcileReport
            ? { reconcile_report: reconcileReport }
            : {}),
        };
      } catch (error) {
        throw error;
      }
    },

    async readRuntimeWorld({ chatId }) {
      const opened = await store.openChatForAdmin({ chatId });
      return JSON.parse(await readFile(
        path.join(opened.chat_save_path, 'derived', 'runtime-world.json'),
        'utf8',
      ));
    },
  });
}
