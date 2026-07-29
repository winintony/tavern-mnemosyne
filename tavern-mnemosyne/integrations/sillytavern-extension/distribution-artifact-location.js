class DistributionArtifactLocationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DistributionArtifactLocationError';
    this.reasonCode = 'browser_folder_artifact_unavailable';
    this.details = Object.freeze({ ...details });
  }
}

function artifactLocationError(message, details = {}) {
  return new DistributionArtifactLocationError(message, details);
}

function normalizedArtifactPath(value) {
  const path = String(value ?? '').replaceAll('\\', '/');
  const segments = path.split('/');
  if (
    !path
    || path.startsWith('/')
    || segments.some(segment => (
      !segment || segment === '.' || segment === '..'
    ))
  ) {
    throw artifactLocationError(
      'The distribution artifact path is invalid.',
    );
  }
  return path;
}

export function distributionArtifactUrls(
  relativePath,
  moduleUrl = import.meta.url,
) {
  const path = normalizedArtifactPath(relativePath);
  return Object.freeze([
    new URL(`../../distribution/${path}`, moduleUrl),
    new URL(
      `./tavern-mnemosyne/distribution/${path}`,
      moduleUrl,
    ),
  ]);
}

export async function fetchDistributionArtifact(
  relativePath,
  {
    fetchImpl = globalThis.fetch,
    moduleUrl = import.meta.url,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw artifactLocationError(
      'The browser cannot load distribution artifacts.',
    );
  }
  const attempts = [];
  for (const url of distributionArtifactUrls(
    relativePath,
    moduleUrl,
  )) {
    try {
      const response = await fetchImpl(url, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response?.ok) return response;
      attempts.push(Object.freeze({
        status: response?.status ?? null,
        url: url.href,
      }));
    } catch (error) {
      attempts.push(Object.freeze({
        error: error?.name ?? 'unknown',
        url: url.href,
      }));
    }
  }
  throw artifactLocationError(
    'The sealed distribution artifact is unavailable.',
    { attempts },
  );
}
