import { randomUUID } from 'node:crypto';

import {
  bridgeRouteForOperation,
  controlOperationRegistry,
  operationCapabilityList,
  operationRegistryCanonicalJson,
} from './control-operation-registry.js';
import { sha256 } from '../contracts/hash.js';

export const BRIDGE_ROUTE_PREFIX = '/v1';
export const BRIDGE_SUPPORTED_PROTOCOLS = Object.freeze(['1']);

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESPONSE_HEADER_ALLOWLIST = Object.freeze([
  'content-type',
  'cache-control',
  'x-mnemosyne-runtime-instance-id',
  'x-mnemosyne-runtime-build-id',
  'x-mnemosyne-protocol-version',
]);

class BridgeTimeoutError extends Error {
  constructor() {
    super('Mnemosyne runtime request timed out.');
    this.name = 'BridgeTimeoutError';
  }
}

function requestHeader(request, name) {
  const value = request?.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function traceIdForRequest(request) {
  const candidate = requestHeader(request, 'x-request-id');
  return typeof candidate === 'string' && TRACE_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
}

function setHeader(response, name, value) {
  if (value === undefined || value === null || value === '') return;
  response.setHeader?.(name, value);
}

function sendJson(response, statusCode, body) {
  setHeader(response, 'cache-control', 'no-store');
  return response.status(statusCode).json(body);
}

function bridgeError({
  reasonCode,
  bridgeStage,
  operation,
  traceId,
  deliveryState,
  retryDisposition,
  protocolVersion = BRIDGE_SUPPORTED_PROTOCOLS[0],
  runtimeBuildId = null,
  runtimeInstanceId = null,
  origin = 'bridge',
}) {
  return {
    schema: 'mnemosyne.bridge-error.v1',
    error: {
      reason_code: reasonCode,
      origin,
      bridge_stage: bridgeStage,
      operation,
      trace_id: traceId,
      delivery_state: deliveryState,
      retry_disposition: retryDisposition,
      protocol_version: protocolVersion,
      runtime_build_id: runtimeBuildId,
      runtime_instance_id: runtimeInstanceId,
    },
  };
}

function semanticBodySize(body) {
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function selectProtocol(runtimeProtocols) {
  if (!Array.isArray(runtimeProtocols)) return null;
  const runtimeSet = new Set(
    runtimeProtocols.filter(version => typeof version === 'string'),
  );
  return BRIDGE_SUPPORTED_PROTOCOLS.find(version => runtimeSet.has(version))
    ?? null;
}

function runtimeMetadata(runtimeResponse) {
  return {
    runtimeBuildId:
      runtimeResponse.headers.get('x-mnemosyne-runtime-build-id') ?? null,
    runtimeInstanceId:
      runtimeResponse.headers.get('x-mnemosyne-runtime-instance-id') ?? null,
    protocolVersion:
      runtimeResponse.headers.get('x-mnemosyne-protocol-version')
      ?? BRIDGE_SUPPORTED_PROTOCOLS[0],
  };
}

async function parseRuntimeJson(runtimeResponse) {
  try {
    return await runtimeResponse.json();
  } catch {
    return null;
  }
}

function copyAllowedResponseHeaders(runtimeResponse, response, traceId) {
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    setHeader(response, name, runtimeResponse.headers.get(name));
  }
  setHeader(response, 'x-request-id', traceId);
  setHeader(response, 'x-content-type-options', 'nosniff');
}

function bindClientAbort(request, response, controller) {
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Bridge client disconnected.'));
    }
  };
  request.once?.('aborted', abort);
  response.once?.('close', abort);
  return () => {
    request.off?.('aborted', abort);
    response.off?.('close', abort);
  };
}

function idempotencyValue(operation, body) {
  if (!operation.required_idempotency_field) return null;
  const value = body?.[operation.required_idempotency_field];
  return typeof value === 'string' && value.trim() ? value : null;
}

function outboundHeaders({
  contextAccessToken,
  bridgeVersion,
  protocolVersion,
  traceId,
  contentType = false,
  idempotencyKey = null,
}) {
  return {
    accept: 'application/json',
    ...(contentType ? { 'content-type': 'application/json' } : {}),
    'x-mnemosyne-session-token': contextAccessToken,
    'x-mnemosyne-control-adapter': 'bridge',
    'x-mnemosyne-protocol-version': protocolVersion,
    'x-mnemosyne-bridge-version': bridgeVersion,
    'x-request-id': traceId,
    ...(idempotencyKey
      ? { 'x-mnemosyne-idempotency-key': idempotencyKey }
      : {}),
  };
}

