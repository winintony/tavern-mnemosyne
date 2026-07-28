import {
  ALL_CONTROL_OPERATION_REGISTRY,
  controlOperationRegistry,
  operationRegistryCanonicalJson,
} from './control-operation-registry-browser.js';

const BRIDGE_CAPABILITIES_PATH =
  '/api/plugins/tavern-mnemosyne/v1/capabilities';
const BRIDGE_CONTROL_PREFIX =
  '/api/plugins/tavern-mnemosyne/v1/control';
const SUPPORTED_PROTOCOLS = Object.freeze(['1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const CONTROL_CLIENT_OPERATION_MAP = Object.freeze({
  readContext: 'context/read',
  inspectHistory: 'history/inspect',
  truncateHistory: 'history/truncate',
  activateSwipe: 'history/activate-swipe',
  deleteSwipe: 'history/delete-swipe',
  prepareIntake: 'intake/prepare',
  confirmIntakeReconciliation: 'intake/reconcile/confirm',
  recoverIntake: 'intake/recover',
  retryIntake: 'intake/retry',
  requestSourceRemovalGrants: 'source-removal-grants',
  inspectUpstreamReadiness: 'upstream-readiness',
  inspectActivity: 'activity/inspect',
  inspectDormantThreads: 'activity/dormant-threads',
  prepareEvaluation: 'evaluation/prepare',
  submitEvaluationFeedback: 'evaluation/feedback',
  exportEvaluation: 'evaluation/export',
});

export class MnemosyneControlError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = 'MnemosyneControlError';
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode, message, details) {
  throw new MnemosyneControlError(reasonCode, message, details);
}

function normalizeHostAuthContext(value) {
  const headers = value?.headers;
  const credentials = value?.credentials;
  if (
    !headers
    || typeof headers !== 'object'
    || Array.isArray(headers)
    || credentials !== 'same-origin'
  ) {
    fail(
      'mnemosyne_host_auth_context_invalid',
      'SillyTavern host authentication context is unavailable.',
    );
  }
  return {
    headers: { ...headers },
    credentials,
  };
}

function mergeRequestHeaders(baseHeaders, requiredHeaders) {
  const headers = new Headers(baseHeaders);
  for (const [name, value] of Object.entries(requiredHeaders)) {
    headers.set(name, value);
  }
  return headers;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    fail(
      'mnemosyne_control_response_invalid',
      'Mnemosyne returned an invalid JSON response.',
      { status: response.status },
    );
  }
}

function assertCapabilities(capabilities) {
  let generationBaseUrl;
  try {
    generationBaseUrl = new URL(capabilities?.generation_base_url);
  } catch {
    generationBaseUrl = null;
  }
  if (
    capabilities?.schema !== 'mnemosyne.bridge-capabilities.v1'
    || typeof capabilities.runtime_build_id !== 'string'
    || !capabilities.runtime_build_id
    || typeof capabilities.runtime_instance_id !== 'string'
    || !capabilities.runtime_instance_id
    || typeof capabilities.generation_binding_hash !== 'string'
    || !/^[a-f0-9]{64}$/.test(capabilities.generation_binding_hash)
    || typeof capabilities.operation_registry_hash !== 'string'
    || !/^[a-f0-9]{64}$/.test(
      capabilities.operation_registry_hash,
    )
    || generationBaseUrl?.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(generationBaseUrl?.hostname)
    || !generationBaseUrl?.port
    || generationBaseUrl.username
    || generationBaseUrl.password
    || generationBaseUrl.search
    || generationBaseUrl.hash
  ) {
    fail(
      'mnemosyne_capabilities_invalid',
      'Mnemosyne bridge capabilities are incomplete.',
    );
  }
  if (
    !SUPPORTED_PROTOCOLS.includes(capabilities.negotiated_protocol)
    || capabilities.registry_compatible !== true
  ) {
    fail(
      'mnemosyne_protocol_incompatible',
      'The Mnemosyne bridge and runtime protocols are incompatible.',
      {
        bridge_supported_protocols:
          capabilities.bridge_supported_protocols ?? [],
        runtime_supported_protocols:
          capabilities.runtime_supported_protocols ?? [],
      },
    );
  }
  if (capabilities.storage_status !== 'ready') {
    fail(
      'mnemosyne_storage_unavailable',
      'Mnemosyne storage is not ready.',
      { storage_status: capabilities.storage_status ?? 'unknown' },
    );
  }
  if (capabilities.upstream_status !== 'configured') {
    fail(
      'mnemosyne_upstream_unconfigured',
      'Mnemosyne upstream configuration is not ready.',
      { upstream_status: capabilities.upstream_status ?? 'unknown' },
    );
  }
}

