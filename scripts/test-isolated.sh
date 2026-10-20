#!/bin/sh
# Run the test suite without touching a live intercom broker.
# Pi sessions export PI_CODING_AGENT_DIR / PI_INTERCOM_* which would point the tests at the live broker;
# the suite only isolates HOME. Usage: scripts/test-isolated.sh [npm test args | tsx --test files...]
set -eu
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
if [ "$#" -gt 0 ]; then CMD="npx tsx --test"; else CMD="npm test"; fi
env -u PI_CODING_AGENT_DIR -u PI_INTERCOM_SESSION_ID -u PI_INTERCOM_SCOPE_ID -u PI_INTERCOM_STABLE_ID \
    -u PI_WEB_SESSION -u PI_SESSION_ID -u PI_SESSION_FILE -u TMUX_PANE -u HERDR_PANE_ID \
    HOME="$T" USERPROFILE="$T" $CMD "$@"
