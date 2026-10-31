#!/bin/bash
# Research Workbench installer for macOS: the starter. Paste into Terminal:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/zyaoceng/organism/claude/vibrant-thompson-s3npyj/research-workbench/scripts/mac/install.sh)"
#
# and append ` -- --doctor`, ` -- --dry-run`, ` -- --uninstall`, ` -- --port 4320` … for options.
# Re-running the same line is the update.
#
# It downloads the official Node.js tarball for this Mac into ~/ResearchWorkbench/runtime, checks it
# against the SHA-256 written below, and runs scripts/mac/install.mjs of the tested commit named in
# release.json with that Node, passing every argument through. Written for the bash 3.2 and BSD tools
# that ship with macOS; the whole body is inside main() so a partially downloaded script never runs.
#
# Linux x64 works for CI and dry runs only. Environment: WB_SOURCE_DIR (run the installer of, and
# install from, a local checkout), WB_RELEASE_COMMIT (skip release.json), WB_NODE (use this Node; tests).

main() {
  set -eu
  set -o pipefail

  REPO="zyaoceng/organism"
  BRANCH="claude/vibrant-thompson-s3npyj"
  SUBDIR="research-workbench"
  RAW="https://raw.githubusercontent.com/$REPO"
  # install.mjs imports these (a unit test keeps the list in sync with scripts/mac/lib)
  LIB_FILES="args.mjs health.mjs launchd.mjs launcher.mjs layout.mjs obsidian.mjs prune.mjs register.mjs release.mjs report.mjs system.mjs"

  say() { printf '==> %s\n' "$*"; }
  die() {
    printf '\n錯誤 / Error: %s\n' "$*" >&2
    exit 1
  }
  sha256() {
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "$1" | awk '{print $1}'
    else
      sha256sum "$1" | awk '{print $1}'
    fi
  }

  # ---------------------------------------------------------------- arguments install.sh itself needs
  DRY=0
  LOCAL_OK=0
  SRC="${WB_SOURCE_DIR:-}"
  NEXT_IS_SRC=0
  for a in ${1+"$@"}; do
    if [ "$NEXT_IS_SRC" = 1 ]; then
      SRC="$a"
      NEXT_IS_SRC=0
      continue
    fi
    case "$a" in
      --dry-run) DRY=1 ;;
      --doctor | --uninstall) LOCAL_OK=1 ;;
      --source-dir) NEXT_IS_SRC=1 ;;
      --source-dir=*) SRC="${a#--source-dir=}" ;;
      -h | --help)
        printf '%s\n' "研究工作台 Mac 安裝程式 / Research Workbench Mac installer" \
          "  options: --doctor --dry-run --uninstall [--purge] --import <file> --port <n> --yes --source-dir <dir> --no-launchd --no-register" \
          "  e.g. /bin/bash -c \"\$(curl -fsSL $RAW/$BRANCH/$SUBDIR/scripts/mac/install.sh)\" -- --doctor"
        exit 0
        ;;
    esac
  done

  command -v curl >/dev/null 2>&1 || die "找不到 curl / curl not found"
  command -v tar >/dev/null 2>&1 || die "找不到 tar / tar not found"

  # ---------------------------------------------------------------- which Node for this machine
  OS="$(uname -s)"
  case "$OS" in
    Darwin)
      PLATFORM=darwin
      # 1 on Apple Silicon, also when this shell runs under Rosetta; the key does not exist on Intel
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi
      MACVER="$(sw_vers -productVersion)"
      MAJOR="${MACVER%%.*}"
      REST="${MACVER#*.}"
      if [ "$REST" = "$MACVER" ]; then MINOR=0; else MINOR="${REST%%.*}"; fi
      case "$MAJOR$MINOR" in
        '' | *[!0-9]*) die "無法判斷 macOS 版本 / cannot read the macOS version: $MACVER" ;;
      esac
      if [ "$MAJOR" -lt 11 ]; then
        die "需要 macOS 11 以上，這台是 $MACVER / macOS 11 or later is required (this Mac: $MACVER)"
      fi
      # Node 24 needs macOS 13.5; Node 22 still runs on 11
      if [ "$MAJOR" -gt 13 ] || { [ "$MAJOR" -eq 13 ] && [ "$MINOR" -ge 5 ]; }; then NODE_VER=24.22.2; else NODE_VER=22.23.4; fi
      say "macOS ${MACVER}，晶片 ${ARCH}，使用 Node $NODE_VER / macOS $MACVER, $ARCH, Node $NODE_VER"
      ;;
    Linux)
      PLATFORM=linux
      [ "$(uname -m)" = "x86_64" ] || die "Linux 只支援 x64（僅供 CI）/ only Linux x64 is supported (CI)"
      ARCH=x64
      NODE_VER=24.22.2
      say "Linux x64（僅供 CI 與 --dry-run）/ Linux x64 (CI and dry runs only)"
      ;;
    *) die "只支援 macOS / macOS only (this is $OS)" ;;
  esac

  # SHA-256 of the official .tar.gz files (nodejs.org/dist/v<version>/SHASUMS256.txt)
  case "$NODE_VER-$PLATFORM-$ARCH" in
    24.22.2-darwin-arm64) NODE_SHA=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a ;;
    24.22.2-darwin-x64) NODE_SHA=d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52 ;;
    24.22.2-linux-x64) NODE_SHA=361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9 ;;
    22.23.4-darwin-arm64) NODE_SHA=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428 ;;
    22.23.4-darwin-x64) NODE_SHA=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819 ;;
    22.23.4-linux-x64) NODE_SHA=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406 ;;
    *) die "沒有對應的 Node / no Node build for $NODE_VER-$PLATFORM-$ARCH" ;;
  esac

  ROOT="$HOME/ResearchWorkbench"
  RUNTIME="$ROOT/runtime"
  NODE_NAME="node-v$NODE_VER-$PLATFORM-$ARCH"
  WB_TMP="$(mktemp -d "${TMPDIR:-/tmp}/wb-install.XXXXXX")"
  trap 'rm -rf "$WB_TMP"' EXIT

  # ---------------------------------------------------------------- the bundled Node
  # --dry-run, --doctor and --uninstall never change runtime/ (re-pointing runtime/current at another
  # Node major would break the installed app's better-sqlite3 at its next start)
  KEEP_RUNTIME="$DRY"
  if [ "$LOCAL_OK" = 1 ]; then KEEP_RUNTIME=1; fi
  if [ -n "${WB_NODE:-}" ]; then
    NODE="$WB_NODE"
    say "使用指定的 Node（測試用）/ using WB_NODE=$NODE"
  elif [ "$LOCAL_OK" = 1 ] && [ -n "$("$RUNTIME/current/bin/node" --version 2>/dev/null || true)" ]; then
    NODE="$RUNTIME/current/bin/node"
    say "使用已安裝的 Node / using the installed Node"
  elif [ -x "$RUNTIME/$NODE_NAME/bin/node" ] && [ "$("$RUNTIME/$NODE_NAME/bin/node" --version 2>/dev/null || true)" = "v$NODE_VER" ]; then
    say "Node $NODE_VER 已經安裝 / Node $NODE_VER is already installed"
    if [ "$KEEP_RUNTIME" = 1 ]; then
      NODE="$RUNTIME/$NODE_NAME/bin/node"
    else
      ln -sfn "$NODE_NAME" "$RUNTIME/current"
      NODE="$RUNTIME/current/bin/node"
    fi
  else
    say "下載 Node.js ${NODE_VER}（$PLATFORM-${ARCH}）/ downloading Node.js from nodejs.org"
    curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$WB_TMP/node.tar.gz" \
      "https://nodejs.org/dist/v$NODE_VER/$NODE_NAME.tar.gz" || die "Node 下載失敗，請確認網路後重試 / Node download failed"
    say "檢查 SHA-256 指紋 / verifying the SHA-256 checksum"
    ACTUAL="$(sha256 "$WB_TMP/node.tar.gz")"
    if [ "$ACTUAL" != "$NODE_SHA" ]; then
      die "Node 檔案指紋不符，已停止（下載不完整或被竄改）/ checksum mismatch: expected $NODE_SHA, got $ACTUAL"
    fi
    if [ "$KEEP_RUNTIME" = 1 ]; then
      say "Node 只解壓到暫存資料夾，不安裝 / Node goes to a temporary folder only"
      tar -xzf "$WB_TMP/node.tar.gz" -C "$WB_TMP"
      NODE="$WB_TMP/$NODE_NAME/bin/node"
    else
      say "安裝 Node 到 $RUNTIME/$NODE_NAME / installing Node"
      mkdir -p "$RUNTIME"
      STAGE="$RUNTIME/.staging-$$"
      rm -rf "$STAGE"
      mkdir "$STAGE"
      tar -xzf "$WB_TMP/node.tar.gz" -C "$STAGE"
      rm -rf "${RUNTIME:?}/$NODE_NAME"
      mv "$STAGE/$NODE_NAME" "$RUNTIME/$NODE_NAME"
      rm -rf "$STAGE"
      ln -sfn "$NODE_NAME" "$RUNTIME/current"
      NODE="$RUNTIME/current/bin/node"
    fi
  fi
  "$NODE" --version >/dev/null 2>&1 || die "Node 無法執行 / Node does not run: $NODE"

  # ---------------------------------------------------------------- install.mjs of the tested commit
  if [ -n "$SRC" ]; then
    MJS="$SRC/scripts/mac/install.mjs"
    [ -f "$MJS" ] || die "找不到 / not found: $MJS"
    say "使用本機的安裝程式 / using the installer in $SRC"
  elif [ "$LOCAL_OK" = 1 ] && [ -f "$ROOT/current/scripts/mac/install.mjs" ]; then
    # --doctor and --uninstall work offline with the copy of the installed version
    MJS="$ROOT/current/scripts/mac/install.mjs"
    say "使用已安裝版本的安裝程式 / using the installed version's installer"
  else
    COMMIT="${WB_RELEASE_COMMIT:-}"
    if [ -z "$COMMIT" ]; then
      say "讀取已測試的版本 release.json / reading the tested release"
      RELEASE="$(curl -fsSL --retry 3 --connect-timeout 20 "$RAW/$BRANCH/$SUBDIR/release.json")" ||
        die "無法連線到 GitHub，請確認網路後重試 / cannot reach GitHub"
      COMMIT="$(printf '%s\n' "$RELEASE" | sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    fi
    if [ "$COMMIT" = "pending" ]; then
      die "目前還沒有通過測試、可以安裝的版本（release.json 的 commit 是 pending），請稍後再試 / no tested release yet; try again later"
    fi
    case "$COMMIT" in
      '' | *[!0-9a-f]*) die "release.json 格式錯誤 / release.json has no valid commit: '$COMMIT'" ;;
    esac
    [ "${#COMMIT}" -eq 40 ] || die "release.json 的 commit 不完整 / not a full commit sha: $COMMIT"
    say "下載安裝程式（版本 ${COMMIT:0:7}）/ downloading the installer of commit ${COMMIT:0:7}"
    mkdir -p "$WB_TMP/scripts/mac/lib"
    curl -fsSL --retry 3 --connect-timeout 20 -o "$WB_TMP/scripts/mac/install.mjs" "$RAW/$COMMIT/$SUBDIR/scripts/mac/install.mjs" ||
      die "無法下載安裝程式 / cannot download install.mjs"
    # LIB_FILES is the newest list (this script comes from the branch), but release.json may still name
    # an older commit with fewer helpers: a file none of the downloaded scripts imports is not needed
    MISSING=""
    for f in $LIB_FILES; do
      curl -fsSL --retry 3 --connect-timeout 20 -o "$WB_TMP/scripts/mac/lib/$f" "$RAW/$COMMIT/$SUBDIR/scripts/mac/lib/$f" || MISSING="$MISSING $f"
    done
    for f in $MISSING; do
      rm -f "$WB_TMP/scripts/mac/lib/$f"
      if grep -qF "/$f'" "$WB_TMP/scripts/mac/install.mjs" "$WB_TMP"/scripts/mac/lib/*.mjs; then
        die "無法下載安裝程式 / cannot download lib/$f"
      fi
    done
    MJS="$WB_TMP/scripts/mac/install.mjs"
    # install.mjs installs exactly this commit instead of reading release.json again
    export WB_RELEASE_COMMIT="$COMMIT"
  fi

  STATUS=0
  "$NODE" "$MJS" ${1+"$@"} || STATUS=$?
  exit "$STATUS"
}

# `bash -c "$(curl …)" --doctor` puts the first argument in $0; hand it back (`-- --doctor` is the documented form)
case "$0" in
  --?*) main "$0" ${1+"$@"} ;;
  *) main ${1+"$@"} ;;
esac
