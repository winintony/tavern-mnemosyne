const KiB = 1024;
const MiB = 1024 * KiB;

function operation({
  operationId,
  runtimeTarget,
  maxBodyBytes,
  timeoutMs,
  mutatesState,
  retryClass,
  requiredIdempotencyField = null,
  cancelable = false,
}) {
  return Object.freeze({
    operation_id: operationId,
    runtime_target: Object.freeze(runtimeTarget),
    max_body_bytes: maxBodyBytes,
    timeout_ms: timeoutMs,
    mutates_state: mutatesState,
    retry_class: retryClass,
    required_idempotency_field: requiredIdempotencyField,
    cancelable,
  });
}

const operations = [
  operation({
    operationId: 'context/read',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/context/',
      body_path_parameter: 'chat_id',
    },
    maxBodyBytes: 1 * MiB,
    timeoutMs: 15_000,
    mutatesState: false,
    retryClass: 'safe',
  }),
  operation({
    operationId: 'history/inspect',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/history/inspect',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 15_000,
    mutatesState: false,
    retryClass: 'safe',
  }),
  operation({
    operationId: 'history/truncate',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/history/truncate',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 30_000,
    mutatesState: true,
    retryClass: 'same_idempotency_key_only',
    requiredIdempotencyField: 'command_id',
  }),
  operation({
    operationId: 'history/activate-swipe',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/history/activate-swipe',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 30_000,
    mutatesState: true,
    retryClass: 'same_idempotency_key_only',
    requiredIdempotencyField: 'command_id',
  }),
  operation({
    operationId: 'history/delete-swipe',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/history/delete-swipe',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 30_000,
    mutatesState: true,
    retryClass: 'same_idempotency_key_only',
    requiredIdempotencyField: 'command_id',
  }),
  operation({
    operationId: 'intake/prepare',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/intake/prepare',
    },
    maxBodyBytes: 64 * MiB,
    timeoutMs: 120_000,
    mutatesState: true,
    retryClass: 'recover_only',
    cancelable: true,
  }),
  operation({
    operationId: 'intake/reconcile/confirm',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/intake/reconcile/confirm',
    },
    maxBodyBytes: 1 * MiB,
    timeoutMs: 120_000,
    mutatesState: true,
    retryClass: 'same_idempotency_key_only',
    requiredIdempotencyField: 'plan_id',
    cancelable: true,
  }),
  operation({
    operationId: 'intake/recover',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/intake/recover',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 60_000,
    mutatesState: true,
    retryClass: 'recover_only',
  }),
  operation({
    operationId: 'intake/retry',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/intake/retry',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 60_000,
    mutatesState: true,
    retryClass: 'never',
  }),
  operation({
    operationId: 'source-removal-grants',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/source-removal-grants',
    },
    maxBodyBytes: 2 * MiB,
    timeoutMs: 30_000,
    mutatesState: false,
    retryClass: 'safe',
  }),
  operation({
    operationId: 'upstream-readiness',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/upstream-readiness',
    },
    maxBodyBytes: 64 * KiB,
    timeoutMs: 15_000,
    mutatesState: false,
    retryClass: 'safe',
    cancelable: true,
  }),
  operation({
    operationId: 'activity/inspect',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/activity/inspect',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 15_000,
    mutatesState: false,
    retryClass: 'safe',
  }),
  operation({
    operationId: 'activity/dormant-threads',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/activity/dormant-threads',
    },
    maxBodyBytes: 64 * KiB,
    timeoutMs: 15_000,
    mutatesState: false,
    retryClass: 'safe',
  }),
];

export const CONTROL_OPERATION_REGISTRY = Object.freeze(
  Object.fromEntries(
    operations.map(entry => [entry.operation_id, entry]),
  ),
);

const evaluationOperations = [
  operation({
    operationId: 'evaluation/prepare',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/evaluation/prepare',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 30_000,
    mutatesState: true,
    retryClass: 'same_idempotency_key_only',
    requiredIdempotencyField: 'run_id',
  }),
  operation({
    operationId: 'evaluation/feedback',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/evaluation/feedback',
    },
    maxBodyBytes: 256 * KiB,
    timeoutMs: 30_000,
    mutatesState: true,
    retryClass: 'same_idempotency_key_only',
    requiredIdempotencyField: 'command_id',
  }),
  operation({
    operationId: 'evaluation/export',
    runtimeTarget: {
      method: 'POST',
      path: '/v1/mnemosyne/evaluation/export',
    },
    maxBodyBytes: 1 * MiB,
    timeoutMs: 60_000,
    mutatesState: false,
    retryClass: 'safe',
  }),
];

