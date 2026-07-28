import {
  get_encoding as getEncoding,
} from 'tiktoken';

import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';

export const PROVIDER_BUDGET_SCHEMA = 'mnemosyne.provider-budget.v1';
export const PROVIDER_BUDGET_POLICY_SCHEMA =
  'mnemosyne.provider-budget-policy.v1';
export const OPENAI_TOKENIZER_PROFILE = 'openai:o200k_base.v1';
const TOKENIZER_ENCODING = 'o200k_base';
export const REQUEST_SAFETY_TOKENS = 64;
const PROVIDER_BUDGET_KEYS = new Set([
  'schema',
  'run_id',
  'configured_context_tokens',
  'output_reserve_tokens',
  'provider_input_tokens',
  'binding_hash',
]);
const PROVIDER_BUDGET_POLICY_KEYS = new Set([
  'schema',
  'configured_context_tokens',
  'output_reserve_tokens',
  'provider_input_tokens',
  'tokenizer_profile',
  'request_safety_tokens',
  'policy_hash',
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

let encoder;

function openAiEncoder() {
  encoder ??= getEncoding(TOKENIZER_ENCODING);
  return encoder;
}

export function countOpenAiTokens(value) {
  const text = typeof value === 'string'
    ? value
    : canonicalJson(value);
  return openAiEncoder().encode(text).length;
}

export function estimateOpenAiRequestTokens(requestBody) {
  const serialized = JSON.stringify(requestBody);
  if (typeof serialized !== 'string') {
    throw providerBudgetBindingError('request_body_invalid');
  }
  const encodedTokens = countOpenAiTokens(serialized);
  return Object.freeze({
    tokenizer_profile: OPENAI_TOKENIZER_PROFILE,
    encoded_request_tokens: encodedTokens,
    safety_tokens: REQUEST_SAFETY_TOKENS,
    measured_input_tokens: encodedTokens + REQUEST_SAFETY_TOKENS,
    request_hash: sha256(serialized),
  });
}

function providerBudgetPayload({
  runId,
  contextTokens,
  outputReserveTokens,
}) {
  return {
    schema: PROVIDER_BUDGET_SCHEMA,
    run_id: runId,
    configured_context_tokens: contextTokens,
    output_reserve_tokens: outputReserveTokens,
    provider_input_tokens: contextTokens - outputReserveTokens,
  };
}

function providerBudgetFieldsValid({
  contextTokens,
  outputReserveTokens,
}) {
  return (
    Number.isSafeInteger(contextTokens)
    && contextTokens > 0
    && Number.isSafeInteger(outputReserveTokens)
    && outputReserveTokens > 0
    && outputReserveTokens < contextTokens
  );
}

function providerBudgetBindingError(failure) {
  return new MnemosyneRequestError(
    'provider_budget_binding_invalid',
    'The provider step requires its exact sealed context budget.',
    { failure },
  );
}

function providerBudgetPolicyError(
  reasonCode,
  message,
  details,
) {
  return new MnemosyneRequestError(reasonCode, message, details);
}

export function createProviderBudgetBinding({
  runId,
  contextTokens,
  outputReserveTokens,
} = {}) {
  if (
    typeof runId !== 'string'
    || !runId
    || !providerBudgetFieldsValid({
      contextTokens,
      outputReserveTokens,
    })
  ) {
    throw providerBudgetBindingError('fields_invalid');
  }
  const payload = providerBudgetPayload({
    runId,
    contextTokens,
    outputReserveTokens,
  });
  return Object.freeze({
    ...payload,
    binding_hash: sha256(canonicalJson(payload)),
  });
}

export function createProviderBudgetPolicy({
  contextTokens,
  outputReserveTokens,
} = {}) {
  if (!providerBudgetFieldsValid({
    contextTokens,
    outputReserveTokens,
  })) {
    throw providerBudgetBindingError('policy_fields_invalid');
  }
  const payload = {
    schema: PROVIDER_BUDGET_POLICY_SCHEMA,
    configured_context_tokens: contextTokens,
    output_reserve_tokens: outputReserveTokens,
    provider_input_tokens: contextTokens - outputReserveTokens,
    tokenizer_profile: OPENAI_TOKENIZER_PROFILE,
    request_safety_tokens: REQUEST_SAFETY_TOKENS,
  };
  return Object.freeze({
    ...payload,
    policy_hash: sha256(canonicalJson(payload)),
  });
}

export function normalizeProviderBudgetPolicy(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length
      !== PROVIDER_BUDGET_POLICY_KEYS.size
    || Object.keys(value).some(
      key => !PROVIDER_BUDGET_POLICY_KEYS.has(key),
    )
  ) {
    throw providerBudgetPolicyError(
      'provider_budget_policy_invalid',
      'The server provider budget policy is invalid.',
      { failure: 'shape_invalid' },
    );
  }
  let expected;
  try {
    expected = createProviderBudgetPolicy({
      contextTokens: value.configured_context_tokens,
      outputReserveTokens: value.output_reserve_tokens,
    });
  } catch {
    throw providerBudgetPolicyError(
      'provider_budget_policy_invalid',
      'The server provider budget policy is invalid.',
      { failure: 'fields_invalid' },
    );
  }
  if (
    value.schema !== expected.schema
    || value.provider_input_tokens
      !== expected.provider_input_tokens
    || value.tokenizer_profile !== expected.tokenizer_profile
    || value.request_safety_tokens
      !== expected.request_safety_tokens
    || !HASH_PATTERN.test(value.policy_hash ?? '')
    || value.policy_hash !== expected.policy_hash
  ) {
    throw providerBudgetPolicyError(
      'provider_budget_policy_invalid',
      'The server provider budget policy seal is invalid.',
      { failure: 'seal_mismatch' },
    );
  }
  return expected;
}

export function assertProviderBudgetMatchesPolicy({
  providerBudget,
  providerPolicy,
  runId,
} = {}) {
  if (providerPolicy == null) {
    throw providerBudgetPolicyError(
      'provider_budget_policy_unavailable',
      'The server provider budget policy is unavailable.',
      { failure: 'policy_missing' },
    );
  }
  const normalizedPolicy =
    normalizeProviderBudgetPolicy(providerPolicy);
  const normalizedBudget = normalizeProviderBudgetBinding(
    providerBudget,
    { runId },
  );
  const comparableFields = [
    'configured_context_tokens',
    'output_reserve_tokens',
    'provider_input_tokens',
  ];
  const mismatch = comparableFields.find(
    field => normalizedBudget[field] !== normalizedPolicy[field],
  );
  if (mismatch) {
    throw providerBudgetPolicyError(
      'provider_budget_policy_mismatch',
      'The trace provider budget does not match server policy.',
      {
        failure: mismatch,
        policy_hash: normalizedPolicy.policy_hash,
      },
    );
  }
  return normalizedBudget;
}

export function normalizeProviderBudgetBinding(
  value,
  {
    runId,
  } = {},
) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== PROVIDER_BUDGET_KEYS.size
    || Object.keys(value).some(key => !PROVIDER_BUDGET_KEYS.has(key))
  ) {
    throw providerBudgetBindingError('shape_invalid');
  }
  let expected;
  try {
    expected = createProviderBudgetBinding({
      runId: value.run_id,
      contextTokens: value.configured_context_tokens,
      outputReserveTokens: value.output_reserve_tokens,
    });
  } catch {
    throw providerBudgetBindingError('fields_invalid');
  }
  if (
    typeof runId !== 'string'
    || !runId
    || value.run_id !== runId
  ) {
    throw providerBudgetBindingError('run_identity_mismatch');
  }
  if (
    value.provider_input_tokens
      !== expected.provider_input_tokens
    || !HASH_PATTERN.test(value.binding_hash ?? '')
    || value.binding_hash !== expected.binding_hash
  ) {
    throw providerBudgetBindingError('seal_mismatch');
  }
  return expected;
}

