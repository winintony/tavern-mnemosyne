import { canonicalJson } from '../contracts/hash.js';

const EXTRACTION_SCHEMA = 'mnemosyne.static-lore-extraction.v1';

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function unitPriority(unit) {
  if (unit.source_kind === 'character_card') return 0;
  if (unit.source_kind === 'persona') return 1;
  if (unit.source_kind === 'scenario') return 2;
  if (unit.source_kind === 'worldbook' && unit.data?.constant) return 3;
  return 4;
}

function batchPacket(packet, units, index, count) {
  return {
    schema: 'mnemosyne.static-lore-source-batch.v1',
    snapshot_id: packet.snapshot_id,
    snapshot_hash: packet.snapshot_hash,
    batch_id: `batch-${index + 1}`,
    batch_index: index,
    batch_count: count,
    units: units.map((unit, sourceIndex) => ({
      source_index: sourceIndex,
      ...structuredClone(unit),
    })),
  };
}

export function partitionStaticLorePacket(packet, {
  maxBatchBytes = 12_000,
  maxBatchUnits = 6,
} = {}) {
  if (!Number.isInteger(maxBatchBytes) || maxBatchBytes <= 0) {
    throw new Error('maxBatchBytes must be a positive integer.');
  }
  if (!Number.isInteger(maxBatchUnits) || maxBatchUnits <= 0) {
    throw new Error('maxBatchUnits must be a positive integer.');
  }
  const ordered = [...(packet?.units ?? [])].sort((left, right) => (
    unitPriority(left) - unitPriority(right)
  ));
  if (ordered.length === 0) {
    throw new Error('Static Lore batching requires at least one source unit.');
  }

  const groups = [];
  let current = [];
  for (const unit of ordered) {
    const candidate = [...current, unit];
    const candidateBytes = utf8Bytes(batchPacket(packet, candidate, 0, 1));
    if (
      current.length > 0
      && (
        current.length >= maxBatchUnits
        || candidateBytes > maxBatchBytes
      )
    ) {
      groups.push(current);
      current = [unit];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((units, index) => {
    const value = batchPacket(packet, units, index, groups.length);
    return {
      ...value,
      packet_bytes: utf8Bytes(value),
      oversized_single_unit:
        units.length === 1 && utf8Bytes(value) > maxBatchBytes,
    };
  });
}

export function createStaticLoreAggregate(snapshotHash) {
  return {
    schema: EXTRACTION_SCHEMA,
    snapshot_hash: snapshotHash,
    concepts: [],
    attribute_definitions: [],
    progression_tracks: [],
    current_state: [],
    topology: [],
    active_scene: null,
  };
}

function collectSourceRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'source_refs') {
      if (!Array.isArray(item)) {
        throw new Error('source_refs must be an array.');
      }
      refs.push(...item);
    } else {
      collectSourceRefs(item, refs);
    }
  }
  return refs;
}

function uniqueStrings(...values) {
  return [...new Set(values.flat().map(String))];
}

function uniqueObjects(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = canonicalJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isLocationConcept(concept) {
  return (
    concept?.type === 'world_lore'
    && Array.isArray(concept.tags)
    && concept.tags.includes('location')
  );
}

function normalizeConceptLinks(concept, concepts, warnings) {
  const links = [];
  for (const link of concept.links ?? []) {
    if (
      link?.relation === 'located_at'
      && !isLocationConcept(concepts.get(link.target_key))
    ) {
      warnings.push({
        code: 'located_at_link_quarantined',
        concept_key: concept.concept_key,
        target_key: link.target_key,
        reason: 'target_is_not_a_location',
      });
      continue;
    }
    links.push(structuredClone(link));
  }
  return {
    ...structuredClone(concept),
    links: uniqueObjects(links),
  };
}

function mergeFacets(current, incoming, warnings, conceptKey) {
  const merged = structuredClone(current ?? {});
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (!(key in merged)) {
      merged[key] = structuredClone(value);
      continue;
    }
    if (canonicalJson(merged[key]) !== canonicalJson(value)) {
      warnings.push({
        code: 'facet_value_disagreed_across_batches',
        concept_key: conceptKey,
        facet: key,
      });
    }
  }
  return merged;
}

