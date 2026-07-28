export const RUNTIME_CONTRACT_SCHEMA = 'mnemosyne.runtime-contract.v1';

export function buildRuntimeContract() {
  return [
    'Mnemosyne runtime protocol v1.',
    'The active SillyTavern preset remains the sole creative authority.',
    'Use only declared tools when older continuity is needed.',
    'Do not expose tool logs in visible prose.',
    'Submit final prose with story.commit, then submit typed memory.write_turn_delta as changed or no_change before finish.',
  ].join(' ');
}
