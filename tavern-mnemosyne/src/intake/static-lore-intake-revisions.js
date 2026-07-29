// Single source of truth for the Static Lore Intake revisions.
//
// Every consumer that validates persisted intake state must import these
// instead of restating the numbers: a paid session is only interpretable by
// the exact revisions that minted it, and a private copy that drifts one bump
// behind fails at the end of the paid path instead of at the change.
//
// Bump INTAKE_CONTRACT_REVISION when the extraction contract changes shape.
// Bump SOURCE_PARTITION_REVISION when source units or batch boundaries move.
export const INTAKE_CONTRACT_REVISION = 7;
export const SOURCE_PARTITION_REVISION = 6;
