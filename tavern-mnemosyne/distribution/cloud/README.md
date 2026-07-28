# Cloud deployment profiles

These profiles implement M-P1 for one trusted SillyTavern instance. They do
not provide confidentiality between mutually untrusted SillyTavern accounts.
Never publish port `18991`.

## Single-container derived image

`single-container/compose.yaml` runs the published SillyTavern + Mnemosyne
image behind an Nginx request gate and Caddy HTTPS termination. The gate
enforces a 72 MiB pre-parse body limit and a per-client request rate; only
Caddy publishes ports.

Provide:

- `MNEMOSYNE_PUBLIC_HOST`
- `MNEMOSYNE_UPSTREAM_BASE_URL`
- `MNEMOSYNE_UPSTREAM_MODEL`
- `MNEMOSYNE_PROVIDER_CONTEXT_TOKENS`
- `MNEMOSYNE_PROVIDER_OUTPUT_RESERVE_TOKENS`
- `MNEMOSYNE_CONTEXT_TOKEN_FILE`: a mode-0600 file containing at least 32
  random bytes encoded as base64url
- `ST_BASIC_AUTH_USERNAME_FILE` and `ST_BASIC_AUTH_PASSWORD_FILE`: mode-0600
  files containing the SillyTavern Basic Auth credentials
- optionally `MNEMOSYNE_VERSION`; it defaults to `0.2.0`

Then run `docker compose up -d` from `single-container/`. Pin the two published
images by digest in controlled deployments. Caddy obtains and renews the
certificate for `MNEMOSYNE_PUBLIC_HOST`; DNS and inbound ports 80/443 must
already reach the host.

The app container starts the runtime first, waits for its real `/health`
response, then starts SillyTavern. Either child exiting terminates the
supervisor. The Compose healthcheck validates both processes, not only the
SillyTavern heartbeat.

The `0.2.0` image pins SillyTavern `1.18.0` by digest and applies a narrowly
scoped browser-startup compatibility correction during the image build. The
build verifies the SHA-256 of every affected upstream file before changing it
and fails closed if the pinned source differs. Remove or re-audit that
correction when the SillyTavern base version changes.

## Shared network namespace

`shared-network-namespace/kubernetes.yaml` is the reference one-Pod profile.
Replace `story.example.com`, the Ingress class/TLS details, upstream binding,
storage classes, and the `tavern-mnemosyne` Secret references before applying
it. The SillyTavern container deliberately uses the published Mnemosyne cloud
image with its entrypoint overridden to the normal SillyTavern entrypoint, so
the same pinned compatibility correction is present in both M-P1 profiles.
Pin both cloud and runtime images by digest in controlled deployments.

The runtime binds only `127.0.0.1:18991` in the Pod network namespace.
SillyTavern is the only application port exposed by the Service. Both
containers use the same combined liveness/readiness probe, so either side
becoming unavailable makes the Pod fail closed and triggers recovery.

## Required acceptance

Before treating a deployment as supported, verify:

1. HTTPS and authentication reject unauthenticated requests.
2. the host and private-address whitelists are enabled;
3. `enableServerPluginsAutoUpdate` is false;
4. the body-size and request-rate gates are active;
5. capabilities returns a negotiated protocol, compatible registry, storage
   ready, and a non-empty runtime instance id;
6. restarting the runtime invalidates an in-flight root-run lease; and
7. one real remote-browser root run completes without any browser request to
   `127.0.0.1`.
