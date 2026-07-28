import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';

const WITNESS_SCHEMA =
  'mnemosyne.recent-continuity-strip-witness.v2';
const COORDINATE_BASIS_SCHEMA =
  'mnemosyne.host-history-coordinate-basis.v1';
const HOST_HISTORY_BINDING_SCHEMA =
  'mnemosyne.host-history-binding.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const HISTORY_IDENTIFIER_PATTERN = /^chatHistory-([1-9]\d*)$/;
const HOST_HISTORY_BINDING_KEYS = Object.freeze([
  'binding_hash',
  'branch_epoch',
  'branch_id',
  'chat_id_hash',
  'last_message_body_hash',
  'last_message_index',
  'last_message_role',
  'message_count',
  'messages_hash',
  'parent_turn_index',
  'schema',
  'target_turn_index',
  'visible_turn_index',
]);
const COORDINATE_BASIS_KEYS = Object.freeze([
  'basis_hash',
  'generation_type',
  'host_history_binding_hash',
  'host_message_indices',
  'run_id',
  'schema',
]);
const PROVIDER_FINGERPRINT_KEYS = Object.freeze([
  'content_hash',
  'message_hash',
  'name',
  'provider_index',
  'role',
]);
const COORDINATE_KEYS = Object.freeze([
  'assembled_history_identifier',
  'identifier',
  'name',
  'prompt_message_hash',
  'provider_index',
  'provider_message_hash',
  'role',
]);
const WITNESS_KEYS = Object.freeze([
  'assembled_history_message_count',
  'captured_host_history_message_count',
  'coordinates',
  'first_retained_assembled_history_identifier',
  'host_history_binding_hash',
  'host_history_coordinate_basis_hash',
  'last_retained_assembled_history_identifier',
  'non_origin_history_slot_count',
  'omitted_assembled_history_message_count',
  'provider_message_set_hash',
  'retained_history_message_count',
  'schema',
  'status',
  'total_host_message_count',
  'witness_hash',
]);

function fail(message, details = undefined) {
  throw new MnemosyneRequestError(
    'recent_continuity_strip_invalid',
    message,
    details,
  );
}

function isObject(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  );
}

function hasExactKeys(value, keys) {
  return (
    isObject(value)
    && canonicalJson(Object.keys(value).sort())
      === canonicalJson([...keys].sort())
  );
}

function assertHostHistoryBinding(binding) {
  if (
    !hasExactKeys(binding, HOST_HISTORY_BINDING_KEYS)
    || binding.schema !== HOST_HISTORY_BINDING_SCHEMA
    || !HASH_PATTERN.test(binding.chat_id_hash ?? '')
    || binding.branch_id !== 'main'
    || !Number.isInteger(binding.branch_epoch)
    || binding.branch_epoch < 0
    || !Number.isInteger(binding.visible_turn_index)
    || binding.visible_turn_index < 0
    || !Number.isInteger(binding.parent_turn_index)
    || binding.parent_turn_index < 0
    || !Number.isInteger(binding.target_turn_index)
    || binding.target_turn_index < 0
    || !Number.isInteger(binding.message_count)
    || binding.message_count <= 0
    || !HASH_PATTERN.test(binding.messages_hash ?? '')
    || binding.last_message_index !== binding.message_count - 1
    || !['user', 'assistant', 'system'].includes(
      binding.last_message_role,
    )
    || !HASH_PATTERN.test(binding.last_message_body_hash ?? '')
    || !HASH_PATTERN.test(binding.binding_hash ?? '')
  ) {
    fail('Recent Continuity Strip requires an exact host history binding.');
  }
  const {
    binding_hash: bindingHash,
    ...payload
  } = binding;
  if (bindingHash !== sha256(canonicalJson(payload))) {
    fail('Host history binding no longer matches its sealed hash.');
  }
  return binding;
}

function basisPayload(basis) {
  const {
    basis_hash: _basisHash,
    ...payload
  } = basis;
  return payload;
}

function assertHostHistoryCoordinateBasis(basis, binding) {
  if (
    !hasExactKeys(basis, COORDINATE_BASIS_KEYS)
    || basis.schema !== COORDINATE_BASIS_SCHEMA
    || typeof basis.run_id !== 'string'
    || !basis.run_id
    || !['normal', 'regenerate', 'swipe'].includes(
      basis.generation_type,
    )
    || basis.host_history_binding_hash !== binding.binding_hash
    || !Array.isArray(basis.host_message_indices)
    || basis.host_message_indices.length === 0
    || basis.host_message_indices.some(index => (
      !Number.isInteger(index)
      || index < 0
      || index >= binding.message_count
    ))
    || basis.host_message_indices.some((index, offset) => (
      offset > 0
      && index <= basis.host_message_indices[offset - 1]
    ))
    || new Set(basis.host_message_indices).size
      !== basis.host_message_indices.length
    || !HASH_PATTERN.test(basis.basis_hash ?? '')
    || basis.basis_hash
      !== sha256(canonicalJson(basisPayload(basis)))
  ) {
    fail(
      'Recent Continuity Strip requires a sealed final-interceptor coordinate basis.',
    );
  }
  return basis;
}

