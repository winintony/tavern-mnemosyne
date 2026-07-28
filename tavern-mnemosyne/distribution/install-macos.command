#!/bin/zsh
set -eu

repo_url="https://github.com/winintony/tavern-mnemosyne.git"
release_ref="__MNEMOSYNE_RELEASE_REF__"

if [[ -n "${SILLYTAVERN_HOME:-}" ]]; then
  tavern_root="$SILLYTAVERN_HOME"
else
  echo "请输入 SillyTavern 文件夹的完整路径，然后按回车："
  read -r tavern_root
fi

tavern_root=${tavern_root/#\~/$HOME}
if [[ ! -f "$tavern_root/server.js" ]] \
  || [[ ! -d "$tavern_root/public/scripts/extensions" ]]; then
  echo "这不是可识别的 SillyTavern 文件夹：$tavern_root"
  read -r "?按回车键关闭……"
  exit 1
fi

extension_path="$tavern_root/public/scripts/extensions/third-party/tavern-mnemosyne"
plugin_path="$tavern_root/plugins/tavern-mnemosyne"

install_or_update() {
  local target_path=$1
  if [[ -d "$target_path/.git" ]]; then
    if [[ -n "$(git -C "$target_path" status --porcelain --untracked-files=no)" ]]; then
      echo "安装目录有未提交的源码修改，请先处理：$target_path"
      exit 1
    fi
    git -C "$target_path" fetch --tags origin
  elif [[ -e "$target_path" ]]; then
    echo "目标位置已存在但不是 Git 安装：$target_path"
    exit 1
  else
    git clone "$repo_url" "$target_path"
  fi

  local default_branch
  default_branch=$(
    git -C "$target_path" symbolic-ref \
      --short refs/remotes/origin/HEAD
  )
  default_branch=${default_branch#origin/}
  local target_ref
  if [[ "$release_ref" == "__MNEMOSYNE_RELEASE_REF__" ]]; then
    target_ref="origin/$default_branch"
  else
    target_ref="refs/tags/$release_ref"
    if ! git -C "$target_path" rev-parse --verify "$target_ref" >/dev/null; then
      echo "仓库中不存在安装器要求的版本：$release_ref"
      exit 1
    fi
  fi
  git -C "$target_path" checkout -B "$default_branch" "$target_ref"
  git -C "$target_path" branch \
    --set-upstream-to="origin/$default_branch" "$default_branch"
}

mkdir -p "${extension_path:h}" "${plugin_path:h}"
install_or_update "$extension_path"
install_or_update "$plugin_path"

if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 npm。此高级安装器需要使用 SillyTavern 自带 Node 对应的 npm。"
  exit 1
fi
echo "正在安装已锁定的 Companion 运行依赖……"
(
  cd "$plugin_path/tavern-mnemosyne"
  npm ci --omit=dev --no-audit --no-fund
)

config_path="$tavern_root/config.yaml"
if [[ -f "$config_path" ]] \
  && grep -q '^enableServerPlugins: false$' "$config_path"; then
  cp "$config_path" "$config_path.mnemosyne-backup"
  sed -i '' 's/^enableServerPlugins: false$/enableServerPlugins: true/' \
    "$config_path"
fi

companion_config="$plugin_path/tavern-mnemosyne/distribution/companion.config.json"
if [[ ! -f "$companion_config" ]]; then
  cp "$plugin_path/tavern-mnemosyne/distribution/companion.config.example.json" \
    "$companion_config"
  chmod 600 "$companion_config"
  open -e "$companion_config"
fi

echo
echo "Tavern Mnemosyne 已安装。"
echo "请保存打开的 Companion 配置，然后重启 SillyTavern。"
echo "以后扩展和服务端插件都从同一个 GitHub 仓库更新。"
read -r "?按回车键关闭……"