function mergeConcept(existing, incoming, warnings) {
  for (const field of ['concept_key', 'type', 'slug']) {
    if (existing[field] !== incoming[field]) {
      throw new Error(
        `Static Lore batch changed ${field} for ${existing.concept_key}.`,
      );
    }
  }
  if (incoming.merge_mode === 'claims_only') {
    return {
      ...structuredClone(existing),
      source_refs: uniqueStrings(
        existing.source_refs ?? [],
        incoming.source_refs ?? [],
      ),
      evidence: uniqueObjects([
        ...(existing.evidence ?? []),
        ...(incoming.evidence ?? []),
      ]),
      baseline_claims: uniqueObjects([
        ...(existing.baseline_claims ?? []),
        ...(incoming.baseline_claims ?? []),
      ]),
    };
  }
  if (existing.title !== incoming.title) {
    warnings.push({
      code: 'concept_title_variant_retained_as_alias',
      concept_key: existing.concept_key,
    });
  }
  return {
    ...structuredClone(existing),
    aliases: uniqueStrings(
      existing.aliases ?? [],
      incoming.aliases ?? [],
      existing.title === incoming.title ? [] : [incoming.title],
    ),
    tags: uniqueStrings(existing.tags ?? [], incoming.tags ?? []),
    source_refs: uniqueStrings(
      existing.source_refs ?? [],
      incoming.source_refs ?? [],
    ),
    evidence: uniqueObjects([
      ...(existing.evidence ?? []),
      ...(incoming.evidence ?? []),
    ]),
    links: uniqueObjects([
      ...(existing.links ?? []),
      ...(incoming.links ?? []),
    ]),
    facets: mergeFacets(
      existing.facets,
      incoming.facets,
      warnings,
      existing.concept_key,
    ),
    baseline_claims: uniqueObjects([
      ...(existing.baseline_claims ?? []),
      ...(incoming.baseline_claims ?? []),
    ]),
  };
}

function mergeRegistryItems(current, incoming, identityField, warnings) {
  const byId = new Map(current.map(item => [item[identityField], item]));
  for (const item of incoming) {
    const id = item?.[identityField];
    if (!byId.has(id)) {
      byId.set(id, structuredClone(item));
      continue;
    }
    const existing = byId.get(id);
    const currentWithoutSources = {
      ...structuredClone(existing),
      source_refs: undefined,
    };
    const incomingWithoutSources = {
      ...structuredClone(item),
      source_refs: undefined,
    };
    if (
      canonicalJson(currentWithoutSources)
      !== canonicalJson(incomingWithoutSources)
    ) {
      warnings.push({
        code: 'registry_definition_disagreed_across_batches',
        registry_id: id,
      });
    }
    existing.source_refs = uniqueStrings(
      existing.source_refs ?? [],
      item.source_refs ?? [],
    );
  }
  return [...byId.values()];
}

function currentStateIdentity(item) {
  const fields = ['entity_key', 'state_domain', 'state_key'];
  for (const field of fields) {
    if (typeof item?.[field] !== 'string' || !item[field]) {
      throw new Error(`Static Lore current_state.${field} is required.`);
    }
  }
  return canonicalJson(fields.map(field => item[field]));
}

function mergeCurrentState(current, incoming, warnings) {
  const byIdentity = new Map();
  for (const item of current) {
    byIdentity.set(currentStateIdentity(item), structuredClone(item));
  }
  for (const item of incoming) {
    const identity = currentStateIdentity(item);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, structuredClone(item));
      continue;
    }
    if (
      canonicalJson(existing.current_value)
      !== canonicalJson(item.current_value)
    ) {
      throw new Error(
        'Static Lore batches produced conflicting current values for '
        + `${item.entity_key}/${item.state_domain}/${item.state_key}.`,
      );
    }
    if (existing.certainty !== item.certainty) {
      warnings.push({
        code: 'current_state_certainty_disagreed_across_batches',
        entity_key: item.entity_key,
        state_domain: item.state_domain,
        state_key: item.state_key,
      });
    }
    existing.source_refs = uniqueStrings(
      existing.source_refs ?? [],
      item.source_refs ?? [],
    );
    existing.salience = Math.max(
      Number(existing.salience) || 0,
      Number(item.salience) || 0,
    );
  }
  return [...byIdentity.values()];
}

function mergeTopology(current, incoming, concepts, warnings) {
  const accepted = [];
  for (const edge of [...current, ...incoming]) {
    let reason = null;
    if (edge?.relation !== 'located_at') {
      reason = 'relation_is_not_spatial';
    } else if (edge.status !== 'baseline') {
      reason = 'status_is_not_baseline';
    } else if (!isLocationConcept(concepts.get(edge.parent_key))) {
      reason = 'parent_is_not_a_location';
    } else if (edge.entity_key === edge.parent_key) {
      reason = 'self_parent';
    }
    if (reason) {
      warnings.push({
        code: 'topology_edge_quarantined',
        entity_key: edge?.entity_key ?? null,
        parent_key: edge?.parent_key ?? null,
        reason,
      });
      continue;
    }
    accepted.push(structuredClone(edge));
  }
  return uniqueObjects(accepted);
}

