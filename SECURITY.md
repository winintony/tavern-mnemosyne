# Security Policy

## Supported versions

Security fixes are provided for the latest published Tavern Mnemosyne
release. Users should update the Extension, bootstrap, Companion runtime, and
container images together so their release versions and sealed manifests
agree.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use
[GitHub private vulnerability reporting](https://github.com/winintony/tavern-mnemosyne/security/advisories/new)
and include:

- the affected release and deployment profile;
- a minimal reproduction;
- the security impact;
- whether credentials, story data, local files, or network access are
  involved; and
- any suggested mitigation.

You should receive an acknowledgement within three business days. A fix,
coordinated disclosure date, and credit will be arranged according to impact
and reproducibility.

## Security boundaries

Tavern Mnemosyne is designed for a trusted local user or one trusted cloud
data domain. The local Companion and SillyTavern bridge must remain on
loopback or an authenticated same-origin network namespace. Do not expose the
Companion port to a LAN or the Internet.

Provider credentials belong in the configured process environment or
SillyTavern's existing credential store. Never place credentials in the
Extension repository, runtime configuration, logs, issue reports, or
vulnerability reproductions.

The local one-action installer downloads the version-matched runtime Release
asset only after explicit directory authorization. The bootstrap verifies the
archive and every extracted file against the manifest shipped in the
Extension checkout before executing the runtime.
