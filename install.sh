#!/bin/sh
set -eu

repo=${MASKODE_REPO:-${BOGU_REPO:-abdullahalsaidi16/maskode}}
install_dir=${MASKODE_INSTALL_DIR:-${BOGU_INSTALL_DIR:-"$HOME/.local/bin"}}
with_privacy=1

for arg in "$@"; do
  case "$arg" in
    --without-privacy-model) with_privacy=0 ;;
    --help|-h) echo "Usage: install.sh [--without-privacy-model]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

case $(uname -s) in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) echo "Maskode currently supports macOS and Linux." >&2; exit 1 ;;
esac

case $(uname -m) in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="maskode-$platform-$arch.tar.gz"
base=${MASKODE_RELEASE_BASE:-${BOGU_RELEASE_BASE:-"https://github.com/$repo/releases/latest/download"}}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

echo "Installing Maskode for $platform-$arch..."
curl -fL --retry 3 "$base/$asset" -o "$tmp_dir/$asset"
curl -fL --retry 3 "$base/$asset.sha256" -o "$tmp_dir/$asset.sha256"

expected=$(awk '{print $1}' "$tmp_dir/$asset.sha256")
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp_dir/$asset" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp_dir/$asset" | awk '{print $1}')
else
  echo "A SHA-256 utility (shasum or sha256sum) is required." >&2
  exit 1
fi
[ "$expected" = "$actual" ] || { echo "Maskode archive checksum verification failed." >&2; exit 1; }

mkdir -p "$install_dir"
tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"
install -m 755 "$tmp_dir/maskode" "$install_dir/maskode"
echo "Installed Maskode to $install_dir/maskode"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH to run 'maskode' directly." ;;
esac

if [ "$with_privacy" -eq 1 ]; then
  if ! command -v python3.12 >/dev/null 2>&1 && ! command -v python3.11 >/dev/null 2>&1 && ! command -v python3.10 >/dev/null 2>&1; then
    if [ "$platform" = darwin ] && command -v brew >/dev/null 2>&1; then
      echo "Installing Python 3.12 for the local privacy runtime..."
      brew install python@3.12
    else
      echo "Python 3.10+ is required. Install it, then run: $install_dir/maskode privacy install" >&2
      exit 1
    fi
  fi
  "$install_dir/maskode" privacy install
fi

echo "Maskode is ready. Run: $install_dir/maskode"
