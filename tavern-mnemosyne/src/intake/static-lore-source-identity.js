import { canonicalJson, sha256 } from '../contracts/hash.js';

export function semanticStaticLoreSources(sources) {
  return structuredClone(sources)
    .map(source => ({
      source_id: source.source_id,
      source_kind: source.source_kind,
      host_ref: source.host_ref,
      data: source.data,
    }))
    .sort((left, right) => (
      String(left.source_id).localeCompare(String(right.source_id))
    ));
}

export function staticLoreSnapshotHash(sources) {
  return sha256(canonicalJson(semanticStaticLoreSources(sources)));
}
