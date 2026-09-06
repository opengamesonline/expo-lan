#!/usr/bin/env zsh

set -euo pipefail

sidecar_pid=""

usage() {
  print "Usage: npm run bridge"
}

fail() {
  print -u2 "emulator bridge: $1"
  exit 1
}

while (( $# > 0 )); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      fail "unknown argument: $1"
      ;;
  esac
done

command -v adb >/dev/null 2>&1 || fail "adb is not on PATH"

cleanup() {
  if [[ -n "$sidecar_pid" ]] && kill -0 "$sidecar_pid" >/dev/null 2>&1; then
    kill -TERM "$sidecar_pid" >/dev/null 2>&1 || true
    wait "$sidecar_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

print "Android emulator bridge ready"
print "  Devices: all running Android emulators"
print "  Mode:    Dynamic Bonjour and TCP sidecar"
print ""
print "Leave this process running. Build or open both development clients from another terminal."

node scripts/emulator-bridge.cjs &
sidecar_pid=$!
sleep 1
kill -0 "$sidecar_pid" >/dev/null 2>&1 || fail "sidecar failed to start"

npx expo start --dev-client --lan
