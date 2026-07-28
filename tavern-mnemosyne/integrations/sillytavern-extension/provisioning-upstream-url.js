const LOOPBACK_HOSTS =
  new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function effectivePort(url) {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function isLocalRuntimeEndpoint(url, runtimeUrl) {
  try {
    const parsed = new URL(url);
    const runtime = new URL(runtimeUrl);
    return (
      LOOPBACK_HOSTS.has(parsed.hostname)
      && LOOPBACK_HOSTS.has(runtime.hostname)
      && effectivePort(parsed) === effectivePort(runtime)
      && parsed.pathname.replace(/\/+$/, '')
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

export function resolveProvisioningUpstreamUrl({
  currentUrl,
  persistedUrl,
  installedRuntimeUrl = '',
  runtimeUrl = 'http://127.0.0.1:18991/v1',
}) {
  const candidate = String(currentUrl ?? '').trim();
  if (candidate && !isLocalRuntimeEndpoint(candidate, runtimeUrl)) {
    return Object.freeze({
      upstreamUrl: candidate,
      snapshotUrl: candidate === persistedUrl ? null : candidate,
    });
  }

  const snapshot = String(persistedUrl ?? '').trim();
  if (snapshot && !isLocalRuntimeEndpoint(snapshot, runtimeUrl)) {
    return Object.freeze({
      upstreamUrl: snapshot,
      snapshotUrl: null,
    });
  }

  const installed = String(installedRuntimeUrl ?? '').trim();
  if (installed && !isLocalRuntimeEndpoint(installed, runtimeUrl)) {
    return Object.freeze({
      upstreamUrl: installed,
      snapshotUrl: installed,
    });
  }

  throw upstreamUrlError();
}
