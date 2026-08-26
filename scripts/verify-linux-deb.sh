#!/usr/bin/env bash
set -euo pipefail

deb_path="${1:?Usage: scripts/verify-linux-deb.sh <package.deb> [amd64|arm64]}"
expected_arch="${2:-amd64}"

case "$expected_arch" in
  amd64) elf_machine='Advanced Micro Devices X86-64' ;;
  arm64) elf_machine='AArch64' ;;
  *)
    echo "Unsupported Linux architecture: $expected_arch (expected amd64 or arm64)." >&2
    exit 1
    ;;
esac

test -f "$deb_path"

architecture="$(dpkg-deb -f "$deb_path" Architecture)"
if [ "$architecture" != "$expected_arch" ]; then
  echo "DEB architecture mismatch: expected '$expected_arch', got '$architecture'." >&2
  exit 1
fi

package_name="$(dpkg-deb -f "$deb_path" Package)"
if [ "$package_name" != "dsh-desktop" ]; then
  echo "DEB package mismatch: expected 'dsh-desktop', got '$package_name'." >&2
  exit 1
fi

contents="$(dpkg-deb -c "$deb_path")"
for required_path in \
  'usr/share/applications/dsh-desktop.desktop' \
  'opt/DSH Desktop/dsh-desktop' \
  'opt/DSH Desktop/resources/harness-node-entry.mjs'; do
  if ! grep -Fq "$required_path" <<<"$contents"; then
    echo "Required package path missing: $required_path" >&2
    exit 1
  fi
done

extract_root="$(mktemp -d)"
trap 'rm -rf "$extract_root"' EXIT
dpkg-deb -x "$deb_path" "$extract_root"
readelf -h "$extract_root/opt/DSH Desktop/dsh-desktop" \
  | grep -F "$elf_machine" >/dev/null

echo "Verified Linux $expected_arch DEB: $deb_path"
