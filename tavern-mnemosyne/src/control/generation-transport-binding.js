import { MnemosyneRequestError } from '../contracts/errors.js';

const BINDING_KEYS = Object.freeze([
  'schema',
  'protocol_version',
  'runtime_build_id',
  'runtime_instance_id',
  'generation_binding_hash',
  'operation_registry_hash',
]);

const LEASE_KEYS = Object.freeze([
  'adapter_id',
  'protocol_version',
  'bridge_version',
  'runtime_build_id',
  'runtime_instance_id',
  'generation_binding_hash',
  'operation_registry_hash',
  'resolved_at',
]);

function fail(reasonCode, message, field = null) {
  const error = new MnemosyneRequestError(
    reasonCode,
    message,
    field ? { field } : undefined,
  );
  error.statusCode = 409;
  throw error;
}

export function assertGenerationTransportBinding(binding, {
  protocolVersion,
  runtimeBuildId,
  runtimeInstanceId,
  generationBindingHash,
  operationRegistryHash,
} = {}) {
  if (binding === undefined || binding === null) {
    fail(
      'generation_transport_binding_missing',
      'A sealed generation transport binding is required.',
    );
  }
  if (
    typeof binding !== 'object'
    || Array.isArray(binding)
    || Object.keys(binding).length !== BINDING_KEYS.length
    || BINDING_KEYS.some(key => !Object.hasOwn(binding, key))
    || binding.schema !== 'mnemosyne.generation-transport-binding.v1'
  ) {
    fail(
      'generation_transport_binding_invalid',
      'The generation transport binding is invalid.',
    );
  }
  const comparisons = [
    [
      'protocol_version',
      protocolVersion,
      'generation_protocol_mismatch',
    ],
    [
      'runtime_build_id',
      runtimeBuildId,
      'generation_runtime_build_mismatch',
    ],
    [
      'runtime_instance_id',
      runtimeInstanceId,
      'generation_runtime_instance_mismatch',
    ],
    [
      'generation_binding_hash',
      generationBindingHash,
      'generation_endpoint_binding_mismatch',
    ],
    [
      'operation_registry_hash',
      operationRegistryHash,
      'generation_operation_registry_mismatch',
    ],
  ];
  for (const [field, expected, reasonCode] of comparisons) {
    if (
      typeof binding[field] !== 'string'
      || !binding[field]
      || binding[field] !== expected
    ) {
      fail(
        reasonCode,
        'The generation transport binding no longer matches the runtime.',
        field,
      );
    }
  }
  return Object.freeze(structuredClone(binding));
}

export function assertRootTransportLease(lease, binding) {
  if (
    typeof lease !== 'object'
    || lease === null
    || Array.isArray(lease)
    || Object.keys(lease).length !== LEASE_KEYS.length
    || LEASE_KEYS.some(key => !Object.hasOwn(lease, key))
    || !['bridge', 'loopback'].includes(lease.adapter_id)
  ) {
    fail(
      'root_transport_lease_invalid',
      'The root transport lease is invalid.',
    );
  }
  for (const field of [
    'protocol_version',
    'bridge_version',
    'runtime_build_id',
    'runtime_instance_id',
  ]) {
    if (
      typeof lease[field] !== 'string'
      || !lease[field]
      || lease[field].length > 512
      || /[\u0000-\u001f\u007f]/.test(lease[field])
    ) {
      fail(
        'root_transport_lease_invalid',
        'The root transport lease is invalid.',
        field,
      );
    }
  }
  for (const field of [
    'generation_binding_hash',
    'operation_registry_hash',
  ]) {
    if (!/^[a-f0-9]{64}$/.test(lease[field])) {
      fail(
        'root_transport_lease_invalid',
        'The root transport lease is invalid.',
        field,
      );
    }
  }
  if (
    typeof lease.resolved_at !== 'string'
    || !Number.isFinite(Date.parse(lease.resolved_at))
  ) {
    fail(
      'root_transport_lease_invalid',
      'The root transport lease is invalid.',
      'resolved_at',
    );
  }
  for (const field of [
    'protocol_version',
    'runtime_build_id',
    'runtime_instance_id',
    'generation_binding_hash',
    'operation_registry_hash',
  ]) {
    if (lease[field] !== binding[field]) {
      fail(
        'root_transport_lease_binding_mismatch',
        'The root transport lease does not match its generation binding.',
        field,
      );
    }
  }
  return Object.freeze(structuredClone(lease));
}
