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

export function captureUpstreamConnectionProfile({
  connectionManager,
  currentUrl,
  runtimeUrl,
}) {
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
    return null;
  }
  return Object.freeze({
    profileId: profile.id,
    upstreamUrl: profileUrl,
  });
}

export function restoreUpstreamConnectionProfile({
  connectionManager,
  snapshot,
  runtimeUrl,
}) {
  if (
    !snapshot
    || typeof snapshot.profileId !== 'string'
    || typeof snapshot.upstreamUrl !== 'string'
    || !Array.isArray(connectionManager?.profiles)
  ) {
    return false;
  }
  const profile = connectionManager.profiles.find(
    candidate => candidate?.id === snapshot.profileId,
  );
  const upstreamUrl = normalizedHttpUrl(snapshot.upstreamUrl);
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
  return true;
}
