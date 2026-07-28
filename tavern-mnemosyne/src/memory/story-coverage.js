export const STORY_COVERAGE_FACETS = Object.freeze([
  'character',
  'character_cognition',
  'relationship',
  'scene_event',
  'world_lore',
  'plot_thread',
  'scene_state',
  'attribute_value',
  'current_state',
]);

const STORY_COVERAGE_FACET_SET =
  new Set(STORY_COVERAGE_FACETS);

export class StoryCoverageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoryCoverageError';
    this.reasonCode = 'memory_coverage_facets_invalid';
  }
}

export function normalizeStoryCoverageFacets(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > STORY_COVERAGE_FACETS.length
    || value.some(facet => (
      typeof facet !== 'string'
      || !STORY_COVERAGE_FACET_SET.has(facet)
    ))
  ) {
    throw new StoryCoverageError(
      'Story coverage facets must use supported typed memory lanes.',
    );
  }
  return [...new Set(value)];
}

export function storyCoverageFacetsForMemory(memory) {
  if (memory?.kind === 'current_state') {
    return [
      memory?.state?.domain === 'attribute'
        ? 'attribute_value'
        : 'current_state',
    ];
  }
  const type = memory?.type ?? memory?.record_kind ?? null;
  if (STORY_COVERAGE_FACET_SET.has(type)) {
    return [type];
  }
  return [];
}

export function selectStoryCoverageCandidates({
  candidates,
  requestedFacets,
  limit,
}) {
  if (
    !Array.isArray(candidates)
    || !Array.isArray(requestedFacets)
    || !Number.isInteger(limit)
    || limit < 1
  ) {
    throw new TypeError(
      'Story coverage selection requires ranked candidates and a limit.',
    );
  }
  const selected = new Set();
  const uncoveredFacets = new Set(requestedFacets);
  while (uncoveredFacets.size > 0 && selected.size < limit) {
    let bestCandidate = null;
    let bestGain = 0;
    for (const candidate of candidates) {
      if (selected.has(candidate)) continue;
      const gain = storyCoverageFacetsForMemory(
        candidate.memory,
      ).filter(facet => uncoveredFacets.has(facet)).length;
      if (gain > bestGain) {
        bestCandidate = candidate;
        bestGain = gain;
      }
    }
    if (bestCandidate === null) break;
    selected.add(bestCandidate);
    for (const facet of storyCoverageFacetsForMemory(
      bestCandidate.memory,
    )) {
      uncoveredFacets.delete(facet);
    }
  }
  for (const candidate of candidates) {
    if (selected.size >= limit) break;
    selected.add(candidate);
  }
  const selectedCandidates = candidates.filter(
    candidate => selected.has(candidate),
  );
  const representedFacets = requestedFacets.filter(facet => (
    selectedCandidates.some(candidate => (
      storyCoverageFacetsForMemory(candidate.memory)
        .includes(facet)
    ))
  ));
  return {
    candidates: selectedCandidates,
    coverage: {
      schema: 'mnemosyne.story-coverage.v1',
      mode: requestedFacets.length > 0
        ? 'facet_balanced'
        : 'relevance',
      requested_facets: structuredClone(requestedFacets),
      represented_facets: representedFacets,
      missing_facets: requestedFacets.filter(
        facet => !representedFacets.includes(facet),
      ),
    },
  };
}
