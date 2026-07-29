import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SENSITIVE_QUERY_KEY =
  /(?:api[-_]?key|secret|token|signature|credential)/i;
const PROFILE_KEYS = Object.freeze([
  'credential_lease_ref_hash',
  'host_profile_ref_hash',
  'preset_fingerprint',
  'profile_hash',
  'provider_context_tokens',
  'provider_output_reserve_tokens',
  'schema',
  'upstream_model',
  'upstream_url',
]);

class MainRuntimeProfileContractError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'MainRuntimeProfileContractError';
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new MainRuntimeProfileContractError(
    reasonCode,
    message,
  );
}

function normalizedUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    fail(
      'runtime_profile_upstream_url_invalid',
      'The main runtime profile upstream URL is invalid.',
    );
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash
    || [...parsed.searchParams.keys()].some(
      key => SENSITIVE_QUERY_KEY.test(key),
    )
  ) {
    fail(
      'runtime_profile_upstream_url_invalid',
      'The main runtime profile upstream URL is unsafe.',
    );
  }
  return parsed.href.replace(/\/+$/, '');
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function normalizeMainRuntimeProfile(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(PROFILE_KEYS)
    || value.schema !== 'mnemosyne.main-runtime-profile.v1'
  ) {
    fail(
      'runtime_profile_shape_invalid',
      'The main runtime profile shape is invalid.',
    );
  }
  const normalized = {
    schema: value.schema,
    host_profile_ref_hash: value.host_profile_ref_hash,
    credential_lease_ref_hash:
      value.credential_lease_ref_hash,
    upstream_url: normalizedUrl(value.upstream_url),
    upstream_model: String(value.upstream_model ?? '').trim(),
    provider_context_tokens: value.provider_context_tokens,
    provider_output_reserve_tokens:
      value.provider_output_reserve_tokens,
    preset_fingerprint: value.preset_fingerprint,
  };
  if (
    !HASH_PATTERN.test(normalized.host_profile_ref_hash ?? '')
    || !HASH_PATTERN.test(
      normalized.credential_lease_ref_hash ?? '',
    )
    || !normalized.upstream_model
    || !positiveInteger(normalized.provider_context_tokens)
    || !positiveInteger(
      normalized.provider_output_reserve_tokens,
    )
    || normalized.provider_output_reserve_tokens
      >= normalized.provider_context_tokens
    || !HASH_PATTERN.test(normalized.preset_fingerprint ?? '')
  ) {
    fail(
      'runtime_profile_shape_invalid',
      'The main runtime profile members are invalid.',
    );
  }
  const expectedHash = sha256(canonicalJson(normalized));
  if (value.profile_hash !== expectedHash) {
    fail(
      'runtime_profile_hash_mismatch',
      'The main runtime profile hash does not match its members.',
    );
  }
  return Object.freeze({
    ...normalized,
    profile_hash: expectedHash,
  });
}

export function createRuntimeConfigurationForProfile(value) {
  const profile = normalizeMainRuntimeProfile(value);
  return Object.freeze({
    schema: 'mnemosyne.runtime-config.v2',
    host: '127.0.0.1',
    port: 0,
    upstreamBaseUrl: profile.upstream_url,
    upstreamModel: profile.upstream_model,
    upstreamAuthMode: 'passthrough',
    providerContextTokens: profile.provider_context_tokens,
    providerOutputReserveTokens:
      profile.provider_output_reserve_tokens,
    contextMode: 'production',
    mainRuntimeProfileHash: profile.profile_hash,
    mainRuntimeProfile: profile,
  });
}

export function runtimeProfileFromConfiguration(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    fail(
      'runtime_profile_configuration_invalid',
      'The runtime configuration is invalid.',
    );
  }
  const profile = normalizeMainRuntimeProfile(
    value.mainRuntimeProfile,
  );
  const expected = createRuntimeConfigurationForProfile(profile);
  for (const key of Object.keys(expected)) {
    if (
      key !== 'mainRuntimeProfile'
      && value[key] !== expected[key]
    ) {
      fail(
        'runtime_profile_configuration_mismatch',
        'The runtime configuration drifted from its sealed profile.',
      );
    }
  }
  return profile;
}
