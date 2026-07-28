import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  assertProviderStepWithinBudget,
  constrainProviderRequestOutput,
} from './provider-step-budget.js';

const KERNEL_OWNED_FIELDS = new Set([
  'model',
  'stream',
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
]);

const PRIVATE_REQUEST_FIELDS = new Set([
  'api_key',
  'authorization',
  'endpoint',
  'headers',
  'mnemosyne_prompt_trace',
]);

function normalizeHeaders(headers, auth) {
  const normalized = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized[name.toLowerCase()] = String(value);
  }
  if (auth?.mode === 'configured' && auth.apiKey) {
    normalized.authorization = `Bearer ${auth.apiKey}`;
  }
  return normalized;
}

function normalizeAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('OpenAI tool provider auth must be an object.');
  }
  const mode = auth.mode ?? 'configured';
  if (!['configured', 'passthrough', 'none'].includes(mode)) {
    throw new Error(`Unsupported OpenAI tool provider auth mode: ${mode}`);
  }
  if (
    auth.apiKey !== undefined
    && (typeof auth.apiKey !== 'string' || !auth.apiKey)
  ) {
    throw new Error('OpenAI tool provider apiKey must be a non-empty string.');
  }
  return Object.freeze({
    mode,
    ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
  });
}

function creativeParameters(creativeRequest) {
  const result = {};
  for (const [name, value] of Object.entries(creativeRequest ?? {})) {
    if (
      value !== undefined
      && !KERNEL_OWNED_FIELDS.has(name)
      && !PRIVATE_REQUEST_FIELDS.has(name)
    ) {
      result[name] = structuredClone(value);
    }
  }
  return result;
}

function normalizeCompletion(payload, fallbackModel) {
  const message = payload?.choices?.[0]?.message;
  if (message?.role !== 'assistant') {
    throw upstreamError(
      'main_ai_provider_response_invalid',
      'The configured main-model provider omitted its assistant message.',
      { failure: 'assistant_message_missing' },
    );
  }
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    throw upstreamError(
      'main_ai_provider_response_invalid',
      'The configured main-model provider omitted required tool calls.',
      { failure: 'assistant_tool_calls_missing' },
    );
  }
  const toolCalls = message.tool_calls.map((call, callIndex) => {
    if (
      typeof call?.id !== 'string'
      || !call.id
      || typeof call?.function?.name !== 'string'
      || !call.function.name
      || typeof call?.function?.arguments !== 'string'
    ) {
      throw upstreamError(
        'main_ai_provider_response_invalid',
        'The configured main-model provider returned a malformed tool call.',
        {
          failure: 'assistant_tool_call_invalid',
          call_index: callIndex,
        },
      );
    }
    return {
      id: call.id,
      type: 'function',
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    };
  });

  return {
    model: typeof payload?.model === 'string'
      ? payload.model
      : fallbackModel,
    assistant_message: {
      role: 'assistant',
      content: structuredClone(message.content ?? null),
      tool_calls: toolCalls,
    },
    usage: structuredClone(payload?.usage ?? {}),
  };
}

function upstreamError(reasonCode, message, details) {
  const error = new MnemosyneRequestError(reasonCode, message, details);
  error.statusCode = 502;
  return error;
}

export function createOpenAiToolProvider({
  fetchImpl = globalThis.fetch,
  endpoint,
  model,
  headers = {},
  auth = { mode: 'configured' },
  adaptRequest = request => request,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('OpenAI tool provider requires fetchImpl.');
  }
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    throw new Error('OpenAI tool provider requires an endpoint.');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('OpenAI tool provider requires a model.');
  }
  if (typeof adaptRequest !== 'function') {
    throw new Error('OpenAI tool provider adaptRequest must be a function.');
  }

  const resolvedAuth = normalizeAuth(auth);
  const requestHeaders = normalizeHeaders(headers, resolvedAuth);

  return Object.freeze({
    async completeToolStep({
      runId,
      creativeRequest,
      messages,
      tools,
      toolChoice,
      parallelToolCalls,
      authContext,
      providerBudget,
      stepIndex,
      signal,
    }) {
      const headersForStep = { ...requestHeaders };
      if (
        resolvedAuth.mode === 'passthrough'
        && typeof authContext?.authorization === 'string'
        && authContext.authorization
      ) {
        headersForStep.authorization = authContext.authorization;
      }
      const requestBody = constrainProviderRequestOutput({
        requestBody: adaptRequest({
          ...creativeParameters(creativeRequest),
          model,
          stream: false,
          messages: structuredClone(messages),
          tools: structuredClone(tools),
          tool_choice: toolChoice,
          parallel_tool_calls: parallelToolCalls,
        }),
        providerBudget,
        runId,
      });
      const providerBudgetEvidence = assertProviderStepWithinBudget({
        requestBody,
        providerBudget,
        runId,
        stepIndex,
      });
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: headersForStep,
        body: JSON.stringify(requestBody),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw upstreamError(
          'main_ai_provider_upstream_error',
          'The configured main-model provider rejected the tool step.',
          { upstream_status: response.status },
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw upstreamError(
          'main_ai_provider_response_invalid',
          'The configured main-model provider returned invalid JSON.',
          { failure: 'invalid_json' },
        );
      }
      return {
        ...normalizeCompletion(payload, model),
        provider_budget_evidence: providerBudgetEvidence,
      };
    },
  });
}
