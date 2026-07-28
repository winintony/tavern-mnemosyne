import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  appendPromptStep,
  assertPromptSpine,
  lockPromptSpine,
} from './prompt-spine.js';
import {
  createChatWriteCoordinator,
} from '../runtime/chat-write-coordinator.js';
import {
  PROVIDER_TYPED_RECORD_SCHEMAS,
  normalizeProviderTurnRecords,
} from '../history/typed-turn-delta.js';
import { countOpenAiTokens } from '../proxy/provider-step-budget.js';
import {
  createBoundedMemoryReadResult,
  DEFAULT_MAX_MEMORY_READ_TOKENS,
  MAX_MEMORY_READ_TOKENS,
  MAX_MEMORY_READ_SELECTOR_LENGTH,
  parseMemoryReadSelector,
  RETRIEVAL_CONTRACT_VERSION,
} from '../memory/bounded-memory-read.js';
import {
  STORY_COVERAGE_FACETS,
} from '../memory/story-coverage.js';

const MEMORY_READER_CAPABILITY_VERSION =
  'mnemosyne.memory-reader.v2';
const SEARCH_SNIPPET_KINDS = new Set([
  'directory_summary',
  'content_excerpt',
  'turn_summary',
]);
const SEARCH_STATE_LAYERS = new Set([
  'current_state',
  'attribute_value',
]);

const TOOL_SCHEMAS = Object.freeze({
  memory_search: {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Find fact-bearing active story memory.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'purpose',
          'query_hint',
          'needs',
          'scope_refs',
          'coverage_facets',
          'limit',
        ],
        properties: {
          purpose: { type: 'string', minLength: 1 },
          query_hint: { type: 'string', minLength: 1 },
          needs: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string', minLength: 1 },
          },
          scope_refs: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'string',
              minLength: 1,
              description:
                'A model-visible OKF entity, current-state, turn-record, or same-chat active-scene scope ref.',
            },
          },
          coverage_facets: {
            type: 'array',
            maxItems: STORY_COVERAGE_FACETS.length,
            items: {
              type: 'string',
              enum: STORY_COVERAGE_FACETS,
            },
            description:
              'Typed story lanes to prioritize within the result limit; the response reports represented and missing lanes.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 12 },
        },
      },
    },
  },
  memory_read: {
    type: 'function',
    function: {
      name: 'memory_read',
      description:
        'Read a bounded page of active memory. Use the advertised maximum token budget for broad entity or path reads. When the result is truncated, immediately pass the returned continuation cursor as a ref to keep reading.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['purpose', 'refs', 'max_tokens'],
        properties: {
          purpose: { type: 'string', minLength: 1 },
          refs: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: { type: 'string', minLength: 1 },
          },
          max_tokens: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_MEMORY_READ_TOKENS,
            description:
              'Final serialized tool-result budget. Prefer the advertised maximum when the selected memory size is unknown.',
          },
        },
      },
    },
  },
  story_commit: {
    type: 'function',
    function: {
      name: 'story_commit',
      description: 'Lock the exact final story prose before memory writeback.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['body', 'format', 'warnings'],
        properties: {
          body: { type: 'string', minLength: 1 },
          format: {
            type: 'string',
            enum: ['host_default', 'markdown', 'plain_text'],
          },
          warnings: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
  memory_write_turn_delta: {
    type: 'function',
    function: {
      name: 'memory_write_turn_delta',
      description: [
        'Settle the committed turn with grounded typed memory.',
        'For each changed fact, cite one unique exact quote from the committed body.',
        'Record durable state, attributes, character changes, cognition boundaries,',
        'relationships, objective events, world rules, plot threads, and scene state.',
        'Use no_change only when the prose creates none of those changes, and explain why.',
      ].join(' '),
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['commit_id', 'mode', 'reason', 'records'],
        properties: {
          commit_id: { type: 'string' },
          mode: { type: 'string', enum: ['changed', 'no_change'] },
          reason: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
          },
          records: {
            type: 'array',
            items: {
              anyOf: PROVIDER_TYPED_RECORD_SCHEMAS,
            },
          },
        },
      },
    },
  },
});

const CORRECTABLE_WRITEBACK_REASON_CODES = new Set([
  'source_quote_ambiguous',
  'source_span_mismatch',
  'turn_delta_invalid',
  'turn_delta_record_invalid',
  'turn_delta_records_invalid',
  'turn_delta_event_invalid',
  'turn_delta_reason_invalid',
  'turn_delta_state_invalid',
  'unsupported_claim',
  'plot_thread_payoff_ungrounded',
]);
const MAX_RETRIEVAL_CORRECTIONS = 2;
const MAX_PROTOCOL_CORRECTIONS = 2;
const MAX_WRITEBACK_CORRECTIONS = 2;
const CORRECTABLE_RETRIEVAL_REASON_CODES = new Set([
  'memory_query_invalid',
  'memory_search_limit_invalid',
  'memory_search_intent_invalid',
  'memory_coverage_facets_invalid',
  'memory_ref_invalid',
  'memory_read_budget_invalid',
  'memory_read_budget_too_small',
  'memory_read_cursor_invalid',
  'memory_read_cursor_stale',
  'memory_read_continuation_required',
  'memory_read_intent_invalid',
]);
function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function parseToolCall(response) {
  const message = response?.assistant_message;
  const calls = message?.tool_calls;
  if (
    message?.role !== 'assistant'
    || !Array.isArray(calls)
    || calls.length !== 1
  ) {
    const toolNames = Array.isArray(calls)
      ? calls.map(call => (
        call?.function?.name
        ?? call?.wire_name
        ?? null
      ))
      : [];
    fail(
      'main_ai_tool_protocol_invalid',
      'The main model must return exactly one tool call per step.',
      {
        tool_call_count: Array.isArray(calls)
          ? calls.length
          : null,
        tool_names: toolNames,
      },
    );
  }
  const call = calls[0];
  const name = call?.function?.name ?? call?.wire_name;
  const serializedArguments = (
    call?.function?.arguments
    ?? call?.arguments_json
  );
  if (
    typeof call?.id !== 'string'
    || !call.id
    || typeof name !== 'string'
    || typeof serializedArguments !== 'string'
  ) {
    fail(
      'main_ai_tool_protocol_invalid',
      'The main model returned an incomplete tool call.',
    );
  }
  let args;
  try {
    args = JSON.parse(serializedArguments);
  } catch {
    fail(
      'main_ai_tool_arguments_invalid',
      `Tool ${name} arguments are not valid JSON.`,
    );
  }
  return { call, message, name, args };
}

