const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SENSITIVE_QUERY_KEY =
  /(?:api[-_]?key|secret|token|signature|credential)/i;

class MainRuntimeProfileError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'MainRuntimeProfileError';
    this.reasonCode = reasonCode;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes,
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function fingerprintMainRuntimePreset({
  preset,
  connectionFieldNames = [],
} = {}) {
  if (
    !preset
    || typeof preset !== 'object'
    || Array.isArray(preset)
    || !Array.isArray(connectionFieldNames)
    || connectionFieldNames.some(
      field => typeof field !== 'string' || !field,
    )
  ) {
    throw profileError(
      'runtime_profile_preset_invalid',
      'The active preset cannot be fingerprinted.',
    );
  }
  const excluded = new Set(connectionFieldNames);
  const behavior = Object.fromEntries(
    Object.entries(preset).filter(([key]) => (
      !excluded.has(key)
      && !SENSITIVE_QUERY_KEY.test(key)
      && key !== 'preset_settings_openai'
    )),
  );
  return sha256Hex(canonicalJson({
    schema: 'mnemosyne.main-runtime-preset.v1',
    behavior,
  }));
}

function normalizedUpstreamUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw profileError(
      'runtime_profile_upstream_url_invalid',
      'The selected runtime profile has an invalid upstream URL.',
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
    throw profileError(
      'runtime_profile_upstream_url_invalid',
      'The selected runtime profile has an unsafe upstream URL.',
    );
  }
  return parsed.href.replace(/\/+$/, '');
}

function profileError(reasonCode, message) {
  return new MainRuntimeProfileError(reasonCode, message);
}

function positiveBudget(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

export async function buildMainRuntimeProfile({
  connectionProfile,
  presetFingerprint,
  providerContextTokens,
  providerOutputReserveTokens,
} = {}) {
  const profileId = String(connectionProfile?.id ?? '').trim();
  const credentialLeaseRef = String(
    connectionProfile?.['secret-id'] ?? '',
  ).trim();
  const upstreamModel = String(
    connectionProfile?.model ?? '',
  ).trim();
  const contextTokens = positiveBudget(providerContextTokens);
  const outputReserveTokens =
    positiveBudget(providerOutputReserveTokens);
  if (
    connectionProfile?.api !== 'custom'
    || !profileId
    || !credentialLeaseRef
    || !upstreamModel
  ) {
    throw profileError(
      'runtime_profile_connection_invalid',
      'The selected Custom connection profile is incomplete.',
    );
  }
  if (!HASH_PATTERN.test(presetFingerprint ?? '')) {
    throw profileError(
      'runtime_profile_preset_fingerprint_invalid',
      'The active preset fingerprint is invalid.',
    );
  }
  if (
    contextTokens === null
    || outputReserveTokens === null
    || outputReserveTokens >= contextTokens
  ) {
    throw profileError(
      'runtime_profile_provider_budget_invalid',
      'The selected provider budget is invalid.',
    );
  }
  const payload = Object.freeze({
    schema: 'mnemosyne.main-runtime-profile.v1',
    host_profile_ref_hash: await sha256Hex(profileId),
    credential_lease_ref_hash:
      await sha256Hex(credentialLeaseRef),
    upstream_url: normalizedUpstreamUrl(
      connectionProfile['api-url'],
    ),
    upstream_model: upstreamModel,
    provider_context_tokens: contextTokens,
    provider_output_reserve_tokens: outputReserveTokens,
    preset_fingerprint: presetFingerprint,
  });
  return Object.freeze({
    ...payload,
    profile_hash: await sha256Hex(canonicalJson(payload)),
  });
}

export function createMainRuntimeProfileRouter({
  readActiveProfileHash,
  activateProfile,
  onState = () => {},
} = {}) {
  if (
    typeof readActiveProfileHash !== 'function'
    || typeof activateProfile !== 'function'
    || typeof onState !== 'function'
  ) {
    throw new TypeError(
      'Main runtime profile router dependencies are invalid.',
    );
  }

  let inFlight = null;

  function publish(state) {
    try {
      onState(Object.freeze({ ...state }));
    } catch {
      // Profile state rendering never controls activation.
    }
  }

  function ensure(profile) {
    const desiredHash = profile?.profile_hash;
    if (!HASH_PATTERN.test(desiredHash ?? '')) {
      return Promise.resolve(Object.freeze({
        status: 'blocked',
        active_profile_hash: null,
        reasonCode: 'runtime_profile_invalid',
      }));
    }
    if (inFlight?.profileHash === desiredHash) {
      return inFlight.promise;
    }
    if (inFlight !== null) {
      return Promise.resolve(Object.freeze({
        status: 'blocked',
        active_profile_hash: null,
        reasonCode: 'runtime_profile_switch_busy',
      }));
    }

    const promise = (async () => {
      try {
        let activeHash = null;
        try {
          activeHash = await readActiveProfileHash();
        } catch {
          activeHash = null;
        }
        if (activeHash === desiredHash) {
          const result = Object.freeze({
            status: 'ready',
            active_profile_hash: desiredHash,
            reused: true,
          });
          publish(result);
          return result;
        }
        publish({
          status: 'switching',
          active_profile_hash: activeHash,
          desired_profile_hash: desiredHash,
        });
        let activation;
        try {
          activation = await activateProfile(profile);
        } catch (error) {
          const result = Object.freeze({
            status: 'blocked',
            active_profile_hash: null,
            reasonCode:
              error?.reasonCode
              ?? 'runtime_profile_activation_failed',
          });
          publish(result);
          return result;
        }
        if (
          activation?.status !== 'ready'
          || activation.active_profile_hash !== desiredHash
        ) {
          const result = Object.freeze({
            status: 'blocked',
            active_profile_hash: null,
            reasonCode:
              activation?.reasonCode
              ?? 'runtime_profile_activation_mismatch',
          });
          publish(result);
          return result;
        }
        const result = Object.freeze({
          status: 'ready',
          active_profile_hash: desiredHash,
          reused: false,
        });
        publish(result);
        return result;
      } finally {
        if (inFlight?.promise === promise) {
          inFlight = null;
        }
      }
    })();
    inFlight = Object.freeze({
      profileHash: desiredHash,
      promise,
    });
    return promise;
  }

  return Object.freeze({ ensure });
}
