// Self-contained floating widget: shows live progress of the current
// Mnemosyne run (memory recall -> provider call -> writeback) by polling
// the `activity/live` control operation while a host generation is in
// flight. Owns its own DOM (lazily mounted on document.body) so that
// index.js only needs to construct this controller and wire host
// generation events into it.

const POLL_INTERVAL_MS = 500;
const POLL_BACKOFF_MS = 2000;
const POLL_TIMEOUT_MS = 3000;
const FAILURE_BACKOFF_THRESHOLD = 3;
const IDLE_DEGRADE_POLL_THRESHOLD = 6;
const ENDED_FAST_POLL_MS = 250;
const ENDED_FINALIZE_TIMEOUT_MS = 4000;
const ABORT_FALLBACK_TIMEOUT_MS = 15000;
const SUCCESS_FADE_DELAY_MS = 4000;
const ABORTED_FADE_DELAY_MS = 2000;
// A send that is being held (intake / history-edit reconciliation gating
// GENERATION_AFTER_COMMANDS) does not render right away: most rounds
// resolve in milliseconds, and revealing-then-instantly-hiding the pill
// would read as a flicker. Only a hold that outlives this window shows.
const HELD_REVEAL_DELAY_MS = 400;
const TRANSITION_MS = 180;
const TICK_INTERVAL_MS = 250;
const MAX_TIMELINE_STEPS = 8;
// Baseline runId+attemptId is captured by an immediate probe poll fired
// right at generation start. A later snapshot is accepted as "this
// generation's" run only once its runId+attemptId differs from that
// baseline, or its startedAt is within this tolerance of local
// generation-start time (covers the race where the real run already
// existed at probe time). See createRunStatusFloatController for details.
const STALE_ACCEPT_TOLERANCE_MS = 10000;

const TERMINAL_STATES = new Set(['completed', 'failed', 'aborted']);
const RUN_LEVEL_EVENT_TYPES = new Set([
  'run_started',
  'run_completed',
  'run_failed',
  'run_aborted',
]);

const STAGE_LABELS = Object.freeze({
  starting: '准备中',
  provider_call: '模型生成中',
  memory_search: '搜索记忆',
  memory_read: '阅读记忆',
  story_commit: '提交正文',
  memory_write: '写入记忆',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
});

const TOOL_LABELS = Object.freeze({
  memory_search: '搜索记忆',
  memory_read: '阅读记忆',
  story_commit: '提交正文',
  memory_write: '写入记忆',
});

// CSS only ships dot/text colors for the original 9 kinds. held/blocked are
// new UI states, not new visual languages, so they borrow the nearest
// existing look instead of growing style.css: held reads as an in-progress
// amber (same as aborting), blocked as a persistent red (same as failed).
const STYLE_KIND = Object.freeze({ held: 'aborting', blocked: 'failed' });

// Human text for a `Blocked: <reason_code>` report. Kept here (not in
// index.js's BLOCK_REASON_TEXT) because only the float needs the second
// "what to do about it" field, and only the float renders it inline instead
// of stripping it for the settings-drawer text node.
const BLOCK_REASON_FEEDBACK = Object.freeze({
  history_edit_requires_tail_regeneration: {
    text: '本聊天的结尾消息与记忆记录不一致',
    action: '请用 Regenerate 重生成结尾，或新开一个聊天',
  },
  turn_candidate_lookup_not_found: {
    text: '找不到这条消息对应的记忆轮次',
    action: '请新开聊天，或删除最近几条后重试',
  },
  static_lore_intake_batch_invalid: {
    text: '设定初始化的某一批结果不合规',
    action: '已保留进度，请重试；持续失败请换兼容模型',
  },
  static_lore_initialization_busy: {
    text: '当前聊天存档还没初始化完',
    action: '请等待初始化完成后再发送',
  },
  static_lore_initialization_incomplete: {
    text: '当前聊天存档还没初始化完',
    action: '请等待初始化完成后再发送',
  },
  static_lore_initialization_stalled: {
    text: '当前聊天存档还没初始化完',
    action: '请等待初始化完成后再发送',
  },
  static_lore_reconcile_approval_required: {
    text: '设定有变化，需要你确认合并',
    action: '请在 Mnemosyne 面板点「应用设定合并」',
  },
  agent_proxy_unavailable: {
    text: '记忆运行时没连上',
    action: '请检查代理是否启动后重试',
  },
  upstream_authentication_failed: {
    text: '连接预设的密钥无效',
    action: '请重新连接该预设',
  },
  runtime_profile_operation_busy: {
    text: '上一项运行操作尚未结束',
    action: '请稍候再发送',
  },
  runtime_profile_switch_busy: {
    text: '另一项运行配置切换正在进行',
    action: '请等待切换结束后重试',
  },
  runtime_profile_activation_unavailable: {
    text: '运行配置切换后未能恢复可用状态',
    action: '请检查运行组件后重试',
  },
  runtime_profile_activation_failed: {
    text: '运行配置未能启用',
    action: '已恢复此前配置，请检查连接后重试',
  },
  runtime_profile_activation_mismatch: {
    text: '运行配置没有通过一致性验证',
    action: '请重新选择连接后重试',
  },
  runtime_profile_connection_invalid: {
    text: '当前 Connection Profile 不完整',
    action: '请选择完整的 Custom 连接后重试',
  },
  send_intent_changed: {
    text: '等待期间输入或聊天发生了变化',
    action: '请确认当前输入后重新发送',
  },
  chat_id_missing: {
    text: '还没打开角色聊天',
    action: '请先打开一个角色聊天',
  },
  character_missing: {
    text: '还没打开角色聊天',
    action: '请先打开一个角色聊天',
  },
});

