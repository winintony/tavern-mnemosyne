import { MnemosyneRequestError } from '../contracts/errors.js';
import { hashPromptSpine } from '../contracts/hash.js';

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

export async function lockPromptSpine(messages, { runId } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    fail('prompt_spine_empty', 'Prompt spine requires at least one message.');
  }
  if (!runId || typeof runId !== 'string') {
    fail('prompt_spine_run_id_missing', 'Prompt spine runId is required.');
  }

  const prefix = structuredClone(messages);
  return Object.freeze({
    schema: 'mnemosyne.prompt-spine.v1',
    run_id: runId,
    message_count: prefix.length,
    hash: await hashPromptSpine(prefix),
  });
}

export async function assertPromptSpine(lock, messages) {
  if (!lock || lock.schema !== 'mnemosyne.prompt-spine.v1') {
    fail('prompt_spine_lock_invalid', 'A valid prompt-spine lock is required.');
  }
  if (!Array.isArray(messages) || messages.length < lock.message_count) {
    fail('prompt_spine_prefix_missing', 'Current messages do not contain the locked prefix.');
  }

  const actualHash = await hashPromptSpine(messages.slice(0, lock.message_count));
  if (actualHash !== lock.hash) {
    fail('prompt_spine_mutated', 'The preset-native prompt prefix changed after it was locked.', {
      expected_hash: lock.hash,
      actual_hash: actualHash,
    });
  }
}

export async function appendPromptStep(lock, currentMessages, additions) {
  await assertPromptSpine(lock, currentMessages);

  if (!Array.isArray(additions) || additions.length === 0) {
    fail('prompt_step_empty', 'At least one prompt step message is required.');
  }

  const invalid = additions.find(message => !['assistant', 'tool'].includes(message?.role));
  if (invalid) {
    fail('prompt_step_role_invalid', 'Tool-loop steps may append only assistant or tool messages.', {
      role: invalid?.role ?? null,
    });
  }

  return [
    ...structuredClone(currentMessages),
    ...structuredClone(additions),
  ];
}