export const EVALUATION_CONTROL_OPERATION_REGISTRY = Object.freeze(
  Object.fromEntries(
    evaluationOperations.map(entry => [entry.operation_id, entry]),
  ),
);

export const ALL_CONTROL_OPERATION_REGISTRY = Object.freeze({
  ...CONTROL_OPERATION_REGISTRY,
  ...EVALUATION_CONTROL_OPERATION_REGISTRY,
});

export function controlOperationRegistry({
  includeEvaluation = false,
} = {}) {
  return includeEvaluation
    ? ALL_CONTROL_OPERATION_REGISTRY
    : CONTROL_OPERATION_REGISTRY;
}

function classification(releaseClass, reason) {
  return Object.freeze({
    release_class: releaseClass,
    reason,
  });
}

export const RUNTIME_PRIVATE_ROUTE_CLASSIFICATION = Object.freeze({
  '/v1/mnemosyne/activity/inspect': classification(
    'open',
    'Published read-only activity inspection.',
  ),
  '/v1/mnemosyne/activity/dormant-threads': classification(
    'open',
    'Published read-only dormant-thread statistics panel.',
  ),
  '/v1/mnemosyne/capabilities': classification(
    'excluded',
    'Runtime-internal capability registry is not the bridge negotiation route.',
  ),
  '/v1/mnemosyne/context/': classification(
    'open',
    'Published context read with the chat id supplied in the request body.',
  ),
  '/v1/mnemosyne/evaluation/export': classification(
    'conditional',
    'M-E1 only; registered only when the evaluation feature is enabled.',
  ),
  '/v1/mnemosyne/evaluation/feedback': classification(
    'conditional',
    'M-E1 only; registered only when the evaluation feature is enabled.',
  ),
  '/v1/mnemosyne/evaluation/prepare': classification(
    'conditional',
    'M-E1 only; registered only when the evaluation feature is enabled.',
  ),
  '/v1/mnemosyne/history/activate-swipe': classification(
    'open',
    'Published active-candidate lifecycle operation.',
  ),
  '/v1/mnemosyne/history/delete-swipe': classification(
    'open',
    'Published candidate-deletion lifecycle operation.',
  ),
  '/v1/mnemosyne/history/inspect': classification(
    'open',
    'Published read-only lifecycle inspection.',
  ),
  '/v1/mnemosyne/history/restore-branch': classification(
    'excluded',
    'No current release Control Client consumer.',
  ),
  '/v1/mnemosyne/history/truncate': classification(
    'open',
    'Published chat-truncation lifecycle operation.',
  ),
  '/v1/mnemosyne/intake/abandon': classification(
    'excluded',
    'Recovery primitive is not exposed by the current release client.',
  ),
  '/v1/mnemosyne/intake/chat/completions': classification(
    'excluded',
    'Generation-plane endpoint; never exposed through the control bridge.',
  ),
  '/v1/mnemosyne/intake/prepare': classification(
    'open',
    'Published intake preparation operation.',
  ),
  '/v1/mnemosyne/intake/rebase': classification(
    'excluded',
    'Recovery primitive is not exposed by the current release client.',
  ),
  '/v1/mnemosyne/intake/reconcile/confirm': classification(
    'open',
    'Published explicit reconciliation confirmation.',
  ),
  '/v1/mnemosyne/intake/recover': classification(
    'open',
    'Published outcome recovery operation.',
  ),
  '/v1/mnemosyne/intake/replay': classification(
    'excluded',
    'Recovery primitive is not exposed by the current release client.',
  ),
  '/v1/mnemosyne/intake/reprocess': classification(
    'excluded',
    'Recovery primitive is not exposed by the current release client.',
  ),
  '/v1/mnemosyne/intake/retry': classification(
    'open',
    'Published explicit retry preparation operation.',
  ),
  '/v1/mnemosyne/prompt-prepare-probe/chat/completions': classification(
    'excluded',
    'Development and acceptance generation probe; absent from release bridge.',
  ),
  '/v1/mnemosyne/source-removal-grants': classification(
    'open',
    'Published read-only prompt-fidelity authorization lookup.',
  ),
  '/v1/mnemosyne/upstream-readiness': classification(
    'open',
    'Published upstream readiness probe.',
  ),
});

export function bridgeRouteForOperation(operationId) {
  if (!ALL_CONTROL_OPERATION_REGISTRY[operationId]) {
    throw new Error(`Unknown Mnemosyne control operation: ${operationId}`);
  }
  return `/v1/control/${operationId}`;
}

export function operationCapabilityList(options) {
  return Object.values(controlOperationRegistry(options))
    .map(entry => structuredClone(entry));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function operationRegistryCanonicalJson(options) {
  return JSON.stringify(canonicalize(controlOperationRegistry(options)));
}