function toolResultMessage(callId, name, result) {
  const canonicalNames = {
    memory_search: 'memory.search',
    memory_read: 'memory.read',
    story_commit: 'story.commit',
    memory_write_turn_delta: 'memory.write_turn_delta',
  };
  return {
    role: 'tool',
    tool_call_id: callId,
    name,
    content: JSON.stringify({
      schema: 'mnemosyne.tool-result.v1',
      call_id: callId,
      tool: canonicalNames[name] ?? name,
      ok: true,
      result,
      error: null,
    }),
  };
}

function toolErrorMessage(callId, name, error) {
  const canonicalNames = {
    memory_search: 'memory.search',
    memory_read: 'memory.read',
    memory_write_turn_delta: 'memory.write_turn_delta',
  };
  return {
    role: 'tool',
    tool_call_id: callId,
    name,
    content: JSON.stringify({
      schema: 'mnemosyne.tool-result.v1',
      call_id: callId,
      tool: canonicalNames[name] ?? name,
      ok: false,
      result: null,
      error: {
        reason_code: error.reasonCode,
        message: error.message,
        retryable: true,
        details: error.details ?? null,
      },
    }),
  };
}

function memoryReadScope(runScope) {
  return {
    chat_id: runScope.chat_id,
    run_id: runScope.run_id,
    branch_id: runScope.branch_id,
    branch_epoch: runScope.branch_epoch,
    turn_index:
      runScope.memory_turn_index
      ?? runScope.turn_index,
  };
}

function normalizeRetrievalText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim()
    : value;
}

function normalizeRetrievalList(value) {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.map(normalizeRetrievalText))];
}

function normalizeMemorySearchIntent(args) {
  return {
    schema: 'mnemosyne.retrieval-intent.v1',
    tool: 'memory.search',
    purpose: normalizeRetrievalText(args?.purpose),
    query_hint: normalizeRetrievalText(args?.query_hint),
    needs: normalizeRetrievalList(args?.needs),
    scope_refs: normalizeRetrievalList(args?.scope_refs),
    coverage_facets:
      normalizeRetrievalList(args?.coverage_facets)
      ?? [],
    limit: args?.limit,
  };
}

function normalizeMemoryReadIntent(args) {
  return {
    schema: 'mnemosyne.retrieval-intent.v1',
    tool: 'memory.read',
    purpose: normalizeRetrievalText(args?.purpose),
    // Refs and cursors are opaque execution selectors. Preserve them exactly
    // so the journal describes the request that the reader actually received.
    refs: structuredClone(args?.refs),
    max_tokens: args?.max_tokens,
  };
}

function validateMemoryReadRequest(args, maxMemoryReadTokens) {
  if (
    typeof args?.purpose !== 'string'
    || !normalizeRetrievalText(args.purpose)
  ) {
    fail(
      'memory_read_intent_invalid',
      'Memory read purpose must be a non-empty string.',
    );
  }
  if (
    !Number.isSafeInteger(args?.max_tokens)
    || args.max_tokens < 1
    || args.max_tokens > maxMemoryReadTokens
  ) {
    fail(
      'memory_read_budget_invalid',
      `Memory read max_tokens must be between 1 and ${maxMemoryReadTokens}.`,
    );
  }
  if (
    !Array.isArray(args?.refs)
    || args.refs.length < 1
    || args.refs.length > 8
    || args.refs.some(ref => (
      typeof ref !== 'string'
      || !ref
      || ref.length > MAX_MEMORY_READ_SELECTOR_LENGTH
    ))
    || new Set(args.refs).size !== args.refs.length
  ) {
    fail(
      'memory_ref_invalid',
      'Memory read requires between one and eight unique bounded refs.',
    );
  }
}

function validateMemorySearchResult(result) {
  const coverage = result?.coverage;
  const validCoverageFacetList = value => (
    Array.isArray(value)
    && value.every(facet => (
      STORY_COVERAGE_FACETS.includes(facet)
    ))
    && new Set(value).size === value.length
  );
  const validStateLayer = entry => {
    const requiresStateLayer = (
      (
        entry?.kind === 'current_state'
        && entry.type === 'current_state'
      )
      || (
        entry?.kind === 'turn_memory_record'
        && entry.type === 'continuity_state'
      )
    );
    if (requiresStateLayer) {
      return SEARCH_STATE_LAYERS.has(entry.state_layer);
    }
    return !Object.hasOwn(entry ?? {}, 'state_layer');
  };
  if (
    result?.schema !== 'mnemosyne.memory-search-result.v2'
    || result.status !== 'ready'
    || !Array.isArray(result.results)
    || (
      coverage !== undefined
      && (
        coverage?.schema !== 'mnemosyne.story-coverage.v1'
        || !['relevance', 'facet_balanced'].includes(
          coverage.mode,
        )
        || !validCoverageFacetList(
          coverage.requested_facets,
        )
        || !validCoverageFacetList(
          coverage.represented_facets,
        )
        || !validCoverageFacetList(
          coverage.missing_facets,
        )
        || coverage.represented_facets.some(
          facet => !coverage.requested_facets.includes(facet),
        )
        || coverage.missing_facets.some(
          facet => (
            !coverage.requested_facets.includes(facet)
            || coverage.represented_facets.includes(facet)
          ),
        )
        || coverage.requested_facets.some(
          facet => (
            !coverage.represented_facets.includes(facet)
            && !coverage.missing_facets.includes(facet)
          ),
        )
      )
    )
    || result.results.some(entry => (
      typeof entry?.ref !== 'string'
      || !entry.ref
      || typeof entry.snippet !== 'string'
      || !entry.snippet.trim()
      || !SEARCH_SNIPPET_KINDS.has(entry.snippet_kind)
      || Object.hasOwn(entry, 'content')
      || Object.hasOwn(entry, 'source_refs')
      || Object.hasOwn(entry, 'memory')
      || !validStateLayer(entry)
    ))
  ) {
    fail(
      'memory_search_result_invalid',
      'Memory search must return only v2 directory entries.',
    );
  }
}

