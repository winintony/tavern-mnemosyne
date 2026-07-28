const TURN_RECORD_REF_PATTERN = (
  /^memory:\/\/turn-record\/([A-Za-z0-9][A-Za-z0-9._-]*)$/
);
const OKF_ENTITY_REF_PATTERN = (
  /^okf:\/\/entity\/([A-Za-z0-9][A-Za-z0-9._-]*)$/
);
const CURRENT_STATE_REF_PATTERN = (
  /^okf:\/\/entity\/([A-Za-z0-9][A-Za-z0-9._-]*)\/state\/([^/]+)\/([^/]+)$/
);
const ACTIVE_SCENE_SCOPE_PATTERN = (
  /^mnemosyne:\/\/chat\/([^/]+)\/active-scene$/
);

function decodeCanonicalSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded
      && encodeURIComponent(decoded) === value
    )
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export const MEMORY_REFERENCE_CONTRACT_VERSION =
  'mnemosyne.memory-reference.v1';

export function formatCurrentStateMemoryRef({
  entityRef,
  stateDomain,
  stateKey,
}) {
  const entityMatch = String(entityRef ?? '').match(
    OKF_ENTITY_REF_PATTERN,
  );
  if (
    !entityMatch
    || typeof stateDomain !== 'string'
    || !stateDomain
    || typeof stateKey !== 'string'
    || !stateKey
  ) {
    throw new TypeError(
      'Current State references require an OKF entity and non-empty coordinate.',
    );
  }
  return [
    `okf://entity/${entityMatch[1]}/state`,
    encodeURIComponent(stateDomain),
    encodeURIComponent(stateKey),
  ].join('/');
}

export function parseMemoryReference(ref) {
  const normalized = String(ref ?? '');
  const turnRecordMatch = normalized.match(TURN_RECORD_REF_PATTERN);
  if (turnRecordMatch) {
    return {
      kind: 'turn_record',
      ref: normalized,
      recordId: turnRecordMatch[1],
    };
  }
  const currentStateMatch = normalized.match(CURRENT_STATE_REF_PATTERN);
  if (currentStateMatch) {
    const stateDomain = decodeCanonicalSegment(currentStateMatch[2]);
    const stateKey = decodeCanonicalSegment(currentStateMatch[3]);
    if (stateDomain !== null && stateKey !== null) {
      return {
        kind: 'current_state',
        ref: normalized,
        entityId: currentStateMatch[1],
        entityRef: `okf://entity/${currentStateMatch[1]}`,
        stateDomain,
        stateKey,
      };
    }
    return null;
  }
  const okfEntityMatch = normalized.match(OKF_ENTITY_REF_PATTERN);
  if (okfEntityMatch) {
    return {
      kind: 'okf_entity',
      ref: normalized,
      entityId: okfEntityMatch[1],
    };
  }
  return null;
}

export function parseMemoryScopeReference(ref) {
  const memoryReference = parseMemoryReference(ref);
  if (memoryReference) return memoryReference;
  const normalized = String(ref ?? '');
  const activeSceneMatch = normalized.match(
    ACTIVE_SCENE_SCOPE_PATTERN,
  );
  if (!activeSceneMatch) return null;
  const chatId = decodeCanonicalSegment(activeSceneMatch[1]);
  return chatId === null
    ? null
    : {
        kind: 'active_scene_scope',
        ref: normalized,
        chatId,
      };
}