// Matched after an exact BLOCK_REASON_FEEDBACK miss, in order.
const BLOCK_REASON_SUFFIX_FEEDBACK = Object.freeze([
  {
    suffix: '_binding_mismatch',
    text: '连接绑定与本轮不一致',
    action: '请重新选择连接预设后重试',
  },
  {
    suffix: '_operation_active',
    text: '有另一个操作正在进行',
    action: '请等它结束后再发送',
  },
]);

const BLOCK_REASON_FALLBACK = Object.freeze({
  text: '生成被内部检查拦截',
  action: '请重试；持续失败请展开查看代码',
});

// Matching order: exact code -> suffix family -> fallback. Only the
// fallback exposes the raw code inline; matched codes keep it out of the
// pill and let the expanded card show it instead (see renderTimeline).
function resolveBlockFeedback(code) {
  if (!code) return BLOCK_REASON_FALLBACK;
  // hasOwn guard (P2 #1): reason_code is server-controlled text, and a
  // plain object literal inherits from Object.prototype. Without this, a
  // legal-but-unlisted code like 'constructor' or 'toString' reads back
  // the inherited function instead of undefined, and renders as the
  // nonsensical "undefined · undefined" instead of falling through to the
  // fallback below.
  const exact = Object.hasOwn(BLOCK_REASON_FEEDBACK, code)
    ? BLOCK_REASON_FEEDBACK[code]
    : undefined;
  if (exact) return exact;
  const suffixMatch = BLOCK_REASON_SUFFIX_FEEDBACK.find(
    ({ suffix }) => code.endsWith(suffix),
  );
  if (suffixMatch) return suffixMatch;
  return {
    text: `${BLOCK_REASON_FALLBACK.text}（码：${code}）`,
    action: BLOCK_REASON_FALLBACK.action,
  };
}

// Third-round Codex fix: onBlocked's "preserve the on-screen intake batch
// detail" branch must only fire when the new reason is actually about that
// same intake/initialization attempt. The prior open-ended
// startsWith('static_lore_') / includes('_initialization_') over-matched —
// codes shaped like static_lore_source_drift or a hypothetical
// *_initialization_* from another family (production analog:
// upstream_model_binding_mismatch) would also wrongly
// preserve the stale batch text. Closed whitelist instead, one entry per
// real source so the set can't silently drift from what the gate actually
// reports:
const INTAKE_FAMILY_REASON_CODES = new Set([
  // BLOCK_REASON_FEEDBACK exact-match entries above (design doc §4) that
  // are genuinely about a static-lore intake/initialization attempt:
  'static_lore_intake_batch_invalid',
  // chat-save-initialization-gate.js normalizedResult()'s fallback branch
  // (status is neither complete/waiting_for_approval/retryable, i.e. the
  // gate's own "busy"/deferred case):
  'static_lore_initialization_busy',
  // chat-save-initialization-gate.js normalizedResult()'s 'retryable' case
  // default reasonCode:
  'static_lore_initialization_incomplete',
  // index.js autoRunStaticLoreIntake()'s own stall/step-limit detection:
  'static_lore_initialization_stalled',
  // chat-save-initialization-gate.js normalizedResult()'s
  // 'waiting_for_approval' case:
  'static_lore_reconcile_approval_required',
  // Not in BLOCK_REASON_FEEDBACK's exact table — resolves via the
  // *_binding_mismatch suffix instead — but still the same intake attempt
  // per the design doc's own suffix-family listing (§4).
  'static_lore_intake_capability_binding_mismatch',
]);

