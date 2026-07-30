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
  || [[ ! -d "$tavern_root/data/default-user" ]]; then
  echo "这不是可识别的 SillyTavern 文件夹：$tavern_root"
  read -r "?按回车键关闭……"
  exit 1
fi

tavern_root=$(cd "$tavern_root" && pwd -P)
extension_parent="$tavern_root/data/default-user/extensions"
extension_path="$extension_parent/tavern-mnemosyne"

if [[ -L "$tavern_root/data" ]] \
  || [[ -L "$tavern_root/data/default-user" ]] \
  || [[ "$(cd "$tavern_root/data/default-user" && pwd -P)" \
    != "$tavern_root/data/default-user" ]]; then
  echo "SillyTavern 用户数据目录经过了符号链接，拒绝在宿主根之外安装。"
  exit 1
fi
mkdir -p "$extension_parent"
if [[ "$(cd "$extension_parent" && pwd -P)" != "$extension_parent" ]]; then
  echo "用户扩展目录经过了符号链接，拒绝在精确代码根之外安装。"
  exit 1
fi
if [[ -L "$extension_path" ]]; then
  echo "Mnemosyne 用户扩展路径是符号链接，拒绝跟随：$extension_path"
  exit 1
fi

install_or_update() {
  local target_path=$1
  if [[ -d "$target_path/.git" ]]; then
    if [[ -L "$target_path/.git" ]]; then
      echo "安装目录的 .git 是符号链接，拒绝更新：$target_path"
      return 1
    fi
    if [[ -n "$(git -C "$target_path" status --porcelain --untracked-files=no)" ]]; then
      echo "安装目录有未提交的源码修改，请先处理：$target_path"
      return 1
    fi
    git -C "$target_path" fetch --tags origin
  elif [[ -e "$target_path" ]]; then
    echo "目标位置已存在但不是 Git 安装：$target_path"
    return 1
  else
    git clone "$repo_url" "$target_path"
  fi

  if [[ "$release_ref" == "__MNEMOSYNE_RELEASE_REF__" ]]; then
    local default_branch
    default_branch=$(
      git -C "$target_path" symbolic-ref \
        --short refs/remotes/origin/HEAD
    )
    default_branch=${default_branch#origin/}
    git -C "$target_path" checkout -B "$default_branch" \
      "origin/$default_branch"
    git -C "$target_path" branch \
      --set-upstream-to="origin/$default_branch" "$default_branch"
  else
    local target_ref="refs/tags/$release_ref"
    if ! git -C "$target_path" rev-parse --verify "$target_ref" >/dev/null; then
      echo "仓库中不存在安装器要求的版本：$release_ref"
      return 1
    fi
    git -C "$target_path" checkout --detach "$target_ref"
  fi
}

if ! install_or_update "$extension_path"; then
  echo "用户扩展更新失败；旧 public 镜像未被迁移。"
  exit 1
fi

migration_module="$extension_path/tavern-mnemosyne/distribution/migrate-code-authority.mjs"
if [[ ! -f "$migration_module" ]] || [[ -L "$migration_module" ]]; then
  echo "发布克隆缺少可信的代码权威迁移模块：$migration_module"
  exit 1
fi
if ! migration_result=$(
  node "$migration_module" --sillytavern-root "$tavern_root"
); then
  echo "无法建立唯一代码权威；旧 public 镜像保持原状。"
  exit 1
fi

echo
echo "Tavern Mnemosyne 用户扩展已安装到唯一代码根。"
if [[ "$migration_result" == *'"status":"migrated"'* ]]; then
  migration_backup=$(
    node -e \
      'process.stdout.write(JSON.parse(process.argv[1]).backup_relative_path)' \
      "$migration_result"
  )
  echo "旧 public 镜像已可恢复地迁移到：$tavern_root/$migration_backup"
fi
echo "请打开 SillyTavern，在 Tavern Mnemosyne 设置中按“启用 Mnemosyne”。"
echo "后续扩展更新统一由 SillyTavern 扩展管理器完成。"
if [[ -t 0 ]]; then
  read -r "?按回车键关闭……"
fi
