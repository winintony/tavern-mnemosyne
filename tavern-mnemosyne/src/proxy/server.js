import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { Agent, fetch as undiciFetch } from 'undici';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  operationRegistryCanonicalJson,
} from '../control/control-operation-registry.js';
import {
  assertGenerationTransportBinding,
  assertRootTransportLease,
} from '../control/generation-transport-binding.js';
import {
  sealMd1HostModelBinding,
} from '../harness/md1-acceptance.js';
import { prepareUpstreamRequest } from '../host/prepare-upstream-request.js';
import {
  assertAdmittedStoryRequest,
} from '../runtime/story-source-admission.js';
import {
  createStorySourceAdmissionInput,
} from '../runtime/story-source-host-adapter.js';
import {
  assertProviderBudgetMatchesPolicy,
  assertProviderStepWithinBudget,
  constrainProviderRequestOutput,
  countOpenAiTokens,
  createProviderBudgetBinding,
  normalizeProviderBudgetPolicy,
} from './provider-step-budget.js';
import {
  createCapabilityRegistry,
  listCapabilities,
} from '../runtime/capabilities.js';
import { getContextResponse } from '../runtime/context-provider.js';

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTAKE_BODY_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_INTAKE_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_INTAKE_OVERALL_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_INTAKE_STREAM_TERMINAL_GRACE_MS = 1_000;
const DEFAULT_ROOT_RUN_OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const RUNTIME_SUPPORTED_PROTOCOLS = Object.freeze(['1']);
const UPSTREAM_READINESS_TIMEOUT_MS = 15 * 1000;
const STREAM_TERMINAL_GRACE_EXPIRED = Symbol('stream_terminal_grace_expired');
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ROOT_RUN_ACCEPTANCE_GUARD_SCHEMA =
  'mnemosyne.root-run-acceptance-guard.v1';
const ROOT_RUN_ACCEPTANCE_GUARD_STATE_SCHEMA =
  'mnemosyne.root-run-acceptance-guard-state.v1';
const ROOT_RUN_ACCEPTANCE_GUARD_KEYS = new Set([
  'schema',
  'claims',
  'acceptance_nonce',
  'pending_message_body',
  'guard_hash',
]);
const ROOT_RUN_ACCEPTANCE_GUARD_CLAIM_KEYS = new Set([
  'chat_id_hash',
  'branch_id',
  'branch_epoch',
  'visible_turn_index',
  'parent_turn_index',
  'memory_turn_index',
  'target_turn_index',
  'host_history_binding_hash',
  'pending_message_body_hash',
  'acceptance_nonce_hash',
  'prepare_evidence_contract_hash',
]);
const ROOT_RUN_ACCEPTANCE_GUARD_STATE_KEYS = new Set([
  'schema',
  'guard_hash',
  'run_id_hash',
  'prompt_spine_hash',
  'consumed_at',
  'state_hash',
]);
const FRESH_INTAKE_AUTHORITY_GUARD_SCHEMA =
  'mnemosyne.fresh-intake-authority-guard.v1';
const FRESH_INTAKE_AUTHORITY_HEALTH_KEYS = new Set([
  'schema',
  'status',
  'witness_hash',
  'phase',
  'chat_id_hash',
  'character_id_hash',
  'chat_save_root_hash',
  'host_chat_hash',
  'state_hash',
]);
const RUNTIME_BUDGET_PROFILE_SCHEMA =
  'mnemosyne.runtime-budget-profile.v2';
const RUNTIME_BUDGET_PROFILE_KEYS = new Set([
  'schema',
  'provider_context_tokens',
  'provider_output_reserve_tokens',
  'root_max_tool_steps',
  'memory_read_max_tokens',
  'max_request_body_bytes',
  'static_lore_max_input_bytes',
  'static_lore_max_output_tokens',
  'root_overall_timeout_ms',
  'profile_hash',
]);

export function applyLoopbackCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) return;

  try {
    const url = new URL(origin);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return;
    if (!['http:', 'https:'].includes(url.protocol)) return;
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.setHeader(
      'access-control-allow-headers',
      [
        'authorization',
        'content-type',
        'x-mnemosyne-session-token',
        'x-mnemosyne-control-adapter',
        'x-mnemosyne-bridge-version',
        'x-mnemosyne-protocol-version',
      ].join(', '),
    );
    response.setHeader(
      'access-control-expose-headers',
      [
        'x-mnemosyne-runtime-build-id',
        'x-mnemosyne-runtime-instance-id',
        'x-mnemosyne-protocol-version',
      ].join(', '),
    );
    response.setHeader('vary', 'Origin');
  } catch {
    // An invalid Origin receives no CORS permission.
  }
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function bindClientCancellation({
  request,
  response,
  controller,
  onCancel = () => {},
}) {
  let cleaned = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    request.off('aborted', cancel);
    response.off('close', close);
    response.off('finish', cleanup);
  }

  function cancel() {
    if (cleaned) return;
    onCancel();
    if (!controller.signal.aborted) controller.abort();
    cleanup();
  }

  function close() {
    if (!response.writableEnded) cancel();
    cleanup();
  }

  request.once('aborted', cancel);
  response.once('close', close);
  response.once('finish', cleanup);
  if (request.aborted || response.destroyed) cancel();
  return cleanup;
}

async function readJsonBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new MnemosyneRequestError(
        'request_body_too_large',
        `Request body exceeds ${maxBodyBytes} bytes.`,
      );
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new MnemosyneRequestError(
      'request_json_invalid',
      'Request body must be valid JSON.',
      { cause: error.message },
    );
  }
}

function assertLocalAuthorization(request, proxyToken) {
  if (!proxyToken) return;

  if (request.headers.authorization !== `Bearer ${proxyToken}`) {
    const error = new MnemosyneRequestError(
      'proxy_authorization_failed',
      'Local Agent Proxy authorization failed.',
    );
    error.statusCode = 401;
    throw error;
  }
}

function assertContextAuthorization(request, contextAccessToken) {
  if (
    !contextAccessToken
    || request.headers['x-mnemosyne-session-token'] !== contextAccessToken
  ) {
    const error = new MnemosyneRequestError(
      'context_authorization_failed',
      'Private Mnemosyne context authorization failed.',
    );
    error.statusCode = 401;
    throw error;
  }
}

function copyResponseHeaders(upstream, response) {
  const contentType = upstream.headers.get('content-type');
  const cacheControl = upstream.headers.get('cache-control');
  if (contentType) response.setHeader('content-type', contentType);
  if (cacheControl) response.setHeader('cache-control', cacheControl);
  response.setHeader('x-content-type-options', 'nosniff');
}

function eventStreamData(block) {
  return block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n');
}

function takeCompleteEventStreamBlocks(source) {
  const blocks = [];
  let remainder = source;
  let delimiter = /\r?\n\r?\n/.exec(remainder);
  while (delimiter) {
    blocks.push(remainder.slice(0, delimiter.index));
    remainder = remainder.slice(delimiter.index + delimiter[0].length);
    delimiter = /\r?\n\r?\n/.exec(remainder);
  }
  return { blocks, remainder };
}

function hasTerminalFinishReason(data) {
  if (!data || data === '[DONE]') return false;
  try {
    const chunk = JSON.parse(data);
    return (chunk.choices ?? []).some(
      choice => choice?.finish_reason !== null
        && choice?.finish_reason !== undefined,
    );
  } catch {
    return false;
  }
}