function assertProviderMessageFingerprints(fingerprints) {
  if (
    !Array.isArray(fingerprints)
    || fingerprints.length === 0
    || fingerprints.some((fingerprint, index) => (
      !hasExactKeys(fingerprint, PROVIDER_FINGERPRINT_KEYS)
      || fingerprint.provider_index !== index
      || typeof fingerprint.role !== 'string'
      || !fingerprint.role
      || (
        fingerprint.name !== null
        && typeof fingerprint.name !== 'string'
      )
      || !HASH_PATTERN.test(fingerprint.content_hash ?? '')
      || !HASH_PATTERN.test(fingerprint.message_hash ?? '')
    ))
  ) {
    fail(
      'Recent Continuity Strip requires exact provider-message fingerprints.',
    );
  }
  return fingerprints;
}

function witnessPayload(witness) {
  const {
    witness_hash: _witnessHash,
    ...payload
  } = witness;
  return payload;
}

function assertCoordinateSequence(coordinates, {
  assembledHistoryMessageCount,
  providerMessageFingerprints,
}) {
  if (
    !Array.isArray(coordinates)
    || coordinates.length === 0
  ) {
    fail('Recent Continuity Strip cannot be empty.');
  }
  const seenProviderIndices = new Set();
  for (let offset = 0; offset < coordinates.length; offset += 1) {
    const coordinate = coordinates[offset];
    const fingerprint =
      providerMessageFingerprints[coordinate?.provider_index];
    const expectedIdentifier =
      coordinates[0]?.assembled_history_identifier + offset;
    if (
      !hasExactKeys(coordinate, COORDINATE_KEYS)
      || !Number.isInteger(
        coordinate.assembled_history_identifier,
      )
      || coordinate.assembled_history_identifier <= 0
      || coordinate.assembled_history_identifier
        > assembledHistoryMessageCount
      || coordinate.assembled_history_identifier
        !== expectedIdentifier
      || coordinate.identifier
        !== `chatHistory-${
          coordinate.assembled_history_identifier
        }`
      || !Number.isInteger(coordinate.provider_index)
      || coordinate.provider_index < 0
      || seenProviderIndices.has(coordinate.provider_index)
      || typeof coordinate.role !== 'string'
      || !coordinate.role
      || (
        coordinate.name !== null
        && typeof coordinate.name !== 'string'
      )
      || !HASH_PATTERN.test(coordinate.prompt_message_hash ?? '')
      || !HASH_PATTERN.test(coordinate.provider_message_hash ?? '')
      || !fingerprint
      || fingerprint.role !== coordinate.role
      || fingerprint.name !== coordinate.name
      || fingerprint.message_hash
        !== coordinate.provider_message_hash
    ) {
      fail(
        'Recent Continuity Strip coordinates are incomplete, non-contiguous, or unbound.',
        { coordinate_offset: offset },
      );
    }
    seenProviderIndices.add(coordinate.provider_index);
  }
  if (
    coordinates.at(-1).assembled_history_identifier
      !== assembledHistoryMessageCount
  ) {
    fail(
      'Recent Continuity Strip must end at the newest assembled-history identifier.',
    );
  }
}

