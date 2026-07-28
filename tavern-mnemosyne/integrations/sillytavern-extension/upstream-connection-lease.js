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

  function captureSelectedProfile(currentUrl, runtimeUrl) {
    const connectionManager = readConnectionManager();
    const profile = selectedProfile(connectionManager);
    const liveUrl = normalizedHttpUrl(currentUrl);
    const profileUrl = normalizedHttpUrl(profile?.['api-url']);
    const normalizedRuntimeUrl = normalizedHttpUrl(runtimeUrl);
    if (
      !profile
      || profile.api !== 'custom'
      || !liveUrl
      || profileUrl !== liveUrl
      || profileUrl === normalizedRuntimeUrl
    ) {
      return false;
    }
    const settings = readSettings();
    settings.upstreamCustomUrl = profileUrl;
    settings.upstreamConnectionProfileId = profile.id;
    settings.upstreamConnectionProfileUrl = profileUrl;
    save();
    return true;
  }

  function resolveForProvisioning({
    currentUrl,
    installedRuntimeUrl = '',
    runtimeUrl,
  }) {
    captureSelectedProfile(currentUrl, runtimeUrl);
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
      return normalized;
    }
    throw upstreamUrlError();
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

  function bindHostRequest(payload) {
    const settings = readSettings();
    const connectionManager = readConnectionManager();
    const profile = connectionManager?.profiles?.find(
      candidate =>
        candidate?.id === settings.upstreamConnectionProfileId,
    );
    const secretId = profile?.['secret-id'];
    if (typeof secretId !== 'string' || !secretId) {
      return { ...payload };
    }
    return { ...payload, secret_id: secretId };
  }

  return Object.freeze({
    resolveForProvisioning,
    restoreSelectedProfile,
    bindHostRequest,
  });
}
