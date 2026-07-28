#!/usr/bin/env sh
set -eu

bundle_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_path="$bundle_root/companion.config.json"

if [ ! -f "$config_path" ]; then
  cp "$bundle_root/companion.config.example.json" "$config_path"
  chmod 600 "$config_path"
  echo "Created $config_path. Edit it, then run this launcher again."
  exit 2
fi

exec "$bundle_root/runtime/node" "$bundle_root/companion-launcher.mjs"
