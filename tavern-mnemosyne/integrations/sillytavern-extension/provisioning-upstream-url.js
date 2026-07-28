function isLoopbackEndpoint(url) {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
      new URL(url).hostname,
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
}) {
  const candidate = String(currentUrl ?? '').trim();
  if (candidate && !isLoopbackEndpoint(candidate)) {
    return Object.freeze({
      upstreamUrl: candidate,
      snapshotUrl: candidate === persistedUrl ? null : candidate,
    });
  }

  const snapshot = String(persistedUrl ?? '').trim();
  if (snapshot && !isLoopbackEndpoint(snapshot)) {
    return Object.freeze({
      upstreamUrl: snapshot,
      snapshotUrl: null,
    });
  }

  const installed = String(installedRuntimeUrl ?? '').trim();
  if (installed && !isLoopbackEndpoint(installed)) {
    return Object.freeze({
      upstreamUrl: installed,
      snapshotUrl: installed,
    });
  }

  throw upstreamUrlError();
}