export function mergeStaticLoreBatch({
  aggregate,
  extraction,
  allowedSourceRefs,
} = {}) {
  if (extraction?.schema !== EXTRACTION_SCHEMA) {
    throw new Error(`Unsupported Static Lore batch schema: ${extraction?.schema}`);
  }
  if (extraction.snapshot_hash !== aggregate.snapshot_hash) {
    throw new Error('Static Lore batch does not match its captured snapshot.');
  }
  for (const field of [
    'concepts',
    'attribute_definitions',
    'progression_tracks',
    'current_state',
    'topology',
  ]) {
    if (!Array.isArray(extraction[field])) {
      throw new Error(`Static Lore batch ${field} must be an array.`);
    }
  }

  const allowed = new Set(allowedSourceRefs ?? []);
  for (const ref of collectSourceRefs(extraction)) {
    if (typeof ref !== 'string' || !allowed.has(ref)) {
      throw new Error(`Static Lore batch used an unrecognized source ref: ${ref}`);
    }
  }

  const warnings = [];
  const concepts = new Map(
    aggregate.concepts.map(concept => [concept.concept_key, concept]),
  );
  const incomingKeys = new Set(
    extraction.concepts.map(concept => concept?.concept_key),
  );
  const knownKeys = new Set([...concepts.keys(), ...incomingKeys]);
  const conceptDefinitions = new Map(concepts);
  for (const incoming of extraction.concepts) {
    const existing = conceptDefinitions.get(incoming?.concept_key);
    if (incoming?.merge_mode === 'claims_only') {
      if (!existing) {
        throw new Error(
          'Static Lore claims-only merge requires an existing concept.',
        );
      }
      continue;
    }
    conceptDefinitions.set(incoming?.concept_key, {
      ...structuredClone(existing ?? {}),
      ...structuredClone(incoming),
      tags: uniqueStrings(existing?.tags ?? [], incoming?.tags ?? []),
    });
  }
  for (const concept of extraction.concepts) {
    if (typeof concept?.concept_key !== 'string' || !concept.concept_key) {
      throw new Error('Static Lore batch concept_key is required.');
    }
    for (const link of concept.links ?? []) {
      if (!knownKeys.has(link.target_key)) {
        throw new Error(
          `Static Lore batch linked to an unknown concept: ${link.target_key}`,
        );
      }
    }
    const normalizedConcept = normalizeConceptLinks(
      concept,
      conceptDefinitions,
      warnings,
    );
    const existing = concepts.get(normalizedConcept.concept_key);
    if (normalizedConcept.merge_mode === 'claims_only' && !existing) {
      throw new Error(
        'Static Lore claims-only merge requires an existing concept.',
      );
    }
    concepts.set(
      normalizedConcept.concept_key,
      existing
        ? mergeConcept(existing, normalizedConcept, warnings)
        : normalizedConcept,
    );
  }
  for (const state of extraction.current_state) {
    if (!knownKeys.has(state.entity_key)) {
      throw new Error(
        `Static Lore batch state referenced an unknown concept: ${state.entity_key}`,
      );
    }
  }
  for (const edge of extraction.topology) {
    if (
      !knownKeys.has(edge.entity_key)
      || !knownKeys.has(edge.parent_key)
    ) {
      throw new Error('Static Lore batch topology referenced an unknown concept.');
    }
  }

  return {
    aggregate: {
      ...structuredClone(aggregate),
      concepts: [...concepts.values()],
      attribute_definitions: mergeRegistryItems(
        aggregate.attribute_definitions,
        extraction.attribute_definitions,
        'attribute_id',
        warnings,
      ),
      progression_tracks: mergeRegistryItems(
        aggregate.progression_tracks,
        extraction.progression_tracks,
        'track_id',
        warnings,
      ),
      current_state: mergeCurrentState(
        aggregate.current_state,
        extraction.current_state,
        warnings,
      ),
      topology: mergeTopology(
        aggregate.topology,
        extraction.topology,
        concepts,
        warnings,
      ),
      active_scene:
        aggregate.active_scene
        ?? structuredClone(extraction.active_scene ?? null),
    },
    warnings,
  };
}

export function staticLoreCatalog(aggregate) {
  return aggregate.concepts.map(concept => ({
    concept_key: concept.concept_key,
    type: concept.type,
    title: concept.title,
    slug: concept.slug,
    aliases: structuredClone(concept.aliases ?? []),
    tags: structuredClone(concept.tags ?? []),
    description: String(concept.description ?? '').slice(0, 400),
  }));
}

export function staticLoreCurrentStateCatalog(aggregate) {
  return (aggregate.current_state ?? []).map(item => ({
    entity_key: item.entity_key,
    state_domain: item.state_domain,
    state_key: item.state_key,
    current_value: structuredClone(item.current_value),
    certainty: item.certainty,
  }));
}