function leaseFromCapabilities(capabilities, adapterId, now) {
  return Object.freeze({
    adapter_id: adapterId,
    protocol_version: capabilities.negotiated_protocol,
    bridge_version: capabilities.bridge_version,
    runtime_build_id: capabilities.runtime_build_id,
    runtime_instance_id: capabilities.runtime_instance_id,
    generation_binding_hash: capabilities.generation_binding_hash,
    operation_registry_hash: capabilities.operation_registry_hash,
    resolved_at: now().toISOString(),
  });
}

function assertLease(lease) {
  if (
    !lease
    || !['bridge', 'loopback'].includes(lease.adapter_id)
    || !SUPPORTED_PROTOCOLS.includes(lease.protocol_version)
    || typeof lease.runtime_build_id !== 'string'
    || typeof lease.runtime_instance_id !== 'string'
  ) {
    fail(
      'mnemosyne_transport_lease_invalid',
      'A fixed Mnemosyne transport lease is required.',
    );
  }
}

function assertResponseIdentity(response, lease) {
  const buildId = response.headers.get('x-mnemosyne-runtime-build-id');
  const instanceId = response.headers.get(
    'x-mnemosyne-runtime-instance-id',
  );
  const protocolVersion = response.headers.get(
    'x-mnemosyne-protocol-version',
  );
  if (buildId !== lease.runtime_build_id) {
    fail(
      'mnemosyne_runtime_build_changed',
      'The Mnemosyne runtime build changed during this run.',
    );
  }
  if (instanceId !== lease.runtime_instance_id) {
    fail(
      'mnemosyne_runtime_instance_changed',
      'The Mnemosyne runtime restarted during this run.',
    );
  }
  if (protocolVersion !== lease.protocol_version) {
    fail(
      'mnemosyne_runtime_protocol_changed',
      'The Mnemosyne runtime protocol changed during this run.',
    );
  }
}

function isExplicitLocalPage(pageUrl, deploymentMode) {
  return deploymentMode === 'local' && LOOPBACK_HOSTS.has(pageUrl.hostname);
}

