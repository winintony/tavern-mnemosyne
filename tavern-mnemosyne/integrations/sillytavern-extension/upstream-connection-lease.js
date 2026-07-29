const LOOPBACK_HOSTS =
  new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizedHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    return null;
  }
  return parsed.href.replace(/\/+$/, '');
}

function selectedProfile(connectionManager) {
  if (
    !connectionManager
    || !Array.isArray(connectionManager.profiles)
  ) {
    return null;
  }
  return connectionManager.profiles.find(
    profile => profile?.id === connectionManager.selectedProfile,
  ) ?? null;
}

function effectivePort(url) {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function isRuntimeEndpoint(value, runtimeValue) {
  try {
    const url = new URL(value);
    const runtime = new URL(runtimeValue);
    return (
      LOOPBACK_HOSTS.has(url.hostname)
      && LOOPBACK_HOSTS.has(runtime.hostname)
      && effectivePort(url) === effectivePort(runtime)
      && url.pathname.replace(/\/+$/, '')
        === runtime.pathname.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

function upstreamUrlError() {
  const error = new Error(
    '当前连接指向本机运行时，且没有记录过真实的上游服务地址。',
  );
  error.reasonCode = 'browser_folder_upstream_url_invalid';
  return error;
}

class UpstreamConnectionLeaseError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'UpstreamConnectionLeaseError';
    this.reasonCode = reasonCode;
  }
}

function normalizedModel(value) {
  const model = String(value ?? '').trim();
  return model || null;
}

function canonicalJson(value) {
  function canonicalize(candidate) {
    if (Array.isArray(candidate)) {
      return candidate.map(canonicalize);
    }
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map(key => [key, canonicalize(candidate[key])]),
      );
    }
    return candidate;
  }
  return JSON.stringify(canonicalize(value));
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

export function createUpstreamConnectionLease({
  readSettings,
  readConnectionManager,
  save,
}) {
  if (
    typeof readSettings !== 'function'
    || typeof readConnectionManager !== 'function'
    || typeof save !== 'function'
  ) {
    throw new TypeError(
      'Upstream connection lease dependencies are invalid.',
    );
  }

  function persistProfileLease(profile, profileUrl) {
    const settings = readSettings();
    settings.upstreamCustomUrl = profileUrl;
    settings.upstreamConnectionProfileId = profile.id;
    settings.upstreamConnectionProfileUrl = profileUrl;
    save();
  }

  function captureSelectedProfile(
    currentUrl,
    runtimeUrl,
    currentModel = null,
  ) {
    const connectionManager = readConnectionManager();
    const profile = selectedProfile(connectionManager);
    const liveUrl = normalizedHttpUrl(currentUrl);
    const profileUrl = normalizedHttpUrl(profile?.['api-url']);
    const normalizedRuntimeUrl = normalizedHttpUrl(runtimeUrl);
    const expectedModel = normalizedModel(currentModel);
    if (
      !profile
      || profile.api !== 'custom'
      || !liveUrl
      || profileUrl !== liveUrl
      || profileUrl === normalizedRuntimeUrl
      || (
        expectedModel
        && normalizedModel(profile.model) !== expectedModel
      )
    ) {
      return false;
    }
    persistProfileLease(profile, profileUrl);
    return true;
  }

  function recoverUniqueProfileLease(upstreamUrl, upstreamModel) {
    const settings = readSettings();
    if (String(settings.upstreamConnectionProfileId ?? '').trim()) {
      return 'existing';
    }
    const normalizedUpstreamUrl = normalizedHttpUrl(upstreamUrl);
    const normalizedUpstreamModel = normalizedModel(upstreamModel);
    if (!normalizedUpstreamUrl || !normalizedUpstreamModel) {
      return 'none';
    }
    const connectionManager = readConnectionManager();
    const matches = Array.isArray(connectionManager?.profiles)
      ? connectionManager.profiles.filter(profile => (
        profile?.api === 'custom'
        && normalizedHttpUrl(profile?.['api-url'])
          === normalizedUpstreamUrl
        && normalizedModel(profile?.model) === normalizedUpstreamModel
      ))
      : [];
    if (matches.length > 1) {
      throw new UpstreamConnectionLeaseError(
        'upstream_connection_profile_lease_ambiguous',
        'Multiple Custom connection profiles match the sealed upstream binding.',
      );
    }
    if (matches.length === 0) return 'none';
    persistProfileLease(matches[0], normalizedUpstreamUrl);
    return 'recovered';
  }

  function recoverContaminatedSelectedProfile({
    runtimeUrl,
    upstreamModel,
    upstreamUrl,
  }) {
    if (
      String(
        readSettings().upstreamConnectionProfileId ?? '',
      ).trim()
    ) {
      return false;
    }
    const connectionManager = readConnectionManager();
    const profile = selectedProfile(connectionManager);
    const normalizedUpstreamUrl = normalizedHttpUrl(upstreamUrl);
    const normalizedUpstreamModel = normalizedModel(upstreamModel);
    if (
      !profile
      || profile.api !== 'custom'
      || !normalizedUpstreamUrl
      || !isRuntimeEndpoint(profile['api-url'], runtimeUrl)
      || (
        normalizedUpstreamModel
        && normalizedModel(profile.model) !== normalizedUpstreamModel
      )
    ) {
      return false;
    }
    profile['api-url'] = normalizedUpstreamUrl;
    persistProfileLease(profile, normalizedUpstreamUrl);
    return true;
  }

  function resolveForProvisioning({
    currentUrl,
    currentModel = null,
    installedRuntimeUrl = '',
    installedRuntimeModel = null,
    runtimeUrl,
  }) {
    captureSelectedProfile(
      currentUrl,
      runtimeUrl,
      currentModel,
    );
    const settings = readSettings();
    const candidates = [
      currentUrl,
      settings.upstreamCustomUrl,
      installedRuntimeUrl,
    ];
    for (const candidate of candidates) {
      const normalized = normalizedHttpUrl(candidate);
      if (!normalized || isRuntimeEndpoint(normalized, runtimeUrl)) {
        continue;
      }
      if (settings.upstreamCustomUrl !== normalized) {
        settings.upstreamCustomUrl = normalized;
        save();
      }
      const recoveryModel = installedRuntimeModel ?? currentModel;
      const recovery = recoverContaminatedSelectedProfile({
        runtimeUrl,
        upstreamModel: recoveryModel,
        upstreamUrl: normalized,
      })
        ? 'recovered'
        : recoverUniqueProfileLease(
          normalized,
          recoveryModel,
        );
      if (
        recovery === 'none'
        && isRuntimeEndpoint(currentUrl, runtimeUrl)
        && selectedProfile(readConnectionManager())
      ) {
        throw new UpstreamConnectionLeaseError(
          'upstream_connection_profile_lease_missing',
          'The selected Custom connection does not match the sealed upstream binding.',
        );
      }
      return normalized;
    }
    throw upstreamUrlError();
  }

  function resolveExplicitProvisioningBinding({
    currentUrl,
    currentModel = null,
    installedRuntimeUrl = '',
    installedRuntimeModel = null,
    runtimeUrl,
  }) {
    const settings = readSettings();
    const connectionManager = readConnectionManager();
    const profile = selectedProfile(connectionManager);
    if (profile) {
      let upstreamUrl = normalizedHttpUrl(profile['api-url']);
      const upstreamModel = normalizedModel(profile.model);
      if (
        profile.api !== 'custom'
        || !upstreamModel
        || typeof profile['secret-id'] !== 'string'
        || !profile['secret-id']
      ) {
        throw new UpstreamConnectionLeaseError(
          'upstream_connection_profile_lease_invalid',
          'The explicitly selected upstream profile is incomplete.',
        );
      }
      if (isRuntimeEndpoint(upstreamUrl, runtimeUrl)) {
        const persistedProfileUrl = (
          settings.upstreamConnectionProfileId === profile.id
            ? normalizedHttpUrl(
              settings.upstreamConnectionProfileUrl,
            )
            : null
        );
        if (
          !persistedProfileUrl
          || isRuntimeEndpoint(persistedProfileUrl, runtimeUrl)
        ) {
          throw new UpstreamConnectionLeaseError(
            'upstream_connection_profile_lease_invalid',
            'The selected upstream profile only exposes the running local runtime.',
          );
        }
        upstreamUrl = persistedProfileUrl;
      }
      if (!upstreamUrl) {
        throw upstreamUrlError();
      }
      persistProfileLease(profile, upstreamUrl);
      return Object.freeze({
        upstreamModel,
        upstreamUrl,
      });
    }

    const upstreamUrl = resolveForProvisioning({
      currentUrl,
      currentModel,
      installedRuntimeUrl,
      installedRuntimeModel,
      runtimeUrl,
    });
    const upstreamModel = normalizedModel(
      installedRuntimeModel ?? currentModel,
    );
    if (!upstreamModel) {
      throw new UpstreamConnectionLeaseError(
        'browser_folder_upstream_model_missing',
        'The upstream model is missing.',
      );
    }
    return Object.freeze({
      upstreamModel,
      upstreamUrl,
    });
  }

  function restoreSelectedProfile(runtimeUrl) {
    const settings = readSettings();
    const connectionManager = readConnectionManager();
    if (!Array.isArray(connectionManager?.profiles)) return false;
    const profile = connectionManager.profiles.find(
      candidate =>
        candidate?.id === settings.upstreamConnectionProfileId,
    );
    const upstreamUrl = normalizedHttpUrl(
      settings.upstreamConnectionProfileUrl,
    );
    const profileUrl = normalizedHttpUrl(profile?.['api-url']);
    const normalizedRuntimeUrl = normalizedHttpUrl(runtimeUrl);
    if (
      !profile
      || profile.api !== 'custom'
      || !upstreamUrl
      || !normalizedRuntimeUrl
      || profileUrl !== normalizedRuntimeUrl
    ) {
      return false;
    }
    profile['api-url'] = upstreamUrl;
    save();
    return true;
  }

  function resolveLeasedBinding(requestModel) {
    const settings = readSettings();
    const connectionManager = readConnectionManager();
    const profileId = String(
      settings.upstreamConnectionProfileId ?? '',
    ).trim();
    if (!profileId) {
      if (!selectedProfile(connectionManager)) {
        return Object.freeze({
          manual: true,
          model: normalizedModel(requestModel),
          secretId: null,
          upstreamUrl: normalizedHttpUrl(
            settings.upstreamCustomUrl,
          ),
        });
      }
      throw new UpstreamConnectionLeaseError(
        'upstream_connection_profile_lease_missing',
        'The upstream connection profile lease is missing.',
      );
    }
    const profile = connectionManager?.profiles?.find(
      candidate => candidate?.id === profileId,
    );
    const leasedUrl = normalizedHttpUrl(
      settings.upstreamConnectionProfileUrl,
    );
    const profileUrl = normalizedHttpUrl(profile?.['api-url']);
    const secretId = profile?.['secret-id'];
    const expectedModel = normalizedModel(requestModel);
    if (
      !profile
      || profile.api !== 'custom'
      || !leasedUrl
      || profileUrl !== leasedUrl
      || (
        expectedModel
        && normalizedModel(profile.model) !== expectedModel
      )
      || typeof secretId !== 'string'
      || !secretId
    ) {
      throw new UpstreamConnectionLeaseError(
        'upstream_connection_profile_lease_invalid',
        'The upstream connection profile lease no longer resolves exactly.',
      );
    }
    return Object.freeze({
      manual: false,
      model: normalizedModel(profile.model),
      secretId,
      upstreamUrl: leasedUrl,
    });
  }

  function bindHostRequest(payload) {
    const binding = resolveLeasedBinding(payload?.model);
    if (binding.manual) return { ...payload };
    return { ...payload, secret_id: binding.secretId };
  }

  async function assertRuntimeBinding({
    expectedProviderContextTokens,
    expectedProviderOutputReserveTokens,
    requireSelectedProfile = false,
    runtimeCapabilities,
    runtimeLease,
  }) {
    if (requireSelectedProfile) {
      const settings = readSettings();
      const connectionManager = readConnectionManager();
      const activeProfile = selectedProfile(connectionManager);
      const leasedProfileId = String(
        settings.upstreamConnectionProfileId ?? '',
      ).trim();
      if ((activeProfile?.id ?? '') !== leasedProfileId) {
        throw new UpstreamConnectionLeaseError(
          'upstream_connection_profile_reprovision_required',
          'The explicitly selected upstream profile is not the running sealed binding.',
        );
      }
    }
    const runtimeModel = normalizedModel(
      runtimeCapabilities?.main_host_binding?.model,
    );
    const providerBudgetPolicyHash =
      runtimeCapabilities?.provider_budget_policy?.policy_hash;
    const protocolVersion = String(
      runtimeLease?.protocol_version ?? '',
    ).trim();
    const generationBindingHash =
      runtimeLease?.generation_binding_hash;
    if (
      !runtimeModel
      || !protocolVersion
      || !/^[a-f0-9]{64}$/.test(
        providerBudgetPolicyHash ?? '',
      )
      || !/^[a-f0-9]{64}$/.test(
        generationBindingHash ?? '',
      )
    ) {
      throw new UpstreamConnectionLeaseError(
        'upstream_connection_profile_lease_invalid',
        'The runtime cannot prove its sealed upstream binding.',
      );
    }
    const binding = resolveLeasedBinding(runtimeModel);
    if (!binding.upstreamUrl) {
      throw new UpstreamConnectionLeaseError(
        'upstream_connection_profile_lease_invalid',
        'The upstream connection URL lease is missing.',
      );
    }
    const expectedHash = await sha256Hex(canonicalJson({
      schema: 'mnemosyne.generation-endpoint-binding.v1',
      protocol_version: protocolVersion,
      upstream_endpoint_hash: await sha256Hex(
        binding.upstreamUrl,
      ),
      upstream_model: runtimeModel,
      upstream_auth_mode: 'passthrough',
      provider_budget_policy_hash: providerBudgetPolicyHash,
    }));
    if (expectedHash !== generationBindingHash) {
      throw new UpstreamConnectionLeaseError(
        'upstream_connection_profile_lease_invalid',
        'The browser lease does not match the running upstream binding.',
      );
    }
    const checksProviderBudget = (
      expectedProviderContextTokens !== undefined
      || expectedProviderOutputReserveTokens !== undefined
    );
    if (checksProviderBudget) {
      const expectedContext = Number(
        expectedProviderContextTokens,
      );
      const expectedOutputReserve = Number(
        expectedProviderOutputReserveTokens,
      );
      const runtimeContext = Number(
        runtimeCapabilities?.provider_budget_policy
          ?.configured_context_tokens,
      );
      const runtimeOutputReserve = Number(
        runtimeCapabilities?.provider_budget_policy
          ?.output_reserve_tokens,
      );
      if (
        !Number.isSafeInteger(expectedContext)
        || expectedContext <= 0
        || !Number.isSafeInteger(expectedOutputReserve)
        || expectedOutputReserve <= 0
        || expectedOutputReserve >= expectedContext
        || !Number.isSafeInteger(runtimeContext)
        || !Number.isSafeInteger(runtimeOutputReserve)
        || runtimeContext !== expectedContext
        || runtimeOutputReserve !== expectedOutputReserve
      ) {
        throw new UpstreamConnectionLeaseError(
          'runtime_provider_budget_binding_mismatch',
          'The running provider budget does not match the current host settings.',
        );
      }
    }
    return true;
  }

  return Object.freeze({
    captureSelectedProfile,
    resolveForProvisioning,
    resolveExplicitProvisioningBinding,
    restoreSelectedProfile,
    bindHostRequest,
    assertRuntimeBinding,
  });
}