function addUsage(aggregate, usage) {
  for (const field of ['prompt_tokens', 'completion_tokens']) {
    const amount = Number(usage?.[field] ?? 0);
    if (Number.isFinite(amount)) aggregate[field] += amount;
  }
}

function isCorrectableWritebackError(error) {
  return (
    error instanceof MnemosyneRequestError
    && CORRECTABLE_WRITEBACK_REASON_CODES.has(error.reasonCode)
  );
}

function isCorrectableRetrievalError(error) {
  return (
    error instanceof MnemosyneRequestError
    && CORRECTABLE_RETRIEVAL_REASON_CODES.has(error.reasonCode)
  );
}

function lastUserMessage(messages) {
  const message = [...messages].reverse().find(item => item?.role === 'user');
  if (!message || typeof message.content !== 'string') {
    fail(
      'root_turn_user_message_missing',
      'A root turn requires an exact user message in the locked prompt.',
    );
  }
  return {
    role: 'user',
    content: message.content,
  };
}

function normalizeWritebackReason(reason) {
  if (
    typeof reason !== 'string'
    || !reason.trim()
    || reason.length > 1000
  ) {
    fail(
      'turn_delta_reason_invalid',
      'Memory writeback requires a concise non-empty reason.',
    );
  }
  return reason.trim();
}

function toolSchemas(
  bodyCommitted,
  memoryReader,
  maxMemoryReadTokens,
  requiredContinuationCount = 0,
) {
  const memoryRead = structuredClone(TOOL_SCHEMAS.memory_read);
  memoryRead.function.parameters.properties.max_tokens.maximum =
    maxMemoryReadTokens;
  if (requiredContinuationCount === 1) {
    memoryRead.function.description = [
      memoryRead.function.description,
      'Exactly one continuation is pending.',
      'Call memory_read with the returned continuation ref;',
      'the kernel will bind a continuation-shaped ref to the exact signed cursor.',
    ].join(' ');
  }
  if (bodyCommitted) {
    return [TOOL_SCHEMAS.memory_write_turn_delta];
  }
  if (requiredContinuationCount > 0) return [memoryRead];
  return [
    ...(memoryReader
      ? [TOOL_SCHEMAS.memory_search, memoryRead]
      : []),
    TOOL_SCHEMAS.story_commit,
  ];
}

function requiredContinuationCursorsFromEvents(events) {
  const required = new Set();
  for (const event of events ?? []) {
    if (
      event?.type !== 'tool_completed'
      || event.tool !== 'memory_read'
    ) {
      continue;
    }
    const refs = Array.isArray(event.arguments?.refs)
      ? event.arguments.refs
      : [];
    for (const ref of refs) {
      required.delete(ref);
    }
    for (const cursor of event.result?.continuation_cursors ?? []) {
      if (typeof cursor === 'string' && cursor) {
        required.add(cursor);
      }
    }
  }
  return required;
}

function bindSingleRequiredContinuation(args, requiredCursors) {
  if (
    requiredCursors.size !== 1
    || !Array.isArray(args?.refs)
    || args.refs.length !== 1
    || typeof args.refs[0] !== 'string'
    || !args.refs[0].startsWith('memory://continuation/')
  ) {
    return null;
  }
  const requiredRef = [...requiredCursors][0];
  if (args.refs[0] === requiredRef) return null;
  const effectiveArgs = {
    ...structuredClone(args),
    refs: [requiredRef],
  };
  return {
    effectiveArgs,
    audit: {
      schema:
        'mnemosyne.single-continuation-binding.v1',
      reason_code:
        'single_pending_continuation_bound',
      requested_ref_hash: sha256(args.refs[0]),
      effective_ref_hash: sha256(requiredRef),
    },
  };
}

function rootTurnResult({
  runId,
  committed,
  model,
  aggregateUsage,
  mode,
  patchId,
  projection,
}) {
  const result = {
    schema: 'mnemosyne.root-turn-result.v1',
    status: 'completed',
    run_id: runId,
    final_body: committed.body,
    body_hash: committed.body_hash,
    model,
    aggregate_usage: structuredClone(aggregateUsage),
    writeback: {
      mode,
      patch_id: patchId,
    },
  };
  if (projection != null) {
    result.projection = structuredClone(projection);
  }
  return result;
}

async function rebuildDynamicProjection(projector, runScope) {
  if (!projector) return null;
  const rebuilt = await projector.rebuild({
    chatId: runScope.chat_id,
    branchId: runScope.branch_id,
    branchEpoch: runScope.branch_epoch,
    turnIndex: runScope.turn_index,
  });
  const hashFields = [
    'canonical_active_state_hash',
    'canonical_chronicle_hash',
    'canonical_bundle_hash',
  ];
  if (
    rebuilt?.schema !== 'mnemosyne.dynamic-story-projection-result.v1'
    || rebuilt.status !== 'ready'
    || hashFields.some(field => !/^[a-f0-9]{64}$/.test(rebuilt[field] ?? ''))
  ) {
    fail(
      'dynamic_projection_result_invalid',
      'Dynamic story projection did not return a sealed ready result.',
    );
  }
  return {
    status: 'ready',
    canonical_active_state_hash: rebuilt.canonical_active_state_hash,
    canonical_chronicle_hash: rebuilt.canonical_chronicle_hash,
    canonical_bundle_hash: rebuilt.canonical_bundle_hash,
  };
}

async function activateCommittedCandidate(stateHistory, runScope) {
  const activated = stateHistory.activateCandidateByHostCoordinate
    ? await stateHistory.activateCandidateByHostCoordinate({
        commandId: `activate-committed-${sha256(canonicalJson({
          chat_id: runScope.chat_id,
          turn_id: runScope.turn_id,
          candidate_id: runScope.candidate_id,
        })).slice(0, 24)}`,
        chatId: runScope.chat_id,
        branchId: runScope.branch_id,
        branchEpoch: runScope.branch_epoch,
        turnIndex: runScope.turn_index,
        swipeId: runScope.swipe_id,
        throughTurnIndex: runScope.turn_index,
      })
    : await stateHistory.activateCandidate({
        chatId: runScope.chat_id,
        turnId: runScope.turn_id,
        candidateId: runScope.candidate_id,
      });
  if (!['activated', 'existing'].includes(activated?.status)) {
    fail(
      'candidate_activation_result_invalid',
      'State History did not activate the committed reply candidate.',
    );
  }
}

