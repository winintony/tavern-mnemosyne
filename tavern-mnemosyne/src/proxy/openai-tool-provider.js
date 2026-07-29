import { MnemosyneRequestError } from '../contracts/errors.js';
import { censusMark } from '../inspection/gate-census.js';
import {
  assertProviderStepWithinBudget,
  constrainProviderRequestOutput,
} from './provider-step-budget.js';
import {
  createDeepSeekV4ToolCallRetryRequest,
} from './provider-request-compatibility.js';

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

const DEFAULT_THINKING_DOWNGRADE_MEMORY_MAX_ENTRIES = 256;
const DEFAULT_THINKING_DOWNGRADE_MEMORY_TTL_MS = 30 * 60 * 1_000;

function createThinkingDowngradeMemory({
  maxEntries = DEFAULT_THINKING_DOWNGRADE_MEMORY_MAX_ENTRIES,
  ttlMs = DEFAULT_THINKING_DOWNGRADE_MEMORY_TTL_MS,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError(
      'Thinking downgrade memory maxEntries must be a positive integer.',
    );
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError(
      'Thinking downgrade memory ttlMs must be a positive integer.',
    );
  }
  if (typeof now !== 'function') {
    throw new TypeError('Thinking downgrade memory now must be a function.');
  }

  const runs = new Map();
  const pruneExpired = timestamp => {
    for (const [runId, expiresAt] of runs) {
      if (expiresAt <= timestamp) runs.delete(runId);
    }
  };

  return Object.freeze({
    has(runId) {
      if (typeof runId !== 'string' || !runId) return false;
      const timestamp = now();
      pruneExpired(timestamp);
      return runs.has(runId);
    },
    remember(runId) {
      if (typeof runId !== 'string' || !runId) return;
      const timestamp = now();
      pruneExpired(timestamp);
      runs.delete(runId);
      runs.set(runId, timestamp + ttlMs);
      while (runs.size > maxEntries) {
        runs.delete(runs.keys().next().value);
      }
    },
  });
}

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

function assistantToolCallsMissing(payload) {
  const message = payload?.choices?.[0]?.message;
  return (
    message?.role === 'assistant'
    && (
      !Array.isArray(message.tool_calls)
      || message.tool_calls.length === 0
    )
  );
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
  if (assistantToolCallsMissing(payload)) {
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
      ...(typeof message.reasoning_content === 'string'
        ? {
            // DeepSeek thinking-mode tool calls require this exact field on
            // every subsequent request in the same tool turn.
            reasoning_content: message.reasoning_content,
          }
        : {}),
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
  thinkingDowngradeMemory,
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
  const downgradedThinkingRuns = createThinkingDowngradeMemory(
    thinkingDowngradeMemory,
  );

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
      const adaptedRequestBody = adaptRequest({
        ...creativeParameters(creativeRequest),
        model,
        stream: false,
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        tool_choice: toolChoice,
        parallel_tool_calls: parallelToolCalls,
      });
      const stickyRequestBody = downgradedThinkingRuns.has(runId)
        ? createDeepSeekV4ToolCallRetryRequest({
            requestBody: adaptedRequestBody,
            endpoint,
            toolChoice,
          })
        : null;
      const stickyThinkingDowngrade = stickyRequestBody !== null;
      if (stickyThinkingDowngrade) {
        censusMark('MAIN_AI_PROVIDER_TOOL_CALL_RECOVERY', 'enter', {
          runId,
          reasonCode: 'prior_non_thinking_retry_succeeded',
          stage: 'deepseek_v4_non_thinking_sticky',
        });
      }
      const requestBody = constrainProviderRequestOutput({
        requestBody: stickyRequestBody ?? adaptedRequestBody,
        providerBudget,
        runId,
      });
      const dispatch = async body => {
        const providerBudgetEvidence = assertProviderStepWithinBudget({
          requestBody: body,
          providerBudget,
          runId,
          stepIndex,
        });
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: headersForStep,
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          let upstreamBody = null;
          try {
            upstreamBody = (await response.text()).slice(0, 600);
          } catch {
            upstreamBody = null;
          }
          if (upstreamBody) {
            for (const secret of [
              resolvedAuth?.apiKey,
              headersForStep?.authorization,
              authContext?.authorization,
            ]) {
              if (typeof secret === 'string' && secret) {
                upstreamBody = upstreamBody.split(secret).join('[redacted]');
              }
            }
          }
          throw upstreamError(
            'main_ai_provider_upstream_error',
            'The configured main-model provider rejected the tool step.',
            {
              upstream_status: response.status,
              upstream_body_snippet: upstreamBody,
            },
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
        return { payload, providerBudgetEvidence };
      };

      const firstAttempt = await dispatch(requestBody);
      const retryBody = (
        !stickyThinkingDowngrade
        && assistantToolCallsMissing(firstAttempt.payload)
      )
        ? createDeepSeekV4ToolCallRetryRequest({
            requestBody,
            endpoint,
            toolChoice,
          })
        : null;
      if (!retryBody) {
        return {
          ...normalizeCompletion(firstAttempt.payload, model),
          provider_budget_evidence:
            firstAttempt.providerBudgetEvidence,
        };
      }

      censusMark('MAIN_AI_PROVIDER_TOOL_CALL_RECOVERY', 'enter', {
        runId,
        reasonCode: 'assistant_tool_calls_missing',
        stage: 'deepseek_v4_non_thinking_retry',
      });
      const retryAttempt = await dispatch(
        constrainProviderRequestOutput({
          requestBody: retryBody,
          providerBudget,
          runId,
        }),
      );
      const normalizedRetry = normalizeCompletion(
        retryAttempt.payload,
        model,
      );
      downgradedThinkingRuns.remember(runId);
      return {
        ...normalizedRetry,
        provider_budget_evidence: Object.freeze([
          firstAttempt.providerBudgetEvidence,
          retryAttempt.providerBudgetEvidence,
        ]),
      };
    },
  });
}