function budgetExceeded({
  providerBudget,
  estimate,
  stepIndex,
}) {
  return new MnemosyneRequestError(
    'provider_step_budget_exceeded',
    'The provider tool step exceeds its sealed input budget.',
    {
      configured_context_tokens:
        providerBudget.configured_context_tokens,
      output_reserve_tokens:
        providerBudget.output_reserve_tokens,
      provider_input_tokens:
        providerBudget.provider_input_tokens,
      measured_input_tokens: estimate.measured_input_tokens,
      tokenizer_profile: estimate.tokenizer_profile,
      request_hash: estimate.request_hash,
      ...(Number.isSafeInteger(stepIndex) && stepIndex >= 0
        ? { step_index: stepIndex }
        : {}),
    },
  );
}

function providerOutputBudgetError(
  reasonCode,
  message,
  details,
) {
  return new MnemosyneRequestError(reasonCode, message, details);
}

function validateProviderOutputLimit(requestBody, providerBudget) {
  if (
    !requestBody
    || typeof requestBody !== 'object'
    || Array.isArray(requestBody)
  ) {
    throw providerOutputBudgetError(
      'provider_output_budget_invalid',
      'The provider request body must be an object.',
      { failure: 'request_body_invalid' },
    );
  }
  const outputFields = [
    'max_tokens',
    'max_completion_tokens',
  ].filter(field => Object.hasOwn(requestBody, field));
  if (outputFields.length !== 1) {
    throw providerOutputBudgetError(
      'provider_output_budget_invalid',
      'Each provider step requires exactly one explicit output limit.',
      {
        failure: outputFields.length === 0
          ? 'output_limit_missing'
          : 'output_limit_ambiguous',
      },
    );
  }
  const field = outputFields[0];
  const requestedOutputTokens = requestBody[field];
  if (
    !Number.isSafeInteger(requestedOutputTokens)
    || requestedOutputTokens < 1
  ) {
    throw providerOutputBudgetError(
      'provider_output_budget_invalid',
      'The provider output limit must be a positive safe integer.',
      { failure: 'output_limit_invalid', field },
    );
  }
  if (requestedOutputTokens > providerBudget.output_reserve_tokens) {
    throw providerOutputBudgetError(
      'provider_output_budget_exceeded',
      'The provider step requests more output than its sealed reserve.',
      {
        field,
        requested_output_tokens: requestedOutputTokens,
        output_reserve_tokens:
          providerBudget.output_reserve_tokens,
      },
    );
  }
}