export function verifyRecentContinuityStripWitness(
  witness,
  {
    hostHistoryBinding,
    hostHistoryCoordinateBasis,
    providerMessageFingerprints,
  } = {},
) {
  const binding = assertHostHistoryBinding(hostHistoryBinding);
  const basis = assertHostHistoryCoordinateBasis(
    hostHistoryCoordinateBasis,
    binding,
  );
  const fingerprints = assertProviderMessageFingerprints(
    providerMessageFingerprints,
  );
  if (
    !hasExactKeys(witness, WITNESS_KEYS)
    || witness.schema !== WITNESS_SCHEMA
    || !['bounded_tail', 'full_history'].includes(witness.status)
    || witness.host_history_binding_hash !== binding.binding_hash
    || witness.host_history_coordinate_basis_hash
      !== basis.basis_hash
    || witness.provider_message_set_hash
      !== sha256(canonicalJson(fingerprints))
    || witness.total_host_message_count
      !== binding.message_count
    || witness.captured_host_history_message_count
      !== basis.host_message_indices.length
    || !Number.isInteger(witness.assembled_history_message_count)
    || witness.assembled_history_message_count <= 0
    || !Number.isInteger(witness.non_origin_history_slot_count)
    || witness.non_origin_history_slot_count < 0
    || !Number.isInteger(
      witness.first_retained_assembled_history_identifier,
    )
    || !Number.isInteger(
      witness.last_retained_assembled_history_identifier,
    )
    || !Number.isInteger(witness.retained_history_message_count)
    || !Number.isInteger(
      witness.omitted_assembled_history_message_count,
    )
    || !HASH_PATTERN.test(witness.witness_hash ?? '')
  ) {
    fail('Recent Continuity Strip witness shape or binding is invalid.');
  }
  assertCoordinateSequence(witness.coordinates, {
    assembledHistoryMessageCount:
      witness.assembled_history_message_count,
    providerMessageFingerprints: fingerprints,
  });
  const first =
    witness.coordinates[0].assembled_history_identifier;
  const last =
    witness.coordinates.at(-1).assembled_history_identifier;
  const expectedStatus = first === 1
    ? 'full_history'
    : 'bounded_tail';
  if (
    witness.assembled_history_message_count !== last
    || witness.non_origin_history_slot_count
      !== last - basis.host_message_indices.length
    || witness.first_retained_assembled_history_identifier !== first
    || witness.last_retained_assembled_history_identifier !== last
    || witness.retained_history_message_count
      !== witness.coordinates.length
    || witness.omitted_assembled_history_message_count !== first - 1
    || witness.status !== expectedStatus
    || witness.witness_hash
      !== sha256(canonicalJson(witnessPayload(witness)))
  ) {
    fail('Recent Continuity Strip witness claims do not match its coordinates.');
  }
  return structuredClone(witness);
}

