# Tavern Mnemosyne

Local-first, governed story memory for SillyTavern.

Tavern Mnemosyne has two cooperating parts:

1. the **SillyTavern extension** in this repository root; and
2. the **Companion**, a loopback-only service that owns durable memory,
   validates requests, and forwards them to the configured OpenAI-compatible
   upstream.

The extension alone does not provide the memory service. The supported setup
paths install or preinstall the matching loopback runtime. For the local
one-action path, the SillyTavern server bootstrap downloads the exact
version-matched runtime Release asset after directory authorization; the
browser never downloads or executes a separate program.

## Recommended: local Chromium one-action setup

In SillyTavern, open **Extensions → Install extension** and paste:

```text
https://github.com/winintony/tavern-mnemosyne
```

On a local SillyTavern page opened in Chrome or Edge:

1. select the Custom OpenAI-compatible connection, model, context window, and
   output reserve you intend to use;
2. open Tavern Mnemosyne settings and press **启用 Mnemosyne**;
3. in the browser's native dialog, select the SillyTavern root and allow
   changes; then restart SillyTavern once.

That single extension action writes a minimal server bootstrap, non-secret
runtime configuration, a `config.yaml` backup, and an audit receipt. On the
next restart, the bootstrap downloads the version-matched runtime asset from
this repository's GitHub Release, verifies the archive and every extracted
file against the manifest already present in the Extension checkout, and only
then loads the Companion. There is no terminal command, package installation,
manual archive extraction, executable launch, or operating-system security
bypass.

This path requires Chromium's File System Access API, the standard
SillyTavern `config.yaml` location and `data/default-user` single-user
extension layout, and SillyTavern running on Node.js 22 or newer with a
WAL-safe embedded SQLite. The first restart also requires access to the
corresponding GitHub Release asset.

## Recommended: preinstalled cloud deployment

Release assets include two M-P1 profiles:

- one supervised SillyTavern + Mnemosyne application image;
- a reference manifest for separate SillyTavern and runtime containers sharing
  one Kubernetes Pod network namespace. Treat it as unsupported until it has
  passed the required real-cluster acceptance in the target environment.

In both profiles, the browser uses an authenticated same-origin SillyTavern
bridge and SillyTavern's Node backend sends generation to an automatically
assigned loopback port. The actual address is discovered through the same-origin
bridge, so local port conflicts do not require user action and the runtime is
never public. See the cloud deployment README included in the Release.

The cloud profile is one trusted data domain. It does not isolate mutually
untrusted SillyTavern accounts and must not be exposed as a public multi-tenant
service.

## Advanced fallback packages

The per-platform standalone Companion archives and macOS installer remain
advanced recovery/legacy paths. They are not the recommended local setup.
They carry the same release version and keep the Companion on `127.0.0.1`;
standalone operators may choose the port with `MNEMOSYNE_PORT`. Never expose
the runtime to a LAN or the Internet.

Firefox, Safari, an existing remote/NAS SillyTavern without a preinstalled
bridge, Termux, and TauriTavern are not covered by the two supported profiles.

## User controls

The release UI exposes:

- an on/off switch for local questionnaires and real-use feedback, defaulting
  to off;
- a user-visible per-run memory activity view showing which state layers were
  read, saved, or updated;
- a Companion health check.

Development-only prompt probes and experimental switches are not part of the
release UI.

## Privacy

Memory and feedback records stay in the configured local data directory.
Real-use feedback is off by default. The current release does not automatically
upload questionnaires, story text, provider credentials, or memory records.
Initial local activation makes one GitHub Release download for the sealed
runtime asset; GitHub receives the ordinary network metadata associated with
that download, but no Tavern Mnemosyne story or credential data.

## Updates

- Local BrowserFolder installations use SillyTavern's extension updater; press
  **启用 Mnemosyne** again only when the UI reports that the sealed runtime
  needs rebinding.
- Cloud deployments update the two published images by semantic version and
  digest.
- Advanced standalone packages must carry the same semantic version as the
  extension.
- Maintainers create a `vX.Y.Z` tag only after tests pass. The release workflow
  rebuilds the self-contained runtime, Companion archives, cloud assets, and
  container images from that tag.

## License

See [LICENSE](LICENSE): installing and using Tavern Mnemosyne with SillyTavern
is free; redistribution, commercial offerings, and derivative works require
written permission. The source is published for transparency and review.

Security issues should be reported privately according to
[SECURITY.md](SECURITY.md).
