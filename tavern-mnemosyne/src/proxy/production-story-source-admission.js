import {
  createProductionStorySourceAdmissionRuntime,
} from '../runtime/story-source-admission-runtime.js';

function removalRunScope(runScope) {
  return {
    chat_id: runScope?.chat_id,
    run_id: runScope?.run_id,
    branch_id: runScope?.branch_id,
    branch_epoch: runScope?.branch_epoch,
    turn_index: runScope?.turn_index,
  };
}
/**
 * Binds production Story Source Admission to the trusted grant ledger.
 *
 * Story admission owns the full nine-field run identity. Source-removal
 * grants intentionally bind only the five fields used by their ledger,
 * so the verifier receives that exact projection and its trusted result
 * is rebound to the full story run before a receipt can be issued.
 */
export function createGrantBackedStorySourceAdmission({
  sourceRemovalGrantService,
} = {}) {
  if (
    typeof sourceRemovalGrantService?.verifyCoverageBinding
      !== 'function'
  ) {
    throw new Error(
      'Production story admission requires the source-removal grant verifier.',
    );
  }
  return createProductionStorySourceAdmissionRuntime({
    async verifyAdmissionEvidence({
      runScope,
      hostProvenance,
    }) {
      const sourceCoverage =
        hostProvenance?.source_coverage;
      if (!sourceCoverage) return null;
      const evidence =
        await sourceRemovalGrantService.verifyCoverageBinding({
          coverageBinding: sourceCoverage.binding,
          coverageBindingHash: sourceCoverage.binding_hash,
          grants: sourceCoverage.grants,
          runScope: removalRunScope(runScope),
          providerFingerprints:
            sourceCoverage.provider_fingerprints,
        });
      if (!evidence) return null;
      return {
        ...structuredClone(evidence),
        run_scope: structuredClone(runScope),
      };
    },
  });
}
