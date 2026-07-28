import { MnemosyneRequestError } from '../contracts/errors.js';

const RESERVED_CAPABILITIES = {
  'transport.chat-completion': {
    status: 'available',
    invocation: 'native',
  },
  'transport.text-completion': {
    status: 'unavailable',
    reason_code: 'capability_not_implemented',
  },
  'transport.tauri-bridge': {
    status: 'unavailable',
    reason_code: 'capability_not_implemented',
  },
  'retrieval.embedding': {
    status: 'unavailable',
    reason_code: 'adapter_not_configured',
  },
  'retrieval.graph': {
    status: 'unavailable',
    reason_code: 'adapter_not_configured',
  },
  'retrieval.rerank': {
    status: 'unavailable',
    reason_code: 'adapter_not_configured',
  },
  'host.source-removal-authorizer': {
    status: 'unavailable',
    reason_code: 'source_removal_authorizer_not_configured',
  },
  'host.mixed-source-provenance': {
    status: 'unavailable',
    reason_code: 'source_route_not_traceable',
  },
  'subagent.background-simulator': {
    status: 'unavailable',
    reason_code: 'capability_not_implemented',
  },
  'subagent.attention-critic': {
    status: 'unavailable',
    reason_code: 'capability_not_implemented',
  },
};

function unavailableResult(capability, reasonCode) {
  return {
    schema: 'mnemosyne.capability-result.v1',
    capability,
    status: 'unavailable',
    reason_code: reasonCode,
    retryable: false,
  };
}

function nativeResult(capability) {
  return {
    schema: 'mnemosyne.capability-result.v1',
    capability,
    status: 'available',
    invocation: 'native',
    retryable: false,
  };
}

export function createCapabilityRegistry(adapters = {}) {
  const registry = new Map();

  for (const [capability, definition] of Object.entries(RESERVED_CAPABILITIES)) {
    const adapter = adapters[capability];
    registry.set(capability, typeof adapter === 'function'
      ? { status: 'available', adapter }
      : { ...definition });
  }

  return registry;
}

export function listCapabilities(registry) {
  return [...registry.entries()].map(([capability, definition]) => ({
    capability,
    status: definition.status,
    invocation: definition.invocation ?? (definition.adapter ? 'adapter' : null),
    reason_code: definition.reason_code ?? null,
  }));
}

export async function invokeCapability(registry, capability, input) {
  const definition = registry.get(capability);
  if (!definition) {
    throw new MnemosyneRequestError(
      'capability_unknown',
      `Unknown capability: ${capability}`,
    );
  }

  if (definition.status !== 'available') {
    return unavailableResult(capability, definition.reason_code ?? 'capability_not_implemented');
  }

  if (typeof definition.adapter === 'function') {
    return definition.adapter(input);
  }

  if (definition.invocation === 'native') {
    return nativeResult(capability);
  }

  return unavailableResult(capability, definition.reason_code ?? 'capability_not_implemented');
}