function isIntakeFamilyReasonCode(code) {
  return typeof code === 'string' && INTAKE_FAMILY_REASON_CODES.has(code);
}

// Initialization runs before any generation exists, so it has no run to poll
// and no timeline: the capsule shows the batch it is on and keeps counting.
const INTAKE_STAGE_LABEL = '初始化记忆';

function intakeStageText(batchIndex, batchCount) {
  return Number.isFinite(batchIndex) && Number.isFinite(batchCount)
    ? `${INTAKE_STAGE_LABEL} · 第${batchIndex}/${batchCount}批`
    : INTAKE_STAGE_LABEL;
}

function stageLabel(stage, step) {
  const base = STAGE_LABELS[stage] ?? stage ?? '处理中';
  if (stage === 'provider_call' && Number.isFinite(step)) {
    return `${base} · 第${step}步`;
  }
  return base;
}

function numericMs(value) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}

function runKeyOf(run) {
  return `${run.runId}:${run.attemptId}`;
}

function timelineBaseType(eventType) {
  if (eventType.startsWith('provider_call_')) return 'provider_call';
  if (
    eventType.startsWith('tool_started')
    || eventType.startsWith('tool_finished')
    || eventType === 'tool_rejected'
    || eventType === 'tool_failed'
  ) {
    return 'tool';
  }
  return eventType;
}

// Timeline rows are keyed by (tool, step) rather than by literal event
// type, so a tool_started row stays the same row when a later
// tool_rejected/tool_failed/tool_finished event arrives for it.
function timelineKey(baseType, event) {
  if (baseType === 'provider_call') return `provider_call:${event.step ?? ''}`;
  return `tool:${event.step ?? ''}:${event.tool ?? ''}`;
}

function timelineLabel(baseType, event) {
  if (baseType === 'provider_call') {
    return Number.isFinite(event.step)
      ? `模型生成中 · 第${event.step}步`
      : '模型生成中';
  }
  return TOOL_LABELS[event.tool] ?? STAGE_LABELS[baseType] ?? (event.tool ?? baseType);
}

function formatSeconds(value) {
  return `${Math.max(0, value).toFixed(1)}s`;
}

function buildTimelineSteps(events) {
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const order = [];
  const byKey = new Map();
  for (const event of sorted) {
    if (RUN_LEVEL_EVENT_TYPES.has(event.type)) continue;
    const baseType = timelineBaseType(event.type);
    const key = timelineKey(baseType, event);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        label: timelineLabel(baseType, event),
        status: 'active',
        startedAtMs: null,
        finishedAtMs: null,
      };
      byKey.set(key, entry);
      order.push(key);
    }
    const atMs = numericMs(event.at);
    if (event.type.endsWith('_started')) {
      entry.startedAtMs = atMs ?? entry.startedAtMs;
      entry.status = 'active';
    } else if (event.type.endsWith('_finished')) {
      entry.finishedAtMs = atMs ?? entry.finishedAtMs;
      entry.status = 'done';
    } else if (event.type === 'tool_rejected') {
      entry.finishedAtMs = atMs ?? entry.finishedAtMs;
      entry.status = 'rejected';
    } else if (event.type === 'tool_failed') {
      entry.finishedAtMs = atMs ?? entry.finishedAtMs;
      entry.status = 'failed';
    }
  }
  return order.map(key => byKey.get(key)).slice(-MAX_TIMELINE_STEPS);
}

function formatStepDuration(step) {
  if (!Number.isFinite(step.startedAtMs) || !Number.isFinite(step.finishedAtMs)) {
    return '';
  }
  return formatSeconds((step.finishedAtMs - step.startedAtMs) / 1000);
}

function initialState() {
  return {
    visible: false,
    expanded: false,
    kind: 'idle',
    stageText: '',
    elapsedSeconds: 0,
    events: [],
    summaryText: '',
    errorCode: null,
  };
}

function isTerminalKind(kind) {
  return (
    kind === 'completed'
    || kind === 'failed'
    || kind === 'aborted'
    // blocked is not a run outcome (no run ever started) but it shares
    // failed's persistent semantics: stop, show summaryText, offer close,
    // and never let a stray GENERATION_STOPPED downgrade it (see
    // onGenerationStopped below, which relies on this).
    || kind === 'blocked'
  );
}

