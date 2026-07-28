import { MnemosyneRequestError } from '../contracts/errors.js';

const TRACE_KEY = 'mnemosyne_prompt_trace';

export function mergePromptTraceIntoCustomBody(value, promptTrace) {
  let existing = {};

  if (value !== undefined && value !== null && String(value).trim() !== '') {
    try {
      existing = JSON.parse(String(value));
    } catch (error) {
      throw new MnemosyneRequestError(
        'custom_include_body_invalid_json',
        'Custom OpenAI include body must be a valid JSON object before Mnemosyne can attach its trace.',
        { cause: error.message },
      );
    }
  }

  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new MnemosyneRequestError(
      'custom_include_body_not_object',
      'Custom OpenAI include body must be a JSON object.',
    );
  }

  if (!promptTrace || typeof promptTrace !== 'object' || Array.isArray(promptTrace)) {
    throw new MnemosyneRequestError(
      'prompt_trace_invalid',
      'Mnemosyne prompt trace must be an object.',
    );
  }

  return JSON.stringify({
    ...existing,
    [TRACE_KEY]: promptTrace,
  });
}
