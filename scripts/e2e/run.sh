#!/bin/sh
# End-to-end wake check on an ISOLATED PI WEB session daemon + intercom broker. Never touches the live ones:
# everything lives under a throwaway /tmp/waker-e2e-* directory and only processes started here are stopped here.
set -eu
HERE=$(cd "$(dirname "$0")/../.." && pwd)
PIWEB=${PIWEB:-$(npm root -g)/@jmfederico/pi-web}
# PI WEB 1.202610.8 and newer do not bundle the Pi SDK: the daemon needs PI_WEB_PI_PACKAGE_DIR (the SDK of the managed Pi install).
# When it is not given and this PI WEB has no bundled SDK, use the one Pi is installed with (the scheduled check runs with a bare environment).
if [ -z "${PI_WEB_PI_PACKAGE_DIR:-}" ] && [ ! -d "$PIWEB/node_modules/@earendil-works/pi-coding-agent" ]; then
  PI_SDK_GUESS="$HOME/.pi/agent/install/releases/$(cat "$HOME/.pi/agent/install/current-version" 2>/dev/null)/node_modules/@earendil-works/pi-coding-agent"
  if [ -f "$PI_SDK_GUESS/package.json" ]; then PI_WEB_PI_PACKAGE_DIR=$PI_SDK_GUESS; export PI_WEB_PI_PACKAGE_DIR; echo "using the Pi SDK at $PI_SDK_GUESS"; fi
fi
R=$(mktemp -d /tmp/waker-e2e-XXXX)
mkdir -p "$R/home" "$R/agent/intercom" "$R/webdata" "$R/work"
SCENARIO=${1:-wake}
case "$SCENARIO" in wake|busy|askshield|smoke) ;; *) echo "usage: $0 [wake|busy|askshield|smoke]" >&2; exit 2 ;; esac
if [ "$SCENARIO" = busy ] || [ "$SCENARIO" = askshield ]; then
  # A scripted local model (no network, no credentials) so sessions can be really busy.
  mkdir -p "$R/agent/extensions"
  cp "$HERE/scripts/e2e/faux-model.ts" "$R/agent/extensions/faux-model.ts"
  printf '{"packages":["%s"],"defaultProvider":"faux","defaultModel":"faux-1","compaction":{"keepRecentTokens":1}}\n' "$HERE" > "$R/agent/settings.json"
else
  # E2E_EXTRA_PACKAGES="path path npm:name": load other packages too (the smoke scenario uses it to check them on another PI WEB / Pi SDK).
  PKGS=$(node -e 'console.log(JSON.stringify([process.argv[1], ...process.argv.slice(2)]))' "$HERE" ${E2E_EXTRA_PACKAGES:-})
  printf '{"packages":%s}\n' "$PKGS" > "$R/agent/settings.json"
fi
clean() {
  env -i PATH="$PATH" HOME="$R/home" XDG_CONFIG_HOME="$R/home/.config" PI_WEB_DATA_DIR="$R/webdata" \
    PI_WEB_SESSIOND_SOCKET="$R/sessiond.sock" PI_CODING_AGENT_DIR="$R/agent" WAKER_E2E_ROOT="$R" FAUX_SLOW_MS="${FAUX_SLOW_MS:-10000}" ${PI_WEB_PI_PACKAGE_DIR:+PI_WEB_PI_PACKAGE_DIR="$PI_WEB_PI_PACKAGE_DIR"} ${SMOKE_WAIT_MS:+SMOKE_WAIT_MS="$SMOKE_WAIT_MS"} "$@"
}
cleanup() {
  # Only the isolated broker (pid file in the throwaway agent dir) and the daemon started below.
  [ -f "$R/agent/intercom/broker.pid" ] && kill "$(cat "$R/agent/intercom/broker.pid")" 2>/dev/null || true
  [ -f "$R/sessiond.pid" ] && kill "$(cat "$R/sessiond.pid")" 2>/dev/null || true
  # The daemon flushes its state files on shutdown, which can take a while: wait for it before removing.
  for i in $(seq 1 40); do
    alive=0
    for f in "$R/agent/intercom/broker.pid" "$R/sessiond.pid"; do
      [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && alive=1
    done
    [ "$alive" = 0 ] && break
    sleep 1
  done
  # Anything still running inside the throwaway directory (for example a broker spawned by the woken session).
  for p in /proc/[0-9]*; do
    case "$(readlink "$p/cwd" 2>/dev/null)" in "$R"*) kill "${p#/proc/}" 2>/dev/null || true ;; esac
  done
  sleep 2
  # PIWEB=<pi-web install dir> tests another PI WEB; PI_WEB_PI_PACKAGE_DIR=<Pi SDK dir> is needed from PI WEB 1.202610.8 on.
  # Set KEEP=1 to keep the throwaway directory (logs, audit, session files) for inspection.
  [ "${KEEP:-}" = 1 ] || { rm -rf "$R"; sleep 1; rm -rf "$R"; }
}
trap cleanup EXIT
# exec so that $! is the daemon itself, not a subshell (the cleanup must stop the real process).
( exec env -i PATH="$PATH" HOME="$R/home" XDG_CONFIG_HOME="$R/home/.config" PI_WEB_DATA_DIR="$R/webdata" \
    PI_WEB_SESSIOND_SOCKET="$R/sessiond.sock" PI_CODING_AGENT_DIR="$R/agent" WAKER_E2E_ROOT="$R" FAUX_SLOW_MS="${FAUX_SLOW_MS:-10000}" \
    ${PI_WEB_PI_PACKAGE_DIR:+PI_WEB_PI_PACKAGE_DIR="$PI_WEB_PI_PACKAGE_DIR"} \
    node "$PIWEB/dist/server/sessiond.js" ) > "$R/sessiond.log" 2>&1 &
echo $! > "$R/sessiond.pid"
for i in $(seq 1 90); do [ -S "$R/sessiond.sock" ] && break; sleep 1; done
echo "isolated root: $R"
cd "$HERE"
clean node_modules/.bin/tsx "scripts/e2e/$SCENARIO-e2e.ts"