export function constrainProviderRequestOutput({
  requestBody,
  providerBudget,
  runId,
} = {}) {
  const normalizedBudget = normalizeProviderBudgetBinding(
    providerBudget,
    { runId },
  );
  if (
    !requestBody
    || typeof requestBody !== 'object'
    || Array.isArray(requestBody)
  ) {
    throw providerOutputBudgetError(
      'provider_output_budget_invalid',
      'The provider request body must be an object.',
      { failure: 'request_body_invalid' },
    );
  }
  const constrained = structuredClone(requestBody);
  if (
    !Object.hasOwn(constrained, 'max_tokens')
    && !Object.hasOwn(constrained, 'max_completion_tokens')
  ) {
    constrained.max_tokens = normalizedBudget.output_reserve_tokens;
  }
  validateProviderOutputLimit(constrained, normalizedBudget);
  return constrained;
}

export function assertProviderStepWithinBudget({
  requestBody,
  providerBudget,
  runId,
  stepIndex,
} = {}) {
  const normalizedBudget = normalizeProviderBudgetBinding(
    providerBudget,
    { runId },
  );
  validateProviderOutputLimit(requestBody, normalizedBudget);
  const estimate = estimateOpenAiRequestTokens(requestBody);
  if (
    estimate.measured_input_tokens
      > normalizedBudget.provider_input_tokens
  ) {
    throw budgetExceeded({
      providerBudget: normalizedBudget,
      estimate,
      stepIndex,
    });
  }
  return Object.freeze({
    schema: 'mnemosyne.provider-step-budget-evidence.v1',
    run_id: normalizedBudget.run_id,
    budget_binding_hash: normalizedBudget.binding_hash,
    step_index:
      Number.isSafeInteger(stepIndex) && stepIndex >= 0
        ? stepIndex
        : null,
    tokenizer_profile: estimate.tokenizer_profile,
    measured_input_tokens: estimate.measured_input_tokens,
    provider_input_tokens:
      normalizedBudget.provider_input_tokens,
    request_hash: estimate.request_hash,
  });
}
