const COMPONENT_SCHEMA =
  'mnemosyne.host-component-provenance.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WORLD_INFO_DEPTH_IDENTIFIER = /^customDepthWI_(\d+)_([012])$/;
const COMPONENT_KEYS = Object.freeze([
  'component_hash',
  'identifier',
  'provenance_kind',
  'schema',
  'source_selectors',
]);
const STATIC_SELECTOR_KEYS = Object.freeze([
  'include_parts',
  'source_id',
  'source_kind',
  'unit_id',
]);
const WORLD_INFO_SELECTOR_KEYS = Object.freeze([
  'assembly_index',
  'depth',
  'include_parts',
  'position',
  'prepared_content_hash',
  'raw_content_hash',
  'role',
  'route_identifier',
  'source_id',
  'source_kind',
  'uid',
  'unit_id',
  'world',
]);

const FIXED_COMPONENT_SELECTORS = Object.freeze({
  charDescription: Object.freeze({
    source_id: 'character-card:active',
    source_kind: 'character_card',
    unit_id: 'description',
    include_parts: true,
  }),
  charPersonality: Object.freeze({
    source_id: 'character-card:active',
    source_kind: 'character_card',
    unit_id: 'personality',
    include_parts: true,
  }),
  scenario: Object.freeze({
    source_id: 'scenario:active',
    source_kind: 'scenario',
    unit_id: 'content',
    include_parts: true,
  }),
  personaDescription: Object.freeze({
    source_id: 'persona:active',
    source_kind: 'persona',
    unit_id: 'description',
    include_parts: true,
  }),
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sealComponent(payload) {
  return Object.freeze({
    ...payload,
    component_hash: await sha256(canonicalJson(payload)),
  });
}

function provenanceError(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

function diagnosticIdentifier(value) {
  const normalized = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return normalized || null;
}

function hasExactKeys(value, expectedKeys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',')
      === [...expectedKeys].sort().join(',')
  );
}

function normalizedWorldInfoRoute(entry) {
  const position = Number(entry?.position);
  if (position === 0) {
    return {
      identifier: 'worldInfoBefore',
      position,
      depth: null,
      role: null,
    };
  }
  if (position === 1) {
    return {
      identifier: 'worldInfoAfter',
      position,
      depth: null,
      role: null,
    };
  }
  if (position !== 4) return null;

  const rawDepth = Number(entry?.depth);
  const depth = Number.isSafeInteger(rawDepth) && rawDepth >= 0
    ? rawDepth
    : 4;
  const rawRole = Number(entry?.role);
  const role = [0, 1, 2].includes(rawRole) ? rawRole : 0;
  return {
    identifier: `customDepthWI_${depth}_${role}`,
    position,
    depth,
    role,
  };
}

function assertWorldInfoIdentity(entry) {
  const world = typeof entry?.world === 'string'
    ? entry.world
    : '';
  const uidValue = entry?.uid;
  const uidValid = (
    (
      typeof uidValue === 'string'
      && uidValue.length > 0
      && !uidValue.includes('\u0000')
    )
    || (
      typeof uidValue === 'number'
      && Number.isSafeInteger(uidValue)
      && uidValue >= 0
    )
  );
  if (
    !world.trim()
    || world.includes('\u0000')
    || !uidValid
  ) {
    throw provenanceError(
      'host_component_selector_invalid',
      'World Info provenance requires an exact world name and uid.',
    );
  }
  return {
    world,
    uid: String(entry.uid),
  };
}

function assertWorldInfoHashes(entry) {
  if (
    !HASH_PATTERN.test(String(entry?.raw_content_hash ?? ''))
    || !HASH_PATTERN.test(String(entry?.prepared_content_hash ?? ''))
  ) {
    throw provenanceError(
      'host_component_selector_invalid',
      'World Info provenance requires exact raw and prepared content hashes.',
    );
  }
}

function assertRouteMatches(entry, route) {
  if (
    !route
    || String(entry?.routeIdentifier ?? '') !== route.identifier
  ) {
    throw provenanceError(
      'host_component_route_mismatch',
      'World Info provenance no longer matches its host route.',
    );
  }
}

function selectorIdentity(selector) {
  return JSON.stringify([selector.world, selector.uid]);
}

async function validateStaticComponent(component) {
  const expected = await fixedHostComponentProvenance(
    component.identifier,
  );
  if (
    !expected
    || canonicalJson(component) !== canonicalJson(expected)
  ) {
    throw provenanceError(
      'host_component_provenance_drift',
      'Static host component provenance no longer matches its selector.',
    );
  }
  return structuredClone(expected);
}

async function validateWorldInfoComponent(component) {
  if (
    component.provenance_kind !== 'world_info_entries'
    || !(
      component.identifier === 'worldInfoBefore'
      || component.identifier === 'worldInfoAfter'
      || WORLD_INFO_DEPTH_IDENTIFIER.test(component.identifier)
    )
    || component.source_selectors.length === 0
  ) {
    throw provenanceError(
      'host_component_selector_invalid',
      'World Info component provenance is invalid.',
    );
  }

  const selectorIdentities = new Set();
  for (
    let index = 0;
    index < component.source_selectors.length;
    index += 1
  ) {
    const selector = component.source_selectors[index];
    if (!hasExactKeys(selector, WORLD_INFO_SELECTOR_KEYS)) {
      throw provenanceError(
        'host_component_selector_invalid',
        'World Info provenance contains unsupported selector fields.',
      );
    }
    const identity = assertWorldInfoIdentity(selector);
    assertWorldInfoHashes(selector);
    const route = normalizedWorldInfoRoute(selector);
    if (
      !route
      || selector.route_identifier !== route.identifier
      || component.identifier !== route.identifier
      || selector.depth !== route.depth
      || selector.role !== route.role
    ) {
      throw provenanceError(
        'host_component_route_mismatch',
        'World Info selector route metadata does not match its component.',
      );
    }
    if (
      selector.position !== route.position
      || selector.source_id !== `worldbook:${identity.world}`
      || selector.source_kind !== 'worldbook'
      || selector.unit_id !== identity.uid
      || selector.include_parts !== true
      || selector.assembly_index !== index
    ) {
      throw provenanceError(
        'host_component_selector_invalid',
        'World Info selector fields do not match the activated source unit.',
      );
    }
    const identityKey = selectorIdentity(selector);
    if (selectorIdentities.has(identityKey)) {
      throw provenanceError(
        'host_component_selector_duplicate',
        'World Info component provenance contains a duplicate selector.',
      );
    }
    selectorIdentities.add(identityKey);
  }

  const payload = {
    schema: component.schema,
    identifier: component.identifier,
    provenance_kind: component.provenance_kind,
    source_selectors: component.source_selectors,
  };
  if (await sha256(canonicalJson(payload)) !== component.component_hash) {
    throw provenanceError(
      'host_component_provenance_drift',
      'World Info component provenance no longer matches its seal.',
    );
  }
  return structuredClone(component);
}

export async function hashHostProvenanceContent(value) {
  return sha256(String(value ?? ''));
}

export async function fixedHostComponentProvenance(identifier) {
  const selector = FIXED_COMPONENT_SELECTORS[identifier];
  if (!selector) return null;
  return sealComponent({
    schema: COMPONENT_SCHEMA,
    identifier,
    provenance_kind: 'static_field',
    source_selectors: [structuredClone(selector)],
  });
}

export async function validateHostComponentProvenance(
  component,
  { identifier = null } = {},
) {
  if (
    !hasExactKeys(component, COMPONENT_KEYS)
    || component.schema !== COMPONENT_SCHEMA
    || typeof component.identifier !== 'string'
    || !component.identifier
    || (
      identifier !== null
      && component.identifier !== identifier
    )
    || !Array.isArray(component.source_selectors)
    || !HASH_PATTERN.test(String(component.component_hash ?? ''))
  ) {
    throw provenanceError(
      'host_component_provenance_invalid',
      'Host component provenance has an invalid or unsupported shape.',
    );
  }
  if (component.provenance_kind === 'static_field') {
    if (
      component.source_selectors.length !== 1
      || !hasExactKeys(
        component.source_selectors[0],
        STATIC_SELECTOR_KEYS,
      )
    ) {
      throw provenanceError(
        'host_component_selector_invalid',
        'Static host component provenance has an invalid selector.',
      );
    }
    return validateStaticComponent(component);
  }
  return validateWorldInfoComponent(component);
}

export async function normalizeHostComponentProvenance(
  components = [],
) {
  if (!Array.isArray(components)) {
    throw provenanceError(
      'host_component_provenance_invalid',
      'Host component provenance must be an array.',
    );
  }
  const byIdentifier = new Map();
  const selectorIdentities = new Set();
  for (const component of components) {
    const normalized = await validateHostComponentProvenance(component);
    if (byIdentifier.has(normalized.identifier)) {
      throw provenanceError(
        'host_component_provenance_ambiguous',
        'Host component provenance contains a duplicate route.',
      );
    }
    for (const selector of normalized.source_selectors) {
      if (normalized.provenance_kind !== 'world_info_entries') continue;
      const identity = selectorIdentity(selector);
      if (selectorIdentities.has(identity)) {
        throw provenanceError(
          'host_component_selector_duplicate',
          'World Info provenance selects the same source unit twice.',
        );
      }
      selectorIdentities.add(identity);
    }
    byIdentifier.set(normalized.identifier, normalized);
  }
  return byIdentifier;
}

export async function resolveHostComponentProvenance({
  identifier,
  components = [],
} = {}) {
  const fixed = await fixedHostComponentProvenance(identifier);
  if (fixed) return structuredClone(fixed);
  const byIdentifier = components instanceof Map
    ? components
    : await normalizeHostComponentProvenance(components);
  const component = byIdentifier.get(identifier);
  if (!component) {
    const diagnostic = diagnosticIdentifier(identifier);
    const available = [
      byIdentifier.has('worldInfoBefore') ? 'before' : null,
      byIdentifier.has('worldInfoAfter') ? 'after' : null,
      [...byIdentifier.keys()].some(
        value => WORLD_INFO_DEPTH_IDENTIFIER.test(value),
      )
        ? 'depth'
        : null,
    ].filter(Boolean).join('_') || 'none';
    const reasonCode = diagnostic
      ? (
        `host_component_provenance_missing_${diagnostic}`
        + `_available_${available}`
      ).slice(0, 95)
      : 'host_component_provenance_missing';
    throw provenanceError(
      reasonCode,
      `Host component provenance is missing for ${identifier}.`,
    );
  }
  return validateHostComponentProvenance(
    component,
    { identifier },
  );
}

export async function buildWorldInfoComponentProvenance(entries = []) {
  if (!Array.isArray(entries)) {
    throw provenanceError(
      'host_component_provenance_invalid',
      'Activated World Info entries must be an array.',
    );
  }

  const identities = new Set();
  const grouped = new Map();
  const sortedEntries = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const orderDelta =
        Number(right.entry?.order) - Number(left.entry?.order);
      return Number.isFinite(orderDelta) && orderDelta !== 0
        ? orderDelta
        : left.index - right.index;
    });

  for (const { entry } of sortedEntries) {
    const identity = assertWorldInfoIdentity(entry);
    const identityKey = JSON.stringify([
      identity.world,
      identity.uid,
    ]);
    if (identities.has(identityKey)) {
      throw provenanceError(
        'host_component_selector_duplicate',
        'Activated World Info contains a duplicate source selector.',
      );
    }
    identities.add(identityKey);
    assertWorldInfoHashes(entry);

    const route = normalizedWorldInfoRoute(entry);
    assertRouteMatches(entry, route);
    const selectors = grouped.get(route.identifier) ?? [];
    selectors.unshift({
      source_id: `worldbook:${identity.world}`,
      source_kind: 'worldbook',
      unit_id: identity.uid,
      include_parts: true,
      world: identity.world,
      uid: identity.uid,
      route_identifier: route.identifier,
      position: route.position,
      depth: route.depth,
      role: route.role,
      assembly_index: -1,
      raw_content_hash: String(entry.raw_content_hash),
      prepared_content_hash: String(entry.prepared_content_hash),
    });
    grouped.set(route.identifier, selectors);
  }

  const components = [];
  for (const [identifier, selectors] of grouped) {
    const indexedSelectors = selectors.map((selector, index) => ({
      ...selector,
      assembly_index: index,
    }));
    components.push(await sealComponent({
      schema: COMPONENT_SCHEMA,
      identifier,
      provenance_kind: 'world_info_entries',
      source_selectors: indexedSelectors,
    }));
  }
  components.sort((left, right) => (
    left.identifier.localeCompare(right.identifier)
  ));
  await normalizeHostComponentProvenance(components);
  return components.map(component => structuredClone(component));
}