export function createMnemosyneSillyTavernBridge({
  runtimeBaseUrl = 'http://127.0.0.1:18991',
  contextAccessToken,
  bridgeVersion = '1',
  fetchImpl = globalThis.fetch,
  timeoutOverrides = {},
  enableEvaluationRoutes = false,
} = {}) {
  if (
    typeof contextAccessToken !== 'string'
    || !contextAccessToken
  ) {
    throw new Error('The bridge requires a server-held context access token.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('The bridge requires fetch.');
  }
  const normalizedRuntimeBaseUrl = new URL(runtimeBaseUrl);
  if (
    normalizedRuntimeBaseUrl.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(
      normalizedRuntimeBaseUrl.hostname,
    )
    || normalizedRuntimeBaseUrl.username
    || normalizedRuntimeBaseUrl.password
    || normalizedRuntimeBaseUrl.search
    || normalizedRuntimeBaseUrl.hash
  ) {
    throw new Error('The bridge runtime URL must be credential-free loopback HTTP.');
  }
  const baseUrl = normalizedRuntimeBaseUrl.href.replace(/\/+$/, '');
  const operationRegistry = controlOperationRegistry({
    includeEvaluation: enableEvaluationRoutes,
  });

  async function performRuntimeFetch({
    request,
    response,
    operationId,
    url,
    options,
    timeoutMs,
    retryDisposition,
    traceId,
  }) {
    const controller = new AbortController();
    const cleanupAbort = bindClientAbort(
      request,
      response,
      controller,
    );
    const timeout = setTimeout(
      () => controller.abort(new BridgeTimeoutError()),
      timeoutMs,
    );
    timeout.unref?.();
    let dispatched = false;
    try {
      dispatched = true;
      const runtimeResponse = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
      });
      const metadata = runtimeMetadata(runtimeResponse);
      const runtimeBody = await parseRuntimeJson(runtimeResponse);
      copyAllowedResponseHeaders(runtimeResponse, response, traceId);
      if (!runtimeResponse.ok) {
        return sendJson(response, runtimeResponse.status, bridgeError({
          reasonCode:
            runtimeBody?.error?.reason_code ?? 'bridge_runtime_error',
          bridgeStage: 'runtime_error',
          operation: operationId,
          traceId,
          deliveryState: 'response_received',
          retryDisposition,
          protocolVersion: metadata.protocolVersion,
          runtimeBuildId: metadata.runtimeBuildId,
          runtimeInstanceId: metadata.runtimeInstanceId,
          origin: 'runtime',
        }));
      }
      if (runtimeBody === null) {
        return sendJson(response, 502, bridgeError({
          reasonCode: 'bridge_runtime_response_invalid',
          bridgeStage: 'runtime_error',
          operation: operationId,
          traceId,
          deliveryState: 'response_received',
          retryDisposition: 'never',
          ...metadata,
          origin: 'runtime',
        }));
      }
      return sendJson(response, runtimeResponse.status, runtimeBody);
    } catch (error) {
      if (response.writableEnded || response.destroyed) {
        return response;
      }
      const timedOut = (
        controller.signal.aborted
        && controller.signal.reason instanceof BridgeTimeoutError
      );
      return sendJson(response, timedOut ? 504 : 502, bridgeError({
        reasonCode: timedOut
          ? 'bridge_runtime_timeout'
          : 'bridge_runtime_unreachable',
        bridgeStage: timedOut ? 'bridge_timeout' : 'runtime_unreachable',
        operation: operationId,
        traceId,
        deliveryState: dispatched
          ? 'dispatched_outcome_unknown'
          : 'not_dispatched',
        retryDisposition: dispatched ? 'recover_only' : retryDisposition,
      }));
    } finally {
      clearTimeout(timeout);
      cleanupAbort();
    }
  }

  async function handleCapabilities(request, response) {
    const traceId = traceIdForRequest(request);
    const runtimeResponse = await performRuntimeFetch({
      request,
      response: {
        setHeader() {},
        status() {
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      },
      operationId: 'capabilities',
      url: `${baseUrl}/health`,
      options: {
        method: 'GET',
        headers: outboundHeaders({
          contextAccessToken,
          bridgeVersion,
          protocolVersion: BRIDGE_SUPPORTED_PROTOCOLS[0],
          traceId,
        }),
      },
      timeoutMs: timeoutOverrides.capabilities ?? 5_000,
      retryDisposition: 'safe',
      traceId,
    });
    const health = runtimeResponse?.body;
    if (!health || health.schema !== 'mnemosyne.health.v1') {
      return sendJson(response, 503, (
        health?.schema === 'mnemosyne.bridge-error.v1'
          ? health
          : bridgeError({
              reasonCode: 'bridge_runtime_health_invalid',
              bridgeStage: 'runtime_error',
              operation: 'capabilities',
              traceId,
              deliveryState: 'response_received',
              retryDisposition: 'safe',
              origin: 'runtime',
            })
      ));
    }
    const negotiatedProtocol = selectProtocol(health.supported_protocols);
    const bridgeRegistryHash = sha256(operationRegistryCanonicalJson({
      includeEvaluation: enableEvaluationRoutes,
    }));
    const runtimeRegistryHashes = new Set([
      bridgeRegistryHash,
      ...(!enableEvaluationRoutes
        ? [sha256(operationRegistryCanonicalJson({
            includeEvaluation: true,
          }))]
        : []),
    ]);
    const registryMatches = runtimeRegistryHashes.has(
      health.operation_registry_hash,
    );
    setHeader(response, 'cache-control', 'no-store');
    setHeader(response, 'x-request-id', traceId);
    return sendJson(response, 200, {
      schema: 'mnemosyne.bridge-capabilities.v1',
      bridge_version: bridgeVersion,
      bridge_supported_protocols: [...BRIDGE_SUPPORTED_PROTOCOLS],
      runtime_supported_protocols: Array.isArray(health.supported_protocols)
        ? [...health.supported_protocols]
        : [],
      negotiated_protocol: registryMatches ? negotiatedProtocol : null,
      runtime_build_id: health.runtime_build?.id ?? null,
      runtime_instance_id: health.runtime_instance_id ?? null,
      generation_binding_hash: health.generation_binding_hash ?? null,
      operation_registry_hash: health.operation_registry_hash ?? null,
      bridge_operation_registry_hash: bridgeRegistryHash,
      registry_compatible: registryMatches,
      storage_status: health.storage_status ?? 'unknown',
      upstream_status: health.upstream_status ?? 'unknown',
      upstream_reachable: health.upstream_reachable ?? 'unknown',
      main_host_binding: health.main_host_binding ?? null,
      provider_budget_policy: health.provider_budget_policy ?? null,
      operations: operationCapabilityList({
        includeEvaluation: enableEvaluationRoutes,
      }),
    });
  }

  async function handleOperation(operationId, request, response) {
    const operation = operationRegistry[operationId];
    const traceId = traceIdForRequest(request);
    if (!operation) {
      return sendJson(response, 404, bridgeError({
        reasonCode: 'bridge_operation_unknown',
        bridgeStage: 'bridge_rejected',
        operation: operationId,
        traceId,
        deliveryState: 'not_dispatched',
        retryDisposition: 'never',
      }));
    }
    if (semanticBodySize(request.body) > operation.max_body_bytes) {
      return sendJson(response, 413, bridgeError({
        reasonCode: 'bridge_request_body_too_large',
        bridgeStage: 'bridge_rejected',
        operation: operationId,
        traceId,
        deliveryState: 'not_dispatched',
        retryDisposition: 'never',
      }));
    }
    const idempotencyKey = idempotencyValue(operation, request.body);
    if (
      operation.required_idempotency_field
      && idempotencyKey === null
    ) {
      return sendJson(response, 422, bridgeError({
        reasonCode: 'bridge_idempotency_key_required',
        bridgeStage: 'bridge_rejected',
        operation: operationId,
        traceId,
        deliveryState: 'not_dispatched',
        retryDisposition: 'never',
      }));
    }

    const target = operation.runtime_target;
    let targetPath = target.path;
    if (target.body_path_parameter) {
      const pathValue = request.body?.[target.body_path_parameter];
      if (typeof pathValue !== 'string' || !pathValue) {
        return sendJson(response, 422, bridgeError({
          reasonCode: 'bridge_path_parameter_required',
          bridgeStage: 'bridge_rejected',
          operation: operationId,
          traceId,
          deliveryState: 'not_dispatched',
          retryDisposition: 'never',
        }));
      }
      targetPath += encodeURIComponent(pathValue);
    }
    const hasBody = target.method !== 'GET';
    return performRuntimeFetch({
      request,
      response,
      operationId,
      url: `${baseUrl}${targetPath}`,
      options: {
        method: target.method,
        headers: outboundHeaders({
          contextAccessToken,
          bridgeVersion,
          protocolVersion: BRIDGE_SUPPORTED_PROTOCOLS[0],
          traceId,
          contentType: hasBody,
          idempotencyKey,
        }),
        ...(hasBody ? { body: JSON.stringify(request.body ?? {}) } : {}),
      },
      timeoutMs:
        timeoutOverrides[operationId] ?? operation.timeout_ms,
      retryDisposition: operation.retry_class,
      traceId,
    });
  }

  function register(router) {
    router.get(
      `${BRIDGE_ROUTE_PREFIX}/capabilities`,
      handleCapabilities,
    );
    for (const operationId of Object.keys(operationRegistry)) {
      router.post(
        bridgeRouteForOperation(operationId),
        (request, response) => (
          handleOperation(operationId, request, response)
        ),
      );
    }
  }

  return Object.freeze({
    register,
    handleCapabilities,
    handleOperation,
  });
}
