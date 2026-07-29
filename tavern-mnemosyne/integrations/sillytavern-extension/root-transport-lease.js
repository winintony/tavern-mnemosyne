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

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} contains an unexpected field.`);
  }
}

function assertCompactString(value, field) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} is invalid.`);
  }
}

export function sealGenerationTransportBinding(lease) {
  const sealedLease = sealRootTransportLease(lease);
  return Object.freeze({
    schema: 'mnemosyne.generation-transport-binding.v1',
    protocol_version: sealedLease.protocol_version,
    runtime_build_id: sealedLease.runtime_build_id,
    runtime_instance_id: sealedLease.runtime_instance_id,
    generation_binding_hash: sealedLease.generation_binding_hash,
    operation_registry_hash: sealedLease.operation_registry_hash,
  });
}

export function sealRootTransportLease(lease) {
  assertExactKeys(lease, LEASE_KEYS, 'Transport lease');
  if (!['bridge', 'loopback'].includes(lease.adapter_id)) {
    throw new Error('adapter_id is invalid.');
  }
  for (const field of [
    'protocol_version',
    'bridge_version',
    'runtime_build_id',
    'runtime_instance_id',
  ]) {
    assertCompactString(lease[field], field);
  }
  for (const field of [
    'generation_binding_hash',
    'operation_registry_hash',
  ]) {
    if (!/^[a-f0-9]{64}$/.test(lease[field])) {
      throw new Error(`${field} is invalid.`);
    }
  }
  if (
    typeof lease.resolved_at !== 'string'
    || !Number.isFinite(Date.parse(lease.resolved_at))
  ) {
    throw new Error('resolved_at is invalid.');
  }
  return Object.freeze(structuredClone(lease));
}

export function mergeTransportLeaseIntoCustomBody(
  customIncludeBody,
  lease,
) {
  let parsed = {};
  if (customIncludeBody) {
    parsed = JSON.parse(customIncludeBody);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Custom OpenAI body must be a JSON object.');
  }
  return JSON.stringify({
    ...parsed,
    mnemosyne_transport_lease: sealRootTransportLease(lease),
    mnemosyne_transport_binding:
      sealGenerationTransportBinding(lease),
  });
}

// The finalize hook runs inside a generation, where a run is already open but
// the cached lease may never have been bound: the only call that binds one is
// the health poll, and it binds nothing when it runs before the run id exists.
// Without a lease the seal throws, the request is sent down the blocked path
// with no binding at all, and the proxy answers 409. Resolving one here keeps
// the request whole instead.
export async function mergeResolvedTransportLeaseIntoCustomBody(
  customIncludeBody,
  { lease = null, resolveLease } = {},
) {
  if (typeof resolveLease !== 'function') {
    throw new Error('A transport lease resolver is required.');
  }
  return mergeTransportLeaseIntoCustomBody(
    customIncludeBody,
    lease ?? await resolveLease(),
  );
}