async function fetchWithDeadline(
  fetchImpl,
  url,
  options,
  {
    signal,
    timeoutMs,
  },
) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      const error = new Error('Transport resolution timed out.');
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, {
        ...options,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function loopbackCapabilities(health, loopbackBaseUrl) {
  const includeEvaluation =
    health.continuity_evaluation?.status === 'ready';
  const expectedRegistryHash = await sha256Hex(
    operationRegistryCanonicalJson({ includeEvaluation }),
  );
  return {
    schema: 'mnemosyne.bridge-capabilities.v1',
    bridge_version: 'loopback',
    bridge_supported_protocols: [...SUPPORTED_PROTOCOLS],
    runtime_supported_protocols: health.supported_protocols ?? [],
    negotiated_protocol: (health.supported_protocols ?? [])
      .find(version => SUPPORTED_PROTOCOLS.includes(version)) ?? null,
    runtime_build_id: health.runtime_build?.id ?? null,
    runtime_instance_id: health.runtime_instance_id ?? null,
    generation_binding_hash: health.generation_binding_hash ?? null,
    operation_registry_hash: health.operation_registry_hash ?? null,
    registry_compatible:
      health.operation_registry_hash === expectedRegistryHash,
    storage_status: health.storage_status ?? 'unknown',
    upstream_status: health.upstream_status ?? 'unknown',
    upstream_reachable: health.upstream_reachable ?? 'unknown',
    generation_base_url: new URL('/v1', loopbackBaseUrl).href,
    operations: Object.values(controlOperationRegistry({
      includeEvaluation,
    })),
  };
}

export function createMnemosyneControlClient({
  pageUrl = globalThis.location?.href,
  deploymentMode,
  loopbackBaseUrl = 'http://127.0.0.1:18991',
  getHostAuthContext,
  getLoopbackHeaders = () => ({}),
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  transportResolveTimeoutMs = 3_000,
} = {}) {
  const resolvedPageUrl = new URL(pageUrl);
  const bridgeCapabilitiesUrl = new URL(
    BRIDGE_CAPABILITIES_PATH,
    resolvedPageUrl,
  );
  const resolvedLoopbackUrl = new URL(loopbackBaseUrl);
  const capabilitiesByLease = new WeakMap();
  if (!LOOPBACK_HOSTS.has(resolvedLoopbackUrl.hostname)) {
    throw new Error('Loopback transport requires a loopback URL.');
  }
  if (
    !Number.isSafeInteger(transportResolveTimeoutMs)
    || transportResolveTimeoutMs <= 0
  ) {
    throw new Error(
      'Transport resolution timeout must be a positive integer.',
    );
  }

  async function resolveRootTransport({ signal } = {}) {
    const auth = normalizeHostAuthContext(getHostAuthContext?.());
    let bridgeResponse;
    try {
      bridgeResponse = await fetchWithDeadline(
        fetchImpl,
        bridgeCapabilitiesUrl,
        {
          method: 'GET',
          headers: mergeRequestHeaders(auth.headers, {
            accept: 'application/json',
          }),
          credentials: auth.credentials,
          cache: 'no-store',
        },
        { signal, timeoutMs: transportResolveTimeoutMs },
      );
    } catch (error) {
      fail(
        'mnemosyne_bridge_unreachable',
        'The same-origin Mnemosyne bridge is unreachable.',
        { cause: error?.name ?? 'unknown' },
      );
    }
    if (bridgeResponse.ok) {
      const capabilities = await readJson(bridgeResponse);
      assertCapabilities(capabilities);
      const lease = leaseFromCapabilities(capabilities, 'bridge', now);
      capabilitiesByLease.set(lease, structuredClone(capabilities));
      return lease;
    }
    if (
      bridgeResponse.status !== 404
      || !isExplicitLocalPage(resolvedPageUrl, deploymentMode)
    ) {
      fail(
        bridgeResponse.status === 404
          ? 'mnemosyne_bridge_required'
          : 'mnemosyne_bridge_unavailable',
        bridgeResponse.status === 404
          ? 'This remote SillyTavern requires the co-located Mnemosyne bridge.'
          : 'The Mnemosyne bridge is present but unavailable.',
        { status: bridgeResponse.status },
      );
    }

    let loopbackResponse;
    try {
      loopbackResponse = await fetchWithDeadline(
        fetchImpl,
        new URL('/health', resolvedLoopbackUrl),
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...getLoopbackHeaders(),
          },
          cache: 'no-store',
        },
        { signal, timeoutMs: transportResolveTimeoutMs },
      );
    } catch (error) {
      fail(
        'mnemosyne_loopback_unavailable',
        'The local Mnemosyne runtime is unavailable.',
        { cause: error?.name ?? 'unknown' },
      );
    }
    if (!loopbackResponse.ok) {
      fail(
        'mnemosyne_loopback_unavailable',
        'The local Mnemosyne runtime is unavailable.',
        { status: loopbackResponse.status },
      );
    }
    const capabilities = await loopbackCapabilities(
      await readJson(loopbackResponse),
      resolvedLoopbackUrl,
    );
    assertCapabilities(capabilities);
    const lease = leaseFromCapabilities(capabilities, 'loopback', now);
    capabilitiesByLease.set(lease, structuredClone(capabilities));
    return lease;
  }

  async function invoke(operationId, body, {
    lease,
    signal,
  } = {}) {
    assertLease(lease);
    const operation = ALL_CONTROL_OPERATION_REGISTRY[operationId];
    if (!operation) {
      fail(
        'mnemosyne_operation_unknown',
        'The requested Mnemosyne control operation is unknown.',
      );
    }
    const capabilities = capabilitiesByLease.get(lease);
    if (
      !capabilities
      || !Array.isArray(capabilities.operations)
      || !capabilities.operations.some(
        entry => entry?.operation_id === operationId,
      )
    ) {
      fail(
        'mnemosyne_operation_not_advertised',
        'The fixed Mnemosyne transport does not advertise this operation.',
      );
    }
    let url;
    let method;
    let headers;
    let credentials;
    let requestBody;
    if (lease.adapter_id === 'bridge') {
      const auth = normalizeHostAuthContext(getHostAuthContext?.());
      url = new URL(
        `${BRIDGE_CONTROL_PREFIX}/${operationId}`,
        resolvedPageUrl,
      );
      method = 'POST';
      headers = mergeRequestHeaders(auth.headers, {
        accept: 'application/json',
        'content-type': 'application/json',
      });
      credentials = auth.credentials;
      requestBody = JSON.stringify(body ?? {});
    } else {
      const target = operation.runtime_target;
      let targetPath = target.path;
      if (target.body_path_parameter) {
        const pathValue = body?.[target.body_path_parameter];
        if (typeof pathValue !== 'string' || !pathValue) {
          fail(
            'mnemosyne_operation_input_invalid',
            `${target.body_path_parameter} is required.`,
          );
        }
        targetPath += encodeURIComponent(pathValue);
      }
      url = new URL(targetPath, resolvedLoopbackUrl);
      method = target.method;
      headers = {
        accept: 'application/json',
        ...(method === 'GET'
          ? {}
          : { 'content-type': 'application/json' }),
        'x-mnemosyne-control-adapter': 'loopback',
        'x-mnemosyne-bridge-version': 'loopback',
        'x-mnemosyne-protocol-version': lease.protocol_version,
        ...getLoopbackHeaders(),
      };
      requestBody = method === 'GET'
        ? undefined
        : JSON.stringify(body ?? {});
    }

    const response = await fetchImpl(url, {
      method,
      headers,
      ...(credentials ? { credentials } : {}),
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal,
    });
    const responseBody = await readJson(response);
    if (
      response.ok
      || responseBody?.error?.origin === 'runtime'
    ) {
      assertResponseIdentity(response, lease);
    }
    if (!response.ok) {
      fail(
        responseBody?.error?.reason_code
          ?? 'mnemosyne_control_operation_failed',
        'The Mnemosyne control operation failed.',
        {
          status: response.status,
          bridge_stage: responseBody?.error?.bridge_stage ?? null,
          delivery_state: responseBody?.error?.delivery_state ?? null,
          retry_disposition:
            responseBody?.error?.retry_disposition ?? operation.retry_class,
        },
      );
    }
    return responseBody;
  }

  const client = {
    resolveRootTransport,
    capabilitiesForLease(lease) {
      assertLease(lease);
      const capabilities = capabilitiesByLease.get(lease);
      if (!capabilities) {
        fail(
          'mnemosyne_transport_lease_unknown',
          'The transport lease was not resolved by this Control Client.',
        );
      }
      return structuredClone(capabilities);
    },
    invoke,
  };
  for (const [methodName, operationId] of Object.entries(
    CONTROL_CLIENT_OPERATION_MAP,
  )) {
    client[methodName] = (body, options) => (
      invoke(operationId, body, options)
    );
  }
  return Object.freeze(client);
}
