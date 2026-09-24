#!/bin/sh
# Root-owned narrow helper for StandWatch file transactions.
# It can only touch managed JSON/YAML/SH files below /usr/local/<group>/.
set -eu
HELPER_VERSION=v4

die() { printf '%s\n' "$*" >&2; exit 1; }
valid_hash() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'; }
valid_tx() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]{1,120}$'; }

resolve_target() {
  [ -n "${1:-}" ] || die 'missing target path'
  [ -f "$1" ] || die 'target is not a regular file'
  target=$(realpath -e -- "$1")
  case "$target" in
    /usr/local/*/volumes/config/*.json) kind=json ;;
    /usr/local/*/volumes/config/*.yaml|/usr/local/*/volumes/config/*.yml|/usr/local/*/home/*.yaml|/usr/local/*/home/*.yml) kind=yaml ;;
    /usr/local/*/scripts/*.sh) kind=shell ;;
    *) die 'target is outside managed JSON/YAML/SH scope' ;;
  esac
  case "$target" in *'/../'*|*'/./'*) die 'unsafe target path' ;; esac
  dir=$(dirname -- "$target")
  name=$(basename -- "$target")
}

json_validator() {
  if command -v jq >/dev/null 2>&1; then printf 'jq'
  elif command -v python3 >/dev/null 2>&1; then printf 'python3'
  else die 'remote JSON validator (jq/python3) not found'
  fi
}

validate_target() {
  case "$kind" in
    json)
      case "$(json_validator)" in
        jq) jq empty "$1" >/dev/null ;;
        python3) python3 -m json.tool "$1" >/dev/null ;;
      esac
      ;;
    yaml)
      # The exact bytes were parsed by bundled js-yaml before transfer and are
      # verified here by SHA-256. A remote YAML dependency is not required.
      ;;
    shell)
      command -v bash >/dev/null 2>&1 || die 'bash validator not found'
      bash -n "$1"
      ;;
  esac
}

prepare_rollback() {
  resolve_target "${1:-}"
  tx=${2:-}; before=${3:-}; expected=${4:-}
  valid_tx "$tx" || die 'invalid transaction id'
  valid_hash "$before" || die 'invalid before sha256'
  valid_hash "$expected" || die 'invalid expected live sha256'
  tmp="$dir/.${name}.standwatch-${tx}.rollback.tmp"
  snap="$dir/.${name}.standwatch-${tx}.t2"
  current=$(sha256sum "$target" | awk '{print $1}')
  if [ "$current" = "$before" ]; then rollback_state=already-restored; return; fi
  [ "$current" = "$expected" ] || die 'live sha256 changed after apply; rollback refused'
  [ -f "$snap" ] || die 'T2 snapshot not found'
  [ "$(sha256sum "$snap" | awk '{print $1}')" = "$before" ] || die 'T2 snapshot sha256 mismatch'
  rollback_state=ready
}

validator_name() {
  case "$kind" in json) json_validator ;; yaml) printf 'js-yaml+sha256' ;; shell) printf 'bash-n' ;; esac
}

command=${1:-}; shift || true
case "$command" in
  version)
    printf 'helper:%s\n' "$HELPER_VERSION"
    ;;
  check)
    resolve_target "${1:-}"
    command -v sha256sum >/dev/null
    command -v realpath >/dev/null
    printf 'helper:%s:%s:%s\n' "$HELPER_VERSION" "$kind" "$(validator_name)"
    ;;
  apply)
    resolve_target "${1:-}"
    tx=${2:-}; before=${3:-}; wanted=${4:-}
    valid_tx "$tx" || die 'invalid transaction id'
    valid_hash "$before" || die 'invalid before sha256'
    valid_hash "$wanted" || die 'invalid target sha256'
    tmp="$dir/.${name}.standwatch-${tx}.tmp"
    snap="$dir/.${name}.standwatch-${tx}.t2"
    cleanup() { rm -f -- "$tmp" >/dev/null 2>&1 || true; }
    trap cleanup EXIT HUP INT TERM
    current=$(sha256sum "$target" | awk '{print $1}')
    [ "$current" = "$before" ] || die 'live sha256 changed before apply'
    cp --preserve=all -- "$target" "$snap"
    [ "$(sha256sum "$snap" | awk '{print $1}')" = "$before" ] || die 'T2 snapshot sha256 mismatch'
    cp --preserve=all -- "$target" "$tmp"
    cat > "$tmp"
    [ "$(sha256sum "$tmp" | awk '{print $1}')" = "$wanted" ] || die 'transferred target sha256 mismatch'
    # A forced DEBUG rewrite may intentionally preserve an existing JSONC file.
    # If bytes are identical to the verified live file, parsing it again with
    # strict remote jq would reject valid-for-the-app comments/trailing commas.
    [ "$wanted" = "$before" ] || validate_target "$tmp"
    mv -f -- "$tmp" "$target"
    trap - EXIT HUP INT TERM
    printf 'SNAPSHOT=%s\nSHA256=%s\n' "$snap" "$wanted"
    ;;
  rollback-check)
    prepare_rollback "$@"
    printf 'ROLLBACK=%s\nCURRENT_SHA256=%s\n' "$rollback_state" "$current"
    ;;
  rollback)
    prepare_rollback "$@"
    if [ "$rollback_state" = already-restored ]; then printf 'ROLLBACK=already-restored\nRESTORED_SHA256=%s\n' "$before"; exit 0; fi
    cleanup() { rm -f -- "$tmp" >/dev/null 2>&1 || true; }
    trap cleanup EXIT HUP INT TERM
    cp --preserve=all -- "$snap" "$tmp"
    # Rollback restores the exact T2 bytes whose SHA was verified above.
    # Do not reject a pre-existing JSONC file with strict jq during recovery.
    mv -f -- "$tmp" "$target"
    trap - EXIT HUP INT TERM
    printf 'RESTORED_SHA256=%s\n' "$before"
    ;;
  *) die 'usage: standwatch-config-helper version|check|apply|rollback-check|rollback ...' ;;
esac
