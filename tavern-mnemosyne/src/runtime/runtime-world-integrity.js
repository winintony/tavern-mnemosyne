import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';
import { censusMark } from '../inspection/gate-census.js';

export class RuntimeWorldIntegrityError extends Error {
  constructor(reasonCode, message, details = null) {
    super(message);
    this.name = 'RuntimeWorldIntegrityError';
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function invalid(reasonCode, message, details = null) {
  throw new RuntimeWorldIntegrityError(
    reasonCode,
    message,
    details,
  );
}

/**
 * Proves that the readable Runtime World file is exactly the one recorded by
 * the sole ready projection for the active Static Lore snapshot.
 */
export function assertRuntimeWorldProjectionIntegrity({
  runtimeWorld,
  activeSnapshot,
  readyProjectionHashes,
}) {
  censusMark('WORLD_HASH_INTEGRITY', 'enter', { runId: null });
  if (
    runtimeWorld?.schema !== 'mnemosyne.runtime-world.v1'
    || runtimeWorld.status !== 'ready'
  ) {
    invalid(
      'runtime_world_view_invalid',
      'The Runtime World view is not ready or has an invalid contract.',
    );
  }
  if (
    !activeSnapshot
    || runtimeWorld.snapshot_id !== activeSnapshot.snapshot_id
    || runtimeWorld.snapshot_hash !== activeSnapshot.snapshot_hash
  ) {
    invalid(
      'runtime_world_snapshot_not_active',
      'The Runtime World view is not bound to the active Static Lore snapshot.',
    );
  }
  if (
    !Array.isArray(readyProjectionHashes)
    || readyProjectionHashes.length === 0
  ) {
    invalid(
      'runtime_world_projection_missing',
      'A ready Runtime World projection is required.',
    );
  }
  if (readyProjectionHashes.length !== 1) {
    invalid(
      'runtime_world_projection_ambiguous',
      'Exactly one ready Runtime World projection is required.',
      { projection_count: readyProjectionHashes.length },
    );
  }
  const runtimeWorldHash = sha256(canonicalJson(runtimeWorld));
  const [projectionHash] = readyProjectionHashes;
  if (projectionHash !== runtimeWorldHash) {
    invalid(
      'runtime_world_projection_stale',
      'The ready Runtime World projection does not match the readable view.',
      {
        projection_hash: projectionHash,
        runtime_world_hash: runtimeWorldHash,
      },
    );
  }
  censusMark('WORLD_HASH_INTEGRITY', 'passed', { runId: null });
  return Object.freeze({
    runtime_world_hash: runtimeWorldHash,
  });
}
