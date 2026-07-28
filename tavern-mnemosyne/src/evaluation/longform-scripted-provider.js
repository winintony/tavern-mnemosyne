// Zero-payment, zero-network provider adapter for the longform runner
// (issue 19, slice 2). It replays a turn script's `tool_script` entries
// verbatim, then always issues exactly one `story_commit` (from
// `assistant_body`) followed by exactly one `memory_write_turn_delta`
// (from `typed_delta`). It never calls out to a model, an HTTP client, or
// any other network/provider module -- this file has no imports at all.

export const LONGFORM_SCRIPTED_PROVIDER_MODEL_ID =
  'mnemosyne.longform-fixture-scripted-provider.v1';

const REF_PLACEHOLDER = '$PREV_REFS';

function toolCall(id, name, args) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    }],
  };
}

function resolvePlaceholders(args, lastSearchResult) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (value !== REF_PLACEHOLDER) return [key, value];
    if (!lastSearchResult) {
      throw new Error(
        `Longform scripted provider cannot resolve ${REF_PLACEHOLDER}: ` +
          'no prior memory_search result is available this turn.',
      );
    }
    return [key, lastSearchResult.results.map(result => result.ref)];
  }));
}

// Builds a provider whose completeToolStep() drives exactly one turn
// script through the Run Kernel's tool-step loop. Create a fresh instance
// per committed turn (the loop stops once memory_write_turn_delta has
// been issued, so this provider is single-use).
export function createLongformScriptedTurnProvider({ turnScript } = {}) {
  if (
    !turnScript
    || typeof turnScript.turn_id !== 'string'
    || !Array.isArray(turnScript.tool_script)
    || typeof turnScript.assistant_body !== 'string'
    || !turnScript.typed_delta
  ) {
    throw new TypeError(
      'Longform scripted provider requires a validated turn script.',
    );
  }
  let stepIndex = 0;
  let lastSearchResult = null;
  let commitIssued = false;
  let writebackIssued = false;

  return Object.freeze({
    async completeToolStep(input) {
      if (writebackIssued) {
        throw new Error(
          `Longform scripted provider for turn ${turnScript.turn_id} was ` +
            'called again after its writeback step.',
        );
      }
      // Track the most recent memory_search result so a later
      // memory_read step can reference it via $PREV_REFS.
      const lastMessage = input?.messages?.at(-1);
      if (
        stepIndex > 0
        && typeof lastMessage?.content === 'string'
        && lastMessage.content
      ) {
        try {
          const parsed = JSON.parse(lastMessage.content);
          if (parsed?.tool === 'memory.search' && parsed.ok) {
            lastSearchResult = parsed.result;
          }
        } catch {
          // Not a JSON tool-result message; ignore.
        }
      }

      if (stepIndex < turnScript.tool_script.length) {
        const step = turnScript.tool_script[stepIndex];
        stepIndex += 1;
        return {
          model: LONGFORM_SCRIPTED_PROVIDER_MODEL_ID,
          assistant_message: toolCall(
            `call-${turnScript.turn_id}-${stepIndex}`,
            step.name,
            resolvePlaceholders(step.arguments, lastSearchResult),
          ),
        };
      }

      if (!commitIssued) {
        commitIssued = true;
        return {
          model: LONGFORM_SCRIPTED_PROVIDER_MODEL_ID,
          assistant_message: toolCall(
            `call-${turnScript.turn_id}-commit`,
            'story_commit',
            {
              body: turnScript.assistant_body,
              format: 'host_default',
              warnings: [],
            },
          ),
        };
      }

      const commitResult = JSON.parse(lastMessage.content).result;
      writebackIssued = true;
      return {
        model: LONGFORM_SCRIPTED_PROVIDER_MODEL_ID,
        assistant_message: toolCall(
          `call-${turnScript.turn_id}-writeback`,
          'memory_write_turn_delta',
          {
            commit_id: commitResult.commit_id,
            mode: turnScript.typed_delta.mode,
            reason: turnScript.typed_delta.reason,
            records: turnScript.typed_delta.records,
          },
        ),
      };
    },
  });
}
