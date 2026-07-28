#!/bin/zsh
set -eu

bundle_root=${0:A:h}
config_path="$bundle_root/companion.config.json"
example_path="$bundle_root/companion.config.example.json"

if [[ ! -f "$config_path" ]]; then
  cp "$example_path" "$config_path"
  chmod 600 "$config_path"
  open -e "$config_path"
  echo "首次启动：配置文件已建立并在文本编辑器中打开。"
  echo "填写后保存，再次双击这个启动文件。"
  read -r "?按回车键关闭……"
  exit 2
fi

exec "$bundle_root/runtime/node" "$bundle_root/companion-launcher.mjs"