function transcriptAfterLock(messages, promptLock) {
  return structuredClone(messages.slice(promptLock.message_count));
}

function toolJournalEvent({
  type = 'tool_completed',
  parsed,
  result = null,
  error = null,
  response,
  retrievalIntent = null,
  modelArguments = null,
  argumentBinding = null,
}) {
  return {
    type,
    call_id: parsed.call.id,
    tool: parsed.name,
    arguments: structuredClone(parsed.args),
    arguments_hash: sha256(canonicalJson(parsed.args)),
    result: result === null ? null : structuredClone(result),
    result_hash: result === null ? null : sha256(canonicalJson(result)),
    error: error === null
      ? null
      : {
          reason_code: error.reasonCode ?? 'tool_failed',
          message: error.message,
          details: structuredClone(error.details ?? null),
        },
    model: response?.model ?? null,
    usage: structuredClone(response?.usage ?? null),
    ...(retrievalIntent === null
      ? {}
      : {
          retrieval_intent:
            structuredClone(retrievalIntent),
          retrieval_intent_hash:
            sha256(canonicalJson(retrievalIntent)),
        }),
    ...(modelArguments === null
      ? {}
      : {
          model_arguments:
            structuredClone(modelArguments),
          model_arguments_hash:
            sha256(canonicalJson(modelArguments)),
        }),
    ...(argumentBinding === null
      ? {}
      : {
          argument_binding:
            structuredClone(argumentBinding),
        }),
    ...(response?.provider_budget_evidence
      ? {
          provider_budget_evidence: structuredClone(
            response.provider_budget_evidence,
          ),
        }
      : {}),
  };
}

