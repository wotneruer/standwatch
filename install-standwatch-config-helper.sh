#!/bin/sh
# Run as root: sh install-standwatch-config-helper.sh <ssh-user>
set -eu

user=${1:-}
printf '%s' "$user" | grep -Eq '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$' || { echo 'invalid user' >&2; exit 1; }
id "$user" >/dev/null 2>&1 || { echo 'user not found' >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo 'run installer through sudo/root' >&2; exit 1; }

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_file="$source_dir/standwatch-config-helper.sh"
[ -f "$source_file" ] || { echo "missing $source_file" >&2; exit 1; }

target=/usr/local/sbin/standwatch-config-helper
sudoers=/etc/sudoers.d/standwatch-config-helper
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT HUP INT TERM

install -o root -g root -m 0755 "$source_file" "$target"
printf '%s ALL=(root) NOPASSWD: %s *\n' "$user" "$target" > "$temporary"
chmod 0440 "$temporary"
visudo -cf "$temporary" >/dev/null
install -o root -g root -m 0440 "$temporary" "$sudoers"
visudo -cf "$sudoers" >/dev/null

printf 'Installed %s\nSudo rule: %s\n' "$target" "$sudoers"