export function createRunStatusFloatController({
  invoke,
  now = () => Date.now(),
}) {
  if (typeof invoke !== 'function') {
    throw new TypeError(
      'Run status float controller dependencies are invalid.',
    );
  }

  const state = initialState();

  let dom = null;
  let chatId = null;
  let generation = 0;
  let pollToken = 0;
  let polling = false;
  let inFlight = false;
  let pollIntervalMs = POLL_INTERVAL_MS;
  let pollTimer = null;
  let tickTimer = null;
  let fadeTimer = null;
  let finalizeTimer = null;
  let abortTimer = null;
  let heldRevealTimer = null;
  // Signal-driven, not time-driven (P1-3): a held window only reveals once
  // intake actually reports real pending work. HELD_REVEAL_DELAY_MS is
  // still enforced as a floor underneath it (see onSendHeld/onIntakeProgress
  // below), it just stops being sufficient on its own — an already-ready
  // chat's health/transport/prepareIntake confirmation round-trip can
  // easily outlive 400ms on nothing but async latency, and scenario 7
  // requires that to stay invisible.
  let heldSignalSeen = false;
  // Third-round Codex fix: heldSignalSeen alone let a signal arriving
  // before the timer fires (e.g. a real progress event at 150ms) reveal
  // immediately, since revealHeldIfSignaled only checked the signal. This
  // makes the 400ms floor an actual lower bound, not just "usually true":
  // only the reveal timer's own callback sets it, so reveal can only ever
  // happen at max(400ms, time of first signal).
  let heldFloorElapsed = false;
  let failureStreak = 0;
  let idleStreak = 0;
  let degraded = false;
  let aborting = false;
  // undefined = baseline probe not yet answered; null = probe saw no run.
  let baselineRunKey;
  let awaitingNewRun = true;
  let runKey = null;
  let lastRevisionAccepted = -1;
  let localStartedAtMs = null;
  let serverStartedAtMs = null;

  function ensureDom() {
    if (dom) return dom;
    const root = document.createElement('div');
    root.id = 'tavern_mnemosyne_run_status_float';
    root.className = 'mnemosyne-run-status-float';
    root.hidden = true;
    root.innerHTML = `
        <button
            id="tavern_mnemosyne_run_status_pill"
            class="mnemosyne-run-status-pill"
            type="button"
        >
            <span class="mnemosyne-run-status-dot"></span>
            <span
                id="tavern_mnemosyne_run_status_text"
                class="mnemosyne-run-status-text"
            ></span>
            <span
                id="tavern_mnemosyne_run_status_timer"
                class="mnemosyne-run-status-timer"
            ></span>
            <button
                id="tavern_mnemosyne_run_status_close"
                class="mnemosyne-run-status-close"
                type="button"
                aria-label="关闭"
                hidden
            >×</button>
        </button>
        <div
            id="tavern_mnemosyne_run_status_card"
            class="mnemosyne-run-status-card"
            hidden
        >
            <div
                id="tavern_mnemosyne_run_status_timeline"
                class="mnemosyne-run-status-timeline"
            ></div>
        </div>`;
    document.body.append(root);
    const pill = root.querySelector('#tavern_mnemosyne_run_status_pill');
    const close = root.querySelector('#tavern_mnemosyne_run_status_close');
    pill?.addEventListener('click', event => {
      if (event.target === close) return;
      state.expanded = !state.expanded;
      render();
    });
    close?.addEventListener('click', event => {
      event.stopPropagation();
      dismiss();
    });
    dom = {
      root,
      pill,
      close,
      text: root.querySelector('#tavern_mnemosyne_run_status_text'),
      timer: root.querySelector('#tavern_mnemosyne_run_status_timer'),
      card: root.querySelector('#tavern_mnemosyne_run_status_card'),
      timeline: root.querySelector('#tavern_mnemosyne_run_status_timeline'),
    };
    return dom;
  }

  function renderTimeline() {
    const { timeline } = ensureDom();
    timeline.innerHTML = '';
    // failed/blocked keep the raw reason code out of the compact pill (see
    // resolveBlockFeedback) but still surface it here once the card is
    // expanded, reusing the plain step row style so style.css needs no new
    // rule for it.
    if (state.errorCode) {
      const codeRow = document.createElement('div');
      codeRow.className = 'mnemosyne-run-status-step';
      codeRow.textContent = state.errorCode;
      timeline.append(codeRow);
    }
    for (const step of buildTimelineSteps(state.events)) {
      const row = document.createElement('div');
      row.className = 'mnemosyne-run-status-step';
      row.dataset.status = step.status;
      const icon = document.createElement('span');
      icon.className = 'mnemosyne-run-status-step-icon';
      icon.textContent = (
        step.status === 'done' ? '✓'
        : step.status === 'rejected' ? '⚠'
        : step.status === 'failed' ? '✗'
        : ''
      );
      const label = document.createElement('span');
      label.className = 'mnemosyne-run-status-step-label';
      label.textContent = step.label;
      const duration = document.createElement('span');
      duration.className = 'mnemosyne-run-status-step-duration';
      duration.textContent = formatStepDuration(step);
      row.append(icon, label, duration);
      timeline.append(row);
    }
  }

  function render() {
    const view = ensureDom();
    view.root.hidden = !state.visible;
    if (!state.visible) return;
    view.root.dataset.kind = STYLE_KIND[state.kind] ?? state.kind;
    const terminal = isTerminalKind(state.kind);
    view.text.textContent = terminal ? state.summaryText : state.stageText;
    view.timer.hidden = terminal;
    view.timer.textContent = formatSeconds(state.elapsedSeconds);
    view.close.hidden = state.kind !== 'failed' && state.kind !== 'blocked';
    view.card.hidden = !state.expanded;
    if (state.expanded) renderTimeline();
  }

  function clearWrapUpTimers() {
    clearTimeout(fadeTimer);
    clearTimeout(finalizeTimer);
    clearTimeout(abortTimer);
    fadeTimer = null;
    finalizeTimer = null;
    abortTimer = null;
    ensureDom().root.classList.remove('mnemosyne-run-status-float--fading');
  }

  function clearAllTimers() {
    clearTimeout(pollTimer);
    clearInterval(tickTimer);
    clearTimeout(heldRevealTimer);
    pollTimer = null;
    tickTimer = null;
    heldRevealTimer = null;
    clearWrapUpTimers();
  }

  function startTicking() {
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      const base = serverStartedAtMs ?? localStartedAtMs;
      state.elapsedSeconds = base === null ? 0 : (now() - base) / 1000;
      render();
    }, TICK_INTERVAL_MS);
  }

  function schedulePoll(delayMs) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollTick, delayMs);
  }

  function enterDegraded() {
    if (degraded) return;
    degraded = true;
    state.kind = 'degraded';
    state.stageText = '生成中';
    render();
  }

  function exitDegraded() {
    degraded = false;
  }

  function finalize(responseState, run) {
    polling = false;
    clearTimeout(pollTimer);
    clearInterval(tickTimer);
    clearTimeout(finalizeTimer);
    clearTimeout(abortTimer);
    finalizeTimer = null;
    abortTimer = null;
    const base = serverStartedAtMs ?? localStartedAtMs;
    const elapsed = base === null ? state.elapsedSeconds : (now() - base) / 1000;
    state.elapsedSeconds = elapsed;
    // responseState comes straight from the server's authoritative
    // `state` field, independent of whether the user pressed STOP, so a
    // genuine run_failed always renders red/persistent here even during
    // an aborting UI phase, and a genuine aborted always renders grey.
    if (responseState === 'completed') {
      state.kind = 'completed';
      state.summaryText =
        `✓ 总耗时${elapsed.toFixed(1)}s`
        + ` · 召回${run?.counts?.searchHits ?? 0}`
        + ` · 写入${run?.counts?.writtenItems ?? 0}`;
      scheduleFade(SUCCESS_FADE_DELAY_MS);
    } else if (responseState === 'failed') {
      state.kind = 'failed';
      state.errorCode = run?.errorCode ?? null;
      // Reuse the Blocked: human-text table for the server's terminal
      // error code too, so a bare code never reaches the release UI.
      state.summaryText =
        `✗ 未完成 · ${resolveBlockFeedback(state.errorCode).text}`;
    } else {
      state.kind = 'aborted';
      state.summaryText = '已中止';
      scheduleFade(ABORTED_FADE_DELAY_MS);
    }
    render();
  }

  function scheduleFade(delayMs) {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      const view = ensureDom();
      view.root.classList.add('mnemosyne-run-status-float--fading');
      fadeTimer = setTimeout(() => {
        state.visible = false;
        view.root.classList.remove('mnemosyne-run-status-float--fading');
        render();
      }, TRANSITION_MS);
    }, delayMs);
  }

  function handleResponse(response) {
    if (!response || typeof response.state !== 'string') {
      handleFailure();
      return;
    }
    failureStreak = 0;
    const revision = Number.isFinite(response.revision) ? response.revision : 0;
    if (revision < lastRevisionAccepted) return;
    lastRevisionAccepted = Math.max(lastRevisionAccepted, revision);

    const run = response.run ?? null;
    if (baselineRunKey === undefined) {
      // First poll of this generation cycle: record whatever run is
      // already present (possibly none) as the baseline to diff future
      // snapshots against, instead of falling through to "no baseline
      // seen yet == accept anything" (the stale-snapshot bug).
      baselineRunKey = run ? runKeyOf(run) : null;
    }
    if (!run) {
      idleStreak += 1;
      if (idleStreak >= IDLE_DEGRADE_POLL_THRESHOLD) enterDegraded();
      return;
    }
    const key = runKeyOf(run);
    if (awaitingNewRun) {
      const startedAtMs = numericMs(run.startedAt);
      const recentEnough =
        startedAtMs !== null
        && localStartedAtMs !== null
        && startedAtMs >= localStartedAtMs - STALE_ACCEPT_TOLERANCE_MS;
      const differsFromBaseline = key !== baselineRunKey;
      if (!differsFromBaseline && !recentEnough) {
        // Still the pre-existing (possibly stale/terminal) run from
        // before this generation started; keep showing "准备中…".
        idleStreak += 1;
        if (idleStreak >= IDLE_DEGRADE_POLL_THRESHOLD) enterDegraded();
        return;
      }
      awaitingNewRun = false;
      runKey = key;
      idleStreak = 0;
    } else if (key !== runKey) {
      runKey = key;
    }
    const startedAtMs = numericMs(run.startedAt);
    if (startedAtMs !== null) serverStartedAtMs = startedAtMs;
    if (Array.isArray(run.events)) state.events = run.events;
    exitDegraded();

    if (TERMINAL_STATES.has(response.state)) {
      finalize(response.state, run);
      return;
    }
    state.kind = aborting ? 'aborting' : 'running';
    state.stageText = aborting ? '正在中止…' : stageLabel(run.currentStage, run.step);
    render();
  }

  function handleFailure() {
    failureStreak += 1;
    if (failureStreak >= FAILURE_BACKOFF_THRESHOLD) {
      pollIntervalMs = POLL_BACKOFF_MS;
      enterDegraded();
    }
  }

  async function pollTick() {
    if (!polling) return;
    const myGeneration = generation;
    if (inFlight) return;
    inFlight = true;
    const myToken = ++pollToken;
    let timeoutHandle;
    const timeoutPromise = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        const error = new Error('activity/live poll timed out.');
        error.name = 'TimeoutError';
        reject(error);
      }, POLL_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([invoke(chatId), timeoutPromise]);
      // A response arriving after a newer generation/poll cycle has
      // already superseded this one must never touch shared state.
      if (myGeneration !== generation || myToken !== pollToken) return;
      handleResponse(response);
    } catch {
      if (myGeneration !== generation || myToken !== pollToken) return;
      handleFailure();
    } finally {
      clearTimeout(timeoutHandle);
      if (myToken === pollToken) {
        inFlight = false;
        if (myGeneration === generation && polling) {
          schedulePoll(pollIntervalMs);
        }
      }
    }
  }

  function dismiss() {
    clearAllTimers();
    polling = false;
    pollToken += 1;
    state.visible = false;
    state.expanded = false;
    render();
  }

  function onGenerationStarted({ chatId: nextChatId }) {
    generation += 1;
    pollToken += 1;
    clearAllTimers();
    chatId = nextChatId ?? null;
    polling = true;
    inFlight = false;
    pollIntervalMs = POLL_INTERVAL_MS;
    failureStreak = 0;
    idleStreak = 0;
    degraded = false;
    aborting = false;
    baselineRunKey = undefined;
    awaitingNewRun = true;
    runKey = null;
    lastRevisionAccepted = -1;
    localStartedAtMs = now();
    serverStartedAtMs = null;
    Object.assign(state, initialState(), {
      visible: true,
      kind: 'preparing',
      stageText: '准备中…',
    });
    render();
    startTicking();
    schedulePoll(0);
  }

  function onGenerationStopped() {
    if (!state.visible) return;
    // The host fires GENERATION_ENDED before GENERATION_STOPPED for a
    // user-initiated stop, so an ENDED-triggered finalize/fade timer may
    // already be scheduled. Clear all of it before entering "aborting"
    // so a late abort terminal is never pre-empted by that timer.
    clearWrapUpTimers();
    if (isTerminalKind(state.kind)) {
      // A genuine terminal snapshot (e.g. run_failed) already landed;
      // never downgrade it to a generic aborting/aborted display.
      return;
    }
    aborting = true;
    state.kind = 'aborting';
    state.stageText = '正在中止…';
    render();
    if (!polling) {
      // The ENDED fast-finalize timeout had already fired and stopped
      // polling before STOPPED arrived; resume so the real abort
      // terminal can still be observed.
      polling = true;
      if (!tickTimer) startTicking();
      schedulePoll(0);
    }
    abortTimer = setTimeout(() => {
      if (!polling) return;
      polling = false;
      clearTimeout(pollTimer);
      clearInterval(tickTimer);
      state.kind = 'aborted';
      state.summaryText = '已中止';
      render();
      scheduleFade(ABORTED_FADE_DELAY_MS);
    }, ABORT_FALLBACK_TIMEOUT_MS);
  }

  function onGenerationEnded() {
    if (!state.visible || !polling) return;
    pollIntervalMs = ENDED_FAST_POLL_MS;
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => {
      if (!polling) return;
      polling = false;
      clearTimeout(pollTimer);
      clearInterval(tickTimer);
      state.visible = false;
      render();
    }, ENDED_FINALIZE_TIMEOUT_MS);
  }

  function clearForChatChange() {
    generation += 1;
    pollToken += 1;
    clearAllTimers();
    polling = false;
    inFlight = false;
    chatId = null;
    aborting = false;
    baselineRunKey = undefined;
    awaitingNewRun = true;
    runKey = null;
    lastRevisionAccepted = -1;
    Object.assign(state, initialState());
    render();
  }

  // Called synchronously from index.js right before it awaits the
  // intake/history-reconciliation gate that GENERATION_AFTER_COMMANDS
  // blocks on (see the module doc). Does not render immediately: see
  // HELD_REVEAL_DELAY_MS above for why.
  //
  // likelyPending (second-round Codex fix): index.js's only synchronous,
  // zero-network-round-trip knowledge of whether intake has real pending
  // work is chat-save-initialization-gate's local state (a leftover
  // state.preparedIntake for this exact chat means the last send did not
  // finish all batches). When index.js has that local knowledge it passes
  // likelyPending: true so the 400ms floor alone is enough to reveal, with
  // no need to wait for this window's own first onIntakeProgress call —
  // which previously left the entire health/collect-sources/prepareIntake
  // round-trip before that first event completely silent. Left false (the
  // default) when there is no such local record, so a chat truly already
  // ready still never flashes on delay alone (scenario 7).
  function onSendHeld({ chatId: nextChatId = null, likelyPending = false } = {}) {
    if (polling) return; // a real run is already tracked; not this widget's concern
    clearAllTimers();
    // Invalidates any poll response still in flight from a just-ended
    // prior generation (ENDED_FINALIZE_TIMEOUT_MS race): without this a
    // late arrival could still pass pollTick's staleness check and
    // clobber the held display, since generation/pollToken are otherwise
    // untouched here.
    pollToken += 1;
    chatId = nextChatId;
    localStartedAtMs = now();
    serverStartedAtMs = null;
    heldSignalSeen = likelyPending === true;
    heldFloorElapsed = false;
    Object.assign(state, initialState(), {
      kind: 'held',
      stageText: '消息已暂存 · 完成后自动发送',
    });
    heldRevealTimer = setTimeout(() => {
      heldRevealTimer = null;
      // Only this callback ever sets heldFloorElapsed: reveal can
      // therefore only ever happen at max(400ms, time of first signal),
      // never earlier, regardless of how early the signal arrives.
      heldFloorElapsed = true;
      revealHeldIfSignaled();
    }, HELD_REVEAL_DELAY_MS);
  }

  // Reveals the held pill once BOTH are true: the anti-flicker floor has
  // actually elapsed (heldFloorElapsed, set only by the 400ms timer above)
  // AND intake has reported real pending work (heldSignalSeen). This is
  // called from two places — the timer callback once the floor elapses,
  // and onIntakeProgress in case the signal arrives first — and must
  // reveal on neither alone: time alone would flash held for a plain
  // confirmation round-trip on an already-ready chat (P1-3); a signal
  // arriving before the floor (e.g. a real batch event at 150ms) must
  // still wait for the floor, or 400ms stops being an actual lower bound.
  function revealHeldIfSignaled() {
    if (state.kind !== 'held' || state.visible) return;
    if (!heldSignalSeen || !heldFloorElapsed) return;
    state.visible = true;
    render();
    startTicking();
  }

  // Fallback release for edge cases with no further signal (e.g. the
  // extension gets disabled mid-hold). The two ordinary outcomes never
  // need this: intake succeeding leads to the real onGenerationStarted
  // below, which resets state wholesale and naturally clears held; a
  // block leads to onBlocked.
  function onSendReleased() {
    if (state.kind !== 'held') return;
    clearAllTimers();
    Object.assign(state, initialState());
    render();
  }

  // Synchronous counterpart to the run poller: a Blocked: report is a
  // decision made this instant, not a run snapshot, so it renders
  // immediately instead of waiting on the next activity/live tick.
  function onBlocked({ reasonCode = null } = {}) {
    if (state.kind === 'blocked' && state.errorCode === reasonCode) {
      // The same block can be reported twice in one turn
      // (blockCurrentGeneration, then blockChatCompletionRequest);
      // ignore the repeat rather than collapsing an already-expanded
      // card or restarting the persistent display.
      return;
    }
    if (state.kind === 'failed' && isIntakeFamilyReasonCode(reasonCode)) {
      // An intake batch detail ("初始化记忆 · 第N/43批 失败") is already on
      // screen. onSendHeld resets state to 'held' at the very start of
      // every send, so the only way to see 'failed' here is this same
      // window's own onIntakeProgress held-branch — never a stale prior
      // run. The gate's final reasonCode (after retries are exhausted) is
      // a coarser code than the last failing batch's, but still the SAME
      // intake attempt (isIntakeFamilyReasonCode), so scenario 6 requires
      // the batch detail to stay on screen rather than be replaced by it.
      // failed already renders persistent/red/closeable identically to
      // blocked (see STYLE_KIND, isTerminalKind, the close-button check),
      // so only kind/errorCode need to catch up — summaryText stays.
      // A DIFFERENT family (e.g. history_edit_requires_tail_regeneration)
      // is a genuinely different decision and must fall through below to
      // overwrite it with its own mapped text, not inherit the stale one.
      state.kind = 'blocked';
      state.errorCode = reasonCode;
      render();
      return;
    }
    const feedback = resolveBlockFeedback(reasonCode);
    clearAllTimers();
    polling = false;
    pollToken += 1;
    aborting = false;
    degraded = false;
    Object.assign(state, initialState(), {
      visible: true,
      kind: 'blocked',
      errorCode: reasonCode,
      summaryText: `${feedback.text} · ${feedback.action}`,
    });
    render();
  }

  // Initialization is driven by the extension itself, batch by batch, so the
  // capsule is told directly instead of polling a run that does not exist
  // yet. A live generation always wins: this never touches a polling run.
  function onIntakeProgress({
    batchIndex = null,
    batchCount = null,
    status = 'running',
    reasonCode = null,
  } = {}) {
    if (polling) return;
    if (state.kind === 'held') {
      // Keep the "消息已暂存" framing while intake runs inside a held send
      // window. A batch failure falls through to the exact same
      // red/persistent display intake gets outside of held — unchanged
      // behavior by design; 'ended' is left alone because the real
      // onGenerationStarted or onBlocked immediately follows and
      // overwrites this state either way.
      if (status === 'failed') {
        clearTimeout(heldRevealTimer);
        heldRevealTimer = null;
        clearInterval(tickTimer);
        tickTimer = null;
        state.visible = true;
        state.kind = 'failed';
        state.errorCode = reasonCode ?? null;
        state.summaryText = `${intakeStageText(batchIndex, batchCount)} 失败`;
        render();
        return;
      }
      if (status === 'ended') return;
      // A real batch is in flight: this is the "yes, there is genuine
      // pending work" signal revealHeldIfSignaled is waiting for (P1-3).
      heldSignalSeen = true;
      // v1.1 (design doc §1 full-sentence ruling, table 2b revised): the
      // "完成后自动发送" suffix stays even once the intake prefix is known,
      // so the sentence never loses the "and then it sends itself" half.
      state.stageText =
        `消息已暂存 · ${intakeStageText(batchIndex, batchCount)} · 完成后自动发送`;
      revealHeldIfSignaled();
      render();
      return;
    }
    if (status === 'ended') {
      if (state.kind !== 'intake') return;
      clearAllTimers();
      Object.assign(state, initialState());
      render();
      return;
    }
    if (state.kind !== 'intake' && state.kind !== 'failed') {
      clearAllTimers();
      localStartedAtMs = now();
      serverStartedAtMs = null;
      Object.assign(state, initialState(), {
        visible: true,
        kind: 'intake',
        stageText: intakeStageText(batchIndex, batchCount),
      });
      render();
      startTicking();
      return;
    }
    if (status === 'failed') {
      clearInterval(tickTimer);
      tickTimer = null;
      state.kind = 'failed';
      state.errorCode = reasonCode ?? null;
      state.summaryText =
        `${intakeStageText(batchIndex, batchCount)} 失败`;
      render();
      return;
    }
    state.kind = 'intake';
    state.stageText = intakeStageText(batchIndex, batchCount);
    render();
  }

  return Object.freeze({
    onGenerationStarted,
    onGenerationStopped,
    onGenerationEnded,
    onIntakeProgress,
    clearForChatChange,
    onSendHeld,
    onSendReleased,
    onBlocked,
  });
}
