/**
 * In-memory live run progress store (design 4.2).
 *
 * The Run Kernel emits progress events through its `onProgress` seam; this
 * store keeps only a bounded, de-identified projection of them so the
 * extension can poll a "what is the runtime doing right now" snapshot.
 *
 * Hard rule: nothing that reaches this store may carry story prose, memory
 * bodies, tool arguments, tool results, journal text or file paths. Only
 * stage names, tool names, step indexes, counts, timestamps and error codes
 * are retained, and every retained field is copied explicitly.
 */

export const LIVE_RUN_ACTIVITY_CAPABILITY_VERSION =
  'mnemosyne.live-run-activity.v1';

export const LIVE_RUN_STAGES = Object.freeze([
  'starting',
  'provider_call',
  'memory_search',
  'memory_read',
  'story_commit',
  'memory_write',
  'completed',
  'failed',
  'aborted',
]);

const DEFAULT_MAX_CHATS = 8;
const DEFAULT_MAX_EVENTS_PER_ATTEMPT = 200;
const DEFAULT_MAX_ATTEMPTS_PER_CHAT = 4;

const KNOWN_EVENT_TYPES = new Set([
  'run_started',
  'provider_call_started',
  'provider_call_finished',
  'tool_started',
  'tool_finished',
  'tool_rejected',
  'tool_failed',
  'run_completed',
  'run_failed',
  'run_aborted',
]);

const TERMINAL_STATE_BY_TYPE = new Map([
  ['run_completed', 'completed'],
  ['run_failed', 'failed'],
  ['run_aborted', 'aborted'],
]);

const STAGE_BY_TOOL = new Map([
  ['memory_search', 'memory_search'],
  ['memory_read', 'memory_read'],
  ['story_commit', 'story_commit'],
  ['memory_write_turn_delta', 'memory_write'],
]);

const COUNT_META_KEYS = Object.freeze([
  'searchHits',
  'readItems',
  'writtenItems',
]);

function safeString(value) {
  return typeof value === 'string' && value ? value : null;
}