export function createRecentContinuityStripWitness({
  promptManagerEntries,
  hostHistoryBinding,
  hostHistoryCoordinateBasis,
  retainedProviderIndices,
  providerMessageFingerprints,
} = {}) {
  const binding = assertHostHistoryBinding(hostHistoryBinding);
  const basis = assertHostHistoryCoordinateBasis(
    hostHistoryCoordinateBasis,
    binding,
  );
  const fingerprints = assertProviderMessageFingerprints(
    providerMessageFingerprints,
  );
  if (
    !Array.isArray(promptManagerEntries)
    || !Array.isArray(retainedProviderIndices)
    || retainedProviderIndices.length !== fingerprints.length
    || retainedProviderIndices.some(index => (
      !Number.isInteger(index) || index < 0
    ))
    || new Set(retainedProviderIndices).size
      !== retainedProviderIndices.length
  ) {
    fail('Recent Continuity Strip inputs are incomplete or ambiguous.');
  }
  const retainedIndexByOriginal = new Map(
    retainedProviderIndices.map((originalIndex, retainedIndex) => (
      [originalIndex, retainedIndex]
    )),
  );
  const historyEntries = promptManagerEntries.filter(entry => (
    entry?.source_label === 'host_recent_chat'
    || HISTORY_IDENTIFIER_PATTERN.test(String(entry?.identifier ?? ''))
  )).map(entry => ({
    entry,
    match: String(entry?.identifier ?? '').match(
      HISTORY_IDENTIFIER_PATTERN,
    ),
  })).sort((left, right) => (
    Number(left.match?.[1]) - Number(right.match?.[1])
  ));
  if (
    historyEntries.length === 0
    || historyEntries.some(({ entry, match }, index) => (
      !match
      || entry.source_label !== 'host_recent_chat'
      || entry.retention_policy !== 'retain'
      || (
        index > 0
        && Number(match[1])
          !== Number(historyEntries[index - 1].match[1]) + 1
      )
    ))
  ) {
    fail(
      'Assembled history entries must form one exact retained coordinate sequence.',
    );
  }
  const firstMappedOffset = historyEntries.findIndex(
    ({ entry }) => Number.isInteger(entry.provider_index),
  );
  if (
    firstMappedOffset < 0
    || historyEntries.slice(0, firstMappedOffset).some(
      ({ entry }) => Number.isInteger(entry.provider_index),
    )
    || historyEntries.slice(firstMappedOffset).some(
      ({ entry }) => !Number.isInteger(entry.provider_index),
    )
  ) {
    fail(
      'Assembled history provider mappings must form one non-empty suffix.',
    );
  }
  const coordinates = historyEntries
    .slice(firstMappedOffset)
    .map(({ entry, match }) => {
    const providerIndex = retainedIndexByOriginal.get(
      entry?.provider_index,
    );
    const fingerprint = fingerprints[providerIndex];
    if (
      !match
      || entry.source_label !== 'host_recent_chat'
      || entry.retention_policy !== 'retain'
      || !Number.isInteger(entry.provider_index)
      || !Number.isInteger(providerIndex)
      || !fingerprint
      || fingerprint.role !== entry.role
      || (fingerprint.name ?? null) !== (entry.name ?? null)
      || !HASH_PATTERN.test(entry.prompt_message_hash ?? '')
    ) {
      fail(
        'Every retained assembled-history entry must have one exact provider mapping.',
        { identifier: entry?.identifier ?? null },
      );
    }
    return {
      assembled_history_identifier: Number(match[1]),
      identifier: entry.identifier,
      provider_index: providerIndex,
      role: entry.role,
      name: entry.name ?? null,
      prompt_message_hash: entry.prompt_message_hash,
      provider_message_hash: fingerprint.message_hash,
    };
  }).sort((left, right) => (
    left.assembled_history_identifier
      - right.assembled_history_identifier
  ));
  const assembledHistoryMessageCount =
    Number(historyEntries.at(-1).match[1]);
  assertCoordinateSequence(coordinates, {
    assembledHistoryMessageCount,
    providerMessageFingerprints: fingerprints,
  });
  const nonOriginHistorySlotCount =
    assembledHistoryMessageCount
    - basis.host_message_indices.length;
  if (nonOriginHistorySlotCount < 0) {
    fail(
      'Assembled history cannot contain fewer slots than the captured host origin.',
    );
  }
  const first = coordinates[0].assembled_history_identifier;
  const payload = {
    schema: WITNESS_SCHEMA,
    status: first === 1 ? 'full_history' : 'bounded_tail',
    host_history_binding_hash: binding.binding_hash,
    host_history_coordinate_basis_hash: basis.basis_hash,
    provider_message_set_hash: sha256(canonicalJson(fingerprints)),
    total_host_message_count: binding.message_count,
    captured_host_history_message_count:
      basis.host_message_indices.length,
    assembled_history_message_count: assembledHistoryMessageCount,
    non_origin_history_slot_count: nonOriginHistorySlotCount,
    first_retained_assembled_history_identifier: first,
    last_retained_assembled_history_identifier:
      coordinates.at(-1).assembled_history_identifier,
    retained_history_message_count: coordinates.length,
    omitted_assembled_history_message_count: first - 1,
    coordinates,
  };
  const witness = {
    ...payload,
    witness_hash: sha256(canonicalJson(payload)),
  };
  return verifyRecentContinuityStripWitness(witness, {
    hostHistoryBinding: binding,
    hostHistoryCoordinateBasis: basis,
    providerMessageFingerprints: fingerprints,
  });
}

export function proveHostArtifactOutsideRecentContinuityStrip({
  witness,
  hostHistoryBinding,
  hostHistoryCoordinateBasis,
  providerMessageFingerprints,
  artifactTurnIndex,
} = {}) {
  const verified = verifyRecentContinuityStripWitness(witness, {
    hostHistoryBinding,
    hostHistoryCoordinateBasis,
    providerMessageFingerprints,
  });
  const ordinal =
    hostHistoryCoordinateBasis.host_message_indices.indexOf(
      artifactTurnIndex,
    );
  const maximumIdentifier = (
    ordinal + 1 + verified.non_origin_history_slot_count
  );
  if (
    verified.status !== 'bounded_tail'
    || !Number.isInteger(artifactTurnIndex)
    || artifactTurnIndex < 0
    || ordinal < 0
    || maximumIdentifier
      >= verified.first_retained_assembled_history_identifier
  ) {
    fail(
      'The selected host artifact is not provably outside the assembled Recent Continuity Strip.',
      {
        artifact_turn_index: artifactTurnIndex ?? null,
        captured_history_ordinal: ordinal,
        maximum_assembled_history_identifier:
          ordinal < 0 ? null : maximumIdentifier,
        first_retained_assembled_history_identifier:
          verified.first_retained_assembled_history_identifier,
      },
    );
  }
  return {
    status: 'outside',
    artifact_turn_index: artifactTurnIndex,
    captured_history_ordinal: ordinal,
    maximum_assembled_history_identifier: maximumIdentifier,
    first_retained_assembled_history_identifier:
      verified.first_retained_assembled_history_identifier,
  };
}
