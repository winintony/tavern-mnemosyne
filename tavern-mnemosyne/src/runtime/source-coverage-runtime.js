import {
  createSourceCoverageGate,
} from './source-coverage-gate.js';
import {
  createSourceCoverageRegistry,
} from './source-coverage-registry.js';
import {
  createSourceRemovalGrantService,
} from './source-removal-grants.js';
import {
  createPaidIntakeSourceUnitManifestProvider,
} from './paid-intake-source-unit-manifest.js';

export function createProductionSourceCoverageRuntime({
  store,
  memoryReader,
  sourceUnitManifestProvider = null,
  now,
} = {}) {
  const trustedManifestProvider = sourceUnitManifestProvider
    ?? createPaidIntakeSourceUnitManifestProvider({ store });
  const coverageGate = createSourceCoverageGate({
    store,
    memoryReader,
    ...(now === undefined ? {} : { now }),
  });
  const coverageRegistry = createSourceCoverageRegistry({
    store,
    coverageGate,
    sourceUnitManifestProvider: trustedManifestProvider,
    ...(now === undefined ? {} : { now }),
  });
  const sourceRemovalGrantService = createSourceRemovalGrantService({
    store,
    coveragePolicy: 'strict',
    trustedRemovalClaimSelector:
      coverageRegistry.selectRemovalClaimIdentifiers,
    trustedCoverageVerifier:
      coverageRegistry.trustedCoverageVerifier,
    ...(now === undefined ? {} : { now }),
  });
  return Object.freeze({
    coverageGate,
    coverageRegistry,
    sourceRemovalGrantService,
  });
}