function safeStep(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeTimestamp(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function createAttemptState({
  chatId,
  runId,
  attemptId,
  at,
  registration,
}) {
  return {
    chatId,
    runId,
    attemptId,
    registration,
    state: 'running',
    startedAt: at,
    currentStage: 'starting',
    stageStartedAt: at,
    step: 0,
    counts: {
      searchHits: 0,
      readItems: 0,
      writtenItems: 0,
    },
    events: [],
    errorCode: null,
    lastSeq: -1,
  };
}

function applyStage(attempt, stage, at) {
  if (attempt.currentStage === stage) return;
  attempt.currentStage = stage;
  attempt.stageStartedAt = at;
}

function applyEvent(attempt, entry, meta) {
  const { type, tool, step, at } = entry;
  if (step !== null) attempt.step = step;
  if (type === 'run_started') {
    applyStage(attempt, 'starting', at);
    return;
  }
  if (
    type === 'provider_call_started'
    || type === 'provider_call_finished'
  ) {
    applyStage(attempt, 'provider_call', at);
    return;
  }
  if (type === 'tool_started') {
    applyStage(attempt, STAGE_BY_TOOL.get(tool) ?? 'provider_call', at);
    return;
  }
  if (type === 'tool_finished') {
    for (const key of COUNT_META_KEYS) {
      if (meta && Object.hasOwn(meta, key)) {
        attempt.counts[key] += safeCount(meta[key]);
      }
    }
    return;
  }
  if (type === 'tool_rejected' || type === 'tool_failed') {
    if (entry.code) attempt.errorCode = entry.code;
    return;
  }
  const terminalState = TERMINAL_STATE_BY_TYPE.get(type);
  if (!terminalState) return;
  attempt.state = terminalState;
  applyStage(attempt, terminalState, at);
  if (type === 'run_failed') {
    attempt.errorCode = entry.code ?? attempt.errorCode;
  }
  if (type === 'run_completed') {
    attempt.errorCode = null;
  }
}

function runDto(attempt) {
  if (!attempt) return null;
  return {
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    chatId: attempt.chatId,
    startedAt: attempt.startedAt,
    currentStage: attempt.currentStage,
    stageStartedAt: attempt.stageStartedAt,
    step: attempt.step,
    counts: {
      searchHits: attempt.counts.searchHits,
      readItems: attempt.counts.readItems,
      writtenItems: attempt.counts.writtenItems,
    },
    events: attempt.events.map(entry => ({
      seq: entry.seq,
      at: entry.at,
      type: entry.type,
      tool: entry.tool,
      step: entry.step,
      code: entry.code,
    })),
    errorCode: attempt.errorCode,
  };
}

export function createLiveRunActivity({
  maxChats = DEFAULT_MAX_CHATS,
  maxEventsPerAttempt = DEFAULT_MAX_EVENTS_PER_ATTEMPT,
  maxAttemptsPerChat = DEFAULT_MAX_ATTEMPTS_PER_CHAT,
} = {}) {
  if (!Number.isSafeInteger(maxChats) || maxChats < 1) {
    throw new Error('Live run activity maxChats must be positive.');
  }
  if (
    !Number.isSafeInteger(maxEventsPerAttempt)
    || maxEventsPerAttempt < 1
  ) {
    throw new Error(
      'Live run activity maxEventsPerAttempt must be positive.',
    );
  }
  if (
    !Number.isSafeInteger(maxAttemptsPerChat)
    || maxAttemptsPerChat < 2
  ) {
    throw new Error(
      'Live run activity maxAttemptsPerChat must be at least two.',
    );
  }

  // Insertion-ordered Map doubles as the LRU list: touched chats are
  // re-inserted at the tail, and the head is evicted when the cap is hit.
  const chats = new Map();
  let revision = 0;
  // Monotonic first-seen order across all attempts. The kernel emits
  // run_started as an attempt's first event, so registration order is
  // attempt start order, and only a strictly newer attempt may take the
  // current pointer. Interleaved events from an older, still-running
  // attempt land in that attempt's own partition and never rewind current.
  let registrationCounter = 0;

  function touchChat(chatId) {
    const existing = chats.get(chatId);
    if (existing) {
      chats.delete(chatId);
      chats.set(chatId, existing);
      return existing;
    }
    const created = {
      attempts: new Map(),
      currentId: null,
      previousId: null,
    };
    chats.set(chatId, created);
    while (chats.size > maxChats) {
      const oldest = chats.keys().next();
      if (oldest.done || oldest.value === chatId) break;
      chats.delete(oldest.value);
    }
    return created;
  }

  function pruneAttempts(chat) {
    while (chat.attempts.size > maxAttemptsPerChat) {
      let evictId = null;
      let evictRegistration = Infinity;
      for (const [id, attempt] of chat.attempts) {
        if (id === chat.currentId || id === chat.previousId) continue;
        if (attempt.registration < evictRegistration) {
          evictRegistration = attempt.registration;
          evictId = id;
        }
      }
      if (evictId === null) return;
      chat.attempts.delete(evictId);
    }
  }

  function partitionFor(chat, { chatId, runId, attemptId, at }) {
    const existing = chat.attempts.get(attemptId);
    if (existing) return existing;
    registrationCounter += 1;
    const created = createAttemptState({
      chatId,
      runId,
      attemptId,
      at,
      registration: registrationCounter,
    });
    chat.attempts.set(attemptId, created);
    const current = chat.currentId === null
      ? null
      : chat.attempts.get(chat.currentId) ?? null;
    if (!current || created.registration > current.registration) {
      chat.previousId = chat.currentId;
      chat.currentId = attemptId;
    }
    pruneAttempts(chat);
    return created;
  }

  return Object.freeze({
    capability_version: LIVE_RUN_ACTIVITY_CAPABILITY_VERSION,
    max_chats: maxChats,
    max_events_per_attempt: maxEventsPerAttempt,
    max_attempts_per_chat: maxAttemptsPerChat,

    emit(event) {
      const type = safeString(event?.type);
      const attemptId = safeString(event?.attemptId);
      if (!type || !attemptId || !KNOWN_EVENT_TYPES.has(type)) return;
      const chatId = safeString(event?.chatId);
      const runId = safeString(event?.runId) ?? attemptId;
      const at = safeTimestamp(event?.at, Date.now());
      const entry = {
        seq: Number.isSafeInteger(event?.seq) ? event.seq : 0,
        at,
        type,
        tool: safeString(event?.tool),
        step: safeStep(event?.step),
        code: safeString(event?.code) ?? safeString(event?.reason),
      };

      const chat = touchChat(chatId);
      const attempt = partitionFor(chat, {
        chatId,
        runId,
        attemptId,
        at,
      });
      if (entry.seq <= attempt.lastSeq) return;
      attempt.lastSeq = entry.seq;

      attempt.events.push(entry);
      while (attempt.events.length > maxEventsPerAttempt) {
        attempt.events.shift();
      }
      applyEvent(
        attempt,
        entry,
        event?.meta && typeof event.meta === 'object'
          ? event.meta
          : null,
      );
      revision += 1;
    },

    snapshot({ chatId = null } = {}) {
      const chat = chats.get(safeString(chatId));
      const current = chat?.currentId
        ? chat.attempts.get(chat.currentId) ?? null
        : null;
      const previous = chat?.previousId
        ? chat.attempts.get(chat.previousId) ?? null
        : null;
      return {
        state: current ? current.state : 'idle',
        revision,
        run: runDto(current),
        previous: runDto(previous),
      };
    },
  });
}