async function readWithTerminalGrace(reader, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise(resolve => {
        timeout = setTimeout(
          () => resolve(STREAM_TERMINAL_GRACE_EXPIRED),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBufferedUpstreamResponse(upstream, {
  streamTerminalGraceMs,
}) {
  const contentType = String(upstream.headers.get('content-type') || '')
    .toLowerCase();
  if (!contentType.includes('text/event-stream') || !upstream.body) {
    return {
      responseText: await upstream.text(),
      streamTermination: 'body_end',
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let responseText = '';
  let eventBuffer = '';
  let terminalFinishSeen = false;
  try {
    while (true) {
      const readResult = terminalFinishSeen
        ? await readWithTerminalGrace(reader, streamTerminalGraceMs)
        : await reader.read();
      if (readResult === STREAM_TERMINAL_GRACE_EXPIRED) {
        await reader.cancel().catch(() => {});
        return {
          responseText,
          streamTermination: 'finish_reason',
        };
      }
      if (readResult.done) {
        responseText += decoder.decode();
        return {
          responseText,
          streamTermination: 'body_end',
        };
      }

      const text = decoder.decode(readResult.value, { stream: true });
      responseText += text;
      eventBuffer += text;
      const taken = takeCompleteEventStreamBlocks(eventBuffer);
      eventBuffer = taken.remainder;
      for (const block of taken.blocks) {
        const data = eventStreamData(block);
        if (data === '[DONE]') {
          await reader.cancel().catch(() => {});
          return {
            responseText,
            streamTermination: 'done_sentinel',
          };
        }
        if (hasTerminalFinishReason(data)) {
          terminalFinishSeen = true;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseOpenAiEventStream(source) {
  const toolCalls = new Map();
  let role = 'assistant';
  let content = '';
  let finishReason = null;
  let usage = null;
  let id;
  let model;

  for (const block of source.split(/\r?\n\r?\n/)) {
    const data = eventStreamData(block);
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch (error) {
      throw new MnemosyneRequestError(
        'static_lore_intake_stream_chunk_invalid',
        'Static Lore Intake upstream returned an invalid stream chunk.',
        { cause: error.message },
      );
    }
    if (chunk.error) {
      const upstreamError = new MnemosyneRequestError(
        'static_lore_intake_upstream_error',
        'Static Lore Intake upstream returned a streamed error.',
        {
          code: chunk.error.code ?? null,
          type: chunk.error.type ?? null,
        },
      );
      upstreamError.statusCode = 502;
      throw upstreamError;
    }
    id ??= chunk.id;
    model ??= chunk.model;
    usage = chunk.usage ?? usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    finishReason = choice.finish_reason ?? finishReason;
    const delta = choice.delta ?? {};
    role = delta.role ?? role;
    if (typeof delta.content === 'string') content += delta.content;
    for (const toolDelta of delta.tool_calls ?? []) {
      const index = Number(toolDelta.index ?? 0);
      const existing = toolCalls.get(index) ?? {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (toolDelta.id) existing.id = toolDelta.id;
      if (toolDelta.type) existing.type = toolDelta.type;
      if (toolDelta.function?.name) {
        existing.function.name += toolDelta.function.name;
      }
      if (toolDelta.function?.arguments) {
        existing.function.arguments += toolDelta.function.arguments;
      }
      toolCalls.set(index, existing);
    }
  }

  return {
    ...(id ? { id } : {}),
    ...(model ? { model } : {}),
    choices: [{
      index: 0,
      message: {
        role,
        content: content || null,
        tool_calls: [...toolCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, toolCall]) => toolCall),
      },
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  };
}

function parseBufferedModelResponse(responseText, contentType) {
  if (String(contentType || '').toLowerCase().includes('text/event-stream')) {
    return parseOpenAiEventStream(responseText);
  }
  try {
    return JSON.parse(responseText);
  } catch (error) {
    const invalidResponse = new MnemosyneRequestError(
      'static_lore_intake_upstream_json_invalid',
      'Static Lore Intake upstream returned invalid JSON.',
      { cause: error.message },
    );
    invalidResponse.statusCode = 502;
    throw invalidResponse;
  }
}

function createErrorBody(error, runId = null) {
  const known = error instanceof MnemosyneRequestError;
  return {
    error: {
      type: known ? 'mnemosyne_request_error' : 'mnemosyne_internal_error',
      reason_code: known ? error.reasonCode : 'internal_error',
      message: known ? error.message : 'The Agent Proxy could not complete the request.',
      details: known ? error.details ?? null : null,
      run_id: runId,
    },
  };
}

function normalizeMainHostBinding(binding) {
  if (!binding) return null;

  if (!String(binding.model || '').trim()) {
    throw new Error('mainHostBinding.model is required.');
  }

  return Object.freeze({
    schema: 'mnemosyne.upstream-model-binding.v1',
    model: String(binding.model),
    preset_policy: 'active_host_preset',
    verification: 'capability_probe_required',
  });
}

function normalizeRootRunAuditBinding(binding) {
  if (!binding) return null;
  const claims = binding.claims;
  const payload = {
    schema: binding.schema,
    claims,
  };
  if (
    binding.schema !== 'mnemosyne.root-run-audit-binding.v1'
    || !claims
    || typeof claims !== 'object'
    || Array.isArray(claims)
    || Object.keys(binding).length !== 3
    || !/^[a-f0-9]{64}$/.test(binding.binding_hash ?? '')
    || binding.binding_hash !== sha256(canonicalJson(payload))
  ) {
    throw new Error('rootRunAuditBinding is invalid.');
  }
  return Object.freeze(structuredClone(binding));
}

function hasExactKeys(value, expectedKeys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === expectedKeys.size
    && Object.keys(value).every(key => expectedKeys.has(key))
  );
}

function normalizeFreshIntakeAuthorityHealth(summary) {
  if (
    !hasExactKeys(summary, FRESH_INTAKE_AUTHORITY_HEALTH_KEYS)
    || summary.schema !== FRESH_INTAKE_AUTHORITY_GUARD_SCHEMA
    || summary.status !== 'ready'
    || ![
      'fresh',
      'intake_started',
      'store_initialized',
    ].includes(summary.phase)
    || ![
      summary.witness_hash,
      summary.chat_id_hash,
      summary.character_id_hash,
      summary.chat_save_root_hash,
      summary.host_chat_hash,
    ].every(value => HASH_PATTERN.test(value ?? ''))
    || (
      summary.state_hash !== null
      && !HASH_PATTERN.test(summary.state_hash ?? '')
    )
    || (summary.phase === 'fresh' && summary.state_hash !== null)
    || (summary.phase !== 'fresh' && summary.state_hash === null)
  ) {
    throw new Error('freshIntakeAdmissionGuard health summary is invalid.');
  }
  return Object.freeze(structuredClone(summary));
}

function unavailableFreshIntakeAuthorityHealth() {
  return {
    schema: FRESH_INTAKE_AUTHORITY_GUARD_SCHEMA,
    status: 'unavailable',
    witness_hash: null,
    phase: null,
    chat_id_hash: null,
    character_id_hash: null,
    chat_save_root_hash: null,
    host_chat_hash: null,
    state_hash: null,
  };
}

export function createRuntimeBudgetProfile({
  providerContextTokens,
  providerOutputReserveTokens,
  rootMaxToolSteps,
  memoryReadMaxTokens,
  maxRequestBodyBytes,
  staticLoreMaxInputBytes,
  staticLoreMaxOutputTokens,
  rootOverallTimeoutMs,
} = {}) {
  const values = [
    providerContextTokens,
    providerOutputReserveTokens,
    memoryReadMaxTokens,
    maxRequestBodyBytes,
    staticLoreMaxInputBytes,
    staticLoreMaxOutputTokens,
    rootOverallTimeoutMs,
  ];
  if (
    values.some(value => !Number.isSafeInteger(value) || value < 1)
    || !Number.isSafeInteger(rootMaxToolSteps)
    || rootMaxToolSteps < 2
    || providerOutputReserveTokens >= providerContextTokens
    || staticLoreMaxOutputTokens >= providerContextTokens
    || maxRequestBodyBytes <= staticLoreMaxInputBytes
  ) {
    throw new Error(
      'Runtime budget profile values must be safe integers that fit the provider context.',
    );
  }
  const payload = {
    schema: RUNTIME_BUDGET_PROFILE_SCHEMA,
    provider_context_tokens: providerContextTokens,
    provider_output_reserve_tokens: providerOutputReserveTokens,
    root_max_tool_steps: rootMaxToolSteps,
    memory_read_max_tokens: memoryReadMaxTokens,
    max_request_body_bytes: maxRequestBodyBytes,
    static_lore_max_input_bytes: staticLoreMaxInputBytes,
    static_lore_max_output_tokens: staticLoreMaxOutputTokens,
    root_overall_timeout_ms: rootOverallTimeoutMs,
  };
  return Object.freeze({
    ...payload,
    profile_hash: sha256(canonicalJson(payload)),
  });
}

function normalizeRuntimeBudgetProfile(profile) {
  if (!hasExactKeys(profile, RUNTIME_BUDGET_PROFILE_KEYS)) {
    throw new Error('runtimeBudgetProfile is invalid.');
  }
  const normalized = createRuntimeBudgetProfile({
    providerContextTokens: profile.provider_context_tokens,
    providerOutputReserveTokens: profile.provider_output_reserve_tokens,
    rootMaxToolSteps: profile.root_max_tool_steps,
    memoryReadMaxTokens: profile.memory_read_max_tokens,
    maxRequestBodyBytes: profile.max_request_body_bytes,
    staticLoreMaxInputBytes: profile.static_lore_max_input_bytes,
    staticLoreMaxOutputTokens: profile.static_lore_max_output_tokens,
    rootOverallTimeoutMs: profile.root_overall_timeout_ms,
  });
  if (canonicalJson(normalized) !== canonicalJson(profile)) {
    throw new Error('runtimeBudgetProfile is invalid.');
  }
  return normalized;
}

function unavailableRuntimeBudgetProfileHealth() {
  return {
    status: 'unavailable',
    schema: null,
    provider_context_tokens: null,
    provider_output_reserve_tokens: null,
    root_max_tool_steps: null,
    memory_read_max_tokens: null,
    max_request_body_bytes: null,
    static_lore_max_input_bytes: null,
    static_lore_max_output_tokens: null,
    root_overall_timeout_ms: null,
    profile_hash: null,
  };
}

function normalizeContinuityEvaluationProgram(program) {
  if (program === undefined || program === null) {
    return {
      program: null,
      protocol: null,
      runAttestation: null,
    };
  }
  if (
    typeof program.prepareFeedback !== 'function'
    || typeof program.applyFeedbackCommand !== 'function'
    || typeof program.buildEvidenceExport !== 'function'
    || program.protocol?.schema
      !== 'mnemosyne.continuity-evaluation-protocol.v1'
    || program.run_attestation?.schema
      !== 'mnemosyne.continuity-evaluation-run-attestation.v1'
  ) {
    throw new Error(
      'continuityEvaluationProgram must implement the evaluation interface.',
    );
  }
  return {
    program,
    protocol: Object.freeze(structuredClone(program.protocol)),
    runAttestation:
      Object.freeze(structuredClone(program.run_attestation)),
  };
}

function normalizeUserVisibleRunActivity(inspector) {
  if (inspector === undefined || inspector === null) return null;
  if (typeof inspector.inspect !== 'function') {
    throw new Error(
      'userVisibleRunActivity must implement inspect.',
    );
  }
  return inspector;
}

function continuityEvaluationUnavailable() {
  const error = new MnemosyneRequestError(
    'continuity_evaluation_unavailable',
    'Continuity Evaluation is unavailable.',
  );
  error.statusCode = 503;
  return error;
}

function userVisibleRunActivityUnavailable() {
  const error = new MnemosyneRequestError(
    'run_activity_unavailable',
    'User-visible Run Activity is unavailable.',
  );
  error.statusCode = 503;
  return error;
}

function assertExactEvaluationPrepareRequest(body) {
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.getPrototypeOf(body) !== Object.prototype
    || Object.keys(body).length !== 2
    || !Object.hasOwn(body, 'chat_id')
    || !Object.hasOwn(body, 'run_id')
  ) {
    throw new MnemosyneRequestError(
      'feedback_input_invalid',
      'Evaluation prepare accepts only chat_id and run_id.',
    );
  }
}

function assertExactRunActivityRequest(body) {
  const keys = (
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.getPrototypeOf(body) === Object.prototype
  )
    ? Object.keys(body)
    : [];
  if (
    ![1, 2].includes(keys.length)
    || !Object.hasOwn(body, 'chat_id')
    || keys.some(key => !['chat_id', 'limit'].includes(key))
  ) {
    throw new MnemosyneRequestError(
      'run_activity_input_invalid',
      'Run Activity accepts only chat_id and optional limit.',
    );
  }
}

function normalizeRootRunAcceptanceGuard(guard) {
  if (!guard) return null;
  if (
    !hasExactKeys(guard, ROOT_RUN_ACCEPTANCE_GUARD_KEYS)
    || !hasExactKeys(
      guard.claims,
      ROOT_RUN_ACCEPTANCE_GUARD_CLAIM_KEYS,
    )
  ) {
    throw new Error('rootRunAcceptanceGuard is invalid.');
  }

  const claims = guard.claims;
  const coordinates = [
    claims.branch_epoch,
    claims.visible_turn_index,
    claims.parent_turn_index,
    claims.memory_turn_index,
    claims.target_turn_index,
  ];
  const hashClaims = [
    claims.chat_id_hash,
    claims.host_history_binding_hash,
    claims.pending_message_body_hash,
    claims.acceptance_nonce_hash,
    claims.prepare_evidence_contract_hash,
  ];
  const {
    guard_hash: guardHash,
    ...payload
  } = guard;
  if (
    guard.schema !== ROOT_RUN_ACCEPTANCE_GUARD_SCHEMA
    || typeof claims.branch_id !== 'string'
    || claims.branch_id.length === 0
    || hashClaims.some(hash => !HASH_PATTERN.test(hash ?? ''))
    || coordinates.some(index => !Number.isInteger(index) || index < 0)
    || claims.parent_turn_index > claims.visible_turn_index
    || claims.memory_turn_index > claims.visible_turn_index
    || claims.target_turn_index < claims.visible_turn_index
    || typeof guard.acceptance_nonce !== 'string'
    || guard.acceptance_nonce.length === 0
    || guard.acceptance_nonce.length > 256
    || guard.acceptance_nonce !== guard.acceptance_nonce.trim()
    || /[\r\n]/.test(guard.acceptance_nonce)
    || sha256(guard.acceptance_nonce) !== claims.acceptance_nonce_hash
    || typeof guard.pending_message_body !== 'string'
    || guard.pending_message_body.length === 0
    || guard.pending_message_body.length > 64 * 1024
    || sha256(guard.pending_message_body)
      !== claims.pending_message_body_hash
    || countOccurrences(
      guard.pending_message_body,
      guard.acceptance_nonce,
    ) !== 1
    || !HASH_PATTERN.test(guardHash ?? '')
    || guardHash !== sha256(canonicalJson(payload))
  ) {
    throw new Error('rootRunAcceptanceGuard is invalid.');
  }
  return Object.freeze(structuredClone(guard));
}

function assertRootRunAcceptanceAuditLink({
  auditBinding,
  acceptanceGuard,
}) {
  const guardHashClaim =
    auditBinding?.claims?.root_run_acceptance_guard_hash;
  if (guardHashClaim === undefined) return;
  if (
    !HASH_PATTERN.test(guardHashClaim)
    || !acceptanceGuard
    || acceptanceGuard.guard_hash !== guardHashClaim
  ) {
    throw new Error(
      'rootRunAuditBinding requires the matching rootRunAcceptanceGuard.',
    );
  }
  const prepareEvidenceContractHash =
    auditBinding.claims.prepare_evidence_contract_hash;
  if (
    prepareEvidenceContractHash !== undefined
    && prepareEvidenceContractHash
      !== acceptanceGuard.claims.prepare_evidence_contract_hash
  ) {
    throw new Error(
      'rootRunAuditBinding does not match the acceptance guard preparation evidence.',
    );
  }
  const acceptanceNonceHash =
    auditBinding.claims.acceptance_nonce_hash;
  if (
    acceptanceNonceHash !== undefined
    && acceptanceNonceHash
      !== acceptanceGuard.claims.acceptance_nonce_hash
  ) {
    throw new Error(
      'rootRunAuditBinding does not match the acceptance guard nonce.',
    );
  }
}

function normalizeUpstreamAuthMode(mode) {
  const value = mode || 'configured';
  if (!['configured', 'passthrough'].includes(value)) {
    throw new Error(`Unsupported upstreamAuthMode: ${value}`);
  }
  return value;
}

function applyUpstreamAuthorization(headers, request, {
  upstreamAuthMode,
  upstreamApiKey,
}) {
  if (upstreamAuthMode === 'passthrough') {
    if (request.headers.authorization) {
      headers.authorization = request.headers.authorization;
    }
    return;
  }

  if (upstreamApiKey) {
    headers.authorization = `Bearer ${upstreamApiKey}`;
  }
}

function normalizeTimeout(value, fallback, label) {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return timeout;
}

function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return null;
  const effort = String(value);
  if (!['min', 'low', 'medium', 'high', 'max'].includes(effort)) {
    throw new Error(`Unsupported intakeReasoningEffort: ${effort}`);
  }
  return effort;
}

function rootRunScope(prepared) {
  const scope = prepared.runScope;
  const targetTurnIndex = Number.isInteger(scope.target_turn_index)
    ? scope.target_turn_index
    : scope.visible_turn_index;
  const turnIdentityHash = sha256(canonicalJson({
    chat_id: scope.chat_id,
    branch_id: 'main',
    branch_epoch: scope.branch_epoch,
    target_turn_index: targetTurnIndex,
  })).slice(0, 24);
  const candidateIdentityHash = sha256(canonicalJson({
    turn_identity_hash: turnIdentityHash,
    run_id: prepared.report.run_id,
    active_candidate_id: scope.active_candidate_id ?? null,
  })).slice(0, 24);
  return {
    chat_id: scope.chat_id,
    run_id: prepared.report.run_id,
    turn_id: `turn_${turnIdentityHash}`,
    candidate_id: `candidate_${candidateIdentityHash}`,
    turn_index: targetTurnIndex,
    memory_turn_index: Number.isInteger(scope.parent_turn_index)
      ? scope.parent_turn_index
      : Math.max(0, targetTurnIndex - 1),
    branch_id: 'main',
    branch_epoch: scope.branch_epoch,
    swipe_id: Number.isInteger(scope.active_swipe_id)
      ? scope.active_swipe_id
      : 0,
  };
}

function countOccurrences(source, needle) {
  if (typeof source !== 'string' || source.length === 0) return 0;
  return source.split(needle).length - 1;
}

function normalizeRootRunAcceptanceGuardState(record, acceptanceGuard) {
  const {
    state_hash: stateHash,
    ...payload
  } = record ?? {};
  const consumedAt = payload.consumed_at;
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || !hasExactKeys(record, ROOT_RUN_ACCEPTANCE_GUARD_STATE_KEYS)
    || payload.schema !== ROOT_RUN_ACCEPTANCE_GUARD_STATE_SCHEMA
    || payload.guard_hash !== acceptanceGuard?.guard_hash
    || !HASH_PATTERN.test(payload.run_id_hash ?? '')
    || !HASH_PATTERN.test(payload.prompt_spine_hash ?? '')
    || typeof consumedAt !== 'string'
    || Number.isNaN(Date.parse(consumedAt))
    || new Date(consumedAt).toISOString() !== consumedAt
    || !HASH_PATTERN.test(stateHash ?? '')
    || stateHash !== sha256(canonicalJson(payload))
  ) {
    throw new Error(
      'rootRunAcceptanceGuardState is invalid or belongs to another guard.',
    );
  }
  return Object.freeze(structuredClone(record));
}

function sealRootRunAcceptanceGuardState({
  guardHash,
  runId,
  promptSpineHash,
}) {
  const payload = {
    schema: ROOT_RUN_ACCEPTANCE_GUARD_STATE_SCHEMA,
    guard_hash: guardHash,
    run_id_hash: sha256(runId),
    prompt_spine_hash: promptSpineHash,
    consumed_at: new Date().toISOString(),
  };
  return {
    ...payload,
    state_hash: sha256(canonicalJson(payload)),
  };
}

function createRootRunAcceptanceGuardStateStore({
  acceptanceGuard,
  statePath,
}) {
  if (statePath !== null && statePath !== undefined) {
    if (!acceptanceGuard) {
      throw new Error(
        'rootRunAcceptanceGuardStatePath requires a rootRunAcceptanceGuard.',
      );
    }
    if (
      typeof statePath !== 'string'
      || statePath.length === 0
      || !path.isAbsolute(statePath)
      || !statSync(path.dirname(statePath)).isDirectory()
    ) {
      throw new Error(
        'rootRunAcceptanceGuardStatePath must name an absolute path in an existing directory.',
      );
    }
  }

  let consumed = null;
  if (statePath) {
    try {
      consumed = normalizeRootRunAcceptanceGuardState(
        JSON.parse(readFileSync(statePath, 'utf8')),
        acceptanceGuard,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return Object.freeze({
    consume({ runId, promptSpineHash }) {
      const matches = record => (
        record?.guard_hash === acceptanceGuard.guard_hash
        && record.run_id_hash === sha256(runId)
        && record.prompt_spine_hash === promptSpineHash
      );
      if (consumed) {
        if (matches(consumed)) return;
        throw new MnemosyneRequestError(
          'root_run_acceptance_guard_consumed',
          'The sealed root-run acceptance guard is locked to another run.',
        );
      }

      const next = sealRootRunAcceptanceGuardState({
        guardHash: acceptanceGuard.guard_hash,
        runId,
        promptSpineHash,
      });
      if (statePath) {
        try {
          writeFileSync(
            statePath,
            `${JSON.stringify(next, null, 2)}\n`,
            { encoding: 'utf8', flag: 'wx', mode: 0o600 },
          );
          consumed = Object.freeze(structuredClone(next));
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          consumed = normalizeRootRunAcceptanceGuardState(
            JSON.parse(readFileSync(statePath, 'utf8')),
            acceptanceGuard,
          );
          if (!matches(consumed)) {
            throw new MnemosyneRequestError(
              'root_run_acceptance_guard_consumed',
              'The sealed root-run acceptance guard is locked to another run.',
            );
          }
        }
      } else {
        consumed = Object.freeze(structuredClone(next));
      }
    },
  });
}

function consumeRootRunAcceptanceGuard(
  prepared,
  acceptanceGuard,
  guardStateStore,
) {
  if (!acceptanceGuard) return;

  const claims = acceptanceGuard.claims;
  const scope = rootRunScope(prepared);
  const binding = prepared.hostHistoryBinding;
  const mismatches = new Set();
  const compare = (field, actual, expected) => {
    if (actual !== expected) mismatches.add(field);
  };

  compare('chat_id_hash', sha256(scope.chat_id), claims.chat_id_hash);
  compare('branch_id', scope.branch_id, claims.branch_id);
  compare('branch_epoch', scope.branch_epoch, claims.branch_epoch);
  compare(
    'visible_turn_index',
    prepared.runScope.visible_turn_index,
    claims.visible_turn_index,
  );
  compare(
    'parent_turn_index',
    scope.memory_turn_index,
    claims.parent_turn_index,
  );
  compare(
    'memory_turn_index',
    scope.memory_turn_index,
    claims.memory_turn_index,
  );
  compare('target_turn_index', scope.turn_index, claims.target_turn_index);
  compare(
    'host_history_binding_hash',
    binding?.binding_hash,
    claims.host_history_binding_hash,
  );
  compare(
    'pending_message_body_hash',
    binding?.last_message_body_hash,
    claims.pending_message_body_hash,
  );

  compare(
    'host_history_binding.chat_id_hash',
    binding?.chat_id_hash,
    sha256(scope.chat_id),
  );
  compare(
    'host_history_binding.branch_id',
    binding?.branch_id,
    scope.branch_id,
  );
  compare(
    'host_history_binding.branch_epoch',
    binding?.branch_epoch,
    scope.branch_epoch,
  );
  compare(
    'host_history_binding.visible_turn_index',
    binding?.visible_turn_index,
    prepared.runScope.visible_turn_index,
  );
  compare(
    'host_history_binding.parent_turn_index',
    binding?.parent_turn_index,
    scope.memory_turn_index,
  );
  compare(
    'host_history_binding.target_turn_index',
    binding?.target_turn_index,
    scope.turn_index,
  );
  compare(
    'host_history_binding.last_message_index',
    binding?.last_message_index,
    prepared.runScope.visible_turn_index,
  );
  compare(
    'host_history_binding.last_message_role',
    binding?.last_message_role,
    'user',
  );

  const finalMessages = prepared.body.messages;
  const lastProviderUser = [...finalMessages]
    .reverse()
    .find(message => message?.role === 'user');
  const totalNonceOccurrences = finalMessages.reduce(
    (total, message) => (
      total
      + countOccurrences(
        typeof message?.content === 'string' ? message.content : '',
        acceptanceGuard.acceptance_nonce,
      )
    ),
    0,
  );
  if (
    totalNonceOccurrences !== 1
    || countOccurrences(
      lastProviderUser?.content,
      acceptanceGuard.acceptance_nonce,
    ) !== 1
  ) {
    mismatches.add('acceptance_nonce_occurrence');
  }
  const totalPendingBodyOccurrences = finalMessages.reduce(
    (total, message) => (
      total
      + countOccurrences(
        typeof message?.content === 'string' ? message.content : '',
        acceptanceGuard.pending_message_body,
      )
    ),
    0,
  );
  if (
    totalPendingBodyOccurrences !== 1
    || lastProviderUser?.content
      !== acceptanceGuard.pending_message_body
  ) {
    mismatches.add('pending_message_body');
  }

  if (mismatches.size > 0) {
    throw new MnemosyneRequestError(
      'root_run_acceptance_guard_mismatch',
      'Root run does not match the sealed acceptance guard.',
      { fields: [...mismatches].sort() },
    );
  }
  guardStateStore.consume({
    runId: prepared.report.run_id,
    promptSpineHash: prepared.promptSpine.hash,
  });
}

function writeRootTurnCompletion(response, outcome, { stream }) {
  const completionId = `chatcmpl-${outcome.run_id}`;
  if (stream) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    response.write(`data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      model: outcome.model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: outcome.final_body,
        },
        finish_reason: null,
      }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      model: outcome.model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    })}\n\n`);
    return response.end('data: [DONE]\n\n');
  }
  return json(response, 200, {
    id: completionId,
    object: 'chat.completion',
    model: outcome.model,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: outcome.final_body,
      },
    }],
    usage: {
      prompt_tokens: outcome.aggregate_usage.prompt_tokens,
      completion_tokens: outcome.aggregate_usage.completion_tokens,
      total_tokens:
        outcome.aggregate_usage.prompt_tokens
        + outcome.aggregate_usage.completion_tokens,
    },
  });
}

export function createMnemosyneProxy({
  upstreamBaseUrl,
  upstreamApiKey,
  upstreamAuthMode,
  upstreamModel,
  upstreamHeaders = {},
  proxyToken,
  contextAccessToken,
  mainHostBinding,
  contextMode = 'unavailable',
  continuityComposer,
  sourceRemovalGrantService,
  sourceCoverageRegistry,
  storySourceAdmission,
  staticLoreExtractionService,
  freshIntakeAdmissionGuard = null,
  historyLifecycleService,
  continuityEvaluationProgram = null,
  userVisibleRunActivity = null,
  dormantThreadInspection = null,
  intakeBodyTimeoutMs,
  intakeHeadersTimeoutMs,
  intakeOverallTimeoutMs,
  intakeStreamTerminalGraceMs,
  intakeReasoningEffort,
  rootRunOverallTimeoutMs,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  capabilityAdapters = {},
  sourceRemovalAuthorizer,
  runKernel,
  providerBudgetPolicy = null,
  runtimeBudgetProfile = null,
  rootRunAuditBinding = null,
  rootRunAcceptanceGuard = null,
  rootRunAcceptanceGuardStatePath = null,
  runtimeBuildIdentity = null,
  runtimeInstanceId = randomBytes(32).toString('base64url'),
  generationBindingHash = null,
  requireGenerationTransportBinding = Boolean(runtimeBuildIdentity),
  sqliteRuntimeHealth = null,
  auditExcludedPhrases = [],
  requireAuditExcludedPhrasesAbsent = false,
  onAudit = () => {},
} = {}) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error('maxBodyBytes must be a positive safe integer.');
  }
  if (typeof requireAuditExcludedPhrasesAbsent !== 'boolean') {
    throw new Error(
      'requireAuditExcludedPhrasesAbsent must be a boolean.',
    );
  }
  if (typeof requireGenerationTransportBinding !== 'boolean') {
    throw new Error(
      'requireGenerationTransportBinding must be a boolean.',
    );
  }
  if (
    requireAuditExcludedPhrasesAbsent
    && auditExcludedPhrases.length === 0
  ) {
    throw new Error(
      'Required prompt exclusion needs at least one audit phrase.',
    );
  }
  if (
    freshIntakeAdmissionGuard !== null
    && typeof freshIntakeAdmissionGuard?.healthSummary !== 'function'
  ) {
    throw new Error(
      'freshIntakeAdmissionGuard must implement healthSummary.',
    );
  }
  if (
    storySourceAdmission !== undefined
    && storySourceAdmission !== null
    && (
      typeof storySourceAdmission.prepareOnly !== 'function'
      || typeof storySourceAdmission.admitStory !== 'function'
    )
  ) {
    throw new Error(
      'storySourceAdmission must implement prepareOnly and admitStory.',
    );
  }
  const continuityEvaluation =
    normalizeContinuityEvaluationProgram(
      continuityEvaluationProgram,
    );
  const runActivity =
    normalizeUserVisibleRunActivity(userVisibleRunActivity);
  const dormantThreads =
    normalizeUserVisibleRunActivity(dormantThreadInspection);
  const capabilities = createCapabilityRegistry(capabilityAdapters);
  const verifiedMainHostBinding = normalizeMainHostBinding(mainHostBinding);
  const verifiedRootRunAuditBinding =
    normalizeRootRunAuditBinding(rootRunAuditBinding);
  const verifiedRootRunAcceptanceGuard =
    normalizeRootRunAcceptanceGuard(rootRunAcceptanceGuard);
  const verifiedProviderBudgetPolicy =
    providerBudgetPolicy === null
      ? null
      : normalizeProviderBudgetPolicy(providerBudgetPolicy);
  const verifiedRuntimeBudgetProfile =
    runtimeBudgetProfile === null
      ? null
      : normalizeRuntimeBudgetProfile(runtimeBudgetProfile);
  if (
    verifiedRuntimeBudgetProfile
    && (
      !verifiedProviderBudgetPolicy
      || verifiedRuntimeBudgetProfile.provider_context_tokens
        !== verifiedProviderBudgetPolicy.configured_context_tokens
      || verifiedRuntimeBudgetProfile.provider_output_reserve_tokens
        !== verifiedProviderBudgetPolicy.output_reserve_tokens
      || verifiedRuntimeBudgetProfile.max_request_body_bytes
        !== maxBodyBytes
    )
  ) {
    throw new Error(
      'runtimeBudgetProfile does not match providerBudgetPolicy.',
    );
  }
  const rootRunAcceptanceGuardStateStore =
    createRootRunAcceptanceGuardStateStore({
      acceptanceGuard: verifiedRootRunAcceptanceGuard,
      statePath: rootRunAcceptanceGuardStatePath,
    });
  assertRootRunAcceptanceAuditLink({
    auditBinding: verifiedRootRunAuditBinding,
    acceptanceGuard: verifiedRootRunAcceptanceGuard,
  });
  const resolvedUpstreamAuthMode = normalizeUpstreamAuthMode(upstreamAuthMode);
  const resolvedGenerationBindingHash = generationBindingHash ?? sha256(
    canonicalJson({
      schema: 'mnemosyne.generation-endpoint-binding.v1',
      protocol_version: RUNTIME_SUPPORTED_PROTOCOLS[0],
      upstream_endpoint_hash: upstreamBaseUrl
        ? sha256(upstreamBaseUrl.replace(/\/+$/, ''))
        : null,
      upstream_model: upstreamModel ?? null,
      upstream_auth_mode: resolvedUpstreamAuthMode,
      provider_budget_policy_hash:
        verifiedProviderBudgetPolicy?.policy_hash ?? null,
    }),
  );
  const operationRegistryHash = sha256(operationRegistryCanonicalJson({
    includeEvaluation: Boolean(continuityEvaluation.program),
  }));
  const runtimeBuildId = runtimeBuildIdentity?.runtimeBuildId ?? null;
  function intakeControlBinding(request, executionLease = null) {
    const leasedAdapterId = executionLease?.adapter_id;
    const leasedBridgeVersion = executionLease?.bridge_version;
    const adapterId = leasedAdapterId ?? request?.headers?.[
      'x-mnemosyne-control-adapter'
    ] ?? 'loopback';
    const bridgeVersion = leasedBridgeVersion ?? request?.headers?.[
      'x-mnemosyne-bridge-version'
    ] ?? 'loopback';
    if (
      !['bridge', 'loopback'].includes(adapterId)
      || typeof bridgeVersion !== 'string'
      || !bridgeVersion
    ) {
      throw new MnemosyneRequestError(
        'intake_control_binding_invalid',
        'Static Lore Intake control binding is invalid.',
      );
    }
    return { adapterId, bridgeVersion };
  }
  async function attachIntakeCapability(
    result,
    request,
    executionLease = null,
  ) {
    if (
      result?.status !== 'prepared'
      || typeof result.request_id !== 'string'
      || typeof staticLoreExtractionService?.issueIntakeCapability
        !== 'function'
    ) {
      return result;
    }
    const controlBinding = intakeControlBinding(request, executionLease);
    const capability =
      await staticLoreExtractionService.issueIntakeCapability({
        requestId: result.request_id,
        runtimeInstanceId,
        protocolVersion: RUNTIME_SUPPORTED_PROTOCOLS[0],
        generationBindingHash: resolvedGenerationBindingHash,
        runtimeBuildId: runtimeBuildId ?? 'development-unsealed',
        operationRegistryHash,
        controlAdapterId: controlBinding.adapterId,
        bridgeVersion: controlBinding.bridgeVersion,
      });
    return {
      ...result,
      intake_capability: capability.token,
      intake_execution_lease: {
        schema: 'mnemosyne.intake-execution-lease.v1',
        audience: capability.audience,
        request_id: capability.request_id,
        chat_id: capability.chat_id,
        session_id: capability.session_id,
        snapshot_id: capability.snapshot_id,
        batch_index: capability.batch_index,
        attempt: capability.attempt,
        model_request_hash: capability.model_request_hash,
        adapter_id: capability.adapter_id,
        bridge_version: capability.bridge_version,
        protocol_version: capability.protocol_version,
        runtime_build_id: capability.runtime_build_id,
        runtime_instance_id: capability.runtime_instance_id,
        generation_binding_hash:
          capability.generation_binding_hash,
        operation_registry_hash:
          capability.operation_registry_hash,
        resolved_at: capability.resolved_at,
        expires_at: capability.expires_at,
      },
    };
  }

  async function attachNestedIntakeCapability(
    result,
    request,
    executionLease = null,
  ) {
    if (result?.next_batch?.status !== 'prepared') return result;
    return {
      ...result,
      next_batch: await attachIntakeCapability(
        result.next_batch,
        request,
        executionLease,
      ),
    };
  }
  const resolvedIntakeBodyTimeoutMs = normalizeTimeout(
    intakeBodyTimeoutMs,
    DEFAULT_INTAKE_BODY_TIMEOUT_MS,
    'intakeBodyTimeoutMs',
  );
  const resolvedIntakeHeadersTimeoutMs = normalizeTimeout(
    intakeHeadersTimeoutMs,
    DEFAULT_INTAKE_HEADERS_TIMEOUT_MS,
    'intakeHeadersTimeoutMs',
  );
  const resolvedIntakeOverallTimeoutMs = normalizeTimeout(
    intakeOverallTimeoutMs,
    DEFAULT_INTAKE_OVERALL_TIMEOUT_MS,
    'intakeOverallTimeoutMs',
  );
  const resolvedIntakeStreamTerminalGraceMs = normalizeTimeout(
    intakeStreamTerminalGraceMs,
    DEFAULT_INTAKE_STREAM_TERMINAL_GRACE_MS,
    'intakeStreamTerminalGraceMs',
  );
  const resolvedIntakeReasoningEffort = normalizeReasoningEffort(
    intakeReasoningEffort,
  );
  const resolvedRootRunOverallTimeoutMs = normalizeTimeout(
    rootRunOverallTimeoutMs,
    DEFAULT_ROOT_RUN_OVERALL_TIMEOUT_MS,
    'rootRunOverallTimeoutMs',
  );
  const intakeDispatcher = new Agent({
    bodyTimeout: resolvedIntakeBodyTimeoutMs,
    headersTimeout: resolvedIntakeHeadersTimeoutMs,
  });
  if (resolvedUpstreamAuthMode === 'passthrough' && proxyToken) {
    throw new Error('proxyToken cannot share Authorization with passthrough upstream auth.');
  }
  if (contextMode === 'production' && !contextAccessToken) {
    throw new Error('Production context mode requires contextAccessToken.');
  }
  const verifySourceRemoval = sourceRemovalAuthorizer
    ?? (sourceRemovalGrantService
      ? (grant, evidence) => sourceRemovalGrantService.verify(grant, evidence)
      : undefined);
  let listenUrl = null;

  const server = http.createServer(async (request, response) => {
    let requestBody = null;
    let requestCancelled = false;

    try {
      response.setHeader(
        'x-mnemosyne-runtime-instance-id',
        runtimeInstanceId,
      );
      response.setHeader(
        'x-mnemosyne-runtime-build-id',
        runtimeBuildId ?? 'unavailable',
      );
      response.setHeader(
        'x-mnemosyne-protocol-version',
        RUNTIME_SUPPORTED_PROTOCOLS[0],
      );
      applyLoopbackCors(request, response);
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        return response.end();
      }

      const requestUrl = new URL(request.url, 'http://mnemosyne.local');

      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        const freshIntakeAuthority = freshIntakeAdmissionGuard
          ? normalizeFreshIntakeAuthorityHealth(
              await freshIntakeAdmissionGuard.healthSummary(),
            )
          : unavailableFreshIntakeAuthorityHealth();
        return json(response, 200, {
          status: 'ok',
          service: 'tavern-mnemosyne-agent-proxy',
          schema: 'mnemosyne.health.v1',
          supported_protocols: [...RUNTIME_SUPPORTED_PROTOCOLS],
          runtime_instance_id: runtimeInstanceId,
          generation_binding_hash: resolvedGenerationBindingHash,
          operation_registry_hash: operationRegistryHash,
          storage_status: sqliteRuntimeHealth ? 'ready' : 'unknown',
          upstream_status: upstreamBaseUrl
            ? 'configured'
            : 'unconfigured',
          upstream_reachable: 'unknown',
          runtime_build: runtimeBuildIdentity
            ? {
                status: 'ready',
                id: runtimeBuildIdentity.runtimeBuildId ?? null,
                source: runtimeBuildIdentity.runtimeBuildIdSource ?? null,
              }
            : {
                status: 'unavailable',
                id: null,
                source: null,
              },
          sqlite_runtime: sqliteRuntimeHealth
            ? {
                status: 'ready',
                ...sqliteRuntimeHealth,
              }
            : {
                status: 'unavailable',
                sqlite_version: null,
                sqlite_source_id: null,
                wal_mode: null,
                wal_round_trip: null,
                probe: null,
              },
          upstream_configured: Boolean(upstreamBaseUrl),
          main_host_binding: verifiedMainHostBinding,
          provider_budget_policy: verifiedProviderBudgetPolicy
            ? {
                status: 'ready',
                ...verifiedProviderBudgetPolicy,
              }
            : {
                status: 'unavailable',
                schema: null,
                configured_context_tokens: null,
                output_reserve_tokens: null,
                provider_input_tokens: null,
                tokenizer_profile: null,
                request_safety_tokens: null,
                policy_hash: null,
              },
          root_turn_runtime: runKernel
            ? {
                status: 'ready',
                capability_version:
                  runKernel.capability_version ?? null,
                max_tool_steps:
                  Number.isInteger(runKernel.max_tool_steps)
                    ? runKernel.max_tool_steps
                    : null,
                overall_timeout_ms:
                  resolvedRootRunOverallTimeoutMs,
                prompt_exclusion_phrase_hashes:
                  auditExcludedPhrases.map(phrase => sha256(phrase)),
                prompt_exclusion_policy:
                  requireAuditExcludedPhrasesAbsent
                    ? 'require_absent'
                    : 'audit_only',
                audit_binding_hash:
                  verifiedRootRunAuditBinding?.binding_hash ?? null,
                acceptance_guard_hash:
                  verifiedRootRunAcceptanceGuard?.guard_hash ?? null,
              }
            : {
                status: 'unavailable',
                capability_version: null,
                max_tool_steps: null,
                overall_timeout_ms: null,
                prompt_exclusion_phrase_hashes: [],
                prompt_exclusion_policy: 'unavailable',
                audit_binding_hash: null,
                acceptance_guard_hash: null,
              },
          intake_transport: {
            body_timeout_ms: resolvedIntakeBodyTimeoutMs,
            headers_timeout_ms: resolvedIntakeHeadersTimeoutMs,
            overall_timeout_ms: resolvedIntakeOverallTimeoutMs,
            stream_terminal_grace_ms:
              resolvedIntakeStreamTerminalGraceMs,
            reasoning_effort: resolvedIntakeReasoningEffort,
            retry_policy: 'none',
          },
          fresh_intake_authority: freshIntakeAuthority,
          runtime_budget_profile: verifiedRuntimeBudgetProfile
            ? {
                status: 'ready',
                ...verifiedRuntimeBudgetProfile,
              }
            : unavailableRuntimeBudgetProfileHealth(),
          continuity_evaluation: continuityEvaluation.program
            ? {
                status: 'ready',
                protocol:
                  structuredClone(continuityEvaluation.protocol),
                run_attestation:
                  structuredClone(
                    continuityEvaluation.runAttestation,
                  ),
              }
            : {
                status: 'unavailable',
                protocol: null,
                run_attestation: null,
              },
          run_activity: runActivity
            ? {
                status: 'ready',
                schema:
                  'mnemosyne.user-visible-run-activity-list.v1',
                max_entries: 50,
                includes_story_content: false,
              }
            : {
                status: 'unavailable',
                schema: null,
                max_entries: 0,
                includes_story_content: false,
              },
        });
      }

      if (
        request.method === 'GET'
        && requestUrl.pathname === '/v1/mnemosyne/capabilities'
      ) {
        return json(response, 200, {
          schema: 'mnemosyne.capabilities.v1',
          capabilities: listCapabilities(capabilities),
        });
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname
          === '/v1/mnemosyne/activity/inspect'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!runActivity) {
          throw userVisibleRunActivityUnavailable();
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        assertExactRunActivityRequest(requestBody);
        const result = await runActivity.inspect({
          chatId: requestBody.chat_id,
          limit: requestBody.limit ?? 20,
        });
        onAudit({
          event: 'user_visible_run_activity_inspected',
          status: 'ready',
          entry_count: Array.isArray(result?.entries)
            ? result.entries.length
            : 0,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname
          === '/v1/mnemosyne/activity/dormant-threads'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!dormantThreads) {
          throw userVisibleRunActivityUnavailable();
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        if (
          !requestBody
          || typeof requestBody !== 'object'
          || Array.isArray(requestBody)
          || Object.getPrototypeOf(requestBody) !== Object.prototype
          || Object.keys(requestBody).length !== 1
          || !Object.hasOwn(requestBody, 'chat_id')
        ) {
          throw new MnemosyneRequestError(
            'dormant_threads_input_invalid',
            'Dormant thread inspection accepts only chat_id.',
          );
        }
        const result = await dormantThreads.inspect({
          chatId: requestBody.chat_id,
        });
        onAudit({
          event: 'dormant_threads_inspected',
          status: 'ready',
          thread_count: Array.isArray(result?.threads)
            ? result.threads.length
            : 0,
        });
        return json(response, 200, result);
      }

      const continuityEvaluationRoute = (
        request.method === 'POST'
        && [
          '/v1/mnemosyne/evaluation/prepare',
          '/v1/mnemosyne/evaluation/feedback',
          '/v1/mnemosyne/evaluation/export',
        ].includes(requestUrl.pathname)
      );
      if (continuityEvaluationRoute) {
        assertContextAuthorization(request, contextAccessToken);
        if (!continuityEvaluation.program) {
          throw continuityEvaluationUnavailable();
        }
        requestBody = await readJsonBody(request, maxBodyBytes);

        if (
          requestUrl.pathname
            === '/v1/mnemosyne/evaluation/prepare'
        ) {
          assertExactEvaluationPrepareRequest(requestBody);
          const result =
            await continuityEvaluation.program.prepareFeedback({
              chatId: requestBody.chat_id,
              runId: requestBody.run_id,
            });
          onAudit({
            event: 'continuity_evaluation_prepared',
            case_id: result.case_id,
            status: result.status,
          });
          return json(response, 200, result);
        }

        if (
          requestUrl.pathname
            === '/v1/mnemosyne/evaluation/feedback'
        ) {
          const result =
            await continuityEvaluation.program
              .applyFeedbackCommand(requestBody);
          onAudit({
            event: 'continuity_feedback_recorded',
            action: result.action,
            case_id: result.case_id,
            feedback_id: result.feedback_id,
            status: result.status,
          });
          return json(response, 200, result);
        }

        const result =
          await continuityEvaluation.program
            .buildEvidenceExport(requestBody);
        onAudit({
          event: 'continuity_evidence_exported',
          export_id: requestBody.export_id,
          status: 'ready',
          record_count: Array.isArray(result.records)
            ? result.records.length
            : 0,
          logically_withdrawn_count: Number(
            result.aggregate_exclusions
              ?.logically_withdrawn_count
            ?? 0,
          ),
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname
          === '/v1/mnemosyne/prompt-prepare-probe/chat/completions'
      ) {
        assertLocalAuthorization(request, proxyToken);
        requestBody = await readJsonBody(request, maxBodyBytes);
        const prepared = await prepareUpstreamRequest(requestBody, {
          verifyRemovalAuthorization: verifySourceRemoval,
          auditExcludedPhrases,
          measureContinuityPayloadTokens: countOpenAiTokens,
        });
        assertProviderBudgetMatchesPolicy({
          providerBudget: prepared.providerBudget,
          providerPolicy: verifiedProviderBudgetPolicy,
          runId: prepared.report.run_id,
        });
        if (requireAuditExcludedPhrasesAbsent) {
          const rejected = prepared.report.prompt_exclusion_witnesses
            .filter(witness => witness.status !== 'absent');
          if (
            prepared.report.prompt_exclusion_witnesses.length
              !== auditExcludedPhrases.length
            || rejected.length > 0
          ) {
            throw new MnemosyneRequestError(
              'prompt_exclusion_phrase_present',
              'A required outside-prompt fact is present in the provider request.',
              {
                rejected: rejected.map(witness => ({
                  phrase_hash: witness.phrase_hash,
                  present_provider_indices:
                    witness.present_provider_indices,
                })),
              },
            );
          }
        }
        const result = {
          schema: 'mnemosyne.prompt-prepare-probe-result.v1',
          status: 'pass',
          run_id: prepared.report.run_id,
          verified_message_count:
            prepared.report.verified_message_count,
          retained_message_count:
            prepared.report.retained_message_count,
          prompt_spine_hash: prepared.promptSpine.hash,
          provider_budget_policy_hash:
            verifiedProviderBudgetPolicy.policy_hash,
        };
        onAudit({
          event: 'prompt_prepare_probe_passed',
          run_id: result.run_id,
          prompt_spine_hash: result.prompt_spine_hash,
          verified_message_count: result.verified_message_count,
          retained_message_count: result.retained_message_count,
          provider_budget_policy_hash:
            result.provider_budget_policy_hash,
        });
        return json(response, 200, {
          id: `mnemosyne-prepare-probe-${result.run_id}`,
          object: 'chat.completion',
          model: 'mnemosyne-host-contract-probe',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'PROMPT_FORWARDING_OK',
            },
          }],
          mnemosyne_prompt_prepare: result,
        });
      }

      if (requestUrl.pathname.startsWith('/v1/mnemosyne/context/')) {
        const chatId = decodeURIComponent(
          requestUrl.pathname.slice('/v1/mnemosyne/context/'.length),
        );
        if (!chatId) {
          throw new MnemosyneRequestError(
            'chat_id_missing',
            'A chat id is required for Continuity Payload lookup.',
          );
        }
        if (
          request.method === 'GET'
          && requestUrl.searchParams.get('mode') === 'contract-probe'
        ) {
          return json(response, 200, await getContextResponse({
            mode: 'contract-probe',
            chatId,
            request: {},
            continuityComposer: null,
            sourceRemovalGrantService: null,
            sourceCoverageRegistry: null,
          }));
        }
        if (contextMode === 'production') {
          if (request.method !== 'POST') {
            return json(response, 405, {
              error: {
                type: 'mnemosyne_request_error',
                reason_code: 'method_not_allowed',
                message: 'Production context lookup requires POST.',
              },
            });
          }
          assertContextAuthorization(request, contextAccessToken);
          requestBody = await readJsonBody(request, maxBodyBytes);
        } else if (request.method !== 'GET') {
          return json(response, 405, {
            error: {
              type: 'mnemosyne_request_error',
              reason_code: 'method_not_allowed',
              message: 'Context probe lookup requires GET.',
            },
          });
        }
        return json(response, 200, await getContextResponse({
          mode: contextMode,
          chatId,
          request: requestBody ?? {},
          continuityComposer,
          sourceRemovalGrantService,
          sourceCoverageRegistry,
        }));
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/source-removal-grants'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!sourceRemovalGrantService) {
          throw new MnemosyneRequestError(
            'source_removal_grant_service_unavailable',
            'Source-removal grant service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await sourceRemovalGrantService.issue({
          chatId: requestBody.chat_id,
          runId: requestBody.run_id,
          runScope: requestBody.run_scope,
          sources: requestBody.sources,
          promptFingerprints: requestBody.prompt_fingerprints,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/history/inspect'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!historyLifecycleService?.inspectGovernedHistory) {
          throw new MnemosyneRequestError(
            'history_inspection_unavailable',
            'Governed history inspection is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result =
          await historyLifecycleService.inspectGovernedHistory({
            chatId: requestBody.chat_id,
            branchId: requestBody.branch_id ?? 'main',
          });
        onAudit({
          event: 'governed_history_inspected',
          chat_id: requestBody.chat_id,
          has_governed_history:
            result.has_governed_history,
          committed_turn_count:
            result.committed_turn_count,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/history/truncate'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!historyLifecycleService?.truncateBranch) {
          throw new MnemosyneRequestError(
            'history_lifecycle_service_unavailable',
            'History lifecycle service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await historyLifecycleService.truncateBranch({
          commandId: requestBody.command_id,
          chatId: requestBody.chat_id,
          branchId: requestBody.branch_id ?? 'main',
          expectedBranchEpoch: requestBody.expected_branch_epoch,
          cutoffTurnIndex: requestBody.cutoff_turn_index,
          reasonCode: requestBody.reason_code,
        });
        onAudit({
          event: 'history_branch_truncated',
          command_id: requestBody.command_id,
          chat_id: requestBody.chat_id,
          new_branch_epoch: result.new_branch_epoch,
          cutoff_turn_index: requestBody.cutoff_turn_index,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/history/restore-branch'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!historyLifecycleService?.restoreBranch) {
          throw new MnemosyneRequestError(
            'history_lifecycle_service_unavailable',
            'History lifecycle service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await historyLifecycleService.restoreBranch({
          commandId: requestBody.command_id,
          chatId: requestBody.chat_id,
          branchId: requestBody.branch_id ?? 'main',
          expectedBranchEpoch: requestBody.expected_branch_epoch,
          sourceBranchEpoch: requestBody.source_branch_epoch,
          throughTurnIndex: requestBody.through_turn_index,
          reasonCode: requestBody.reason_code,
        });
        onAudit({
          event: 'history_branch_restored',
          command_id: requestBody.command_id,
          chat_id: requestBody.chat_id,
          previous_branch_epoch: result.previous_branch_epoch,
          source_branch_epoch: result.source_branch_epoch,
          new_branch_epoch: result.new_branch_epoch,
          inherited_through_turn_index:
            result.inherited_through_turn_index,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/history/activate-swipe'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!historyLifecycleService?.activateSwipe) {
          throw new MnemosyneRequestError(
            'history_lifecycle_service_unavailable',
            'History lifecycle service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await historyLifecycleService.activateSwipe({
          commandId: requestBody.command_id,
          chatId: requestBody.chat_id,
          branchId: requestBody.branch_id ?? 'main',
          branchEpoch: requestBody.branch_epoch,
          turnIndex: requestBody.turn_index,
          swipeId: requestBody.swipe_id,
          throughTurnIndex: requestBody.through_turn_index,
        });
        onAudit({
          event: 'history_swipe_activated',
          command_id: requestBody.command_id,
          chat_id: requestBody.chat_id,
          turn_index: requestBody.turn_index,
          candidate_id: result.candidate_id,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/history/delete-swipe'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!historyLifecycleService?.deleteSwipe) {
          throw new MnemosyneRequestError(
            'history_lifecycle_service_unavailable',
            'History lifecycle service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await historyLifecycleService.deleteSwipe({
          commandId: requestBody.command_id,
          chatId: requestBody.chat_id,
          branchId: requestBody.branch_id ?? 'main',
          branchEpoch: requestBody.branch_epoch,
          turnIndex: requestBody.turn_index,
          deletedSwipeId: requestBody.deleted_swipe_id,
          fallbackSwipeId: requestBody.fallback_swipe_id ?? null,
          throughTurnIndex: requestBody.through_turn_index,
        });
        onAudit({
          event: 'history_swipe_deleted',
          command_id: requestBody.command_id,
          chat_id: requestBody.chat_id,
          turn_index: requestBody.turn_index,
          deleted_candidate_id: result.deleted_candidate_id,
          active_candidate_id: result.active_candidate_id,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/upstream-readiness'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        await readJsonBody(request, maxBodyBytes);
        if (!upstreamBaseUrl) {
          throw new MnemosyneRequestError(
            'upstream_not_configured',
            'The main upstream API profile is not configured.',
          );
        }
        const headers = { accept: 'application/json', ...upstreamHeaders };
        applyUpstreamAuthorization(headers, request, {
          upstreamAuthMode: resolvedUpstreamAuthMode,
          upstreamApiKey,
        });
        let upstream;
        try {
          upstream = await undiciFetch(
            `${upstreamBaseUrl.replace(/\/+$/, '')}/models`,
            {
              method: 'GET',
              headers,
              redirect: 'manual',
              dispatcher: intakeDispatcher,
              signal: AbortSignal.timeout(UPSTREAM_READINESS_TIMEOUT_MS),
            },
          );
        } catch (error) {
          onAudit({
            event: 'upstream_readiness_failed',
            upstream_status: null,
            reason_code: 'upstream_deployment_unreachable',
          });
          return json(response, 503, {
            schema: 'mnemosyne.upstream-readiness.v1',
            status: 'unavailable',
            reason_code: 'upstream_deployment_unreachable',
            upstream_status: null,
          });
        }
        await upstream.body?.cancel();
        const unavailable = (
          upstream.status >= 500
          || [408, 425, 429].includes(upstream.status)
        );
        const result = {
          schema: 'mnemosyne.upstream-readiness.v1',
          status: unavailable ? 'unavailable' : 'ready',
          reason_code: unavailable
            ? 'upstream_deployment_unavailable'
            : null,
          upstream_status: upstream.status,
        };
        onAudit({
          event: 'upstream_readiness_checked',
          upstream_status: upstream.status,
          readiness_status: result.status,
        });
        return json(response, unavailable ? 503 : 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/prepare'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService.prepare({
          chatId: requestBody.chat_id,
          characterId: requestBody.character_id,
          hostBinding: requestBody.host_binding,
          sources: requestBody.sources,
        });
        return json(
          response,
          200,
          await attachIntakeCapability(result, request),
        );
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/reconcile/confirm'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService.confirmReconcile({
          chatId: requestBody.chat_id,
          snapshotId: requestBody.snapshot_id,
          sessionId: requestBody.session_id,
          planId: requestBody.plan_id,
        });
        return json(
          response,
          200,
          await attachNestedIntakeCapability(result, request),
        );
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/recover'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService
          .recoverLatestFailedArtifact({
            chatId: requestBody.chat_id,
            snapshotId: requestBody.snapshot_id,
            sessionId: requestBody.session_id,
          });
        onAudit({
          event: 'static_lore_intake_artifact_recovery_checked',
          session_id: result.session_id,
          batch_index:
            result.completed_batch_index
            ?? result.batch_index
            ?? null,
          recovery_status: result.status,
          recovery_candidate_count:
            result.recovery_candidate_count ?? 0,
          recovered_request_id:
            result.recovered_request_id ?? null,
        });
        return json(
          response,
          200,
          await attachNestedIntakeCapability(result, request),
        );
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/replay'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService.replayArtifact({
          chatId: requestBody.chat_id,
          requestId: requestBody.request_id,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/rebase'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService
          .rebaseCompatibleArtifacts({
            chatId: requestBody.chat_id,
            sourceSnapshotId: requestBody.source_snapshot_id,
            targetSnapshotId: requestBody.target_snapshot_id,
            targetSessionId: requestBody.target_session_id,
          });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/abandon'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService.abandonInterruptedAttempt({
          chatId: requestBody.chat_id,
          snapshotId: requestBody.snapshot_id,
          sessionId: requestBody.session_id,
          requestId: requestBody.request_id,
          reasonCode: requestBody.reason_code,
          statusCode: requestBody.upstream_status,
          responseStarted: requestBody.response_started,
          startedAt: requestBody.started_at,
        });
        onAudit({
          event: 'static_lore_intake_transport_abandoned',
          request_id: requestBody.request_id,
          reason_code: result.failure_reason_code,
          retry_policy: 'none',
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/retry'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService.prepareRetry({
          chatId: requestBody.chat_id,
          snapshotId: requestBody.snapshot_id,
          sessionId: requestBody.session_id,
        });
        return json(
          response,
          200,
          await attachIntakeCapability(result, request),
        );
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/reprocess'
      ) {
        assertContextAuthorization(request, contextAccessToken);
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const result = await staticLoreExtractionService.reprocessFromBatch({
          chatId: requestBody.chat_id,
          snapshotId: requestBody.snapshot_id,
          sessionId: requestBody.session_id,
          fromBatchIndex: requestBody.from_batch_index,
          reasonCode: requestBody.reason_code,
        });
        onAudit({
          event: 'static_lore_intake_reprocess_prepared',
          session_id: result.session_id,
          from_batch_index: result.reprocessed_from_batch,
          invalidated_attempt_count: result.invalidated_attempt_count,
          reason_code: requestBody.reason_code,
        });
        return json(response, 200, result);
      }

      if (
        request.method === 'POST'
        && requestUrl.pathname === '/v1/mnemosyne/intake/chat/completions'
      ) {
        if (!staticLoreExtractionService) {
          throw new MnemosyneRequestError(
            'static_lore_intake_unavailable',
            'Static Lore Intake service is unavailable.',
          );
        }
        if (!upstreamBaseUrl) {
          throw new MnemosyneRequestError(
            'upstream_not_configured',
            'The main upstream API profile is not configured.',
          );
        }
        requestBody = await readJsonBody(request, maxBodyBytes);
        const requestId = requestBody.mnemosyne_intake_request_id;
        const intakeCapability =
          request.headers['x-mnemosyne-intake-capability'];
        let capabilityClaim = null;
        const usesIntakeCapability = (
          typeof intakeCapability === 'string'
          && intakeCapability
          && typeof staticLoreExtractionService.claimIntakeCapability
            === 'function'
        );
        if (!usesIntakeCapability) {
          assertContextAuthorization(request, contextAccessToken);
        }
        const intakeRequestBody = { ...requestBody };
        delete intakeRequestBody.mnemosyne_intake_execution_lease;
        const verifiedBody = staticLoreExtractionService.verifyPreparedModelRequest({
          requestId,
          requestBody: intakeRequestBody,
        });
        const upstreamBody = upstreamModel
          ? {
            ...verifiedBody,
            model: upstreamModel,
            stream: true,
            stream_options: { include_usage: true },
            ...(resolvedIntakeReasoningEffort
              ? { reasoning_effort: resolvedIntakeReasoningEffort }
              : {}),
          }
          : {
            ...verifiedBody,
            stream: true,
            stream_options: { include_usage: true },
            ...(resolvedIntakeReasoningEffort
              ? { reasoning_effort: resolvedIntakeReasoningEffort }
              : {}),
          };
        if (!verifiedProviderBudgetPolicy) {
          throw new MnemosyneRequestError(
            'provider_budget_policy_unavailable',
            'Static Lore Intake requires the server provider budget policy.',
          );
        }
        const intakeRunId = `intake:${requestId}`;
        const intakeProviderBudget = createProviderBudgetBinding({
          runId: intakeRunId,
          contextTokens:
            verifiedProviderBudgetPolicy.configured_context_tokens,
          outputReserveTokens: upstreamBody.max_tokens,
        });
        const intakeBudgetEvidence = assertProviderStepWithinBudget({
          requestBody: upstreamBody,
          providerBudget: intakeProviderBudget,
          runId: intakeRunId,
          stepIndex: 0,
        });
        onAudit({
          event: 'static_lore_intake_provider_budget_passed',
          request_id: requestId,
          measured_input_tokens:
            intakeBudgetEvidence.measured_input_tokens,
          provider_input_tokens:
            intakeProviderBudget.provider_input_tokens,
          output_reserve_tokens:
            intakeProviderBudget.output_reserve_tokens,
          tokenizer_profile: intakeBudgetEvidence.tokenizer_profile,
          provider_budget_policy_hash:
            verifiedProviderBudgetPolicy.policy_hash,
          request_hash: intakeBudgetEvidence.request_hash,
        });
        const headers = {
          'content-type': 'application/json',
          accept: 'application/json',
          ...upstreamHeaders,
        };
        applyUpstreamAuthorization(headers, request, {
          upstreamAuthMode: resolvedUpstreamAuthMode,
          upstreamApiKey,
        });
        if (usesIntakeCapability) {
          capabilityClaim =
            await staticLoreExtractionService.claimIntakeCapability({
              requestId,
              token: intakeCapability,
              runtimeInstanceId,
              protocolVersion: RUNTIME_SUPPORTED_PROTOCOLS[0],
              generationBindingHash: resolvedGenerationBindingHash,
              executionLease:
                requestBody.mnemosyne_intake_execution_lease,
            });
          if (capabilityClaim.dispatch_allowed !== true) {
            return json(response, 409, {
              schema: 'mnemosyne.intake-recovery-required.v1',
              status: capabilityClaim.status,
              request_id: requestId,
              retry_disposition: 'recover_only',
            });
          }
        } else {
          await staticLoreExtractionService.markUpstreamStarted({
            requestId,
          });
        }
        onAudit({
          event: 'static_lore_intake_model_started',
          request_id: requestId,
          body_timeout_ms: resolvedIntakeBodyTimeoutMs,
          overall_timeout_ms: resolvedIntakeOverallTimeoutMs,
          reasoning_effort: resolvedIntakeReasoningEffort,
          retry_policy: 'none',
        });
        let upstream;
        let responseText;
        let streamTermination;
        let clientCancelled = false;
        let overallTimedOut = false;
        const intakeAbortController = new AbortController();
        const cleanupClientCancellation = bindClientCancellation({
          request,
          response,
          controller: intakeAbortController,
          onCancel() {
            clientCancelled = true;
            requestCancelled = true;
          },
        });
        const overallTimeout = setTimeout(() => {
          overallTimedOut = true;
          intakeAbortController.abort();
        }, resolvedIntakeOverallTimeoutMs);
        overallTimeout.unref?.();
        const cleanupIntakeTransport = () => {
          clearTimeout(overallTimeout);
          cleanupClientCancellation();
        };
        try {
          upstream = await undiciFetch(
            `${upstreamBaseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(upstreamBody),
              dispatcher: intakeDispatcher,
              signal: intakeAbortController.signal,
            },
          );
          onAudit({
            event: 'static_lore_intake_upstream_responded',
            request_id: requestId,
            status_code: upstream.status,
            content_type: upstream.headers.get('content-type'),
          });
          const buffered = await readBufferedUpstreamResponse(upstream, {
            streamTerminalGraceMs:
              resolvedIntakeStreamTerminalGraceMs,
          });
          responseText = buffered.responseText;
          streamTermination = buffered.streamTermination;
          onAudit({
            event: 'static_lore_intake_upstream_body_complete',
            request_id: requestId,
            stream_termination: streamTermination,
            response_bytes: Buffer.byteLength(responseText, 'utf8'),
          });
        } catch (error) {
          const causeCode = error?.cause?.code ?? error?.code;
          const timedOut = [
            'UND_ERR_BODY_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
          ].includes(causeCode) || overallTimedOut;
          const cancelled = (
            clientCancelled
            || request.aborted
            || response.destroyed
          );
          const reasonCode = cancelled
            ? 'static_lore_intake_client_cancelled'
            : (
              overallTimedOut
                ? 'static_lore_intake_upstream_request_timeout'
                : (
                  timedOut
                    ? 'static_lore_intake_upstream_body_timeout'
                    : 'static_lore_intake_upstream_unreachable'
                )
            );
          await staticLoreExtractionService.recordTransportFailure({
            requestId,
            reasonCode,
            statusCode: upstream?.status ?? null,
            responseStarted: Boolean(upstream),
          });
          onAudit({
            event: 'static_lore_intake_transport_failed',
            request_id: requestId,
            reason_code: reasonCode,
            upstream_status: upstream?.status ?? null,
            retry_policy: 'none',
          });
          cleanupIntakeTransport();
          if (cancelled) return;
          const upstreamError = new MnemosyneRequestError(
            timedOut
              ? reasonCode
              : 'static_lore_intake_upstream_unreachable',
            timedOut
              ? 'Static Lore Intake upstream exceeded its configured response timeout.'
              : 'Static Lore Intake upstream request failed.',
            { cause_code: causeCode ?? null },
          );
          upstreamError.statusCode = timedOut ? 504 : 502;
          throw upstreamError;
        } finally {
          cleanupIntakeTransport();
        }
        if (!upstream.ok) {
          await staticLoreExtractionService.recordUpstreamFailure({
            requestId,
            statusCode: upstream.status,
            responseText,
          });
          onAudit({
            event: 'static_lore_intake_upstream_failed',
            request_id: requestId,
            status_code: upstream.status,
            retry_policy: 'none',
          });
          response.statusCode = upstream.status;
          copyResponseHeaders(upstream, response);
          return response.end(responseText);
        }
        let modelResponse;
        try {
          modelResponse = parseBufferedModelResponse(
            responseText,
            upstream.headers.get('content-type'),
          );
        } catch (error) {
          const reasonCode = error.reasonCode
            === 'static_lore_intake_upstream_json_invalid'
            ? error.reasonCode
            : 'static_lore_intake_upstream_stream_invalid';
          await staticLoreExtractionService.recordTransportFailure({
            requestId,
            reasonCode,
            statusCode: upstream.status,
            responseText,
            responseStarted: true,
          });
          onAudit({
            event: 'static_lore_intake_transport_failed',
            request_id: requestId,
            reason_code: reasonCode,
            upstream_status: upstream.status,
            retry_policy: 'none',
          });
          throw error;
        }
        const intakeResult = await staticLoreExtractionService.complete({
          requestId,
          modelResponse,
        });
        const intakeResultWithCapability =
          await attachNestedIntakeCapability(
            intakeResult,
            request,
            requestBody.mnemosyne_intake_execution_lease,
          );
        onAudit({
          event: 'static_lore_intake_completed',
          request_id: requestId,
          input_tokens: intakeResult.usage.input_tokens,
          output_tokens: intakeResult.usage.output_tokens,
          concept_count:
            intakeResultWithCapability.concept_count
            ?? intakeResultWithCapability.concept_count_so_far,
          intake_status: intakeResultWithCapability.status,
          completed_batch_index:
            intakeResultWithCapability.completed_batch_index
            ?? intakeResultWithCapability.batch_count,
          batch_count: intakeResultWithCapability.batch_count,
        });
        return json(response, 200, {
          ...modelResponse,
          mnemosyne_intake_result: intakeResultWithCapability,
        });
      }

      if (request.method === 'GET' && requestUrl.pathname === '/v1/models') {
        if (upstreamModel) {
          return json(response, 200, {
            object: 'list',
            data: [{
              id: upstreamModel,
              object: 'model',
              owned_by: 'configured-upstream',
            }],
          });
        }
        if (!upstreamBaseUrl) {
          throw new MnemosyneRequestError(
            'upstream_not_configured',
            'The main upstream API profile is not configured.',
          );
        }

        const headers = { accept: 'application/json', ...upstreamHeaders };
        applyUpstreamAuthorization(headers, request, {
          upstreamAuthMode: resolvedUpstreamAuthMode,
          upstreamApiKey,
        });
        const upstream = await fetch(
          `${upstreamBaseUrl.replace(/\/+$/, '')}/models`,
          { headers },
        );
        response.statusCode = upstream.status;
        copyResponseHeaders(upstream, response);
        if (!upstream.body) return response.end();
        return Readable.fromWeb(upstream.body).pipe(response);
      }

      if (
        request.method !== 'POST'
        || requestUrl.pathname !== '/v1/chat/completions'
      ) {
        return json(response, 404, {
          error: {
            type: 'mnemosyne_request_error',
            reason_code: 'route_not_found',
            message: 'Route not found.',
          },
        });
      }

      assertLocalAuthorization(request, proxyToken);
      if (!upstreamBaseUrl) {
        throw new MnemosyneRequestError(
          'upstream_not_configured',
          'The main upstream API profile is not configured.',
        );
      }

      requestBody = await readJsonBody(request, maxBodyBytes);
      const suppliedTransportBinding =
        requestBody.mnemosyne_transport_binding;
      const suppliedTransportLease =
        requestBody.mnemosyne_transport_lease;
      const transportBinding = (
        requireGenerationTransportBinding
        || suppliedTransportBinding !== undefined
        || suppliedTransportLease !== undefined
      )
        ? assertGenerationTransportBinding(
            suppliedTransportBinding,
            {
              protocolVersion: RUNTIME_SUPPORTED_PROTOCOLS[0],
              runtimeBuildId,
              runtimeInstanceId,
              generationBindingHash: resolvedGenerationBindingHash,
              operationRegistryHash,
            },
          )
        : null;
      const transportLease = transportBinding
        ? assertRootTransportLease(
            suppliedTransportLease,
            transportBinding,
          )
        : null;
      const preparedRequestBody = {
        ...requestBody,
      };
      delete preparedRequestBody.mnemosyne_transport_binding;
      delete preparedRequestBody.mnemosyne_transport_lease;
      const prepared = await prepareUpstreamRequest(preparedRequestBody, {
        verifyRemovalAuthorization: verifySourceRemoval,
        auditExcludedPhrases,
        measureContinuityPayloadTokens: countOpenAiTokens,
      });
      assertProviderBudgetMatchesPolicy({
        providerBudget: prepared.providerBudget,
        providerPolicy: verifiedProviderBudgetPolicy,
        runId: prepared.report.run_id,
      });
      if (requireAuditExcludedPhrasesAbsent) {
        const rejected = prepared.report.prompt_exclusion_witnesses
          .filter(witness => witness.status !== 'absent');
        if (
          prepared.report.prompt_exclusion_witnesses.length
            !== auditExcludedPhrases.length
          || rejected.length > 0
        ) {
          onAudit({
            event: 'prompt_exclusion_rejected',
            run_id: prepared.report.run_id,
            rejected_phrase_hashes:
              rejected.map(witness => witness.phrase_hash),
          });
          throw new MnemosyneRequestError(
            'prompt_exclusion_phrase_present',
            'A required outside-prompt fact is present in the provider request.',
            {
              rejected: rejected.map(witness => ({
                phrase_hash: witness.phrase_hash,
                present_provider_indices:
                  witness.present_provider_indices,
              })),
            },
          );
        }
      }
      if (!storySourceAdmission) {
        const error = new MnemosyneRequestError(
          'story_source_admission_unavailable',
          'Story Source Admission is required before a story request can be dispatched.',
        );
        error.statusCode = 503;
        throw error;
      }
      const constrainedPreparedBody = constrainProviderRequestOutput({
        requestBody: {
          ...prepared.body,
          ...(upstreamModel ? { model: upstreamModel } : {}),
        },
        providerBudget: prepared.providerBudget,
        runId: prepared.report.run_id,
      });
      const hostInput = createStorySourceAdmissionInput({
        requestBody: preparedRequestBody,
        prepared: {
          ...prepared,
          body: constrainedPreparedBody,
        },
      });
      const admissionPreview = await storySourceAdmission.prepareOnly(
        hostInput,
      );
      const admittedStory = assertAdmittedStoryRequest(
        await storySourceAdmission.admitStory({
          hostInput,
          receipt: admissionPreview.receipt,
        }),
      );
      consumeRootRunAcceptanceGuard(
        prepared,
        verifiedRootRunAcceptanceGuard,
        rootRunAcceptanceGuardStateStore,
      );
      const upstreamBody = admittedStory.body;
      const upstreamUrl = `${upstreamBaseUrl.replace(/\/+$/, '')}/chat/completions`;
      const headers = {
        'content-type': 'application/json',
        accept: request.headers.accept ?? 'application/json',
        ...upstreamHeaders,
      };
      applyUpstreamAuthorization(headers, request, {
        upstreamAuthMode: resolvedUpstreamAuthMode,
        upstreamApiKey,
      });

      onAudit({
        event: 'prompt_fidelity_passed',
        run_id: prepared.report.run_id,
        prompt_spine_hash: prepared.promptSpine.hash,
        verified_message_count: prepared.report.verified_message_count,
        retained_message_count: prepared.report.retained_message_count,
        removed_sources: prepared.report.removed,
        recent_continuity_strip_availability:
          prepared.recentContinuityStripAvailability,
        recent_continuity_strip_mapping_diagnostics:
          prepared.recentContinuityStripMappingDiagnostics,
      });

      if (runKernel) {
        if (typeof runKernel.executeRootTurn !== 'function') {
          throw new Error('runKernel must implement executeRootTurn.');
        }
        const kernelAbortController = new AbortController();
        let rootRunTimedOut = false;
        const rootRunTimeout = setTimeout(() => {
          if (kernelAbortController.signal.aborted) return;
          rootRunTimedOut = true;
          kernelAbortController.abort(
            new Error('The root run exceeded its overall deadline.'),
          );
        }, resolvedRootRunOverallTimeoutMs);
        rootRunTimeout.unref?.();
        const cleanupKernelCancellation = bindClientCancellation({
          request,
          response,
          controller: kernelAbortController,
          onCancel() {
            requestCancelled = true;
          },
        });
        let outcome;
        try {
          const kernelRunScope = structuredClone(
            admittedStory.run_scope,
          );
          const dispatchedModel = String(
            upstreamBody.model
            ?? verifiedMainHostBinding?.model
            ?? '',
          );
          const requestedModel = String(
            prepared.body.model
            ?? dispatchedModel,
          );
          outcome = await runKernel.executeRootTurn({
            requestBody: upstreamBody,
            runScope: kernelRunScope,
            runEvidence: {
              schema: 'mnemosyne.root-run-host-evidence.v1',
              ...(continuityEvaluation.runAttestation
                ? {
                    continuity_evaluation:
                      structuredClone(
                        continuityEvaluation.runAttestation,
                      ),
                  }
                : {}),
              prompt_fidelity: structuredClone(prepared.report),
              transport_lease: transportLease
                ? structuredClone(transportLease)
                : null,
              story_source_admission_receipt:
                structuredClone(admissionPreview.receipt),
              prompt_spine_hash: prepared.promptSpine.hash,
              provider_budget:
                structuredClone(prepared.providerBudget),
              provider_budget_policy:
                structuredClone(verifiedProviderBudgetPolicy),
              model_binding: sealMd1HostModelBinding({
                runId: kernelRunScope.run_id,
                promptSpineHash: prepared.promptSpine.hash,
                requestedModel,
                dispatchedModel,
                bindingSource: (
                  verifiedMainHostBinding?.model === dispatchedModel
                    ? 'configured_main_host'
                    : 'host_request'
                ),
              }),
              audit_binding: verifiedRootRunAuditBinding
                ? structuredClone(verifiedRootRunAuditBinding)
                : null,
              host_history_binding: prepared.hostHistoryBinding
                ? structuredClone(prepared.hostHistoryBinding)
                : null,
              host_history_coordinate_basis:
                prepared.hostHistoryCoordinateBasis
                  ? structuredClone(
                      prepared.hostHistoryCoordinateBasis,
                    )
                  : null,
            },
            providerAuthContext: {
              authorization: request.headers.authorization,
            },
            signal: kernelAbortController.signal,
          });
        } catch (error) {
          if (rootRunTimedOut) {
            onAudit({
              event: 'root_turn_timed_out',
              run_id: prepared.report.run_id,
              timeout_ms: resolvedRootRunOverallTimeoutMs,
              recovery_policy: 'retry_same_run_id',
            });
            const timeoutError = new MnemosyneRequestError(
              'root_turn_timeout',
              'The root turn exceeded its configured overall deadline.',
              {
                timeout_ms: resolvedRootRunOverallTimeoutMs,
                recovery_policy: 'retry_same_run_id',
              },
            );
            timeoutError.statusCode = 504;
            throw timeoutError;
          }
          throw error;
        } finally {
          clearTimeout(rootRunTimeout);
          cleanupKernelCancellation();
        }
        onAudit({
          event: 'root_turn_completed',
          run_id: outcome.run_id,
          body_hash: outcome.body_hash,
          writeback_mode: outcome.writeback.mode,
        });
        return writeRootTurnCompletion(response, outcome, {
          stream: admittedStory.body.stream === true,
        });
      }

      let upstream;
      const passThroughAbortController = new AbortController();
      const cleanupPassThroughCancellation = bindClientCancellation({
        request,
        response,
        controller: passThroughAbortController,
        onCancel() {
          requestCancelled = true;
        },
      });
      try {
        const budgetEvidence = assertProviderStepWithinBudget({
          requestBody: upstreamBody,
          providerBudget: prepared.providerBudget,
          runId: prepared.report.run_id,
          stepIndex: 0,
        });
        onAudit({
          event: 'provider_step_budget_passed',
          run_id: prepared.report.run_id,
          step_index: 0,
          measured_input_tokens:
            budgetEvidence.measured_input_tokens,
          provider_input_tokens:
            prepared.providerBudget.provider_input_tokens,
          tokenizer_profile:
            budgetEvidence.tokenizer_profile,
          provider_budget_policy_hash:
            verifiedProviderBudgetPolicy.policy_hash,
          request_hash: budgetEvidence.request_hash,
        });
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(upstreamBody),
          signal: passThroughAbortController.signal,
        });
      } catch (error) {
        cleanupPassThroughCancellation();
        if (passThroughAbortController.signal.aborted) {
          onAudit({
            event: 'upstream_cancelled',
            run_id: prepared.report.run_id,
          });
          return;
        }
        if (error instanceof MnemosyneRequestError) {
          throw error;
        }
        const proxyError = new MnemosyneRequestError(
          'upstream_unreachable',
          'The configured main upstream API could not be reached.',
          { cause: error.message },
        );
        proxyError.statusCode = 502;
        throw proxyError;
      }

      onAudit({
        event: 'upstream_responded',
        run_id: prepared.report.run_id,
        status_code: upstream.status,
        content_type: upstream.headers.get('content-type'),
      });

      response.statusCode = upstream.status;
      copyResponseHeaders(upstream, response);
      if (!upstream.body) {
        return response.end();
      }

      const upstreamStream = Readable.fromWeb(upstream.body);
      upstreamStream.on('error', error => {
        if (!response.destroyed) response.destroy(error);
      });
      upstreamStream.pipe(response);
    } catch (error) {
      if (requestCancelled || request.aborted || response.destroyed) {
        onAudit({
          event: 'request_cancelled',
          run_id: requestBody?.mnemosyne_prompt_trace?.run_id ?? null,
        });
        return;
      }
      const statusCode = error.statusCode ?? 500;
      const runId = requestBody?.mnemosyne_prompt_trace?.run_id ?? null;
      const providerTraceMismatch = (
        error instanceof MnemosyneRequestError
        && error.reasonCode === 'provider_trace_hash_mismatch'
        && error.details
        && typeof error.details === 'object'
      )
        ? error.details
        : null;
      onAudit({
        event: 'request_blocked',
        run_id: runId,
        reason_code: error.reasonCode ?? 'internal_error',
        provider_trace_index:
          Number.isInteger(providerTraceMismatch?.index)
            ? providerTraceMismatch.index
            : undefined,
        provider_trace_identifier:
          typeof providerTraceMismatch?.expected_identifier === 'string'
          && /^[A-Za-z0-9_.:-]{1,96}$/.test(
            providerTraceMismatch.expected_identifier,
          )
            ? providerTraceMismatch.expected_identifier
            : undefined,
        provider_trace_source_label:
          typeof providerTraceMismatch?.expected_source_label === 'string'
          && /^[a-z][a-z0-9_]{1,63}$/.test(
            providerTraceMismatch.expected_source_label,
          )
            ? providerTraceMismatch.expected_source_label
            : undefined,
        provider_trace_role_mismatch: providerTraceMismatch
          ? providerTraceMismatch.expected_role
            !== providerTraceMismatch.actual_role
          : undefined,
        provider_trace_name_mismatch: providerTraceMismatch
          ? providerTraceMismatch.expected_name
            !== providerTraceMismatch.actual_name
          : undefined,
        provider_trace_content_mismatch: providerTraceMismatch
          ? providerTraceMismatch.expected_hash
            !== providerTraceMismatch.actual_hash
          : undefined,
        provider_trace_normalized_message_mismatch:
          providerTraceMismatch
            ? providerTraceMismatch.expected_prompt_message_hash
              !== providerTraceMismatch.actual_prompt_message_hash
            : undefined,
        host_reason_code:
          error instanceof MnemosyneRequestError
          && typeof error.details?.host_reason_code === 'string'
          && /^[a-z][a-z0-9_]{2,95}$/.test(
            error.details.host_reason_code,
          )
            ? error.details.host_reason_code
            : undefined,
        internal_error_name: error instanceof MnemosyneRequestError
          ? undefined
          : error?.name ?? 'Error',
        internal_error_message: error instanceof MnemosyneRequestError
          ? undefined
          : String(error?.message || 'Unknown internal error').slice(0, 500),
        internal_error_cause_code: error instanceof MnemosyneRequestError
          ? undefined
          : error?.cause?.code,
        internal_error_cause_message: error instanceof MnemosyneRequestError
          ? undefined
          : String(error?.cause?.message || '').slice(0, 500) || undefined,
      });
      return json(response, statusCode, createErrorBody(error, runId));
    }
  });

  return {
    get url() {
      return listenUrl;
    },
    async listen({ port = 18991, host = '127.0.0.1' } = {}) {
      if (listenUrl) return listenUrl;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      listenUrl = `http://${host}:${address.port}`;
      return listenUrl;
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()));
        });
      }
      await intakeDispatcher.close();
      listenUrl = null;
    },
  };
}