export function createRunKernel({
  provider,
  stateHistory,
  memoryReader = null,
  runJournal = null,
  projector = null,
  chatWriteCoordinator = createChatWriteCoordinator(),
  maxToolSteps = 8,
  memoryCursorSecret = null,
  measureMemoryToolResultTokens = null,
  maxMemoryReadTokens = DEFAULT_MAX_MEMORY_READ_TOKENS,
  qualityTelemetry = null,
  continuityRules = null,
} = {}) {
  if (!provider?.completeToolStep) {
    throw new Error('Run Kernel requires a provider adapter.');
  }
  if (!stateHistory?.commitTurn || !stateHistory?.activateCandidate) {
    throw new Error(
      'Run Kernel requires State History commit and candidate activation.',
    );
  }
  if (projector !== null && !projector?.rebuild) {
    throw new Error('Run Kernel projector must expose rebuild.');
  }
  if (
    qualityTelemetry !== null
    && typeof qualityTelemetry?.buildJournalEvent !== 'function'
  ) {
    throw new Error(
      'Run Kernel quality telemetry must expose buildJournalEvent.',
    );
  }
  if (
    continuityRules !== null
    && typeof continuityRules?.buildJournalEvent !== 'function'
  ) {
    throw new Error(
      'Run Kernel continuity rules must expose buildJournalEvent.',
    );
  }
  if (!chatWriteCoordinator?.run) {
    throw new Error(
      'Run Kernel Chat Write Coordinator must expose run.',
    );
  }
  if (!Number.isInteger(maxToolSteps) || maxToolSteps < 2) {
    throw new Error('Run Kernel maxToolSteps must be at least two.');
  }
  if (
    !Number.isSafeInteger(maxMemoryReadTokens)
    || maxMemoryReadTokens < 1
    || maxMemoryReadTokens > MAX_MEMORY_READ_TOKENS
  ) {
    throw new Error(
      'Run Kernel maxMemoryReadTokens must be a positive safe integer.',
    );
  }
  if (
    memoryReader
    && (
      memoryReader.capability_version
        !== MEMORY_READER_CAPABILITY_VERSION
      || typeof memoryReader.search !== 'function'
      || typeof memoryReader.read !== 'function'
    )
  ) {
    throw new Error(
      'Run Kernel requires the current Memory Reader v2 contract.',
    );
  }
  if (
    memoryReader
    && (
      !(
        typeof memoryCursorSecret === 'string'
        || Buffer.isBuffer(memoryCursorSecret)
      )
      || Buffer.byteLength(memoryCursorSecret) < 32
    )
  ) {
    throw new Error(
      'Run Kernel memory reads require a stable cursor signing secret.',
    );
  }
  if (
    measureMemoryToolResultTokens !== null
    && typeof measureMemoryToolResultTokens !== 'function'
  ) {
    throw new Error(
      'Run Kernel memory tool-result measurement must be a function.',
    );
  }
  const memoryToolTokenMeasure = (
    measureMemoryToolResultTokens
    ?? countOpenAiTokens
  );

  const activeRuns = new Set();

  return Object.freeze({
    capability_version: 'mnemosyne.run-kernel.v1',
    max_tool_steps: maxToolSteps,
    max_memory_read_tokens: maxMemoryReadTokens,

    async executeRootTurn({
      requestBody,
      runScope,
      providerAuthContext,
      runEvidence = null,
      signal,
    }) {
      const runId = runScope?.run_id;
      const activeRunKey = canonicalJson([
        runScope?.chat_id ?? null,
        runId ?? null,
      ]);
      if (activeRuns.has(activeRunKey)) {
        fail(
          'root_turn_already_running',
          'This root run is already executing in the current runtime.',
        );
      }
      activeRuns.add(activeRunKey);
      try {
      const lockedMessages = structuredClone(requestBody?.messages);
      const promptLock = await lockPromptSpine(lockedMessages, { runId });
      const requestHash = sha256(canonicalJson({
        request_body: requestBody,
        run_scope: runScope,
      }));
      let messages = structuredClone(lockedMessages);
      let committed = null;
      let writebackCorrections = 0;
      let retrievalCorrections = 0;
      let protocolCorrections = 0;
      let model = requestBody?.model ?? null;
      let consumedToolSteps = 0;
      let requiredContinuationCursors = new Set();
      const aggregateUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
      };
      if (runJournal) {
        const begun = await runJournal.begin({
          chatId: runScope.chat_id,
          runId,
          requestHash,
          promptSpineHash: promptLock.hash,
          retrievalContractVersion: RETRIEVAL_CONTRACT_VERSION,
          runScope,
          runEvidence,
        });
        const journal = begun.journal;
        if (journal.state === 'completed' && journal.result) {
          return structuredClone(journal.result);
        }
        if (
          ['applying_writeback', 'partial_success'].includes(journal.state)
          && journal.pending_writeback
        ) {
          let settled;
          let projection;
          try {
            ({ settled, projection } = await chatWriteCoordinator.run(
              runScope.chat_id,
              async () => {
                const committedTurn = await stateHistory.commitTurn(
                  structuredClone(
                    journal.pending_writeback.commit_input,
                  ),
                );
                await activateCommittedCandidate(stateHistory, runScope);
                const rebuilt = await rebuildDynamicProjection(
                  projector,
                  runScope,
                );
                return {
                  settled: committedTurn,
                  projection: rebuilt,
                };
              },
            ));
          } catch (error) {
            await runJournal.checkpoint({
              chatId: runScope.chat_id,
              runId,
              requestHash,
              patch: { state: 'partial_success' },
            });
            throw new MnemosyneRequestError(
              'root_turn_partial_success',
              'The final prose is sealed but memory writeback still needs recovery.',
              {
                body_hash: journal.committed?.body_hash ?? null,
                cause: error.reasonCode ?? error.message,
              },
            );
          }
          const recovered = rootTurnResult({
            runId,
            committed: journal.committed,
            model: journal.pending_writeback.model,
            aggregateUsage: journal.pending_writeback.aggregate_usage,
            mode: journal.pending_writeback.mode,
            patchId: settled.patch_id,
            projection,
          });
          const recoveredWriteback = {
            status: 'applied',
            patch_id: settled.patch_id,
            body_hash: settled.body_hash,
            delta_hash: settled.delta_hash,
            projection,
          };
          const recoveredTranscript = [
            ...(Array.isArray(journal.transcript)
              ? structuredClone(journal.transcript)
              : []),
            toolResultMessage(
              journal.pending_writeback.call_id,
              'memory_write_turn_delta',
              recoveredWriteback,
            ),
          ];
          await runJournal.checkpoint({
            chatId: runScope.chat_id,
            runId,
            requestHash,
            patch: {
              state: 'completed',
              pending_writeback: null,
              model: journal.pending_writeback.model,
              aggregate_usage:
                journal.pending_writeback.aggregate_usage,
              transcript: recoveredTranscript,
              result: recovered,
            },
            event: {
              type: 'writeback_recovered',
              call_id: journal.pending_writeback.call_id,
              tool: 'memory_write_turn_delta',
              result: recoveredWriteback,
              result_hash: sha256(canonicalJson(recoveredWriteback)),
            },
          });
          return recovered;
        }
        if (begun.status === 'existing') {
          if (
            journal.retrieval_contract_version
              !== RETRIEVAL_CONTRACT_VERSION
          ) {
            fail(
              'root_turn_recovery_contract_stale',
              'The existing run journal uses a stale retrieval contract.',
            );
          }
          if (!['running', 'body_committed'].includes(journal.state)) {
            fail(
              'root_turn_recovery_incomplete',
              'The existing run journal is not in a resumable state.',
            );
          }
          if (!Array.isArray(journal.transcript)) {
            fail(
              'root_turn_recovery_incomplete',
              'The existing run journal has no replayable tool transcript.',
            );
          }
          if (journal.transcript.length > 0) {
            messages = await appendPromptStep(
              promptLock,
              lockedMessages,
              journal.transcript,
            );
          }
          consumedToolSteps = journal.transcript.filter(
            message => message?.role === 'assistant',
          ).length;
          writebackCorrections = (journal.events ?? []).filter(
            event => (
              event?.type === 'tool_rejected'
              && event.tool === 'memory_write_turn_delta'
            ),
          ).length;
          retrievalCorrections = (journal.events ?? []).filter(
            event => (
              event?.type === 'tool_rejected'
              && ['memory_search', 'memory_read'].includes(event.tool)
            ),
          ).length;
          protocolCorrections = (journal.events ?? []).filter(
            event => (
              event?.type === 'model_step_rejected'
              && event.tool === 'main_ai_tool_protocol'
            ),
          ).length;
          committed = journal.committed === null
            ? null
            : structuredClone(journal.committed);
          requiredContinuationCursors =
            requiredContinuationCursorsFromEvents(journal.events);
          model = journal.model ?? model;
          aggregateUsage.prompt_tokens = Number(
            journal.aggregate_usage?.prompt_tokens ?? 0,
          );
          aggregateUsage.completion_tokens = Number(
            journal.aggregate_usage?.completion_tokens ?? 0,
          );
        }
      }

      for (
        let step = consumedToolSteps;
        step < maxToolSteps;
        step += 1
      ) {
        if (signal?.aborted) {
          fail('root_turn_cancelled', 'The root turn was cancelled.');
        }
        await assertPromptSpine(promptLock, messages);
        const response = await provider.completeToolStep({
          runId,
          stepIndex: step,
          providerBudget:
            runEvidence?.provider_budget
              ? structuredClone(runEvidence.provider_budget)
              : null,
          creativeRequest: {
            ...structuredClone(requestBody),
            messages: undefined,
            tools: undefined,
            tool_choice: undefined,
            parallel_tool_calls: undefined,
            stream: false,
          },
          messages: structuredClone(messages),
          tools: structuredClone(toolSchemas(
            Boolean(committed),
            memoryReader,
            maxMemoryReadTokens,
            requiredContinuationCursors.size,
          )),
          toolChoice: 'required',
          parallelToolCalls: false,
          authContext: providerAuthContext,
          signal,
        });
        model = response?.model ?? model;
        addUsage(aggregateUsage, response?.usage);
        let parsed;
        try {
          parsed = parseToolCall(response);
        } catch (error) {
          const protocolCalls =
            response?.assistant_message?.tool_calls;
          const correctableProtocolError = (
            error?.reasonCode === 'main_ai_tool_protocol_invalid'
            && Array.isArray(protocolCalls)
            && protocolCalls.length > 1
            && protocolCalls.every(call => (
              typeof call?.id === 'string'
              && call.id
              && typeof call?.function?.name === 'string'
              && call.function.name
              && typeof call?.function?.arguments === 'string'
            ))
          );
          if (!correctableProtocolError) {
            if (runJournal) {
              await runJournal.checkpoint({
                chatId: runScope.chat_id,
                runId,
                requestHash,
                patch: {
                  state: 'failed',
                  model,
                  aggregate_usage: aggregateUsage,
                  last_error: {
                    reason_code:
                      error?.reasonCode
                      ?? 'main_ai_tool_protocol_invalid',
                    message: error?.message
                      ?? 'The main model tool protocol is invalid.',
                    retryable: false,
                  },
                },
              });
            }
            throw error;
          }
          protocolCorrections += 1;
          const terminal = (
            protocolCorrections > MAX_PROTOCOL_CORRECTIONS
            || step + 1 >= maxToolSteps
          );
          const correctionMessages = [
            structuredClone(response.assistant_message),
            ...protocolCalls.map(call => toolErrorMessage(
              call.id,
              call.function.name,
              error,
            )),
          ];
          messages = await appendPromptStep(
            promptLock,
            messages,
            correctionMessages,
          );
          if (runJournal) {
            await runJournal.checkpoint({
              chatId: runScope.chat_id,
              runId,
              requestHash,
              patch: {
                state: terminal ? 'failed' : 'running',
                model,
                aggregate_usage: aggregateUsage,
                transcript: transcriptAfterLock(
                  messages,
                  promptLock,
                ),
                ...(terminal
                  ? {
                      last_error: {
                        reason_code: error.reasonCode,
                        message: error.message,
                        retryable: true,
                      },
                    }
                  : {}),
              },
              event: {
                type: 'model_step_rejected',
                tool: 'main_ai_tool_protocol',
                reason_code: error.reasonCode,
                tool_call_count: protocolCalls.length,
                tool_names: protocolCalls.map(
                  call => call.function.name,
                ),
                model: response?.model ?? null,
                usage: structuredClone(response?.usage ?? {}),
              },
            });
          }
          if (terminal) throw error;
          continue;
        }
        const continuationBinding = parsed.name === 'memory_read'
          ? bindSingleRequiredContinuation(
              parsed.args,
              requiredContinuationCursors,
            )
          : null;
        const executionParsed = continuationBinding
          ? {
              ...parsed,
              args: continuationBinding.effectiveArgs,
            }
          : parsed;
        const retrievalIntent =
          executionParsed.name === 'memory_search'
            ? normalizeMemorySearchIntent(executionParsed.args)
            : executionParsed.name === 'memory_read'
              ? normalizeMemoryReadIntent(executionParsed.args)
              : null;
        const rejectCorrectableRetrieval = async error => {
          if (!isCorrectableRetrievalError(error)) throw error;
          retrievalCorrections += 1;
          const terminal = (
            retrievalCorrections > MAX_RETRIEVAL_CORRECTIONS
            || step + 1 >= maxToolSteps
          );
          const errorToolMessage = toolErrorMessage(
            parsed.call.id,
            parsed.name,
            error,
          );
          messages = await appendPromptStep(promptLock, messages, [
            structuredClone(parsed.message),
            errorToolMessage,
          ]);
          if (runJournal) {
            await runJournal.checkpoint({
              chatId: runScope.chat_id,
              runId,
              requestHash,
              patch: {
                state: terminal ? 'failed' : 'running',
                model,
                aggregate_usage: aggregateUsage,
                transcript: transcriptAfterLock(messages, promptLock),
                ...(terminal
                  ? {
                      last_error: {
                        reason_code: error.reasonCode,
                        message: error.message,
                        retryable: true,
                      },
                    }
                  : {}),
              },
              event: toolJournalEvent({
                type: 'tool_rejected',
                parsed: executionParsed,
                error,
                response,
                retrievalIntent,
                modelArguments: continuationBinding
                  ? parsed.args
                  : null,
                argumentBinding:
                  continuationBinding?.audit ?? null,
              }),
            });
          }
          if (terminal) throw error;
        };

        if (parsed.name === 'memory_search') {
          if (committed || !memoryReader?.search) {
            fail(
              'main_ai_tool_unavailable',
              'memory.search is unavailable in the current run state.',
            );
          }
          let searchResult;
          try {
            searchResult = await memoryReader.search({
              chatId: runScope.chat_id,
              query: retrievalIntent.query_hint,
              purpose: retrievalIntent.purpose,
              needs: retrievalIntent.needs,
              scopeRefs: retrievalIntent.scope_refs,
              coverageFacets:
                retrievalIntent.coverage_facets,
              branchId: runScope.branch_id,
              branchEpoch: runScope.branch_epoch,
              turnIndex:
                runScope.memory_turn_index
                ?? runScope.turn_index,
              limit: retrievalIntent.limit,
            });
            validateMemorySearchResult(searchResult);
          } catch (error) {
            await rejectCorrectableRetrieval(error);
            continue;
          }
          const searchToolMessage = toolResultMessage(
            parsed.call.id,
            parsed.name,
            searchResult,
          );
          messages = await appendPromptStep(promptLock, messages, [
            structuredClone(parsed.message),
            searchToolMessage,
          ]);
          if (runJournal) {
            await runJournal.checkpoint({
              chatId: runScope.chat_id,
              runId,
              requestHash,
              patch: {
                state: 'running',
                model,
                aggregate_usage: aggregateUsage,
                transcript: transcriptAfterLock(messages, promptLock),
              },
              event: toolJournalEvent({
                parsed,
                result: searchResult,
                response,
                retrievalIntent,
              }),
            });
          }
          continue;
        }

        if (parsed.name === 'memory_read') {
          if (
            committed
            || !memoryReader?.read
          ) {
            fail(
              'main_ai_tool_unavailable',
              'memory.read is unavailable or its refs are invalid.',
            );
          }
          let readResult;
          try {
            validateMemoryReadRequest(
              executionParsed.args,
              maxMemoryReadTokens,
            );
            if (
              requiredContinuationCursors.size > 0
              && !executionParsed.args.refs.some(
                ref => requiredContinuationCursors.has(ref),
              )
            ) {
              fail(
                'memory_read_continuation_required',
                'The next memory read must consume an issued continuation cursor.',
                {
                  correction:
                    'retry_with_issued_continuation_cursor',
                },
              );
            }
            const readScope = memoryReadScope(runScope);
            const selectors = executionParsed.args.refs.map(
              ref => parseMemoryReadSelector(ref, {
                cursorSecret: memoryCursorSecret,
                scope: readScope,
                retrievalContractVersion: RETRIEVAL_CONTRACT_VERSION,
              }),
            );
            const reads = await Promise.all(selectors.map(selector => (
              memoryReader.read({
                chatId: runScope.chat_id,
                ref: selector.ref,
                branchId: runScope.branch_id,
                branchEpoch: runScope.branch_epoch,
                turnIndex:
                  runScope.memory_turn_index
                  ?? runScope.turn_index,
              })
            )));
            readResult = createBoundedMemoryReadResult({
              selectors,
              readResults: reads,
              maxTokens: executionParsed.args.max_tokens,
              cursorSecret: memoryCursorSecret,
              scope: readScope,
              retrievalContractVersion: RETRIEVAL_CONTRACT_VERSION,
              maxAllowedTokens: maxMemoryReadTokens,
              measureSerializedResultTokens: result => {
                const serialized = toolResultMessage(
                  parsed.call.id,
                  parsed.name,
                  result,
                ).content;
                return memoryToolTokenMeasure(serialized);
              },
            });
            for (const ref of executionParsed.args.refs) {
              requiredContinuationCursors.delete(ref);
            }
            for (
              const cursor
              of readResult.continuation_cursors ?? []
            ) {
              if (typeof cursor === 'string' && cursor) {
                requiredContinuationCursors.add(cursor);
              }
            }
          } catch (error) {
            const correctedError = (
              error?.reasonCode
                === 'memory_read_budget_too_small'
            )
              ? new MnemosyneRequestError(
                  error.reasonCode,
                  error.message,
                  {
                    ...(error.details ?? {}),
                    requested_max_tokens:
                      executionParsed.args.max_tokens,
                    configured_max_tokens:
                      maxMemoryReadTokens,
                    correction:
                      'retry_with_configured_max_tokens',
                  },
                )
              : error;
            await rejectCorrectableRetrieval(correctedError);
            continue;
          }
          const readToolMessage = toolResultMessage(
            parsed.call.id,
            parsed.name,
            readResult,
          );
          messages = await appendPromptStep(promptLock, messages, [
            structuredClone(parsed.message),
            readToolMessage,
          ]);
          if (runJournal) {
            await runJournal.checkpoint({
              chatId: runScope.chat_id,
              runId,
              requestHash,
              patch: {
                state: 'running',
                model,
                aggregate_usage: aggregateUsage,
                transcript: transcriptAfterLock(messages, promptLock),
              },
              event: toolJournalEvent({
                parsed: executionParsed,
                result: readResult,
                response,
                retrievalIntent,
                modelArguments: continuationBinding
                  ? parsed.args
                  : null,
                argumentBinding:
                  continuationBinding?.audit ?? null,
              }),
            });
          }
          continue;
        }

        if (parsed.name === 'story_commit') {
          if (
            typeof parsed.args?.body !== 'string'
            || !parsed.args.body.trim()
          ) {
            fail(
              'story_commit_body_invalid',
              'story.commit requires non-empty final prose.',
            );
          }
          const bodyHash = sha256(parsed.args.body);
          if (committed && committed.body_hash !== bodyHash) {
            fail(
              'story_commit_already_locked',
              'The root turn already locked different final prose.',
            );
          }
          committed ??= {
            commit_id: `commit_${sha256(`${runId}:${bodyHash}`).slice(0, 24)}`,
            body: parsed.args.body,
            body_hash: bodyHash,
          };
          const commitResult = {
            commit_id: committed.commit_id,
            body_hash: committed.body_hash,
            byte_length: Buffer.byteLength(committed.body, 'utf8'),
            span_map_version: 1,
            status: 'locked',
          };
          const commitToolMessage = toolResultMessage(
            parsed.call.id,
            parsed.name,
            commitResult,
          );
          messages = await appendPromptStep(promptLock, messages, [
            structuredClone(parsed.message),
            commitToolMessage,
          ]);
          if (runJournal) {
            await runJournal.checkpoint({
              chatId: runScope.chat_id,
              runId,
              requestHash,
              patch: {
                state: 'body_committed',
                committed,
                model,
                aggregate_usage: aggregateUsage,
                transcript: transcriptAfterLock(messages, promptLock),
              },
              event: toolJournalEvent({
                parsed,
                result: commitResult,
                response,
              }),
            });
          }
          continue;
        }

        if (parsed.name === 'memory_write_turn_delta') {
          if (!committed) {
            fail(
              'story_commit_required',
              'Memory writeback cannot run before story.commit.',
            );
          }
          if (parsed.args?.commit_id !== committed.commit_id) {
            fail(
              'turn_delta_commit_mismatch',
              'Memory writeback does not reference the locked story commit.',
            );
          }
          let settled;
          let commitInput;
          let projection;
          try {
            const writebackReason = normalizeWritebackReason(
              parsed.args.reason,
            );
            commitInput = {
              chatId: runScope.chat_id,
              runId,
              turnId: runScope.turn_id,
              candidateId: runScope.candidate_id,
              turnIndex: runScope.turn_index,
              branchId: runScope.branch_id,
              branchEpoch: runScope.branch_epoch,
              swipeId: runScope.swipe_id,
              enforcePromisePayoffGrounding: true,
              userMessage: lastUserMessage(lockedMessages),
              assistantMessage: {
                role: 'assistant',
                content: committed.body,
              },
              promptSpineHash: promptLock.hash,
              delta: {
                mode: parsed.args.mode,
                reason: writebackReason,
                records: normalizeProviderTurnRecords(
                  parsed.args.records,
                  committed.body,
                  {
                    turnId: runScope.turn_id,
                    candidateId: runScope.candidate_id,
                  },
                ),
              },
            };
            if (runJournal) {
              await runJournal.checkpoint({
                chatId: runScope.chat_id,
                runId,
                requestHash,
                patch: {
                  state: 'applying_writeback',
                  model,
                  aggregate_usage: aggregateUsage,
                  transcript: [
                    ...transcriptAfterLock(messages, promptLock),
                    structuredClone(parsed.message),
                  ],
                  pending_writeback: {
                    mode: parsed.args.mode,
                    commit_input: commitInput,
                    model,
                    aggregate_usage: aggregateUsage,
                    call_id: parsed.call.id,
                  },
                },
                event: toolJournalEvent({
                  type: 'tool_started',
                  parsed,
                  response,
                }),
              });
            }
            ({ settled, projection } = await chatWriteCoordinator.run(
              runScope.chat_id,
              async () => {
                const committedTurn = await stateHistory.commitTurn(
                  commitInput,
                );
                await activateCommittedCandidate(stateHistory, runScope);
                const rebuilt = await rebuildDynamicProjection(
                  projector,
                  runScope,
                );
                return {
                  settled: committedTurn,
                  projection: rebuilt,
                };
              },
            ));
          } catch (error) {
            if (
              isCorrectableWritebackError(error)
              && writebackCorrections
                < MAX_WRITEBACK_CORRECTIONS
            ) {
              writebackCorrections += 1;
              const errorToolMessage = toolErrorMessage(
                parsed.call.id,
                parsed.name,
                error,
              );
              messages = await appendPromptStep(promptLock, messages, [
                structuredClone(parsed.message),
                errorToolMessage,
              ]);
              if (runJournal) {
                await runJournal.checkpoint({
                  chatId: runScope.chat_id,
                  runId,
                  requestHash,
                  patch: {
                    state: 'body_committed',
                    pending_writeback: null,
                    model,
                    aggregate_usage: aggregateUsage,
                    transcript: transcriptAfterLock(messages, promptLock),
                  },
                  event: toolJournalEvent({
                    type: 'tool_rejected',
                    parsed,
                    error,
                    response,
                  }),
                });
              }
              continue;
            }
            if (runJournal) {
              const correctable =
                isCorrectableWritebackError(error);
              if (correctable) {
                messages = await appendPromptStep(
                  promptLock,
                  messages,
                  [
                    structuredClone(parsed.message),
                    toolErrorMessage(
                      parsed.call.id,
                      parsed.name,
                      error,
                    ),
                  ],
                );
                await runJournal.checkpoint({
                  chatId: runScope.chat_id,
                  runId,
                  requestHash,
                  patch: {
                    state: 'partial_success',
                    pending_writeback: null,
                    transcript:
                      transcriptAfterLock(messages, promptLock),
                    last_error: {
                      reason_code: error.reasonCode,
                      message: error.message,
                      retryable: false,
                    },
                  },
                  event: toolJournalEvent({
                    type: 'tool_rejected',
                    parsed,
                    error,
                    response,
                  }),
                });
              } else {
                await runJournal.checkpoint({
                  chatId: runScope.chat_id,
                  runId,
                  requestHash,
                  patch: {
                    state: 'partial_success',
                    last_error: {
                      reason_code: 'writeback_failed',
                      message: error.message,
                      retryable: true,
                    },
                  },
                });
              }
              throw new MnemosyneRequestError(
                'root_turn_partial_success',
                'The final prose is sealed but memory writeback did not finish.',
                {
                  body_hash: committed.body_hash,
                  cause: error.reasonCode ?? error.message,
                },
              );
            }
            throw error;
          }
          const result = rootTurnResult({
            runId,
            committed,
            model,
            aggregateUsage,
            mode: parsed.args.mode,
            patchId: settled.patch_id,
            projection,
          });
          if (runJournal) {
            const writebackResult = {
              status: 'applied',
              patch_id: settled.patch_id,
              body_hash: settled.body_hash,
              delta_hash: settled.delta_hash,
              projection,
            };
            const finalTranscript = [
              ...transcriptAfterLock(messages, promptLock),
              structuredClone(parsed.message),
              toolResultMessage(
                parsed.call.id,
                parsed.name,
                writebackResult,
              ),
            ];
            await runJournal.checkpoint({
              chatId: runScope.chat_id,
              runId,
              requestHash,
              patch: {
                state: 'completed',
                pending_writeback: null,
                model,
                aggregate_usage: aggregateUsage,
                transcript: finalTranscript,
                result,
              },
              event: toolJournalEvent({
                parsed,
                result: writebackResult,
                response,
              }),
            });
            // M10 journal-stage quality telemetry: strictly after the turn
            // is completed, so a pass failure can only degrade to a
            // pass_failed journal event, never block the reply.
            if (qualityTelemetry) {
              try {
                const qualityEvent =
                  await qualityTelemetry.buildJournalEvent({
                    runScope,
                    committedBody: committed.body,
                    deltaMode: parsed.args.mode,
                    recordCount: commitInput.delta.records.length,
                  });
                await runJournal.checkpoint({
                  chatId: runScope.chat_id,
                  runId,
                  requestHash,
                  patch: {},
                  event: qualityEvent,
                });
              } catch (error) {
                try {
                  await runJournal.checkpoint({
                    chatId: runScope.chat_id,
                    runId,
                    requestHash,
                    patch: {},
                    event: {
                      type: 'quality_metrics_pass_failed',
                      reason_code:
                        error?.reasonCode
                        ?? 'quality_metrics_pass_failed',
                    },
                  });
                } catch {
                  // Telemetry must never affect the completed turn.
                }
              }
            }
            // M12 rule-only dark run: advisory counts are sealed after
            // writeback and have no prompt or commit consumer.
            if (continuityRules) {
              try {
                const rulesEvent =
                  await continuityRules.buildJournalEvent({ runScope });
                await runJournal.checkpoint({
                  chatId: runScope.chat_id,
                  runId,
                  requestHash,
                  patch: {},
                  event: rulesEvent,
                });
              } catch (error) {
                try {
                  await runJournal.checkpoint({
                    chatId: runScope.chat_id,
                    runId,
                    requestHash,
                    patch: {},
                    event: {
                      type: 'continuity_rules_pass_failed',
                      reason_code:
                        error?.reasonCode
                        ?? 'continuity_rules_pass_failed',
                    },
                  });
                } catch {
                  // Rule telemetry must never affect the completed turn.
                }
              }
            }
          }
          return result;
        }

        fail(
          'main_ai_tool_unavailable',
          `Tool ${parsed.name} is not available in the current run state.`,
        );
      }

      fail(
        'main_ai_tool_budget_exhausted',
        'The root turn exceeded its tool-step budget.',
      );
      } finally {
        activeRuns.delete(activeRunKey);
      }
    },
  });
}
